export type SignatureRecord = {
    signature: string;
};
export type SignaturePageRequest = {
    before?: string;
    limit: number;
};
export type PaginatedSignatures<T extends SignatureRecord> = {
    signatures: T[];
    reachedOldest: boolean;
    capped: boolean;
};
export declare function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number;
export declare function collectSignaturesToOldest<T extends SignatureRecord>(fetchPage: (request: SignaturePageRequest) => Promise<T[]>, options: {
    maxTotal: number;
    pageSize?: number;
}): Promise<PaginatedSignatures<T>>;
export type StarterPackWalletScore = {
    address: string;
    patterns: string[];
    successfulTrades: number;
    totalTrades: number;
    winRate: number | null;
    score: number;
};
export declare function createStarterPackScoreTracker(): {
    recordPattern: (address: string, pattern: string, context: string) => void;
    recordTradeOutcome: (address: string, tradeKey: string, isWin: boolean) => void;
    results: () => StarterPackWalletScore[];
};
//# sourceMappingURL=starter-pack.d.ts.map