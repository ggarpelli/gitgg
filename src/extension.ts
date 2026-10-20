import * as vscode from 'vscode';
import { runCompareFileCommand } from './commands/compareFileCommand';
import { runReleaseDriftCommand } from './commands/releaseDriftCommand';
import { runPRComparisonCommand } from './commands/prComparisonCommand';
import { runExportPRSnapshotCommand } from './commands/exportPRSnapshotCommand';
import { registerRefContentProvider } from './ui/refContentProvider';
import { initDiffTabActions, registerDiffTabActions } from './ui/diffTabActions';
import { showError } from './ui/feedback';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        registerRefContentProvider(),
        ...registerDiffTabActions(),
        vscode.commands.registerCommand('gitgg.compareFile', (...args: unknown[]) => withErrorHandling(() => runCompareFileCommand(context, args))),
        vscode.commands.registerCommand('gitgg.releaseDrift', (commitSha?: unknown) =>
            withErrorHandling(() => runReleaseDriftCommand(context, typeof commitSha === 'string' ? commitSha : undefined))),
        vscode.commands.registerCommand('gitgg.prComparison', () => withErrorHandling(() => runPRComparisonCommand(context))),
        vscode.commands.registerCommand('gitgg.exportPRSnapshot', () => withErrorHandling(() => runExportPRSnapshotCommand(context)))
    );
    initDiffTabActions();
}

async function withErrorHandling(run: () => Promise<void>): Promise<void> {
    try {
        await run();
    } catch (error) {
        // Cancellations are silent; real failures get a notification with details in the Gitgg output channel.
        await showError('Command failed', error);
    }
}

export function deactivate() {
    // Nothing to clean up: diffs are served from memory through the `gitgg:` content provider.
}
