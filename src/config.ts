import * as vscode from 'vscode';

export interface GitggConfig {
    fetchBeforeCompare: boolean;
    separateTabsMaxFiles: number;
    diffLineLimit: number;
    snapshotFolder: string;
}

export function getConfig(): GitggConfig {
    const config = vscode.workspace.getConfiguration('gitgg');
    return {
        fetchBeforeCompare: config.get<boolean>('fetchBeforeCompare', true),
        separateTabsMaxFiles: config.get<number>('separateTabsMaxFiles', 5),
        diffLineLimit: config.get<number>('diffLineLimit', 100),
        snapshotFolder: config.get<string>('snapshotFolder', 'snapshot')
    };
}
