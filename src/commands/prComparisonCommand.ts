import * as vscode from 'vscode';
import { pickBranchWithFavorites } from '../ui/branchPicker';
import { resolveGitService } from '../ui/repo';
import { DiffPanel } from '../views/diffPanel';
import { compareWithProgress } from '../ui/feedback';
import { buildPRComparisonReport, toComparisonStatus } from '../services/prReport';
import { getConfig } from '../config';

export async function runPRComparisonCommand(context: vscode.ExtensionContext): Promise<void> {
    const git = await resolveGitService();
    if (!git) {
        return;
    }

    // The current branch is the promotion branch (what would be merged).
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

    const destinationBranch = await pickBranchWithFavorites(context, otherBranches, 'Select destination branch (where the PR would go)');
    if (!destinationBranch) {
        return;
    }
    const environmentBranch = await pickBranchWithFavorites(context, otherBranches, 'Select environment branch (source of truth)');
    if (!environmentBranch) {
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Gitgg: Comparing PR changes...',
        cancellable: true
    }, async (progress, token) => {
        const fetchFirst = getConfig().fetchBeforeCompare;
        progress.report({ message: 'Resolving branches...' });
        const destination = await git.resolveBranchRef(destinationBranch, fetchFirst);
        const environment = await git.resolveBranchRef(environmentBranch, fetchFirst);
        for (const warning of [destination.warning, environment.warning]) {
            if (warning) {
                vscode.window.showWarningMessage(`Gitgg: ${warning}`);
            }
        }

        progress.report({ message: 'Getting changed files...' });
        const changedFiles = await git.getChangedFilesBetweenRefs(destination.ref, 'HEAD');
        if (changedFiles.length === 0) {
            vscode.window.showInformationMessage('Gitgg: No files changed between the branches.');
            return;
        }

        progress.report({ message: `Analyzing ${changedFiles.length} files...` });
        const comparison = await compareWithProgress(git, environment.ref, changedFiles, progress, token);
        if (token.isCancellationRequested) {
            return;
        }

        const safeBranch = promotionBranch.replace(/[\\/:*?"<>|\s]+/g, '-');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

        await DiffPanel.open(context, git, {
            viewType: 'gitgg-pr-comparison-view',
            title: `PR Comparison: ${promotionBranch} → ${destinationBranch} (vs ${environmentBranch})`,
            baseRef: environment.ref,
            baseLabel: environmentBranch,
            localLabel: `${promotionBranch} (working tree)`,
            contextNote: `The file list is the committed tree diff between ${promotionBranch} (HEAD) and ${destinationBranch}. For those files, Gitgg compares the current working-tree contents on ${promotionBranch} (including staged and unstaged edits) with ${environmentBranch}.`,
            filePaths: changedFiles,
            initialComparison: comparison,
            // Saved on demand from the panel ("Save Report"), built from the current state of the comparison.
            report: {
                defaultFileName: `pr-comparison-${safeBranch}-${timestamp}.md`,
                build: files => buildPRComparisonReport({
                    promotionBranch,
                    destinationBranch,
                    environmentBranch,
                    results: files.map(file => ({ path: file.path, status: toComparisonStatus(file.kind) })),
                    generatedAt: new Date()
                })
            }
        });
    });
}
