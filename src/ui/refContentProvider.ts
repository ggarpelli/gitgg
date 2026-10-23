import * as vscode from 'vscode';
import { GitService } from '../services/gitService';

export const REF_SCHEME = 'gitgg';

interface RefQuery {
    repo: string;
    ref: string;
}

/**
 * Builds a read-only URI for a file at a Git ref. The URI path keeps the real file name,
 * so VS Code picks the right language (syntax highlighting) in diff editors.
 * An empty `ref` produces an empty document (used for files that do not exist on one side).
 */
export function toRefUri(repoPath: string, ref: string, relativePath: string): vscode.Uri {
    const query: RefQuery = { repo: repoPath, ref };
    return vscode.Uri.from({
        scheme: REF_SCHEME,
        path: '/' + relativePath.replace(/\\/g, '/'),
        query: JSON.stringify(query)
    });
}

/** Reads back what `toRefUri` encoded. */
export function parseRefUri(uri: vscode.Uri): { repo: string; ref: string; filePath: string } {
    const { repo, ref } = JSON.parse(uri.query) as RefQuery;
    return { repo, ref, filePath: uri.path.replace(/^\//, '') };
}

class RefContentProvider implements vscode.TextDocumentContentProvider {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const { repo, ref, filePath } = parseRefUri(uri);
        if (!ref) {
            return '';
        }
        const content = await GitService.forRepo(repo).getFileContent(ref, filePath);
        return content ?? '';
    }
}

export function registerRefContentProvider(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(REF_SCHEME, new RefContentProvider());
}

/** Opens VS Code's diff editor: file at `baseRef` on the left, working tree on the right. */
export async function openRefDiff(
    git: GitService,
    baseRef: string,
    relativePath: string,
    baseLabel: string,
    localLabel: string
): Promise<void> {
    const leftUri = toRefUri(git.getRepoPath(), baseRef, relativePath);
    const localPath = git.toAbsolutePath(relativePath);
    const existsLocally = await git.readWorkingTreeBuffer(relativePath).then(buffer => buffer !== null);
    const rightUri = existsLocally ? vscode.Uri.file(localPath) : toRefUri(git.getRepoPath(), '', relativePath);

    const fileName = relativePath.split('/').pop() ?? relativePath;
    const title = `${fileName} (${baseLabel}) ↔ (${localLabel})`;
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: false });
}
