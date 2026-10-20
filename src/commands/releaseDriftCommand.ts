import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { pickBranchWithFavorites } from '../ui/branchPicker';
import { resolveGitService } from '../ui/repo';
import { DiffPanel } from '../views/diffPanel';
import { compareWithProgress } from '../ui/feedback';

const FAVORITE_COMMITS_KEY = 'favoriteCommits';
const StarIcon = new vscode.ThemeIcon('star-full');
const StarEmptyIcon = new vscode.ThemeIcon('star-empty');

interface FavoriteCommit {
    sha: string;
    alias: string;
}

interface CommitItem extends vscode.QuickPickItem {
    sha: string;
}

export async function runReleaseDriftCommand(context: vscode.ExtensionContext, commitSha?: string): Promise<void> {
    const git = await resolveGitService();
    if (!git) {
        return;
    }

    const sha = commitSha ? await git.getCommitSha(commitSha) : await pickCommit(context, git);
    if (!sha) {
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Gitgg: Detecting drift...',
        cancellable: true
    }, async (progress, token) => {
        const [changedFiles, commitMessage] = await Promise.all([
            git.getChangedFilesInCommit(sha),
            git.getCommitMessage(sha)
        ]);
        if (changedFiles.length === 0) {
            vscode.window.showInformationMessage(`Gitgg: Commit ${sha.substring(0, 7)} does not change any file.`);
            return;
        }

        const filePaths = changedFiles.map(file => file.path);
        const comparison = await compareWithProgress(git, sha, filePaths, progress, token);
        if (token.isCancellationRequested) {
            return;
        }

        await DiffPanel.open(context, git, {
            viewType: 'gitgg-drift-view',
            title: `Drift: ${sha.substring(0, 7)} ${commitMessage} → Working Tree`,
            baseRef: sha,
            baseLabel: sha.substring(0, 7),
            localLabel: 'Working Tree',
            filePaths,
            initialComparison: comparison
        });
    });
}

async function pickCommit(context: vscode.ExtensionContext, git: GitService): Promise<string | undefined> {
    const mode = await vscode.window.showQuickPick([
        { label: '$(git-branch) Select branch', value: 'branch' },
        { label: '$(git-commit) Enter SHA manually...', value: 'sha' },
        { label: '$(folder-library) Favorite Hashes', value: 'favorites' }
    ], { placeHolder: 'Select a branch, paste a SHA, or open favorite hashes' });

    if (!mode) {
        return undefined;
    }
    if (mode.value === 'sha') {
        return promptForSha(context, git);
    }
    if (mode.value === 'favorites') {
        const favorites = getFavorites(context);
        if (favorites.length === 0) {
            vscode.window.showInformationMessage('Gitgg: No favorite hashes saved yet.');
            return undefined;
        }
        const selected = await vscode.window.showQuickPick(favorites.map(favoriteItem), { placeHolder: 'Select a favorite hash' });
        return selected?.sha;
    }

    const currentBranch = await git.getCurrentBranch();
    const branch = await pickBranchWithFavorites(context, await git.getBranches(), 'Select a branch (Favorites ⭐️ are listed first)', currentBranch);
    if (!branch) {
        return undefined;
    }
    const { ref } = await git.resolveBranchRef(branch, false);
    const branchRef = (await git.refExists(`refs/heads/${branch}`)) ? branch : ref;
    return pickCommitFromBranch(context, git, branchRef);
}

async function pickCommitFromBranch(context: vscode.ExtensionContext, git: GitService, branchRef: string): Promise<string | undefined> {
    const commits = await git.getRecentCommits(branchRef, 50);
    const manualOption: CommitItem = { label: '$(git-commit) Enter SHA manually...', description: 'Paste or type a commit hash', sha: '' };

    const buildItems = (): CommitItem[] => {
        const favorites = getFavorites(context);
        const commitItems = commits
            .filter(commit => !favorites.some(favorite => favorite.sha === commit.sha))
            .map<CommitItem>(commit => ({
                label: commit.subject.length > 70 ? commit.subject.substring(0, 70) + '...' : commit.subject,
                description: commit.sha.substring(0, 7),
                sha: commit.sha,
                buttons: [{ iconPath: StarEmptyIcon, tooltip: 'Add to favorites' }]
            }));
        return [manualOption, ...favorites.map(favoriteItem), ...commitItems];
    };

    const pick = vscode.window.createQuickPick<CommitItem>();
    pick.items = buildItems();
    pick.placeholder = `Select a commit from ${branchRef} to compare with the working tree`;

    let askingAlias = false;
    const selected = await new Promise<CommitItem | undefined>(resolve => {
        pick.onDidAccept(() => {
            resolve(pick.selectedItems[0]);
            pick.hide();
        });
        pick.onDidTriggerItemButton(async ({ item }) => {
            if (getFavorites(context).some(favorite => favorite.sha === item.sha)) {
                await removeFavorite(context, item.sha);
            } else {
                // The alias input box temporarily replaces (hides) the quick pick; reopen it afterwards.
                askingAlias = true;
                await addFavorite(context, item.sha, item.label);
                askingAlias = false;
                pick.show();
            }
            pick.items = buildItems();
        });
        pick.onDidHide(() => {
            if (!askingAlias) {
                resolve(undefined);
            }
        });
        pick.show();
    });
    pick.dispose();

    if (!selected) {
        return undefined;
    }
    return selected.sha || promptForSha(context, git);
}

async function promptForSha(context: vscode.ExtensionContext, git: GitService): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
        prompt: 'Enter commit SHA (full or short hash)',
        placeHolder: 'e.g., abc1234 or abc1234567890abcdef',
        validateInput: async value => {
            if (!value || value.trim().length < 4) {
                return 'Please enter a valid commit SHA (at least 4 characters)';
            }
            return (await git.refExists(value.trim())) ? null : 'Invalid commit SHA - could not verify';
        }
    });
    if (!input) {
        return undefined;
    }

    const sha = await git.getCommitSha(input.trim());
    if (!getFavorites(context).some(favorite => favorite.sha === sha)) {
        // Non-blocking offer, so the drift analysis starts right away.
        void vscode.window.showInformationMessage(`Gitgg: Save ${sha.substring(0, 7)} as a favorite hash?`, 'Save as Favorite')
            .then(choice => choice ? addFavorite(context, sha, sha.substring(0, 7)) : undefined);
    }
    return sha;
}

function getFavorites(context: vscode.ExtensionContext): FavoriteCommit[] {
    return context.globalState.get<FavoriteCommit[]>(FAVORITE_COMMITS_KEY, []);
}

function favoriteItem(favorite: FavoriteCommit): CommitItem {
    return {
        label: `$(star-full) ${favorite.alias}`,
        description: favorite.sha.substring(0, 7),
        detail: favorite.sha,
        sha: favorite.sha,
        buttons: [{ iconPath: StarIcon, tooltip: 'Remove from favorites' }]
    };
}

async function addFavorite(context: vscode.ExtensionContext, sha: string, suggestedAlias: string): Promise<void> {
    const alias = await vscode.window.showInputBox({
        prompt: 'Favorite name (alias)',
        value: suggestedAlias.replace(/^\$\(star-full\)\s*/, '')
    });
    if (alias === undefined) {
        return;
    }
    const favorites = getFavorites(context).filter(favorite => favorite.sha !== sha);
    favorites.push({ sha, alias: alias.trim() || sha.substring(0, 7) });
    await context.globalState.update(FAVORITE_COMMITS_KEY, favorites);
}

async function removeFavorite(context: vscode.ExtensionContext, sha: string): Promise<void> {
    await context.globalState.update(FAVORITE_COMMITS_KEY, getFavorites(context).filter(favorite => favorite.sha !== sha));
}
