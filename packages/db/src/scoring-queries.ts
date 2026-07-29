import { query } from './client.js';
import { deleteWalletCascade } from './wallets.js';
import type { Chain, WalletScoreInput, WalletTier } from '@swat/shared';

function finiteMetric(value: number | string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getWalletMetrics(address: string, chain: Chain): Promise<WalletScoreInput> {
  const rows = await query<{
    win_rate: number | string | null;
    realized_roi: number | string | null;
    early_entry_score: number | string | null;
    consistency_score: number | string | null;
  }>(`
    WITH
    -- All completed positions: tokens where the wallet both bought and sold
    raw_positions AS (
      SELECT
        tx.target_token,
        SUM(CASE WHEN tx.direction = 'buy' THEN tx.amount_in_usd ELSE 0 END)   AS total_cost_basis,
        SUM(CASE WHEN tx.direction = 'sell' THEN tx.amount_out_usd ELSE 0 END) AS realized_value,
        SUM(CASE WHEN tx.direction = 'buy' THEN tx.amount_out ELSE 0 END)      AS total_tokens_bought,
        SUM(CASE WHEN tx.direction = 'sell' THEN tx.amount_in ELSE 0 END)      AS total_tokens_sold,
        MAX(pm.status) AS pm_status,
        MAX(pm.winning_token_id) AS pm_winning_token,
        MAX(tk.decimals) AS token_decimals
      FROM transactions tx
      LEFT JOIN tokens tk ON tx.target_token = tk.mint AND tx.chain = tk.chain
      LEFT JOIN polymarket_markets pm ON tk.polymarket_condition_id = pm.condition_id
      WHERE tx.wallet_address = $1
        AND tx.chain = $2
        -- A swap row populates only its own USD side (buys → amount_in_usd,
        -- sells → amount_out_usd). Requiring BOTH non-null dropped almost every
        -- real row; filter per-side instead.
        AND (
          (tx.direction = 'buy'  AND tx.amount_in_usd  IS NOT NULL) OR
          (tx.direction = 'sell' AND tx.amount_out_usd IS NOT NULL)
        )
      GROUP BY tx.target_token
      -- Only count positions where at least some selling occurred (closed)
      -- OR the position is tied to a resolved Polymarket market
      HAVING SUM(CASE WHEN tx.direction = 'sell' THEN 1 ELSE 0 END) > 0
          OR MAX(pm.status) = 'closed'
    ),
    closed_positions AS (
      SELECT
        target_token,
        CASE
          WHEN pm_status = 'closed' THEN
            realized_value
              + GREATEST(total_tokens_bought - total_tokens_sold, 0)
                / POWER(10::numeric, COALESCE(token_decimals, 0))
                * CASE WHEN target_token = pm_winning_token THEN 1.0 ELSE 0.0 END
          ELSE realized_value
        END AS realized_value,
        total_cost_basis * LEAST(
          1.0,
          CASE
            WHEN pm_status = 'closed' THEN 1.0
            WHEN total_tokens_bought > 0 THEN (total_tokens_sold / total_tokens_bought)::float
            ELSE 1.0
          END
        ) AS cost_basis
      FROM raw_positions
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
          / NULLIF(COUNT(*) FILTER (WHERE t.direction = 'buy' AND tok.launch_timestamp IS NOT NULL), 0) AS early_entry_score
      FROM transactions t
      LEFT JOIN tokens tok ON t.target_token = tok.mint AND t.chain = tok.chain
      WHERE t.wallet_address = $1
        AND t.chain = $2
    ),
    -- Consistency Score: 1 - (std_dev / mean) of monthly ROI, capped at [0,1]
    monthly_roi AS (
      SELECT
        date_trunc('month', t.timestamp) AS month,
        SUM(CASE WHEN t.direction = 'sell' THEN t.amount_out_usd ELSE 0 END) -
        SUM(CASE WHEN t.direction = 'buy'  THEN t.amount_in_usd  ELSE 0 END) AS monthly_pnl
      FROM transactions t
      WHERE t.wallet_address = $1
        AND t.chain = $2
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
  `, [address, chain]);

  const row = rows[0];
  return {
    chain,
    winRate:          finiteMetric(row?.win_rate),
    realizedRoi:      finiteMetric(row?.realized_roi),
    earlyEntryScore:  finiteMetric(row?.early_entry_score),
    consistencyScore: finiteMetric(row?.consistency_score),
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
      AND chain = $8
  `, [
    score,
    tier,
    metrics.winRate,
    metrics.realizedRoi,
    metrics.earlyEntryScore,
    metrics.consistencyScore,
    address,
    metrics.chain
  ]);
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
export async function findUnprofitableBigBuyers(
  minTrades = 5
): Promise<Array<{ address: string; chain: Chain }>> {
  return query<{ address: string; chain: Chain }>(`
    SELECT w.address, w.chain
    FROM wallets w
    WHERE w.discovery_method = 'token-big'
      AND w.total_trades >= $1
      AND NOT (w.realized_roi > 0 AND w.win_rate >= 0.5)
      AND EXISTS (
        SELECT 1
        FROM transactions t
        WHERE t.wallet_address = w.address
          AND t.chain = w.chain
        GROUP BY t.target_token
        HAVING COUNT(*) FILTER (WHERE t.direction = 'buy') > 0
           AND COUNT(*) FILTER (WHERE t.direction = 'sell') > 0
      )
  `, [minTrades]);
}

/**
 * Cascade-delete the unprofitable 'token-big' wallets found by
 * findUnprofitableBigBuyers. Runs in the scorer batch AFTER scoring (so
 * realized_roi/win_rate are populated) and BEFORE clustering (so dead wallets
 * don't pollute clusters). 'token-early' wallets are never considered. Returns
 * the number removed.
 */
export async function pruneUnprofitableBigBuyers(minTrades = 5): Promise<number> {
  const wallets = await findUnprofitableBigBuyers(minTrades);
  for (const wallet of wallets) {
    await deleteWalletCascade(wallet.address, wallet.chain);
  }
  return wallets.length;
}

export async function getActiveWallets() {
  return query<{ address: string; chain: Chain }>(
    `SELECT address, chain FROM wallets WHERE status = 'active'`
  );
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
