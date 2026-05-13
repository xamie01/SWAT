import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { insertSignalWithDedupe, query } from '@swat/db';
import { REDIS_CHANNELS } from '@swat/shared';
import { checkTokenSafety } from './safety.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const alertQueue = new Queue('swat:alerts', { connection: redis });
const tradeQueue = new Queue('swat:trades', { connection: redis });

async function detectSnipePattern() {
  const rows = await query<{
    token_mint: string;
    cluster_id: string;
    buyer_count: number;
  }>(`
    SELECT t.target_token as token_mint, cm.cluster_id, count(*)::int as buyer_count
    FROM transactions t
    JOIN cluster_memberships cm ON t.wallet_address = cm.wallet_address
    WHERE t.direction = 'buy'
      AND t.timestamp > NOW() - INTERVAL '5 minutes'
    GROUP BY t.target_token, cm.cluster_id
    HAVING count(*) >= 3
  `);

  for (const row of rows) {
    const safety = await checkTokenSafety(row.token_mint);

    const signal = await insertSignalWithDedupe({
      patternType: 'snipe',
      clusterId: row.cluster_id,
      tokenMint: row.token_mint,
      confidence: 87,
      signalScore: 82,
      triggerData: { buyerCount: row.buyer_count, window: '5m' },
      safetyFlags: safety.flags,
      safetyWarnings: safety.warnings
    });

    if (!signal) {
      continue;
    }

    if (!signal.inserted) {
      console.log(`[signal-engine] duplicate signal skipped: ${signal.id}`);
      continue;
    }

    await alertQueue.add(
      'signal-alert',
      {
        signalId: signal.id,
        pattern: 'snipe',
        tokenMint: row.token_mint,
        clusterId: row.cluster_id,
        buyerCount: row.buyer_count,
        confidence: 87,
        score: 82,
        window: '5m',
        isSafe: safety.isSafe,
        warnings: safety.warnings
      },
      { removeOnComplete: true }
    );
    
    if (safety.isSafe) {
      await tradeQueue.add('signal-trade', { signalId: signal.id, score: 82 }, { removeOnComplete: true });
    } else {
      console.log(`[signal-engine] trade aborted due to safety flags: ${safety.flags.join(',')}`);
    }
  }
}

async function detectAccumulationPattern() {
  const rows = await query<{
    token_mint: string;
    cluster_id: string;
    buy_volume: number;
  }>(`
    SELECT t.target_token as token_mint, cm.cluster_id, sum(t.amount_in_usd) as buy_volume
    FROM transactions t
    JOIN cluster_memberships cm ON t.wallet_address = cm.wallet_address
    WHERE t.direction = 'buy'
      AND t.timestamp > NOW() - INTERVAL '1 hour'
      AND t.amount_in_usd IS NOT NULL
    GROUP BY t.target_token, cm.cluster_id
    HAVING sum(t.amount_in_usd) > 50000
  `);

  for (const row of rows) {
    const safety = await checkTokenSafety(row.token_mint);

    const signal = await insertSignalWithDedupe({
      patternType: 'accumulation',
      clusterId: row.cluster_id,
      tokenMint: row.token_mint,
      confidence: 75,
      signalScore: 85,
      triggerData: { buyVolume: row.buy_volume, window: '1h' },
      safetyFlags: safety.flags,
      safetyWarnings: safety.warnings
    }, 60); // Dedupe for 60 mins

    if (!signal) continue;
    if (!signal.inserted) continue;

    await alertQueue.add(
      'signal-alert',
      {
        signalId: signal.id,
        pattern: 'accumulation',
        tokenMint: row.token_mint,
        clusterId: row.cluster_id,
        buyVolume: row.buy_volume,
        confidence: 75,
        score: 85,
        window: '1h',
        isSafe: safety.isSafe,
        warnings: safety.warnings
      },
      { removeOnComplete: true }
    );
    
    if (safety.isSafe) {
      await tradeQueue.add('signal-trade', { signalId: signal.id, score: 85 }, { removeOnComplete: true });
    }
  }
}

async function tick() {
  try {
    await detectSnipePattern();
    await detectAccumulationPattern();
  } catch (error) {
    console.error('[signal-engine] detect tick failed', error);
  }
}

setInterval(tick, 15_000);
void tick();

const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
await subscriber.subscribe(REDIS_CHANNELS.walletSwap);
subscriber.on('message', (_channel, message) => {
  console.log('[signal-engine] wallet swap event', message);
});

console.log('[signal-engine] service running');
