import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { insertSignalWithDedupe, query } from '@swat/db';
import { REDIS_CHANNELS } from '@swat/shared';
import { checkTokenSafety } from './safety.js';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const alertQueue = new Queue('swat-alerts', { connection: redis });
const tradeQueue = new Queue('swat-trades', { connection: redis });
const MIN_SIGNAL_SCORE = Number(process.env.MIN_SIGNAL_SCORE ?? 70);
// ─── Shared helper ─────────────────────────────────────────────────────────────
async function enqueueSignal(opts) {
    const safety = await checkTokenSafety(opts.tokenMint);
    const signal = await insertSignalWithDedupe({
        patternType: opts.patternType,
        clusterId: opts.clusterId,
        tokenMint: opts.tokenMint,
        confidence: opts.confidence,
        signalScore: opts.signalScore,
        triggerData: opts.triggerData,
        safetyFlags: safety.flags,
        safetyWarnings: safety.warnings
    }, opts.dedupeMinutes ?? 10);
    if (!signal || !signal.inserted) {
        if (signal)
            console.log(`[signal-engine] duplicate skipped: ${signal.id}`);
        return;
    }
    if (opts.signalScore < MIN_SIGNAL_SCORE) {
        console.log(`[signal-engine] signal score ${opts.signalScore} below threshold ${MIN_SIGNAL_SCORE} — logged only`);
        return;
    }
    await alertQueue.add('signal-alert', {
        signalId: signal.id,
        pattern: opts.patternType,
        tokenMint: opts.tokenMint,
        clusterId: opts.clusterId,
        confidence: opts.confidence,
        score: opts.signalScore,
        isSafe: safety.isSafe,
        warnings: safety.warnings,
        liquidity: safety.liquidity,
        top10HolderPct: safety.top10HolderPct,
        ...opts.triggerData
    }, { removeOnComplete: true });
    if (!opts.suppressTrade && safety.isSafe && opts.signalScore >= 80) {
        await tradeQueue.add('signal-trade', {
            signalId: signal.id,
            score: opts.signalScore,
            tokenMint: opts.tokenMint,
            clusterTier: 'promising' // will be enriched from cluster record in executor
        }, { removeOnComplete: true });
    }
    else if (!safety.isSafe) {
        console.log(`[signal-engine] trade blocked — safety flags: ${safety.flags.join(', ')}`);
    }
}
// ─── Pattern A: Snipe ─────────────────────────────────────────────────────────
// 3+ wallets in a cluster buy the same token within 5 minutes
async function detectSnipePattern() {
    const rows = await query(`
    SELECT
      t.target_token              AS token_mint,
      cm.cluster_id,
      COUNT(*)::int               AS buyer_count,
      wc.confidence               AS cluster_confidence,
      COALESCE(wc.total_realized_roi, 0) AS cluster_roi
    FROM transactions t
    JOIN cluster_memberships cm ON t.wallet_address = cm.wallet_address
    JOIN wallet_clusters wc ON cm.cluster_id = wc.id
    WHERE t.direction = 'buy'
      AND t.timestamp > NOW() - INTERVAL '5 minutes'
    GROUP BY t.target_token, cm.cluster_id, wc.confidence, wc.total_realized_roi
    HAVING COUNT(*) >= 3
  `);
    for (const row of rows) {
        // Score = base 82 + cluster confidence bonus + ROI bonus
        const confBonus = Math.round(row.cluster_confidence * 10);
        const roiBonus = Math.min(5, Math.round(row.cluster_roi * 2));
        const signalScore = Math.min(99, 82 + confBonus + roiBonus);
        await enqueueSignal({
            patternType: 'snipe',
            clusterId: row.cluster_id,
            tokenMint: row.token_mint,
            confidence: row.cluster_confidence,
            signalScore,
            triggerData: { buyerCount: row.buyer_count, window: '5m', clusterRoi: row.cluster_roi }
        });
    }
}
// ─── Pattern B: Accumulation ──────────────────────────────────────────────────
// Cluster buys same token across 3+ separate sessions with $50k+ total volume
async function detectAccumulationPattern() {
    const rows = await query(`
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
    GROUP BY t.target_token, cm.cluster_id, wc.confidence
    HAVING COUNT(DISTINCT DATE(t.timestamp)) >= 3
       AND SUM(t.amount_in_usd) > 50000
  `);
    for (const row of rows) {
        const signalScore = Math.min(99, 75 + Math.round(row.cluster_confidence * 10));
        await enqueueSignal({
            patternType: 'accumulation',
            clusterId: row.cluster_id,
            tokenMint: row.token_mint,
            confidence: row.cluster_confidence,
            signalScore,
            dedupeMinutes: 60,
            triggerData: {
                buyVolume: row.buy_volume,
                buySessions: row.buy_sessions,
                window: '7d'
            }
        });
    }
}
// ─── Pattern C: Rotation ──────────────────────────────────────────────────────
// Cluster sells Token A and buys Token B within 1 hour
async function detectRotationPattern() {
    const rows = await query(`
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
  `);
    for (const row of rows) {
        const signalScore = Math.min(95, 72 + Math.round(row.cluster_confidence * 10) + Math.min(10, row.actor_count * 2));
        await enqueueSignal({
            patternType: 'rotation',
            clusterId: row.cluster_id,
            tokenMint: row.token_in, // Alert on the token being bought
            confidence: row.cluster_confidence,
            signalScore,
            dedupeMinutes: 60,
            triggerData: {
                soldToken: row.token_out,
                boughtToken: row.token_in,
                actorCount: row.actor_count,
                window: '1h'
            }
        });
    }
}
// ─── Pattern D: Exit ──────────────────────────────────────────────────────────
// 50%+ of cluster sells >50% of position within 1 hour — SELL SIGNAL
async function detectExitPattern() {
    const rows = await query(`
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
  `);
    for (const row of rows) {
        const signalScore = Math.min(99, 78 + Math.round(row.cluster_confidence * 10));
        const sellerPct = Math.round((row.seller_count / row.cluster_size) * 100);
        await enqueueSignal({
            patternType: 'exit',
            clusterId: row.cluster_id,
            tokenMint: row.token_mint,
            confidence: row.cluster_confidence,
            signalScore,
            suppressTrade: true, // Exit signals do not trigger buys
            dedupeMinutes: 60,
            triggerData: {
                sellerCount: row.seller_count,
                clusterSize: row.cluster_size,
                sellerPct,
                exitVolume: row.exit_volume,
                window: '1h'
            }
        });
    }
}
// ─── Tick ─────────────────────────────────────────────────────────────────────
async function tick() {
    try {
        await Promise.all([
            detectSnipePattern(),
            detectAccumulationPattern(),
            detectRotationPattern(),
            detectExitPattern()
        ]);
    }
    catch (error) {
        console.error('[signal-engine] tick failed', error);
    }
}
setInterval(tick, 15_000);
void tick();
// React immediately to real-time wallet swap events from indexer
const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
await subscriber.subscribe(REDIS_CHANNELS.walletSwap);
subscriber.on('message', (_channel, message) => {
    // Trigger an immediate detection cycle on any new swap
    void tick();
    console.log('[signal-engine] swap event received:', message);
});
console.log('[signal-engine] service running');
//# sourceMappingURL=index.js.map