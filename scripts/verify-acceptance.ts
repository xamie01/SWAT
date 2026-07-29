import 'dotenv/config';
import { pool } from '../packages/db/src/client.js';

async function main() {
  console.log('--- SWAT Phase 7 Acceptance Verification ---');
  const client = await pool.connect();

  try {
    // ─── G7-A7: Solana Metrics ────────────────────────────────────────────────
    console.log('\n[G7-A7] Solana Acceptance Criteria:');
    
    // 1. Median snipe-to-alert latency
    const solLatency = await client.query(`
      SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (alerted_at - detected_at))) as median_latency_sec
      FROM signals
      WHERE chain = 'solana' AND pattern_type = 'sniper' AND alerted_at IS NOT NULL AND detected_at IS NOT NULL
    `);
    const medLat = solLatency.rows[0]?.median_latency_sec;
    console.log(`  - Median Snipe-to-Alert Latency: ${medLat !== null ? Number(medLat).toFixed(2) + 's' : 'N/A'} (Target: < 60s)`);

    // 2. Positive 1-hour snipe expectancy net of slippage
    const solExpectancy = await client.query(`
      SELECT AVG(realized_pnl_usd) as expectancy_usd
      FROM signal_outcomes
      WHERE chain = 'solana' AND pattern_type = 'sniper'
    `);
    const expUsd = solExpectancy.rows[0]?.expectancy_usd;
    console.log(`  - 1-hour Snipe Expectancy: ${expUsd !== null ? '$' + Number(expUsd).toFixed(2) : 'N/A'} (Target: > $0)`);

    // 3. Executed signals per day from healthy clusters
    const execSignals = await client.query(`
      SELECT COUNT(*)::float / GREATEST(1, EXTRACT(DAY FROM (NOW() - MIN(s.created_at)))) as signals_per_day
      FROM signals s
      JOIN wallet_clusters wc ON s.cluster_id = wc.id
      WHERE s.chain = 'solana' AND s.status = 'executed' AND wc.tier IN ('elite', 'pro')
    `);
    const sigDay = execSignals.rows[0]?.signals_per_day;
    console.log(`  - Executed Signals Per Day (Elite/Pro): ${sigDay !== null ? Number(sigDay).toFixed(2) : 'N/A'} (Target: >= 1)`);


    // ─── G7-A8: Polymarket Metrics ────────────────────────────────────────────
    console.log('\n[G7-A8] Polymarket Acceptance Criteria:');

    // 1. 100% Polymarket signal-context coverage
    const pmContext = await client.query(`
      SELECT 
        COUNT(*) as total_pm_signals,
        SUM(CASE WHEN trigger_data->>'pmQuestion' IS NOT NULL THEN 1 ELSE 0 END) as signals_with_context
      FROM signals
      WHERE chain = 'polygon'
    `);
    const pmTotal = pmContext.rows[0]?.total_pm_signals;
    const pmWithCtx = pmContext.rows[0]?.signals_with_context;
    const pmCoverage = pmTotal > 0 ? (pmWithCtx / pmTotal) * 100 : 0;
    console.log(`  - Signal-Context Coverage: ${pmTotal > 0 ? pmCoverage.toFixed(2) + '%' : 'N/A'} (Target: 100%)`);

    // 2. Resolution-based wallet scoring (proxy: do we have PM markets resolving?)
    const pmResolved = await client.query(`
      SELECT COUNT(*) as resolved_markets
      FROM polymarket_markets
      WHERE status IN ('resolved', 'settled')
    `);
    console.log(`  - Resolved Markets (for scoring): ${pmResolved.rows[0]?.resolved_markets}`);

    // 3. Target ingestion lag below 5 minutes
    const pmLag = await client.query(`
      SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (NOW() - last_ingested_at))) / 60 as lag_mins
      FROM ingestion_health
      WHERE chain = 'polygon'
    `);
    const pmLagMins = pmLag.rows[0]?.lag_mins;
    console.log(`  - Median Ingestion Lag: ${pmLagMins !== null ? Number(pmLagMins).toFixed(2) + 'm' : 'N/A'} (Target: < 5m)`);


    // ─── G7-A9: Robinhood Metrics ─────────────────────────────────────────────
    console.log('\n[G7-A9] Robinhood Acceptance Criteria:');

    // 1. Ingestion completeness above 90% (Proxy: error rate in health table)
    const rhCompleteness = await client.query(`
      SELECT (1.0 - COALESCE(error_rate_24h, 0)) * 100 as completeness_pct
      FROM ingestion_health
      WHERE chain = 'robinhood-chain'
    `);
    const rhComp = rhCompleteness.rows[0]?.completeness_pct;
    console.log(`  - Ingestion Completeness: ${rhComp !== null ? Number(rhComp).toFixed(2) + '%' : 'N/A'} (Target: > 90%)`);

    // 2. Scored-wallet roster with at least 20 classified trades per scored wallet
    const rhScoredWallets = await client.query(`
      SELECT MIN(classified_trades_count) as min_trades
      FROM (
        SELECT w.address, COUNT(t.id) as classified_trades_count
        FROM wallets w
        JOIN transactions t ON w.address = t.wallet_address
        WHERE w.chain = 'robinhood-chain' AND w.tier IS NOT NULL
        GROUP BY w.address
      ) sub
    `);
    const rhMinTrades = rhScoredWallets.rows[0]?.min_trades;
    console.log(`  - Min Trades per Scored Wallet: ${rhMinTrades !== null ? rhMinTrades : 'N/A'} (Target: >= 20)`);

  } catch (e) {
    console.error('Error running verification:', e);
  } finally {
    client.release();
    pool.end();
  }
}

main().catch(console.error);
