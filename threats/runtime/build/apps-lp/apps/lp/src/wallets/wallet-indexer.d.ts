import type { Chain } from '@swat/shared';
import { recordLpWalletIndexPass, trackLpWallet, untrackLpWallet, upsertLpWalletPositionResult } from '@swat/db';
import { type WalletPositionSnapshotPoint } from './pnl.js';
import type { LpPositionReader } from './types.js';
/**
 * The wallet indexer (Track D4) — storage wiring around the readers.
 *
 * `runWalletIndexPass` is one scheduled sweep: every tracked wallet is read
 * through its chain's reader, the observation becomes a snapshot row, and any
 * position whose series can close the books gets its net result upserted into
 * the results table the leaderboard aggregates.
 *
 * Track D5 (the leaderboard query) lives in `@swat/db`
 * (`queryLpWalletLeaderboard`) because it is a pure SQL aggregation.
 */
export interface TrackedWalletRef {
    readonly id: string;
    readonly chain: Chain;
    readonly walletAddress: string;
}
export interface WalletIndexPassDeps {
    readonly readers: readonly LpPositionReader[];
    readonly listWallets?: () => Promise<readonly TrackedWalletRef[]>;
    readonly recordPass?: typeof recordLpWalletIndexPass;
    readonly upsertResult?: typeof upsertLpWalletPositionResult;
    /** Snapshot series per (tracked wallet id, position address), for PnL closing. */
    readonly snapshotSeries?: (trackedWalletId: string, positionAddress: string) => Promise<readonly WalletPositionSnapshotPoint[]>;
}
export interface WalletIndexPassSummary {
    walletsIndexed: number;
    positionsObserved: number;
    resultsClosed: number;
    failedWallets: string[];
}
export declare function runWalletIndexPass(deps: WalletIndexPassDeps): Promise<WalletIndexPassSummary>;
export { trackLpWallet, untrackLpWallet };
//# sourceMappingURL=wallet-indexer.d.ts.map