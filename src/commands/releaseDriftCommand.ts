import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { DriftResult } from '../services/gitService';
import { DriftView } from '../views/driftView';
import simpleGit, { SimpleGit } from 'simple-git';
import { pickBranchWithFavorites } from '../ui/branchPicker';

interface CommitItem extends vscode.QuickPickItem {
    sha: string;
    buttons?: vscode.QuickInputButton[];
}

const FAVORITE_COMMITS_KEY = 'favoriteCommits';
const StarIcon = new vscode.ThemeIcon('star-full');
const StarEmptyIcon = new vscode.ThemeIcon('star-empty');

interface FavoriteCommit {
    sha: string;
    alias: string;
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
            const selectedSha = await showCommitPicker(context, repoPath, selection.branch);
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

    const favoriteCommits = context.globalState.get<FavoriteCommit[]>(FAVORITE_COMMITS_KEY, []);
    const modeOptions = [
        { label: '$(git-branch) Select branch', value: 'branch' },
        { label: '$(git-commit) Enter SHA manually...', value: 'sha' },
        { label: '$(folder-library) Favorite Hashes', value: 'favorites' }
    ];

    const pickMode = await vscode.window.showQuickPick(modeOptions, {
        placeHolder: 'Select a branch, paste a SHA, or open favorite hashes'
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

    if (pickMode.value === 'favorites') {
        if (favoriteCommits.length === 0) {
            vscode.window.showInformationMessage('No favorite hashes saved yet.');
            return undefined;
        }

        const selectedFavorite = await vscode.window.showQuickPick(
            favoriteCommits.map(f => ({
                label: `$(star-full) ${f.alias}`,
                description: f.sha.substring(0, 7),
                detail: f.sha,
                sha: f.sha
            })),
            { placeHolder: 'Select a favorite hash' }
        );

        if (!selectedFavorite) return undefined;
        return { sha: selectedFavorite.sha };
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

async function showCommitPicker(context: vscode.ExtensionContext, repoPath: string, branch?: string): Promise<string | undefined> {
    // Get recent commits using git log, filtered by branch if specified
    const git = simpleGit({ baseDir: repoPath });
    const args = ['log', '--format=%H|%s', '-n', '50'];
    if (branch) {
        args.push(branch);
    }
    const result = await git.raw(args);


    const favorites = context.globalState.get<FavoriteCommit[]>(FAVORITE_COMMITS_KEY, []);
    const favoriteItems: CommitItem[] = favorites.map(f => ({
        label: `$(star-full) ${f.alias}`,
        description: f.sha.substring(0, 7),
        detail: f.sha,
        sha: f.sha,
        buttons: [{ iconPath: StarIcon, tooltip: "Remove from favorites" }]
    }));

    const commits: CommitItem[] = result.trim().split('\n')
        .filter((line: string) => line.includes('|'))
        .map((line: string) => {
            const parts = line.split('|');
            const sha = parts[0]?.trim() || '';
            const message = parts.slice(1).join('|').trim();
            return {
                label: message.substring(0, 70) + (message.length > 70 ? '...' : ''),
                description: sha.substring(0, 7),
                sha,
                buttons: [{ iconPath: StarEmptyIcon, tooltip: 'Add to favorites' }]
            };
        });

    // Add "Enter SHA manually" option at the top
    const manualOption: CommitItem = {
        label: '$(git-commit) Enter SHA manually...',
        description: 'Paste or type a commit hash',
        sha: ''
    };

    const options = [manualOption, ...favoriteItems, ...commits.filter(c => !favorites.some(f => f.sha === c.sha))];

    const pick = vscode.window.createQuickPick<CommitItem>();
    pick.items = options;
    pick.placeholder = 'Select a commit to compare against current branch';

    const selected = await new Promise<CommitItem | undefined>((resolve) => {
        pick.onDidAccept(() => { resolve(pick.selectedItems[0]); pick.hide(); });
        pick.onDidTriggerItemButton(async ({ item }) => {
            let current = context.globalState.get<FavoriteCommit[]>(FAVORITE_COMMITS_KEY, []);
            const existing = current.find(f => f.sha === item.sha);
            if (existing) {
                current = current.filter(f => f.sha !== item.sha);
            } else {
                const alias = await vscode.window.showInputBox({ prompt: "Favorite name (alias)", value: item.label.replace(/^\$\(star-full\)\s*/, '') });
                if (!alias) return;
                current.push({ sha: item.sha, alias: alias.trim() || item.sha.substring(0, 7) });
            }
            await context.globalState.update(FAVORITE_COMMITS_KEY, current);
            pick.items = [manualOption, ...current.map(f => ({ label: `$(star-full) ${f.alias}`, description: f.sha.substring(0,7), detail: f.sha, sha: f.sha, buttons: [{ iconPath: StarIcon, tooltip: "Remove from favorites" }] })), ...commits.filter(c => !current.some(f => f.sha === c.sha)).map(c => ({...c, buttons:[{ iconPath: StarEmptyIcon, tooltip:"Add to favorites" }]}))];
        });
        pick.onDidHide(() => { resolve(undefined); pick.dispose(); });
        pick.show();
    });

    if (!selected) return undefined;

    if (selected.sha && selected.sha !== "") return selected.sha;

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