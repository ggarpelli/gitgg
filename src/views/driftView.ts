import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { GitService } from '../services/gitService';
import { DriftResult, DriftFile, DriftStatus } from '../services/gitService';
import { html } from 'diff2html';


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

        await this.updateContent(driftResult);
    }

    private async updateContent(driftResult: DriftResult): Promise<void> {
        if (!this.panel) return;

        const html = await this.generateHtml(driftResult);
        this.panel.webview.html = html;
    }

    private async handleMessage(msg: any): Promise<void> {
        if (!this.gitService || !this.driftResult) return;

        if (!this.isValidWebviewMessage(msg)) {
            return;
        }

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

    private isValidWebviewMessage(msg: any): msg is
        | { command: 'openDiff'; path: string; sourceType?: 'commit' | 'current' }
        | { command: 'stageFile'; path: string }
        | { command: 'previewFile'; path: string }
        | { command: 'refresh' }
        | { command: 'stageAll' }
        | { command: 'revertAll' } {
        if (!msg || typeof msg !== 'object' || typeof msg.command !== 'string') return false;
        const hasPath = typeof msg.path === 'string' && msg.path.trim().length > 0;

        switch (msg.command) {
            case 'openDiff':
                return hasPath && (!msg.sourceType || msg.sourceType === 'commit' || msg.sourceType === 'current');
            case 'stageFile':
            case 'previewFile':
                return hasPath;
            case 'refresh':
            case 'stageAll':
            case 'revertAll':
                return true;
            default:
                return false;
        }
    }

    private async previewFile(filePath: string): Promise<void> {
        if (!this.gitService || !this.driftResult || !this.panel) return;

        const commitContent = await this.gitService.getFileContent(this.driftResult.commitSha, filePath);
        // Compare against REAL WORKING TREE (disk state), not HEAD
        const currentContent = await this.gitService.getWorkingTreeContent(filePath);

        // Get line counts from drift file
        const driftFile = this.driftResult.files.find(f => f.path === filePath);
        const addedLines = driftFile?.addedLines || 0;
        const removedLines = driftFile?.removedLines || 0;

        let html = '';
        if (commitContent !== null && currentContent !== null) {
            // Show side-by-side diff
            html = await this.generateSideBySideDiffHtml(commitContent, currentContent, filePath, addedLines, removedLines);
        } else if (commitContent !== null && currentContent === null) {
            html = `<div class="diff-header">Commit version (file missing in working tree)</div><pre>${this.escapeHtml(commitContent)}</pre>`;
        } else if (currentContent !== null) {
            html = `<div class="diff-header">Working tree version (file not in commit)</div><pre>${this.escapeHtml(currentContent)}</pre>`;
        } else {
            html = '<pre>File not found in commit or working tree</pre>';
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

    private async generateSideBySideDiffHtml(commitContent: string, currentContent: string, filePath: string, addedLines: number = 0, removedLines: number = 0): Promise<string> {
        // Use pre-computed patch from driftResult (same as main.js multi-file comparison)
        const safeFilePath = filePath.replace(/\\/g, '/');
        let diff = '';

        // Use pre-computed patch if available (from detectDrift)
        const driftFile = this.driftResult?.files.find(f => f.path === filePath);
        if (driftFile?.patch) {
            diff = driftFile.patch;
        } else if (this.gitService && this.driftResult?.commitSha) {
            // Fallback: compute diff using git service
            diff = await this.gitService.getUnifiedDiff(this.driftResult.commitSha, safeFilePath);
        } else {
            // Last fallback: manual diff generation
            diff = this.generateUnifiedDiff(commitContent, currentContent, safeFilePath);
        }

        // EXACT same logic as main.js multi-files
        const LINE_LIMIT = 100;
        const lines = diff.split('\n');
        let isTruncated = false;

        if (lines.length > LINE_LIMIT) {
            diff = lines.slice(0, LINE_LIMIT).join('\n');
            isTruncated = true;
        }

        const diffHtml = html(diff, {
            drawFileList: false,
            matching: 'lines',
            outputFormat: 'side-by-side',
            renderNothingWhenEmpty: true,
            colorScheme: 'dark' as any
        });

        let truncateMsg = '';
        if (isTruncated) {
            truncateMsg = '<div class="truncated-message">Diff truncated. Click "View full Diff" to see the complete file.</div>';
        }

        return `
            <div class="sb-header">
                <span class="sb-side-label">← Commit (${this.driftResult?.commitSha.substring(0, 7)})</span>
                <span class="sb-stats"><span class="sb-added">+${addedLines}</span> <span class="sb-removed">-${removedLines}</span></span>
                <span class="sb-side-label">Working Tree →</span>
            </div>
            ${truncateMsg}
            <div class="d2h-wrapper">
                ${diffHtml}
            </div>
        `;
    }

    private generateUnifiedDiff(oldContent: string, newContent: string, filePath: string): string {
        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');

        // Simple LCS-based diff to generate hunk markers
        const hunks = this.computeDiffHunks(oldLines, newLines);

        let diff = `--- a/${filePath}\n+++ b/${filePath}\n`;

        for (const hunk of hunks) {
            diff += `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`;
            diff += hunk.lines.join('\n') + '\n';
        }

        return diff;
    }

    private computeDiffHunks(oldLines: string[], newLines: string[]): Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }> {
        const hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }> = [];

        // Use LCS to find differences
        const lcs = this.longestCommonSubsequence(oldLines, newLines);

        let oldIdx = 0;
        let newIdx = 0;
        let lcsIdx = 0;
        let hunkStart = -1;
        let hunkLines: string[] = [];
        let oldStart = 0;
        let newStart = 0;

        const flushHunk = () => {
            if (hunkLines.length > 0) {
                hunks.push({
                    oldStart: oldStart,
                    oldCount: hunkLines.filter(l => !l.startsWith('+')).length,
                    newStart: newStart,
                    newCount: hunkLines.filter(l => !l.startsWith('-')).length,
                    lines: hunkLines
                });
                hunkLines = [];
            }
        };

        while (oldIdx < oldLines.length || newIdx < newLines.length) {
            if (lcsIdx < lcs.length && oldIdx < oldLines.length && newIdx < newLines.length &&
                oldLines[oldIdx] === lcs[lcsIdx] && newLines[newIdx] === lcs[lcsIdx]) {
                // Common line
                if (hunkStart >= 0) {
                    hunkLines.push(' ' + oldLines[oldIdx]);
                }
                oldIdx++;
                newIdx++;
                lcsIdx++;
            } else if (oldIdx < oldLines.length && (lcsIdx >= lcs.length || oldLines[oldIdx] !== lcs[lcsIdx])) {
                // Line only in old
                if (hunkStart < 0) {
                    hunkStart = oldIdx;
                    oldStart = oldIdx + 1;
                    newStart = newIdx + 1;
                }
                hunkLines.push('-' + oldLines[oldIdx]);
                oldIdx++;
            } else if (newIdx < newLines.length && (lcsIdx >= lcs.length || newLines[newIdx] !== lcs[lcsIdx])) {
                // Line only in new
                if (hunkStart < 0) {
                    hunkStart = oldIdx;
                    oldStart = oldIdx + 1;
                    newStart = newIdx + 1;
                }
                hunkLines.push('+' + newLines[newIdx]);
                newIdx++;
            }

            // Flush if gap is too large (>3 context lines)
            if (hunkStart >= 0 && hunkLines.length > 0) {
                const lastLine = hunkLines[hunkLines.length - 1];
                if (lastLine.startsWith(' ') && hunkLines.length > 6) {
                    const contextAfterLastCommon = hunkLines.slice(-3).every(l => l.startsWith(' '));
                    if (contextAfterLastCommon) {
                        // Keep context in hunk but could split - for simplicity, just keep growing
                    }
                }
            }
        }

        flushHunk();
        return hunks;
    }

    private longestCommonSubsequence(a: string[], b: string[]): string[] {
        const m = a.length;
        const n = b.length;
        const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (a[i - 1] === b[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }

        // Backtrack to find LCS
        const lcs: string[] = [];
        let i = m;
        let j = n;
        while (i > 0 && j > 0) {
            if (a[i - 1] === b[j - 1]) {
                lcs.unshift(a[i - 1]);
                i--;
                j--;
            } else if (dp[i - 1][j] > dp[i][j - 1]) {
                i--;
            } else {
                j--;
            }
        }

        return lcs;
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
            if (file.status === 'MISSING_IN_CURRENT_BRANCH' || file.status === 'MODIFIED' || file.status === 'RENAMED') {
                // File exists in commit but is different/missing in working tree - restore commit version
                const content = await this.gitService.getFileContent(this.driftResult.commitSha, file.path);
                if (content !== null) {
                    await this.gitService.writeToWorkingTree(file.path, content);
                    await this.gitService.stageFile(file.path);
                }
            } else if (file.status === 'DELETED') {
                // File was deleted in commit - delete from working tree
                await this.gitService.deleteFile(file.path);
            }
            // EXTRA_IN_CURRENT_BRANCH: file is extra in working tree, not revertable
            // IDENTICAL: nothing to revert
        }
        await this.refresh();
    }

    private async openDiff(filePath: string, sourceType: 'commit' | 'current'): Promise<void> {
        if (!this.gitService || !this.driftResult || !this.panel) return;

        let tempContent: string;
        if (sourceType === 'commit') {
            tempContent = await this.gitService.getFileContent(this.driftResult.commitSha, filePath) || '';
        } else {
            // Compare against working tree, not HEAD
            tempContent = await this.gitService.getWorkingTreeContent(filePath) || '';
        }

        const tempFilePath = path.join(os.tmpdir(), `gitgg-drift-${path.basename(filePath)}-${Date.now()}`);
        fs.writeFileSync(tempFilePath, tempContent);

        const leftUri = vscode.Uri.file(tempFilePath);
        const rightUri = vscode.Uri.file(path.join(this.gitService.getRepoPath(), filePath));

        const diffTitle = `${path.basename(filePath)} (${this.driftResult.commitSha.substring(0, 7)}) ↔ Working Tree`;
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

    private async generateHtml(driftResult: DriftResult): Promise<string> {
        const crypto = require('crypto');
        const nonce = crypto.randomBytes(16).toString('base64');
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Drift Detection</title>
    <style>
        /* ====== CSS COMPLETO DO DIFF2HTML PARA SIDE-BY-SIDE ====== */
        .d2h-wrapper{text-align:left;font-family:Consolas,Monaco,monospace;font-size:12px}
        .d2h-file-header{background:#2d2d2d;border-bottom:1px solid #3c3c3c;display:flex;height:35px;padding:5px 10px;align-items:center}
        .d2h-file-stats{display:flex;font-size:13px;margin-left:auto;gap:0}
        .d2h-lines-added{border:1px solid rgba(46,160,67,.4);border-radius:4px 0 0 4px;color:#3fb950;padding:2px 6px;text-align:right;background:rgba(46,160,67,.1)}
        .d2h-lines-deleted{border:1px solid rgba(248,81,73,.4);border-radius:0 4px 4px 0;color:#f85149;margin-left:1px;padding:2px 6px;text-align:left;background:rgba(248,81,73,.1)}
        .d2h-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:Consolas,Monaco,monospace;font-size:13px;color:#9cdcfe}
        .d2h-file-wrapper{border:1px solid #3c3c3c;border-radius:4px;margin-bottom:1em;background:#1e1e1e;overflow:hidden}
        .d2h-diff-table{border-collapse:collapse;font-family:Consolas,Monaco,monospace;font-size:12px;width:100%;table-layout:fixed}
        .d2h-files-diff{display:flex;width:100%}
        .d2h-file-diff{overflow-y:hidden;width:100%}
        .d2h-file-side-diff{display:inline-block;overflow-x:auto;overflow-y:hidden;width:50%}
        .d2h-code-line,.d2h-code-side-line{display:inline-block;white-space:nowrap;width:100%;box-sizing:border-box}
        .d2h-code-side-line{padding:0 4.5em;position:relative;background:transparent}
        .d2h-code-line-ctn{display:inline-block;padding:0;white-space:pre;width:100%;vertical-align:middle;color:#ccc;font-size:12px}
        .d2h-code-side-line del,.d2h-code-side-line ins{text-decoration:none;border-radius:.15em;padding:0 1px}
        .d2h-code-line del,.d2h-code-line ins{text-decoration:none;border-radius:.15em;padding:0 1px}
        .d2h-code-linenumber{background-color:#0d1117;border-right:1px solid #21262d;color:#6e7681;display:inline-block;position:absolute;text-align:right;width:3.5em;padding:0 .5em;left:0;font-size:12px}
        .d2h-code-side-linenumber{background-color:#0d1117;border-right:1px solid #21262d;color:#6e7681;display:inline-block;position:absolute;left:0;text-align:right;width:3.5em;padding:0 .5em;font-size:12px}
        .d2h-emptyplaceholder{background-color:transparent}
        .d2h-del{background-color:transparent}
        .d2h-ins{background-color:transparent}
        .d2h-info{background-color:rgba(56,139,253,.1);color:#6e7681}
        .d2h-change{display:inline-block}
        .line-num1,.line-num2{overflow:hidden;padding:0 .5em;text-overflow:ellipsis;width:2em;display:inline-block;text-align:right;color:#484f58}
        .line-num2{width:2.5em}
        tbody tr{border-bottom:1px solid #21262d;height:20px}
        tbody tr:last-child{border-bottom:none}
        .d2h-dark-color-scheme{background:#1e1e1e;color:#ccc}
        .d2h-file-diff{background:#1e1e1e}
        .d2h-file-side-diff{background:#1e1e1e}

        /* Linhas removidas (vermelho) e adicionadas (verde) */
        .d2h-code-side-line del,
        .d2h-code-line del { background-color: rgba(248,81,73,.25); }
        .d2h-code-side-line ins,
        .d2h-code-line ins { background-color: rgba(46,160,67,.25); }

        /* Contexto Lines - sem fundo */
        .d2h-code-side-line,
        .d2h-code-line { background: transparent; }

        /* ====== ESTILOS CUSTOMIZADOS DO DRIFT VIEW ====== */
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
            padding: 10px 15px;
            background: #2d2d2d;
            border-radius: 6px;
            border: 1px solid #3c3c3c;
            cursor: pointer;
            margin-bottom: 5px;
        }
        .file-item:hover { border-color: #0e639c; }
        .file-item.selected { border-color: #9cdcfe; background: #3d3d3d; }
        .file-main {
            display: flex;
            align-items: center;
        }
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
        .file-preview {
            display: none;
            margin-top: 10px;
            border-top: 1px solid #3c3c3c;
            padding-top: 10px;
        }
        .file-preview.visible {
            display: block;
        }

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

        /* Line count in file list */
        .line-counts {
            font-size: 11px;
            margin: 0 8px;
            color: #888;
        }
        .line-added { color: #7d7; }
        .line-removed { color: #d77; }

        /* Truncated message */
        .truncated-message {
            padding: 8px;
            text-align: center;
            font-style: italic;
            color: #888;
            background: #252526;
            border-top: 1px solid #3c3c3c;
        }

        /* Side-by-side header styles */
        .sb-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: #252526;
            border-bottom: 1px solid #3c3c3c;
            padding: 6px 12px;
            color: #cecece;
            font-size: 12px;
            margin: -12px -12px 12px -12px;
        }
        .sb-stats { font-weight: bold; font-family: Consolas, Monaco, monospace; }
        .sb-added { color: #7d7; }
        .sb-removed { color: #d77; }
        .sb-side-label { color: #cecece; font-size: 11px; }
        .d2h-wrapper { background: #1e1e1e; }
        .d2h-file-diff { background: #1e1e1e; }
    </style>
</head>
<body>
    <div class="d2h-dark-color-scheme">
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
        ${await Promise.all(driftResult.files.map(f => this.renderFileItem(f))).then(files => files.join(''))}
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
        /**
         * Bridge contract between DriftView (extension host) and this webview:
         *
         * Webview -> extension:
         * - openDiff    { command: 'openDiff', path: string }
         * - stageFile   { command: 'stageFile', path: string }
         * - previewFile { command: 'previewFile', path: string }
         * - stageAll    { command: 'stageAll' }
         * - revertAll   { command: 'revertAll' }
         * - refresh     { command: 'refresh' }
         *
         * Extension -> webview:
         * - showPreview { command: 'showPreview', path: string, html: string }
         */

        function isObject(value) {
            return value !== null && typeof value === 'object';
        }

        function isNonEmptyString(value) {
            return typeof value === 'string' && value.trim().length > 0;
        }

        function isValidIncomingMessage(msg) {
            return isObject(msg)
                && msg.command === 'showPreview'
                && isNonEmptyString(msg.path)
                && typeof msg.html === 'string';
        }

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
                const filePath = item.dataset.path;
                const previewId = 'preview-' + filePath.replace(/[^a-zA-Z0-9]/g, '_');
                const previewDiv = document.getElementById(previewId);

                // If clicking same file, toggle visibility
                if (selectedFile === filePath && previewDiv) {
                    if (previewDiv.classList.contains('visible')) {
                        previewDiv.classList.remove('visible');
                        item.classList.remove('selected');
                        selectedFile = null;
                    } else {
                        previewDiv.classList.add('visible');
                    }
                    return;
                }

                // Hide all other previews
                document.querySelectorAll('.file-item').forEach(i => {
                    i.classList.remove('selected');
                    const pid = 'preview-' + i.dataset.path.replace(/[^a-zA-Z0-9]/g, '_');
                    const pdiv = document.getElementById(pid);
                    if (pdiv) pdiv.classList.remove('visible');
                });

                // Show this preview
                document.querySelectorAll('.file-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                selectedFile = filePath;
                vscode.postMessage({ command: 'previewFile', path: filePath });
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
            if (!isValidIncomingMessage(msg)) {
                return;
            }

            // Show preview in per-file div, hide global preview
            const previewId = 'preview-' + msg.path.replace(/[^a-zA-Z0-9]/g, '_');
            const previewDiv = document.getElementById(previewId);
            const globalSection = document.getElementById('previewSection');
            if (previewDiv) {
                previewDiv.innerHTML = msg.html;
                previewDiv.classList.add('visible');
            }
            if (globalSection) {
                globalSection.classList.remove('visible');
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

    private async renderFileItem(file: DriftFile): Promise<string> {
        const statusClass = file.status.toLowerCase().replace(/_/g, '-');
        const statusLabel = file.status.replace(/_/g, ' ');
        const lineCounts = (file.addedLines !== undefined || file.removedLines !== undefined)
            ? `<span class="line-counts"><span class="line-added">+${file.addedLines || 0}</span> <span class="line-removed">-${file.removedLines || 0}</span></span>`
            : '';

        // Generate the side-by-side diff content for this file
        let diffContent = '';
        if (file.status !== DriftStatus.IDENTICAL) {
            // Generate side-by-side diff using same logic as multi-file comparison
            diffContent = await this.generateSideBySideDiffHtml(
                '', // commitContent - not used when gitService is available
                '', // currentContent - not used when gitService is available
                file.path,
                file.addedLines ?? 0,
                file.removedLines ?? 0
            );
        } else {
            // For identical files, show a message
            diffContent = '<div class="identical-message">No differences</div>';
        }

        return `
            <div class="file-item" data-path="${file.path}">
                <div class="file-main">
                    <span class="file-path">${file.path}</span>
                    ${lineCounts}
                    <span class="status-badge badge-${statusClass}">${statusLabel}</span>
                    <button class="action-btn stage-btn" data-path="${file.path}">Stage</button>
                </div>
                <div class="file-preview" id="preview-${file.path.replace(/[^a-zA-Z0-9]/g, '_')}" data-path="${file.path}">
                    ${diffContent}
                </div>
            </div>
        `;
    }

    dispose(): void {
        this.panel?.dispose();
    }
}
