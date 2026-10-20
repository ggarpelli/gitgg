import * as assert from 'assert';
import { buildPRComparisonReport, parseSalesforceComponent, toComparisonStatus } from '../../services/prReport';

suite('PR comparison report', () => {
    test('toComparisonStatus maps every change kind', () => {
        assert.strictEqual(toComparisonStatus('unchanged'), 'IDENTICAL');
        assert.strictEqual(toComparisonStatus('changed'), 'DIFFERENT');
        assert.strictEqual(toComparisonStatus('added'), 'MISSING_IN_ENVIRONMENT');
        assert.strictEqual(toComparisonStatus('deleted'), 'MISSING_IN_PROMOTION');
    });

    test('parseSalesforceComponent prefers the most specific type', () => {
        assert.deepStrictEqual(
            parseSalesforceComponent('force-app/main/default/objects/Account/fields/Score__c.field-meta.xml'),
            { type: 'CustomField', name: 'Score__c' }
        );
        assert.deepStrictEqual(parseSalesforceComponent('force-app/main/default/classes/Payment.cls'), { type: 'ApexClass', name: 'Payment' });
        assert.strictEqual(parseSalesforceComponent('README.md'), null);
    });

    test('report groups components and counts statuses', () => {
        const report = buildPRComparisonReport({
            promotionBranch: 'feature/x',
            destinationBranch: 'main',
            environmentBranch: 'uat',
            generatedAt: new Date('2026-01-01T10:00:00'),
            results: [
                { path: 'force-app/main/default/classes/A.cls', status: 'IDENTICAL' },
                { path: 'force-app/main/default/classes/B.cls', status: 'DIFFERENT' },
                { path: 'docs/notes.md', status: 'MISSING_IN_PROMOTION' }
            ]
        });

        assert.ok(report.includes('#### ApexClass\n- A `IDENTICAL`\n- B `DIFFERENT`'));
        assert.ok(report.includes('#### Other Files\n- docs/notes.md `MISSING_IN_PROMOTION`'));
        assert.ok(report.includes('Identical: 1'));
        assert.ok(report.includes('Missing in Promotion: 1'));
        assert.ok(!report.includes('**force-app/main/default/classes/A.cls**'));
    });
});
