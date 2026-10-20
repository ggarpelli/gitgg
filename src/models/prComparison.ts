export type ComparisonStatus = 'IDENTICAL' | 'DIFFERENT' | 'MISSING_IN_ENVIRONMENT' | 'MISSING_IN_PROMOTION';

export interface PRComparisonFileResult {
    path: string;
    status: ComparisonStatus;
}

export interface PRComparisonReportInput {
    promotionBranch: string;
    destinationBranch: string;
    environmentBranch: string;
    results: PRComparisonFileResult[];
    generatedAt: Date;
}
