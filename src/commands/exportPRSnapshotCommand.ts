import * as vscode from 'vscode';
import { exportSnapshot, SnapshotCancelledError } from '../services/snapshotExportService';
import { pickBranchWithFavorites } from '../ui/branchPicker';
import { resolveGitService } from '../ui/repo';
import { getConfig } from '../config';
import { isAbortError } from '../utils/concurrency';

export async function runExportPRSnapshotCommand(context: vscode.ExtensionContext): Promise<void> {
    const git = await resolveGitService();
    if (!git) {
        return;
    }

    const promotionBranch = await git.getCurrentBranch();
    if (!promotionBranch) {
        vscode.window.showErrorMessage('Gitgg: Could not determine the current branch. Please check out a branch first.');
        return;
    }

    const otherBranches = (await git.getBranches()).filter(branch => branch !== promotionBranch);
    if (otherBranches.length === 0) {
        vscode.window.showErrorMessage('Gitgg: No other branches available for selection.');
        return;
    }

    const targetBranch = await pickBranchWithFavorites(context, otherBranches, 'Select target branch to compare with the current branch');
    if (!targetBranch) {
        return;
    }

    const config = getConfig();
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Gitgg: Exporting PR snapshot...',
            cancellable: true
        }, async (progress, token) => {
            const abortController = new AbortController();
            const cancellation = token.onCancellationRequested(() => abortController.abort());
            progress.report({ message: 'Getting changed files...' });
            try {
                const target = await git.resolveBranchRef(targetBranch, config.fetchBeforeCompare, abortController.signal);
                if (target.warning) {
                    vscode.window.showWarningMessage(`Gitgg: ${target.warning}`);
                }
                if (token.isCancellationRequested) {
                    return;
                }

                const changedFiles = await git.getChangedFilesBetweenRefs(target.ref, promotionBranch, abortController.signal);
                if (changedFiles.length === 0) {
                    vscode.window.showInformationMessage('Gitgg: No files changed between the branches.');
                    return;
                }

                progress.report({ message: `Preparing ${changedFiles.length.toLocaleString()} files...` });
                let reportedPercent = 0;
                const result = await exportSnapshot(git, {
                    workspacePath: git.getRepoPath(),
                    folderName: config.snapshotFolder,
                    sourceBranch: promotionBranch,
                    sourceRef: promotionBranch,
                    targetBranch,
                    targetRef: target.ref,
                    changedFiles,
                    generatedAt: new Date(),
                    signal: abortController.signal,
                    onProgress: (done, total, phase) => {
                        const fraction = total === 0 ? 1 : done / total;
                        const percent = phase === 'Reading files'
                            ? Math.floor(fraction * 40)
                            : 40 + Math.floor(fraction * 60);
                        progress.report({
                            message: `${phase} ${done.toLocaleString()} of ${total.toLocaleString()} files...`,
                            increment: Math.max(0, percent - reportedPercent)
                        });
                        reportedPercent = Math.max(reportedPercent, percent);
                    },
                    confirmOverwrite: async folder => {
                        const choice = await vscode.window.showWarningMessage(
                            `The folder '${folder}' already exists and was not created by Gitgg. Delete it and replace it?`,
                            { modal: true },
                            'Delete and Replace'
                        );
                        return choice === 'Delete and Replace';
                    }
                });

                const choice = await vscode.window.showInformationMessage(`Gitgg: PR snapshot exported to ${result.snapshotRoot}`, 'Open Summary');
                if (choice) {
                    await vscode.window.showTextDocument(vscode.Uri.file(result.summaryPath));
                }
            } finally {
                cancellation.dispose();
            }
        });
    } catch (error) {
        if (isAbortError(error)) {
            vscode.window.showInformationMessage('Gitgg: PR snapshot export cancelled.');
            return;
        }
        if (error instanceof SnapshotCancelledError) {
            vscode.window.showInformationMessage(`Gitgg: ${error.message} Change the "gitgg.snapshotFolder" setting to use another folder.`);
            return;
        }
        throw error;
    }
}
