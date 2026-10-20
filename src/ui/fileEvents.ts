import * as vscode from 'vscode';
import { GitService } from '../services/gitService';

export interface FilesChangedEvent {
    repoPath: string;
    /** Repository-relative paths whose content or staging state may have changed. */
    paths: string[];
    /** Who made the change, so it can ignore its own event. */
    source: unknown;
}

const emitter = new vscode.EventEmitter<FilesChangedEvent>();

/** Fired after Gitgg changes files (from a panel or a diff tab), so open panels and diff tabs stay in sync. */
export const onDidChangeFiles = emitter.event;

export function fireFilesChanged(event: FilesChangedEvent): void {
    emitter.fire(event);
}

/**
 * Saves open editors with unsaved edits for these files, so Git operations work on what the user sees
 * (and backups include those edits) instead of overwriting them.
 */
export async function saveDirtyDocuments(git: GitService, paths: string[]): Promise<void> {
    const wanted = new Set(paths);
    const dirty = vscode.workspace.textDocuments.filter(document =>
        document.isDirty && document.uri.scheme === 'file' && wanted.has(git.toRelativePath(document.uri.fsPath)));
    await Promise.all(dirty.map(document => document.save()));
}
