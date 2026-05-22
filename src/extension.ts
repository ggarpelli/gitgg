import * as vscode from 'vscode';
import simpleGit, { SimpleGit, SimpleGitOptions, StatusResult } from 'simple-git';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { runReleaseDriftCommand } from './commands/releaseDriftCommand';
import { runPRComparisonCommand } from './commands/prComparisonCommand';
import { GitService } from './services/gitService';
import { pickBranchWithFavorites } from './ui/branchPicker';

type ComparisonMode = 'separate' | 'singleView';

interface FileData {
    filePath: string;
    patch: string | null;
    noChanges: boolean;
    isNewInDiff?: boolean;
    isDeletedInDiff?: boolean;
}

interface RestoreBackup {
    filePath: string;
    content: Buffer | null;
    revertedToContent: Buffer | null;
    timestamp: number;
}

const createdTempFiles = new Set<string>();

const StarIcon = new vscode.ThemeIcon('star-full');
const StarEmptyIcon = new vscode.ThemeIcon('star-empty');

async function resolveUrisToFiles(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
    const fileUris: Set<vscode.Uri> = new Set();

    for (const uri of uris) {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type === vscode.FileType.Directory) {
                const filesInDir = await vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*'));
                for (const file of filesInDir) {
                    fileUris.add(file);
                }
            } else if (stat.type === vscode.FileType.File) {
                fileUris.add(uri);
            }
        } catch (_error) {
            console.warn(`fs.stat failed for ${uri.fsPath}. Assuming it's a file managed by source control (e.g., deleted).`);
            fileUris.add(uri);
        }
    }

    return Array.from(fileUris);
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand('gitgg.compareFile', async (...args: unknown[]) => {

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Gitgg: Preparing comparison...",
            cancellable: true
        }, async (progress, token) => {

            token.onCancellationRequested(() => {
                console.log("User canceled the comparison.");
            });

            progress.report({ increment: 0, message: "Analyzing selected files..." });

            let initialUris: vscode.Uri[] = [];

            function extractUris(arg: unknown): vscode.Uri[] {
                if (arg instanceof vscode.Uri) {
                    return [arg];
                }
                if (arg && typeof arg === 'object' && 'resourceUri' in arg && (arg as any).resourceUri instanceof vscode.Uri) {
                    return [(arg as any).resourceUri as vscode.Uri];
                }
                if (Array.isArray(arg)) {
                    return arg.flatMap(item => extractUris(item));
                }
                return [];
            }

            initialUris = args.flatMap(arg => extractUris(arg));

            if (initialUris.length === 0 && vscode.window.activeTextEditor) {
                initialUris.push(vscode.window.activeTextEditor.document.uri);
            }

            if (initialUris.length === 0) {
                vscode.window.showErrorMessage('No file or folder selected for comparison.');
                return;
            }

            progress.report({ increment: 5, message: "Resolving folders..." });
            const urisToCompare = await resolveUrisToFiles(initialUris);

            const uniqueUris = [...new Set(urisToCompare.map(uri => uri.toString()))].map(uriString => vscode.Uri.parse(uriString));

            if (uniqueUris.length === 0) {
                vscode.window.showErrorMessage('No valid files found in the selection to compare.');
                return;
            }

            let repoPath: string | undefined;
            const firstUri = uniqueUris[0];

            if (firstUri) {
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(firstUri);
                if (workspaceFolder) {
                    repoPath = workspaceFolder.uri.fsPath;
                }
            }

            if (!repoPath && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                if (vscode.workspace.workspaceFolders.length === 1) {
                    repoPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
                } else {
                    const folderContainingFile = vscode.workspace.workspaceFolders.find(folder => firstUri.fsPath.startsWith(folder.uri.fsPath));
                    if (folderContainingFile) {
                        repoPath = folderContainingFile.uri.fsPath;
                    } else {
                        repoPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
                    }
                }
            }

            if (!repoPath) {
                vscode.window.showErrorMessage('Error: Could not determine the Git workspace. Please open a folder containing a Git repository.');
                return;
            }

            const options: Partial<SimpleGitOptions> = {
                baseDir: repoPath,
                binary: 'git',
                maxConcurrentProcesses: 6,
            };

            const git: SimpleGit = simpleGit(options);

            try {
                progress.report({ increment: 10, message: "Checking Git repository..." });
                const isRepo = await git.checkIsRepo();
                if (!isRepo) {
                    vscode.window.showErrorMessage('Error: The opened folder is not a Git repository.');
                    return;
                }

                progress.report({ increment: 25, message: "Fetching local branches..." });
                const branches = await git.branchLocal();
                const currentBranch = branches.current;

                const targetBranch = await pickBranchWithFavorites(
                    context,
                    branches.all,
                    'Compare with branch... (Favorites ⭐️ are listed first)'
                );

                if (token.isCancellationRequested || !targetBranch) { return; }

                progress.report({ increment: 50, message: `Fetching updates for '${targetBranch}'...` });
                let comparisonSource = targetBranch;
                try {
                    const remotes = await git.getRemotes(true);
                    const hasOrigin = remotes.some(r => r.name === 'origin');
                    if (hasOrigin) {
                        await git.fetch('origin', targetBranch);
                        comparisonSource = `origin/${targetBranch}`;
                    }
                } catch (_error: unknown) {
                    vscode.window.showWarningMessage(`Could not fetch updates for '${targetBranch}'. Comparing with the local version, which may be outdated.`);
                }

                const status: StatusResult = await git.status();
                let localFileLabel = currentBranch;

                if (targetBranch === currentBranch) {
                    const hasWorkingTreeChanges = uniqueUris.some(uri => {
                        const relativePath = path.relative(repoPath!, uri.fsPath).replace(/\\/g, '/');
                        const isModified = status.modified.includes(relativePath);
                        const isUntracked = status.not_added.includes(relativePath);
                        const isDeleted = status.deleted.includes(relativePath);
                        return isModified || isUntracked || isDeleted;
                    });

                    if (hasWorkingTreeChanges) {
                        localFileLabel = 'Working Tree';
                    }
                }

                let comparisonMode: ComparisonMode = 'separate';
                if (uniqueUris.length > 1) {
                    if (uniqueUris.length <= 5) {
                        const options = [
                            { label: 'Compare in Separate Tabs', description: 'Opens a diff tab for each file', mode: 'separate' as ComparisonMode },
                            { label: 'Compare in a Single View', description: 'Opens a summary of all changes in a single view', mode: 'singleView' as ComparisonMode }
                        ];
                        const choice = await vscode.window.showQuickPick(options, { placeHolder: `How do you want to compare the ${uniqueUris.length} selected files?` });

                        if (!choice || token.isCancellationRequested) { return; }
                        comparisonMode = choice.mode;
                    } else {
                        comparisonMode = 'singleView';
                        vscode.window.showInformationMessage(`Comparing ${uniqueUris.length} files in a single view for better performance.`);
                    }
                }

                if (comparisonMode === 'separate') {
                    await runNativeDiffComparison(progress, token, uniqueUris, repoPath, git, currentBranch, targetBranch, comparisonSource, localFileLabel, status);
                } else {
                    await runWebviewDiffComparison(context, progress, token, uniqueUris, repoPath, git, currentBranch, targetBranch, comparisonSource, localFileLabel, status);
                }

            } catch (error: unknown) {
                if (!token.isCancellationRequested) {
                    vscode.window.showErrorMessage(`An error occurred: ${(error as Error).message}`);
                }
            }
        });
    }));

    // Register Release Drift command
    context.subscriptions.push(vscode.commands.registerCommand('gitgg.releaseDrift', async (commitSha?: string) => {
        await runReleaseDriftCommand(context, commitSha);
    }));

    // Register PR Comparison command
    context.subscriptions.push(vscode.commands.registerCommand('gitgg.prComparison', async () => {
        await runPRComparisonCommand(context);
    }));
}

async function runWebviewDiffComparison(
    context: vscode.ExtensionContext,
    progress: any,
    token: vscode.CancellationToken,
    urisToCompare: vscode.Uri[],
    repoPath: string,
    git: SimpleGit,
    currentBranch: string,
    targetBranch: string,
    comparisonSource: string,
    localFileLabel: string,
    status: StatusResult
) {
    progress.report({ increment: 90, message: "Rendering view..." });

    const isComparingWorkingTree = localFileLabel === 'Working Tree';

    const classifyFiles = (files: FileData[], currentStatus: StatusResult) => {
        const added: FileData[] = [];
        const changed: FileData[] = [];
        const deleted: FileData[] = [];
        const unchanged: FileData[] = [];

        files.forEach(file => {
            if (isComparingWorkingTree) {
                const fileStatus = currentStatus.files.find(f => f.path === file.filePath);
                if (fileStatus && (fileStatus.working_dir === '?' || fileStatus.index === 'A')) {
                    added.push(file);
                } else if (currentStatus.deleted.includes(file.filePath)) {
                    deleted.push(file);
                } else if (file.noChanges) {
                    unchanged.push(file);
                } else {
                    changed.push(file);
                }
            } else {
                if (file.noChanges) {
                    unchanged.push(file);
                } else if (file.isNewInDiff) {
                    added.push(file);
                } else if (file.isDeletedInDiff) {
                    deleted.push(file);
                } else {
                    changed.push(file);
                }
            }
        });

        return { added, changed, deleted, unchanged };
    };

    const allFilesData: FileData[] = [];
    for (const uri of urisToCompare) {
        if (token.isCancellationRequested) { return; }
        const relativePath = path.relative(repoPath, uri.fsPath).replace(/\\/g, '/');
        const isUntracked = status.not_added.includes(relativePath);

        let patch: string | null = null;
        if (isUntracked) {
            patch = await git.diff(['--no-index', '--', '/dev/null', uri.fsPath])
                .then(d => d.replace('--- /dev/null', `--- a/${relativePath}`))
                .catch(error => { console.error(`Error generating diff for untracked file ${relativePath}:`, error); return null; });
        } else {
            patch = await git.diff([comparisonSource, '--', relativePath]).catch(() => '');
        }

        allFilesData.push({
            filePath: relativePath,
            patch: patch,
            noChanges: !patch || patch.trim().length === 0,
            isNewInDiff: patch?.includes('new file mode') ?? false,
            isDeletedInDiff: patch?.includes('deleted file mode') ?? false,
        });
    }

    if (token.isCancellationRequested) return;

    const allFilesDataCopy = [...allFilesData];
    const classified = classifyFiles(allFilesDataCopy, status);

    const addedFiles: FileData[] = [...classified.added];
    const changedFiles: FileData[] = [...classified.changed];
    const deletedFiles: FileData[] = [...classified.deleted];
    const unchangedFiles: FileData[] = [...classified.unchanged];

    addedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath));
    changedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath));
    deletedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath));
    unchangedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath));

    const panelTitle = `Changes between (${targetBranch}) ↔ (${localFileLabel}) (${urisToCompare.length} files)`;
    const panel = vscode.window.createWebviewPanel('gitgg-diff-summary', panelTitle, vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
    });

    context.subscriptions.push(panel);

    const diffCache: Record<string, string> = {};
    const panelTempFiles: string[] = [];
    const restoreBackups = new Map<string, RestoreBackup>();

    const readWorkspaceFileIfExists = async (relativePath: string): Promise<Buffer | null> => {
        try {
            return await fs.promises.readFile(path.join(repoPath, relativePath));
        } catch (error: any) {
            if (error?.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    };

    const buffersEqual = (left: Buffer | null, right: Buffer | null) => {
        if (left === null || right === null) {
            return left === right;
        }
        return left.equals(right);
    };

    const getRestorableFiles = () => Array.from(restoreBackups.keys());

    panel.onDidDispose(() => {
        panelTempFiles.forEach(filePath => {
            try { fs.unlinkSync(filePath); } catch (_e) { }
            createdTempFiles.delete(filePath);
        });
    });

    const refreshWebview = async () => {
        const newStatus = await git.status();

        panel.webview.postMessage({
            command: 'refresh',
            data: {
                addedFiles, changedFiles, deletedFiles, unchangedFiles,
                targetBranch, localFileLabel, status: newStatus, restorableFiles: getRestorableFiles()
            }
        });
    };

    const removeFilesFromChanges = (filePaths: string[]) => {
        const filePathSet = new Set(filePaths);
        const removeFrom = (files: FileData[]) => {
            for (let i = files.length - 1; i >= 0; i--) {
                if (filePathSet.has(files[i].filePath)) {
                    unchangedFiles.unshift(files[i]);
                    files.splice(i, 1);
                }
            }
        };

        removeFrom(addedFiles);
        removeFrom(changedFiles);
        removeFrom(deletedFiles);
        unchangedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath));
    };

    const moveFilesFromUnchangedToChanged = (filePaths: string[]) => {
        const filePathSet = new Set(filePaths);
        for (let i = unchangedFiles.length - 1; i >= 0; i--) {
            if (filePathSet.has(unchangedFiles[i].filePath)) {
                changedFiles.unshift(unchangedFiles[i]);
                unchangedFiles.splice(i, 1);
            }
        }
        changedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath));
    };

    panel.webview.onDidReceiveMessage(async msg => {
        if (msg.command === 'openDiff') {
            const isDeleted = status.deleted.includes(msg.path);

            let tempContent = diffCache[msg.path];
            if (!tempContent) {
                tempContent = await git.show([`${comparisonSource}:${msg.path}`]).catch(() => '');
                diffCache[msg.path] = tempContent;
            }

            const tempFilePath = path.join(os.tmpdir(), `gitgg-${path.basename(msg.path)}-${Date.now()}`);
            fs.writeFileSync(tempFilePath, tempContent);
            createdTempFiles.add(tempFilePath);
            panelTempFiles.push(tempFilePath);
            const leftUri = vscode.Uri.file(tempFilePath);

            const rightUri = isDeleted
                ? leftUri.with({ scheme: 'untitled' })
                : vscode.Uri.file(path.join(repoPath, msg.path));

            const diffTitle = `Comparing ${path.basename(msg.path)} (${targetBranch}) ↔ (${localFileLabel})`;
            await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, diffTitle, { preview: false });
        }

        if (msg.command === 'stageFile') {
            // Write content from comparison source to working tree first
            try {
                const content = await git.show([`${comparisonSource}:${msg.path}`]).catch(() => null);
                if (content !== null) {
                    const fullPath = path.join(repoPath, msg.path);
                    const dir = path.dirname(fullPath);

                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }

                    fs.writeFileSync(fullPath, content);
                } else {
                    // File doesn't exist in source branch - delete from working tree
                    const fullPath = path.join(repoPath, msg.path);
                    try { fs.unlinkSync(fullPath); } catch (_e) { }
                }
            } catch (error: any) {
                console.error('Error writing file to working tree:', error);
            }

            await git.add(msg.path);
            vscode.window.showInformationMessage(`Staged: ${msg.path}`);
            await refreshWebview();
        }

        if (msg.command === 'stageFromComparison') {
            // Enhanced staging: write content from comparison source to working tree first, then stage
            // This fixes the case where target branch has content that current branch doesn't have
            const { path: filePath, sourceBranch, useSourceContent } = msg;

            if (useSourceContent && sourceBranch) {
                try {
                    const content = await git.show([`${sourceBranch}:${filePath}`]).catch(() => null);
                    if (content !== null) {
                        const fullPath = path.join(repoPath, filePath);
                        const dir = path.dirname(fullPath);

                        // Ensure directory exists
                        if (!fs.existsSync(dir)) {
                            fs.mkdirSync(dir, { recursive: true });
                        }

                        fs.writeFileSync(fullPath, content);
                    }
                } catch (error: any) {
                    console.error('Error writing file to working tree:', error);
                }
            }

            await git.add(filePath);
            vscode.window.showInformationMessage(`Staged: ${filePath}`);
            await refreshWebview();
        }

        if (msg.command === 'unstageFile') {
            await git.reset(['HEAD', '--', msg.path]);
            vscode.window.showInformationMessage(`Unstaged: ${msg.path}`);
            await refreshWebview();
        }

        if (msg.command === 'revertFile') {
            const currentStatus = await git.status();
            const isStaged = currentStatus.staged.includes(msg.path);
            const isUntracked = currentStatus.not_added.includes(msg.path);

            if (isStaged) {
                await git.reset(['HEAD', '--', msg.path]);
                vscode.window.showInformationMessage(`Unstaged: ${msg.path}`);
            } else {
                const confirmation = await vscode.window.showWarningMessage(
                    `Discard local changes in ${msg.path}? You can restore them from this panel until it is closed.`,
                    { modal: true },
                    'Discard Changes'
                );

                if (confirmation !== 'Discard Changes') {
                    return;
                }

                const contentBeforeRevert = await readWorkspaceFileIfExists(msg.path);

                if (isUntracked) {
                    const fullPath = path.join(repoPath, msg.path);
                    try { await fs.promises.unlink(fullPath); } catch (_e) { }
                } else {
                    await git.checkout(['--', msg.path]);
                }

                const revertedToContent = await readWorkspaceFileIfExists(msg.path);
                restoreBackups.set(msg.path, {
                    filePath: msg.path,
                    content: contentBeforeRevert,
                    revertedToContent,
                    timestamp: Date.now()
                });
                removeFilesFromChanges([msg.path]);
                vscode.window.showInformationMessage(`Reverted: ${msg.path}`);
            }

            await refreshWebview();
        }

        // Handle global stage all - write content from comparison source first
        if (msg.command === 'stageAll') {
            const filesToStage = [...addedFiles, ...changedFiles, ...deletedFiles].map(f => f.filePath);
            for (const filePath of filesToStage) {
                // Write content from comparison source to working tree first
                try {
                    const content = await git.show([`${comparisonSource}:${filePath}`]).catch(() => null);
                    if (content !== null) {
                        const fullPath = path.join(repoPath, filePath);
                        const dir = path.dirname(fullPath);

                        if (!fs.existsSync(dir)) {
                            fs.mkdirSync(dir, { recursive: true });
                        }

                        fs.writeFileSync(fullPath, content);
                    } else {
                        // File doesn't exist in source branch - delete from working tree
                        const fullPath = path.join(repoPath, filePath);
                        try { fs.unlinkSync(fullPath); } catch (_e) { }
                    }
                } catch (error: any) {
                    console.error('Error writing file to working tree:', error);
                }

                await git.add(filePath);
            }
            vscode.window.showInformationMessage(`Staged ${filesToStage.length} files`);
            await refreshWebview();
        }

        // Handle global unstage all
        if (msg.command === 'unstageAll') {
            const currentStatus = await git.status();
            const allFiles = [...addedFiles, ...changedFiles, ...deletedFiles].map(f => f.filePath);
            const stagedFiles = allFiles.filter(file => currentStatus.staged.includes(file));
            if (stagedFiles.length > 0) {
                await git.reset(['HEAD', '--', ...stagedFiles]);
                vscode.window.showInformationMessage(`Unstaged ${stagedFiles.length} files`);
            }
            await refreshWebview();
        }

        if (msg.command === 'revertAll') {
            const currentStatus = await git.status();
            const allFiles = [...addedFiles, ...changedFiles, ...deletedFiles].map(f => f.filePath);
            // Revert only NON-staged files
            const filesToRevert = allFiles.filter(file => !currentStatus.staged.includes(file));

            if (filesToRevert.length === 0) {
                return;
            }

            const confirmation = await vscode.window.showWarningMessage(
                `Discard local changes in ${filesToRevert.length} file${filesToRevert.length > 1 ? 's' : ''}? You can restore them from this panel until it is closed.`,
                { modal: true },
                'Discard Changes'
            );

            if (confirmation !== 'Discard Changes') {
                await refreshWebview();
                return;
            }

            const successfullyRevertedFiles: string[] = [];

            for (const file of filesToRevert) {
                const contentBeforeRevert = await readWorkspaceFileIfExists(file);

                try {
                    const isUntracked = currentStatus.not_added.includes(file) ||
                                      currentStatus.files.some(f => f.path === file && f.working_dir === '?');

                    if (isUntracked) {
                        const fullPath = path.join(repoPath, file);
                        if (fs.existsSync(fullPath)) {
                            await fs.promises.unlink(fullPath);
                        }
                    } else {
                        await git.checkout(['--', file]);
                    }
                } catch (error) {
                    console.error(`Error reverting file ${file}:`, error);
                    await git.checkout(['--', file]).catch(() => {});
                }

                const revertedToContent = await readWorkspaceFileIfExists(file);
                restoreBackups.set(file, {
                    filePath: file,
                    content: contentBeforeRevert,
                    revertedToContent,
                    timestamp: Date.now()
                });
                successfullyRevertedFiles.push(file);
            }

            removeFilesFromChanges(successfullyRevertedFiles);
            vscode.window.showInformationMessage(`Reverted ${successfullyRevertedFiles.length} files`);
            await refreshWebview();
        }

        if (msg.command === 'restoreFile') {
            const backup = restoreBackups.get(msg.path);
            if (!backup) {
                vscode.window.showWarningMessage(`No restore data available for ${msg.path}.`);
                await refreshWebview();
                return;
            }

            const currentContent = await readWorkspaceFileIfExists(msg.path);
            if (!buffersEqual(currentContent, backup.revertedToContent)) {
                const confirmation = await vscode.window.showWarningMessage(
                    `${msg.path} has changed since it was reverted. Restoring will overwrite the current file contents.`,
                    { modal: true },
                    'Overwrite Current File'
                );

                if (confirmation !== 'Overwrite Current File') {
                    return;
                }
            }

            if (backup.content === null) {
                const confirmation = await vscode.window.showWarningMessage(
                    `Restore the deleted state for ${msg.path}? This will delete the current file.`,
                    { modal: true },
                    'Delete Current File'
                );

                if (confirmation !== 'Delete Current File') {
                    return;
                }

                await fs.promises.unlink(path.join(repoPath, msg.path));
            } else {
                await fs.promises.writeFile(path.join(repoPath, msg.path), backup.content);
            }
            restoreBackups.delete(msg.path);
            moveFilesFromUnchangedToChanged([msg.path]);
            vscode.window.showInformationMessage(`Restored changes: ${msg.path}`);
            await refreshWebview();
        }

        // Handle global restore all
        if (msg.command === 'restoreAll') {
            const restorableEntries = Array.from(restoreBackups.entries());
            if (restorableEntries.length === 0) {
                vscode.window.showWarningMessage('No files to restore.');
                return;
            }

            const confirmation = await vscode.window.showWarningMessage(
                `Restore ${restorableEntries.length} file${restorableEntries.length > 1 ? 's' : ''}? This will overwrite current files.`,
                { modal: true },
                'Restore All'
            );

            if (confirmation !== 'Restore All') {
                return;
            }

            for (const [filePath, backup] of restorableEntries) {
                const currentContent = await readWorkspaceFileIfExists(filePath);
                if (!buffersEqual(currentContent, backup.revertedToContent)) {
                    continue; // Skip files that have changed since revert
                }

                if (backup.content === null) {
                    await fs.promises.unlink(path.join(repoPath, filePath)).catch(() => {});
                } else {
                    await fs.promises.writeFile(path.join(repoPath, filePath), backup.content);
                }
                restoreBackups.delete(filePath);
                moveFilesFromUnchangedToChanged([filePath]);
            }

            vscode.window.showInformationMessage('Restored all reverted files.');
            await refreshWebview();
        }
    });

    panel.webview.html = getWebviewContent(context, panel.webview, addedFiles, changedFiles, deletedFiles, unchangedFiles, targetBranch, localFileLabel, status, getRestorableFiles());
}

async function runNativeDiffComparison(
    progress: any,
    token: vscode.CancellationToken,
    urisToCompare: vscode.Uri[],
    repoPath: string,
    git: SimpleGit,
    currentBranch: string,
    targetBranch: string,
    comparisonSource: string,
    localFileLabel: string,
    status: StatusResult
) {
    let processed = 0;
    for (const uri of urisToCompare) {
        if (token.isCancellationRequested) { break; }
        processed++;
        progress.report({ increment: 75 + (processed / urisToCompare.length * 25), message: `Comparing ${path.basename(uri.fsPath)}...` });

        const relativePath = path.relative(repoPath, uri.fsPath).replace(/\\/g, '/');
        const isDeleted = status.deleted.includes(relativePath);

        const fileContent = await git.show([`${comparisonSource}:${relativePath}`]).catch(() => '');

        const tempFilePath = path.join(os.tmpdir(), `gitgg-${path.basename(uri.fsPath)}-${Date.now()}`);
        fs.writeFileSync(tempFilePath, fileContent);
        createdTempFiles.add(tempFilePath);
        const leftUri = vscode.Uri.file(tempFilePath);

        const rightUri = isDeleted ? leftUri.with({ scheme: 'untitled' }) : uri;
        const diffTitle = `Comparing ${path.basename(uri.fsPath)} (${targetBranch}) ↔ (${localFileLabel})`;

        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, diffTitle, { preview: false });
    }
}

function getWebviewContent(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    addedFiles: FileData[],
    changedFiles: FileData[],
    deletedFiles: FileData[],
    unchangedFiles: FileData[],
    targetBranch: string,
    localFileLabel: string,
    status: any,
    restorableFiles: string[]
): string {
    const nonce = crypto.randomBytes(16).toString('base64');

    const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'webview.html');
    const cssPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'webview.css');
    const jsPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'main.js');

    const cssUri = webview.asWebviewUri(cssPath);
    const jsUri = webview.asWebviewUri(jsPath);

    let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');

    const webviewData = {
        addedFiles,
        changedFiles,
        deletedFiles,
        unchangedFiles,
        targetBranch,
        localFileLabel,
        status,
        restorableFiles
    };

    htmlContent = htmlContent.replace(/_WEBVIEW_CSS_URI_/g, cssUri.toString());
    htmlContent = htmlContent.replace(/_WEBVIEW_JS_URI_/g, jsUri.toString());
    htmlContent = htmlContent.replace('_VSCODE_WEBVIEW_DATA_', JSON.stringify(webviewData));
    htmlContent = htmlContent.replace(/_CSP_SOURCE_/g, webview.cspSource);
    htmlContent = htmlContent.replace(/_NONCE_/g, nonce);

    return htmlContent;
}

export function deactivate() {
    createdTempFiles.forEach(filePath => {
        try { fs.unlinkSync(filePath); } catch (_e) { }
    });
    createdTempFiles.clear();
}
