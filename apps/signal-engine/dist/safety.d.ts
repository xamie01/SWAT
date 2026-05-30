export type SafetyResult = {
    isSafe: boolean;
    passed: boolean;
    flags: string[];
    warnings: string[];
    liquidity?: number | null;
    top10HolderPct?: number | null;
};
export declare function checkTokenSafety(tokenMint: string): Promise<SafetyResult>;
//# sourceMappingURL=safety.d.ts.map