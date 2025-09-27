import * as vscode from 'vscode';
import simpleGit, { SimpleGitOptions } from 'simple-git';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Define the type for our comparison modes
type ComparisonMode = 'separate' | 'singleView';

export function activate(context: vscode.ExtensionContext) {

    context.subscriptions.push(vscode.commands.registerCommand('gitgg.compareFile', async (...args: any[]) => {

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Gitgg: Preparing comparison...",
            cancellable: true
        }, async (progress, token) => {

            token.onCancellationRequested(() => {
                console.log("User canceled the comparison.");
            });

            progress.report({ increment: 0, message: "Analyzing selected files..." });

            let urisToCompare: vscode.Uri[] = [];

            // More robust logic to find all URIs in the arguments
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

            urisToCompare = args.flatMap(arg => extractUris(arg));

            // Filter out duplicate URIs that can sometimes be passed by VS Code's context menu commands.
            // This ensures the extension correctly identifies a single-file selection.
            urisToCompare = [...new Set(urisToCompare.map(uri => uri.toString()))].map(uriString => vscode.Uri.parse(uriString));

            if (urisToCompare.length === 0 && vscode.window.activeTextEditor) {
                urisToCompare.push(vscode.window.activeTextEditor.document.uri);
            }

            if (urisToCompare.length === 0) {
                vscode.window.showErrorMessage('No valid file selected for comparison.');
                return;
            }

            const firstUri = urisToCompare[0];
            const repoPath = vscode.workspace.getWorkspaceFolder(firstUri)?.uri.fsPath;
            if (!repoPath) {
                vscode.window.showErrorMessage('Error: The selected file(s) are not in a Git workspace.');
                return;
            }

            const options: Partial<SimpleGitOptions> = {
                baseDir: repoPath,
                binary: 'git',
                maxConcurrentProcesses: 6,
            };

            const git = simpleGit(options);

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
                const items = branches.all.map(branch => ({ label: branch }));

                const selectedItem = await vscode.window.showQuickPick(items, {
                    placeHolder: `Compare with branch...`
                });

                if (token.isCancellationRequested || !selectedItem) { return; }

                const targetBranch = selectedItem.label;

                // Fetch logic to ensure we are comparing against the remote
                progress.report({ increment: 50, message: `Fetching updates for '${targetBranch}'...` });
                let comparisonSource = targetBranch;
                try {
                    const remotes = await git.getRemotes();
                    const hasOrigin = remotes.some(r => r.name === 'origin');
                    if (hasOrigin) {
                        await git.fetch('origin', targetBranch);
                        comparisonSource = `origin/${targetBranch}`;
                    }
                } catch (error: any) {
                    vscode.window.showWarningMessage(`Could not fetch updates for '${targetBranch}'. Comparing with the local version, which may be outdated.`);
                }

                const status = await git.status();
                let localFileLabel = currentBranch;
                if (targetBranch === currentBranch) {
                    const areFilesModifiedOrUntracked = urisToCompare.some(uri => {
                        const relativePath = path.relative(repoPath, uri.fsPath).replace(/\\/g, '/');
                        const isModified = status.modified.some((file: string) => file === relativePath);
                        const isUntracked = status.not_added.some((file: string) => file === relativePath);
                        return isModified || isUntracked;
                    });
                    if (areFilesModifiedOrUntracked) {
                        localFileLabel = 'Working Tree';
                    }
                }

                let comparisonMode: ComparisonMode = 'separate';

                if (urisToCompare.length > 1) {
                    const options = [
                        { label: 'Compare in Separate Tabs', description: 'Opens a diff tab for each file', mode: 'separate' as ComparisonMode },
                        { label: 'Compare in a Single View', description: 'Opens a summary of all changes in a single view', mode: 'singleView' as ComparisonMode }
                    ];
                    const choice = await vscode.window.showQuickPick(options, { placeHolder: `How do you want to compare the ${urisToCompare.length} selected files?` });
                    if (!choice || token.isCancellationRequested) { return; }
                    comparisonMode = choice.mode;
                }

                if (comparisonMode === 'separate') {
                    await runNativeDiffComparison(progress, token, urisToCompare, repoPath, git, currentBranch, targetBranch, comparisonSource, localFileLabel);
                } else {
                    await runWebviewDiffComparison(context, progress, token, urisToCompare, repoPath, git, currentBranch, targetBranch, comparisonSource, localFileLabel, status);
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
 * Creates a custom Webview panel to display a summary of all diffs.
 */
async function runWebviewDiffComparison(context: vscode.ExtensionContext, progress: any, token: vscode.CancellationToken, urisToCompare: vscode.Uri[], repoPath: string, git: any, currentBranch: string, targetBranch: string, comparisonSource: string, localFileLabel: string, status: any) {
    progress.report({ increment: 90, message: "Rendering view..." });

    const filesData = [];
    for (const uri of urisToCompare) {
        if (token.isCancellationRequested) { return; }
        const relativePath = path.relative(repoPath, uri.fsPath).replace(/\\/g, '/');

        let patch: string | null = null;
        const isUntracked = status.not_added.some((file: string) => file === relativePath);

        if (isUntracked) {
            // Special handling for untracked files: diff against /dev/null
            try {
                const diffOutput = await git.diff(['--no-index', '--', '/dev/null', uri.fsPath]);
                // Reformat the header to be consistent with other diffs
                patch = diffOutput.replace('--- /dev/null', `--- a/${relativePath}`);
            } catch (error) {
                console.error(`Error generating diff for untracked file: ${error}`);
                patch = null;
            }
        } else {
            // Normal diff for existing files
            patch = await git.diff([comparisonSource, '--', relativePath]).catch(() => '');
        }

        filesData.push({
            filePath: relativePath,
            patch: patch,
            noChanges: !patch || patch.trim().length === 0
        });
    }

    if (token.isCancellationRequested) return;

    // Separate changed and unchanged files
    const changedFiles = filesData.filter(f => !f.noChanges);
    const unchangedFiles = filesData.filter(f => f.noChanges);

    const fileCountText = `(${urisToCompare.length} files)`;

    const panel = vscode.window.createWebviewPanel(
        'gitgg-diff-summary',
        `Changes between (${targetBranch}) ↔ (${localFileLabel}) ${fileCountText}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    // ⚡ Cache for full diff content to improve performance
    const diffCache: Record<string, string> = {};

    panel.webview.onDidReceiveMessage(async msg => {
        if (msg.command === 'openDiff') {
            const fileUri = vscode.Uri.file(path.join(repoPath, msg.path));

            // Use cache if available
            let tempContent = diffCache[msg.path];
            if (!tempContent) {
                tempContent = await git.show([`${comparisonSource}:${msg.path}`]).catch(() => '');
                diffCache[msg.path] = tempContent;
            }

            const tempFilePath = path.join(os.tmpdir(), `gitgg-${path.basename(msg.path)}-${Date.now()}`);
            fs.writeFileSync(tempFilePath, tempContent);
            await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(tempFilePath), fileUri, `Comparing ${msg.path} (${targetBranch}) ↔ (${localFileLabel})`, { preview: false });
        }
    });

    panel.webview.html = getWebviewContent(changedFiles, unchangedFiles);
}

/**
 * This function handles the "old" way of opening native diff tabs.
 */
async function runNativeDiffComparison(progress: any, token: vscode.CancellationToken, urisToCompare: vscode.Uri[], repoPath: string, git: any, currentBranch: string, targetBranch: string, comparisonSource: string, localFileLabel: string) {
    let processed = 0;
    for (const uri of urisToCompare) {
        if (token.isCancellationRequested) { break; }

        processed++;
        progress.report({ increment: 75 + (processed / urisToCompare.length * 25), message: `Comparing ${path.basename(uri.fsPath)}...` });

        const relativePath = path.relative(repoPath, uri.fsPath).replace(/\\/g, '/');
        const fileContent = await git.show([`${comparisonSource}:${relativePath}`]).catch(() => '');

        const tempDir = os.tmpdir();
        const tempFileName = `gitgg-${path.basename(uri.fsPath)}-${Date.now()}`;
        const tempFilePath = path.join(tempDir, tempFileName);
        fs.writeFileSync(tempFilePath, fileContent);
        const tempUri = vscode.Uri.file(tempFilePath);

        const diffTitle = `Comparing ${path.basename(uri.fsPath)} (${targetBranch}) ↔ (${localFileLabel})`;

        await vscode.commands.executeCommand('vscode.diff', tempUri, uri, diffTitle, { preview: false });
    }
}

/**
 * Generates the HTML content for our custom diff summary webview.
 * Change: now receives changedFiles and unchangedFiles separately to render UNCHANGED at the bottom
 */
function getWebviewContent(changedFiles: { filePath: string, patch: string | null, noChanges: boolean }[], unchangedFiles: { filePath: string, patch: string | null, noChanges: boolean }[]): string {
    const changedJson = JSON.stringify(changedFiles);
    const unchangedJson = JSON.stringify(unchangedFiles);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Diff Summary</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/diff2html/bundles/css/diff2html.min.css" />
<script src="https://cdn.jsdelivr.net/npm/diff2html/bundles/js/diff2html-ui.min.js"></script>
<style>
body { background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
.d2h-file-header { background-color: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-sideBar-border); padding: 5px; font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
.d2h-file-wrapper { border: 1px solid var(--vscode-sideBar-border); margin-bottom: 1em; border-radius: 5px; }
.d2h-files-diff { position: inherit; }
.d2h-ins { background-color: var(--vscode-diffEditor-insertedTextBackground); }
.d2h-del { background-color: var(--vscode-diffEditor-removedTextBackground); }
.d2h-code-line-ctn, .d2h-code-side-line, .d2h-file-diff, .d2h-files-diff { border-color: var(--vscode-sideBar-border, #333); }
.status-button { margin-left: 6px; padding: 1px 4px; font-size: 0.75em; cursor: pointer; background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; }
.status-button:hover { background-color: var(--vscode-button-hoverBackground); }
.status-tag { font-size: 0.8em; font-weight: bold; color: gray; }
</style>
</head>
<body>
<div id="diff-container"></div>
<script>
const vscode = acquireVsCodeApi();
const diffContainer = document.getElementById('diff-container');
const changedFiles = ${changedJson};
const unchangedFiles = ${unchangedJson};

// Render files helper
function renderFiles(files, isUnchanged=false){
    files.forEach(file => {
        const fileWrapper = document.createElement('div');
        fileWrapper.className = 'd2h-file-wrapper';
        diffContainer.appendChild(fileWrapper);

        const configuration = {
            drawFileList: false,
            fileContentToggle: true,
            matching: 'lines',
            outputFormat: 'side-by-side',
            renderNothingWhenEmpty: false,
            colorScheme: 'dark',
            diffMaxChanges: null,
            context: file.patch ? Math.min(500, file.patch.split('\\n').length) : 100
        };

        if(isUnchanged){
            const header = document.createElement('div');
            header.className = 'd2h-file-header unchanged';
            header.innerHTML = \`
                <div style="display: flex; gap: 4px; align-items: center;">
                    <span class="d2h-file-name">\${file.filePath}</span>
                    <button class="status-button">View full Diff</button>
                </div>
                <span class="status-tag">UNCHANGED</span>
            \`;
            fileWrapper.appendChild(header);

            const btn = header.querySelector('button.status-button');
            btn.addEventListener('click', () => {
                vscode.postMessage({ command: 'openDiff', path: file.filePath });
            });

        } else {
            const patch = file.patch || '';
            const diff2htmlUi = new Diff2HtmlUI(fileWrapper, patch, configuration);
            diff2htmlUi.draw();

            const viewedHeader = fileWrapper.querySelector('.d2h-file-header .d2h-file-name');
            if(viewedHeader){
                const btn = document.createElement('button');
                btn.textContent = 'View full Diff';
                btn.className = 'status-button';
                btn.addEventListener('click', () => {
                    vscode.postMessage({ command: 'openDiff', path: file.filePath });
                });
                viewedHeader.parentNode.appendChild(btn);
            }
        }
    });
}

renderFiles(changedFiles);
renderFiles(unchangedFiles, true);
</script>
</body>
</html>`;
}

export function deactivate() {}
