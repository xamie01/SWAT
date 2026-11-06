import type { LpChain } from '@swat/shared';
/**
 * Tracked LP wallets and their observation tables (`059`, Track D).
 *
 * The pipeline: the wallet indexer records an observation pass into
 * `lp_wallet_snapshots` (raw time series), the PnL calculator (apps/lp Track
 * D3, using the shared net-LP-result function) closes the books per position
 * into `lp_wallet_position_results`, and the leaderboard aggregates only the
 * results table — the screen never re-derives PnL from raw series at request
 * time.
 *
 * Tracked wallets are external addresses (not tenants), so nothing here takes a
 * UserScope. They are all chain-prefixed, same shape as
 * `source_trades.wallet_address`.
 */
export interface TrackedLpWallet {
    readonly id: string;
    readonly chain: LpChain;
    /** Chain-prefixed. */
    readonly walletAddress: string;
    readonly label: string | null;
    readonly pollingCadenceSeconds: number;
    readonly lastIndexedAt: Date | null;
    readonly createdAt: Date;
}
export interface TrackLpWalletInput {
    readonly chain: LpChain;
    /** Chain-prefixed. */
    readonly walletAddress: string;
    readonly label?: string | null;
    readonly pollingCadenceSeconds?: number;
}
export declare function trackLpWallet(input: TrackLpWalletInput): Promise<TrackedLpWallet>;
export declare function untrackLpWallet(chain: LpChain, walletAddress: string): Promise<boolean>;
export declare function listTrackedLpWallets(options?: {
    chain?: LpChain;
    limit?: number;
}): Promise<TrackedLpWallet[]>;
/** One observed position in an index pass. */
export interface WalletPositionObservation {
    /** Chain-prefixed. */
    readonly positionAddress: string;
    /** Chain-prefixed. */
    readonly poolAddress: string;
    readonly capturedAt: Date;
    readonly positionValueUsd: number;
    readonly uncollectedFeesUsd: number;
    readonly inRange: boolean;
}
/**
 * Records one index pass for a wallet: the snapshot rows and the freshness
 * stamp land in one transaction, so a wallet is never marked indexed with
 * observations that failed to write.
 */
export declare function recordLpWalletIndexPass(trackedWalletId: string, observations: readonly WalletPositionObservation[]): Promise<void>;
export interface WalletPositionResultInput {
    /** Chain-prefixed. */
    readonly positionAddress: string;
    /** Chain-prefixed. */
    readonly poolAddress: string;
    readonly chain: LpChain;
    readonly strategyType: 'spot' | 'curve' | 'bidask';
    readonly netResultUsd: number;
    readonly firstObservedAt: Date;
    readonly lastObservedAt: Date;
    readonly closed: boolean;
}
/** Track D3 output: one closed book per position. Upsert, keyed by (wallet, position). */
export declare function upsertLpWalletPositionResult(trackedWalletId: string, input: WalletPositionResultInput): Promise<void>;
export type LeaderboardSort = 'pnl' | 'winRate';
export interface LpLeaderboardEntry {
    readonly trackedWalletId: string;
    readonly chain: LpChain;
    /** Chain-prefixed. */
    readonly walletAddress: string;
    readonly label: string | null;
    readonly realizedPnlUsd: number;
    /** Closed positions only; `null` when the wallet has no closed positions yet. */
    readonly winRate: number | null;
    readonly closedPositionCount: number;
    readonly dominantStrategyType: 'spot' | 'curve' | 'bidask' | null;
}
/**
 * The LP Wallets screen. Win rate counts closed positions only — an open
 * position has no realized result to vote on — and `dominant_strategy_type` is
 * the modal strategy across all observed positions.
 */
export declare function queryLpWalletLeaderboard(options?: {
    chain?: LpChain;
    sort?: LeaderboardSort;
    limit?: number;
}): Promise<LpLeaderboardEntry[]>;
//# sourceMappingURL=lp-tracked-wallets.d.ts.map