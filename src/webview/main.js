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
const summaryContainer = document.getElementById('summary-container');
const summaryTitle = document.getElementById('summary-title');
const summaryBranches = document.getElementById('summary-branches');
const searchInput = document.getElementById('search');
const searchCount = document.getElementById('search-count');
const busyBanner = document.getElementById('busy-banner');
const resultBanner = document.getElementById('result-banner');

/** Row elements by file path, rebuilt on every render (used for row spinners and highlights). */
const rowElements = new Map();

/** How many files are rendered at once per section; "Show more" renders the next page. */
const PAGE_SIZE = 200;

// --- 1. State ---
let state = JSON.parse(document.getElementById('json-data').textContent);
const savedViewState = vscode.getState() || {};
const view = {
    query: savedViewState.query || '',
    showUnchanged: savedViewState.showUnchanged || false,
    limits: { changes: PAGE_SIZE, unchanged: PAGE_SIZE },
    // Diffs the user opened stay open across refreshes.
    expanded: new Set(savedViewState.expanded || []),
};
searchInput.value = view.query;

function saveViewState() {
    vscode.setState({ query: view.query, showUnchanged: view.showUnchanged, expanded: Array.from(view.expanded) });
}

// --- 2. Helper Functions ---
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getFileName(filePath) {
    return filePath.split('/').pop();
}

function getDirectory(filePath) {
    const parts = filePath.split('/');
    parts.pop();
    return parts.join('/');
}

function getLineChanges(patch) {
    if (!patch) return { added: 0, removed: 0 };
    let added = 0, removed = 0;
    patch.split('\n').forEach(line => {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        if (line.startsWith('-') && !line.startsWith('---')) removed++;
    });
    return { added, removed };
}

function isFileStaged(filePath) {
    return state.status?.staged?.includes(filePath) ?? false;
}

// Unstaged or untracked changes on disk compared with the current branch.
function hasUnstagedChanges(filePath) {
    return state.status?.unstaged?.includes(filePath) ?? false;
}

// Anything different from the current branch (HEAD), staged or not: what "Revert" would undo.
function hasLocalChanges(filePath) {
    return isFileStaged(filePath) || hasUnstagedChanges(filePath);
}

function isFileRestorable(filePath) {
    return (state.restorableFiles || []).includes(filePath);
}

// Follow the VS Code theme (light, dark or high contrast).
function getColorScheme() {
    return document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light')
        ? 'light'
        : 'dark';
}

function button(className, label, tooltip, attributes = '') {
    return `<button class="status-button ${className}" title="${escapeHtml(tooltip)}" ${attributes}>${escapeHtml(label)}</button>`;
}

function matchesQuery(file) {
    return !view.query || file.filePath.toLowerCase().includes(view.query.toLowerCase());
}

// --- 3. Tooltips (one place, so every button explains itself) ---
const tips = {
    use: () => `Replace your file with the version from ${state.targetBranch} and stage it. You can undo it with "Restore Changes" (kept while VS Code is open).`,
    useAll: () => `Replace every file that differs with its version from ${state.targetBranch} and stage them. You can undo it with "Restore All Changes" (kept while VS Code is open).`,
    stage: 'Stage this file exactly as it is on disk (git add). The content is not changed.',
    stageAll: 'Stage every file in this list that has unstaged changes, exactly as it is on disk (git add).',
    unstage: 'Remove this file from the staging area (git reset). The file on disk is not changed.',
    unstageAll: 'Remove every file in this list from the staging area (git reset). The files on disk are not changed.',
    revert: 'Put this file back as it is in your current branch (HEAD), discarding staged and unstaged changes. You can undo it with "Restore Changes" (kept while VS Code is open).',
    revertAll: 'Put every file with local changes back as it is in your current branch (HEAD). You can undo it with "Restore All Changes" (kept while VS Code is open).',
    restore: 'Undo the last "Use" or "Revert" on this file: brings back its previous content and staging state.',
    restoreAll: 'Undo every "Use" and "Revert" done in this panel. Files edited since then are skipped.',
    saveReport: 'Save the PR comparison report (Markdown) to a file you choose, with the current state of this comparison. Easy to share.',
    diff: () => `Open the full diff (${state.targetBranch} ↔ ${state.localFileLabel}) in the VS Code diff editor.`,
};

// --- 4. Summary Header ---
function renderSummary() {
    const counts = {
        added: state.addedFiles.length,
        changed: state.changedFiles.length,
        deleted: state.deletedFiles.length,
    };
    const totalChanges = counts.added + counts.changed + counts.deleted;

    let details = '';
    if (counts.added > 0) details += `<span class="summary-item summary-item-added" title="Files that exist only in your working tree">Added: ${counts.added}</span>`;
    if (counts.changed > 0) details += `<span class="summary-item summary-item-changed" title="Files with different content">Changed: ${counts.changed}</span>`;
    if (counts.deleted > 0) details += `<span class="summary-item summary-item-deleted" title="Files that exist only in ${escapeHtml(state.targetBranch)}">Deleted: ${counts.deleted}</span>`;

    summaryContainer.style.display = '';
    if (totalChanges > 0) {
        summaryTitle.innerHTML = `Comparison Summary: ${totalChanges} file${totalChanges > 1 ? 's' : ''} with changes (&nbsp;${details}&nbsp;)`;
    } else if (state.unchangedFiles.length > 0) {
        summaryTitle.textContent = 'Comparison Summary: No differences found.';
    } else {
        summaryContainer.style.display = 'none';
    }

    summaryBranches.textContent = `Compared: ${state.targetBranch} ↔ ${state.localFileLabel}`;
}

// --- 5. File rows ---
function renderFile(container, file, fileType) {
    const fileWrapper = document.createElement('div');
    fileWrapper.className = 'd2h-file-wrapper';
    container.appendChild(fileWrapper);
    rowElements.set(file.filePath, fileWrapper);

    const header = document.createElement('div');
    const lineChanges = getLineChanges(file.patch);

    let lineBadges = '';
    if (lineChanges.added > 0) lineBadges += `<span class="status-badge status-added" title="Lines added">+${lineChanges.added}</span>`;
    if (lineChanges.removed > 0) lineBadges += `<span class="status-badge status-removed" title="Lines removed">-${lineChanges.removed}</span>`;

    let actionButtons = '';
    if (fileType !== 'unchanged') {
        actionButtons += button('accept-btn', 'Use ' + state.targetBranch, tips.use());
    }
    if (hasUnstagedChanges(file.filePath)) {
        actionButtons += button('stage-btn', 'Stage', tips.stage, 'data-action="stageFile"');
    }
    if (isFileStaged(file.filePath)) {
        actionButtons += button('stage-btn', 'Unstage', tips.unstage, 'data-action="unstageFile"');
    }
    if (hasLocalChanges(file.filePath)) {
        actionButtons += button('revert-btn', 'Revert', tips.revert);
    }
    if (isFileRestorable(file.filePath)) {
        actionButtons += button('restore-btn', 'Restore Changes', tips.restore);
    }
    actionButtons += button('native-diff-btn', 'View full Diff', tips.diff());

    let statusBadge;
    if (fileType === 'unchanged') {
        header.className = 'd2h-file-header';
        statusBadge = `<span class="status-badge badge-border status-unchanged-bg" title="Same content in ${escapeHtml(state.targetBranch)} and in your working tree">UNCHANGED</span>`;
    } else {
        header.className = 'd2h-file-header d2h-file-header-collapsed';
        header.style.cursor = 'pointer';
        header.title = 'Click to show or hide the changes';
        if (fileType === 'added') {
            statusBadge = '<span class="status-badge badge-bg status-added-bg" title="Exists only in your working tree">ADDED</span>';
        } else if (fileType === 'deleted') {
            statusBadge = `<span class="status-badge badge-bg status-deleted-bg" title="Exists only in ${escapeHtml(state.targetBranch)}">DELETED</span>`;
        } else {
            statusBadge = '<span class="status-badge badge-border status-changed-bg" title="Content differs">CHANGED</span>';
        }
    }

    const directory = getDirectory(file.filePath);
    header.innerHTML = `
        <div class="d2h-file-title" style="display: flex; align-items: center;" title="${escapeHtml(file.filePath)}">
            <svg aria-hidden="true" class="d2h-icon" height="16" version="1.1" viewBox="0 0 12 16" width="12"><path d="M6 5H2v-1h4v1zM2 8h7v-1H2v1z m0 2h7v-1H2v1z m0 2h7v-1H2v1z m10-7.5v9.5c0 0.55-0.45 1-1 1H1c-0.55 0-1-0.45-1-1V2c0-0.55 0.45-1 1-1h7.5l3.5 3.5z m-1 0.5L8 2H1v12h10V5z"></path></svg>
            <span class="d2h-file-name" style="margin-left: 8px;">${escapeHtml(getFileName(file.filePath))}</span>
            ${directory ? `<span class="file-directory">${escapeHtml(directory)}</span>` : ''}
            ${statusBadge}
            ${lineBadges}
        </div>
        <div class="d2h-file-stats">
            ${actionButtons}
        </div>
    `;
    fileWrapper.appendChild(header);

    const post = (command) => (e) => {
        e.stopPropagation();
        vscode.postMessage({ command, path: file.filePath });
    };
    const bind = (selector, command) => header.querySelectorAll(selector).forEach(b => b.addEventListener('click', post(command || b.dataset.action)));
    bind('.accept-btn', 'acceptFile');
    bind('.stage-btn');
    bind('.revert-btn', 'revertFile');
    bind('.restore-btn', 'restoreFile');
    bind('.native-diff-btn', 'openDiff');

    if (fileType === 'unchanged') {
        return;
    }

    const diffContentContainer = document.createElement('div');
    diffContentContainer.style.display = 'none';
    fileWrapper.appendChild(diffContentContainer);

    let isDiffDrawn = false;
    const setExpanded = (expand) => {
        if (expand && !isDiffDrawn) {
            drawDiff(diffContentContainer, file.patch);
            isDiffDrawn = true;
        }
        diffContentContainer.style.display = expand ? 'block' : 'none';
        header.classList.toggle('d2h-file-header-collapsed', !expand);
    };

    header.addEventListener('click', () => {
        const expand = diffContentContainer.style.display === 'none';
        if (expand) view.expanded.add(file.filePath); else view.expanded.delete(file.filePath);
        saveViewState();
        setExpanded(expand);
    });

    if (view.expanded.has(file.filePath)) {
        setExpanded(true);
    }
}

function drawDiff(container, rawPatch) {
    const lineLimit = state.lineLimit || 100;
    let patch = rawPatch || '';
    const lines = patch.split('\n');
    const isTruncated = lines.length > lineLimit;
    if (isTruncated) {
        patch = lines.slice(0, lineLimit).join('\n');
    }

    container.innerHTML = html(patch, {
        drawFileList: false,
        fileContentToggle: false,
        matching: 'lines',
        outputFormat: 'side-by-side',
        renderNothingWhenEmpty: true,
        colorScheme: getColorScheme()
    });

    if (isTruncated) {
        const truncatedMsg = document.createElement('div');
        truncatedMsg.className = 'truncated-message';
        truncatedMsg.textContent = 'Diff truncated. Click "View full Diff" to see the complete file.';
        container.appendChild(truncatedMsg);
    }

    const internalHeader = container.querySelector('.d2h-file-header');
    if (internalHeader) {
        internalHeader.style.display = 'none';
    }
}

// Renders up to the current page limit, plus a "Show more" button for the rest.
function renderList(container, entries, limitKey) {
    const limit = view.limits[limitKey];
    entries.slice(0, limit).forEach(([file, type]) => renderFile(container, file, type));

    const remaining = entries.length - limit;
    if (remaining > 0) {
        const more = document.createElement('button');
        more.className = 'status-button show-more-btn';
        more.textContent = `Show ${Math.min(remaining, PAGE_SIZE)} more (${remaining} remaining)`;
        more.title = 'Render the next files of this list. Use the search box to find a specific file faster.';
        more.addEventListener('click', () => {
            view.limits[limitKey] += PAGE_SIZE;
            renderFileSections();
        });
        container.appendChild(more);
    }
}

function renderFileSections() {
    const changes = [
        ...state.addedFiles.map(f => [f, 'added']),
        ...state.changedFiles.map(f => [f, 'changed']),
        ...state.deletedFiles.map(f => [f, 'deleted']),
    ].filter(([file]) => matchesQuery(file));
    const unchanged = state.unchangedFiles.map(f => [f, 'unchanged']).filter(([file]) => matchesQuery(file));

    const total = state.addedFiles.length + state.changedFiles.length + state.deletedFiles.length + state.unchangedFiles.length;
    searchCount.textContent = view.query
        ? `${changes.length + unchanged.length} of ${total} files match`
        : `${total} files`;

    diffContainer.innerHTML = '';
    rowElements.clear();
    if (changes.length === 0 && unchanged.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-message';
        empty.textContent = view.query ? `No files match "${view.query}".` : 'No files to show.';
        diffContainer.appendChild(empty);
        return;
    }

    renderList(diffContainer, changes, 'changes');

    if (unchanged.length > 0) {
        // Unchanged files are collapsed by default (they can be thousands); a search always shows matches.
        const open = view.showUnchanged || !!view.query;
        const toggle = document.createElement('div');
        toggle.className = 'section-toggle';
        toggle.title = open ? 'Hide unchanged files' : 'Show unchanged files';
        toggle.textContent = `${open ? '▾' : '▸'} Unchanged files (${unchanged.length})`;
        toggle.addEventListener('click', () => {
            view.showUnchanged = !open;
            saveViewState();
            renderFileSections();
        });
        diffContainer.appendChild(toggle);
        if (open) {
            renderList(diffContainer, unchanged, 'unchanged');
        }
    }
}

// --- 6. Global Actions ---
function renderGlobalActions() {
    const globalActions = document.getElementById('global-actions');
    const differentFromBase = [...state.addedFiles, ...state.changedFiles, ...state.deletedFiles];
    const staged = state.status?.staged ?? [];
    const unstaged = state.status?.unstaged ?? [];

    let buttons = '';
    if (differentFromBase.length > 0) {
        buttons += button('global-accept-btn', 'Use all from ' + state.targetBranch, tips.useAll());
    }
    if (unstaged.length > 0) {
        buttons += button('global-stage-btn', 'Stage All', tips.stageAll);
    }
    if (staged.length > 0) {
        buttons += button('global-unstage-btn', 'Unstage All', tips.unstageAll);
    }
    if (staged.length > 0 || unstaged.length > 0) {
        buttons += button('global-revert-btn', 'Revert All', tips.revertAll);
    }
    if ((state.restorableFiles || []).length > 0) {
        buttons += button('global-restore-btn', 'Restore All Changes', tips.restoreAll);
    }
    if (state.hasReport) {
        buttons += button('global-report-btn', 'Save Report', tips.saveReport);
    }
    globalActions.innerHTML = buttons;

    const bind = (selector, command) => {
        const element = globalActions.querySelector(selector);
        if (element) element.addEventListener('click', () => vscode.postMessage({ command }));
    };
    bind('.global-accept-btn', 'acceptAll');
    bind('.global-stage-btn', 'stageAll');
    bind('.global-unstage-btn', 'unstageAll');
    bind('.global-revert-btn', 'revertAll');
    bind('.global-restore-btn', 'restoreAll');
    bind('.global-report-btn', 'saveReport');
}

function render() {
    renderSummary();
    renderFileSections();
    renderGlobalActions();
}

// --- 7. Search ---
let searchTimer;
searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        view.query = searchInput.value.trim();
        view.limits = { changes: PAGE_SIZE, unchanged: PAGE_SIZE };
        saveViewState();
        renderFileSections();
    }, 150);
});
searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input'));
    }
});
// Ctrl/Cmd+F focuses the search box.
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
    }
});

// --- 8. Feedback: busy state, results, errors ---
let busyStartedAt = 0;
let elapsedTimer;
let resultTimer;

function formatElapsed() {
    const seconds = Math.floor((Date.now() - busyStartedAt) / 1000);
    // Only worth showing when it takes a while.
    return seconds >= 2 ? ` · ${seconds}s` : '';
}

function showBusy(message) {
    if (message.step === 0) {
        busyStartedAt = Date.now();
        hideResult();
    }

    if (message.scope === 'row') {
        // Single-file action: spinner on that row only, the rest of the panel stays usable.
        const row = rowElements.get(message.path);
        if (row) {
            row.classList.add('row-busy');
            const stats = row.querySelector('.d2h-file-stats');
            let spinner = stats && stats.querySelector('.row-spinner');
            if (stats && !spinner) {
                spinner = document.createElement('span');
                spinner.className = 'row-spinner';
                stats.prepend(spinner);
            }
            if (spinner) spinner.textContent = message.text + '...';
        }
        return;
    }

    document.body.classList.add('busy');
    busyBanner.hidden = false;
    const draw = () => {
        busyBanner.innerHTML = `<div class="busy-title">${escapeHtml(message.text)}${formatElapsed()}</div>`
            + (message.detail ? `<div class="busy-detail">${escapeHtml(message.detail)}</div>` : '')
            + `<div class="busy-progress"><div style="width: ${Math.round((message.step / message.totalSteps) * 100)}%"></div></div>`;
    };
    draw();
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(draw, 1000);
}

function hideBusy() {
    clearInterval(elapsedTimer);
    busyBanner.hidden = true;
    document.body.classList.remove('busy');
    rowElements.forEach(row => {
        row.classList.remove('row-busy');
        row.querySelector('.row-spinner')?.remove();
    });
}

function hideResult() {
    clearTimeout(resultTimer);
    resultBanner.hidden = true;
}

function showResult(message) {
    // Highlight the rows that changed, so the eye finds them after the list re-renders.
    (message.highlight || []).forEach(filePath => {
        const row = rowElements.get(filePath);
        if (row) {
            row.classList.remove('row-flash');
            void row.offsetWidth; // restart the animation
            row.classList.add('row-flash');
        }
    });

    if (!message.text) {
        return;
    }

    const isError = message.kind === 'error';
    resultBanner.className = isError ? 'result-error' : 'result-success';
    resultBanner.innerHTML = `
        <span class="result-icon">${isError ? '✕' : '✓'}</span>
        <span class="result-text">${escapeHtml(message.text)}</span>
        ${!isError && message.undoPaths && message.undoPaths.length > 0
            ? button('result-undo-btn', 'Undo', 'Put the files back exactly as they were before this action.')
            : ''}
        ${isError && message.details ? button('result-details-btn', 'Details', 'Show the full error message.') : ''}
        <button class="result-close" title="Dismiss">×</button>
        ${isError && message.details ? `<pre class="result-details" hidden>${escapeHtml(message.details)}</pre>` : ''}
    `;
    resultBanner.hidden = false;

    resultBanner.querySelector('.result-undo-btn')?.addEventListener('click', () => {
        hideResult();
        vscode.postMessage({ command: 'undo', paths: message.undoPaths });
    });
    resultBanner.querySelector('.result-details-btn')?.addEventListener('click', () => {
        const details = resultBanner.querySelector('.result-details');
        if (details) details.hidden = !details.hidden;
    });
    resultBanner.querySelector('.result-close').addEventListener('click', hideResult);

    // Success messages leave by themselves (not while the mouse is over them); errors stay until dismissed.
    clearTimeout(resultTimer);
    if (!isError) {
        const schedule = () => { resultTimer = setTimeout(hideResult, 10000); };
        resultBanner.onmouseenter = () => clearTimeout(resultTimer);
        resultBanner.onmouseleave = schedule;
        schedule();
    } else {
        resultBanner.onmouseenter = null;
        resultBanner.onmouseleave = null;
    }
}

// --- 9. Messages from the extension ---
window.addEventListener('message', event => {
    const message = event.data;
    if (message.command === 'refresh') {
        state = message.data;
        render();
    } else if (message.command === 'busy') {
        showBusy(message);
    } else if (message.command === 'idle') {
        hideBusy();
    } else if (message.command === 'result') {
        showResult(message);
    }
});

render();
