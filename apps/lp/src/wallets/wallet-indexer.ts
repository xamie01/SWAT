import type { Chain } from '@swat/shared';
import {
  recordLpWalletIndexPass,
  trackLpWallet,
  untrackLpWallet,
  upsertLpWalletPositionResult
} from '@swat/db';
import { computeWalletPositionPnl, type WalletPositionSnapshotPoint } from './pnl.js';
import type { LpPositionReader, ObservedPosition } from './types.js';

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

export async function runWalletIndexPass(deps: WalletIndexPassDeps): Promise<WalletIndexPassSummary> {
  const listWallets = deps.listWallets ?? defaultListWallets;
  const recordPass = deps.recordPass ?? recordLpWalletIndexPass;
  const upsertResult = deps.upsertResult ?? upsertLpWalletPositionResult;
  const snapshotSeries = deps.snapshotSeries ?? (async () => []);

  const wallets = await listWallets();
  const summary: WalletIndexPassSummary = {
    walletsIndexed: 0,
    positionsObserved: 0,
    resultsClosed: 0,
    failedWallets: []
  };

  for (const wallet of wallets) {
    const reader = deps.readers.find((candidate) => candidate.chain === wallet.chain);
    if (!reader) {
      summary.failedWallets.push(wallet.walletAddress);
      continue;
    }
    try {
      const observed = await reader.readPositions(wallet.walletAddress);
      await recordPass(
        wallet.id,
        observed.map((position) => ({
          positionAddress: position.positionAddress,
          poolAddress: position.poolAddress,
          capturedAt: new Date(),
          positionValueUsd: position.positionValueUsd,
          uncollectedFeesUsd: position.uncollectedFeesUsd,
          inRange: position.inRange
        }))
      );
      summary.walletsIndexed += 1;
      summary.positionsObserved += observed.length;

      for (const position of observed) {
        const series = await snapshotSeries(wallet.id, position.positionAddress);
        const pnl = computeWalletPositionPnl(series);
        if (!pnl) continue;
        await upsertResult(wallet.id, {
          positionAddress: position.positionAddress,
          poolAddress: position.poolAddress,
          chain: reader.chain,
          strategyType: 'spot', // strategy attribution arrives with position metadata; spot is the ladder default
          netResultUsd: pnl.netResultUsd,
          firstObservedAt: pnl.firstObservedAt,
          lastObservedAt: pnl.lastObservedAt,
          closed: pnl.closed
        });
        summary.resultsClosed += 1;
      }
    } catch (error) {
      summary.failedWallets.push(wallet.walletAddress);
      console.error(
        '[lp] wallet index pass failed for',
        wallet.walletAddress,
        error instanceof Error ? error.message : error
      );
    }
  }

  return summary;
}

async function defaultListWallets(): Promise<readonly TrackedWalletRef[]> {
  const { listTrackedLpWallets } = await import('@swat/db');
  const wallets = await listTrackedLpWallets({ limit: 500 });
  return wallets.map((wallet) => ({
    id: wallet.id,
    chain: wallet.chain,
    walletAddress: wallet.walletAddress
  }));
}

export { trackLpWallet, untrackLpWallet };
