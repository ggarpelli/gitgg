import * as vscode from 'vscode';
import simpleGit, { SimpleGitOptions } from 'simple-git';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { createHash } from 'crypto';

export function activate(context: vscode.ExtensionContext) {

    let disposable = vscode.commands.registerCommand('gitgg.compareFile', async (...args: any[]) => {

        let uri: vscode.Uri | undefined;
        
        // Simplified logic to get a single URI
        if (args.length > 0 && args[0] && args[0].resourceUri) {
            uri = args[0].resourceUri;
        } else if (vscode.window.activeTextEditor) {
            uri = vscode.window.activeTextEditor.document.uri;
        }

        if (!uri) {
            vscode.window.showErrorMessage('No valid file or folder selected for comparison.');
            return;
        }

        const repoPath = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
        if (!repoPath) {
            vscode.window.showErrorMessage('Error: The selected file is not in a Git repository workspace.');
            return;
        }
        
        const options: Partial<SimpleGitOptions> = {
            baseDir: repoPath,
            binary: 'git',
            maxConcurrentProcesses: 6,
        };

        const git = simpleGit(options);

        try {
            // FIX: Removed the 'root' argument
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
                placeHolder: 'Select a branch to compare...'
            });

            if (!selectedItem) {
                return;
            }

            const selectedBranch = selectedItem.label;
            
            let remoteBranchExists = false;
            try {
                const remotes = await git.getRemotes(true);
                const remoteNames = remotes.map(r => r.name);
                
                if (remoteNames.length > 0) {
                    const branchSummary = await git.branch(['--remotes', '--list', `origin/${selectedBranch}`]);
                    if (branchSummary.branches[`origin/${selectedBranch}`]) {
                        remoteBranchExists = true;
                    }
                }
            } catch (error) {
                remoteBranchExists = false;
            }

            let comparisonSource: string;

            if (remoteBranchExists) {
                vscode.window.showInformationMessage(`Fetching latest updates for remote branch '${selectedBranch}'...`);
                await git.fetch('origin', selectedBranch);
                comparisonSource = `origin/${selectedBranch}`;
            } else {
                vscode.window.showInformationMessage(`Branch '${selectedBranch}' does not exist on the remote. Comparing with the local version.`);
                comparisonSource = selectedBranch;
            }

            const filePath = uri.fsPath;
            const relativePath = path.relative(repoPath, filePath).replace(/\\/g, '/');

            let fileContent;
            try {
                fileContent = await git.show([`${comparisonSource}:${relativePath}`]);
            } catch (error: any) {
                if (error.message.includes('fatal: path') || error.message.includes('fatal: bad object')) {
                    fileContent = '';
                } else {
                    vscode.window.showErrorMessage(`An error occurred while getting file content: ${error.message}`);
                    return;
                }
            }
            
            // Enhanced label logic using Git status
            let currentFileLabel = `(${currentBranch})`;
            if (selectedBranch === currentBranch) {
                const status = await git.status();
                const hasLocalChanges = status.modified.includes(relativePath);
                
                if (hasLocalChanges) {
                    currentFileLabel = `(Working Tree)`;
                }
            }

            const tempDir = os.tmpdir();
            const tempFilePath = path.join(tempDir, `gitgg-${path.basename(filePath)}-${Date.now()}`);
            fs.writeFileSync(tempFilePath, fileContent);

            const tempUri = vscode.Uri.file(tempFilePath);
            const currentUri = vscode.Uri.file(filePath);

            await vscode.commands.executeCommand(
                'vscode.diff',
                tempUri,
                currentUri,
                `Comparing ${path.basename(filePath)} (${selectedBranch}) ↔ ${currentFileLabel}`,
                {
                    label1: `${path.basename(filePath)} (${selectedBranch})`,
                    label2: `${path.basename(filePath)} ${currentFileLabel}`,
                    preview: false
                }
            );

        } catch (error: any) {
            vscode.window.showErrorMessage(`An error occurred: ${error.message}`);
        }
    });

    context.subscriptions.push(disposable);
}

function hashContent(content: string): string {
    return createHash('sha1').update(content).digest('hex');
}