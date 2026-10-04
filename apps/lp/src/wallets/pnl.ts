import { netLpResult } from '../domain/net-lp-result.js';

/**
 * Per-wallet PnL calculator (Track D3).
 *
 * Closes the books for one tracked wallet position from its snapshot series,
 * reusing the Track A net-LP-result function verbatim. The series decomposition
 * is honest about what snapshots can and cannot know:
 *
 *   - `feesEarned` = the growth of uncollected fees between first and last
 *     observation. Fees *collected mid-series* are invisible to this method —
 *     the value is documented, and the live indexer will fold fee-claim
 *     events into the series later.
 *   - `inventoryChange` = the growth of inventory value. Sign-convention note:
 *     inventory *growth* is positive, and netLpResult adds it.
 *   - `impermanentLoss`, `gasCost`, `rebalanceCost` are 0 here: the snapshot
 *     series cannot separate IL from inventory drift without a HODL baseline,
 *     and gas/repositioning are execution-side facts. What this computes is
 *     "series PnL" — a floor on the true net result.
 */

export interface WalletPositionSnapshotPoint {
  readonly capturedAt: Date;
  readonly positionValueUsd: number;
  readonly uncollectedFeesUsd: number;
  readonly inRange: boolean;
}

export interface WalletPositionPnl {
  readonly netResultUsd: number;
  readonly feesEarnedUsd: number;
  readonly inventoryChangeUsd: number;
  readonly firstObservedAt: Date;
  readonly lastObservedAt: Date;
  /** True when the series shows the position emptied out (value and fees at zero). */
  readonly closed: boolean;
}

export function computeWalletPositionPnl(
  series: readonly WalletPositionSnapshotPoint[]
): WalletPositionPnl | null {
  if (series.length < 2) {
    // One point is an observation, not a result — nothing has been earned or
    // lost *over time* yet.
    return null;
  }

  const ordered = [...series].sort(
    (left, right) => left.capturedAt.getTime() - right.capturedAt.getTime()
  );
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;

  const feesEarnedUsd = last.uncollectedFeesUsd - first.uncollectedFeesUsd;
  const inventoryChangeUsd = last.positionValueUsd - first.positionValueUsd;

  const netResultUsd = netLpResult({
    feesEarned: feesEarnedUsd,
    impermanentLoss: 0,
    gasCost: 0,
    rebalanceCost: 0,
    inventoryChange: inventoryChangeUsd
  });

  return {
    netResultUsd,
    feesEarnedUsd,
    inventoryChangeUsd,
    firstObservedAt: first.capturedAt,
    lastObservedAt: last.capturedAt,
    closed: last.positionValueUsd === 0 && last.uncollectedFeesUsd === 0
  };
}
