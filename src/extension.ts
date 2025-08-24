import * as vscode from 'vscode';
import simpleGit, { SimpleGitOptions } from 'simple-git';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { createHash } from 'crypto';

export function activate(context: vscode.ExtensionContext) {

    let disposable = vscode.commands.registerCommand('gitgg.compareFile', async (uri: vscode.Uri) => {

        const filePath = uri.fsPath;

        const options: Partial<SimpleGitOptions> = {
            baseDir: path.dirname(filePath),
            binary: 'git',
            maxConcurrentProcesses: 6,
        };

        const git = simpleGit(options);

        try {
            const isRepo = await git.checkIsRepo('root');
            if (!isRepo) {
                vscode.window.showErrorMessage('Erro: A pasta aberta não é um repositório Git.');
                return;
            }

            const branches = await git.branchLocal();
            const branchNames = branches.all;
            const currentBranch = branches.current;

            const items = branchNames.map(branch => ({
                label: branch,
                description: `Comparar com a branch ${branch}`
            }));

            const selectedItem = await vscode.window.showQuickPick(items, {
                placeHolder: 'Selecione a branch para comparar...'
            });

            if (!selectedItem) {
                return;
            }

            const selectedBranch = selectedItem.label;

            const relativePath = path.relative(path.dirname(filePath), filePath).replace(/\\/g, '/');

            let fileContent;
            try {
                fileContent = await git.show([`${selectedBranch}:${relativePath}`]);
            } catch (error: any) {
                if (error.message.includes('fatal: path') || error.message.includes('fatal: bad object')) {
                    fileContent = '';
                } else {
                    throw error;
                }
            }

            const currentFileContent = fs.readFileSync(filePath, 'utf-8');

            if (hashContent(currentFileContent) === hashContent(fileContent)) {
                vscode.window.showInformationMessage(`Os arquivos são idênticos na branch '${selectedBranch}'.`);
                return;
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
                `${path.basename(filePath)} (${selectedBranch}) ↔ (${currentBranch})`,
                {
                    label1: `${path.basename(filePath)} (${selectedBranch})`,
                    label2: `${path.basename(filePath)} (${currentBranch})`
                }
            );

        } catch (error: any) {
            vscode.window.showErrorMessage(`Ocorreu um erro: ${error.message}`);
        }
    });

    context.subscriptions.push(disposable);
}

function hashContent(content: string): string {
    return createHash('sha1').update(content).digest('hex');
}