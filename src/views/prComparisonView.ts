import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { GitService } from '../services/gitService';
import { PRComparisonResult, PRComparisonFileResult, ComparisonStatus } from '../models/prComparison';

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

export class PRComparisonView {
    private panel: vscode.WebviewPanel | undefined;
    private gitService: GitService | undefined;
    private prResult: PRComparisonResult | undefined;
    private context: vscode.ExtensionContext | undefined;

    async show(context: vscode.ExtensionContext, prResult: PRComparisonResult, gitService: GitService): Promise<void> {
        this.context = context;
        this.prResult = prResult;
        this.gitService = gitService;

        this.panel = vscode.window.createWebviewPanel(
            'gitgg-pr-comparison-view',
            `PR Comparison: ${prResult.promotionBranch} → ${prResult.destinationBranch}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')]
            }
        );

        context.subscriptions.push(this.panel);
        this.panel.webview.onDidReceiveMessage(async msg => this.handleMessage(msg));
        await this.updateContent(prResult);
    }

    private async updateContent(prResult: PRComparisonResult): Promise<void> {
        if (!this.panel) return;
        this.panel.webview.html = await this.generateHtml(prResult);
    }

    private async handleMessage(msg: any): Promise<void> {
        if (!this.gitService || !this.prResult) return;

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
        if (!this.prResult) return;
        for (const file of this.prResult.results) {
            if (file.status !== 'IDENTICAL') await this.stageFile(file.path, false);
        }
        await this.refresh();
    }

    private async unstageAll(): Promise<void> {
        if (!this.gitService || !this.prResult) return;
        for (const file of this.prResult.results) {
            if (file.status !== 'IDENTICAL') await this.gitService.unstageFile(file.path);
        }
        await this.refresh();
    }

    private async revertAll(): Promise<void> {
        if (!this.prResult) return;
        for (const file of this.prResult.results) {
            if (file.status !== 'IDENTICAL') await this.revertFile(file.path, false);
        }
        await this.refresh();
    }

    private async openDiff(filePath: string): Promise<void> {
        if (!this.gitService || !this.prResult) return;

        const fileResult = this.prResult.results.find(f => f.path === filePath);
        if (!fileResult) return;

        // Show environment content on left, promotion content on right
        const envContent = fileResult.environmentContent || '';
        const promoContent = fileResult.promotionContent || '';

        const tempEnvPath = path.join(os.tmpdir(), `gitgg-env-${path.basename(filePath)}-${Date.now()}`);
        const tempPromoPath = path.join(os.tmpdir(), `gitgg-promo-${path.basename(filePath)}-${Date.now()}`);

        fs.writeFileSync(tempEnvPath, envContent);
        fs.writeFileSync(tempPromoPath, promoContent);

        const diffTitle = `${path.basename(filePath)} (${this.prResult.environmentBranch} ↔ ${this.prResult.promotionBranch})`;
        await vscode.commands.executeCommand('vscode.diff',
            vscode.Uri.file(tempEnvPath),
            vscode.Uri.file(tempPromoPath),
            diffTitle,
            { preview: false }
        );
    }

    private async stageFile(filePath: string, refresh = true): Promise<void> {
        if (!this.gitService || !this.prResult) return;

        const fileResult = this.prResult.results.find(f => f.path === filePath);
        if (!fileResult) return;

        // Stage from promotion branch (HEAD) - this is the key difference from DriftView
        const content = fileResult.promotionContent;
        if (content === null) {
            await this.gitService.deleteFile(filePath);
        } else {
            await this.gitService.writeToWorkingTree(filePath, content);
        }
        await this.gitService.stageFile(filePath);
        if (refresh) await this.refresh();
    }

    private async unstageFile(filePath: string): Promise<void> {
        if (!this.gitService) return;
        await this.gitService.unstageFile(filePath);
        await this.refresh();
    }

    private async revertFile(filePath: string, refresh = true): Promise<void> {
        if (!this.gitService || !this.prResult) return;

        const fileResult = this.prResult.results.find(f => f.path === filePath);
        if (!fileResult) return;

        // Revert to environment content (source of truth)
        const content = fileResult.environmentContent;
        if (content === null) {
            await this.gitService.deleteFile(filePath);
        } else {
            await this.gitService.writeToWorkingTree(filePath, content);
        }
        if (refresh) await this.refresh();
    }

    private async refresh(): Promise<void> {
        // For now, just refresh the view - could re-run analysis if needed
        if (this.prResult) {
            await this.updateContent(this.prResult);
        }
    }

    private mapStatusToWebview(status: ComparisonStatus): 'added' | 'changed' | 'deleted' | 'unchanged' {
        switch (status) {
            case 'IDENTICAL':
                return 'unchanged';
            case 'MISSING_IN_ENVIRONMENT':
                return 'added'; // File is new in promotion (extra in current)
            case 'DIFFERENT':
                return 'changed';
            default:
                return 'unchanged';
        }
    }

    private async buildPayload(prResult: PRComparisonResult): Promise<WebviewPayload> {
        const payload: WebviewPayload = {
            addedFiles: [],
            changedFiles: [],
            deletedFiles: [],
            unchangedFiles: [],
            targetBranch: prResult.environmentBranch,
            localFileLabel: `${prResult.promotionBranch} vs ${prResult.environmentBranch}`,
            status: { staged: [] },
            restorableFiles: []
        };

        for (const file of prResult.results) {
            // Use pre-generated patch from command, or generate if missing
            let patch = file.patch || '';
            if (!patch && file.status === 'DIFFERENT' && file.promotionContent !== null && file.environmentContent !== null) {
                patch = this.generateSimplePatch(file.path, file.environmentContent, file.promotionContent);
            } else if (!patch && file.status === 'MISSING_IN_ENVIRONMENT' && file.promotionContent !== null) {
                patch = this.generateAddedPatch(file.path, file.promotionContent);
            }

            const item = { filePath: file.path, patch };
            const bucket = this.mapStatusToWebview(file.status);

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

    private generateSimplePatch(filePath: string, oldContent: string, newContent: string): string {
        const safePath = filePath.replace(/\\/g, '/');
        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');

        // Simple line-by-line diff
        let result = `diff --git a/${safePath} b/${safePath}\n`;
        result += `--- a/${safePath}\n`;
        result += `+++ b/${safePath}\n`;

        let oldStart = 1, oldCount = 0;
        let newStart = 1, newCount = 0;
        const hunks: string[] = [];

        // Find common prefix
        let prefix = 0;
        while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
            prefix++;
        }

        // Find common suffix
        let suffix = 0;
        while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
               oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) {
            suffix++;
        }

        oldCount = oldLines.length - prefix - suffix;
        newCount = newLines.length - prefix - suffix;

        if (oldCount > 0 || newCount > 0) {
            result += `@@ -${prefix + 1},${oldCount} +${prefix + 1},${newCount} @@\n`;
            for (let i = prefix; i < oldLines.length - suffix; i++) {
                result += '-' + oldLines[i] + '\n';
            }
            for (let i = prefix; i < newLines.length - suffix; i++) {
                result += '+' + newLines[i] + '\n';
            }
        }

        return result;
    }

    private generateAddedPatch(filePath: string, content: string): string {
        const safePath = filePath.replace(/\\/g, '/');
        const lines = content.split('\n');
        let result = `diff --git a/${safePath} b/${safePath}\n`;
        result += `new file mode 100644\n`;
        result += `--- /dev/null\n`;
        result += `+++ b/${safePath}\n`;
        result += `@@ -0,0 +1,${lines.length} @@\n`;
        for (const line of lines) {
            result += '+' + line + '\n';
        }
        return result;
    }

    private async generateHtml(prResult: PRComparisonResult): Promise<string> {
        if (!this.context || !this.panel) return '';

        const nonce = crypto.randomBytes(16).toString('base64');
        const webview = this.panel.webview;
        const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'webview.html');
        const cssPath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'webview.css');
        const jsPath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'main.js');

        let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');
        const webviewData = await this.buildPayload(prResult);

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