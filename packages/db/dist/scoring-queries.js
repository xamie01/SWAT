import { query } from './client.js';
export async function getWalletMetrics(address) {
    const rows = await query(`
    WITH
    -- All completed positions: tokens where the wallet both bought and sold
    closed_positions AS (
      SELECT
        target_token,
        SUM(CASE WHEN direction = 'buy' THEN amount_in_usd ELSE 0 END)   AS cost_basis,
        SUM(CASE WHEN direction = 'sell' THEN amount_out_usd ELSE 0 END) AS realized_value
      FROM transactions
      WHERE wallet_address = $1
        AND amount_in_usd  IS NOT NULL
        AND amount_out_usd IS NOT NULL
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
        AND t.amount_in_usd IS NOT NULL
        AND t.amount_out_usd IS NOT NULL
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
        winRate: row?.win_rate ?? 0,
        realizedRoi: row?.realized_roi ?? 0,
        earlyEntryScore: row?.early_entry_score ?? 0,
        consistencyScore: row?.consistency_score ?? 0,
    };
}
export async function updateWalletScore(address, score, tier, metrics) {
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
        OR (last_active < NOW() - INTERVAL '30 days' AND last_active IS NOT NULL)
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
    // Reactivate paused wallets that had a new transaction in the last 7 days
    await query(`
    UPDATE wallets SET status = 'active'
    WHERE status = 'paused'
      AND last_active > NOW() - INTERVAL '7 days'
  `);
}
export async function getActiveWallets() {
    return query(`SELECT address FROM wallets WHERE status = 'active'`);
}
export async function getWalletStats() {
    const rows = await query(`
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
//# sourceMappingURL=scoring-queries.js.map