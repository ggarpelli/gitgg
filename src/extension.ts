import * as vscode from 'vscode';
import simpleGit, { SimpleGit, SimpleGitOptions, StatusResult } from 'simple-git';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Defines the two possible modes for displaying diffs.
type ComparisonMode = 'separate' | 'singleView';

// Defines the data structure for a file being compared.
interface FileData {
    filePath: string;
    patch: string | null;
    noChanges: boolean;
    isNewInDiff?: boolean;
    isDeletedInDiff?: boolean;
}

/**
 * Resolves a list of user-selected URIs (which can be files or directories)
 * into a flat list of file URIs.
 * @param uris The initial list of URIs from the user's selection.
 * @returns A promise that resolves to a flat array of file URIs.
 */
async function resolveUrisToFiles(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
    const fileUris: Set<vscode.Uri> = new Set();

    for (const uri of uris) {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type === vscode.FileType.Directory) {
                // If a directory is selected, recursively find all files within it.
                const filesInDir = await vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*'));
                for (const file of filesInDir) {
                    fileUris.add(file);
                }
            } else if (stat.type === vscode.FileType.File) {
                fileUris.add(uri);
            }
        } catch (error) {
            // If fs.stat fails, it's likely a deleted file URI from the SCM view.
            // We add it to the list and let the Git logic determine its status later.
            console.warn(`fs.stat failed for ${uri.fsPath}. Assuming it's a file managed by source control (e.g., deleted).`);
            fileUris.add(uri);
        }
    }

    return Array.from(fileUris);
}

/**
 * Main activation function, called by VS Code when the extension is activated.
 */
export function activate(context: vscode.ExtensionContext) {

    // Register the main command of the extension.
    context.subscriptions.push(vscode.commands.registerCommand('gitgg.compareFile', async (...args: any[]) => {

        // Show a progress notification to the user for the duration of the command.
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Gitgg: Preparing comparison...",
            cancellable: true
        }, async (progress, token) => {

            token.onCancellationRequested(() => {
                console.log("User canceled the comparison.");
            });

            // --- 1. GATHER AND VALIDATE USER INPUT ---
            progress.report({ increment: 0, message: "Analyzing selected files..." });

            let initialUris: vscode.Uri[] = [];

            // Helper function to robustly extract URIs from various VS Code contexts.
            function extractUris(arg: any): vscode.Uri[] {
                if (arg instanceof vscode.Uri) {
                    return [arg];
                }
                if (arg && arg.resourceUri instanceof vscode.Uri) {
                    return [arg.resourceUri];
                }
                if (Array.isArray(arg)) {
                    return arg.flatMap(item => extractUris(item));
                }
                return [];
            }

            initialUris = args.flatMap(arg => extractUris(arg));

            // If no selection, fall back to the currently active editor file.
            if (initialUris.length === 0 && vscode.window.activeTextEditor) {
                initialUris.push(vscode.window.activeTextEditor.document.uri);
            }

            if (initialUris.length === 0) {
                vscode.window.showErrorMessage('No file or folder selected for comparison.');
                return;
            }

            // Resolve any selected folders into a list of files and remove duplicates.
            progress.report({ increment: 5, message: "Resolving folders..." });
            const urisToCompare = await resolveUrisToFiles(initialUris);
            
            const uniqueUris = [...new Set(urisToCompare.map(uri => uri.toString()))].map(uriString => vscode.Uri.parse(uriString));

            if (uniqueUris.length === 0) {
                vscode.window.showErrorMessage('No valid files found in the selection to compare.');
                return;
            }

            // --- 2. DETERMINE THE GIT REPOSITORY PATH ---
            // This logic robustly finds the repository root, especially in multi-root workspaces.
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

            // --- 3. INITIALIZE GIT AND GET BRANCH INFORMATION ---
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

                // Get local branches and prompt the user to select one for comparison.
                progress.report({ increment: 25, message: "Fetching local branches..." });
                const branches = await git.branchLocal();
                const currentBranch = branches.current;
                const items = branches.all.map(branch => ({ label: branch }));

                const selectedItem = await vscode.window.showQuickPick(items, {
                    placeHolder: `Compare with branch...`
                });

                if (token.isCancellationRequested || !selectedItem) { return; }

                const targetBranch = selectedItem.label;

                // Fetch from the remote to ensure the comparison is against the latest version.
                progress.report({ increment: 50, message: `Fetching updates for '${targetBranch}'...` });
                let comparisonSource = targetBranch;
                try {
                    const remotes = await git.getRemotes(true);
                    const hasOrigin = remotes.some(r => r.name === 'origin');
                    if (hasOrigin) {
                        await git.fetch('origin', targetBranch);
                        comparisonSource = `origin/${targetBranch}`;
                    }
                } catch (error: any) {
                    vscode.window.showWarningMessage(`Could not fetch updates for '${targetBranch}'. Comparing with the local version, which may be outdated.`);
                }
                
                // --- 4. DETERMINE COMPARISON LABELS AND MODE ---
                const status: StatusResult = await git.status();
                let localFileLabel = currentBranch;

                // If comparing against the current branch, check for local uncommitted changes
                // to correctly label the local version as 'Working Tree'.
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

                // Smartly decide which comparison mode to use based on the number of files.
                let comparisonMode: ComparisonMode = 'separate'; // Default for single files
                if (uniqueUris.length > 1) {
                    // For a small number of files, ask the user.
                    if (uniqueUris.length <= 5) {
                        const options = [
                            { label: 'Compare in Separate Tabs', description: 'Opens a diff tab for each file', mode: 'separate' as ComparisonMode },
                            { label: 'Compare in a Single View', description: 'Opens a summary of all changes in a single view', mode: 'singleView' as ComparisonMode }
                        ];
                        const choice = await vscode.window.showQuickPick(options, { placeHolder: `How do you want to compare the ${uniqueUris.length} selected files?` });

                        if (!choice || token.isCancellationRequested) { return; }
                        comparisonMode = choice.mode;
                    } 
                    // For a large number of files, default to the single view for better performance.
                    else {
                        comparisonMode = 'singleView';
                        vscode.window.showInformationMessage(`Comparing ${uniqueUris.length} files in a single view for better performance.`);
                    }
                }

                // --- 5. EXECUTE THE COMPARISON ---
                if (comparisonMode === 'separate') {
                    await runNativeDiffComparison(progress, token, uniqueUris, repoPath, git, currentBranch, targetBranch, comparisonSource, localFileLabel, status);
                } else {
                    await runWebviewDiffComparison(context, progress, token, uniqueUris, repoPath, git, currentBranch, targetBranch, comparisonSource, localFileLabel, status);
                }

            } catch (error: any) {
                if (!token.isCancellationRequested) {
                    vscode.window.showErrorMessage(`An error occurred: ${error.message}`);
                }
            }
        });
    }));
}

/**
 * Handles the multi-file comparison by creating and showing a custom Webview panel.
 */
async function runWebviewDiffComparison(context: vscode.ExtensionContext, progress: any, token: vscode.CancellationToken, urisToCompare: vscode.Uri[], repoPath: string, git: SimpleGit, currentBranch: string, targetBranch: string, comparisonSource: string, localFileLabel: string, status: StatusResult) {
    progress.report({ increment: 90, message: "Rendering view..." });

    // Iterate through each file to generate its Git diff patch.
    const allFilesData: FileData[] = [];
    for (const uri of urisToCompare) {
        if (token.isCancellationRequested) { return; }
        const relativePath = path.relative(repoPath, uri.fsPath).replace(/\\/g, '/');
        const isUntracked = status.not_added.includes(relativePath);

        let patch: string | null = null;
        if (isUntracked) {
            patch = await git.diff(['--no-index', '--', '/dev/null', uri.fsPath]).then(d => d.replace('--- /dev/null', `--- a/${relativePath}`)).catch(error => {console.error(`Error generating diff for untracked file ${relativePath}:`, error); return null; });
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

    // Categorize files into Added, Changed, Deleted, and Unchanged for organized display.
    const addedFiles: FileData[] = [];
    const changedFiles: FileData[] = [];
    const deletedFiles: FileData[] = [];
    const unchangedFiles: FileData[] = [];
    
    const isComparingWorkingTree = localFileLabel === 'Working Tree';
    allFilesData.forEach(file => {
        if (isComparingWorkingTree) {
            const fileStatus = status.files.find(f => f.path === file.filePath);
            if (fileStatus && (fileStatus.working_dir === '?' || fileStatus.index === 'A')) {
                addedFiles.push(file);
            } else if (status.deleted.includes(file.filePath)) {
                deletedFiles.push(file);
            } else if (file.noChanges) {
                unchangedFiles.push(file);
            } else {
                changedFiles.push(file);
            }
        } else {
            if (file.noChanges) {
                unchangedFiles.push(file);
            } else if (file.isNewInDiff) {
                addedFiles.push(file);
            } else if (file.isDeletedInDiff) {
                deletedFiles.push(file);
            } else {
                changedFiles.push(file);
            }
        }
    });

    // Sort files alphabetically within each category.
    addedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath));
    changedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath));
    deletedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath));
    unchangedFiles.sort((a, b) => a.filePath.localeCompare(b.filePath));

    // Create the Webview panel with a dynamic title.
    const panelTitle = `Changes between (${targetBranch}) ↔ (${localFileLabel}) (${urisToCompare.length} files)`;
    const panel = vscode.window.createWebviewPanel('gitgg-diff-summary', panelTitle, vscode.ViewColumn.One, { 
        enableScripts: true, 
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
    });
    const diffCache: Record<string, string> = {};

    // This listener is the bridge from the Webview back to the extension.
    // It handles the 'View full Diff' button click.
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
            const leftUri = vscode.Uri.file(tempFilePath);

            // Determine the right side URI. For deleted files, use a virtual 'untitled' document.
            const rightUri = isDeleted
                ? leftUri.with({ scheme: 'untitled' })
                : vscode.Uri.file(path.join(repoPath, msg.path));
            
            const diffTitle = `Comparing ${path.basename(msg.path)} (${targetBranch}) ↔ (${localFileLabel})`;
            await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, diffTitle, { preview: false });
        }
    });

    // Generate and set the final HTML content for the panel.
    panel.webview.html = getWebviewContent(context, panel.webview, addedFiles, changedFiles, deletedFiles, unchangedFiles, targetBranch, localFileLabel);
}

/**
 * Handles comparison by opening a native VS Code diff editor for each file.
 */
async function runNativeDiffComparison(progress: any, token: vscode.CancellationToken, urisToCompare: vscode.Uri[], repoPath: string, git: SimpleGit, currentBranch: string, targetBranch: string, comparisonSource: string, localFileLabel: string, status: StatusResult) {
    let processed = 0;
    for (const uri of urisToCompare) {
        if (token.isCancellationRequested) { break; }
        processed++;
        progress.report({ increment: 75 + (processed / urisToCompare.length * 25), message: `Comparing ${path.basename(uri.fsPath)}...` });

        const relativePath = path.relative(repoPath, uri.fsPath).replace(/\\/g, '/');
        const isDeleted = status.deleted.includes(relativePath);

        const fileContent = await git.show([`${comparisonSource}:${relativePath}`]).catch(() => '');

        // Create a temporary file to hold the content from the target branch (left side of diff).
        const tempDir = os.tmpdir();
        const tempFileName = `gitgg-${path.basename(uri.fsPath)}-${Date.now()}`;
        const tempFilePath = path.join(tempDir, tempFileName);
        fs.writeFileSync(tempFilePath, fileContent);
        const leftUri = vscode.Uri.file(tempFilePath);

        // If the file is deleted, the right side is a virtual 'untitled' document.
        // Otherwise, it's the actual file in the working tree.
        const rightUri = isDeleted ? leftUri.with({ scheme: 'untitled' }) : uri;
        const diffTitle = `Comparing ${path.basename(uri.fsPath)} (${targetBranch}) ↔ (${localFileLabel})`;
        
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, diffTitle, { preview: false });
    }
}

/**
 * Generates the HTML content for the Webview.
 * It reads an HTML template from disk and injects the necessary data and asset URIs.
 */
function getWebviewContent(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    addedFiles: FileData[],
    changedFiles: FileData[],
    deletedFiles: FileData[],
    unchangedFiles: FileData[],
    targetBranch: string,
    localFileLabel: string
): string {
    
    // Paths now point to the 'dist' folder, where assets will be copied during build.
    const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'webview.html');
    const cssPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'webview.css');
    const jsPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'main.js');

    // Convert the asset paths to special URIs that the webview can load.
    const cssUri = webview.asWebviewUri(cssPath);
    const jsUri = webview.asWebviewUri(jsPath);

    // Read the HTML template file.
    let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');

    // Prepare the data to be sent to the webview.
    const webviewData = {
        addedFiles,
        changedFiles,
        deletedFiles,
        unchangedFiles,
        targetBranch,
        localFileLabel
    };

    // Replace placeholders in the HTML with the actual asset URIs and the serialized data.
    htmlContent = htmlContent.replace(/_WEBVIEW_CSS_URI_/g, cssUri.toString());
    htmlContent = htmlContent.replace(/_WEBVIEW_JS_URI_/g, jsUri.toString());
    htmlContent = htmlContent.replace('_VSCODE_WEBVIEW_DATA_', JSON.stringify(webviewData));
    htmlContent = htmlContent.replace(/\${webview.cspSource}/g, webview.cspSource);
    
    return htmlContent;
}

export function deactivate() {}