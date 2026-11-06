import type { Chain, WalletScoreInput, WalletTier } from '@swat/shared';
export declare function getWalletMetrics(address: string, chain: Chain): Promise<WalletScoreInput>;
export declare function updateWalletScore(address: string, score: number, tier: WalletTier, metrics: WalletScoreInput): Promise<void>;
/**
 * Pauses wallets the platform no longer wants to index for performance reasons.
 *
 * **A subscribed wallet is never paused here.** This sweep was written for a
 * single operator; under tenancy, pausing a wallet a user explicitly chose (and
 * may be paying to track) would silently stop their data with no event and no
 * way to diagnose it. Underperformance is *surfaced* to the user — score and tier
 * are already on the wallet row — not acted on for them.
 *
 * `wallets.status` answers one question: "is the platform indexing this?" A
 * subscriber pins it to `active` regardless of score. The zero-subscriber
 * direction is `pauseUnsubscribedWallets` (D9).
 */
export declare function pauseUnderperformingWallets(): Promise<void>;
/**
 * Pauses wallets nobody subscribes to and the platform has no interest in (D9).
 *
 * Without this, every wallet ever discovered stays in the polling set forever and
 * webhook volume grows monotonically with user churn rather than with active use.
 *
 * "Platform interest" is deliberately broad — clustered, scored, or high-priority
 * wallets stay active even with zero subscribers, because dropping them would
 * corrupt cluster membership and the discovery pipeline's own inputs.
 */
export declare function pauseUnsubscribedWallets(): Promise<void>;
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
export declare function findUnprofitableBigBuyers(minTrades?: number): Promise<Array<{
    address: string;
    chain: Chain;
}>>;
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
    chain: Chain;
}[]>;
export declare function getWalletStats(): Promise<{
    total: number;
    active: number;
    paused: number;
    elite: number;
    pro: number;
}>;
//# sourceMappingURL=scoring-queries.d.ts.map