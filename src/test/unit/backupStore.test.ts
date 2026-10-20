import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import { GitService } from '../../services/gitService';
import { BackupStore } from '../../services/backupStore';

suite('BackupStore (Use / Revert / Restore)', function () {
    this.timeout(30000);

    let repoPath: string;
    let git: SimpleGit;
    let service: GitService;
    let store: BackupStore;
    let otherRef: string;

    const read = (file: string) => fs.existsSync(path.join(repoPath, file)) ? fs.readFileSync(path.join(repoPath, file), 'utf8') : null;
    const write = (file: string, content: string) => fs.writeFileSync(path.join(repoPath, file), content);

    setup(async () => {
        repoPath = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gitgg-backup-')));
        git = simpleGit(repoPath);
        await git.init();
        await git.addConfig('user.name', 'Gitgg Test');
        await git.addConfig('user.email', 'test@example.com');
        await git.addConfig('core.autocrlf', 'false');

        write('a.txt', 'other a\n');
        write('only-other.txt', 'other only\n');
        await git.add(['-A']);
        await git.commit('other');
        otherRef = (await git.revparse(['HEAD'])).trim();

        write('a.txt', 'mine a\n');
        fs.unlinkSync(path.join(repoPath, 'only-other.txt'));
        await git.add(['-A']);
        await git.commit('mine');

        service = new GitService(repoPath);
        store = new BackupStore();
    });

    teardown(() => {
        fs.rmSync(repoPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    test('Use then Restore brings back content and unstages', async () => {
        write('a.txt', 'my local edit\n');
        const files = ['a.txt', 'only-other.txt'];

        const changed = await store.apply(service, files, () => service.takeFilesFromRef(otherRef, files));
        assert.strictEqual(changed, 2);
        assert.strictEqual(read('a.txt'), 'other a\n');
        assert.strictEqual(read('only-other.txt'), 'other only\n');
        assert.deepStrictEqual(store.paths(repoPath).sort(), files);

        const { entries, editedSince } = await store.inspect(service, files);
        assert.strictEqual(editedSince.size, 0);
        await store.restore(service, entries);

        assert.strictEqual(read('a.txt'), 'my local edit\n');
        assert.strictEqual(read('only-other.txt'), null);
        assert.deepStrictEqual((await service.getStatus()).staged, []);
        assert.deepStrictEqual(store.paths(repoPath), []);
    });

    test('Revert then Restore keeps a previously staged file staged', async () => {
        write('a.txt', 'staged edit\n');
        await service.stageFiles(['a.txt']);

        await store.apply(service, ['a.txt'], () => service.revertToHead(['a.txt']));
        assert.strictEqual(read('a.txt'), 'mine a\n');
        assert.deepStrictEqual((await service.getStatus()).staged, []);

        const { entries } = await store.inspect(service, ['a.txt']);
        await store.restore(service, entries);
        assert.strictEqual(read('a.txt'), 'staged edit\n');
        assert.deepStrictEqual((await service.getStatus()).staged, ['a.txt']);
    });

    test('keeps the oldest backup and detects edits made after the action', async () => {
        write('a.txt', 'original\n');
        await store.apply(service, ['a.txt'], () => service.takeFilesFromRef(otherRef, ['a.txt']));
        await store.apply(service, ['a.txt'], () => service.revertToHead(['a.txt']));
        write('a.txt', 'edited afterwards\n');

        const { entries, editedSince } = await store.inspect(service, ['a.txt']);
        assert.ok(editedSince.has('a.txt'));
        await store.restore(service, entries);
        assert.strictEqual(read('a.txt'), 'original\n');
    });

    test('files that did not change get no backup', async () => {
        const changed = await store.apply(service, ['a.txt'], () => service.revertToHead(['a.txt']));
        assert.strictEqual(changed, 0);
        assert.strictEqual(store.has(repoPath, 'a.txt'), false);
    });
});
