import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildPatch, ChangeKind, classifyChange, parseNameStatus, NameStatusEntry } from '../utils/patch';
import { createAbortError, mapWithConcurrency, throwIfAborted, yieldToEventLoop } from '../utils/concurrency';

/** Parallel file system reads; high enough to be fast, low enough to avoid "too many open files". */
const FS_CONCURRENCY = 32;

/** Hash of Git's empty tree, used as the "parent" of a root commit. */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface FileComparison {
    path: string;
    kind: ChangeKind;
    /** Content at the base ref (branch/commit); null when the file does not exist there. */
    baseContent: string | null;
    /** Content on disk; null when the file does not exist in the working tree. */
    localContent: string | null;
    patch: string;
}

export interface CompareOptions {
    /** Aborting stops the comparison (Git processes are killed) and rejects with an AbortError. */
    signal?: AbortSignal;
    /** Called while files are processed, to show "x of y" progress. */
    onProgress?: (done: number, total: number, phase: string) => void;
}

export interface ResolvedRef {
    ref: string;
    /** Set when the remote could not be fetched and the comparison may use stale data. */
    warning?: string;
}

export interface CommitSummary {
    sha: string;
    subject: string;
}

export class GitService {
    private git: SimpleGit;
    private readonly repoPath: string;

    constructor(repoPath: string) {
        this.repoPath = repoPath;
        this.git = simpleGit({ baseDir: repoPath, binary: 'git', maxConcurrentProcesses: 6 });
    }

    /**
     * Returns the root of the Git repository that contains `startPath` (a file or folder),
     * or undefined when it is not inside a repository.
     */
    static async findRepoRoot(startPath: string): Promise<string | undefined> {
        let dir = startPath;
        // The path may point to a deleted file or folder; walk up until something exists.
        while (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            const parent = path.dirname(dir);
            if (parent === dir) {
                return undefined;
            }
            dir = parent;
        }

        try {
            const root = await simpleGit({ baseDir: dir }).revparse(['--show-toplevel']);
            return root.trim() ? path.normalize(root.trim()) : undefined;
        } catch {
            return undefined;
        }
    }

    getRepoPath(): string {
        return this.repoPath;
    }

    /** Converts an absolute path to a repository-relative path with forward slashes. */
    toRelativePath(absolutePath: string): string {
        return path.relative(this.repoPath, absolutePath).replace(/\\/g, '/');
    }

    toAbsolutePath(relativePath: string): string {
        return path.join(this.repoPath, relativePath);
    }

    // ---------- Refs and branches ----------

    async getCurrentBranch(): Promise<string> {
        const branches = await this.git.branchLocal();
        return branches.current;
    }

    /** Local branches plus branches that only exist on `origin`, without duplicates. */
    async getBranches(): Promise<string[]> {
        const output = await this.git.raw(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin']);
        const names = new Set<string>();
        for (const ref of output.split('\n').map(line => line.trim()).filter(Boolean)) {
            if (ref.startsWith('refs/heads/')) {
                names.add(ref.substring('refs/heads/'.length));
            } else if (ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD') {
                names.add(ref.substring('refs/remotes/origin/'.length));
            }
        }
        return Array.from(names);
    }

    async refExists(ref: string): Promise<boolean> {
        try {
            // With --quiet Git exits non-zero without writing to stderr, which simple-git does not treat
            // as an error, so the empty output is what signals a missing ref.
            const sha = await this.git.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
            return sha.trim().length > 0;
        } catch {
            return false;
        }
    }

    /**
     * Picks the best ref for a branch: `origin/<branch>` when it exists (optionally fetching it first),
     * otherwise the local branch.
     */
    async resolveBranchRef(branch: string, fetchFirst: boolean): Promise<ResolvedRef> {
        let fetchFailed = false;
        if (fetchFirst) {
            const remotes = await this.git.getRemotes();
            if (remotes.some(remote => remote.name === 'origin')) {
                try {
                    await this.git.fetch('origin', branch);
                } catch {
                    fetchFailed = true;
                }
            }
        }

        if (await this.refExists(`refs/remotes/origin/${branch}`)) {
            return {
                ref: `origin/${branch}`,
                warning: fetchFailed ? `Could not fetch '${branch}' from origin. Using the last fetched version, which may be outdated.` : undefined
            };
        }
        return { ref: branch };
    }

    async getCommitSha(ref: string): Promise<string> {
        const result = await this.git.raw(['rev-parse', '--verify', `${ref}^{commit}`]);
        return result.trim();
    }

    async getCommitMessage(sha: string): Promise<string> {
        const message = await this.git.show(['--format=%s', '-s', sha]);
        return message.trim();
    }

    async getRecentCommits(ref: string, limit: number): Promise<CommitSummary[]> {
        const output = await this.git.raw(['log', '--format=%H%x00%s', '-n', String(limit), ref, '--']);
        return output.split('\n')
            .filter(line => line.includes('\0'))
            .map(line => {
                const [sha, subject] = line.split('\0');
                return { sha: sha.trim(), subject: subject.trim() };
            });
    }

    // ---------- File contents ----------

    /** Text content of a file at a ref, or null if it does not exist there. */
    async getFileContent(ref: string, filePath: string): Promise<string | null> {
        if (!ref) {
            return null;
        }
        try {
            return await this.git.show([`${ref}:${filePath}`]);
        } catch {
            return null;
        }
    }

    /** Alias kept for snapshot export. */
    async getFileContentAtRef(ref: string, filePath: string): Promise<string | null> {
        return this.getFileContent(ref, filePath);
    }

    /** Raw bytes of a file at a ref (safe for binary files), or null if it does not exist there. */
    async getFileBuffer(ref: string, filePath: string): Promise<Buffer | null> {
        try {
            return await this.git.binaryCatFile(['blob', `${ref}:${filePath}`]);
        } catch {
            return null;
        }
    }

    /**
     * Reads many blobs (`ref:path`) with a single `git cat-file --batch` process.
     * Returns null for paths that do not exist at `ref` (or are not files).
     */
    async readBlobs(ref: string, filePaths: string[], signal?: AbortSignal): Promise<Map<string, Buffer | null>> {
        const result = new Map<string, Buffer | null>();
        if (filePaths.length === 0) {
            return result;
        }
        const output = await this.runGit(['cat-file', '--batch'], filePaths.map(filePath => `${ref}:${filePath}\n`).join(''), signal);

        let offset = 0;
        for (const filePath of filePaths) {
            const lineEnd = output.indexOf(0x0a, offset);
            const header = output.toString('utf8', offset, lineEnd);
            offset = lineEnd + 1;
            if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
                result.set(filePath, null);
                continue;
            }
            const [, type, sizeText] = header.split(' ');
            const size = parseInt(sizeText, 10);
            result.set(filePath, type === 'blob' ? output.subarray(offset, offset + size) : null);
            offset += size + 1; // content is followed by a newline
        }
        return result;
    }

    /** Reads many working tree files in parallel; null for files that do not exist. */
    async readWorkingTreeBuffers(filePaths: string[], signal?: AbortSignal, onEach?: () => void): Promise<Map<string, Buffer | null>> {
        const buffers = await mapWithConcurrency(filePaths, FS_CONCURRENCY, async filePath => {
            const buffer = await this.readWorkingTreeBuffer(filePath);
            onEach?.();
            return buffer;
        }, signal);
        return new Map(filePaths.map((filePath, index) => [filePath, buffers[index]]));
    }

    async getWorkingTreeContent(filePath: string): Promise<string | null> {
        try {
            return await fs.promises.readFile(this.toAbsolutePath(filePath), 'utf8');
        } catch {
            return null;
        }
    }

    async readWorkingTreeBuffer(filePath: string): Promise<Buffer | null> {
        try {
            return await fs.promises.readFile(this.toAbsolutePath(filePath));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    /** Writes (or deletes, when `content` is null) a file in the working tree. */
    async writeWorkingTreeBuffer(filePath: string, content: Buffer | null): Promise<void> {
        const fullPath = this.toAbsolutePath(filePath);
        if (content === null) {
            await fs.promises.rm(fullPath, { force: true });
            return;
        }
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.promises.writeFile(fullPath, content);
    }

    // ---------- Comparison ----------

    /** Compares each file at `baseRef` with its current content on disk. */
    async compareWithWorkingTree(baseRef: string, filePaths: string[], options: CompareOptions = {}): Promise<FileComparison[]> {
        const { signal, onProgress } = options;
        const uniquePaths = Array.from(new Set(filePaths));
        const total = uniquePaths.length;

        let read = 0;
        onProgress?.(0, total, 'Reading files');
        const [baseBlobs, localBuffers] = await Promise.all([
            this.readBlobs(baseRef, uniquePaths, signal),
            this.readWorkingTreeBuffers(uniquePaths, signal, () => {
                read++;
                if (read % 100 === 0 || read === total) {
                    onProgress?.(read, total, 'Reading files');
                }
            })
        ]);

        const result: FileComparison[] = [];
        for (const [index, filePath] of uniquePaths.entries()) {
            if (index % 200 === 0) {
                // Building diffs is synchronous: yield so progress and cancellation stay responsive.
                throwIfAborted(signal);
                onProgress?.(index, total, 'Comparing');
                await yieldToEventLoop();
            }
            const baseContent = baseBlobs.get(filePath)?.toString('utf8') ?? null;
            const localContent = localBuffers.get(filePath)?.toString('utf8') ?? null;
            result.push({
                path: filePath,
                kind: classifyChange(baseContent, localContent),
                baseContent,
                localContent,
                patch: buildPatch(filePath, baseContent, localContent)
            });
        }
        onProgress?.(total, total, 'Comparing');
        return result;
    }

    /** Files touched by a commit, compared with its first parent (works for merges and root commits). */
    async getChangedFilesInCommit(sha: string): Promise<NameStatusEntry[]> {
        const parents = (await this.git.raw(['rev-list', '--parents', '-n', '1', sha])).trim().split(/\s+/).slice(1);
        const base = parents[0] ?? EMPTY_TREE_SHA;
        const output = await this.git.raw(['diff', '--name-status', '-M', base, sha]);
        return parseNameStatus(output);
    }

    async getChangedFilesBetweenRefs(fromRef: string, toRef: string): Promise<string[]> {
        // Keep both paths of a rename so callers can represent it as a deletion plus an addition.
        const output = await this.git.raw(['diff', '--name-only', '--no-renames', fromRef, toRef]);
        return output.split('\n').map(line => line.trim()).filter(Boolean);
    }

    // ---------- Index / working tree operations ----------

    async getStatus(): Promise<StatusResult> {
        return this.git.status();
    }

    /** Stages files exactly as they are on disk (including deletions). */
    async stageFiles(filePaths: string[]): Promise<void> {
        await this.runWithPathspecs(['add', '-A'], filePaths);
    }

    async unstageFiles(filePaths: string[]): Promise<void> {
        await this.runWithPathspecs(['reset', '-q', 'HEAD'], filePaths);
    }

    /**
     * Brings the version of each file from `ref` into the working tree and stages it
     * (files that do not exist at `ref` are deleted and the deletion is staged).
     */
    async takeFilesFromRef(ref: string, filePaths: string[]): Promise<void> {
        await this.checkoutFromRef(ref, filePaths);
    }

    /**
     * Puts files back exactly as they are in the current branch (HEAD), discarding staged and
     * unstaged changes. Files that do not exist in HEAD are removed from the index and deleted.
     */
    async revertToHead(filePaths: string[]): Promise<void> {
        await this.checkoutFromRef('HEAD', filePaths);
    }

    /** `git checkout <ref> -- files` for files that exist at `ref`; the others are removed. */
    private async checkoutFromRef(ref: string, filePaths: string[]): Promise<void> {
        if (filePaths.length === 0) {
            return;
        }
        const existing = await this.existingAtRef(ref, filePaths);
        await this.runWithPathspecs(['checkout', ref], filePaths.filter(filePath => existing.has(filePath)));

        const missing = filePaths.filter(filePath => !existing.has(filePath));
        await this.runWithPathspecs(['rm', '-q', '--cached', '--ignore-unmatch'], missing);
        await mapWithConcurrency(missing, FS_CONCURRENCY, filePath => fs.promises.rm(this.toAbsolutePath(filePath), { force: true }));
    }

    /** Which of the paths exist as files at `ref` (one `git cat-file --batch-check` process). */
    private async existingAtRef(ref: string, filePaths: string[]): Promise<Set<string>> {
        const output = (await this.runGit(['cat-file', '--batch-check'], filePaths.map(filePath => `${ref}:${filePath}\n`).join(''))).toString('utf8');
        const lines = output.split('\n');
        return new Set(filePaths.filter((_filePath, index) => lines[index]?.split(' ')[1] === 'blob'));
    }

    /**
     * Runs a Git command on many paths at once. Paths are passed through stdin (NUL-separated),
     * which avoids the command line length limit on Windows and handles any file name;
     * `--literal-pathspecs` stops names such as `file[1].txt` from being treated as globs.
     */
    private async runWithPathspecs(args: string[], filePaths: string[]): Promise<void> {
        if (filePaths.length > 0) {
            await this.runGit(['--literal-pathspecs', ...args, '--pathspec-from-file=-', '--pathspec-file-nul'], filePaths.join('\0'));
        }
    }

    private runGit(args: string[], input: string, signal?: AbortSignal): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(createAbortError());
                return;
            }
            const child = spawn('git', args, { cwd: this.repoPath, windowsHide: true });
            const onAbort = () => {
                child.kill();
                reject(createAbortError());
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            child.on('close', () => signal?.removeEventListener('abort', onAbort));
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
            child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
            child.on('error', reject);
            child.on('close', code => {
                if (code === 0) {
                    resolve(Buffer.concat(stdout));
                } else {
                    const message = Buffer.concat(stderr).toString('utf8').trim();
                    reject(new Error(message || `git ${args.join(' ')} failed with exit code ${code}`));
                }
            });
            child.stdin.end(input);
        });
    }
}
