import cron from 'node-cron';
import { Redis } from 'ioredis';
import {
  getWalletMetrics,
  updateWalletScore,
  pauseUnderperformingWallets,
  promoteHighScoringDiscoveredWallets,
  reactivateDormantWallets,
  pruneUnprofitableBigBuyers,
  getActiveWallets,
  generateFundingClusters,
  generateBehavioralClusters,
  markToMarketOpenPositions
} from '@swat/db';
import { calculateCompositeScore, scoreToTier, REDIS_CHANNELS } from '@swat/shared';

/** Regenerate clusters on demand (API POST /v1/clusters/:id/refresh). */
async function regenerateClusters() {
  console.log('[scorer] Regenerating clusters on demand...');
  await generateFundingClusters();
  await generateBehavioralClusters();
  console.log('[scorer] Cluster regeneration complete.');
}

async function runScoringBatch() {
  console.log('[scorer] Starting nightly scoring batch...');
  const startTime = Date.now();

  const wallets = await getActiveWallets();
  console.log(`[scorer] Scoring ${wallets.length} active wallets...`);

  let scored = 0;
  let errors = 0;

  for (const wallet of wallets) {
    try {
      const metrics = await getWalletMetrics(wallet.address);
      const score = calculateCompositeScore(metrics);
      const tier = scoreToTier(score);
      await updateWalletScore(wallet.address, score, tier, metrics);
      scored++;
    } catch (e) {
      console.error(`[scorer] Error scoring ${wallet.address}:`, e);
      errors++;
    }
  }
  console.log(`[scorer] Scored ${scored} wallets (${errors} errors)`);

  console.log('[scorer] Running pruning rules...');
  await pauseUnderperformingWallets();
  await promoteHighScoringDiscoveredWallets();
  await reactivateDormantWallets();

  // Now that token-discovered 'token-big' wallets have been scored, drop the ones
  // that turned out unprofitable (ROI <= 0 OR win rate < 50%) before they enter
  // clustering. 'token-early' wallets are kept unconditionally.
  const pruned = await pruneUnprofitableBigBuyers();
  if (pruned > 0) console.log(`[scorer] Pruned ${pruned} unprofitable token-big wallets`);

  console.log('[scorer] Running clustering engines...');
  await generateFundingClusters();
  await generateBehavioralClusters();

  console.log('[scorer] Marking open positions to market...');
  await runMarkToMarketGuarded();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[scorer] Batch complete in ${elapsed}s.`);
}

/**
 * Refresh unrealised P&L on open positions. Runs inside the nightly batch and
 * on a short standalone cron so /v1/trading/performance stays current.
 */
async function runMarkToMarket() {
  try {
    const { updated, skipped } = await markToMarketOpenPositions();
    console.log(`[scorer] Mark-to-market: updated ${updated}, skipped ${skipped}.`);
  } catch (e) {
    console.error('[scorer] Mark-to-market failed:', e);
  }
}

// In-process guards prevent overlapping runs: a batch that overruns into the
// next schedule, or the nightly batch's mark-to-market racing the 5-minute one
// (both issue overlapping UPDATEs). Single-process deployment, so a boolean
// flag is sufficient and avoids the cross-connection pitfalls of pooled
// pg_advisory_lock.
let batchRunning = false;
let mtmRunning = false;

async function runScoringBatchGuarded() {
  if (batchRunning) {
    console.log('[scorer] batch already running, skipping this trigger.');
    return;
  }
  batchRunning = true;
  try {
    await runScoringBatch();
  } catch (e) {
    console.error('[scorer] batch failed', e);
  } finally {
    batchRunning = false;
  }
}

async function runMarkToMarketGuarded() {
  if (mtmRunning) return;
  mtmRunning = true;
  try {
    await runMarkToMarket();
  } finally {
    mtmRunning = false;
  }
}

// Nightly at 02:00 UTC
cron.schedule('0 2 * * *', () => {
  runScoringBatchGuarded().catch(console.error);
}, { timezone: 'UTC' });

// Mark-to-market every 5 minutes so paper-trade P&L stays fresh.
cron.schedule('*/5 * * * *', () => {
  runMarkToMarketGuarded().catch(console.error);
}, { timezone: 'UTC' });

// On-demand cluster refresh: the API publishes here when a user hits
// POST /v1/clusters/:id/refresh. Without this subscriber the endpoint was a
// silent no-op.
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
let clusterRefreshing = false;

function subscribeClusterRefresh() {
  subscriber.subscribe(REDIS_CHANNELS.clusterRefresh, (err) => {
    if (err) console.error('[scorer] subscribe failed', err);
    else console.log('[scorer] subscribed to cluster-refresh channel.');
  });
}
subscribeClusterRefresh();
subscriber.on('ready', subscribeClusterRefresh); // resubscribe after reconnect
subscriber.on('error', (e) => console.error('[scorer] redis error', e.message));
subscriber.on('message', (channel) => {
  if (channel !== REDIS_CHANNELS.clusterRefresh) return;
  if (clusterRefreshing) return;
  clusterRefreshing = true;
  regenerateClusters()
    .catch((e) => console.error('[scorer] cluster refresh failed', e))
    .finally(() => { clusterRefreshing = false; });
});

console.log('[scorer] Service running. Scheduled at 02:00 UTC daily; mark-to-market every 5m; listening for cluster-refresh.');

if (process.env.RUN_ON_STARTUP === 'true') {
  runScoringBatchGuarded().catch(console.error);
}
