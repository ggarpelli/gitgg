import simpleGit, { SimpleGit } from 'simple-git';

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
     * Detect drift between a commit and current HEAD
     */
    async detectDrift(commitSha: string): Promise<DriftResult> {
        const changedFiles = await this.getChangedFilesInCommit(commitSha);
        const commitMessage = await this.getCommitMessage(commitSha);

        const driftFiles: DriftFile[] = [];

        for (const file of changedFiles) {
            const commitHash = await this.getBlobHash(commitSha, file.path);
            const currentHash = await this.getBlobHash('HEAD', file.path);
            const status = this.determineDriftStatus(commitHash, currentHash, file.status);

            driftFiles.push({
                path: file.path,
                commitBlobHash: commitHash,
                currentBlobHash: currentHash,
                status
            });
        }

        return {
            commitSha,
            commitMessage: commitMessage.trim(),
            files: driftFiles,
            comparedTo: 'HEAD'
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
