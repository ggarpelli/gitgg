import * as vscode from 'vscode';
import simpleGit, { SimpleGitOptions } from 'simple-git';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {

    let disposable = vscode.commands.registerCommand('gitgg.compareFile', async (...args: any[]) => {

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

            // Logic to detect single or multiple selected files
            if (args.length > 0) {
                if (Array.isArray(args[1]) && args[1].length > 0) {
                    urisToCompare = args[1];
                }
                else if (args[0]) {
                    const uri = args[0].resourceUri ? args[0].resourceUri : args[0];
                    if (uri instanceof vscode.Uri) {
                        urisToCompare = [uri];
                    }
                }
            }
            
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
                progress.report({ increment: 10, message: "Verifying Git repository..." });
                const isRepo = await git.checkIsRepo();
                if (!isRepo) {
                    vscode.window.showErrorMessage('Error: The open folder is not a Git repository.');
                    return;
                }

                progress.report({ increment: 25, message: "Fetching local branches..." });
                const branches = await git.branchLocal();
                const currentBranch = branches.current;
                const items = branches.all.map(branch => ({ label: branch }));

                const selectedItem = await vscode.window.showQuickPick(items, {
                    placeHolder: `Compare ${urisToCompare.length} file(s) from '${currentBranch}' with branch...`
                });

                if (token.isCancellationRequested || !selectedItem) { return; }

                const targetBranch = selectedItem.label;

                // Robust fetch logic with user feedback
                progress.report({ increment: 50, message: `Checking remote for branch '${targetBranch}'...` });
                let comparisonSource = targetBranch; // Default to local branch

                try {
                    const remotes = await git.getRemotes();
                    const hasOrigin = remotes.some(r => r.name === 'origin');
                    
                    if (hasOrigin) {
                        progress.report({ increment: 60, message: `Fetching updates for '${targetBranch}' from origin...` });
                        await git.fetch('origin', targetBranch);
                        // After fetching, we compare against the remote-tracking branch
                        comparisonSource = `origin/${targetBranch}`;
                    }
                } catch (error: any) {
                    // If fetch fails, inform the user and proceed with the local version
                    vscode.window.showWarningMessage(`Could not fetch updates for '${targetBranch}'. Comparing against the local version, which may be outdated.`);
                }
                
                progress.report({ increment: 75, message: `Comparing files...` });
                
                let processed = 0;
                // Loop to process each file and open a native diff tab
                for (const uri of urisToCompare) {
                    if (token.isCancellationRequested) { break; }
                    
                    processed++;
                    progress.report({ increment: 75 + (processed / urisToCompare.length * 25), message: `Comparing ${path.basename(uri.fsPath)}...` });
                    
                    const relativePath = path.relative(repoPath, uri.fsPath).replace(/\\/g, '/');
                    // Use 'comparisonSource' which could be the remote branch (e.g., 'origin/main')
                    const fileContent = await git.show([`${comparisonSource}:${relativePath}`]).catch(() => '');

                    const tempDir = os.tmpdir();
                    const tempFileName = `gitgg-${path.basename(uri.fsPath)}-${Date.now()}`;
                    const tempFilePath = path.join(tempDir, tempFileName);
                    fs.writeFileSync(tempFilePath, fileContent);
                    const tempUri = vscode.Uri.file(tempFilePath);
                    
                    let localFileLabel = currentBranch;
                    if (targetBranch === currentBranch) {
                        const status = await git.status();
                        const isModified = status.modified.some(file => path.join(repoPath, file) === uri.fsPath);
                        if (isModified) {
                            localFileLabel = 'Working Tree';
                        }
                    }
                    
                    const diffTitle = `Comparing ${path.basename(uri.fsPath)} (${targetBranch}) ↔ (${localFileLabel})`;
                    
                    // Open a native diff tab for each file
                    await vscode.commands.executeCommand('vscode.diff', tempUri, uri, diffTitle, { preview: false });
                }

            } catch (error: any) {
                if (!token.isCancellationRequested) {
                    vscode.window.showErrorMessage(`An error occurred: ${error.message}`);
                }
            }
        });
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}