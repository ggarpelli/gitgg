import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { GitService, DriftResult, DriftStatus, DriftFile } from '../services/gitService';

type WebviewFile = { filePath: string; patch: string };

type WebviewPayload = {
    addedFiles: WebviewFile[];
    changedFiles: WebviewFile[];
    deletedFiles: WebviewFile[];
    unchangedFiles: WebviewFile[];
    targetBranch: string;
    localFileLabel: string;
    status: { staged: string[] };
    restorableFiles: string[];
};

export class DriftView {
    private panel: vscode.WebviewPanel | undefined;
    private gitService: GitService | undefined;
    private driftResult: DriftResult | undefined;
    private context: vscode.ExtensionContext | undefined;

    async show(context: vscode.ExtensionContext, driftResult: DriftResult, gitService?: GitService): Promise<void> {
        this.context = context;
        this.driftResult = driftResult;
        this.gitService = gitService;

        this.panel = vscode.window.createWebviewPanel(
            'gitgg-drift-view',
            `Drift: ${driftResult.commitSha.substring(0, 7)} → ${driftResult.comparedTo}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
            }
        );

        context.subscriptions.push(this.panel);
        this.panel.webview.onDidReceiveMessage(async msg => this.handleMessage(msg));
        await this.updateContent(driftResult);
    }

    private async updateContent(driftResult: DriftResult): Promise<void> {
        if (!this.panel) return;
        this.panel.webview.html = await this.generateHtml(driftResult);
    }

    private async handleMessage(msg: any): Promise<void> {
        if (!this.gitService || !this.driftResult) return;

        switch (msg.command) {
            case 'openDiff':
                await this.openDiff(msg.path);
                break;
            case 'stageFile':
                await this.stageFile(msg.path);
                break;
            case 'unstageFile':
                await this.unstageFile(msg.path);
                break;
            case 'revertFile':
            case 'restoreFile':
                await this.revertFile(msg.path);
                break;
            case 'stageAll':
                await this.stageAll();
                break;
            case 'unstageAll':
                await this.unstageAll();
                break;
            case 'revertAll':
                await this.revertAll();
                break;
            case 'refresh':
                await this.refresh();
                break;
        }
    }

    private async stageAll(): Promise<void> {
        if (!this.driftResult) return;
        for (const file of this.driftResult.files) {
            if (file.status !== DriftStatus.IDENTICAL) await this.stageFile(file.path, false);
        }
        await this.refresh();
    }

    private async unstageAll(): Promise<void> {
        if (!this.gitService || !this.driftResult) return;
        for (const file of this.driftResult.files) {
            if (file.status !== DriftStatus.IDENTICAL) await this.gitService.unstageFile(file.path);
        }
        await this.refresh();
    }

    private async revertAll(): Promise<void> {
        if (!this.driftResult) return;
        for (const file of this.driftResult.files) {
            if (file.status !== DriftStatus.IDENTICAL) await this.revertFile(file.path, false);
        }
        await this.refresh();
    }

    private async openDiff(filePath: string): Promise<void> {
        if (!this.gitService || !this.driftResult) return;

        const tempContent = await this.gitService.getFileContent(this.driftResult.commitSha, filePath) || '';
        const tempFilePath = path.join(os.tmpdir(), `gitgg-drift-${path.basename(filePath)}-${Date.now()}`);
        fs.writeFileSync(tempFilePath, tempContent);

        const leftUri = vscode.Uri.file(tempFilePath);
        const rightUri = vscode.Uri.file(path.join(this.gitService.getRepoPath(), filePath));
        const diffTitle = `${path.basename(filePath)} (${this.driftResult.commitSha.substring(0, 7)}) ↔ Working Tree`;
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, diffTitle, { preview: false });
    }

    private async stageFile(filePath: string, refresh = true): Promise<void> {
        if (!this.gitService || !this.driftResult) return;
        const content = await this.gitService.getFileContent(this.driftResult.commitSha, filePath);
        if (content === null) await this.gitService.deleteFile(filePath);
        else await this.gitService.writeToWorkingTree(filePath, content);
        await this.gitService.stageFile(filePath);
        if (refresh) await this.refresh();
    }

    private async unstageFile(filePath: string): Promise<void> {
        if (!this.gitService) return;
        await this.gitService.unstageFile(filePath);
        await this.refresh();
    }

    private async revertFile(filePath: string, refresh = true): Promise<void> {
        if (!this.gitService || !this.driftResult) return;
        const content = await this.gitService.getFileContent(this.driftResult.commitSha, filePath);
        if (content === null) await this.gitService.deleteFile(filePath);
        else await this.gitService.writeToWorkingTree(filePath, content);
        if (refresh) await this.refresh();
    }

    private async refresh(): Promise<void> {
        if (!this.gitService || !this.driftResult) return;
        this.driftResult = await this.gitService.detectDrift(this.driftResult.commitSha);
        await this.updateContent(this.driftResult);
    }

    private mapFile(file: DriftFile): 'added' | 'changed' | 'deleted' | 'unchanged' {
        if (file.status === DriftStatus.IDENTICAL) return 'unchanged';
        if (file.status === DriftStatus.EXTRA_IN_CURRENT_BRANCH) return 'added';
        if (file.status === DriftStatus.DELETED || file.status === DriftStatus.MISSING_IN_CURRENT_BRANCH) return 'deleted';
        return 'changed';
    }

    private async buildPayload(driftResult: DriftResult): Promise<WebviewPayload> {
        const payload: WebviewPayload = {
            addedFiles: [],
            changedFiles: [],
            deletedFiles: [],
            unchangedFiles: [],
            targetBranch: driftResult.commitSha.substring(0, 7),
            localFileLabel: driftResult.comparedTo,
            status: { staged: [] },
            restorableFiles: []
        };

        for (const file of driftResult.files) {
            const patch = file.patch || '';
            const item = { filePath: file.path, patch };
            const bucket = this.mapFile(file);
            if (bucket === 'added') payload.addedFiles.push(item);
            if (bucket === 'changed') payload.changedFiles.push(item);
            if (bucket === 'deleted') payload.deletedFiles.push(item);
            if (bucket === 'unchanged') payload.unchangedFiles.push(item);
        }

        if (this.gitService) {
            const status = await this.gitService.getStatus();
            payload.status.staged = status.staged;
        }

        return payload;
    }

    private async generateHtml(driftResult: DriftResult): Promise<string> {
        if (!this.context || !this.panel) return '';

        const nonce = crypto.randomBytes(16).toString('base64');
        const webview = this.panel.webview;
        const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'webview.html');
        const cssPath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'webview.css');
        const jsPath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.js');

        let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');
        const webviewData = await this.buildPayload(driftResult);

        htmlContent = htmlContent.replace(/_WEBVIEW_CSS_URI_/g, webview.asWebviewUri(cssPath).toString());
        htmlContent = htmlContent.replace(/_WEBVIEW_JS_URI_/g, webview.asWebviewUri(jsPath).toString());
        htmlContent = htmlContent.replace('_VSCODE_WEBVIEW_DATA_', JSON.stringify(webviewData));
        htmlContent = htmlContent.replace(/_CSP_SOURCE_/g, webview.cspSource);
        htmlContent = htmlContent.replace(/_NONCE_/g, nonce);

        return htmlContent;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}