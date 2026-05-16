import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { GitService } from '../services/gitService';
import { DriftResult, DriftFile } from '../services/gitService';

export class DriftView {
    private panel: vscode.WebviewPanel | undefined;
    private gitService: GitService | undefined;
    private driftResult: DriftResult | undefined;
    private context: vscode.ExtensionContext | undefined;

    async show(
        context: vscode.ExtensionContext,
        driftResult: DriftResult,
        gitService?: GitService
    ): Promise<void> {
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
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')
                ]
            }
        );

        context.subscriptions.push(this.panel);

        this.panel.webview.onDidReceiveMessage(async msg => {
            await this.handleMessage(msg);
        });

        this.updateContent(driftResult);
    }

    private updateContent(driftResult: DriftResult): void {
        if (!this.panel) return;

        const html = this.generateHtml(driftResult);
        this.panel.webview.html = html;
    }

    private async handleMessage(msg: any): Promise<void> {
        if (!this.gitService || !this.driftResult) return;

        switch (msg.command) {
            case 'openDiff':
                await this.openDiff(msg.path, msg.sourceType || 'commit');
                break;
            case 'stageFile':
                await this.stageFile(msg.path);
                break;
            case 'refresh':
                await this.refresh();
                break;
            case 'previewFile':
                await this.previewFile(msg.path);
                break;
            case 'stageAll':
                await this.stageAll();
                break;
            case 'revertAll':
                await this.revertAll();
                break;
        }
    }

    private async previewFile(filePath: string): Promise<void> {
        if (!this.gitService || !this.driftResult || !this.panel) return;

        const commitContent = await this.gitService.getFileContent(this.driftResult.commitSha, filePath);
        const currentContent = await this.gitService.getFileContent('HEAD', filePath);

        let html = '';
        if (commitContent !== null && currentContent !== null) {
            // Show diff
            const diffResult = this.generateDiffHtml(commitContent, currentContent, filePath);
            html = diffResult;
        } else if (commitContent !== null) {
            html = `<div class="diff-header">Commit version (file missing in HEAD)</div><pre>${this.escapeHtml(commitContent)}</pre>`;
        } else if (currentContent !== null) {
            html = `<div class="diff-header">HEAD version (file missing in commit)</div><pre>${this.escapeHtml(currentContent)}</pre>`;
        } else {
            html = '<pre>File not found in commit or HEAD</pre>';
        }

        this.panel.webview.postMessage({ command: 'showPreview', path: filePath, html });
    }

    private generateDiffHtml(commitContent: string, currentContent: string, filePath: string): string {
        const commitLines = commitContent.split('\n');
        const currentLines = currentContent.split('\n');
        let html = `<div class="diff-header">← Commit (${this.driftResult?.commitSha.substring(0, 7)}) | HEAD →</div><pre>`;

        const maxLines = Math.max(commitLines.length, currentLines.length);
        for (let i = 0; i < maxLines; i++) {
            const commitLine = commitLines[i] ?? '';
            const currentLine = currentLines[i] ?? '';

            if (commitLine === currentLine) {
                html += `<span class="diff-context">${this.escapeHtml(commitLine)}</span>\n`;
            } else {
                if (commitLine !== '') {
                    html += `<span class="diff-remove">- ${this.escapeHtml(commitLine)}</span>\n`;
                }
                if (currentLine !== '') {
                    html += `<span class="diff-add">+ ${this.escapeHtml(currentLine)}</span>\n`;
                }
            }
        }
        html += '</pre>';
        return html;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private async stageAll(): Promise<void> {
        if (!this.gitService || !this.driftResult) return;

        for (const file of this.driftResult.files) {
            if (file.status === 'IDENTICAL') continue;
            await this.stageFile(file.path);
        }
        await this.refresh();
    }

    private async revertAll(): Promise<void> {
        if (!this.gitService || !this.driftResult) return;

        for (const file of this.driftResult.files) {
            if (file.status === 'MISSING_IN_CURRENT_BRANCH') {
                // File exists in commit but not in HEAD - restore it
                const content = await this.gitService.getFileContent(this.driftResult.commitSha, file.path);
                if (content !== null) {
                    await this.gitService.writeToWorkingTree(file.path, content);
                    await this.gitService.stageFile(file.path);
                }
            } else if (file.status === 'DELETED') {
                // File was deleted in commit - delete from working tree
                await this.gitService.deleteFile(file.path);
            }
            // For other statuses, revert makes no sense in this context
        }
        await this.refresh();
    }

    private async openDiff(filePath: string, sourceType: 'commit' | 'current'): Promise<void> {
        if (!this.gitService || !this.driftResult || !this.panel) return;

        let tempContent: string;
        if (sourceType === 'commit') {
            tempContent = await this.gitService.getFileContent(this.driftResult.commitSha, filePath) || '';
        } else {
            tempContent = await this.gitService.getFileContent('HEAD', filePath) || '';
        }

        const tempFilePath = path.join(os.tmpdir(), `gitgg-drift-${path.basename(filePath)}-${Date.now()}`);
        fs.writeFileSync(tempFilePath, tempContent);

        const leftUri = vscode.Uri.file(tempFilePath);
        const rightUri = vscode.Uri.file(path.join(this.gitService.getRepoPath(), filePath));

        const diffTitle = `${path.basename(filePath)} (${this.driftResult.commitSha.substring(0, 7)}) ↔ (${this.driftResult.comparedTo})`;
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, diffTitle, { preview: false });
    }

    private async stageFile(filePath: string): Promise<void> {
        if (!this.gitService || !this.driftResult) return;

        const content = await this.gitService.getFileContent(this.driftResult.commitSha, filePath);

        if (content === null) {
            await this.gitService.deleteFile(filePath);
        } else {
            await this.gitService.writeToWorkingTree(filePath, content);
        }

        await this.gitService.stageFile(filePath);
        await this.refresh();
    }

    private async refresh(): Promise<void> {
        if (!this.gitService || !this.driftResult || !this.panel) return;

        const newResult = await this.gitService.detectDrift(this.driftResult.commitSha);
        this.driftResult = newResult;
        this.updateContent(newResult);
    }

    private generateHtml(driftResult: DriftResult): string {
        const crypto = require('crypto');
        const nonce = crypto.randomBytes(16).toString('base64');
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Drift Detection</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 20px;
            background: #1e1e1e;
            color: #cccccc;
        }
        .header {
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid #3c3c3c;
        }
        .commit-info {
            font-size: 14px;
            color: #9cdcfe;
            margin-bottom: 5px;
        }
        .commit-message {
            font-size: 16px;
            font-weight: 500;
            margin-bottom: 10px;
        }
        .global-actions {
            display: flex;
            gap: 10px;
            margin-top: 10px;
        }
        .global-btn {
            padding: 6px 16px;
            background: #0e639c;
            border: none;
            border-radius: 4px;
            color: white;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
        }
        .global-btn:hover { background: #1177bb; }
        .global-btn.stage-all { background: #2d5a2d; }
        .global-btn.stage-all:hover { background: #3d6a3d; }
        .global-btn.revert-all { background: #5a2d2d; }
        .global-btn.revert-all:hover { background: #6a3d3d; }

        .stats {
            display: flex;
            gap: 15px;
            font-size: 12px;
        }
        .stat-item {
            padding: 4px 8px;
            border-radius: 4px;
        }
        .stat-identical { background: #2d5a2d; }
        .stat-modified { background: #5a4a2d; }
        .stat-missing { background: #5a2d2d; }
        .stat-extra { background: #2d4a5a; }
        .stat-renamed { background: #4a2d5a; }
        .stat-deleted { background: #5a2d2d; }

        .file-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .file-item {
            display: flex;
            align-items: center;
            padding: 10px 15px;
            background: #2d2d2d;
            border-radius: 6px;
            border: 1px solid #3c3c3c;
            cursor: pointer;
        }
        .file-item:hover { border-color: #0e639c; }
        .file-item.selected { border-color: #9cdcfe; background: #3d3d3d; }
        .file-path {
            flex: 1;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 13px;
        }
        .status-badge {
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 500;
            margin-left: 10px;
        }
        .badge-identical { background: #2d5a2d; color: #7d7; }
        .badge-modified { background: #5a4a2d; color: #da8; }
        .badge-missing { background: #5a2d2d; color: #d77; }
        .badge-extra { background: #2d4a5a; color: #7ad; }
        .badge-renamed { background: #4a2d5a; color: #a7d; }
        .badge-deleted { background: #5a2d2d; color: #d77; }

        .action-btn {
            padding: 5px 12px;
            background: #0e639c;
            border: none;
            border-radius: 4px;
            color: white;
            cursor: pointer;
            font-size: 12px;
            margin-left: 8px;
        }
        .action-btn:hover { background: #1177bb; }

        .preview-section {
            margin-top: 20px;
            border: 1px solid #3c3c3c;
            border-radius: 6px;
            overflow: hidden;
            display: none;
        }
        .preview-section.visible { display: block; }
        .preview-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 15px;
            background: #2d2d2d;
            border-bottom: 1px solid #3c3c3c;
        }
        .preview-title {
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 13px;
            color: #9cdcfe;
        }
        .preview-close {
            background: none;
            border: none;
            color: #888;
            cursor: pointer;
            font-size: 18px;
            padding: 0 5px;
        }
        .preview-close:hover { color: #ccc; }
        .preview-content {
            background: #1e1e1e;
            max-height: 400px;
            overflow: auto;
        }
        .preview-content pre {
            margin: 0;
            padding: 15px;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 12px;
            line-height: 1.5;
            white-space: pre-wrap;
            word-break: break-all;
        }
        .diff-add { background: #2d4a2d; color: #7d7; }
        .diff-remove { background: #4a2d2d; color: #d77; }
        .diff-context { color: #888; }
        .diff-header { color: #9cdcfe; background: #2d2d2d; padding: 5px 10px; }
    </style>
</head>
<body>
    <div class="header">
        <div class="commit-info">${driftResult.commitSha.substring(0, 7)} → ${driftResult.comparedTo}</div>
        <div class="commit-message">${driftResult.commitMessage}</div>
        <div class="stats">
            ${this.renderStats(driftResult)}
        </div>
        <div class="global-actions">
            <button class="global-btn stage-all" id="stageAllBtn">Stage All</button>
            <button class="global-btn revert-all" id="revertAllBtn">Revert All</button>
            <button class="global-btn" id="refreshBtn">Refresh</button>
        </div>
    </div>
    <div class="file-list" id="fileList">
        ${driftResult.files.map(f => this.renderFileItem(f)).join('')}
    </div>
    <div class="preview-section" id="previewSection">
        <div class="preview-header">
            <span class="preview-title" id="previewTitle">File preview</span>
            <button class="preview-close" id="closePreview">×</button>
        </div>
        <div class="preview-content" id="previewContent"><pre></pre></div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let selectedFile = null;

        document.querySelectorAll('.diff-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ command: 'openDiff', path: btn.dataset.path });
            });
        });
        document.querySelectorAll('.stage-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ command: 'stageFile', path: btn.dataset.path });
            });
        });
        document.querySelectorAll('.file-item').forEach(item => {
            item.addEventListener('click', () => {
                document.querySelectorAll('.file-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                selectedFile = item.dataset.path;
                vscode.postMessage({ command: 'previewFile', path: item.dataset.path });
            });
        });
        document.getElementById('stageAllBtn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'stageAll' });
        });
        document.getElementById('revertAllBtn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'revertAll' });
        });
        document.getElementById('refreshBtn')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'refresh' });
        });
        document.getElementById('closePreview')?.addEventListener('click', () => {
            document.getElementById('previewSection').classList.remove('visible');
            selectedFile = null;
        });

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'showPreview') {
                const section = document.getElementById('previewSection');
                const title = document.getElementById('previewTitle');
                const content = document.getElementById('previewContent');
                title.textContent = msg.path;
                content.innerHTML = msg.html;
                section.classList.add('visible');
            }
        });
    </script>
</body>
</html>`;
    }

    private renderStats(driftResult: DriftResult): string {
        const counts = {
            identical: driftResult.files.filter(f => f.status === 'IDENTICAL').length,
            modified: driftResult.files.filter(f => f.status === 'MODIFIED').length,
            missing: driftResult.files.filter(f => f.status === 'MISSING_IN_CURRENT_BRANCH').length,
            extra: driftResult.files.filter(f => f.status === 'EXTRA_IN_CURRENT_BRANCH').length,
            renamed: driftResult.files.filter(f => f.status === 'RENAMED').length,
            deleted: driftResult.files.filter(f => f.status === 'DELETED').length
        };

        return `
            <span class="stat-item stat-identical">Identical: ${counts.identical}</span>
            <span class="stat-item stat-modified">Modified: ${counts.modified}</span>
            <span class="stat-item stat-missing">Missing: ${counts.missing}</span>
            <span class="stat-item stat-extra">Extra: ${counts.extra}</span>
            <span class="stat-item stat-renamed">Renamed: ${counts.renamed}</span>
            <span class="stat-item stat-deleted">Deleted: ${counts.deleted}</span>
        `;
    }

    private renderFileItem(file: any): string {
        const statusClass = file.status.toLowerCase().replace(/_/g, '-');
        const statusLabel = file.status.replace(/_/g, ' ');

        return `
            <div class="file-item" data-path="${file.path}">
                <span class="file-path">${file.path}</span>
                <span class="status-badge badge-${statusClass}">${statusLabel}</span>
                <button class="action-btn diff-btn" data-path="${file.path}">Diff</button>
                <button class="action-btn stage-btn" data-path="${file.path}">Stage</button>
            </div>
        `;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}