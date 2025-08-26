import * as vscode from 'vscode';
import simpleGit, { SimpleGitOptions } from 'simple-git';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {

    let disposable = vscode.commands.registerCommand('gitgg.compareFile', 
        async (...args: any[]) => {

        let urisToCompare: vscode.Uri[] = [];

        // Logic to detect multiple files from different contexts
        if (args.length > 0) {
            if (Array.isArray(args[1]) && args[1].length > 0) {
                urisToCompare = args[1]; // Multi-select from Explorer
            }
            else if (args[0]) {
                const uri = args[0].resourceUri ? args[0].resourceUri : args[0]; // Single-select from SCM or Explorer
                if (uri instanceof vscode.Uri) {
                    urisToCompare = [uri];
                }
            }
        }
        
        // Fallback for command palette or keybinding
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
            const isRepo = await git.checkIsRepo();
            if (!isRepo) {
                vscode.window.showErrorMessage('Error: The open folder is not a Git repository.');
                return;
            }

            const branches = await git.branchLocal();
            const branchNames = branches.all;
            const currentBranch = branches.current;
            
            const items = branchNames.map(branch => ({
                label: branch,
                description: `Compare with branch ${branch}`
            }));

            const selectedItem = await vscode.window.showQuickPick(items, {
                placeHolder: `Compare ${urisToCompare.length} file(s) with branch...`
            });

            if (!selectedItem) {
                return; // User cancelled
            }

            const selectedBranch = selectedItem.label;
            
            let comparisonSource = selectedBranch;
            try {
                const remoteBranchExists = (await git.branch(['-r'])).all.some(b => b.endsWith(`/${selectedBranch}`));

                if (remoteBranchExists) {
                    vscode.window.showInformationMessage(`Fetching updates for remote branch '${selectedBranch}'...`);
                    await git.fetch();
                    comparisonSource = `origin/${selectedBranch}`;
                } else {
                    vscode.window.showInformationMessage(`Branch '${selectedBranch}' does not exist on the remote. Comparing with the local version.`);
                }
            } catch (error) {
                // Ignore fetch errors
            }

            // Loop to process each selected file
            for (const uri of urisToCompare) {
                try {
                    const filePath = uri.fsPath;
                    const relativePath = path.relative(repoPath, filePath).replace(/\\/g, '/');

                    let fileContent;
                    try {
                        fileContent = await git.show([`${comparisonSource}:${relativePath}`]);
                    } catch (error: any) {
                        if (error.message.includes('fatal: path') || error.message.includes('fatal: bad object')) {
                            fileContent = '';
                        } else {
                            vscode.window.showWarningMessage(`Could not get content of '${relativePath}' from branch '${selectedBranch}'. Skipping...`);
                            continue; 
                        }
                    }
                    
                    let currentFileLabel = `(${currentBranch})`;
                    if (selectedBranch === currentBranch) {
                        const status = await git.status();
                        const isModified = status.modified.some(file => path.join(repoPath, file) === filePath);
                        
                        if (isModified) {
                            currentFileLabel = `(Working Tree)`;
                        }
                    }

                    const tempDir = os.tmpdir();
                    const tempFileName = `gitgg-${path.basename(filePath)}-${Date.now()}`;
                    const tempFilePath = path.join(tempDir, tempFileName);
                    fs.writeFileSync(tempFilePath, fileContent);

                    const tempUri = vscode.Uri.file(tempFilePath);
                    
                    await vscode.commands.executeCommand(
                        'vscode.diff',
                        tempUri,
                        uri,
                        `Comparing ${path.basename(filePath)} (${selectedBranch}) ↔ ${currentFileLabel}`,
                        { preview: false }
                    );
                } catch (innerError: any) {
                    vscode.window.showErrorMessage(`Error comparing file ${path.basename(uri.fsPath)}: ${innerError.message}`);
                }
            }

        } catch (error: any) {
            vscode.window.showErrorMessage(`An error occurred: ${error.message}`);
        }
    });

    context.subscriptions.push(disposable);
}