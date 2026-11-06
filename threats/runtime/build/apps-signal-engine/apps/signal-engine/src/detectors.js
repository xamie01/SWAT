/**
 * Cluster pattern detectors (checklist S4-M26).
 *
 * Extracted from index.ts so detector queries, scoring math, and signal
 * payloads can be unit tested without starting intervals or establishing
 * Redis connections at module import time.
 *
 * All four cluster detectors emit signals with `suppressTrade: true`
 * (discovery and alerting only — ADR-0005 §6.1). Copy trades derive strictly
 * from `source_trade` events.
 */
// ─── SQL Queries ─────────────────────────────────────────────────────────────
export const SNIPE_DETECTOR_QUERY = `
  SELECT
    t.target_token              AS token_mint,
    cm.cluster_id,
    COUNT(DISTINCT t.wallet_address)::int AS buyer_count,
    wc.confidence               AS cluster_confidence,
    COALESCE(wc.total_realized_roi, 0) AS cluster_roi
  FROM transactions t
  JOIN cluster_memberships cm ON t.wallet_address = cm.wallet_address
  JOIN wallet_clusters wc ON cm.cluster_id = wc.id
  WHERE t.direction = 'buy'
    AND t.timestamp > NOW() - INTERVAL '5 minutes'
    AND t.target_token IS NOT NULL
  GROUP BY t.target_token, cm.cluster_id, wc.confidence, wc.total_realized_roi
  HAVING COUNT(DISTINCT t.wallet_address) >= 3
`;
export const ACCUMULATION_DETECTOR_QUERY = `
  SELECT
    t.target_token              AS token_mint,
    cm.cluster_id,
    SUM(t.amount_in_usd)        AS buy_volume,
    COUNT(DISTINCT DATE(t.timestamp)) AS buy_sessions,
    wc.confidence               AS cluster_confidence
  FROM transactions t
  JOIN cluster_memberships cm ON t.wallet_address = cm.wallet_address
  JOIN wallet_clusters wc ON cm.cluster_id = wc.id
  WHERE t.direction = 'buy'
    AND t.timestamp > NOW() - INTERVAL '7 days'
    AND t.amount_in_usd IS NOT NULL
    AND t.target_token IS NOT NULL
  GROUP BY t.target_token, cm.cluster_id, wc.confidence
  HAVING COUNT(DISTINCT DATE(t.timestamp)) >= 3
     AND SUM(t.amount_in_usd) > 50000
`;
export const ROTATION_DETECTOR_QUERY = `
  WITH sells AS (
    SELECT t.target_token AS sold_token, cm.cluster_id, t.wallet_address, t.timestamp
    FROM transactions t
    JOIN cluster_memberships cm ON t.wallet_address = cm.wallet_address
    WHERE t.direction = 'sell'
      AND t.timestamp > NOW() - INTERVAL '1 hour'
  ),
  buys AS (
    SELECT t.target_token AS bought_token, cm.cluster_id, t.wallet_address, t.timestamp
    FROM transactions t
    JOIN cluster_memberships cm ON t.wallet_address = cm.wallet_address
    WHERE t.direction = 'buy'
      AND t.timestamp > NOW() - INTERVAL '1 hour'
  )
  SELECT
    s.sold_token     AS token_out,
    b.bought_token   AS token_in,
    s.cluster_id,
    COUNT(DISTINCT s.wallet_address) AS actor_count,
    wc.confidence    AS cluster_confidence
  FROM sells s
  JOIN buys b ON s.cluster_id = b.cluster_id
    AND s.wallet_address = b.wallet_address
    AND b.timestamp > s.timestamp
    AND b.bought_token != s.sold_token
  JOIN wallet_clusters wc ON s.cluster_id = wc.id
  GROUP BY s.sold_token, b.bought_token, s.cluster_id, wc.confidence
  HAVING COUNT(DISTINCT s.wallet_address) >= 2
`;
export const EXIT_DETECTOR_QUERY = `
  WITH cluster_sizes AS (
    SELECT cluster_id, COUNT(*) AS member_count
    FROM cluster_memberships
    GROUP BY cluster_id
  ),
  recent_sells AS (
    SELECT
      t.target_token,
      cm.cluster_id,
      COUNT(DISTINCT t.wallet_address) AS seller_count,
      SUM(t.amount_out_usd)            AS exit_volume
    FROM transactions t
    JOIN cluster_memberships cm ON t.wallet_address = cm.wallet_address
    WHERE t.direction = 'sell'
      AND t.timestamp > NOW() - INTERVAL '1 hour'
      AND t.amount_out_usd IS NOT NULL
    GROUP BY t.target_token, cm.cluster_id
  )
  SELECT
    rs.target_token         AS token_mint,
    rs.cluster_id,
    rs.seller_count,
    cs.member_count         AS cluster_size,
    rs.exit_volume,
    wc.confidence           AS cluster_confidence
  FROM recent_sells rs
  JOIN cluster_sizes cs ON rs.cluster_id = cs.cluster_id
  JOIN wallet_clusters wc ON rs.cluster_id = wc.id
  WHERE rs.seller_count::float / cs.member_count >= 0.5
    AND rs.exit_volume > 10000
`;
// ─── Pure Scoring Logic ──────────────────────────────────────────────────────
export function scoreSnipePattern(row) {
    const confBonus = Math.round(row.cluster_confidence * 10);
    const roiBonus = Math.min(5, Math.round(row.cluster_roi * 2));
    return Math.min(99, 82 + confBonus + roiBonus);
}
export function scoreAccumulationPattern(row) {
    return Math.min(99, 75 + Math.round(row.cluster_confidence * 10));
}
export function scoreRotationPattern(row) {
    return Math.min(95, 72 + Math.round(row.cluster_confidence * 10) + Math.min(10, row.actor_count * 2));
}
export function scoreExitPattern(row) {
    const signalScore = Math.min(99, 78 + Math.round(row.cluster_confidence * 10));
    const sellerPct = Math.round((row.seller_count / row.cluster_size) * 100);
    return { signalScore, sellerPct };
}
// ─── Execution Runners ───────────────────────────────────────────────────────
export async function runSnipeDetector(queryFn, enqueueFn) {
    const rows = (await queryFn(SNIPE_DETECTOR_QUERY));
    let count = 0;
    for (const row of rows) {
        const signalScore = scoreSnipePattern(row);
        await enqueueFn({
            patternType: 'snipe',
            clusterId: row.cluster_id,
            tokenMint: row.token_mint,
            confidence: row.cluster_confidence,
            signalScore,
            suppressTrade: true,
            triggerData: { buyerCount: row.buyer_count, window: '5m', clusterRoi: row.cluster_roi }
        }).catch((error) => {
            console.error(`[signal-engine] failed to enqueue snipe for ${row.token_mint}`, error);
        });
        count++;
    }
    return count;
}
export async function runAccumulationDetector(queryFn, enqueueFn) {
    const rows = (await queryFn(ACCUMULATION_DETECTOR_QUERY));
    let count = 0;
    for (const row of rows) {
        const signalScore = scoreAccumulationPattern(row);
        await enqueueFn({
            patternType: 'accumulation',
            clusterId: row.cluster_id,
            tokenMint: row.token_mint,
            confidence: row.cluster_confidence,
            signalScore,
            dedupeMinutes: 7 * 24 * 60,
            suppressTrade: true,
            triggerData: {
                buyVolume: row.buy_volume,
                buySessions: row.buy_sessions,
                window: '7d'
            }
        }).catch((error) => {
            console.error(`[signal-engine] failed to enqueue accumulation for ${row.token_mint}`, error);
        });
        count++;
    }
    return count;
}
export async function runRotationDetector(queryFn, enqueueFn) {
    const rows = (await queryFn(ROTATION_DETECTOR_QUERY));
    let count = 0;
    for (const row of rows) {
        const signalScore = scoreRotationPattern(row);
        await enqueueFn({
            patternType: 'rotation',
            clusterId: row.cluster_id,
            tokenMint: row.token_in,
            confidence: row.cluster_confidence,
            signalScore,
            dedupeMinutes: 60,
            suppressTrade: true,
            triggerData: {
                soldToken: row.token_out,
                boughtToken: row.token_in,
                actorCount: row.actor_count,
                window: '1h'
            }
        }).catch((error) => {
            console.error(`[signal-engine] failed to enqueue rotation for ${row.token_in}`, error);
        });
        count++;
    }
    return count;
}
export async function runExitDetector(queryFn, enqueueFn) {
    const rows = (await queryFn(EXIT_DETECTOR_QUERY));
    let count = 0;
    for (const row of rows) {
        const { signalScore, sellerPct } = scoreExitPattern(row);
        await enqueueFn({
            patternType: 'exit',
            clusterId: row.cluster_id,
            tokenMint: row.token_mint,
            confidence: row.cluster_confidence,
            signalScore,
            suppressTrade: true,
            dedupeMinutes: 60,
            triggerData: {
                sellerCount: row.seller_count,
                clusterSize: row.cluster_size,
                sellerPct,
                exitVolume: row.exit_volume,
                window: '1h'
            }
        }).catch((error) => {
            console.error(`[signal-engine] failed to enqueue exit for ${row.token_mint}`, error);
        });
        count++;
    }
    return count;
}
//# sourceMappingURL=detectors.js.map