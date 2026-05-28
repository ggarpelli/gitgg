import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { exportSnapshot } from '../services/snapshotExportService';
import { pickBranchWithFavorites } from '../ui/branchPicker';

function getRepoPath(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
    }
    return workspaceFolders[0].uri.fsPath;
}

export async function runExportPRSnapshotCommand(context: vscode.ExtensionContext): Promise<void> {
    const repoPath = getRepoPath();
    if (!repoPath) {
        vscode.window.showErrorMessage('Could not determine Git workspace.');
        return;
    }

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Exporting PR snapshot...',
            cancellable: true
        }, async (progress, _token) => {
            progress.report({ increment: 0, message: 'Initializing...' });

            const gitService = new GitService(repoPath);
            const promotionBranch = await gitService.getCurrentBranch();
            if (!promotionBranch) {
                vscode.window.showErrorMessage('Could not determine current branch. Please check out a branch first.');
                return;
            }

            progress.report({ increment: 20, message: 'Getting available branches...' });

            const branches = await gitService.getAllBranches();
            if (branches.length === 0) {
                vscode.window.showErrorMessage('No branches found in repository.');
                return;
            }

            const otherBranches = branches.filter(branch => branch !== promotionBranch);
            if (otherBranches.length === 0) {
                vscode.window.showErrorMessage('No other branches available for selection.');
                return;
            }

            progress.report({ increment: 40, message: 'Selecting target branch...' });

            const targetBranch = await pickBranchWithFavorites(
                context,
                otherBranches,
                'Select target branch to compare with the current branch'
            );
            if (!targetBranch) {
                return;
            }

            const resolveRef = async (branch: string): Promise<string> => {
                try {
                    await gitService.getCommitSha('origin/' + branch);
                    return 'origin/' + branch;
                } catch {
                    return branch;
                }
            };

            progress.report({ increment: 70, message: 'Getting changed files between branches...' });

            const targetRef = await resolveRef(targetBranch);
            const changedFiles = await gitService.getChangedFilesBetweenRefs(targetRef, promotionBranch);
            if (changedFiles.length === 0) {
                vscode.window.showInformationMessage('No files changed between the branches.');
                return;
            }

            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showErrorMessage('Could not determine workspace folder for snapshot export.');
                return;
            }

            progress.report({ increment: 90, message: 'Writing snapshot files...' });

            const snapshotExport = await exportSnapshot(gitService, {
                workspacePath: workspaceFolder.uri.fsPath,
                sourceBranch: promotionBranch,
                sourceRef: promotionBranch,
                targetBranch,
                targetRef,
                changedFiles,
                generatedAt: new Date()
            });

            progress.report({ increment: 100, message: 'Snapshot export complete!' });

            vscode.window.showInformationMessage(`PR snapshot exported to: ${snapshotExport.snapshotRoot}`);
        });
    } catch (error) {
        console.error('Error exporting PR snapshot:', error);
        vscode.window.showErrorMessage('Failed to export PR snapshot: ' + (error instanceof Error ? error.message : String(error)));
    }
}
