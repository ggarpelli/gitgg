import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { GitService } from '../../services/gitService';
import { isAbortError } from '../../utils/concurrency';

suite('GitService (real repository)', function () {
    this.timeout(30000);

    let repoPath: string;
    let git: SimpleGit;
    let service: GitService;

    const write = (relativePath: string, content: string) => {
        const fullPath = path.join(repoPath, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
    };
    const commit = async (message: string) => {
        await git.add(['-A']);
        await git.commit(message);
        return (await git.revparse(['HEAD'])).trim();
    };

    setup(async () => {
        repoPath = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gitgg-repo-')));
        git = simpleGit(repoPath);
        await git.init();
        await git.addConfig('user.name', 'Gitgg Test');
        await git.addConfig('user.email', 'test@example.com');
        await git.addConfig('core.autocrlf', 'false');
        service = new GitService(repoPath);
    });

    teardown(() => {
        fs.rmSync(repoPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    test('findRepoRoot finds the root from a nested (even missing) path', async () => {
        write('a/b/file.txt', 'x');
        const root = await GitService.findRepoRoot(path.join(repoPath, 'a', 'b', 'missing', 'file.txt'));
        assert.strictEqual(root?.toLowerCase(), path.normalize(repoPath).toLowerCase());
    });

    test('drift reports identical files as unchanged (regression: blob hash vs plain hash)', async () => {
        write('same.txt', 'hello\n');
        write('edited.txt', 'v1\n');
        const sha = await commit('first');
        write('edited.txt', 'v2\n');

        const files = await service.getChangedFilesInCommit(sha);
        const result = await service.compareWithWorkingTree(sha, files.map(file => file.path));
        const kinds = Object.fromEntries(result.map(file => [file.path, file.kind]));
        assert.deepStrictEqual(kinds, { 'edited.txt': 'changed', 'same.txt': 'unchanged' });
    });

    test('getChangedFilesInCommit works for the root commit and for renames', async () => {
        write('old-name.txt', 'line 1\nline 2\nline 3\n');
        const root = await commit('root');
        assert.deepStrictEqual(await service.getChangedFilesInCommit(root), [{ status: 'A', path: 'old-name.txt' }]);

        await git.mv('old-name.txt', 'new-name.txt');
        const renamed = await commit('rename');
        assert.deepStrictEqual(await service.getChangedFilesInCommit(renamed), [
            { status: 'R', path: 'new-name.txt', originalPath: 'old-name.txt' }
        ]);
    });

    test('compareWithWorkingTree classifies untracked and deleted files', async () => {
        write('tracked.txt', 'a\n');
        const sha = await commit('base');
        fs.unlinkSync(path.join(repoPath, 'tracked.txt'));
        write('untracked.txt', 'new\n');

        const result = await service.compareWithWorkingTree(sha, ['tracked.txt', 'untracked.txt']);
        const kinds = Object.fromEntries(result.map(file => [file.path, file.kind]));
        assert.deepStrictEqual(kinds, { 'tracked.txt': 'deleted', 'untracked.txt': 'added' });
    });

    test('stageFiles stages the file as it is on disk (does not overwrite it)', async () => {
        write('file.txt', 'base\n');
        await commit('base');
        write('file.txt', 'my local work\n');

        await service.stageFiles(['file.txt']);

        assert.strictEqual(fs.readFileSync(path.join(repoPath, 'file.txt'), 'utf8'), 'my local work\n');
        assert.deepStrictEqual((await service.getStatus()).staged, ['file.txt']);

        await service.unstageFiles(['file.txt']);
        assert.deepStrictEqual((await service.getStatus()).staged, []);
    });

    test('takeFileFromRef brings the other branch version (or its deletion) and stages it', async () => {
        write('shared.txt', 'main version\n');
        write('only-main.txt', 'main only\n');
        await commit('main');
        await git.checkoutLocalBranch('feature');
        write('shared.txt', 'feature version\n');
        fs.unlinkSync(path.join(repoPath, 'only-main.txt'));
        write('only-feature.txt', 'feature only\n');
        await commit('feature');
        const mainRef = (await git.raw(['rev-parse', 'HEAD~1'])).trim();

        await service.takeFilesFromRef(mainRef, ['shared.txt', 'only-main.txt', 'only-feature.txt']);

        assert.strictEqual(fs.readFileSync(path.join(repoPath, 'shared.txt'), 'utf8'), 'main version\n');
        assert.strictEqual(fs.readFileSync(path.join(repoPath, 'only-main.txt'), 'utf8'), 'main only\n');
        assert.strictEqual(fs.existsSync(path.join(repoPath, 'only-feature.txt')), false);
        assert.deepStrictEqual((await service.getStatus()).staged.sort(), ['only-feature.txt', 'only-main.txt', 'shared.txt']);
    });

    test('revertToHead drops staged and unstaged changes and removes files not in HEAD', async () => {
        write('file.txt', 'base\n');
        write('staged.txt', 'base\n');
        await commit('base');
        write('file.txt', 'changed\n');
        write('staged.txt', 'staged change\n');
        write('extra.txt', 'temp\n');
        write('new-staged.txt', 'new\n');
        await service.stageFiles(['staged.txt', 'new-staged.txt']);

        await service.revertToHead(['file.txt', 'staged.txt', 'extra.txt', 'new-staged.txt']);

        assert.strictEqual(fs.readFileSync(path.join(repoPath, 'file.txt'), 'utf8'), 'base\n');
        assert.strictEqual(fs.readFileSync(path.join(repoPath, 'staged.txt'), 'utf8'), 'base\n');
        assert.strictEqual(fs.existsSync(path.join(repoPath, 'extra.txt')), false);
        assert.strictEqual(fs.existsSync(path.join(repoPath, 'new-staged.txt')), false);
        assert.deepStrictEqual((await service.getStatus()).files, []);
    });

    test('getBranches lists local branches and resolveBranchRef falls back to local', async () => {
        write('file.txt', 'x');
        await commit('base');
        await git.branch(['feature/one']);

        const branches = await service.getBranches();
        assert.ok(branches.includes('feature/one'));
        assert.deepStrictEqual(await service.resolveBranchRef('feature/one', true), { ref: 'feature/one' });
    });

    test('batch operations handle thousands of files and special names in a few Git processes', async function () {
        // Creating and committing the files is the slow part (especially on Windows), not the batch operations.
        this.timeout(180000);
        const names = ['with space.txt', 'brackets[1].txt', 'accentuação.txt', 'hash#1.txt'];
        for (let i = 0; i < 1500; i++) {
            names.push(`force-app/main/default/classes/Class${i}.cls`);
        }
        for (const name of names) {
            write(name, `base ${name}\n`);
        }
        const base = await commit('base');
        for (const name of names) {
            write(name, `local ${name}\n`);
        }

        const comparison = await service.compareWithWorkingTree(base, names);
        assert.strictEqual(comparison.filter(file => file.kind === 'changed').length, names.length);

        // Paths go through stdin, so the Windows command line limit (~32k chars) does not apply.
        await service.takeFilesFromRef(base, names);
        assert.strictEqual(fs.readFileSync(path.join(repoPath, 'brackets[1].txt'), 'utf8'), 'base brackets[1].txt\n');
        assert.deepStrictEqual((await service.getStatus()).files, []);

        for (const name of names) {
            write(name, `local ${name}\n`);
        }
        await service.stageFiles(names);
        assert.strictEqual((await service.getStatus()).staged.length, names.length);
        await service.unstageFiles(names);
        assert.strictEqual((await service.getStatus()).staged.length, 0);
        await service.revertToHead(names);
        assert.deepStrictEqual((await service.getStatus()).files, []);
    });

    test('compareWithWorkingTree reports progress and stops when cancelled', async () => {
        const names = Array.from({ length: 250 }, (_, i) => `file${i}.txt`);
        names.forEach(name => write(name, `${name}\n`));
        const sha = await commit('base');

        const updates: Array<[number, number, string]> = [];
        await service.compareWithWorkingTree(sha, names, { onProgress: (done, total, phase) => updates.push([done, total, phase]) });
        assert.ok(updates.length > 2);
        assert.ok(updates.every(([, total]) => total === names.length));
        assert.deepStrictEqual(updates[updates.length - 1], [names.length, names.length, 'Comparing']);

        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            service.compareWithWorkingTree(sha, names, { signal: controller.signal }),
            (error: Error) => error.name === 'AbortError'
        );
    });

    test('forRepo reuses one instance per repository', () => {
        assert.strictEqual(GitService.forRepo(repoPath), GitService.forRepo(repoPath));
        assert.notStrictEqual(GitService.forRepo(repoPath), GitService.forRepo(os.tmpdir()));
    });

    test('an aborted signal stops Git commands instead of letting them finish in the background', async () => {
        write('file.txt', 'x\n');
        const sha = await commit('base');
        const aborted = AbortSignal.abort();

        // Every command the UI can be left waiting on must honour the signal.
        for (const run of [
            () => service.getStatus(aborted),
            () => service.getChangedFilesBetweenRefs(sha, 'HEAD', aborted),
            () => service.getChangedFilesInCommit(sha, aborted),
            () => service.resolveBranchRef('main', true, aborted)
        ]) {
            await assert.rejects(run(), (error: Error) => {
                assert.ok(isAbortError(error), `expected an abort error, got: ${error.message}`);
                return true;
            });
        }

        // Without a signal the same commands still work.
        assert.deepStrictEqual((await service.getStatus()).files, []);
    });

    test('getFileBuffer keeps binary content intact', async () => {
        const bytes = Buffer.from([0, 255, 1, 254, 10, 13, 0]);
        fs.writeFileSync(path.join(repoPath, 'bin.dat'), bytes);
        const sha = await commit('binary');
        assert.ok((await service.getFileBuffer(sha, 'bin.dat'))?.equals(bytes));
    });
});
