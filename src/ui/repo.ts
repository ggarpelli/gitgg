import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../services/gitService';

/**
 * Finds the Git repository to work on: the one containing `hint`, else the active editor's file,
 * else the workspace folder (asking the user when there are several).
 * Shows an error and returns undefined when no repository is found.
 */
export async function resolveGitService(hint?: vscode.Uri): Promise<GitService | undefined> {
    let startPath: string | undefined;

    if (hint?.scheme === 'file') {
        startPath = hint.fsPath;
    } else {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (activeUri?.scheme === 'file') {
            startPath = path.dirname(activeUri.fsPath);
        }
    }

    if (!startPath) {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 1) {
            startPath = folders[0].uri.fsPath;
        } else if (folders.length > 1) {
            const folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select the folder of the Git repository' });
            startPath = folder?.uri.fsPath;
            if (!startPath) {
                return undefined;
            }
        }
    }

    const repoRoot = startPath ? await GitService.findRepoRoot(startPath) : undefined;
    if (!repoRoot) {
        vscode.window.showErrorMessage('Gitgg: Could not find a Git repository. Open a folder that contains a Git repository.');
        return undefined;
    }
    return new GitService(repoRoot);
}
