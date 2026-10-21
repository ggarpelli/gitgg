import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { FileComparison, GitService } from '../services/gitService';
import { serializeForScriptTag } from '../utils/patch';
import { backupStore } from '../services/backupStore';
import { openRefDiff } from '../ui/refContentProvider';
import { fireFilesChanged, onDidChangeFiles, saveDirtyDocuments } from '../ui/fileEvents';
import { getConfig } from '../config';
import { errorMessage, logError, showError } from '../ui/feedback';

/** Optional report the user can save from the panel (used by PR Comparison). */
export interface PanelReport {
    /** Suggested file name for the save dialog. */
    defaultFileName: string;
    /** Builds the report from the current comparison, so it reflects actions done in the panel. */
    build(files: FileComparison[]): string;
}

export interface DiffPanelOptions {
    viewType: string;
    title: string;
    /** Ref the working tree is compared against (branch, origin/branch or commit SHA). */
    baseRef: string;
    baseLabel: string;
    localLabel: string;
    /** Extra context shown above the comparison (used to explain PR reference semantics). */
    contextNote?: string;
    filePaths: string[];
    /** Comparison already computed by the command, to avoid doing it twice on open. */
    initialComparison?: FileComparison[];
    report?: PanelReport;
}

interface WebviewFile {
    filePath: string;
    patch: string;
}

interface WebviewPayload {
    addedFiles: WebviewFile[];
    changedFiles: WebviewFile[];
    deletedFiles: WebviewFile[];
    unchangedFiles: WebviewFile[];
    targetBranch: string;
    localFileLabel: string;
    contextNote?: string;
    /** Files with staged changes and files with unstaged (or untracked) changes. */
    status: { staged: string[]; unstaged: string[] };
    restorableFiles: string[];
    lineLimit: number;
    /** Shows the "Save Report" button. */
    hasReport: boolean;
}

interface PanelMessage {
    command: string;
    path?: string;
    /** For "undo": the files to restore. */
    paths?: string[];
}

/** An action confirmed by the user and ready to run under a progress indicator. */
interface PlannedAction {
    title: string;
    /** Files whose content may change; only these are re-compared afterwards. */
    touchedPaths: string[];
    /** Files whose content or staging state may change (announced to diff tabs and other panels). */
    affectedPaths: string[];
    /** Shows a notification with progress (bulk actions) instead of only the status bar. */
    bulk: boolean;
    /** Number of progress steps `run` reports (a final "refreshing" step is added automatically). */
    steps: number;
    /** Set for single-file actions: only that row shows the spinner, the rest of the panel stays usable. */
    rowPath?: string;
    /** Files that can be restored afterwards, offered as an "Undo" button in the result banner. */
    undoable?: boolean;
    run(report: (message: string) => void): Promise<string>;
}

/**
 * Multi-file diff report shared by "Compare with branch", "Release Drift" and "PR Comparison".
 * Always compares `baseRef` with the working tree, so every action is reflected on the next refresh:
 * - Use <base>: take the base version of the file and stage it.
 * - Stage / Unstage: plain `git add` / `git reset` of the file as it is on disk.
 * - Revert: put the file back as it is in the current branch (HEAD), dropping staged and unstaged changes.
 * - Restore Changes: undo Use/Revert on a file (backups are shared with diff tabs, kept while VS Code is open).
 * Bulk actions run as a few batched Git commands, so they stay fast with thousands of files.
 */
export class DiffPanel {
    private readonly panel: vscode.WebviewPanel;
    private readonly comparison = new Map<string, FileComparison>();
    private queue: Promise<void> = Promise.resolve();

    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly git: GitService,
        private readonly options: DiffPanelOptions
    ) {
        this.panel = vscode.window.createWebviewPanel(options.viewType, options.title, vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
        });

        const messageListener = this.panel.webview.onDidReceiveMessage((msg: PanelMessage) => {
            // Serialize actions so two quick clicks never run Git commands concurrently on the same files.
            this.queue = this.queue.then(() => this.handleMessage(msg)).catch(error => showError('Action failed', error));
        });
        // Keep in sync with changes made from diff tabs or other panels.
        const changeListener = onDidChangeFiles(event => {
            if (event.source === this || event.repoPath !== git.getRepoPath()) {
                return;
            }
            const touched = event.paths.filter(filePath => this.comparison.has(filePath));
            if (touched.length > 0) {
                this.queue = this.queue.then(() => this.refresh(touched)).catch(() => undefined);
            }
        });
        this.panel.onDidDispose(() => {
            messageListener.dispose();
            changeListener.dispose();
        });
    }

    static async open(context: vscode.ExtensionContext, git: GitService, options: DiffPanelOptions): Promise<DiffPanel> {
        const diffPanel = new DiffPanel(context, git, options);
        const comparison = options.initialComparison ?? await git.compareWithWorkingTree(options.baseRef, options.filePaths);
        diffPanel.setComparison(comparison);
        diffPanel.panel.webview.html = diffPanel.renderHtml(await diffPanel.buildPayload());
        return diffPanel;
    }

    private async handleMessage(msg: PanelMessage): Promise<void> {
        if (msg.command === 'openDiff' && msg.path) {
            await openRefDiff(this.git, this.options.baseRef, msg.path, this.options.baseLabel, this.options.localLabel);
            return;
        }
        if (msg.command === 'saveReport') {
            await this.saveReport();
            return;
        }

        const action = msg.command === 'undo'
            ? await this.planRestore(msg.paths ?? [], false)
            : await this.planAction(msg);
        if (!action) {
            return;
        }
        await this.runAction(action);
    }

    /**
     * Runs an action with feedback everywhere it is useful:
     * - while running: a spinner on the row (single file) or a banner with step and elapsed time (bulk),
     *   plus a VS Code progress notification for bulk actions;
     * - when done: a banner in the panel with the result (and "Undo" when possible) and the changed rows highlighted;
     * - on failure: an error banner with details, a notification and a log entry in the "Gitgg" output channel.
     */
    private async runAction(action: PlannedAction): Promise<void> {
        const totalSteps = action.steps + 1;
        const scope = action.rowPath ? { scope: 'row', path: action.rowPath } : { scope: 'panel' };
        let step = 0;

        await this.post({ command: 'busy', ...scope, text: action.title, step: 0, totalSteps, startedAt: Date.now() });
        try {
            const resultText = await vscode.window.withProgress({
                location: action.bulk ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
                title: `Gitgg: ${action.title}`
            }, async progress => {
                const report = (message: string) => {
                    step = Math.min(step + 1, totalSteps);
                    const stepText = `Step ${step} of ${totalSteps}: ${message}`;
                    progress.report({ message: stepText, increment: 100 / totalSteps });
                    void this.post({ command: 'busy', ...scope, text: action.title, detail: stepText, step, totalSteps });
                };
                await saveDirtyDocuments(this.git, action.touchedPaths);
                const text = await action.run(report);
                report('refreshing the comparison...');
                await this.refresh(action.touchedPaths);
                fireFilesChanged({ repoPath: this.git.getRepoPath(), paths: action.affectedPaths, source: this });
                return text;
            });

            const undoPaths = action.undoable ? action.affectedPaths.filter(filePath => backupStore.has(this.git.getRepoPath(), filePath)) : [];
            await this.post({
                command: 'result',
                kind: 'success',
                // Single-file actions only highlight their row; bulk actions also show the banner.
                text: action.rowPath ? undefined : resultText,
                undoPaths: action.rowPath ? [] : undoPaths,
                highlight: action.affectedPaths
            });
        } catch (error) {
            logError(action.title, error);
            await this.post({ command: 'result', kind: 'error', text: `${action.title} failed: ${errorMessage(error).split('\n')[0]}`, details: errorMessage(error) });
            await this.refresh([]).catch(() => undefined);
            throw error;
        } finally {
            await this.post({ command: 'idle' });
        }
    }

    private post(message: Record<string, unknown>): Thenable<boolean> {
        return this.panel.webview.postMessage(message);
    }

    /** Validates the request and asks for confirmation when needed. Returns undefined when there is nothing to do. */
    private async planAction(msg: PanelMessage): Promise<PlannedAction | undefined> {
        const filePath = msg.path ?? '';
        const base = this.options.baseLabel;

        switch (msg.command) {
            case 'stageFile':
            case 'stageAll': {
                const paths = msg.command === 'stageFile' ? [filePath] : (await this.localChanges()).unstaged;
                return paths.length === 0 ? undefined : {
                    title: `Staging ${plural(paths.length)}`, touchedPaths: [], affectedPaths: paths, bulk: paths.length > 1, steps: 1,
                    rowPath: msg.command === 'stageFile' ? filePath : undefined,
                    run: async report => {
                        report('git add...');
                        await this.git.stageFiles(paths);
                        return `Staged ${plural(paths.length)}.`;
                    }
                };
            }
            case 'unstageFile':
            case 'unstageAll': {
                const paths = msg.command === 'unstageFile' ? [filePath] : (await this.localChanges()).staged;
                return paths.length === 0 ? undefined : {
                    title: `Unstaging ${plural(paths.length)}`, touchedPaths: [], affectedPaths: paths, bulk: paths.length > 1, steps: 1,
                    rowPath: msg.command === 'unstageFile' ? filePath : undefined,
                    run: async report => {
                        report('git reset...');
                        await this.git.unstageFiles(paths);
                        return `Unstaged ${plural(paths.length)}.`;
                    }
                };
            }
            case 'acceptFile':
            case 'acceptAll': {
                const paths = msg.command === 'acceptFile' ? [filePath] : this.changedPaths();
                if (paths.length === 0) {
                    return undefined;
                }
                if (paths.length > 1 && !await this.confirm(
                    `Replace ${plural(paths.length)} with their version from ${base} and stage them? You can undo it with "Restore All Changes".`,
                    'Use Branch Version')) {
                    return undefined;
                }
                return {
                    title: `Using the ${base} version of ${plural(paths.length)}`, touchedPaths: paths, affectedPaths: paths, bulk: paths.length > 1, steps: 3,
                    rowPath: msg.command === 'acceptFile' ? filePath : undefined, undoable: true,
                    run: async report => {
                        await backupStore.apply(this.git, paths, () => this.git.takeFilesFromRef(this.options.baseRef, paths), report);
                        return paths.length === 1
                            ? `${paths[0]} now matches ${base} and is staged.`
                            : `${plural(paths.length)} now match ${base} and are staged.`;
                    }
                };
            }
            case 'revertFile':
            case 'revertAll': {
                const paths = msg.command === 'revertFile' ? [filePath] : (await this.localChanges()).all;
                if (paths.length === 0) {
                    return undefined;
                }
                const target = paths.length === 1 ? paths[0] : plural(paths.length);
                if (!await this.confirm(
                    `Revert ${target} to the version in your current branch (HEAD)? Staged and unstaged changes will be discarded. You can undo it with "Restore Changes".`,
                    'Revert')) {
                    return undefined;
                }
                return {
                    title: `Reverting ${plural(paths.length)}`, touchedPaths: paths, affectedPaths: paths, bulk: paths.length > 1, steps: 3,
                    rowPath: msg.command === 'revertFile' ? filePath : undefined, undoable: true,
                    run: async report => {
                        const changed = await backupStore.apply(this.git, paths, () => this.git.revertToHead(paths), report);
                        return changed === 0 ? 'Nothing to revert.' : `Reverted ${plural(changed)}.`;
                    }
                };
            }
            case 'restoreFile':
            case 'restoreAll':
                return this.planRestore(msg.command === 'restoreFile' ? [filePath] : this.restorablePaths(), true);
            default:
                return undefined;
        }
    }

    private async planRestore(paths: string[], askConfirmation: boolean): Promise<PlannedAction | undefined> {
        const { entries, editedSince } = await backupStore.inspect(this.git, paths);
        if (entries.length === 0) {
            return undefined;
        }

        let toRestore = entries;
        if (!askConfirmation) {
            // "Undo" right after an action: no question, but never overwrite edits made since then.
            toRestore = entries.filter(entry => !editedSince.has(entry.filePath));
        } else if (entries.length === 1) {
            const message = editedSince.size > 0
                ? `${entries[0].filePath} has changed since the last action. Restoring will overwrite the current file contents.`
                : `Restore ${entries[0].filePath} to how it was before?`;
            if (!await this.confirm(message, 'Restore')) {
                return undefined;
            }
        } else {
            const skipNote = editedSince.size > 0 ? ` ${plural(editedSince.size)} edited since then will be skipped.` : '';
            if (!await this.confirm(`Restore ${plural(entries.length)} to how they were before?${skipNote}`, 'Restore All')) {
                return undefined;
            }
            toRestore = entries.filter(entry => !editedSince.has(entry.filePath));
        }

        return {
            title: `Restoring ${plural(toRestore.length)}`,
            touchedPaths: toRestore.map(entry => entry.filePath),
            affectedPaths: toRestore.map(entry => entry.filePath),
            bulk: toRestore.length > 1,
            steps: 2,
            rowPath: askConfirmation && entries.length === 1 ? entries[0].filePath : undefined,
            run: async report => {
                await backupStore.restore(this.git, toRestore, report);
                const skipped = entries.length - toRestore.length;
                return `Restored ${plural(toRestore.length)}.${skipped > 0 ? ` Skipped ${plural(skipped)} edited since the last action.` : ''}`;
            }
        };
    }

    private async confirm(message: string, action: string): Promise<boolean> {
        return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
    }

    private setComparison(files: FileComparison[]): void {
        for (const file of files) {
            this.comparison.set(file.path, file);
        }
    }

    private changedPaths(): string[] {
        return Array.from(this.comparison.values()).filter(file => file.kind !== 'unchanged').map(file => file.path);
    }

    /** Panel files that differ from HEAD: staged, unstaged/untracked, and both combined. */
    private async localChanges(): Promise<{ staged: string[]; unstaged: string[]; all: string[] }> {
        const status = await this.git.getStatus();
        const inPanel = (filePath: string) => this.comparison.has(filePath);
        const staged = status.staged.filter(inPanel);
        const unstaged = status.files.filter(file => file.working_dir !== ' ' && inPanel(file.path)).map(file => file.path);
        return { staged, unstaged, all: Array.from(new Set([...staged, ...unstaged])) };
    }

    private restorablePaths(): string[] {
        return backupStore.paths(this.git.getRepoPath()).filter(filePath => this.comparison.has(filePath));
    }

    private async saveReport(): Promise<void> {
        const report = this.options.report;
        if (!report) {
            return;
        }
        const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(this.git.toAbsolutePath(report.defaultFileName)),
            filters: { Markdown: ['md'] },
            saveLabel: 'Save Report',
            title: 'Save the PR comparison report'
        });
        if (!target) {
            return;
        }
        const content = report.build(Array.from(this.comparison.values()).sort((a, b) => a.path.localeCompare(b.path)));
        await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
        const choice = await vscode.window.showInformationMessage(`Gitgg: Report saved to ${target.fsPath}`, 'Open', 'Reveal in File Explorer');
        if (choice === 'Open') {
            await vscode.window.showTextDocument(target, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        } else if (choice === 'Reveal in File Explorer') {
            await vscode.commands.executeCommand('revealFileInOS', target);
        }
    }

    /** Re-compares only `touchedPaths` (all files are kept), then sends the new state to the webview. */
    private async refresh(touchedPaths: string[]): Promise<void> {
        if (touchedPaths.length > 0) {
            this.setComparison(await this.git.compareWithWorkingTree(this.options.baseRef, touchedPaths));
        }
        await this.panel.webview.postMessage({ command: 'refresh', data: await this.buildPayload() });
    }

    private async buildPayload(): Promise<WebviewPayload> {
        const files = Array.from(this.comparison.values()).sort((a, b) => a.path.localeCompare(b.path));
        const byKind = (kind: FileComparison['kind']): WebviewFile[] => files
            .filter(file => file.kind === kind)
            .map(file => ({ filePath: file.path, patch: file.patch }));

        const { staged, unstaged } = await this.localChanges();
        return {
            addedFiles: byKind('added'),
            changedFiles: byKind('changed'),
            deletedFiles: byKind('deleted'),
            unchangedFiles: byKind('unchanged'),
            targetBranch: this.options.baseLabel,
            localFileLabel: this.options.localLabel,
            contextNote: this.options.contextNote,
            status: { staged, unstaged },
            restorableFiles: this.restorablePaths(),
            lineLimit: getConfig().diffLineLimit,
            hasReport: !!this.options.report
        };
    }

    private renderHtml(payload: WebviewPayload): string {
        const webview = this.panel.webview;
        const webviewRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
        const template = fs.readFileSync(vscode.Uri.joinPath(webviewRoot, 'webview.html').fsPath, 'utf8');
        const replacements: Record<string, string> = {
            _WEBVIEW_CSS_URI_: webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'webview.css')).toString(),
            _WEBVIEW_JS_URI_: webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.js')).toString(),
            _VSCODE_WEBVIEW_DATA_: serializeForScriptTag(payload),
            _CSP_SOURCE_: webview.cspSource,
            _NONCE_: crypto.randomBytes(16).toString('base64')
        };
        // A replacer function is used so `$&`, `$'` etc. inside file contents are inserted literally.
        return template.replace(/_WEBVIEW_CSS_URI_|_WEBVIEW_JS_URI_|_VSCODE_WEBVIEW_DATA_|_CSP_SOURCE_|_NONCE_/g, key => replacements[key]);
    }
}

function plural(count: number): string {
    return `${count} file${count === 1 ? '' : 's'}`;
}
