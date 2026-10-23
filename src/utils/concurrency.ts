/** Like `Promise.all(items.map(fn))`, but with at most `limit` calls running at the same time. Keeps order. */
export async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
    signal?: AbortSignal
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            throwIfAborted(signal);
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/** Error used when the user cancels a long operation; callers treat it as a silent stop, not a failure. */
export function createAbortError(): Error {
    const error = new Error('The operation was cancelled.');
    error.name = 'AbortError';
    return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

export function isAbortError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    // Our own AbortError, or simple-git killing the process because its abort signal fired.
    return error.name === 'AbortError' || (error as { plugin?: string }).plugin === 'abort';
}

/** True when a Git command was killed for producing no output for too long (simple-git's block timeout). */
export function isGitTimeoutError(error: unknown): boolean {
    return error instanceof Error && (error as { plugin?: string }).plugin === 'timeout';
}

/** Lets the event loop run (progress messages, cancellation) during long synchronous loops. */
export function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}
