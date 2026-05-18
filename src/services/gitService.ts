import simpleGit, { SimpleGit } from 'simple-git';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export enum DriftStatus {
    IDENTICAL = 'IDENTICAL',
    MODIFIED = 'MODIFIED',
    MISSING_IN_CURRENT_BRANCH = 'MISSING_IN_CURRENT_BRANCH',
    EXTRA_IN_CURRENT_BRANCH = 'EXTRA_IN_CURRENT_BRANCH',
    RENAMED = 'RENAMED',
    DELETED = 'DELETED'
}

export interface DriftFile {
    path: string;
    commitBlobHash: string | null;
    currentBlobHash: string | null;
    status: DriftStatus;
    originalPath?: string;
    addedLines?: number;
    removedLines?: number;
    patch?: string;
}

export interface DriftResult {
    commitSha: string;
    commitMessage: string;
    files: DriftFile[];
    comparedTo: string;
}

export interface ChangedFile {
    path: string;
    status: string;
}

export class GitService {
    private git: SimpleGit;
    private _repoPath: string;

    constructor(repoPath: string) {
        this._repoPath = repoPath;
        this.git = simpleGit({ baseDir: repoPath, binary: 'git', maxConcurrentProcesses: 6 });
    }

    getRepoPath(): string {
        return this._repoPath;
    }

    /**
     * Check if a commit is a merge commit (has more than one parent)
     */
    async isMergeCommit(sha: string): Promise<boolean> {
        const parents = await this.getCommitParents(sha);
        return parents.length > 1;
    }

    /**
     * Get all parent SHAs of a commit
     */
    async getCommitParents(sha: string): Promise<string[]> {
        const result = await this.git.raw(['rev-list', '--parents', '--format=%P', '-n', '1', sha]);
        const lines = result.trim().split('\n');
        if (lines.length < 2) return [];

        const parentLine = lines[1].trim();
        if (!parentLine) return [];
        return parentLine.split(' ').filter(s => s.length > 0);
    }

    /**
     * Get the first parent of a commit (^1)
     */
    async getFirstParent(sha: string): Promise<string> {
        const parents = await this.getCommitParents(sha);
        return parents[0] || '';
    }

    /**
     * Get commit message
     */
    async getCommitMessage(sha: string): Promise<string> {
        return this.git.show(['--format=%s', '-s', sha]);
    }

    /**
     * Get files changed in a specific commit.
     * For merge commits, correctly handles the diff between first parent and the merge.
     */
    async getChangedFilesInCommit(sha: string): Promise<ChangedFile[]> {
        const isMerge = await this.isMergeCommit(sha);

        if (isMerge) {
            // For merge commits, get files changed between first parent and the merge
            const firstParent = await this.getFirstParent(sha);
            const result = await this.git.raw(['diff', `${firstParent}`, sha, '--name-status']);
            return this.parseNameStatus(result);
        } else {
            // For regular commits, use the standard approach
            const result = await this.git.raw(['diff', `${sha}^`, sha, '--name-status']);
            return this.parseNameStatus(result);
        }
    }

    /**
     * Parse git --name-status output into structured data
     */
    private parseNameStatus(output: string): ChangedFile[] {
        const files: ChangedFile[] = [];
        const lines = output.trim().split('\n');

        for (const line of lines) {
            if (!line.trim()) continue;
            const parts = line.split('\t');
            if (parts.length >= 2) {
                files.push({
                    status: parts[0],
                    path: parts[1]
                });
            }
        }

        return files;
    }

    /**
     * Get blob hash for a file at a specific commit/branch
     */
    async getBlobHash(commitish: string, filePath: string): Promise<string | null> {
        try {
            const result = await this.git.raw(['rev-parse', `${commitish}:${filePath}`]);
            return result.trim() || null;
        } catch {
            return null;
        }
    }

    /**
     * Check if a file is binary
     */
    async isBinaryFile(commitish: string, filePath: string): Promise<boolean> {
        try {
            const result = await this.git.raw(['show', '--text', `${commitish}:${filePath}`]);
            return false;
        } catch {
            return true;
        }
    }

    /**
     * Get file content from a specific commit/branch
     */
    async getFileContent(commitish: string, filePath: string): Promise<string | null> {
        try {
            const content = await this.git.show([`${commitish}:${filePath}`]);
            return content;
        } catch {
            return null;
        }
    }

    /**
     * Write content to the working tree
     */
    async writeToWorkingTree(filePath: string, content: string): Promise<void> {
        const fullPath = this._repoPath + '/' + filePath;
        const fs = await import('fs');

        // Ensure directory exists
        const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
        await fs.promises.mkdir(dir, { recursive: true });

        await fs.promises.writeFile(fullPath, content, { encoding: 'utf8' });
    }

    /**
     * Get file content from working tree (real disk state, including unstaged changes)
     */
    async getWorkingTreeContent(filePath: string): Promise<string | null> {
        const fullPath = this._repoPath + '/' + filePath;
        const fs = await import('fs');
        try {
            return await fs.promises.readFile(fullPath, 'utf8');
        } catch {
            return null;
        }
    }

    /**
     * Delete a file from working tree
     */
    async deleteFile(filePath: string): Promise<void> {
        const fullPath = this._repoPath + '/' + filePath;
        const fs = await import('fs');
        try {
            await fs.promises.unlink(fullPath);
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    /**
     * Stage a file
     */
    async stageFile(filePath: string): Promise<void> {
        await this.git.add(filePath);
    }

    /**
     * Unstage a file
     */
    async unstageFile(filePath: string): Promise<void> {
        await this.git.reset(['HEAD', '--', filePath]);
    }

    /**
     * Determine drift status by comparing blob hashes
     */
    determineDriftStatus(
        commitBlobHash: string | null,
        currentBlobHash: string | null,
        changeType: string
    ): DriftStatus {
        // File was added in commit (A)
        if (changeType === 'A') {
            if (currentBlobHash === null) {
                return DriftStatus.DELETED;
            }
            return DriftStatus.EXTRA_IN_CURRENT_BRANCH;
        }

        // File was deleted in commit (D)
        if (changeType === 'D') {
            if (commitBlobHash !== null && currentBlobHash === null) {
                return DriftStatus.MISSING_IN_CURRENT_BRANCH;
            }
            if (commitBlobHash === null && currentBlobHash !== null) {
                return DriftStatus.EXTRA_IN_CURRENT_BRANCH;
            }
            return DriftStatus.DELETED;
        }

        // File was modified or renamed (M, R)
        if (commitBlobHash === null && currentBlobHash !== null) {
            return DriftStatus.MISSING_IN_CURRENT_BRANCH;
        }

        if (commitBlobHash !== null && currentBlobHash === null) {
            return DriftStatus.EXTRA_IN_CURRENT_BRANCH;
        }

        if (commitBlobHash === currentBlobHash) {
            return DriftStatus.IDENTICAL;
        }

        if (changeType === 'R' || changeType === 'C') {
            return DriftStatus.RENAMED;
        }

        return DriftStatus.MODIFIED;
    }

    /**
     * Get diff stats between commit and working tree (HEAD staged/index)
     */
    async getDiffStats(commitSha: string, filePath: string): Promise<{ added: number; removed: number }> {
        let tempDir: string | null = null;
        try {
            const commitContent = await this.getFileContent(commitSha, filePath);
            const workingTreeContent = await this.getWorkingTreeContent(filePath);

            if (commitContent === null && workingTreeContent === null) {
                return { added: 0, removed: 0 };
            }

            tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gitgg-diff-'));
            const beforePath = path.join(tempDir, 'before.txt');
            const afterPath = path.join(tempDir, 'after.txt');
            await fs.promises.writeFile(beforePath, commitContent ?? '', 'utf8');
            await fs.promises.writeFile(afterPath, workingTreeContent ?? '', 'utf8');

            const result = await this.git.raw(['diff', '--no-index', '--numstat', beforePath, afterPath]);
            const parts = result.trim().split('\t');
            if (parts.length >= 2) {
                const added = parseInt(parts[0], 10) || 0;
                const removed = parseInt(parts[1], 10) || 0;
                return { added, removed };
            }
        } catch {
            // ignore
        } finally {
            if (tempDir) {
                await fs.promises.rm(tempDir, { recursive: true, force: true });
            }
        }
        return { added: 0, removed: 0 };
    }

    /**
     * Get unified diff between commit and working tree for a file
     * Uses the same approach as main.js multi-file comparison
     */
    async getUnifiedDiff(commitSha: string, filePath: string): Promise<string> {
        try {
            // Get diff between commit blob and working tree file
            const result = await this.git.raw([
                'diff',
                '--unified=3',
                `${commitSha}:${filePath}`,
                '--',
                `${this._repoPath}/${filePath}`
            ]);
            return result;
        } catch (error) {
            // Fallback - generate diff from content
            return await this.generateFallbackDiff(commitSha, filePath);
        }
    }

    private async generateFallbackDiff(commitSha: string, filePath: string): Promise<string> {
        try {
            const commitContent = await this.getFileContent(commitSha, filePath);
            const workingTreeContent = await this.getWorkingTreeContent(filePath);
            if (commitContent === null && workingTreeContent === null) return '';

            const crypto = await import('crypto');
            const hashContent = (content: string) =>
                crypto.createHash('sha1').update(content, 'utf8').digest('hex').substring(0, 7);

            const safePath = filePath.replace(/\\/g, '/');

            if (commitContent === null) {
                const h = await hashContent(workingTreeContent ?? '');
                const lines = (workingTreeContent ?? '').split('\n');
                return `diff --git a/${safePath} b/${safePath}\nnew file mode 100644\nindex 0000000..${h}\n--- /dev/null\n+++ b/${safePath}\n@@ -0,0 +${lines.length} @@\n${lines.map(l => '+' + l).join('\n')}`;
            }
            if (workingTreeContent === null) {
                const h = await hashContent(commitContent ?? '');
                const lines = (commitContent ?? '').split('\n');
                return `diff --git a/${safePath} b/${safePath}\ndeleted file mode 100644\nindex ${h}..0000000\n--- a/${safePath}\n+++ /dev/null\n@@ -${lines.length},0 +0,0 @@\n${lines.map(l => '-' + l).join('\n')}`;
            }

            // Both exist - generate simple unified diff
            const oldLines = (commitContent ?? '').split('\n');
            const newLines = (workingTreeContent ?? '').split('\n');
            const oldHash = await hashContent(commitContent ?? '');
            const newHash = await hashContent(workingTreeContent ?? '');
            let diff = `diff --git a/${safePath} b/${safePath}\nindex ${oldHash}..${newHash} 100644\n--- a/${safePath}\n+++ b/${safePath}\n`;

            const maxLines = Math.max(oldLines.length, newLines.length);
            for (let i = 0; i < maxLines; i++) {
                const o = oldLines[i] ?? '';
                const n = newLines[i] ?? '';
                if (o === n) {
                    diff += ` ${o}\n`;
                } else {
                    if (o) diff += `-${o}\n`;
                    if (n) diff += `+${n}\n`;
                }
            }
            return diff;
        } catch {
            return '';
        }
    }

    /**
     * Detect drift between a commit and current working tree (not HEAD)
     */
    async detectDrift(commitSha: string): Promise<DriftResult> {
        const changedFiles = await this.getChangedFilesInCommit(commitSha);
        const commitMessage = await this.getCommitMessage(commitSha);

        const driftFiles: DriftFile[] = [];

        for (const file of changedFiles) {
            const commitHash = await this.getBlobHash(commitSha, file.path);
            const workingTreeContent = await this.getWorkingTreeContent(file.path);
            const normalizedContent = workingTreeContent?.replace(/\r\n/g, '\n');
            const currentHash = normalizedContent !== undefined
                ? crypto.createHash('sha1').update(normalizedContent, 'utf8').digest('hex')
                : null;
            const status = this.determineDriftStatus(commitHash, currentHash, file.status);
            const diffStats = await this.getDiffStats(commitSha, file.path);
            const patch = await this.getUnifiedDiff(commitSha, file.path);

            driftFiles.push({
                path: file.path,
                commitBlobHash: commitHash,
                currentBlobHash: currentHash,
                status,
                addedLines: diffStats.added,
                removedLines: diffStats.removed,
                patch
            });
        }

        return {
            commitSha,
            commitMessage: commitMessage.trim(),
            files: driftFiles,
            comparedTo: 'Working Tree'
        };
    }

    /**
     * Get current branch name
     */
    async getCurrentBranch(): Promise<string> {
        const branches = await this.git.branchLocal();
        return branches.current;
    }

    /**
     * Get all branch names
     */
    async getAllBranches(): Promise<string[]> {
        const branches = await this.git.branchLocal();
        return branches.all;
    }

    /**
     * Check if current HEAD is behind/ahead of a branch
     */
    async getBranchDiff(baseBranch: string): Promise<{ ahead: number; behind: number }> {
        try {
            const result = await this.git.raw(['rev-list', '--left-right', '--count', `${baseBranch}...HEAD`]);
            const [ahead, behind] = result.trim().split('\t').map(n => parseInt(n, 10) || 0);
            return { ahead, behind };
        } catch {
            return { ahead: 0, behind: 0 };
        }
    }
}
