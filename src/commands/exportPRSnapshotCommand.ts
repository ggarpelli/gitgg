import * as vscode from 'vscode';
import { exportSnapshot, SnapshotCancelledError } from '../services/snapshotExportService';
import { pickBranchWithFavorites } from '../ui/branchPicker';
import { resolveGitService } from '../ui/repo';
import { getConfig } from '../config';

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
            title: 'Gitgg: Exporting PR snapshot...'
        }, async progress => {
            progress.report({ message: 'Getting changed files...' });
            const target = await git.resolveBranchRef(targetBranch, config.fetchBeforeCompare);
            if (target.warning) {
                vscode.window.showWarningMessage(`Gitgg: ${target.warning}`);
            }

            const changedFiles = await git.getChangedFilesBetweenRefs(target.ref, promotionBranch);
            if (changedFiles.length === 0) {
                vscode.window.showInformationMessage('Gitgg: No files changed between the branches.');
                return;
            }

            progress.report({ message: `Writing ${changedFiles.length} files...` });
            const result = await exportSnapshot(git, {
                workspacePath: git.getRepoPath(),
                folderName: config.snapshotFolder,
                sourceBranch: promotionBranch,
                sourceRef: promotionBranch,
                targetBranch,
                targetRef: target.ref,
                changedFiles,
                generatedAt: new Date(),
                confirmOverwrite: async folder => {
                    const choice = await vscode.window.showWarningMessage(
                        `The folder '${folder}' already exists and was not created by Gitgg. Delete it and replace it with the snapshot?`,
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
        });
    } catch (error) {
        if (error instanceof SnapshotCancelledError) {
            vscode.window.showInformationMessage(`Gitgg: ${error.message} Change the "gitgg.snapshotFolder" setting to use another folder.`);
            return;
        }
        throw error;
    }
}
