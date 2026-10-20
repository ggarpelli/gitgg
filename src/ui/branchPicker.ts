import * as vscode from 'vscode';

export const FAVORITE_BRANCHES_KEY = 'favoriteBranches';

const StarIcon = new vscode.ThemeIcon('star-full');
const StarEmptyIcon = new vscode.ThemeIcon('star-empty');

interface BranchQuickPickItem extends vscode.QuickPickItem {
    branchName: string;
}

/** Branch quick pick with favorites (⭐) listed first. `currentBranch` is marked as "current". */
export async function pickBranchWithFavorites(
    context: vscode.ExtensionContext,
    branches: string[],
    placeholder: string,
    currentBranch?: string
): Promise<string | undefined> {
    const uniqueBranches = Array.from(new Set(branches));

    const buildItems = (favorites: string[]): BranchQuickPickItem[] => {
        const validFavorites = favorites.filter(branch => uniqueBranches.includes(branch));
        const toItem = (branch: string, favorite: boolean): BranchQuickPickItem => ({
            label: favorite ? `$(star-full) ${branch}` : branch,
            description: branch === currentBranch ? 'current' : undefined,
            branchName: branch,
            buttons: [favorite
                ? { iconPath: StarIcon, tooltip: 'Remove from favorites' }
                : { iconPath: StarEmptyIcon, tooltip: 'Add to favorites' }]
        });

        return [
            ...validFavorites.map(branch => toItem(branch, true)),
            ...uniqueBranches.filter(branch => !validFavorites.includes(branch)).map(branch => toItem(branch, false))
        ];
    };

    return new Promise<string | undefined>(resolve => {
        const quickPick = vscode.window.createQuickPick<BranchQuickPickItem>();
        let resolved = false;

        const finish = (value: string | undefined) => {
            if (!resolved) {
                resolved = true;
                resolve(value);
            }
        };

        quickPick.items = buildItems(context.globalState.get<string[]>(FAVORITE_BRANCHES_KEY, []));
        quickPick.placeholder = placeholder;
        quickPick.matchOnDescription = true;

        quickPick.onDidAccept(() => {
            finish(quickPick.selectedItems[0]?.branchName);
            quickPick.hide();
        });

        quickPick.onDidTriggerItemButton(async ({ item }) => {
            let favorites = context.globalState.get<string[]>(FAVORITE_BRANCHES_KEY, []);
            favorites = favorites.includes(item.branchName)
                ? favorites.filter(branch => branch !== item.branchName)
                : [...favorites, item.branchName];
            await context.globalState.update(FAVORITE_BRANCHES_KEY, favorites);
            quickPick.items = buildItems(favorites);
        });

        quickPick.onDidHide(() => {
            quickPick.dispose();
            finish(undefined);
        });

        quickPick.show();
    });
}
