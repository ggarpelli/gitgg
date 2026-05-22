import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from '../services/gitService';
import { PRComparisonView } from '../views/prComparisonView';
import { pickBranchWithFavorites } from '../ui/branchPicker';
import { PRComparisonResult, PRComparisonFileResult, ComparisonStatus } from '../models/prComparison';

// Helper to generate added patch (used as fallback)
function generateAddedPatch(filePath: string, content: string): string {
    const safePath = filePath.replace(/\\/g, '/');
    const lines = content.split('\n');
    let result = 'diff --git a/' + safePath + ' b/' + safePath + '\n';
    result += 'new file mode 100644\n';
    result += '--- /dev/null\n';
    result += '+++ b/' + safePath + '\n';
    result += '@@ -0,0 +1,' + lines.length + ' @@\n';
    for (const line of lines) {
        result += '+' + line + '\n';
    }
    return result;
}

// Helper function to get repository path
function getRepoPath(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
    }
    return workspaceFolders[0].uri.fsPath;
}

export async function runPRComparisonCommand(context: vscode.ExtensionContext): Promise<void> {
    const repoPath = getRepoPath();
    if (!repoPath) {
        vscode.window.showErrorMessage('Could not determine Git workspace.');
        return;
    }

    try {
        // Show progress indicator
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Comparing PR changes...",
            cancellable: true
        }, async (progress, token) => {
            progress.report({ increment: 0, message: "Initializing..." });

            // Create git service
            const gitService = new GitService(repoPath);

            // Get current branch - this is MANDATORY as the promotion branch (what we currently have)
            const promotionBranch = await gitService.getCurrentBranch();
            if (!promotionBranch) {
                vscode.window.showErrorMessage('Could not determine current branch. Please check out a branch first.');
                return;
            }

            progress.report({ increment: 20, message: "Getting available branches..." });

            // Get all branches for the pickers
            const branches = await gitService.getAllBranches();
            if (branches.length === 0) {
                vscode.window.showErrorMessage('No branches found in repository.');
                return;
            }

            // Filter out the current branch from selection options
            const otherBranches = branches.filter(branch => branch !== promotionBranch);
            if (otherBranches.length === 0) {
                vscode.window.showErrorMessage('No other branches available for selection.');
                return;
            }

            progress.report({ increment: 30, message: "Selecting destination branch (PR target)..." });

            // Show branch picker for destination branch (where PR would go)
            const destinationBranch = await pickBranchWithFavorites(
                context,
                otherBranches,
                'Select destination branch (where PR would go)'
            );
            if (!destinationBranch) return;

            progress.report({ increment: 50, message: "Selecting environment branch (source of truth)..." });

            // Show branch picker for environment branch (to compare against)
            const environmentBranch = await pickBranchWithFavorites(
                context,
                otherBranches,
                'Select environment branch (source of truth)'
            );
            if (!environmentBranch) return;

            progress.report({ increment: 60, message: "Getting changed files between branches..." });

            // Helper to resolve branch ref - try remote first, fallback to local
            const resolveRef = async (branch: string): Promise<string> => {
                try {
                    await gitService.getCommitSha('origin/' + branch);
                    return 'origin/' + branch;
                } catch {
                    return branch;
                }
            };

            // Resolve refs for destination and environment
            const destinationRef = await resolveRef(destinationBranch);
            const environmentRef = await resolveRef(environmentBranch);

            // Get changed files between destination ref and promotion branch (HEAD)
            const changedFiles = await gitService.getChangedFilesBetweenRefs(destinationRef, promotionBranch);

            if (changedFiles.length === 0) {
                vscode.window.showInformationMessage('No files changed between the branches.');
                return;
            }

            progress.report({ increment: 70, message: "Analyzing file differences..." });

            // Analyze each file: compare HEAD (promotion) vs environment branch
            const fileAnalysisPromises = changedFiles.map(async (filePath) => {
                // Get content from promotion branch (HEAD)
                const promotionContent = await gitService.getFileContent(promotionBranch, filePath);

                // Get content from environment branch (try remote first, then local)
                const environmentContent = await gitService.getFileContent(environmentRef, filePath);

                // Generate patch using git diff for accurate line counts
                let patch = '';
                if (environmentRef && promotionContent !== null && environmentContent !== null) {
                    patch = await gitService.getDiffBetweenRefs(environmentRef, promotionBranch, filePath);
                } else if (environmentContent === null && promotionContent !== null) {
                    // File only in promotion - generate "new file" patch
                    patch = await gitService.getDiffBetweenRefs('/dev/null', promotionBranch, filePath);
                    if (!patch) {
                        // Fallback if git diff fails
                        patch = generateAddedPatch(filePath, promotionContent);
                    }
                }

                // Determine status
                let status: ComparisonStatus;

                if (promotionContent !== null && environmentContent === null) {
                    // File exists in promotion but not in environment
                    status = 'MISSING_IN_ENVIRONMENT';
                } else if (promotionContent === environmentContent) {
                    // Identical content
                    status = 'IDENTICAL';
                } else {
                    // Content differs
                    status = 'DIFFERENT';
                }

                return {
                    path: filePath,
                    status,
                    promotionContent,
                    environmentContent,
                    promotionBranch,
                    environmentRef,
                    patch
                } as PRComparisonFileResult;
            });

            const fileAnalysisResults = await Promise.all(fileAnalysisPromises);

            progress.report({ increment: 95, message: "Preparing results..." });

            // Create PR comparison result
            const prResult: PRComparisonResult = {
                promotionBranch,
                destinationBranch,
                environmentBranch,
                environmentRef,
                results: fileAnalysisResults,
                analyzedAt: new Date()
            };

            // Salesforce component type matcher
            const metadataMatchers = [
                { regex: /classes\/(.*)\.cls$/, type: 'ApexClass' },
                { regex: /triggers\/(.*)\.trigger$/, type: 'ApexTrigger' },
                { regex: /flows\/(.*)\.flow-meta\.xml$/, type: 'Flow' },
                { regex: /permissionsets\/(.*)\.permissionset-meta\.xml$/, type: 'PermissionSet' },
                { regex: /lwc\/([^\/]+)/, type: 'LWC' },
                { regex: /objects\/([^\/]+)/, type: 'CustomObject' },
                { regex: /layouts\/(.*)\.layout-meta\.xml$/, type: 'Layout' },
                { regex: /profiles\/(.*)\.profile-meta\.xml$/, type: 'Profile' },
                { regex: /sharingRules\/(.*)\.sharingRules-meta\.xml$/, type: 'SharingRules' },
                { regex: /workflows\/(.*)\.workflow-meta\.xml$/, type: 'Workflow' },
                { regex: /objects\/([^\/]+)\/fields\/.*\.field-meta\.xml$/, type: 'CustomField' }
            ];

            const parseSalesforceComponent = (filePath: string): { type: string; name: string } | null => {
                for (const matcher of metadataMatchers) {
                    const match = filePath.match(matcher.regex);
                    if (match) {
                        return { type: matcher.type, name: match[1] };
                    }
                }
                return null;
            };

            // Group files by component type
            const grouped: Record<string, { name: string; path: string; status: string }[]> = {};
            const ungrouped: { path: string; status: string }[] = [];

            for (const file of fileAnalysisResults) {
                const component = parseSalesforceComponent(file.path);
                if (component) {
                    if (!grouped[component.type]) {
                        grouped[component.type] = [];
                    }
                    grouped[component.type].push({ name: component.name, path: file.path, status: file.status });
                } else {
                    ungrouped.push({ path: file.path, status: file.status });
                }
            }

            // Build summary with grouping
            const identicalFiles = fileAnalysisResults.filter(f => f.status === 'IDENTICAL');
            const differentFiles = fileAnalysisResults.filter(f => f.status === 'DIFFERENT');
            const missingFiles = fileAnalysisResults.filter(f => f.status === 'MISSING_IN_ENVIRONMENT');

            const lines: string[] = [];

            // Header
            lines.push('# PR COMPARISON ANALYSIS');
            lines.push('');
            lines.push('## Info');
            lines.push('- **Promotion Branch**: ' + promotionBranch);
            lines.push('- **Destination Branch**: ' + destinationBranch);
            lines.push('- **Environment Branch**: ' + environmentBranch);
            lines.push('');

            // Section 1: Files in PR (promotion vs destination)
            lines.push('## Section 1: Files in PR');
            lines.push('Comparing **' + promotionBranch + '** (source) with **' + destinationBranch + '** (target)');
            lines.push('');
            lines.push('Total files in PR: ' + fileAnalysisResults.length);
            lines.push('');
            lines.push('### Salesforce Components');
            lines.push('');

            // Group Section 1 by component type
            for (const type of Object.keys(grouped).sort()) {
                lines.push('#### ' + type);
                for (const item of grouped[type]) {
                    lines.push('- ' + item.name + ' `' + item.status + '`');
                }
                lines.push('');
            }

            if (ungrouped.length > 0) {
                lines.push('#### Other Files');
                for (const item of ungrouped) {
                    lines.push('- ' + item.path + ' `' + item.status + '`');
                }
                lines.push('');
            }

            // Section 2: Comparison with Environment (promotion vs environment)
            lines.push('## Section 2: Comparison with Environment');
            lines.push('Comparing **' + promotionBranch + '** (source) with **' + environmentBranch + '** (environment)');
            lines.push('');
            lines.push('- [x] Identical: ' + identicalFiles.length);
            lines.push('- [~] Different: ' + differentFiles.length);
            lines.push('- [-] Missing in Environment: ' + missingFiles.length);
            lines.push('');
            lines.push('### Files that differ from Environment');
            lines.push('');

            const differFromEnv = fileAnalysisResults.filter(f => f.status !== 'IDENTICAL');
            if (differFromEnv.length > 0) {
                for (const file of differFromEnv) {
                    const icon = file.status === 'DIFFERENT' ? '[~]' : '[-]';
                    lines.push('- ' + icon + ' **' + file.path + '**');
                    lines.push('  - Status: ' + file.status);
                }
            } else {
                lines.push('All files are identical to the environment!');
            }

            lines.push('');
            lines.push('---');
            lines.push('*Generated on ' + new Date().toLocaleString() + '*');

            const summary = lines.join('\n');

            // Save summary to a markdown file for later reference
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (workspaceFolder) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const safeBranchName = promotionBranch.replace(/[\/\\]/g, '-');
                const fileName = 'pr-comparison-' + safeBranchName + '-' + timestamp + '.md';
                const filePath = path.join(workspaceFolder.uri.fsPath, fileName);
                fs.writeFileSync(filePath, summary, 'utf8');
                vscode.window.showInformationMessage('PR Analysis saved to: ' + fileName);
            }

            progress.report({ increment: 100, message: "Analysis complete!" });

            // Show results using new PR comparison view
            const prView = new PRComparisonView();
            await prView.show(context, prResult, gitService);

            vscode.window.showInformationMessage('PR validation complete: ' + fileAnalysisResults.length + ' files analyzed');
        });
    } catch (error) {
        console.error('Error running PR comparison:', error);
        vscode.window.showErrorMessage('Failed to compare PR: ' + (error instanceof Error ? error.message : String(error)));
    }
}