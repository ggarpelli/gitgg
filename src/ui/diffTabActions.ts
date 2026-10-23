import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { backupStore } from '../services/backupStore';
import { REF_SCHEME, parseRefUri, toRefUri } from './refContentProvider';
import { fireFilesChanged, onDidChangeFiles, saveDirtyDocuments } from './fileEvents';
import { showError } from './feedback';

/**
 * Buttons in the title bar of Gitgg diff tabs ("Compare in Separate Tabs" and "View full Diff"):
 * Use <branch> version, Stage, Unstage, Revert and Restore Changes, shown only when they apply.
 * Visibility is driven by the `gitgg.diff.*` context keys used in package.json.
 */

interface ActiveDiff {
    git: GitService;
    baseRef: string;
    filePath: string;
}

const CONTEXT_KEYS = ['isCompareDiff', 'canUseBase', 'canStage', 'canUnstage', 'canRevert', 'canRestore'] as const;
type ContextKey = typeof CONTEXT_KEYS[number];

/** The Gitgg diff shown in the active tab: base version (gitgg: URI) on the left, the file on the right. */
function getActiveDiff(): ActiveDiff | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputTextDiff) || input.original.scheme !== REF_SCHEME) {
        return undefined;
    }
    const { repo, ref, filePath } = parseRefUri(input.original);
    return { git: GitService.forRepo(repo), baseRef: ref, filePath };
}

async function setContext(values: Partial<Record<ContextKey, boolean>>): Promise<void> {
    await Promise.all(CONTEXT_KEYS.map(key => vscode.commands.executeCommand('setContext', `gitgg.diff.${key}`, values[key] ?? false)));
}

async function updateContext(): Promise<void> {
    const diff = getActiveDiff();
    if (!diff) {
        await setContext({});
        return;
    }
    const { git, baseRef, filePath } = diff;
    const [status, [comparison]] = await Promise.all([
        git.getStatus(),
        git.compareWithWorkingTree(baseRef, [filePath])
    ]);
    const staged = status.staged.includes(filePath);
    const unstaged = status.files.some(file => file.path === filePath && file.working_dir !== ' ');
    await setContext({
        isCompareDiff: true,
        canUseBase: comparison.kind !== 'unchanged',
        canStage: unstaged,
        canUnstage: staged,
        canRevert: staged || unstaged,
        canRestore: backupStore.has(git.getRepoPath(), filePath)
    });
}

let updateTimer: NodeJS.Timeout | undefined;
function scheduleUpdate(): void {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
        updateContext().catch(error => console.error('Gitgg: could not update diff tab actions', error));
    }, 100);
}

/** Runs an action on the file of the active Gitgg diff, then refreshes buttons and open panels. */
async function runOnActiveDiff(title: string, action: (diff: ActiveDiff) => Promise<string | undefined>): Promise<void> {
    const diff = getActiveDiff();
    if (!diff) {
        return;
    }
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    await saveDirtyDocuments(diff.git, [diff.filePath]);
    let message: string | undefined;
    try {
        message = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Gitgg: ${title}` }, () => action(diff));
    } catch (error) {
        await showError(`${title} failed`, error);
        scheduleUpdate();
        return;
    }
    fireFilesChanged({ repoPath: diff.git.getRepoPath(), paths: [diff.filePath], source: undefined });

    // If the file was created or deleted, the right side must switch between the real file and an empty document.
    if (tab && tab.input instanceof vscode.TabInputTextDiff) {
        const showsFile = tab.input.modified.scheme === 'file';
        const existsNow = (await diff.git.readWorkingTreeBuffer(diff.filePath)) !== null;
        if (showsFile !== existsNow) {
            const right = existsNow
                ? vscode.Uri.file(diff.git.toAbsolutePath(diff.filePath))
                : toRefUri(diff.git.getRepoPath(), '', diff.filePath);
            const original = tab.input.original;
            await vscode.window.tabGroups.close(tab);
            await vscode.commands.executeCommand('vscode.diff', original, right, tab.label, { preview: false });
        }
    }
    if (message) {
        vscode.window.showInformationMessage(`Gitgg: ${message}`);
    }
}

async function confirm(message: string, action: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
}

function baseLabel(ref: string): string {
    // Commit SHAs are shown short; branch refs as they are.
    return /^[0-9a-f]{40}$/i.test(ref) ? ref.substring(0, 7) : ref;
}

export function registerDiffTabActions(): vscode.Disposable[] {
    return [
        vscode.window.tabGroups.onDidChangeTabs(scheduleUpdate),
        vscode.window.tabGroups.onDidChangeTabGroups(scheduleUpdate),
        vscode.workspace.onDidSaveTextDocument(scheduleUpdate),
        onDidChangeFiles(scheduleUpdate),

        vscode.commands.registerCommand('gitgg.diff.useBase', () => runOnActiveDiff('Using compared version', async ({ git, baseRef, filePath }) => {
            await backupStore.apply(git, [filePath], () => git.takeFilesFromRef(baseRef, [filePath]));
            return `${filePath} now matches ${baseLabel(baseRef)} and is staged.`;
        })),
        vscode.commands.registerCommand('gitgg.diff.stage', () => runOnActiveDiff('Staging', async ({ git, filePath }) => {
            await git.stageFiles([filePath]);
            return undefined;
        })),
        vscode.commands.registerCommand('gitgg.diff.unstage', () => runOnActiveDiff('Unstaging', async ({ git, filePath }) => {
            await git.unstageFiles([filePath]);
            return undefined;
        })),
        vscode.commands.registerCommand('gitgg.diff.revert', async () => {
            const diff = getActiveDiff();
            if (!diff || !await confirm(
                `Revert ${diff.filePath} to the version in your current branch (HEAD)? Staged and unstaged changes will be discarded. You can undo it with "Restore Changes".`,
                'Revert')) {
                return;
            }
            await runOnActiveDiff('Reverting', async ({ git, filePath }) => {
                await backupStore.apply(git, [filePath], () => git.revertToHead([filePath]));
                return `Reverted ${filePath}.`;
            });
        }),
        vscode.commands.registerCommand('gitgg.diff.restore', async () => {
            const diff = getActiveDiff();
            if (!diff) {
                return;
            }
            const { entries, editedSince } = await backupStore.inspect(diff.git, [diff.filePath]);
            if (entries.length === 0) {
                return;
            }
            const message = editedSince.size > 0
                ? `${diff.filePath} has changed since the last action. Restoring will overwrite the current file contents.`
                : `Restore ${diff.filePath} to how it was before?`;
            if (!await confirm(message, 'Restore')) {
                return;
            }
            await runOnActiveDiff('Restoring', async ({ git }) => {
                await backupStore.restore(git, entries);
                return `Restored ${diff.filePath}.`;
            });
        })
    ];
}

/** Initial state, for a diff tab that is already open when the extension activates. */
export function initDiffTabActions(): void {
    scheduleUpdate();
}
