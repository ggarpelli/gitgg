import * as fs from 'fs';
import * as path from 'path';
import { GitService } from './gitService';

export interface SnapshotExportOptions {
    workspacePath: string;
    sourceBranch: string;
    sourceRef: string;
    targetBranch: string;
    targetRef: string;
    environmentBranch?: string;
    changedFiles: string[];
    generatedAt?: Date;
}

export interface SnapshotChangedFileSummary {
    path: string;
    extension: string;
    type?: string;
}

const FILE_TYPE_MAPPINGS: Array<{ suffix: string; type: string }> = [
    { suffix: '.flow-meta.xml', type: 'Flow Metadata' },
    { suffix: '.permissionset-meta.xml', type: 'Permission Set Metadata' },
    { suffix: '.cls', type: 'Apex Class' },
    { suffix: '.trigger', type: 'Apex Trigger' },
    { suffix: '.js', type: 'JavaScript' },
    { suffix: '.html', type: 'HTML' },
    { suffix: '.css', type: 'CSS' },
    { suffix: '.xml', type: 'XML' }
];

export function sanitizeBranchFolderName(branchName: string): string {
    const sanitized = branchName
        .replace(/[\/\\:\s]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');

    return sanitized || 'snapshot-branch';
}

export function detectSnapshotFileType(filePath: string): string | undefined {
    const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
    const mapping = FILE_TYPE_MAPPINGS.find(item => normalizedPath.endsWith(item.suffix));
    return mapping?.type;
}

export function detectSnapshotExtension(filePath: string): string {
    const normalizedPath = filePath.replace(/\\/g, '/');

    if (normalizedPath.endsWith('.flow-meta.xml')) {
        return '.flow-meta.xml';
    }

    if (normalizedPath.endsWith('.permissionset-meta.xml')) {
        return '.permissionset-meta.xml';
    }

    return path.extname(normalizedPath);
}

export function buildSnapshotSummary(
    options: SnapshotExportOptions,
    entries: SnapshotChangedFileSummary[]
): string {
    const generatedAt = formatSnapshotTimestamp(options.generatedAt ?? new Date());
    const lines: string[] = ['# Snapshot Summary', '', 'Source Branch:', options.sourceBranch, '', 'Target Branch:', options.targetBranch];

    if (options.environmentBranch) {
        lines.push('', 'Environment Branch:', options.environmentBranch);
    }

    lines.push(
        '',
        'Folder Structure:',
        'Original repository-relative structure preserved, including standard Salesforce paths when present.',
        '',
        'Generated At:',
        generatedAt,
        '',
        'Total Files:',
        String(entries.length),
        '',
        'Changed Files:',
        ''
    );

    if (entries.length === 0) {
        lines.push('None');
    } else {
        for (const entry of entries) {
            lines.push(entry.path);
            lines.push(`Extension: ${entry.extension || '(none)'}`);

            if (entry.type) {
                lines.push(`Type: ${entry.type}`);
            }

            lines.push('');
        }
    }

    return lines.join('\n').trimEnd() + '\n';
}

export async function exportSnapshot(
    gitService: GitService,
    options: SnapshotExportOptions
): Promise<{ snapshotRoot: string; summaryPath: string }> {
    const snapshotRoot = path.join(options.workspacePath, 'snapshot');
    const sourceFolder = path.join(snapshotRoot, sanitizeBranchFolderName(options.sourceBranch));
    const targetFolder = path.join(snapshotRoot, sanitizeBranchFolderName(options.targetBranch));
    const generatedAt = options.generatedAt ?? new Date();
    const sortedChangedFiles = Array.from(new Set(options.changedFiles)).sort((left, right) => left.localeCompare(right));

    await fs.promises.rm(snapshotRoot, { recursive: true, force: true });
    await fs.promises.mkdir(sourceFolder, { recursive: true });
    await fs.promises.mkdir(targetFolder, { recursive: true });

    for (const filePath of sortedChangedFiles) {
        const [sourceContent, targetContent] = await Promise.all([
            gitService.getFileContentAtRef(options.sourceRef, filePath),
            gitService.getFileContentAtRef(options.targetRef, filePath)
        ]);

        if (sourceContent !== null) {
            await writeSnapshotFile(sourceFolder, filePath, sourceContent);
        }

        if (targetContent !== null) {
            await writeSnapshotFile(targetFolder, filePath, targetContent);
        }
    }

    const summaryEntries = sortedChangedFiles.map(filePath => ({
        path: filePath,
        extension: detectSnapshotExtension(filePath),
        type: detectSnapshotFileType(filePath)
    }));

    const summary = buildSnapshotSummary(
        {
            ...options,
            generatedAt,
            changedFiles: sortedChangedFiles
        },
        summaryEntries
    );

    const summaryPath = path.join(snapshotRoot, 'SNAPSHOT_SUMMARY.md');
    await fs.promises.writeFile(summaryPath, summary, 'utf8');

    return { snapshotRoot, summaryPath };
}

function formatSnapshotTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

async function writeSnapshotFile(rootFolder: string, filePath: string, content: string): Promise<void> {
    const normalizedPath = filePath.replace(/[\\/]+/g, path.sep);
    const destinationPath = path.join(rootFolder, normalizedPath);
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.writeFile(destinationPath, content, 'utf8');
}
