import * as vscode from 'vscode';

export const FAVORITE_BRANCHES_KEY = 'favoriteBranches';

const StarIcon = new vscode.ThemeIcon('star-full');
const StarEmptyIcon = new vscode.ThemeIcon('star-empty');

interface BranchQuickPickItem extends vscode.QuickPickItem {
    branchName: string;
}

export async function pickBranchWithFavorites(
    context: vscode.ExtensionContext,
    branches: string[],
    placeholder: string
): Promise<string | undefined> {
    const uniqueBranches = Array.from(new Set(branches));

    const buildItems = (favorites: string[]): BranchQuickPickItem[] => {
        const validFavorites = favorites.filter((branch) => uniqueBranches.includes(branch));

        const favoriteItems: BranchQuickPickItem[] = validFavorites.map((branch) => ({
            label: `$(star-full) ${branch}`,
            branchName: branch,
            buttons: [{ iconPath: StarIcon, tooltip: 'Remove from favorites' }]
        }));

        const otherItems: BranchQuickPickItem[] = uniqueBranches
            .filter((branch) => !validFavorites.includes(branch))
            .map((branch) => ({
                label: branch,
                branchName: branch,
                buttons: [{ iconPath: StarEmptyIcon, tooltip: 'Add to favorites' }]
            }));

        return [...favoriteItems, ...otherItems];
    };

    return new Promise<string | undefined>((resolve) => {
        const quickPick = vscode.window.createQuickPick<BranchQuickPickItem>();
        let resolved = false;

        const finish = (value: string | undefined) => {
            if (resolved) {
                return;
            }
            resolved = true;
            resolve(value);
        };

        const currentFavorites = context.globalState.get<string[]>(FAVORITE_BRANCHES_KEY, []);
        quickPick.items = buildItems(currentFavorites);
        quickPick.placeholder = placeholder;

        quickPick.onDidAccept(() => {
            finish(quickPick.selectedItems[0]?.branchName);
            quickPick.hide();
        });

        quickPick.onDidTriggerItemButton(async ({ item }) => {
            let favorites = context.globalState.get<string[]>(FAVORITE_BRANCHES_KEY, []);
            if (favorites.includes(item.branchName)) {
                favorites = favorites.filter((branch) => branch !== item.branchName);
            } else {
                favorites.push(item.branchName);
            }

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
