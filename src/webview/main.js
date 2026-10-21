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
const contextNote = document.getElementById('context-note');
const searchInput = document.getElementById('search');
const statusFilter = document.getElementById('status-filter');
const searchCount = document.getElementById('search-count');
const busyBanner = document.getElementById('busy-banner');
const resultBanner = document.getElementById('result-banner');

/** Row elements by file path, rebuilt on every render (used for row spinners and highlights). */
const rowElements = new Map();
const lineChangeCache = new WeakMap();

/** How many files are rendered at once per section; "Show more" renders the next page. */
const PAGE_SIZE = 200;
const AUTO_EXPAND_MAX_ITEMS = 12;

// --- 1. State ---
let state = JSON.parse(document.getElementById('json-data').textContent);
const savedViewState = vscode.getState() || {};
const view = {
    query: savedViewState.query || '',
    statusFilter: savedViewState.statusFilter || 'all',
    showUnchanged: savedViewState.showUnchanged || false,
    limits: { unchanged: PAGE_SIZE },
    // Diffs the user opened stay open across refreshes.
    expanded: new Set(savedViewState.expanded || []),
    collapsedGroups: new Set(savedViewState.collapsedGroups || []),
    expandedGroups: new Set(savedViewState.expandedGroups || []),
    sortModes: savedViewState.sortModes || {},
};
searchInput.value = view.query;
statusFilter.value = view.statusFilter;

function saveViewState() {
    vscode.setState({
        query: view.query,
        statusFilter: view.statusFilter,
        showUnchanged: view.showUnchanged,
        expanded: Array.from(view.expanded),
        collapsedGroups: Array.from(view.collapsedGroups),
        expandedGroups: Array.from(view.expandedGroups),
        sortModes: view.sortModes
    });
}

function isGroupExpanded(key, defaultExpanded) {
    if (view.expandedGroups.has(key)) return true;
    if (view.collapsedGroups.has(key)) return false;
    if (view.query) return true;
    return defaultExpanded;
}

function toggleGroup(key, defaultExpanded) {
    if (isGroupExpanded(key, defaultExpanded)) {
        view.expandedGroups.delete(key);
        view.collapsedGroups.add(key);
    } else {
        view.collapsedGroups.delete(key);
        view.expandedGroups.add(key);
    }
    saveViewState();
    renderFileSections();
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

function getSalesforceFileType(filePath) {
    const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
    const lower = parts.map(part => part.toLowerCase());
    const metadataIndex = lower.findIndex((part, index) => part === 'default' && lower[index - 1] === 'main');
    if (metadataIndex < 0) return { group: 'Other Files', label: '' };
    const metadataPath = metadataIndex >= 0 ? lower.slice(metadataIndex + 1) : lower;

    const lwcIndex = lower.indexOf('lwc');
    if (lwcIndex >= 0) {
        const componentName = parts[lwcIndex + 1] || '';
        const componentKey = componentName ? parts.slice(0, lwcIndex + 2).join('/').toLowerCase() : '';
        return { group: 'Lightning Web Components', label: 'LWC', componentName, componentKey };
    }
    const auraIndex = lower.indexOf('aura');
    if (auraIndex >= 0) {
        const componentName = parts[auraIndex + 1] || '';
        const componentKey = componentName ? parts.slice(0, auraIndex + 2).join('/').toLowerCase() : '';
        return { group: 'Aura Components', label: 'Aura', componentName, componentKey };
    }
    const fileName = parts[parts.length - 1] || '';
    if (metadataPath.includes('classes') || /\.cls(?:-meta\.xml)?$/i.test(fileName)) {
        if (/\.cls(?:-meta\.xml)?$/i.test(fileName)) {
            const componentName = fileName.replace(/\.cls(?:-meta\.xml)?$/i, '');
            const componentKey = `${parts.slice(0, -1).join('/').toLowerCase()}/${componentName.toLowerCase()}`;
            return { group: 'Apex Classes', label: 'Apex Class', componentName, componentKey };
        }
        return { group: 'Apex Classes', label: 'Apex Class' };
    }
    if (metadataPath.includes('triggers') || /\.trigger(?:-meta\.xml)?$/i.test(fileName)) {
        const componentName = fileName.replace(/\.trigger(?:-meta\.xml)?$/i, '');
        return { group: 'Apex Triggers', label: 'Apex Trigger', componentName, componentKey: `${parts.slice(0, -1).join('/').toLowerCase()}/${componentName.toLowerCase()}` };
    }
    if (metadataPath.includes('flows')) return { group: 'Flows', label: 'Flow', componentName: fileName.replace(/\.flow-meta\.xml$/i, ''), componentKey: `${parts.slice(0, -1).join('/').toLowerCase()}/${fileName.replace(/\.flow-meta\.xml$/i, '').toLowerCase()}` };
    if (metadataPath.includes('objects')) {
        const objectsIndex = metadataPath.indexOf('objects');
        const objectName = metadataPath[objectsIndex + 1] || '';
        const nestedType = metadataPath[objectsIndex + 2] || 'objects';
        const labels = {
            fields: 'Field',
            validationrules: 'Validation Rule',
            recordtypes: 'Record Type',
            layouts: 'Layout',
            fieldsets: 'Field Set',
            compactlayouts: 'Compact Layout',
            sharingreasons: 'Sharing Reason',
            businessprocesses: 'Business Process'
        };
        const componentName = objectName || fileName.replace(/\.object-meta\.xml$/i, '');
        const componentKey = objectName ? `${parts.slice(0, metadataIndex >= 0 ? metadataIndex + 1 : 0).join('/').toLowerCase()}/objects/${objectName.toLowerCase()}` : '';
        return { group: 'Objects & Fields', label: labels[nestedType] || 'Object', componentName, componentKey };
    }
    const directoryLabels = {
        accesssettings: 'Access Settings', applications: 'Applications', approvalprocesses: 'Approval Processes', assignmentrules: 'Assignment Rules',
        authproviders: 'Auth Providers', audience: 'Audiences', audiences: 'Audiences', callcenters: 'Call Centers', campaigns: 'Campaigns',
        certificates: 'Certificates', cleanDataServices: 'Clean Data Services', connectedapps: 'Connected Apps', contentassets: 'Content Assets',
        customlabels: 'Custom Labels', custommetadata: 'Custom Metadata', custompermissions: 'Custom Permissions', dashboards: 'Dashboards',
        datacategories: 'Data Categories', datacloud: 'Data Cloud', documents: 'Documents', duplicateRules: 'Duplicate Rules', duplicates: 'Duplicate Rules',
        email: 'Email', emailservices: 'Email Services', entitlements: 'Entitlements', escalationRules: 'Escalation Rules', experiences: 'Experiences',
        flexipages: 'Lightning Pages', globalValueSets: 'Global Value Sets', groups: 'Groups', homePageComponents: 'Home Page Components',
        homePageLayouts: 'Home Page Layouts', labels: 'Labels & Translations', layouts: 'Page Layouts', matchingRules: 'Matching Rules',
        namedCredentials: 'Named Credentials', navigationMenus: 'Navigation Menus', networks: 'Experience Cloud Networks', objects: 'Objects & Fields',
        pages: 'Visualforce Pages', pathAssistants: 'Path Assistants', permissionsets: 'Permission Sets', permissionsetgroups: 'Permission Set Groups',
        profiles: 'Profiles', queues: 'Queues', quickActions: 'Quick Actions', globalValueSets: 'Global Value Sets', sharingRules: 'Sharing Rules',
        staticresources: 'Static Resources', tabs: 'Tabs & Apps', translations: 'Translations', triggers: 'Apex Triggers', workflows: 'Workflow Rules',
        flows: 'Flows', classes: 'Apex Classes', aura: 'Aura Components', lwc: 'Lightning Web Components'
    };
    if (metadataIndex >= 0 && metadataPath.length) {
        const directory = metadataPath[0];
        const group = Object.entries(directoryLabels).find(([key]) => key.toLowerCase() === directory.toLowerCase())?.[1]
            || directory.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
        const suffix = fileName.match(/\.([^.]+?)(?:-meta\.xml)?$/i)?.[1] || '';
        const label = suffix ? suffix.toUpperCase() : group.replace(/s$/, '');
        return { group, label };
    }
    return { group: 'Other Files', label: '' };
}

function buildDisplayItems(entries) {
    const items = [];
    const bundles = new Map();
    const bundleGroups = new Set(['Lightning Web Components', 'Aura Components', 'Apex Classes', 'Apex Triggers', 'Objects & Fields']);
    const changedPaths = new Set(entries.map(([file]) => file.filePath.replace(/\\/g, '/').toLowerCase()));

    entries.forEach(entry => {
        const filePath = entry[0].filePath;
        const type = getSalesforceFileType(filePath);
        let bundleKey = bundleGroups.has(type.group) && type.componentKey ? `${type.group}:${type.componentKey}` : '';
        if (!bundleKey && type.group !== 'Other Files') {
            if (/-meta\.xml$/i.test(filePath)) {
                const companionPath = filePath.replace(/-meta\.xml$/i, '').toLowerCase();
                if (changedPaths.has(companionPath)) bundleKey = `pair:${companionPath}`;
            } else if (changedPaths.has(`${filePath.toLowerCase()}-meta.xml`)) {
                bundleKey = `pair:${filePath.toLowerCase()}`;
            }
        }

        if (!bundleKey) {
            items.push({ key: `file:${filePath}`, group: type.group, entries: [entry] });
            return;
        }

        if (!bundles.has(bundleKey)) {
            const item = {
                key: `bundle:${bundleKey}`,
                bundleKey,
                componentName: type.componentName || getFileName(filePath).replace(/-meta\.xml$/i, ''),
                group: type.group,
                entries: []
            };
            bundles.set(bundleKey, item);
            items.push(item);
        }
        bundles.get(bundleKey).entries.push(entry);
    });

    return items.map(item => item.bundleKey && item.group !== 'Objects & Fields' && item.entries.length === 1
        ? { key: `file:${item.entries[0][0].filePath}`, group: item.group, entries: item.entries }
        : item);
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

function getFileLineChanges(file) {
    if (lineChangeCache.has(file)) return lineChangeCache.get(file);
    const changes = getLineChanges(file.patch);
    lineChangeCache.set(file, changes);
    return changes;
}

function summarizeLines(entries) {
    return entries.reduce((total, [file]) => {
        const changes = getFileLineChanges(file);
        total.added += changes.added;
        total.removed += changes.removed;
        return total;
    }, { added: 0, removed: 0 });
}

function renderObjectFolderTree(container, entries) {
    const root = { files: [], folders: new Map() };
    entries.forEach(entry => {
        const [file, type] = entry;
        const parts = file.filePath.replace(/\\/g, '/').split('/').filter(Boolean);
        const lower = parts.map(part => part.toLowerCase());
        const objectsIndex = lower.indexOf('objects');
        const relativeParts = objectsIndex >= 0 ? parts.slice(objectsIndex + 2, -1).concat(parts.slice(-1)) : [getFileName(file.filePath)];
        let node = root;
        relativeParts.slice(0, -1).forEach(folderName => {
            if (!node.folders.has(folderName)) node.folders.set(folderName, { files: [], folders: new Map() });
            node = node.folders.get(folderName);
        });
        node.files.push(entry);
    });

    const renderNode = (parent, node, parentKey = 'objects-root') => {
        node.files.forEach(([file, type]) => renderFile(parent, file, type));
        Array.from(node.folders.entries()).sort(([left], [right]) => left.localeCompare(right)).forEach(([folderName, child]) => {
            const folderKey = `${parentKey}/${folderName.toLowerCase()}`;
            const folderOpen = isGroupExpanded(`object-folder:${folderKey}`, false);
            const folder = document.createElement('section');
            folder.className = 'object-source-folder';
            const heading = document.createElement('button');
            heading.type = 'button';
            heading.className = 'object-source-folder-heading';
            heading.setAttribute('aria-expanded', String(folderOpen));
            const chevron = document.createElement('span');
            chevron.className = 'group-chevron';
            chevron.textContent = folderOpen ? '▾' : '▸';
            const label = document.createElement('strong');
            label.textContent = folderName;
            const folderEntries = [...child.files, ...Array.from(child.folders.values()).flatMap(descendant => collectObjectFolderEntries(descendant))];
            const count = document.createElement('span');
            count.className = 'object-source-folder-count';
            count.textContent = `${folderEntries.length} ${folderEntries.length === 1 ? 'file' : 'files'} changed`;
            heading.append(chevron, label, count);
            heading.addEventListener('click', () => toggleGroup(`object-folder:${folderKey}`, false));
            folder.appendChild(heading);
            if (folderOpen) {
                const contents = document.createElement('div');
                contents.className = 'object-source-folder-content';
                renderNode(contents, child, folderKey);
                folder.appendChild(contents);
            }
            parent.appendChild(folder);
        });
    };
    renderNode(container, root);
}

function collectObjectFolderEntries(node) {
    return [...node.files, ...Array.from(node.folders.values()).flatMap(collectObjectFolderEntries)];
}

function createLineChangeSummary(added, removed) {
    const summary = document.createElement('span');
    summary.className = 'line-change-summary';
    summary.title = 'Added and removed text lines across the files in this group.';
    const additions = document.createElement('span');
    additions.className = 'line-change-added';
    additions.textContent = `+${added}`;
    const removals = document.createElement('span');
    removals.className = 'line-change-removed';
    removals.textContent = `−${removed}`;
    summary.append(additions, removals);
    return summary;
}

function createBundleStatusBadges(entries) {
    const counts = entries.reduce((result, [, type]) => {
        if (type === 'added' || type === 'changed' || type === 'deleted') result[type]++;
        return result;
    }, { added: 0, changed: 0, deleted: 0 });
    const activeStatuses = Object.entries(counts).filter(([, count]) => count > 0);
    const fragment = document.createDocumentFragment();
    activeStatuses.forEach(([type, count]) => {
        const badge = document.createElement('span');
        const variant = type === 'changed' ? 'badge-border' : 'badge-bg';
        badge.className = `status-badge ${variant} status-${type}-bg bundle-status-badge`;
        badge.textContent = activeStatuses.length === 1 ? type.toUpperCase() : `${type.toUpperCase()} ${count}`;
        badge.title = `${count} ${type} ${count === 1 ? 'file' : 'files'} in this group`;
        fragment.appendChild(badge);
    });
    return fragment;
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
    contextNote.textContent = state.contextNote || '';
    contextNote.hidden = !state.contextNote;
}

// --- 5. File rows ---
function renderFile(container, file, fileType) {
    const fileWrapper = document.createElement('div');
    fileWrapper.className = 'd2h-file-wrapper';
    container.appendChild(fileWrapper);
    rowElements.set(file.filePath, fileWrapper);

    const header = document.createElement('div');
    const lineChanges = getFileLineChanges(file);

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

    const salesforceType = getSalesforceFileType(file.filePath);
    header.innerHTML = `
        <div class="d2h-file-title" style="display: flex; align-items: center;" title="${escapeHtml(file.filePath)}">
            <svg aria-hidden="true" class="d2h-icon" height="16" version="1.1" viewBox="0 0 12 16" width="12"><path d="M6 5H2v-1h4v1zM2 8h7v-1H2v1z m0 2h7v-1H2v1z m0 2h7v-1H2v1z m10-7.5v9.5c0 0.55-0.45 1-1 1H1c-0.55 0-1-0.45-1-1V2c0-0.55 0.45-1 1-1h7.5l3.5 3.5z m-1 0.5L8 2H1v12h10V5z"></path></svg>
            <span class="d2h-file-name" style="margin-left: 8px;">${escapeHtml(getFileName(file.filePath))}</span>
            ${salesforceType.label ? `<span class="component-type-badge">${escapeHtml(salesforceType.label)}</span>` : ''}
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

    const sides = container.querySelectorAll('.d2h-file-side-diff');
    sides.forEach((side, index) => {
        const label = document.createElement('div');
        label.className = `diff-side-label ${index === 1 ? 'diff-side-label-current' : ''}`;
        const role = document.createElement('span');
        role.className = 'diff-side-role';
        role.textContent = index === 0 ? 'Compared version' : 'Current file';
        const branch = document.createElement('strong');
        branch.className = 'diff-side-branch';
        branch.textContent = index === 0 ? state.targetBranch : state.localFileLabel;
        label.append(role, branch);
        side.prepend(label);
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
    const limit = view.limits[limitKey] ?? PAGE_SIZE;
    entries.slice(0, limit).forEach(([file, type]) => renderFile(container, file, type));

    const remaining = entries.length - limit;
    if (remaining > 0) {
        const more = document.createElement('button');
        more.className = 'status-button show-more-btn';
        more.textContent = `Show ${Math.min(remaining, PAGE_SIZE)} more (${remaining} remaining)`;
        more.title = 'Render the next files of this list. Use the search box to find a specific file faster.';
        more.addEventListener('click', () => {
            view.limits[limitKey] = limit + PAGE_SIZE;
            renderFileSections();
        });
        container.appendChild(more);
    }
}

function renderFileSections() {
    const allChanges = [
        ...state.addedFiles.map(f => [f, 'added']),
        ...state.changedFiles.map(f => [f, 'changed']),
        ...state.deletedFiles.map(f => [f, 'deleted']),
    ].filter(([file]) => matchesQuery(file)).sort((left, right) => left[0].filePath.localeCompare(right[0].filePath));
    const changes = allChanges.filter(([, type]) => view.statusFilter === 'all' || type === view.statusFilter);
    const unchanged = view.statusFilter === 'all'
        ? state.unchangedFiles.map(f => [f, 'unchanged']).filter(([file]) => matchesQuery(file))
        : [];

    const allTotal = state.addedFiles.length + state.changedFiles.length + state.deletedFiles.length + state.unchangedFiles.length;
    const statusTotal = view.statusFilter === 'all'
        ? allTotal
        : ({ added: state.addedFiles.length, changed: state.changedFiles.length, deleted: state.deletedFiles.length }[view.statusFilter] || 0);
    const matchingTotal = changes.length + unchanged.length;
    searchCount.textContent = view.query || view.statusFilter !== 'all'
        ? `${matchingTotal} of ${statusTotal} files match`
        : `${allTotal} files`;

    diffContainer.innerHTML = '';
    rowElements.clear();
    if (changes.length === 0 && unchanged.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-message';
        empty.textContent = view.query || view.statusFilter !== 'all'
            ? 'No files match the current search and status filter.'
            : 'No files to show.';
        diffContainer.appendChild(empty);
        return;
    }

    const displayItems = buildDisplayItems(changes);
    const autoExpandBundles = displayItems.length <= AUTO_EXPAND_MAX_ITEMS;
    const groups = new Map();
    const groupTotals = new Map();
    changes.forEach(entry => {
        const group = getSalesforceFileType(entry[0].filePath).group;
        const totals = groupTotals.get(group) || { files: 0, added: 0, removed: 0 };
        const lineChanges = getFileLineChanges(entry[0]);
        totals.files++;
        totals.added += lineChanges.added;
        totals.removed += lineChanges.removed;
        groupTotals.set(group, totals);
    });
    displayItems.forEach(item => {
        const group = item.group;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(item);
    });

    const groupOrder = [
        'Apex Classes', 'Apex Triggers', 'Lightning Web Components', 'Aura Components', 'Flows',
        'Objects & Fields', 'Access & Permissions', 'Lightning Pages', 'Page Layouts', 'Tabs & Apps',
        'Static Resources', 'Labels & Translations', 'Other Files'
    ];
    const orderedGroups = Array.from(groups.entries()).sort((left, right) => {
        const leftIndex = groupOrder.indexOf(left[0]);
        const rightIndex = groupOrder.indexOf(right[0]);
        if (leftIndex >= 0 || rightIndex >= 0) {
            if (leftIndex < 0) return 1;
            if (rightIndex < 0) return -1;
            if (leftIndex !== rightIndex) return leftIndex - rightIndex;
        }
        return left[0].localeCompare(right[0]);
    });
    for (const [group, entries] of orderedGroups) {
        const groupLimitKey = `changes:${group}`;
        const groupLimit = view.limits[groupLimitKey] ?? PAGE_SIZE;
        const sortMode = view.sortModes[group] || 'name';
        const itemStats = new Map(entries.map(item => {
            const lineTotals = summarizeLines(item.entries);
            return [item, {
                name: (item.componentName || getFileName(item.entries[0][0].filePath)).toLocaleLowerCase(),
                files: item.entries.length,
                lines: lineTotals.added + lineTotals.removed
            }];
        }));
        const sortedEntries = [...entries].sort((left, right) => {
            const statsA = itemStats.get(left);
            const statsB = itemStats.get(right);
            if (sortMode === 'files' && statsA.files !== statsB.files) return statsB.files - statsA.files;
            if (sortMode === 'lines' && statsA.lines !== statsB.lines) return statsB.lines - statsA.lines;
            return statsA.name.localeCompare(statsB.name);
        });
        const visibleEntries = sortedEntries.slice(0, groupLimit);
        const section = document.createElement('section');
        section.className = 'component-group';
        const categoryKey = `category:${group}`;
        const categoryOpen = isGroupExpanded(categoryKey, true);
        const headingRow = document.createElement('div');
        headingRow.className = 'component-group-header-row';
        const heading = document.createElement('button');
        heading.type = 'button';
        heading.className = 'component-group-heading';
        heading.setAttribute('aria-expanded', String(categoryOpen));
        const chevron = document.createElement('span');
        chevron.className = 'group-chevron';
        chevron.textContent = categoryOpen ? '▾' : '▸';
        const headingLabel = document.createElement('span');
        headingLabel.textContent = group;
        const count = document.createElement('span');
        count.className = 'component-group-count';
        const groupLineTotals = groupTotals.get(group);
        count.textContent = String(groupLineTotals.files);
        const lineSummary = createLineChangeSummary(groupLineTotals.added, groupLineTotals.removed);
        heading.append(chevron, headingLabel, count, lineSummary);
        heading.title = categoryOpen ? `Hide ${group}` : `Show ${group}`;
        heading.addEventListener('click', () => toggleGroup(categoryKey, true));
        headingRow.appendChild(heading);
        if (entries.length > 1) {
            const sortSelect = document.createElement('select');
            sortSelect.className = 'component-sort-select';
            sortSelect.setAttribute('aria-label', `Sort ${group}`);
            sortSelect.title = `Sort ${group}`;
            [
                ['name', 'Name'],
                ['files', 'Most files'],
                ['lines', 'Most changed lines']
            ].forEach(([value, label]) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                option.selected = sortMode === value;
                sortSelect.appendChild(option);
            });
            sortSelect.addEventListener('click', event => event.stopPropagation());
            sortSelect.addEventListener('change', () => {
                view.sortModes[group] = sortSelect.value;
                saveViewState();
                renderFileSections();
            });
            headingRow.appendChild(sortSelect);
        }
        section.appendChild(headingRow);
        if (categoryOpen) {
            const content = document.createElement('div');
            content.className = 'component-group-content';
            if (['Lightning Web Components', 'Aura Components', 'Apex Classes', 'Apex Triggers', 'Objects & Fields'].includes(group)) {
                for (const item of visibleEntries) {
                    if (!item.bundleKey) {
                        const [file, type] = item.entries[0];
                        renderFile(content, file, type);
                        continue;
                    }

                    const bundle = document.createElement('section');
                    bundle.className = 'component-bundle';
                    const bundleKey = item.key;
                    const bundleOpen = isGroupExpanded(bundleKey, autoExpandBundles);
                    const bundleHeading = document.createElement('button');
                    bundleHeading.type = 'button';
                    bundleHeading.className = 'component-bundle-heading';
                    bundleHeading.setAttribute('aria-expanded', String(bundleOpen));
                    const bundleChevron = document.createElement('span');
                    bundleChevron.className = 'group-chevron';
                    bundleChevron.textContent = bundleOpen ? '▾' : '▸';
                    const bundleName = document.createElement('strong');
                    bundleName.textContent = item.componentName;
                    const bundleStatuses = createBundleStatusBadges(item.entries);
                    const bundleMeta = document.createElement('span');
                    bundleMeta.className = 'component-bundle-meta';
                    const bundleCount = document.createElement('span');
                    bundleCount.className = 'component-bundle-count';
                    const totalBundleFiles = item.entries.length;
                    bundleCount.textContent = `${totalBundleFiles} ${totalBundleFiles === 1 ? 'file' : 'files'} changed`;
                    const bundleLineTotals = summarizeLines(item.entries);
                    const bundleLineSummary = createLineChangeSummary(bundleLineTotals.added, bundleLineTotals.removed);
                    bundleLineSummary.classList.add('component-bundle-line-summary');
                    bundleHeading.append(bundleChevron, bundleName, bundleStatuses, bundleLineSummary, bundleMeta);
                    bundleMeta.append(bundleCount);
                    bundleHeading.title = bundleOpen ? `Hide files in ${item.componentName}` : `Show files in ${item.componentName}`;
                    bundleHeading.addEventListener('click', () => toggleGroup(bundleKey, autoExpandBundles));
                    bundle.appendChild(bundleHeading);
                    if (bundleOpen) {
                        const bundleFiles = document.createElement('div');
                        bundleFiles.className = 'component-bundle-files';
                        if (group === 'Objects & Fields') {
                            renderObjectFolderTree(bundleFiles, item.entries);
                        } else {
                            item.entries.forEach(([file, type]) => renderFile(bundleFiles, file, type));
                        }
                        bundle.appendChild(bundleFiles);
                    }
                    content.appendChild(bundle);
                }
            } else {
                visibleEntries.forEach(item => {
                    const [file, type] = item.entries[0];
                    renderFile(content, file, type);
                });
            }
            const remainingItems = entries.length - groupLimit;
            if (remainingItems > 0) {
                const more = document.createElement('button');
                more.className = 'status-button show-more-btn';
                const remainingFiles = entries.slice(groupLimit).reduce((sum, item) => sum + item.entries.length, 0);
                const nextFiles = entries.slice(groupLimit, groupLimit + PAGE_SIZE).reduce((sum, item) => sum + item.entries.length, 0);
                more.textContent = `Show next ${nextFiles} files (${remainingFiles} remaining)`;
                more.title = 'Show the next files in this category. Salesforce bundles stay together.';
                more.addEventListener('click', () => {
                    more.disabled = true;
                    more.textContent = 'Loading more files…';
                    window.setTimeout(() => {
                        view.limits[groupLimitKey] = groupLimit + PAGE_SIZE;
                        saveViewState();
                        renderFileSections();
                    }, 20);
                });
                content.appendChild(more);
            }
            section.appendChild(content);
        }
        diffContainer.appendChild(section);
    }

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
        view.limits = { unchanged: PAGE_SIZE };
        saveViewState();
        renderFileSections();
    }, 150);
});
statusFilter.addEventListener('change', () => {
    view.statusFilter = statusFilter.value;
    view.limits = { unchanged: PAGE_SIZE };
    saveViewState();
    renderFileSections();
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
