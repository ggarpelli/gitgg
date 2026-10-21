import * as fs from 'fs';
import * as path from 'path';
import type { GitService } from './gitService';
import { throwIfAborted } from '../utils/concurrency';

export const SNAPSHOT_MARKER_FILE = '.gitgg-snapshot';

/** Thrown when the snapshot folder already exists, was not created by Gitgg and the user did not allow overwriting it. */
export class SnapshotCancelledError extends Error {
    constructor(folder: string) {
        super(`Snapshot export cancelled: '${folder}' already exists and was not created by Gitgg.`);
        this.name = 'SnapshotCancelledError';
    }
}

export interface SnapshotExportOptions {
    workspacePath: string;
    /** Folder (relative to workspacePath) where the snapshot is written. Defaults to `snapshot`. */
    folderName?: string;
    /**
     * Called when the snapshot folder exists but has no Gitgg marker file (it may hold user data).
     * Return true to delete and overwrite it. When omitted, such a folder is never deleted.
     */
    confirmOverwrite?: (folder: string) => Promise<boolean>;
    sourceBranch: string;
    sourceRef: string;
    targetBranch: string;
    targetRef: string;
    environmentBranch?: string;
    changedFiles: string[];
    generatedAt?: Date;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number, phase: 'Reading files' | 'Writing files') => void;
}

type SnapshotGitService = Pick<GitService, 'getFileContentAtRef'> & Partial<Pick<GitService, 'readBlobs'>>;

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
    const lines: string[] = [
        '# Snapshot Summary',
        '',
        'Source Branch:',
        options.sourceBranch,
        '',
        'Target Branch:',
        options.targetBranch,
        '',
        'Snapshot Contents:',
        'Committed versions from the selected branch refs. Uncommitted working-tree changes are not included.'
    ];

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
    gitService: SnapshotGitService,
    options: SnapshotExportOptions
): Promise<{ snapshotRoot: string; summaryPath: string }> {
    const snapshotRoot = path.join(options.workspacePath, options.folderName || 'snapshot');
    const generatedAt = options.generatedAt ?? new Date();
    const sortedChangedFiles = Array.from(new Set(options.changedFiles)).sort((left, right) => left.localeCompare(right));
    const tempSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workingRoot = `${snapshotRoot}.gitgg-tmp-${tempSuffix}`;
    const backupRoot = `${snapshotRoot}.gitgg-backup-${tempSuffix}`;

    if (fs.existsSync(snapshotRoot)) {
        const createdByGitgg = fs.existsSync(path.join(snapshotRoot, SNAPSHOT_MARKER_FILE));
        if (!createdByGitgg && !(options.confirmOverwrite && await options.confirmOverwrite(snapshotRoot))) {
            throw new SnapshotCancelledError(snapshotRoot);
        }
    }

    const sourceFolder = path.join(workingRoot, sanitizeBranchFolderName(options.sourceBranch));
    const targetFolder = path.join(workingRoot, sanitizeBranchFolderName(options.targetBranch));
    try {
        throwIfAborted(options.signal);
        await fs.promises.mkdir(sourceFolder, { recursive: true });
        await fs.promises.writeFile(
            path.join(workingRoot, SNAPSHOT_MARKER_FILE),
            'Created by the Gitgg VS Code extension. This folder is replaced on every snapshot export.\n',
            'utf8'
        );
        await fs.promises.mkdir(targetFolder, { recursive: true });

        const batchSize = 200;
        let written = 0;
        options.onProgress?.(0, sortedChangedFiles.length, 'Reading files');
        for (let offset = 0; offset < sortedChangedFiles.length; offset += batchSize) {
            throwIfAborted(options.signal);
            const batch = sortedChangedFiles.slice(offset, offset + batchSize);
            const [sourceBlobs, targetBlobs] = await Promise.all([
                readSnapshotBlobs(gitService, options.sourceRef, batch, options.signal),
                readSnapshotBlobs(gitService, options.targetRef, batch, options.signal)
            ]);
            options.onProgress?.(offset + batch.length, sortedChangedFiles.length, 'Reading files');

            for (const filePath of batch) {
                throwIfAborted(options.signal);
                const sourceContent = sourceBlobs.get(filePath);
                const targetContent = targetBlobs.get(filePath);
                if (sourceContent) {
                    await writeSnapshotFile(sourceFolder, filePath, sourceContent);
                }
                if (targetContent) {
                    await writeSnapshotFile(targetFolder, filePath, targetContent);
                }
                written++;
                if (written % 50 === 0 || written === sortedChangedFiles.length) {
                    options.onProgress?.(written, sortedChangedFiles.length, 'Writing files');
                }
            }
        }

        throwIfAborted(options.signal);
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

        await fs.promises.writeFile(path.join(workingRoot, 'SNAPSHOT_SUMMARY.md'), summary, 'utf8');
        throwIfAborted(options.signal);

        let movedExistingSnapshot = false;
        try {
            if (fs.existsSync(snapshotRoot)) {
                await fs.promises.rename(snapshotRoot, backupRoot);
                movedExistingSnapshot = true;
            }
            await fs.promises.rename(workingRoot, snapshotRoot);
        } catch (error) {
            if (movedExistingSnapshot && !fs.existsSync(snapshotRoot)) {
                await fs.promises.rename(backupRoot, snapshotRoot).catch(() => undefined);
            }
            throw error;
        }
        if (movedExistingSnapshot) {
            await fs.promises.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
        }
        return { snapshotRoot, summaryPath: path.join(snapshotRoot, 'SNAPSHOT_SUMMARY.md') };
    } catch (error) {
        await fs.promises.rm(workingRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

async function readSnapshotBlobs(
    gitService: SnapshotGitService,
    ref: string,
    filePaths: string[],
    signal?: AbortSignal
): Promise<Map<string, Buffer | null>> {
    throwIfAborted(signal);
    if (gitService.readBlobs) {
        return gitService.readBlobs(ref, filePaths, signal);
    }
    const contents = await Promise.all(filePaths.map(filePath => gitService.getFileContentAtRef(ref, filePath)));
    throwIfAborted(signal);
    return new Map(filePaths.map((filePath, index) => [filePath, contents[index] === null ? null : Buffer.from(contents[index]!, 'utf8')]));
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

async function writeSnapshotFile(rootFolder: string, filePath: string, content: Buffer): Promise<void> {
    const normalizedPath = filePath.replace(/[\\/]+/g, path.sep);
    const destinationPath = path.join(rootFolder, normalizedPath);
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.writeFile(destinationPath, content);
}
