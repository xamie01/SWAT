import type { WalletScoreInput, WalletTier } from '@swat/shared';
export declare function getWalletMetrics(address: string): Promise<WalletScoreInput>;
export declare function updateWalletScore(address: string, score: number, tier: WalletTier, metrics: WalletScoreInput): Promise<void>;
export declare function pauseUnderperformingWallets(): Promise<void>;
export declare function promoteHighScoringDiscoveredWallets(): Promise<void>;
export declare function reactivateDormantWallets(): Promise<void>;
export declare function getActiveWallets(): Promise<{
    address: string;
}[]>;
export declare function getWalletStats(): Promise<{
    total: number;
    active: number;
    paused: number;
    elite: number;
    pro: number;
}>;
//# sourceMappingURL=scoring-queries.d.ts.map