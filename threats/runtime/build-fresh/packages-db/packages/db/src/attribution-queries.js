import { query } from './client.js';
const EXPECTANCY_GROUPS_SQL = `
  SELECT
    pattern_type,
    tier,
    chain,
    execution_mode,
    COUNT(*)::int AS eligible_outcomes,
    AVG(CASE WHEN hit_result THEN 1.0 ELSE 0.0 END) * 100 AS hit_rate_pct,
    AVG(realized_pnl_usd) FILTER (WHERE realized_pnl_usd > 0) AS avg_win_usd,
    AVG(realized_pnl_usd) FILTER (WHERE realized_pnl_usd < 0) AS avg_loss_usd,
    AVG(realized_pnl_usd) AS expectancy_usd
  FROM signal_outcomes
  WHERE execution_mode <> 'shadow'
    AND realized_pnl_usd IS NOT NULL
    AND hit_result IS NOT NULL
  GROUP BY pattern_type, tier, chain, execution_mode
  ORDER BY pattern_type, chain, tier NULLS LAST, execution_mode
`;
/**
 * Rebuilds outcomes from filled live and paper trades. A row is realized only
 * when complete buy and sell amounts are available; open or incomplete
 * positions retain NULL P&L and never become losses by default.
 */
export async function runNightlyAttribution() {
    await query(`
    WITH trade_totals AS (
      SELECT
        t.signal_id,
        t.chain,
        COALESCE(t.execution_mode, 'paper') AS execution_mode,
        SUM(t.amount_usd + COALESCE(t.fee_usd, 0))
          FILTER (WHERE t.direction = 'buy') AS buy_usd,
        SUM(t.token_amount) FILTER (WHERE t.direction = 'buy') AS buy_tokens,
        SUM(t.amount_usd - COALESCE(t.fee_usd, 0))
          FILTER (WHERE t.direction = 'sell') AS sell_usd,
        SUM(t.token_amount) FILTER (WHERE t.direction = 'sell') AS sell_tokens,
        BOOL_AND(t.amount_usd IS NOT NULL AND t.token_amount IS NOT NULL)
          FILTER (WHERE t.direction = 'buy') AS complete_buys,
        BOOL_AND(t.amount_usd IS NOT NULL AND t.token_amount IS NOT NULL)
          FILTER (WHERE t.direction = 'sell') AS complete_sells
      FROM trades t
      WHERE t.signal_id IS NOT NULL
        AND t.status IN ('filled', 'partial')
        AND (t.execution_mode IS NULL OR t.execution_mode <> 'shadow')
      GROUP BY t.signal_id, t.chain, COALESCE(t.execution_mode, 'paper')
    ),
    trade_outcomes AS (
      SELECT
        signal_id,
        chain,
        execution_mode,
        buy_usd / NULLIF(buy_tokens, 0) AS entry_price_usd,
        CASE
          WHEN complete_buys
           AND complete_sells
           AND buy_tokens > 0
           AND sell_tokens > 0
          THEN sell_usd - (sell_tokens * (buy_usd / NULLIF(buy_tokens, 0)))
          ELSE NULL
        END AS realized_pnl_usd
      FROM trade_totals
    )
    INSERT INTO signal_outcomes (
      signal_id,
      pattern_type,
      chain,
      cluster_id,
      tier,
      execution_mode,
      entry_price_usd,
      price_1h_usd,
      pnl_1h_pct,
      price_24h_usd,
      pnl_24h_pct,
      realized_pnl_usd,
      hit_result
    )
    SELECT
      s.id,
      s.pattern_type,
      outcome.chain,
      s.cluster_id,
      CASE
        WHEN wc.avg_composite_score IS NULL THEN NULL
        WHEN wc.avg_composite_score >= 90 THEN 'elite'
        WHEN wc.avg_composite_score >= 75 THEN 'pro'
        WHEN wc.avg_composite_score >= 60 THEN 'promising'
        ELSE 'speculative'
      END,
      outcome.execution_mode,
      outcome.entry_price_usd,
      p1.price_usd,
      CASE
        WHEN outcome.entry_price_usd > 0 AND p1.price_usd IS NOT NULL
        THEN (p1.price_usd - outcome.entry_price_usd) / outcome.entry_price_usd * 100
        ELSE NULL
      END,
      p24.price_usd,
      CASE
        WHEN outcome.entry_price_usd > 0 AND p24.price_usd IS NOT NULL
        THEN (p24.price_usd - outcome.entry_price_usd) / outcome.entry_price_usd * 100
        ELSE NULL
      END,
      outcome.realized_pnl_usd,
      CASE
        WHEN outcome.realized_pnl_usd IS NULL THEN NULL
        ELSE outcome.realized_pnl_usd > 0
      END
    FROM signals s
    JOIN trade_outcomes outcome ON outcome.signal_id = s.id
    LEFT JOIN wallet_clusters wc ON wc.id = s.cluster_id
    LEFT JOIN LATERAL (
      SELECT ps.price_usd
      FROM price_snapshots ps
      WHERE ps.token_mint = s.token_mint
        AND ps.chain = outcome.chain
        AND ps.snapshot_at >= s.created_at + INTERVAL '50 minutes'
        AND ps.snapshot_at <= s.created_at + INTERVAL '70 minutes'
      ORDER BY ABS(EXTRACT(EPOCH FROM (
        ps.snapshot_at - (s.created_at + INTERVAL '1 hour')
      )))
      LIMIT 1
    ) p1 ON TRUE
    LEFT JOIN LATERAL (
      SELECT ps.price_usd
      FROM price_snapshots ps
      WHERE ps.token_mint = s.token_mint
        AND ps.chain = outcome.chain
        AND ps.snapshot_at >= s.created_at + INTERVAL '23 hours'
        AND ps.snapshot_at <= s.created_at + INTERVAL '25 hours'
      ORDER BY ABS(EXTRACT(EPOCH FROM (
        ps.snapshot_at - (s.created_at + INTERVAL '24 hours')
      )))
      LIMIT 1
    ) p24 ON TRUE
    ON CONFLICT (signal_id, chain, execution_mode) DO UPDATE SET
      pattern_type = EXCLUDED.pattern_type,
      cluster_id = EXCLUDED.cluster_id,
      tier = EXCLUDED.tier,
      entry_price_usd = EXCLUDED.entry_price_usd,
      price_1h_usd = EXCLUDED.price_1h_usd,
      pnl_1h_pct = EXCLUDED.pnl_1h_pct,
      price_24h_usd = EXCLUDED.price_24h_usd,
      pnl_24h_pct = EXCLUDED.pnl_24h_pct,
      realized_pnl_usd = EXCLUDED.realized_pnl_usd,
      hit_result = EXCLUDED.hit_result
  `);
}
export async function getExpectancyReport() {
    return query(EXPECTANCY_GROUPS_SQL);
}
async function getExpectancyConfigSnapshot() {
    const configRows = await query(`
    SELECT key, value, updated_at
    FROM config
    WHERE key IN ('signals', 'trading', 'risk', 'execution_config')
    ORDER BY key
  `);
    return Object.fromEntries(configRows.map((row) => [row.key, {
            value: row.value,
            updated_at: row.updated_at
        }]));
}
/** Persists an immutable report and atomically updates the latest-report config. */
export async function persistExpectancyReport() {
    const rows = await getExpectancyReport();
    const configSnapshot = await getExpectancyConfigSnapshot();
    const [report] = await query(`
    WITH saved AS (
      INSERT INTO expectancy_reports (config_snapshot, rows)
      VALUES ($1::jsonb, $2::jsonb)
      RETURNING id, generated_at, config_snapshot, rows
    ),
    latest AS (
      INSERT INTO config (key, value)
      SELECT
        'expectancy_report',
        jsonb_build_object(
          'id', saved.id,
          'generated_at', saved.generated_at,
          'config_snapshot', saved.config_snapshot,
          'rows', saved.rows
        )
      FROM saved
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW()
      RETURNING key
    )
    SELECT saved.id, saved.generated_at, saved.config_snapshot, saved.rows
    FROM saved
    CROSS JOIN latest
  `, [JSON.stringify(configSnapshot), JSON.stringify(rows)]);
    if (!report)
        throw new Error('Expectancy report persistence returned no row');
    return report;
}
export async function getLatestExpectancyReport() {
    const rows = await query(`
    SELECT id, generated_at, config_snapshot, rows
    FROM expectancy_reports
    ORDER BY generated_at DESC, id DESC
    LIMIT 1
  `);
    return rows[0] ?? null;
}
export async function getAttributionLatencyReport() {
    return query(`
    SELECT
      t.chain,
      s.pattern_type,
      CASE
        WHEN wc.avg_composite_score IS NULL THEN NULL
        WHEN wc.avg_composite_score >= 90 THEN 'elite'
        WHEN wc.avg_composite_score >= 75 THEN 'pro'
        WHEN wc.avg_composite_score >= 60 THEN 'promising'
        ELSE 'speculative'
      END AS tier,
      COALESCE(t.execution_mode, 'paper') AS execution_mode,
      COUNT(*)::int AS sample_count,
      percentile_cont(0.50) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (t.confirmed_at - s.detected_at)) * 1000
      ) AS p50_detection_to_confirmation_ms,
      percentile_cont(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (t.confirmed_at - s.detected_at)) * 1000
      ) AS p95_detection_to_confirmation_ms,
      percentile_cont(0.50) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (t.confirmed_at - t.submitted_at)) * 1000
      ) AS p50_submission_to_confirmation_ms,
      percentile_cont(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (t.confirmed_at - t.submitted_at)) * 1000
      ) AS p95_submission_to_confirmation_ms
    FROM trades t
    JOIN signals s ON s.id = t.signal_id
    LEFT JOIN wallet_clusters wc ON wc.id = s.cluster_id
    WHERE t.status IN ('filled', 'partial')
      AND (t.execution_mode IS NULL OR t.execution_mode <> 'shadow')
      AND s.detected_at IS NOT NULL
      AND t.submitted_at IS NOT NULL
      AND t.confirmed_at IS NOT NULL
      AND t.confirmed_at >= s.detected_at
      AND t.confirmed_at >= t.submitted_at
      AND t.confirmed_at >= NOW() - INTERVAL '24 hours'
    GROUP BY t.chain, s.pattern_type, wc.avg_composite_score, COALESCE(t.execution_mode, 'paper')
    ORDER BY t.chain, s.pattern_type, wc.avg_composite_score DESC NULLS LAST, COALESCE(t.execution_mode, 'paper')
  `);
}
export async function getLiveShadowCostReport() {
    return query(`
    SELECT
      live.chain,
      COUNT(*)::int AS matched_trades,
      AVG(
        CASE live.direction
          WHEN 'buy' THEN ((live.price_usd - shadow.price_usd) / shadow.price_usd) * 10000
          WHEN 'sell' THEN ((shadow.price_usd - live.price_usd) / shadow.price_usd) * 10000
        END
      ) AS avg_execution_cost_bps
    FROM trades live
    JOIN trades shadow ON shadow.shadow_of = live.id
    WHERE live.execution_mode = 'live'
      AND shadow.execution_mode = 'shadow'
      AND live.status IN ('filled', 'partial')
      AND shadow.status IN ('filled', 'partial')
      AND shadow.chain = live.chain
      AND live.direction = shadow.direction
      AND live.price_usd > 0
      AND shadow.price_usd > 0
    GROUP BY live.chain
    ORDER BY live.chain
  `);
}
export async function getAttributionLedger(limit = 50) {
    const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 50;
    const boundedLimit = Math.max(1, Math.min(200, requestedLimit));
    return query(`
    SELECT
      t.id AS trade_id,
      t.signal_id,
      t.chain,
      s.pattern_type,
      COALESCE(t.execution_mode, 'paper') AS execution_mode,
      t.executed_at,
      s.detected_at,
      t.submitted_at,
      t.confirmed_at,
      t.slippage_bps,
      outcome.realized_pnl_usd
    FROM trades t
    JOIN signals s ON s.id = t.signal_id
    LEFT JOIN signal_outcomes outcome
      ON outcome.signal_id = t.signal_id
     AND outcome.chain = t.chain
     AND outcome.execution_mode = COALESCE(t.execution_mode, 'paper')
    WHERE t.status IN ('filled', 'partial')
      AND (t.execution_mode IS NULL OR t.execution_mode <> 'shadow')
    ORDER BY t.executed_at DESC, t.id DESC
    LIMIT $1
  `, [boundedLimit]);
}
export async function getAttributionDashboard() {
    const [report, latency, liveVsShadow, ledger] = await Promise.all([
        getLatestExpectancyReport(),
        getAttributionLatencyReport(),
        getLiveShadowCostReport(),
        getAttributionLedger()
    ]);
    return { report, latency, live_vs_shadow: liveVsShadow, ledger };
}
//# sourceMappingURL=attribution-queries.js.map