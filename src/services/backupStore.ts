import { GitService } from './gitService';
import { mapWithConcurrency } from '../utils/concurrency';

export interface RestoreBackup {
    /** File content before the first action (null = the file did not exist). */
    content: Buffer | null;
    /** File content right after the last action, used to detect edits made since then. */
    revertedToContent: Buffer | null;
    /** Whether the file had staged changes before the first action, so restoring puts the index back too. */
    wasStaged: boolean;
}

export interface RestoreEntry {
    filePath: string;
    backup: RestoreBackup;
}

/**
 * Keeps the previous state of files changed by "Use <branch>" and "Revert", so "Restore Changes"
 * can undo them. Shared by the single-view panels and the separate diff tabs, and kept while
 * VS Code is open.
 */
export class BackupStore {
    private readonly backups = new Map<string, RestoreBackup>();

    private key(repoPath: string, filePath: string): string {
        return `${repoPath}\0${filePath}`;
    }

    has(repoPath: string, filePath: string): boolean {
        return this.backups.has(this.key(repoPath, filePath));
    }

    /** Repository-relative paths that can be restored in a repository. */
    paths(repoPath: string): string[] {
        const prefix = `${repoPath}\0`;
        return Array.from(this.backups.keys()).filter(key => key.startsWith(prefix)).map(key => key.substring(prefix.length));
    }

    /**
     * Runs `action` (one batched Git operation) and records a backup for every file whose content or
     * staged state changed. Returns how many files changed.
     */
    async apply(
        git: GitService,
        paths: string[],
        action: () => Promise<void>,
        report: (message: string) => void = () => undefined,
        reportFiles?: (phase: string, done: number, total: number) => void
    ): Promise<number> {
        report(`saving a backup of ${paths.length} file${paths.length === 1 ? '' : 's'}...`);
        const stagedBefore = new Set((await git.getStatus()).staged);
        let read = 0;
        reportFiles?.('Saving backup', 0, paths.length);
        const before = await git.readWorkingTreeBuffers(paths, undefined, () => {
            read++;
            if (read % 100 === 0 || read === paths.length) {
                reportFiles?.('Saving backup', read, paths.length);
            }
        });

        report('updating files...');
        reportFiles?.('Updating files', 0, paths.length);
        await action();
        reportFiles?.('Updating files', paths.length, paths.length);

        report('checking the result...');
        read = 0;
        const after = await git.readWorkingTreeBuffers(paths, undefined, () => {
            read++;
            if (read % 100 === 0 || read === paths.length) {
                reportFiles?.('Checking files', read, paths.length);
            }
        });
        const stagedAfter = new Set((await git.getStatus()).staged);

        let changed = 0;
        for (const [index, filePath] of paths.entries()) {
            const beforeContent = before.get(filePath) ?? null;
            const afterContent = after.get(filePath) ?? null;
            if (buffersEqual(beforeContent, afterContent) && stagedBefore.has(filePath) === stagedAfter.has(filePath)) {
                continue;
            }
            // Keep the oldest backup: acting twice must still restore the user's original state.
            const key = this.key(git.getRepoPath(), filePath);
            const previous = this.backups.get(key);
            this.backups.set(key, {
                content: previous ? previous.content : beforeContent,
                revertedToContent: afterContent,
                wasStaged: previous ? previous.wasStaged : stagedBefore.has(filePath)
            });
            changed++;
            if ((index + 1) % 100 === 0 || index + 1 === paths.length) {
                reportFiles?.('Checking files', index + 1, paths.length);
            }
        }
        return changed;
    }

    /** The restorable entries among `paths`, and which of them were edited after the last action. */
    async inspect(git: GitService, paths: string[]): Promise<{ entries: RestoreEntry[]; editedSince: Set<string> }> {
        const entries = paths.flatMap(filePath => {
            const backup = this.backups.get(this.key(git.getRepoPath(), filePath));
            return backup ? [{ filePath, backup }] : [];
        });
        const current = await git.readWorkingTreeBuffers(entries.map(entry => entry.filePath));
        const editedSince = new Set(entries
            .filter(entry => !buffersEqual(current.get(entry.filePath) ?? null, entry.backup.revertedToContent))
            .map(entry => entry.filePath));
        return { entries, editedSince };
    }

    /** Puts content and staging state back as they were before the first action, then forgets the backups. */
    async restore(
        git: GitService,
        entries: RestoreEntry[],
        report: (message: string) => void = () => undefined,
        reportFiles?: (phase: string, done: number, total: number) => void
    ): Promise<void> {
        report('writing files...');
        let written = 0;
        reportFiles?.('Restoring files', 0, entries.length);
        await mapWithConcurrency(entries, 32, async entry => {
            await git.writeWorkingTreeBuffer(entry.filePath, entry.backup.content);
            written++;
            if (written % 100 === 0 || written === entries.length) {
                reportFiles?.('Restoring files', written, entries.length);
            }
        });
        report('updating the staging area...');
        await git.stageFiles(entries.filter(entry => entry.backup.wasStaged).map(entry => entry.filePath));
        // Fails harmlessly in a repository without commits.
        await git.unstageFiles(entries.filter(entry => !entry.backup.wasStaged).map(entry => entry.filePath)).catch(() => undefined);
        entries.forEach(entry => this.backups.delete(this.key(git.getRepoPath(), entry.filePath)));
    }
}

/** Single store for the whole extension, so a change made in a diff tab can be restored from a panel and vice versa. */
export const backupStore = new BackupStore();

function buffersEqual(left: Buffer | null, right: Buffer | null): boolean {
    if (left === null || right === null) {
        return left === right;
    }
    return left.equals(right);
}
