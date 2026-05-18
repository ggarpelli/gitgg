//
// This script runs inside the Webview's context, not in the main extension.
// It is responsible for all DOM manipulation, rendering the diffs, and handling user interaction.
//

import { html } from 'diff2html';
import 'diff2html/bundles/css/diff2html.min.css';
import './webview.css';

// Get the special API object that allows the webview to post messages back to the extension.
const vscode = acquireVsCodeApi();
const diffContainer = document.getElementById('diff-container');

// --- 1. Load Initial Data ---
const dataEl = document.getElementById('json-data');
let {
    addedFiles,
    changedFiles,
    deletedFiles,
    unchangedFiles,
    targetBranch,
    localFileLabel,
    status,
    restorableFiles = []
} = JSON.parse(dataEl.textContent);

// --- 2. Build the Summary Header ---
const summaryContainer = document.getElementById('summary-container');
const summaryTitle = document.getElementById('summary-title');
const summaryBranches = document.getElementById('summary-branches');

const counts = {
    added: addedFiles.length,
    changed: changedFiles.length,
    deleted: deletedFiles.length,
};
const totalChanges = counts.added + counts.changed + counts.deleted;

let summaryDetailsHtml = '';
if (counts.added > 0) summaryDetailsHtml += `<span class="summary-item summary-item-added">Added: ${counts.added}</span>`;
if (counts.changed > 0) summaryDetailsHtml += `<span class="summary-item summary-item-changed">Changed: ${counts.changed}</span>`;
if (counts.deleted > 0) summaryDetailsHtml += `<span class="summary-item summary-item-deleted">Deleted: ${counts.deleted}</span>`;

if (totalChanges > 0) {
    summaryTitle.innerHTML = `Comparison Summary: ${totalChanges} file${totalChanges > 1 ? 's' : ''} with changes (&nbsp;${summaryDetailsHtml.trim()}&nbsp;)`;
} else if (unchangedFiles.length > 0) {
    summaryTitle.textContent = 'Comparison Summary: No differences found.';
} else {
    summaryContainer.style.display = 'none';
}

summaryBranches.innerHTML = `Branches Compared: ${targetBranch} &harr; ${localFileLabel}`;

// --- 3. Helper Functions ---
function getFileName(filePath) {
    return filePath.split('/').pop();
}

function getLineChanges(patch) {
    if (!patch) return { added: 0, removed: 0 };
    let added = 0, removed = 0;
    const lines = patch.split('\n');
    lines.forEach(line => {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        if (line.startsWith('-') && !line.startsWith('---')) removed++;
    });
    return { added, removed };
}

let currentStatus = status;

function isFileStaged(filePath) {
    return currentStatus?.staged?.includes(filePath) ?? false;
}

function isFileRestorable(filePath) {
    return restorableFiles.includes(filePath);
}

// --- 4. Main Rendering Logic ---
function renderFiles(files, fileType) {
    files.forEach(file => {
        const fileWrapper = document.createElement('div');
        fileWrapper.className = 'd2h-file-wrapper';
        diffContainer.appendChild(fileWrapper);

        const header = document.createElement('div');
        const lineChanges = getLineChanges(file.patch);

        let statusBadge = '';
        let lineBadges = '';
        if (lineChanges.added > 0) lineBadges += `<span class="status-badge status-added">+${lineChanges.added}</span>`;
        if (lineChanges.removed > 0) lineBadges += `<span class="status-badge status-removed">-${lineChanges.removed}</span>`;

        let actionButtons = '';
        if (fileType !== 'unchanged') {
            const staged = isFileStaged(file.filePath);
            actionButtons += `<button class="status-button stage-btn" data-action="${staged ? 'unstageFile' : 'stageFile'}">${staged ? 'Unstage' : 'Stage'}</button>`;
            if (!staged) {
                actionButtons += '<button class="status-button revert-btn">Revert</button>';
            }
        } else if (isFileRestorable(file.filePath)) {
            actionButtons += '<button class="status-button restore-btn">Restore Changes</button>';
        }
        actionButtons += '<button class="status-button native-diff-btn">View full Diff</button>';

        if (fileType === 'unchanged') {
            header.className = 'd2h-file-header';
            statusBadge = '<span class="status-badge badge-border status-unchanged-bg">UNCHANGED</span>';
        } else {
            header.className = 'd2h-file-header d2h-file-header-collapsed';
            header.style.cursor = 'pointer';
            if (fileType === 'added') {
                statusBadge = '<span class="status-badge badge-bg status-added-bg">ADDED</span>';
            } else if (fileType === 'deleted') {
                statusBadge = '<span class="status-badge badge-bg status-deleted-bg">DELETED</span>';
            } else {
                statusBadge = '<span class="status-badge badge-border status-changed-bg">CHANGED</span>';
            }
        }

        header.innerHTML = `
            <div class="d2h-file-title" style="display: flex; align-items: center;" title="${file.filePath}">
                <svg aria-hidden="true" class="d2h-icon" height="16" version="1.1" viewBox="0 0 12 16" width="12"><path d="M6 5H2v-1h4v1zM2 8h7v-1H2v1z m0 2h7v-1H2v1z m0 2h7v-1H2v1z m10-7.5v9.5c0 0.55-0.45 1-1 1H1c-0.55 0-1-0.45-1-1V2c0-0.55 0.45-1 1-1h7.5l3.5 3.5z m-1 0.5L8 2H1v12h10V5z"></path></svg>
                <span class="d2h-file-name" style="margin-left: 8px;">${getFileName(file.filePath)}</span>
                ${statusBadge}
                ${lineBadges}
            </div>
            <div class="d2h-file-stats">
                ${actionButtons}
            </div>
        `;
        fileWrapper.appendChild(header);

        const stageBtn = header.querySelector('.stage-btn');
        if (stageBtn) {
            stageBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ command: stageBtn.dataset.action, path: file.filePath });
            });
        }

        const revertBtn = header.querySelector('.revert-btn');
        if (revertBtn) {
            revertBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ command: 'revertFile', path: file.filePath });
            });
        }

        const restoreBtn = header.querySelector('.restore-btn');
        if (restoreBtn) {
            restoreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ command: 'restoreFile', path: file.filePath });
            });
        }

        header.querySelector('.native-diff-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ command: 'openDiff', path: file.filePath });
        });

        if (fileType !== 'unchanged') {
            const diffContentContainer = document.createElement('div');
            diffContentContainer.style.display = 'none';
            fileWrapper.appendChild(diffContentContainer);

            let isDiffDrawn = false;
            header.addEventListener('click', () => {
                if (!isDiffDrawn) {
                    const LINE_LIMIT = 100;
                    let patch = file.patch || '';
                    const lines = patch.split('\n');
                    let isTruncated = false;

                    if (lines.length > LINE_LIMIT) {
                        patch = lines.slice(0, LINE_LIMIT).join('\n');
                        isTruncated = true;
                    }

                    const diffHtml = html(patch, {
                        drawFileList: false,
                        fileContentToggle: false,
                        matching: 'lines',
                        outputFormat: 'side-by-side',
                        renderNothingWhenEmpty: true,
                        colorScheme: 'dark'
                    });
                    diffContentContainer.innerHTML = diffHtml;

                    if (isTruncated) {
                        const truncatedMsg = document.createElement('div');
                        truncatedMsg.className = 'truncated-message';
                        truncatedMsg.textContent = 'Diff truncated. Click "View full Diff" to see the complete file.';
                        diffContentContainer.appendChild(truncatedMsg);
                    }

                    const internalHeader = diffContentContainer.querySelector('.d2h-file-header');
                    if (internalHeader) {
                        internalHeader.style.display = 'none';
                    }
                    isDiffDrawn = true;
                }

                const isVisible = diffContentContainer.style.display !== 'none';
                diffContentContainer.style.display = isVisible ? 'none' : 'block';
                header.classList.toggle('d2h-file-header-collapsed', !isVisible);
            });
        }
    });
}

// --- 5. Update Global Actions ---
function updateGlobalActions() {
    const globalActions = document.getElementById('global-actions');
    const modifiedFiles = [...addedFiles, ...changedFiles, ...deletedFiles];
    const hasRestorable = restorableFiles.length > 0;
    const hasAnyChanges = modifiedFiles.length > 0;
    const unstagedCount = modifiedFiles.filter(f => !currentStatus.staged.includes(f.filePath)).length;

    const allStaged = hasAnyChanges && modifiedFiles.every(f => currentStatus.staged.includes(f.filePath));
    const noneStaged = hasAnyChanges && unstagedCount === modifiedFiles.length;
    const someStaged = hasAnyChanges && !allStaged && !noneStaged;

    let html = '';

    if (hasAnyChanges) {
        if (allStaged) {
            // All files staged: only Unstage All
            html += `<button class="status-button global-unstage-btn">Unstage All</button>`;
        } else {
            // Some or none staged: Stage All + Unstage All + Revert All (in order)
            html += `<button class="status-button global-stage-btn">Stage All</button>`;

            // If some are staged, show Unstage All (for staged files)
            if (someStaged) {
                html += `<button class="status-button global-unstage-btn">Unstage All</button>`;
            }

            // Revert All always comes last (only when there are non-staged files)
            if (unstagedCount > 0) {
                html += `<button class="status-button global-revert-btn">Revert All</button>`;
            }
        }
    }

    // Always show Restore All if there are restorable files
    if (hasRestorable) {
        html += `<button class="status-button global-restore-btn">Restore All Changes</button>`;
    }

    globalActions.innerHTML = html;

    // Re-attach listeners
    const stageBtn = globalActions.querySelector('.global-stage-btn');
    if (stageBtn) stageBtn.addEventListener('click', () => vscode.postMessage({ command: 'stageAll' }));

    const unstageBtn = globalActions.querySelector('.global-unstage-btn');
    if (unstageBtn) unstageBtn.addEventListener('click', () => vscode.postMessage({ command: 'unstageAll' }));

    const revertBtn = globalActions.querySelector('.global-revert-btn');
    if (revertBtn) revertBtn.addEventListener('click', () => vscode.postMessage({ command: 'revertAll' }));

    const restoreBtn = globalActions.querySelector('.global-restore-btn');
    if (restoreBtn) restoreBtn.addEventListener('click', () => vscode.postMessage({ command: 'restoreAll' }));
}

// --- 6. Listen for messages from the extension ---
window.addEventListener('message', event => {
    const message = event.data;
    if (message.command === 'refresh') {
        const { addedFiles: a, changedFiles: c, deletedFiles: d, unchangedFiles: u, status: s, restorableFiles: r = [] } = message.data;
        currentStatus = s;
        restorableFiles = r;
        diffContainer.innerHTML = '';
        renderFiles(a, 'added');
        renderFiles(c, 'changed');
        renderFiles(d, 'deleted');
        renderFiles(u, 'unchanged');
        updateGlobalActions();
    }
});

// --- 6. Initial Render Call ---
renderFiles(addedFiles, 'added');
renderFiles(changedFiles, 'changed');
renderFiles(deletedFiles, 'deleted');
renderFiles(unchangedFiles, 'unchanged');
updateGlobalActions();
