import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import {
  getPolymarketOutcomeContext,
  insertSignalWithDedupe,
  insertSourceTradeSignal,
  listSourceTradeSignalCandidates,
  markSourceTradeSignalDispatched,
  query,
  type SourceTradeSignalCandidate
} from '@swat/db';
import {
  REDIS_CHANNELS,
  scoreToTier,
  fetchTokenMetadata,
  initLogger,
  stripChainPrefix
} from '@swat/shared';
import { checkTokenSafety } from './safety.js';
import { requirePolymarketSignalContext } from './polymarket-context.js';

initLogger('signal-engine');

/**
 * Resolve a cluster's tier from its average composite score (same thresholds as
 * wallet tiers). Used to size trades correctly — previously the trade payload
 * hardcoded 'promising', so every auto-trade was sized at the 0.5x multiplier
 * regardless of the cluster's real quality.
 */
async function getClusterTier(clusterId: string): Promise<'elite' | 'pro' | 'promising' | 'speculative'> {
  const rows = await query<{ avg_composite_score: number | null }>(
    `SELECT avg_composite_score FROM wallet_clusters WHERE id = $1`,
    [clusterId]
  );
  const score = rows[0]?.avg_composite_score;
  return score != null ? scoreToTier(Number(score)) : 'promising';
}

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const alertQueue = new Queue('swat-alerts', { connection: redis });
const tradeQueue = new Queue('swat-trades', { connection: redis });

const MIN_SIGNAL_SCORE = Number(process.env.MIN_SIGNAL_SCORE ?? 70);
const SOURCE_COPY_MAX_EVENT_AGE_MS = Number(
  process.env.SOURCE_COPY_MAX_EVENT_AGE_MS ?? 10 * 60_000
);
const SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS = Number(
  process.env.SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS ?? 10 * 60_000
);

for (const [name, value] of [
  ['MIN_SIGNAL_SCORE', MIN_SIGNAL_SCORE],
  ['SOURCE_COPY_MAX_EVENT_AGE_MS', SOURCE_COPY_MAX_EVENT_AGE_MS],
  ['SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS', SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS]
] as const) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
}

// ─── Shared helper ─────────────────────────────────────────────────────────────

async function enqueueSignal(opts: {
  patternType: string;
  clusterId: string | null;
  tokenMint: string;
  confidence: number;
  signalScore: number;
  triggerData: Record<string, unknown>;
  dedupeMinutes?: number;
  suppressTrade?: boolean;
  sourceTrade?: SourceTradeSignalCandidate;
}) {
  // 1. Check Blacklist config setting
  try {
    const blacklistRows = await query<{ value: any }>(`SELECT value FROM config WHERE key = 'blacklist'`);
    const rawValue = blacklistRows[0]?.value;
    if (rawValue) {
      let blacklist: string[] = [];
      if (Array.isArray(rawValue)) {
        blacklist = rawValue;
      } else if (typeof rawValue === 'string') {
        try {
          const parsed = JSON.parse(rawValue);
          if (Array.isArray(parsed)) {
            blacklist = parsed;
          } else if (typeof parsed === 'string') {
            try {
              const parsed2 = JSON.parse(parsed);
              blacklist = Array.isArray(parsed2) ? parsed2 : [parsed];
            } catch {
              blacklist = [parsed];
            }
          }
        } catch {
          const trimmed = rawValue.trim();
          blacklist = trimmed.startsWith('[') 
            ? [] 
            : trimmed.split(',').map(s => s.trim());
        }
      } else if (typeof rawValue === 'object' && rawValue !== null) {
        blacklist = Object.values(rawValue).filter(v => typeof v === 'string') as string[];
      }
      
      const tokenKey = stripChainPrefix(opts.tokenMint);
      if (blacklist.some((entry) => stripChainPrefix(entry) === tokenKey)) {
        console.log(`[signal-engine] SKIPPED: token ${opts.tokenMint} is in the blacklist.`);
        return;
      }
    }
  } catch (e: any) {
    console.error(`[signal-engine] failed to read blacklist config:`, e.message);
  }

  // 2. Fetch token metadata (Name & Symbol) from Helius / DexScreener
  let tokenName = 'Unknown';
  let tokenSymbol = 'UNKNOWN';
  let chain = opts.tokenMint.includes(':') ? opts.tokenMint.split(':')[0] : 'solana';

  try {
    const meta = await fetchTokenMetadata(opts.tokenMint);
    if (meta?.name && meta?.symbol) {
      tokenName = meta.name;
      tokenSymbol = meta.symbol;
      
      // Upsert into the tokens table so other parts of the database have the metadata
      await query(
        `INSERT INTO tokens (mint, name, symbol, chain)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (mint) DO UPDATE SET name = EXCLUDED.name, symbol = EXCLUDED.symbol`,
        [opts.tokenMint, tokenName, tokenSymbol, chain]
      );
    }
  } catch (e: any) {
    console.error(`[signal-engine] failed to fetch metadata for ${opts.tokenMint}:`, e.message);
  }

  if (chain === 'polygon') {
    const context = requirePolymarketSignalContext(
      await getPolymarketOutcomeContext(opts.tokenMint),
      opts.tokenMint
    );
    tokenName = context.tokenName;
    tokenSymbol = context.tokenSymbol;
    Object.assign(opts.triggerData, context.triggerData);
  }

  const safety = await checkTokenSafety(opts.tokenMint);

  const signal = opts.sourceTrade
    ? await insertSourceTradeSignal({
        sourceTradeId: opts.sourceTrade.sourceTradeId,
        clusterId: opts.clusterId,
        confidence: opts.confidence,
        signalScore: opts.signalScore,
        triggerData: opts.triggerData,
        safetyFlags: safety.flags,
        safetyWarnings: safety.warnings,
        tokenName,
        tokenSymbol,
        maxEventAgeMs: SOURCE_COPY_MAX_EVENT_AGE_MS,
        maxPositionEvidenceAgeMs: SOURCE_COPY_POSITION_EVIDENCE_MAX_AGE_MS
      })
    : await insertSignalWithDedupe(
        {
          patternType:    opts.patternType,
          clusterId:      opts.clusterId,
          tokenMint:      opts.tokenMint,
          confidence:     opts.confidence,
          signalScore:    opts.signalScore,
          triggerData:    opts.triggerData,
          safetyFlags:    safety.flags,
          safetyWarnings: safety.warnings,
          tokenName,
          tokenSymbol
        },
        opts.dedupeMinutes ?? 10
      );

  if (!signal || (!signal.inserted && !opts.sourceTrade)) {
    if (signal) console.log(`[signal-engine] duplicate skipped: ${signal.id}`);
    return;
  }

  if (opts.signalScore < MIN_SIGNAL_SCORE) {
    console.log(`[signal-engine] signal score ${opts.signalScore} below threshold ${MIN_SIGNAL_SCORE} — logged only`);
    if (opts.sourceTrade) await markSourceTradeSignalDispatched(signal.id);
    return;
  }

  await alertQueue.add('signal-alert', {
    signalId:     signal.id,
    pattern:      opts.patternType,
    tokenMint:    opts.tokenMint,
    clusterId:    opts.clusterId,
    confidence:   opts.confidence,
    score:        opts.signalScore,
    isSafe:       safety.isSafe,
    warnings:     safety.warnings,
    liquidity:    safety.liquidity,
    top10HolderPct: safety.top10HolderPct,
    ...opts.triggerData,
    sourceTradeId: opts.sourceTrade?.sourceTradeId,
    direction: opts.sourceTrade?.side
  }, {
    ...(opts.sourceTrade ? { jobId: `source-alert-${signal.id}` } : {}),
    removeOnComplete: true,
    // Retry transient Telegram failures (429/5xx) with backoff; the alert
    // worker is idempotent via signals.alerted_at so retries can't double-send.
    attempts: 4,
    backoff: { type: 'exponential', delay: 2000 }
  });

  if (!opts.suppressTrade && safety.isSafe && opts.signalScore >= 80) {
    const clusterTier = opts.clusterId
      ? await getClusterTier(opts.clusterId)
      : scoreToTier(opts.signalScore);
    console.log(`[signal-engine] ✅ TRADE QUEUED: ${opts.tokenMint} | score: ${opts.signalScore} | tier: ${clusterTier}`);
    await tradeQueue.add('signal-trade', {
      signalId:    signal.id,
      score:       opts.signalScore,
      tokenMint:   opts.tokenMint,
      clusterTier,
      sourceTradeId: opts.sourceTrade?.sourceTradeId,
      direction: opts.sourceTrade?.side
    }, {
      ...(opts.sourceTrade ? { jobId: `source-trade-${signal.id}` } : {}),
      removeOnComplete: true,
      attempts: 4,
      backoff: { type: 'exponential', delay: 5000 }
    });
  } else if (!safety.isSafe) {
    console.log(`[signal-engine] ❌ trade blocked — safety flags: ${safety.flags.join(', ')} | token: ${opts.tokenMint}`);
  } else if (opts.suppressTrade) {
    console.log(`[signal-engine] ⏭️ trade suppressed (exit signal) | token: ${opts.tokenMint}`);
  } else {
    console.log(`[signal-engine] ⏭️ trade skipped — score ${opts.signalScore} < 80 | token: ${opts.tokenMint}`);
  }

  if (opts.sourceTrade) {
    await markSourceTradeSignalDispatched(signal.id);
  }
}

export async function processSourceTradeSignals(sourceTradeId?: string): Promise<void> {
  const candidates = await listSourceTradeSignalCandidates({
    sourceTradeId,
    maxEventAgeMs: SOURCE_COPY_MAX_EVENT_AGE_MS,
    limit: sourceTradeId ? 1 : 100
  });
  for (const candidate of candidates) {
    await enqueueSignal({
      patternType: 'source_trade',
      clusterId: candidate.clusterId,
      tokenMint: candidate.tokenMint,
      confidence: candidate.clusterConfidence,
      signalScore: candidate.walletScore,
      sourceTrade: candidate,
      triggerData: {
        sourceWallet: candidate.walletAddress,
        sourceQuantity: candidate.quantity,
        sourceAmountUsd: candidate.amountUsd,
        sourcePriceUsd: candidate.priceUsd,
        sourceEventAt: candidate.eventAt.toISOString(),
        sourceWalletTier: candidate.walletTier
      }
    }).catch((error) => {
      console.error(
        `[signal-engine] failed to derive source signal ${candidate.sourceTradeId}`,
        error
      );
    });
  }
}

// ─── Pattern A: Snipe ─────────────────────────────────────────────────────────
// 3+ wallets in a cluster buy the same token within 5 minutes

async function detectSnipePattern() {
  const rows = await query<{
    token_mint: string;
    cluster_id: string;
    buyer_count: number;
    cluster_confidence: number;
    cluster_roi: number;
  }>(`
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
  `);

  for (const row of rows) {
    // Score = base 82 + cluster confidence bonus + ROI bonus
    const confBonus = Math.round(row.cluster_confidence * 10);
    const roiBonus = Math.min(5, Math.round(row.cluster_roi * 2));
    const signalScore = Math.min(99, 82 + confBonus + roiBonus);

    await enqueueSignal({
      patternType: 'snipe',
      clusterId:   row.cluster_id,
      tokenMint:   row.token_mint,
      confidence:  row.cluster_confidence,
      signalScore,
      triggerData: { buyerCount: row.buyer_count, window: '5m', clusterRoi: row.cluster_roi }
    }).catch((error) => {
      console.error(`[signal-engine] failed to enqueue snipe for ${row.token_mint}`, error);
    });
  }
}

// ─── Pattern B: Accumulation ──────────────────────────────────────────────────
// Cluster buys same token across 3+ separate sessions with $50k+ total volume

async function detectAccumulationPattern() {
  const rows = await query<{
    token_mint: string;
    cluster_id: string;
    buy_volume: number;
    buy_sessions: number;
    cluster_confidence: number;
  }>(`
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
  `);

  for (const row of rows) {
    const signalScore = Math.min(99, 75 + Math.round(row.cluster_confidence * 10));

    await enqueueSignal({
      patternType:   'accumulation',
      clusterId:     row.cluster_id,
      tokenMint:     row.token_mint,
      confidence:    row.cluster_confidence,
      signalScore,
      dedupeMinutes: 7 * 24 * 60,
      triggerData:   {
        buyVolume:    row.buy_volume,
        buySessions:  row.buy_sessions,
        window:       '7d'
      }
    }).catch((error) => {
      console.error(`[signal-engine] failed to enqueue accumulation for ${row.token_mint}`, error);
    });
  }
}

// ─── Pattern C: Rotation ──────────────────────────────────────────────────────
// Cluster sells Token A and buys Token B within 1 hour

async function detectRotationPattern() {
  const rows = await query<{
    token_out: string;  // sold
    token_in:  string;  // bought
    cluster_id: string;
    actor_count: number;
    cluster_confidence: number;
  }>(`
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
      patternType:   'rotation',
      clusterId:     row.cluster_id,
      tokenMint:     row.token_in,  // Alert on the token being bought
      confidence:    row.cluster_confidence,
      signalScore,
      dedupeMinutes: 60,
      triggerData:   {
        soldToken:   row.token_out,
        boughtToken: row.token_in,
        actorCount:  row.actor_count,
        window:      '1h'
      }
    }).catch((error) => {
      console.error(`[signal-engine] failed to enqueue rotation for ${row.token_in}`, error);
    });
  }
}

// ─── Pattern D: Exit ──────────────────────────────────────────────────────────
// 50%+ of cluster sells >50% of position within 1 hour — SELL SIGNAL

async function detectExitPattern() {
  const rows = await query<{
    token_mint: string;
    cluster_id: string;
    seller_count: number;
    cluster_size: number;
    exit_volume: number;
    cluster_confidence: number;
  }>(`
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
      patternType:   'exit',
      clusterId:     row.cluster_id,
      tokenMint:     row.token_mint,
      confidence:    row.cluster_confidence,
      signalScore,
      suppressTrade: true,  // Exit signals do not trigger buys
      dedupeMinutes: 60,
      triggerData:   {
        sellerCount:   row.seller_count,
        clusterSize:   row.cluster_size,
        sellerPct,
        exitVolume:    row.exit_volume,
        window:        '1h'
      }
    }).catch((error) => {
      console.error(`[signal-engine] failed to enqueue exit for ${row.token_mint}`, error);
    });
  }
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

let tickRunning = false;
async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const results = await Promise.allSettled([
      processSourceTradeSignals(),
      detectSnipePattern(),
      detectAccumulationPattern(),
      detectRotationPattern(),
      detectExitPattern()
    ]);
    const detectorNames = ['source-trade', 'snipe', 'accumulation', 'rotation', 'exit'];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`[signal-engine] ${detectorNames[index]} detector failed`, result.reason);
      }
    });
  } finally {
    tickRunning = false;
  }
}

setInterval(tick, 15_000);
void tick();

// React immediately to real-time wallet swap events from indexer.
// Pub/sub is a latency optimization only — the 15s polling tick() is the
// authoritative detector — but ioredis does NOT auto-resubscribe after a
// reconnect, so resubscribe on every 'ready' to avoid silently going deaf.
const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
function subscribeSwaps() {
  subscriber.subscribe(REDIS_CHANNELS.walletSwap, (err) => {
    if (err) console.error('[signal-engine] swap subscribe failed', err);
    else console.log('[signal-engine] subscribed to wallet-swap channel.');
  });
}
subscribeSwaps();
subscriber.on('ready', subscribeSwaps);
subscriber.on('error', (e) => console.error('[signal-engine] redis error', e.message));
subscriber.on('message', (_channel, message) => {
  // Trigger an immediate detection cycle on any new swap. Don't log the full
  // payload (high-volume; avoids leaking wallet-activity detail into logs).
  try {
    const payload = JSON.parse(message) as { sourceTradeId?: unknown };
    if (typeof payload.sourceTradeId === 'string' && payload.sourceTradeId.trim()) {
      void processSourceTradeSignals(payload.sourceTradeId).catch((error) => {
        console.error('[signal-engine] source-trade event processing failed', error);
      });
    }
  } catch {
    console.error('[signal-engine] ignored malformed wallet-swap event');
  }
  void tick();
});

console.log('[signal-engine] service running');
