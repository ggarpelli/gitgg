import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff';

export type ChangeKind = 'added' | 'changed' | 'deleted' | 'unchanged';

/** Above this many edits jsdiff gives up, so a huge rewrite never freezes the extension host. */
const MAX_EDIT_LENGTH = 20000;

/**
 * Wall-clock budget for diffing one file. `maxEditLength` alone does not bound the time: each edit
 * step costs O(file length), so a very large file (a Salesforce profile or permission set, say)
 * can grind for minutes and block everything, because the diff is synchronous.
 */
const DIFF_TIMEOUT_MS = 500;

/** Beyond this, a file is not worth diffing inline; the diff editor handles it far better. */
const MAX_INLINE_DIFF_CHARS = 2_000_000;

export function normalizeLineEndings(content: string): string {
    return content.replace(/\r\n/g, '\n');
}

export function isBinaryContent(content: string | null): boolean {
    return content !== null && content.includes('\0');
}

/**
 * Classifies a file by comparing the base version (branch/commit) with the local one.
 * `null` means the file does not exist on that side. Line endings are ignored, like Git does with autocrlf.
 */
export function classifyChange(baseContent: string | null, localContent: string | null): ChangeKind {
    if (baseContent === null && localContent === null) {
        return 'unchanged';
    }
    if (baseContent === null) {
        return 'added';
    }
    if (localContent === null) {
        return 'deleted';
    }
    return normalizeLineEndings(baseContent) === normalizeLineEndings(localContent) ? 'unchanged' : 'changed';
}

/**
 * Builds a unified diff in Git format (parsable by diff2html) between the base and local versions of a file.
 * Returns an empty string when there are no differences.
 */
export function buildPatch(filePath: string, baseContent: string | null, localContent: string | null): string {
    const kind = classifyChange(baseContent, localContent);
    if (kind === 'unchanged') {
        return '';
    }

    const safePath = filePath.replace(/\\/g, '/');
    let header = `diff --git a/${safePath} b/${safePath}\n`;
    if (kind === 'added') {
        header += 'new file mode 100644\n';
    } else if (kind === 'deleted') {
        header += 'deleted file mode 100644\n';
    }

    const oldName = baseContent === null ? '/dev/null' : `a/${safePath}`;
    const newName = localContent === null ? '/dev/null' : `b/${safePath}`;

    if (isBinaryContent(baseContent) || isBinaryContent(localContent)) {
        return `${header}Binary files ${oldName} and ${newName} differ\n`;
    }

    const before = normalizeLineEndings(baseContent ?? '');
    const after = normalizeLineEndings(localContent ?? '');
    const tooBig = before.length + after.length > MAX_INLINE_DIFF_CHARS;

    const patch = tooBig ? undefined : createTwoFilesPatch(
        oldName,
        newName,
        before,
        after,
        undefined,
        undefined,
        { context: 3, headerOptions: FILE_HEADERS_ONLY, maxEditLength: MAX_EDIT_LENGTH, timeout: DIFF_TIMEOUT_MS }
    );

    // Either the file is huge or the diff ran out of its budget: show a placeholder instead of
    // freezing, and point at the diff editor, which handles files of any size.
    if (patch === undefined) {
        return `${header}--- ${oldName}\n+++ ${newName}\n@@ -1,1 +1,1 @@\n-(this file is too large to diff inline)\n+(click "View full Diff" to see the changes)\n`;
    }

    return header + patch;
}

export function countLineChanges(patch: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const line of patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
            added++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            removed++;
        }
    }
    return { added, removed };
}

export interface NameStatusEntry {
    /** Single-letter Git status (A, M, D, R, C, T...). */
    status: string;
    path: string;
    /** Previous path for renames/copies. */
    originalPath?: string;
}

/** Parses `git diff --name-status` output, including rename/copy lines such as `R100\told\tnew`. */
export function parseNameStatus(output: string): NameStatusEntry[] {
    const entries: NameStatusEntry[] = [];
    for (const line of output.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        const parts = line.split('\t');
        const status = parts[0].charAt(0);
        if ((status === 'R' || status === 'C') && parts.length >= 3) {
            entries.push({ status, path: parts[2], originalPath: parts[1] });
        } else if (parts.length >= 2) {
            entries.push({ status, path: parts[1] });
        }
    }
    return entries;
}

/**
 * Serializes data for embedding inside `<script type="application/json">`.
 * Escapes `<`, `>` and `&` so content such as `</script>` cannot break out of the tag.
 */
export function serializeForScriptTag(data: unknown): string {
    return JSON.stringify(data)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
}
