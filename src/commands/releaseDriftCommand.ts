import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { DriftResult } from '../services/gitService';
import { DriftView } from '../views/driftView';
import simpleGit from 'simple-git';
import { pickBranchWithFavorites } from '../ui/branchPicker';

interface CommitItem extends vscode.QuickPickItem {
    sha: string;
}

export async function runReleaseDriftCommand(context: vscode.ExtensionContext, commitSha?: string): Promise<void> {
    const repoPath = getRepoPath();
    if (!repoPath) {
        vscode.window.showErrorMessage('Could not determine Git workspace.');
        return;
    }

    const gitService = new GitService(repoPath);

    // If no SHA provided, show branch picker then commit picker
    if (!commitSha) {
        const selection = await showBranchPicker(context, gitService, repoPath);
        if (!selection) return;

        // If user entered SHA directly, use it
        if (selection.sha) {
            commitSha = selection.sha;
        } else if (selection.branch) {
            const selectedSha = await showCommitPicker(repoPath, selection.branch);
            if (!selectedSha) return;
            commitSha = selectedSha;
        }
    }

    if (!commitSha) {
        vscode.window.showErrorMessage('No commit SHA provided.');
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'GitGG: Detecting drift...',
        cancellable: true
    }, async (progress, token) => {
        progress.report({ increment: 0, message: 'Analyzing commit...' });

        try {
            const driftResult = await gitService.detectDrift(commitSha);

            if (token.isCancellationRequested) return;

            progress.report({ increment: 100, message: 'Rendering drift view...' });

            await showDriftWebview(context, driftResult, gitService);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error detecting drift: ${error.message}`);
        }
    });
}

async function showBranchPicker(context: vscode.ExtensionContext, gitService: GitService, repoPath: string): Promise<{ branch?: string; sha?: string } | undefined> {
    const branches = await gitService.getAllBranches();
    const currentBranch = await gitService.getCurrentBranch();

    const pickMode = await vscode.window.showQuickPick([
        { label: '$(git-branch) Select branch', value: 'branch' },
        { label: '$(git-commit) Enter SHA manually...', value: 'sha' }
    ], {
        placeHolder: 'Select a branch to view commits, or paste a SHA directly'
    });

    if (!pickMode) return undefined;

    // If manual option selected, ask for SHA
    if (pickMode.value === 'sha') {
        const shaInput = await vscode.window.showInputBox({
            prompt: 'Enter commit SHA (full or short hash)',
            placeHolder: 'e.g., abc1234 or abc1234567890abcdef',
            validateInput: async (value) => {
                if (!value || value.trim().length < 4) {
                    return 'Please enter a valid commit SHA (at least 4 characters)';
                }
                try {
                    const git = simpleGit({ baseDir: repoPath });
                    await git.raw(['rev-parse', '--verify', value.trim()]);
                    return null;
                } catch {
                    return 'Invalid commit SHA - could not verify';
                }
            }
        });

        if (!shaInput) return undefined;

        // Get full SHA if short hash was provided
        try {
            const git = simpleGit({ baseDir: repoPath });
            const fullSha = await git.raw(['rev-parse', shaInput.trim()]);
            return { sha: fullSha.trim() };
        } catch {
            return { sha: shaInput.trim() };
        }
    }

    const decoratedBranches = branches.map(branch =>
        branch === currentBranch ? `${branch} (current)` : branch
    );

    const selectedBranch = await pickBranchWithFavorites(
        context,
        decoratedBranches,
        'Select a branch (Favorites ⭐️ are listed first)'
    );

    if (!selectedBranch) return undefined;

    return { branch: selectedBranch.replace(/\s\(current\)$/, '') };
}

async function showCommitPicker(repoPath: string, branch?: string): Promise<string | undefined> {
    // Get recent commits using git log, filtered by branch if specified
    const git = simpleGit({ baseDir: repoPath });
    const args = ['log', '--format=%H|%s', '-n', '50'];
    if (branch) {
        args.push(branch);
    }
    const result = await git.raw(args);

    const commits: CommitItem[] = result.trim().split('\n')
        .filter((line: string) => line.includes('|'))
        .map((line: string) => {
            const parts = line.split('|');
            const sha = parts[0]?.trim() || '';
            const message = parts.slice(1).join('|').trim();
            return {
                label: message.substring(0, 70) + (message.length > 70 ? '...' : ''),
                description: sha.substring(0, 7),
                sha
            };
        });

    // Add "Enter SHA manually" option at the top
    const manualOption: CommitItem = {
        label: '$(git-commit) Enter SHA manually...',
        description: 'Paste or type a commit hash',
        sha: ''
    };

    const options = [manualOption, ...commits];

    const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select a commit to compare against current branch'
    });

    if (!selected) return undefined;

    // If manual option selected, ask for SHA
    if (selected.sha === '') {
        const shaInput = await vscode.window.showInputBox({
            prompt: 'Enter commit SHA (full or short hash)',
            placeHolder: 'e.g., abc1234 or abc1234567890abcdef',
            validateInput: async (value) => {
                if (!value || value.trim().length < 4) {
                    return 'Please enter a valid commit SHA (at least 4 characters)';
                }
                // Validate that the SHA exists
                try {
                    await git.raw(['rev-parse', '--verify', value.trim()]);
                    return null;
                } catch {
                    return 'Invalid commit SHA - could not verify';
                }
            }
        });

        if (!shaInput) return undefined;

        // Get full SHA if short hash was provided
        try {
            const fullSha = await git.raw(['rev-parse', shaInput.trim()]);
            return fullSha.trim();
        } catch {
            return shaInput.trim();
        }
    }

    return selected.sha;
}

async function showDriftWebview(
    context: vscode.ExtensionContext,
    driftResult: DriftResult,
    gitService: GitService
): Promise<void> {
    const driftView = new DriftView();
    context.subscriptions.push(driftView);
    await driftView.show(context, driftResult, gitService);
}

async function stageFromDrift(
    gitService: GitService,
    driftResult: DriftResult,
    filePath: string
): Promise<void> {
    // Get content from commit
    const content = await gitService.getFileContent(driftResult.commitSha, filePath);

    if (content === null) {
        // File doesn't exist in commit - delete from working tree
        await gitService.deleteFile(filePath);
    } else {
        // Write content to working tree first
        await gitService.writeToWorkingTree(filePath, content);
    }

    // Now stage it
    await gitService.stageFile(filePath);
}

async function refreshDriftView(
    panel: vscode.WebviewPanel,
    gitService: GitService,
    driftResult: DriftResult
): Promise<void> {
    const newResult = await gitService.detectDrift(driftResult.commitSha);
    panel.webview.postMessage({ command: 'update', data: newResult });
}

function getDriftWebviewContent(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    driftResult: DriftResult,
    currentBranch: string
): string {
    const nonce = require('crypto').randomBytes(16).toString('base64');

    const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'webview.html');
    const cssPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'webview.css');
    const jsPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'main.js');

    const cssUri = webview.asWebviewUri(cssPath);
    const jsUri = webview.asWebviewUri(jsPath);

    let htmlContent = require('fs').readFileSync(htmlPath.fsPath, 'utf8');

    const webviewData = {
        driftResult,
        currentBranch
    };

    htmlContent = htmlContent.replace(/_WEBVIEW_CSS_URI_/g, cssUri.toString());
    htmlContent = htmlContent.replace(/_WEBVIEW_JS_URI_/g, jsUri.toString());
    htmlContent = htmlContent.replace('_VSCODE_WEBVIEW_DATA_', JSON.stringify(webviewData));
    htmlContent = htmlContent.replace(/_CSP_SOURCE_/g, webview.cspSource);
    htmlContent = htmlContent.replace(/_NONCE_/g, nonce);

    return htmlContent;
}

function getRepoPath(): string | undefined {
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    return undefined;
}