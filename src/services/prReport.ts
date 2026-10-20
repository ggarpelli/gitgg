import { ComparisonStatus, PRComparisonReportInput } from '../models/prComparison';
import { ChangeKind } from '../utils/patch';

/** Maps a working tree comparison against the environment branch to a PR comparison status. */
export function toComparisonStatus(kind: ChangeKind): ComparisonStatus {
    switch (kind) {
        case 'unchanged': return 'IDENTICAL';
        case 'added': return 'MISSING_IN_ENVIRONMENT';
        case 'deleted': return 'MISSING_IN_PROMOTION';
        default: return 'DIFFERENT';
    }
}

const SALESFORCE_MATCHERS: Array<{ regex: RegExp; type: string }> = [
    // More specific patterns first (a field also lives under objects/).
    { regex: /objects\/[^/]+\/fields\/([^/]+)\.field-meta\.xml$/, type: 'CustomField' },
    { regex: /classes\/(.*)\.cls(-meta\.xml)?$/, type: 'ApexClass' },
    { regex: /triggers\/(.*)\.trigger(-meta\.xml)?$/, type: 'ApexTrigger' },
    { regex: /flows\/(.*)\.flow-meta\.xml$/, type: 'Flow' },
    { regex: /permissionsets\/(.*)\.permissionset-meta\.xml$/, type: 'PermissionSet' },
    { regex: /lwc\/([^/]+)/, type: 'LWC' },
    { regex: /aura\/([^/]+)/, type: 'Aura' },
    { regex: /objects\/([^/]+)/, type: 'CustomObject' },
    { regex: /layouts\/(.*)\.layout-meta\.xml$/, type: 'Layout' },
    { regex: /profiles\/(.*)\.profile-meta\.xml$/, type: 'Profile' },
    { regex: /sharingRules\/(.*)\.sharingRules-meta\.xml$/, type: 'SharingRules' },
    { regex: /workflows\/(.*)\.workflow-meta\.xml$/, type: 'Workflow' }
];

export function parseSalesforceComponent(filePath: string): { type: string; name: string } | null {
    for (const matcher of SALESFORCE_MATCHERS) {
        const match = filePath.match(matcher.regex);
        if (match) {
            return { type: matcher.type, name: match[1] };
        }
    }
    return null;
}

const STATUS_ICONS: Record<ComparisonStatus, string> = {
    IDENTICAL: '[x]',
    DIFFERENT: '[~]',
    MISSING_IN_ENVIRONMENT: '[-]',
    MISSING_IN_PROMOTION: '[!]'
};

/** Markdown report for the PR comparison. */
export function buildPRComparisonReport(input: PRComparisonReportInput): string {
    const { promotionBranch, destinationBranch, environmentBranch, results } = input;
    const count = (status: ComparisonStatus) => results.filter(file => file.status === status).length;

    const grouped = new Map<string, Array<{ name: string; status: ComparisonStatus }>>();
    const ungrouped: Array<{ path: string; status: ComparisonStatus }> = [];
    for (const file of results) {
        const component = parseSalesforceComponent(file.path);
        if (component) {
            const items = grouped.get(component.type) ?? [];
            items.push({ name: component.name, status: file.status });
            grouped.set(component.type, items);
        } else {
            ungrouped.push(file);
        }
    }

    const lines: string[] = [
        '# PR COMPARISON ANALYSIS',
        '',
        '## Info',
        `- **Promotion Branch**: ${promotionBranch} (working tree)`,
        `- **Destination Branch**: ${destinationBranch}`,
        `- **Environment Branch**: ${environmentBranch}`,
        '',
        '## Section 1: Files in PR',
        `Comparing **${promotionBranch}** (source) with **${destinationBranch}** (target)`,
        '',
        `Total files in PR: ${results.length}`,
        ''
    ];

    if (grouped.size > 0) {
        lines.push('### Salesforce Components', '');
        for (const type of Array.from(grouped.keys()).sort()) {
            lines.push(`#### ${type}`);
            for (const item of grouped.get(type) ?? []) {
                lines.push(`- ${item.name} \`${item.status}\``);
            }
            lines.push('');
        }
    }

    if (ungrouped.length > 0) {
        lines.push('#### Other Files');
        for (const item of ungrouped) {
            lines.push(`- ${item.path} \`${item.status}\``);
        }
        lines.push('');
    }

    lines.push(
        '## Section 2: Comparison with Environment',
        `Comparing **${promotionBranch}** (source) with **${environmentBranch}** (environment)`,
        '',
        `- ${STATUS_ICONS.IDENTICAL} Identical: ${count('IDENTICAL')}`,
        `- ${STATUS_ICONS.DIFFERENT} Different: ${count('DIFFERENT')}`,
        `- ${STATUS_ICONS.MISSING_IN_ENVIRONMENT} Missing in Environment: ${count('MISSING_IN_ENVIRONMENT')}`,
        `- ${STATUS_ICONS.MISSING_IN_PROMOTION} Missing in Promotion: ${count('MISSING_IN_PROMOTION')}`,
        '',
        '### Files that differ from Environment',
        ''
    );

    const differing = results.filter(file => file.status !== 'IDENTICAL');
    if (differing.length === 0) {
        lines.push('All files are identical to the environment!');
    } else {
        for (const file of differing) {
            lines.push(`- ${STATUS_ICONS[file.status]} **${file.path}**`, `  - Status: ${file.status}`);
        }
    }

    lines.push('', '---', `*Generated on ${input.generatedAt.toLocaleString()}*`);
    return lines.join('\n');
}
