import * as vscode from 'vscode';
import { getConfig } from '../config';
import { compareWithProgress, runCancellable } from '../ui/feedback';
import { throwIfAborted } from '../utils/concurrency';
import { pickBranchWithFavorites } from '../ui/branchPicker';
import { resolveGitService } from '../ui/repo';
import { DiffPanel } from '../views/diffPanel';

/** Compares the selected branch with the current branch's working tree across the repository. */
export async function runCompareBranchesCommand(context: vscode.ExtensionContext): Promise<void> {
    const git = await resolveGitService();
    if (!git) {
        return;
    }

    const currentBranch = await git.getCurrentBranch();
    if (!currentBranch) {
        vscode.window.showErrorMessage('Gitgg: Could not determine the current branch. Please check out a branch first.');
        return;
    }

    const otherBranches = (await git.getBranches()).filter(branch => branch !== currentBranch);
    if (otherBranches.length === 0) {
        vscode.window.showErrorMessage('Gitgg: No other branches available for comparison.');
        return;
    }

    const targetBranch = await pickBranchWithFavorites(
        context,
        otherBranches,
        `Compare ${currentBranch} with another branch...`,
        currentBranch
    );
    if (!targetBranch) {
        return;
    }

    const config = getConfig();
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Gitgg: Comparing branches...',
        cancellable: true
    }, async (progress, token) => runCancellable(token, async signal => {
        progress.report({ message: `Resolving '${targetBranch}'...` });
        const target = await git.resolveBranchRef(targetBranch, config.fetchBeforeCompare, signal);
        if (target.warning) {
            vscode.window.showWarningMessage(`Gitgg: ${target.warning}`);
        }
        throwIfAborted(signal);

        progress.report({ message: 'Getting changed files...' });
        const changedPaths = await git.getChangedFilesBetweenRefs(target.ref, 'HEAD', signal);
        const workingTreePaths = (await git.getStatus(signal)).files.map(file => file.path);
        const filePaths = Array.from(new Set([...changedPaths, ...workingTreePaths])).sort((left, right) => left.localeCompare(right));
        if (filePaths.length === 0) {
            vscode.window.showInformationMessage(`Gitgg: No differences between ${currentBranch} and ${targetBranch}.`);
            return;
        }

        const hasWorkingTreeChanges = workingTreePaths.some(filePath => filePaths.includes(filePath));
        const localLabel = hasWorkingTreeChanges ? `${currentBranch} (working tree)` : currentBranch;
        const comparison = await compareWithProgress(git, target.ref, filePaths, progress, signal);
        throwIfAborted(signal);

        await DiffPanel.open(context, git, {
            viewType: 'gitgg-branch-comparison-view',
            title: `Branch Comparison: ${currentBranch} ↔ ${targetBranch} (${filePaths.length} files)`,
            baseRef: target.ref,
            baseLabel: targetBranch,
            localLabel,
            contextNote: `Gitgg compares ${targetBranch} with ${currentBranch}${hasWorkingTreeChanges ? ', including staged and unstaged working-tree changes' : ''}. Use the status filter to focus on added, changed or deleted files.`,
            filePaths,
            initialComparison: comparison
        });
    }));
}
