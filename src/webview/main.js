//
// This script runs inside the Webview's context, not in the main extension.
// It is responsible for all DOM manipulation, rendering the diffs, and handling user interaction.
//

// Get the special API object that allows the webview to post messages back to the extension.
const vscode = acquireVsCodeApi();
const diffContainer = document.getElementById('diff-container');

// --- 1. Load Initial Data ---
// The extension serializes all necessary data into a JSON string and places it in the HTML.
// Here, we parse that JSON to get the file data and other metadata.
const dataEl = document.getElementById('json-data');
const {
    addedFiles,
    changedFiles,
    deletedFiles,
    unchangedFiles,
    targetBranch,
    localFileLabel
} = JSON.parse(dataEl.textContent);


// --- 2. Build the Summary Header ---
// This section dynamically creates the summary text at the top of the report.
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

/** Extracts the filename from a full file path. */
function getFileName(filePath) {
    return filePath.split('/').pop();
}

/** Calculates the number of added and removed lines from a Git patch string. */
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

// --- 4. Main Rendering Logic ---

/**
 * Renders a list of files into the DOM.
 * @param {Array} files - The array of file objects to render.
 * @param {string} fileType - The status of the files ('added', 'changed', etc.).
 */
function renderFiles(files, fileType) {
    files.forEach(file => {
        const fileWrapper = document.createElement('div');
        fileWrapper.className = 'd2h-file-wrapper';
        diffContainer.appendChild(fileWrapper);

        // Create the header for this file, which is always visible and interactive.
        const header = document.createElement('div');
        const lineChanges = getLineChanges(file.patch);

        let statusBadge = '';
        let lineBadges = '';
        if (lineChanges.added > 0) lineBadges += `<span class="status-badge status-added">+${lineChanges.added}</span>`;
        if (lineChanges.removed > 0) lineBadges += `<span class="status-badge status-removed">-${lineChanges.removed}</span>`;
        
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
            } else { // 'changed'
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
                <button class="status-button native-diff-btn">View full Diff</button>
            </div>
        `;
        fileWrapper.appendChild(header);

        // Add an event listener to the 'View full Diff' button to send a message back to the extension.
        header.querySelector('.native-diff-btn').addEventListener('click', (e) => {
            e.stopPropagation(); // Prevents the click from also toggling the collapsible section.
            vscode.postMessage({ command: 'openDiff', path: file.filePath });
        });

        // For files with changes, set up the collapsible diff view.
        if (fileType !== 'unchanged') {
            const diffContentContainer = document.createElement('div');
            diffContentContainer.style.display = 'none'; // Initially hidden.
            fileWrapper.appendChild(diffContentContainer);

            // Optimization: The diff is only rendered the first time the user clicks to expand it.
            let isDiffDrawn = false;
            header.addEventListener('click', () => {
                if (!isDiffDrawn) {
                    const LINE_LIMIT = 100; // Truncate large diffs for performance.
                    let patch = file.patch || '';
                    const lines = patch.split('\n');
                    let isTruncated = false;

                    if (lines.length > LINE_LIMIT) {
                        patch = lines.slice(0, LINE_LIMIT).join('\n');
                        isTruncated = true;
                    }

                    // Use the diff2html library to draw the side-by-side diff.
                    const diff2htmlUi = new Diff2HtmlUI(diffContentContainer, patch, {
                        drawFileList: false,
                        fileContentToggle: false,
                        matching: 'lines',
                        outputFormat: 'side-by-side',
                        renderNothingWhenEmpty: true,
                        colorScheme: 'dark'
                    });
                    diff2htmlUi.draw();

                    if (isTruncated) {
                        const truncatedMsg = document.createElement('div');
                        truncatedMsg.className = 'truncated-message';
                        truncatedMsg.textContent = 'Diff truncated. Click "View full Diff" to see the complete file.';
                        diffContentContainer.appendChild(truncatedMsg);
                    }
                    
                    // Remove the default header created by diff2html, as we have our own.
                    const internalHeader = diffContentContainer.querySelector('.d2h-file-header');
                    if (internalHeader) {
                        internalHeader.style.display = 'none';
                    }
                    isDiffDrawn = true;
                }
                
                // Toggle visibility of the diff container.
                const isVisible = diffContentContainer.style.display !== 'none';
                diffContentContainer.style.display = isVisible ? 'none' : 'block';
                header.classList.toggle('d2h-file-header-collapsed', !isVisible);
            });
        }
    });
}

// --- 5. Initial Render Call ---
// Render each category of files in the desired order.
renderFiles(addedFiles, 'added');
renderFiles(changedFiles, 'changed');
renderFiles(deletedFiles, 'deleted');
renderFiles(unchangedFiles, 'unchanged');