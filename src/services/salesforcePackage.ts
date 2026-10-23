import * as fs from 'fs';
import * as path from 'path';

const SALESFORCE_METADATA_NAMESPACE = 'http://soap.sforce.com/2006/04/metadata';
const DEFAULT_API_VERSION = '68.0';

const ROOT_METADATA_TYPES: Record<string, string> = {
    applications: 'CustomApplication',
    approvalprocesses: 'ApprovalProcess',
    assignmentrules: 'AssignmentRules',
    autoresponserules: 'AutoResponseRules',
    connectedapps: 'ConnectedApp',
    customlabels: 'CustomLabels',
    custommetadata: 'CustomMetadata',
    custompermissions: 'CustomPermission',
    dashboards: 'Dashboard',
    documents: 'Document',
    duplicaterules: 'DuplicateRule',
    email: 'EmailTemplate',
    emailtemplates: 'EmailTemplate',
    escalationrules: 'EscalationRules',
    flexipages: 'FlexiPage',
    flows: 'Flow',
    globalvaluesets: 'GlobalValueSet',
    groups: 'Group',
    homepagecomponents: 'HomePageComponent',
    homepagelayouts: 'HomePageLayout',
    labels: 'CustomLabels',
    layouts: 'Layout',
    matchingrules: 'MatchingRules',
    namedcredentials: 'NamedCredential',
    pages: 'ApexPage',
    pathassistants: 'PathAssistant',
    permissionsets: 'PermissionSet',
    permissionsetgroups: 'PermissionSetGroup',
    profiles: 'Profile',
    queues: 'Queue',
    quickactions: 'QuickAction',
    remotesitesettings: 'RemoteSiteSetting',
    reports: 'Report',
    roles: 'Role',
    sharingrules: 'SharingRules',
    staticresources: 'StaticResource',
    tabs: 'CustomTab',
    translations: 'Translations',
    workflows: 'Workflow',
    settings: 'Settings'
};

const OBJECT_CHILD_TYPES: Record<string, string> = {
    businessprocesses: 'BusinessProcess',
    compactlayouts: 'CompactLayout',
    fields: 'CustomField',
    fieldsets: 'FieldSet',
    indexes: 'CustomIndex',
    listviews: 'ListView',
    namedfilters: 'NamedFilter',
    recordtypes: 'RecordType',
    sharingreasons: 'SharingReason',
    validationrules: 'ValidationRule',
    weblinks: 'WebLink'
};

const FOLDERED_METADATA_TYPES = new Set(['dashboards', 'documents', 'email', 'emailtemplates', 'reports']);

export interface SalesforcePackageManifest {
    xml: string;
    /** Distinct metadata members represented by the manifest. */
    componentCount: number;
    typeCount: number;
}

/**
 * Builds a Salesforce Metadata API package.xml from Salesforce source-format paths.
 * Files that aren't recognized Salesforce metadata are intentionally omitted.
 */
export function buildSalesforcePackageManifest(filePaths: string[], apiVersion: string): SalesforcePackageManifest {
    const membersByType = new Map<string, Set<string>>();
    for (const filePath of new Set(filePaths)) {
        const component = getMetadataComponent(filePath);
        if (!component) {
            continue;
        }
        const members = membersByType.get(component.type) ?? new Set<string>();
        members.add(component.member);
        membersByType.set(component.type, members);
    }

    const types = Array.from(membersByType.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([type, members]) => ({ type, members: Array.from(members).sort((left, right) => left.localeCompare(right)) }));
    const componentCount = types.reduce((count, item) => count + item.members.length, 0);
    if (componentCount === 0) {
        return { xml: '', componentCount: 0, typeCount: 0 };
    }

    const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<Package xmlns="${SALESFORCE_METADATA_NAMESPACE}">`
    ];
    for (const item of types) {
        lines.push('    <types>');
        for (const member of item.members) {
            lines.push(`        <members>${escapeXml(member)}</members>`);
        }
        lines.push(`        <name>${item.type}</name>`, '    </types>');
    }
    lines.push(`    <version>${escapeXml(apiVersion)}</version>`, '</Package>', '');
    return { xml: lines.join('\n'), componentCount, typeCount: types.length };
}

/** The Salesforce DX sourceApiVersion is the preferred manifest version. */
export async function resolveSalesforceApiVersion(repositoryPath: string): Promise<string> {
    try {
        const project = JSON.parse(await fs.promises.readFile(path.join(repositoryPath, 'sfdx-project.json'), 'utf8')) as { sourceApiVersion?: unknown };
        if (typeof project.sourceApiVersion === 'string' && /^\d+(?:\.\d+)?$/.test(project.sourceApiVersion)) {
            return project.sourceApiVersion;
        }
    } catch {
        // The repository may not be a Salesforce DX project; check for a manifest version next.
    }

    for (const manifestPath of ['manifest/package.xml', 'package.xml']) {
        try {
            const content = await fs.promises.readFile(path.join(repositoryPath, manifestPath), 'utf8');
            const version = content.match(/<version>\s*(\d+(?:\.\d+)?)\s*<\/version>/i)?.[1];
            if (version) {
                return version;
            }
        } catch {
            // Keep looking for a version source.
        }
    }

    return DEFAULT_API_VERSION;
}

function getMetadataComponent(filePath: string): { type: string; member: string } | undefined {
    const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
    const lowerParts = parts.map(part => part.toLowerCase());
    const fileName = parts[parts.length - 1] ?? '';
    const lowerFileName = fileName.toLowerCase();

    const className = stripMetadataExtension(fileName, '.cls');
    if (className) {
        return { type: 'ApexClass', member: className };
    }
    const triggerName = stripMetadataExtension(fileName, '.trigger');
    if (triggerName) {
        return { type: 'ApexTrigger', member: triggerName };
    }

    for (const [folder, type] of [['lwc', 'LightningComponentBundle'], ['aura', 'AuraDefinitionBundle']] as const) {
        const folderIndex = lowerParts.indexOf(folder);
        const componentName = folderIndex >= 0 ? parts[folderIndex + 1] : undefined;
        if (componentName) {
            return { type, member: componentName };
        }
    }

    const objectsIndex = lowerParts.indexOf('objects');
    if (objectsIndex >= 0) {
        const objectSegment = parts[objectsIndex + 1];
        if (objectSegment) {
            const objectFileName = stripMetadataExtension(objectSegment, '.object');
            if (objectFileName) {
                return { type: 'CustomObject', member: objectFileName };
            }

            const objectName = objectSegment;
            const childFolder = lowerParts[objectsIndex + 2];
            if (!childFolder || childFolder.endsWith('.object-meta.xml')) {
                return { type: 'CustomObject', member: objectName };
            }
            const childType = OBJECT_CHILD_TYPES[childFolder];
            if (childType) {
                const childName = metadataMemberName(fileName);
                return childName ? { type: childType, member: `${objectName}.${childName}` } : undefined;
            }
        }
    }

    for (const [index, segment] of lowerParts.entries()) {
        const type = ROOT_METADATA_TYPES[segment];
        if (!type) {
            continue;
        }
        const memberName = metadataMemberName(fileName);
        if (!memberName) {
            return undefined;
        }
        if (segment === 'customlabels') {
            return { type, member: 'CustomLabels' };
        }
        const folders = FOLDERED_METADATA_TYPES.has(segment) ? parts.slice(index + 1, -1) : [];
        return { type, member: [...folders, memberName].join('/') };
    }

    // Standard Salesforce metadata files that use source-format folders but aren't in ROOT_METADATA_TYPES.
    if (lowerFileName.endsWith('.flow-meta.xml')) {
        return { type: 'Flow', member: metadataMemberName(fileName) };
    }
    if (lowerFileName.endsWith('.workflow-meta.xml')) {
        return { type: 'Workflow', member: metadataMemberName(fileName) };
    }
    if (lowerFileName.endsWith('.sharingrules-meta.xml')) {
        return { type: 'SharingRules', member: metadataMemberName(fileName) };
    }

    return undefined;
}

function stripMetadataExtension(fileName: string, extension: string): string | undefined {
    const withoutMeta = fileName.replace(/-meta\.xml$/i, '');
    if (!withoutMeta.toLowerCase().endsWith(extension.toLowerCase())) {
        return undefined;
    }
    const member = withoutMeta.slice(0, -extension.length);
    return member || undefined;
}

function metadataMemberName(fileName: string): string {
    const withoutMeta = fileName.replace(/-meta\.xml$/i, '');
    const extensionIndex = withoutMeta.lastIndexOf('.');
    return extensionIndex > 0 ? withoutMeta.slice(0, extensionIndex) : withoutMeta;
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
