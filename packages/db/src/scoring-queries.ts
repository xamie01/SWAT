import { query } from './client.js';
import { deleteWalletCascade } from './wallets.js';
import type { WalletScoreInput, WalletTier } from '@swat/shared';

export async function getWalletMetrics(address: string): Promise<WalletScoreInput> {
  const rows = await query<{
    win_rate: number | null;
    realized_roi: number | null;
    early_entry_score: number | null;
    consistency_score: number | null;
  }>(`
    WITH
    -- All completed positions: tokens where the wallet both bought and sold
    closed_positions AS (
      SELECT
        target_token,
        SUM(CASE WHEN direction = 'buy' THEN amount_in_usd ELSE 0 END)   AS cost_basis,
        SUM(CASE WHEN direction = 'sell' THEN amount_out_usd ELSE 0 END) AS realized_value
      FROM transactions
      WHERE wallet_address = $1
        -- A swap row populates only its own USD side (buys → amount_in_usd,
        -- sells → amount_out_usd). Requiring BOTH non-null dropped almost every
        -- real row; filter per-side instead.
        AND (
          (direction = 'buy'  AND amount_in_usd  IS NOT NULL) OR
          (direction = 'sell' AND amount_out_usd IS NOT NULL)
        )
      GROUP BY target_token
      -- Only count positions where at least some selling occurred (closed)
      HAVING SUM(CASE WHEN direction = 'sell' THEN 1 ELSE 0 END) > 0
    ),
    -- Win rate: positions that returned more than their cost basis
    win_rate_calc AS (
      SELECT
        COUNT(*) FILTER (WHERE realized_value > cost_basis)::float
          / NULLIF(COUNT(*), 0) AS win_rate
      FROM closed_positions
    ),
    -- Realized ROI: aggregate (profit / cost) across all closed positions
    roi_calc AS (
      SELECT
        SUM(realized_value - cost_basis) / NULLIF(SUM(cost_basis), 0) AS realized_roi
      FROM closed_positions
    ),
    -- Early Entry Score: fraction of buys that happened within 10 min of token launch
    early_entry_calc AS (
      SELECT
        COUNT(*) FILTER (
          WHERE t.direction = 'buy'
            AND tok.launch_timestamp IS NOT NULL
            AND t.timestamp < tok.launch_timestamp + INTERVAL '10 minutes'
        )::float
          / NULLIF(COUNT(*) FILTER (WHERE t.direction = 'buy'), 0) AS early_entry_score
      FROM transactions t
      LEFT JOIN tokens tok ON t.target_token = tok.mint
      WHERE t.wallet_address = $1
    ),
    -- Consistency Score: 1 - (std_dev / mean) of monthly ROI, capped at [0,1]
    monthly_roi AS (
      SELECT
        date_trunc('month', t.timestamp) AS month,
        SUM(CASE WHEN t.direction = 'sell' THEN t.amount_out_usd ELSE 0 END) -
        SUM(CASE WHEN t.direction = 'buy'  THEN t.amount_in_usd  ELSE 0 END) AS monthly_pnl
      FROM transactions t
      WHERE t.wallet_address = $1
        AND (
          (t.direction = 'buy'  AND t.amount_in_usd  IS NOT NULL) OR
          (t.direction = 'sell' AND t.amount_out_usd IS NOT NULL)
        )
      GROUP BY month
    ),
    consistency_calc AS (
      SELECT
        CASE
          WHEN AVG(monthly_pnl) = 0 OR COUNT(*) < 2 THEN 0.5
          ELSE GREATEST(0, LEAST(1, 1 - (STDDEV(monthly_pnl) / NULLIF(ABS(AVG(monthly_pnl)), 0))))
        END AS consistency_score
      FROM monthly_roi
    )
    SELECT
      w.win_rate,
      r.realized_roi,
      e.early_entry_score,
      c.consistency_score
    FROM win_rate_calc   w,
         roi_calc        r,
         early_entry_calc e,
         consistency_calc c
  `, [address]);

  const row = rows[0];
  return {
    winRate:          row?.win_rate           ?? 0,
    realizedRoi:      row?.realized_roi       ?? 0,
    earlyEntryScore:  row?.early_entry_score  ?? 0,
    consistencyScore: row?.consistency_score  ?? 0,
  };
}

export async function updateWalletScore(address: string, score: number, tier: WalletTier, metrics: WalletScoreInput) {
  await query(`
    UPDATE wallets SET
      composite_score    = $1,
      tier               = $2,
      win_rate           = $3,
      realized_roi       = $4,
      early_entry_score  = $5,
      consistency_score  = $6,
      updated_at         = NOW()
    WHERE address = $7
  `, [score, tier, metrics.winRate, metrics.realizedRoi, metrics.earlyEntryScore, metrics.consistencyScore, address]);
}

export async function pauseUnderperformingWallets() {
  await query(`
    UPDATE wallets SET status = 'paused'
    WHERE status = 'active'
      AND (
        (total_trades >= 50 AND composite_score < 40)
        -- last_active < ... already excludes NULLs, so no explicit NULL guard needed.
        OR (last_active < NOW() - INTERVAL '30 days')
      )
  `);
}

export async function promoteHighScoringDiscoveredWallets() {
  await query(`
    UPDATE wallets SET priority = 'high'
    WHERE source = 'discovered'
      AND total_trades >= 20
      AND composite_score > 75
      AND priority = 'normal'
  `);
}

export async function reactivateDormantWallets() {
  // Reactivate paused wallets that had a new transaction in the last 7 days,
  // BUT NOT wallets that would immediately be re-paused by the
  // underperformance rule — otherwise a low-score-but-recently-active wallet
  // oscillates active↔paused every nightly batch.
  await query(`
    UPDATE wallets SET status = 'active'
    WHERE status = 'paused'
      AND last_active > NOW() - INTERVAL '7 days'
      AND NOT (total_trades >= 50 AND composite_score < 40)
  `);
}

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
export async function findUnprofitableBigBuyers(minTrades = 5): Promise<string[]> {
  const rows = await query<{ address: string }>(`
    SELECT address
    FROM wallets
    WHERE discovery_method = 'token-big'
      AND total_trades >= $1
      AND NOT (realized_roi > 0 AND win_rate >= 0.5)
  `, [minTrades]);
  return rows.map(r => r.address);
}

/**
 * Cascade-delete the unprofitable 'token-big' wallets found by
 * findUnprofitableBigBuyers. Runs in the scorer batch AFTER scoring (so
 * realized_roi/win_rate are populated) and BEFORE clustering (so dead wallets
 * don't pollute clusters). 'token-early' wallets are never considered. Returns
 * the number removed.
 */
export async function pruneUnprofitableBigBuyers(minTrades = 5): Promise<number> {
  const addresses = await findUnprofitableBigBuyers(minTrades);
  for (const address of addresses) {
    await deleteWalletCascade(address);
  }
  return addresses.length;
}

export async function getActiveWallets() {
  return query<{ address: string }>(`SELECT address FROM wallets WHERE status = 'active'`);
}

export async function getWalletStats() {
  const rows = await query<{
    total: number;
    active: number;
    paused: number;
    elite: number;
    pro: number;
  }>(`
    SELECT
      COUNT(*)                                       AS total,
      COUNT(*) FILTER (WHERE status = 'active')     AS active,
      COUNT(*) FILTER (WHERE status = 'paused')     AS paused,
      COUNT(*) FILTER (WHERE tier = 'elite')        AS elite,
      COUNT(*) FILTER (WHERE tier = 'pro')          AS pro
    FROM wallets
  `);
  return rows[0];
}
