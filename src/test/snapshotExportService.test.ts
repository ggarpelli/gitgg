import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService } from '../services/gitService';
import {
    buildSnapshotSummary,
    detectSnapshotExtension,
    detectSnapshotFileType,
    exportSnapshot,
    sanitizeBranchFolderName
} from '../services/snapshotExportService';

suite('Snapshot Export Service Test Suite', () => {
    test('sanitizeBranchFolderName normalizes branch names', () => {
        assert.strictEqual(sanitizeBranchFolderName('promotion/UAT-US123'), 'promotion-UAT-US123');
        assert.strictEqual(sanitizeBranchFolderName(' release\\candidate : 01 '), 'release-candidate-01');
        assert.strictEqual(sanitizeBranchFolderName('////'), 'snapshot-branch');
    });

    test('detectSnapshotFileType and extension map metadata correctly', () => {
        assert.strictEqual(detectSnapshotFileType('force-app/main/default/classes/Test.cls'), 'Apex Class');
        assert.strictEqual(detectSnapshotFileType('force-app/main/default/lwc/payment/payment.js'), 'JavaScript');
        assert.strictEqual(detectSnapshotFileType('force-app/main/default/flows/Checkout.flow-meta.xml'), 'Flow Metadata');
        assert.strictEqual(detectSnapshotFileType('force-app/main/default/file.unknown'), undefined);

        assert.strictEqual(detectSnapshotExtension('force-app/main/default/classes/Test.cls'), '.cls');
        assert.strictEqual(detectSnapshotExtension('force-app/main/default/flows/Checkout.flow-meta.xml'), '.flow-meta.xml');
        assert.strictEqual(detectSnapshotExtension('force-app/main/default/lwc/payment/payment.html'), '.html');
    });

    test('buildSnapshotSummary contains expected fields', () => {
        const summary = buildSnapshotSummary(
            {
                workspacePath: 'C:\\repo',
                sourceBranch: 'promotion/UAT-US123',
                sourceRef: 'promotion/UAT-US123',
                targetBranch: 'M3',
                targetRef: 'origin/M3',
                changedFiles: ['force-app/main/default/classes/Test.cls'],
                generatedAt: new Date('2026-05-28T15:22:00')
            },
            [
                {
                    path: 'force-app/main/default/classes/Test.cls',
                    extension: '.cls',
                    type: 'Apex Class'
                }
            ]
        );

        assert.ok(summary.includes('Source Branch:\npromotion/UAT-US123'));
        assert.ok(summary.includes('Target Branch:\nM3'));
        assert.ok(summary.includes('Folder Structure:\nOriginal repository-relative structure preserved, including standard Salesforce paths when present.'));
        assert.ok(summary.includes('Generated At:\n2026-05-28 15:22:00'));
        assert.ok(summary.includes('Total Files:\n1'));
        assert.ok(summary.includes('force-app/main/default/classes/Test.cls'));
        assert.ok(summary.includes('Extension: .cls'));
        assert.ok(summary.includes('Type: Apex Class'));
    });

    test('exportSnapshot writes only changed files and preserves structure', async () => {
        const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gitgg-snapshot-test-'));
        const contentMap = new Map<string, string | null>([
            ['promotion/UAT-US123:force-app/main/default/classes/Payment.cls', 'public class Payment {}'],
            ['promotion/UAT-US123:force-app/main/default/flows/Checkout.flow-meta.xml', '<Flow />'],
            ['origin/M3:force-app/main/default/classes/Payment.cls', 'public class PaymentTarget {}'],
            ['origin/M3:force-app/main/default/flows/Checkout.flow-meta.xml', null]
        ]);

        const gitService = {
            async getFileContentAtRef(ref: string, filePath: string): Promise<string | null> {
                return contentMap.get(`${ref}:${filePath}`) ?? null;
            }
        } as GitService;

        try {
            const result = await exportSnapshot(gitService, {
                workspacePath: tempRoot,
                sourceBranch: 'promotion/UAT-US123',
                sourceRef: 'promotion/UAT-US123',
                targetBranch: 'M3',
                targetRef: 'origin/M3',
                changedFiles: [
                    'force-app/main/default/classes/Payment.cls',
                    'force-app/main/default/flows/Checkout.flow-meta.xml'
                ],
                generatedAt: new Date('2026-05-28T15:22:00')
            });

            const sourceFile = path.join(result.snapshotRoot, 'promotion-UAT-US123', 'force-app', 'main', 'default', 'classes', 'Payment.cls');
            const targetFile = path.join(result.snapshotRoot, 'M3', 'force-app', 'main', 'default', 'classes', 'Payment.cls');
            const missingTargetFlow = path.join(result.snapshotRoot, 'M3', 'force-app', 'main', 'default', 'flows', 'Checkout.flow-meta.xml');
            const sourceFlow = path.join(result.snapshotRoot, 'promotion-UAT-US123', 'force-app', 'main', 'default', 'flows', 'Checkout.flow-meta.xml');

            assert.strictEqual(await fs.promises.readFile(sourceFile, 'utf8'), 'public class Payment {}');
            assert.strictEqual(await fs.promises.readFile(targetFile, 'utf8'), 'public class PaymentTarget {}');
            assert.strictEqual(await fs.promises.readFile(sourceFlow, 'utf8'), '<Flow />');
            assert.strictEqual(fs.existsSync(missingTargetFlow), false);
            assert.strictEqual(fs.existsSync(result.summaryPath), true);

            const summary = await fs.promises.readFile(result.summaryPath, 'utf8');
            assert.ok(summary.includes('Target Branch:\nM3'));
            assert.ok(summary.includes('Total Files:\n2'));
            assert.ok(summary.includes('Type: Flow Metadata'));
        } finally {
            await fs.promises.rm(tempRoot, { recursive: true, force: true });
        }
    });
});
