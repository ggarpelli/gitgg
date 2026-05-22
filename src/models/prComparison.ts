export type ComparisonStatus = 'IDENTICAL' | 'DIFFERENT' | 'MISSING_IN_ENVIRONMENT';

export interface PRComparisonFileResult {
    path: string;
    status: ComparisonStatus;
    promotionContent: string | null;   // conteúdo da HEAD (promotion local)
    environmentContent: string | null; // conteúdo do environment
    promotionBranch: string;           // HEAD (para compatibilidade com UI)
    environmentRef: string;             // ref do environment (origin/X ou X para local)
    patch?: string;                      // diff patch gerado via git diff
}

export interface PRComparisonResult {
    promotionBranch: string;      // detectar de HEAD
    destinationBranch: string;     // selecionado
    environmentBranch: string;     // selecionado (ex: UAT)
    environmentRef: string;        // ref resolved (origin/X ou X)
    results: PRComparisonFileResult[];
    analyzedAt: Date;
}