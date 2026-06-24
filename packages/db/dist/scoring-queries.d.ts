import type { WalletScoreInput, WalletTier } from '@swat/shared';
export declare function getWalletMetrics(address: string): Promise<WalletScoreInput>;
export declare function updateWalletScore(address: string, score: number, tier: WalletTier, metrics: WalletScoreInput): Promise<void>;
export declare function pauseUnderperformingWallets(): Promise<void>;
export declare function promoteHighScoringDiscoveredWallets(): Promise<void>;
export declare function reactivateDormantWallets(): Promise<void>;
/**
 * Delete token-discovered "biggest buyer" wallets that turned out unprofitable
 * once their history was backfilled and scored. Keep criterion: realized ROI > 0
 * AND win rate >= 0.5. Only wallets with enough scored data (total_trades >=
 * minTrades) are judged; an unscored wallet has NULL realized_roi, so the
 * `realized_roi > 0` test is NULL and it is NOT selected (left to be judged once
 * scored). Early-buyer wallets ('token-early') are never touched here.
 *
 * Returns the addresses removed (the caller cascade-deletes each).
 */
export declare function findUnprofitableBigBuyers(minTrades?: number): Promise<string[]>;
/**
 * Cascade-delete the unprofitable 'token-big' wallets found by
 * findUnprofitableBigBuyers. Runs in the scorer batch AFTER scoring (so
 * realized_roi/win_rate are populated) and BEFORE clustering (so dead wallets
 * don't pollute clusters). 'token-early' wallets are never considered. Returns
 * the number removed.
 */
export declare function pruneUnprofitableBigBuyers(minTrades?: number): Promise<number>;
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