import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { FileComparison, GitService } from '../services/gitService';
import { serializeForScriptTag } from '../utils/patch';
import { backupStore } from '../services/backupStore';
import { createAbortError, isAbortError } from '../utils/concurrency';
import { openRefDiff } from '../ui/refContentProvider';
import { fireFilesChanged, onDidChangeFiles, saveDirtyDocuments } from '../ui/fileEvents';
import { getConfig } from '../config';
import { errorMessage, logError, showError } from '../ui/feedback';
import { buildSalesforcePackageManifest } from '../services/salesforcePackage';

/** Optional report the user can save from the panel (used by PR Comparison). */
export interface PanelReport {
    /** Suggested file name for the save dialog. */
    defaultFileName: string;
    /** Builds the report from the current comparison, so it reflects actions done in the panel. */
    build(files: FileComparison[]): string;
}

export interface PanelPackageXml {
    defaultFileName: string;
    apiVersion: string;
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
    packageXml?: PanelPackageXml;
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
    /** Shows the "Save Salesforce package.xml" button. */
    hasPackageXml: boolean;
}

interface PanelMessage {
    command: string;
    path?: string;
    /** Explicit file paths for actions such as selective staging and undo. */
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
    run(report: (message: string) => void, reportFiles: (phase: string, done: number, total: number) => void): Promise<string>;
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
    /** Title of the action currently running, or undefined when idle. */
    private running: string | undefined;
    /** Repository-changing clicks are processed in FIFO order so users can keep working. */
    private readonly actionQueue: PanelMessage[] = [];
    private processingQueue = false;
    private readonly pendingExternalRefresh = new Set<string>();

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
            void this.handleMessage(msg).catch(error => showError('Action failed', error));
        });
        // Keep in sync with changes made from diff tabs or other panels.
        const changeListener = onDidChangeFiles(event => {
            if (event.source === this || event.repoPath !== git.getRepoPath()) {
                return;
            }
            const touched = event.paths.filter(filePath => this.comparison.has(filePath));
            if (touched.length > 0) {
                if (this.processingQueue || this.running) {
                    touched.forEach(filePath => this.pendingExternalRefresh.add(filePath));
                } else {
                    void this.refresh(touched).catch(() => undefined);
                }
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
        // Open and export actions stay available while a repository-changing action runs.
        if (msg.command === 'openDiff' && msg.path) {
            await openRefDiff(this.git, this.options.baseRef, msg.path, this.options.baseLabel, this.options.localLabel);
            return;
        }
        if (msg.command === 'saveReport') {
            await this.saveReport();
            return;
        }
        if (msg.command === 'savePackageXml') {
            await this.savePackageXml();
            return;
        }

        this.actionQueue.push(msg);
        await this.postQueueStatus();
        void this.processActionQueue();
    }

    /** Processes accepted clicks in order, planning each one against the latest repository state. */
    private async processActionQueue(): Promise<void> {
        if (this.processingQueue) {
            return;
        }
        this.processingQueue = true;
        try {
            while (this.actionQueue.length > 0) {
                const msg = this.actionQueue.shift()!;
                this.running = 'Preparing action';
                await this.postQueueStatus();
                let action: PlannedAction | undefined;
                try {
                    action = msg.command === 'undo'
                        ? await this.planRestore(msg.paths ?? [], false)
                        : await this.planAction(msg);
                    if (!action) {
                        await this.post({ command: 'result', kind: 'warning', text: this.nothingToDoMessage(msg.command) });
                        continue;
                    }
                    this.running = action.title;
                    await this.postQueueStatus();
                    await this.runAction(action);
                } catch (error) {
                    // runAction already reports its own failures. This branch reports planning errors only.
                    if (!isAbortError(error) && !action) {
                        logError('Preparing action', error);
                        await this.post({ command: 'result', kind: 'error', text: `Action failed: ${errorMessage(error).split('\n')[0]}`, details: errorMessage(error) });
                        await showError('Action failed', error);
                    }
                } finally {
                    this.running = undefined;
                    await this.refreshPendingExternalChanges();
                    await this.postQueueStatus();
                }
            }
        } finally {
            await this.refreshPendingExternalChanges();
            this.processingQueue = false;
            this.running = undefined;
            await this.postQueueStatus();
        }
    }

    private async refreshPendingExternalChanges(): Promise<void> {
        while (this.pendingExternalRefresh.size > 0) {
            const paths = Array.from(this.pendingExternalRefresh);
            this.pendingExternalRefresh.clear();
            this.running = 'Refreshing the comparison';
            try {
                await this.refresh(paths);
            } catch (error) {
                logError('Refreshing the comparison', error);
            } finally {
                this.running = undefined;
            }
        }
    }

    private async postQueueStatus(): Promise<void> {
        const activeOffset = this.running ? 1 : 0;
        await this.post({
            command: 'queue',
            active: !!this.running,
            pending: this.actionQueue.length,
            items: this.actionQueue.map((msg, index) => ({
                path: msg.path ?? msg.paths?.[0],
                position: index + 1 + activeOffset,
                label: this.queueActionLabel(msg)
            }))
        });
    }

    private queueActionLabel(msg: PanelMessage): string {
        const base = this.options.baseLabel;
        switch (msg.command) {
            case 'acceptFile':
                return `Use ${base} version`;
            case 'acceptFiles':
                return `Use ${base} version for ${plural(msg.paths?.length ?? 0)}`;
            case 'acceptAll':
                return `Use all from ${base}`;
            case 'stageFile':
            case 'stageFiles':
            case 'stageAll':
                return 'Stage files';
            case 'unstageFile':
            case 'unstageAll':
                return 'Unstage files';
            case 'revertFile':
            case 'revertAll':
                return 'Revert files';
            case 'restoreFile':
            case 'restoreAll':
            case 'undo':
                return 'Restore files';
            default:
                return 'Action';
        }
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
                const reportFiles = (phase: string, done: number, total: number) => {
                    const detail = `${phase} ${done.toLocaleString()} of ${total.toLocaleString()} files...`;
                    progress.report({ message: detail });
                    void this.post({ command: 'busy', ...scope, text: action.title, detail, step, totalSteps });
                };
                await saveDirtyDocuments(this.git, action.touchedPaths);
                if (action.bulk) {
                    reportFiles(action.title.split(' ')[0], 0, action.affectedPaths.length);
                }
                const text = await action.run(report, reportFiles);
                if (action.bulk) {
                    reportFiles(action.title.split(' ')[0], action.affectedPaths.length, action.affectedPaths.length);
                }
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
                    run: async (report, reportFiles) => {
                        report('git add...');
                        await this.git.stageFiles(paths, (done, total) => reportFiles('Staging', done, total));
                        return `Staged ${plural(paths.length)}.`;
                    }
                };
            }
            case 'stageFiles': {
                const requested = new Set(msg.paths ?? []);
                const paths = (await this.localChanges()).unstaged.filter(path => requested.has(path));
                return paths.length === 0 ? undefined : {
                    title: `Staging ${plural(paths.length)}`, touchedPaths: [], affectedPaths: paths, bulk: paths.length > 1, steps: 1,
                    run: async (report, reportFiles) => {
                        report('git add...');
                        await this.git.stageFiles(paths, (done, total) => reportFiles('Staging', done, total));
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
                    run: async (report, reportFiles) => {
                        report('git reset...');
                        await this.git.unstageFiles(paths, (done, total) => reportFiles('Unstaging', done, total));
                        return `Unstaged ${plural(paths.length)}.`;
                    }
                };
            }
            case 'acceptFile':
            case 'acceptFiles':
            case 'acceptAll': {
                const changedPaths = this.changedPaths();
                const requestedPaths = new Set(msg.paths ?? []);
                const paths = msg.command === 'acceptFile'
                    ? [filePath]
                    : msg.command === 'acceptFiles'
                        ? changedPaths.filter(path => requestedPaths.has(path))
                        : changedPaths;
                if (paths.length === 0) {
                    return undefined;
                }
                if (paths.length > 1) {
                    await this.confirm(
                        `Replace ${plural(paths.length)} with their version from ${base} and stage them? You can undo it with "Restore All Changes".`,
                        `Use ${base} version`);
                }
                return {
                    title: `Using the ${base} version of ${plural(paths.length)}`, touchedPaths: paths, affectedPaths: paths, bulk: paths.length > 1, steps: 3,
                    rowPath: msg.command === 'acceptFile' ? filePath : undefined, undoable: true,
                    run: async (report, reportFiles) => {
                        await backupStore.apply(this.git, paths, () => this.git.takeFilesFromRef(
                            this.options.baseRef,
                            paths,
                            (done, total) => reportFiles('Updating files', done, total)
                        ), report, reportFiles);
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
                await this.confirm(
                    `Revert ${target} to the version in your current branch (HEAD)? Staged and unstaged changes will be discarded. You can undo it with "Restore Changes".`,
                    'Revert');
                return {
                    title: `Reverting ${plural(paths.length)}`, touchedPaths: paths, affectedPaths: paths, bulk: paths.length > 1, steps: 3,
                    rowPath: msg.command === 'revertFile' ? filePath : undefined, undoable: true,
                    run: async (report, reportFiles) => {
                        const changed = await backupStore.apply(this.git, paths, () => this.git.revertToHead(
                            paths,
                            (done, total) => reportFiles('Updating files', done, total)
                        ), report, reportFiles);
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
            await this.confirm(message, 'Restore');
        } else {
            const skipNote = editedSince.size > 0 ? ` ${plural(editedSince.size)} edited since then will be skipped.` : '';
            await this.confirm(`Restore ${plural(entries.length)} to how they were before?${skipNote}`, 'Restore All');
            toRestore = entries.filter(entry => !editedSince.has(entry.filePath));
        }

        return {
            title: `Restoring ${plural(toRestore.length)}`,
            touchedPaths: toRestore.map(entry => entry.filePath),
            affectedPaths: toRestore.map(entry => entry.filePath),
            bulk: toRestore.length > 1,
            steps: 2,
            rowPath: askConfirmation && entries.length === 1 ? entries[0].filePath : undefined,
            run: async (report, reportFiles) => {
                await backupStore.restore(this.git, toRestore, report, reportFiles);
                const skipped = entries.length - toRestore.length;
                return `Restored ${plural(toRestore.length)}.${skipped > 0 ? ` Skipped ${plural(skipped)} edited since the last action.` : ''}`;
            }
        };
    }

    /** Asks for confirmation; throws an AbortError (a silent stop) when the user declines. */
    private async confirm(message: string, action: string): Promise<void> {
        if (await vscode.window.showWarningMessage(message, { modal: true }, action) !== action) {
            throw createAbortError();
        }
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

    /** Explains why a button did nothing, so it never looks broken. */
    private nothingToDoMessage(command: string): string {
        const base = this.options.baseLabel;
        switch (command) {
            case 'stageFile':
            case 'stageAll':
            case 'stageFiles':
                return 'Nothing to stage: no file here has unstaged changes.';
            case 'unstageFile':
            case 'unstageAll':
                return 'Nothing to unstage: no file here is staged.';
            case 'acceptFile':
            case 'acceptFiles':
            case 'acceptAll':
                return `Nothing to do: every file here already matches ${base}.`;
            case 'revertFile':
            case 'revertAll':
                return 'Nothing to revert: no file here differs from your current branch (HEAD).';
            default:
                return 'Nothing to restore: no file here was changed from this panel.';
        }
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

    /** Saves the Salesforce Metadata API package.xml for the Salesforce components in this comparison. */
    private async savePackageXml(): Promise<void> {
        const packageXml = this.options.packageXml;
        if (!packageXml) {
            return;
        }
        const files = Array.from(this.comparison.values());
        const manifest = buildSalesforcePackageManifest(
            files.filter(file => file.localContent !== null).map(file => file.path),
            packageXml.apiVersion
        );
        if (manifest.componentCount === 0) {
            await vscode.window.showInformationMessage('Gitgg: No Salesforce metadata components remain in this comparison to include in a Salesforce package.xml manifest.');
            return;
        }

        const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(this.git.toAbsolutePath(packageXml.defaultFileName)),
            filters: { XML: ['xml'] },
            saveLabel: 'Save package.xml',
            title: 'Save Salesforce package.xml manifest'
        });
        if (!target) {
            return;
        }
        await vscode.workspace.fs.writeFile(target, Buffer.from(manifest.xml, 'utf8'));
        const choice = await vscode.window.showInformationMessage(
            `Gitgg: Saved Salesforce package.xml with ${manifest.componentCount} recognized metadata component${manifest.componentCount === 1 ? '' : 's'} across ${manifest.typeCount} type${manifest.typeCount === 1 ? '' : 's'}. Other file types are omitted; deletions require a Salesforce destructiveChanges.xml manifest.`,
            'Open', 'Reveal in File Explorer'
        );
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
            hasReport: !!this.options.report,
            hasPackageXml: !!this.options.packageXml
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
