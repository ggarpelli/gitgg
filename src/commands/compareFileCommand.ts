import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { pickBranchWithFavorites } from '../ui/branchPicker';
import { openRefDiff } from '../ui/refContentProvider';
import { resolveGitService } from '../ui/repo';
import { DiffPanel } from '../views/diffPanel';
import { compareWithProgress } from '../ui/feedback';
import { getConfig } from '../config';

/**
 * Extracts URIs from the arguments VS Code passes to a command, which differ per menu:
 * explorer (uri, uri[]), SCM resource (SourceControlResourceState...), SCM group (SourceControlResourceGroup).
 */
function extractUris(arg: unknown): vscode.Uri[] {
    if (arg instanceof vscode.Uri) {
        return [arg];
    }
    if (Array.isArray(arg)) {
        return arg.flatMap(item => extractUris(item));
    }
    if (arg && typeof arg === 'object') {
        const candidate = arg as { resourceUri?: unknown; resourceStates?: unknown };
        if (candidate.resourceUri instanceof vscode.Uri) {
            return [candidate.resourceUri];
        }
        if (Array.isArray(candidate.resourceStates)) {
            return extractUris(candidate.resourceStates);
        }
    }
    return [];
}

/** Expands folders into the files they contain. URIs that no longer exist (deleted files) are kept as-is. */
async function resolveUrisToFiles(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
    const files = new Map<string, vscode.Uri>();
    for (const uri of uris) {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type === vscode.FileType.Directory) {
                for (const file of await vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*'))) {
                    files.set(file.toString(), file);
                }
            } else {
                files.set(uri.toString(), uri);
            }
        } catch {
            files.set(uri.toString(), uri);
        }
    }
    return Array.from(files.values());
}

export async function runCompareFileCommand(context: vscode.ExtensionContext, args: unknown[]): Promise<void> {
    let initialUris = args.flatMap(arg => extractUris(arg)).filter(uri => uri.scheme === 'file' || uri.scheme === 'git');
    // Files opened from the SCM view use the `git:` scheme; their fsPath still points to the real file.
    initialUris = initialUris.map(uri => uri.scheme === 'git' ? vscode.Uri.file(uri.fsPath) : uri);

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (initialUris.length === 0 && activeUri && (activeUri.scheme === 'file' || activeUri.scheme === 'git')) {
        initialUris = [vscode.Uri.file(activeUri.fsPath)];
    }
    if (initialUris.length === 0) {
        vscode.window.showErrorMessage('Gitgg: No file or folder selected for comparison.');
        return;
    }

    const git = await resolveGitService(initialUris[0]);
    if (!git) {
        return;
    }

    const fileUris = await resolveUrisToFiles(initialUris);
    const relativePaths = fileUris
        .map(uri => git.toRelativePath(uri.fsPath))
        .filter(relativePath => relativePath && !relativePath.startsWith('..'));
    if (relativePaths.length === 0) {
        vscode.window.showErrorMessage('Gitgg: The selected files are not inside the Git repository.');
        return;
    }

    const currentBranch = await git.getCurrentBranch();
    const targetBranch = await pickBranchWithFavorites(context, await git.getBranches(), 'Compare with branch... (Favorites ⭐️ are listed first)', currentBranch);
    if (!targetBranch) {
        return;
    }

    const config = getConfig();
    let mode: 'separate' | 'singleView' = 'separate';
    if (relativePaths.length > 1) {
        if (relativePaths.length <= config.separateTabsMaxFiles) {
            const choice = await vscode.window.showQuickPick([
                { label: 'Compare in Separate Tabs', description: 'Opens a diff tab for each file', mode: 'separate' as const },
                { label: 'Compare in a Single View', description: 'Opens a summary of all changes in a single view', mode: 'singleView' as const }
            ], { placeHolder: `How do you want to compare the ${relativePaths.length} selected files?` });
            if (!choice) {
                return;
            }
            mode = choice.mode;
        } else {
            mode = 'singleView';
        }
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Gitgg',
        cancellable: true
    }, async (progress, token) => {
        progress.report({ message: `Resolving '${targetBranch}'...` });
        const { ref: baseRef, warning } = await git.resolveBranchRef(targetBranch, config.fetchBeforeCompare);
        if (warning) {
            vscode.window.showWarningMessage(`Gitgg: ${warning}`);
        }
        if (token.isCancellationRequested) {
            return;
        }

        const localLabel = await buildLocalLabel(git, currentBranch, relativePaths);

        if (mode === 'separate') {
            for (const [index, relativePath] of relativePaths.entries()) {
                if (token.isCancellationRequested) {
                    return;
                }
                progress.report({
                    message: `Opening diff ${index + 1} of ${relativePaths.length} files...`,
                    increment: 100 / relativePaths.length
                });
                await openRefDiff(git, baseRef, relativePath, targetBranch, localLabel);
            }
            return;
        }

        progress.report({ message: `Comparing ${relativePaths.length} files...` });
        const comparison = await compareWithProgress(git, baseRef, relativePaths, progress, token);
        if (token.isCancellationRequested) {
            return;
        }

        await DiffPanel.open(context, git, {
            viewType: 'gitgg-diff-summary',
            title: `Changes between (${targetBranch}) ↔ (${localLabel}) (${relativePaths.length} files)`,
            baseRef,
            baseLabel: targetBranch,
            localLabel,
            filePaths: relativePaths,
            initialComparison: comparison
        });
    });
}

/** "main" or "main (working tree)" when any of the files has uncommitted changes. */
async function buildLocalLabel(git: GitService, currentBranch: string, relativePaths: string[]): Promise<string> {
    const status = await git.getStatus();
    const dirty = new Set(status.files.map(file => file.path));
    const branchLabel = currentBranch || 'HEAD';
    return relativePaths.some(relativePath => dirty.has(relativePath)) ? `${branchLabel} (working tree)` : branchLabel;
}
