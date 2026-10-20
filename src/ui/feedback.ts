import * as vscode from 'vscode';
import { FileComparison, GitService } from '../services/gitService';
import { isAbortError } from '../utils/concurrency';

let outputChannel: vscode.OutputChannel | undefined;

/** The "Gitgg" output channel, where errors are logged with full details. */
export function getOutputChannel(): vscode.OutputChannel {
    outputChannel ??= vscode.window.createOutputChannel('Gitgg');
    return outputChannel;
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function logError(context: string, error: unknown): void {
    const details = error instanceof Error && error.stack ? error.stack : errorMessage(error);
    getOutputChannel().appendLine(`[${new Date().toLocaleString()}] ${context}\n${details}\n`);
}

/** Error notification with a "Show Details" button that opens the Gitgg output channel. Cancellations are ignored. */
export async function showError(context: string, error: unknown): Promise<void> {
    if (isAbortError(error)) {
        return;
    }
    logError(context, error);
    const choice = await vscode.window.showErrorMessage(`Gitgg: ${context}: ${firstLine(errorMessage(error))}`, 'Show Details');
    if (choice) {
        getOutputChannel().show(true);
    }
}

function firstLine(text: string): string {
    return text.split('\n')[0];
}

type Progress = vscode.Progress<{ message?: string; increment?: number }>;

/**
 * Compares files while showing "Reading 3,200 of 8,337 files..." with a percentage bar,
 * and stops right away (killing Git) when the user presses Cancel.
 */
export function compareWithProgress(
    git: GitService,
    baseRef: string,
    filePaths: string[],
    progress: Progress,
    token: vscode.CancellationToken
): Promise<FileComparison[]> {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    let reported = 0;

    return git.compareWithWorkingTree(baseRef, filePaths, {
        signal: controller.signal,
        onProgress: (done, total, phase) => {
            // Two phases (reading, comparing), each worth half of the bar.
            const percent = total === 0 ? 100 : Math.floor((done / total) * 50) + (phase === 'Comparing' ? 50 : 0);
            progress.report({
                message: `${phase} ${done.toLocaleString()} of ${total.toLocaleString()} files...`,
                increment: Math.max(0, percent - reported)
            });
            reported = Math.max(reported, percent);
        }
    }).finally(() => subscription.dispose());
}
