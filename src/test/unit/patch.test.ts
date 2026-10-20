import * as assert from 'assert';
import { parse } from 'diff2html';
import {
    buildPatch,
    classifyChange,
    countLineChanges,
    parseNameStatus,
    serializeForScriptTag
} from '../../utils/patch';

suite('Patch utilities', () => {
    test('classifyChange covers every side combination and ignores CRLF', () => {
        assert.strictEqual(classifyChange(null, null), 'unchanged');
        assert.strictEqual(classifyChange(null, 'a'), 'added');
        assert.strictEqual(classifyChange('a', null), 'deleted');
        assert.strictEqual(classifyChange('a\nb\n', 'a\r\nb\r\n'), 'unchanged');
        assert.strictEqual(classifyChange('a\n', 'b\n'), 'changed');
    });

    test('buildPatch produces a diff that diff2html can parse', () => {
        const patch = buildPatch('src/app.ts', 'one\ntwo\nthree\n', 'one\n2\nthree\nfour\n');
        const [file] = parse(patch);
        assert.strictEqual(file.newName, 'src/app.ts');
        assert.strictEqual(file.addedLines, 2);
        assert.strictEqual(file.deletedLines, 1);
        assert.deepStrictEqual(countLineChanges(patch), { added: 2, removed: 1 });
    });

    test('buildPatch marks new and deleted files', () => {
        const added = parse(buildPatch('new.txt', null, 'hello\n'))[0];
        assert.strictEqual(added.isNew, true);
        assert.strictEqual(added.addedLines, 1);

        const deleted = parse(buildPatch('old.txt', 'bye\n', null))[0];
        assert.strictEqual(deleted.isDeleted, true);
        assert.strictEqual(deleted.deletedLines, 1);
    });

    test('buildPatch returns empty for identical content and a stub for binaries', () => {
        assert.strictEqual(buildPatch('same.txt', 'x\r\n', 'x\n'), '');
        assert.ok(buildPatch('img.png', 'a\0b', 'a\0c').includes('Binary files'));
    });

    test('parseNameStatus handles renames, copies and regular entries', () => {
        const entries = parseNameStatus('M\tsrc/a.ts\nR087\tsrc/old.ts\tsrc/new.ts\nC100\tx.ts\ty.ts\nA\tadded.ts\n');
        assert.deepStrictEqual(entries, [
            { status: 'M', path: 'src/a.ts' },
            { status: 'R', path: 'src/new.ts', originalPath: 'src/old.ts' },
            { status: 'C', path: 'y.ts', originalPath: 'x.ts' },
            { status: 'A', path: 'added.ts' }
        ]);
    });

    test('serializeForScriptTag cannot close the script tag and round-trips', () => {
        const data = { patch: '</script><script>alert(1)</script> $& $\' $` &amp;' };
        const serialized = serializeForScriptTag(data);
        assert.ok(!serialized.includes('</script>'));
        assert.ok(!serialized.includes('<'));
        assert.deepStrictEqual(JSON.parse(serialized), data);
    });
});
