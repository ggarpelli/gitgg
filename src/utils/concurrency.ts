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
    return error instanceof Error && error.name === 'AbortError';
}

/** Lets the event loop run (progress messages, cancellation) during long synchronous loops. */
export function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}
