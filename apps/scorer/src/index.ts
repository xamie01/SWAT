import cron from 'node-cron';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
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
  listClusters,
  updateClusterPerformance,
  markToMarketOpenPositions,
  runNightlyAttribution,
  persistExpectancyReport,
  resolveRiskPolicy,
  claimStopLossTrigger,
  releaseStopLossTrigger
} from '@swat/db';
import { calculateCompositeScore, scoreToTier, REDIS_CHANNELS, initLogger, tradeQueueForChain } from '@swat/shared';
import type { Chain } from '@swat/shared';
import { runAttributionReporting } from './expectancy.js';
import { runStopLossSweep } from './stop-loss.js';
import {
  runMasterMetricsBatch,
  listMasterCandidates,
  fetchMasterTradeRows,
  formatMasterMetricsLine
} from './master-metrics.js';

const redisUrlForPublish = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redisPublishClient = new Redis(redisUrlForPublish, { maxRetriesPerRequest: null });

// Stop-loss exits go through the same durable queues the signal engine uses, so
// they inherit the executor's mode gating, circuit breaker and reconciliation.
// One queue per chain since S3-25, so a stalled venue cannot hold up another
// chain's exits — which for a stop-loss is the difference between a bounded loss
// and an unbounded one.
const tradeQueueConnection = new Redis(redisUrlForPublish, { maxRetriesPerRequest: null });
const tradeQueues = new Map<Chain, Queue>(
  (['solana', 'polygon', 'robinhood-chain'] as const).map((chain) => {
    const queue = new Queue(tradeQueueForChain(chain), { connection: tradeQueueConnection });
    queue.on('error', (error) => console.error(`[scorer] ${chain} trade queue error`, error));
    return [chain, queue];
  })
);

initLogger('scorer');

/** Regenerate clusters on demand (API POST /v1/clusters/:id/refresh). */
async function regenerateClusters() {
  console.log('[scorer] Regenerating clusters on demand...');
  await generateFundingClusters();
  await generateBehavioralClusters();
  await refreshClusterPerformance();
  console.log('[scorer] Cluster regeneration complete.');
}

async function runStage<T>(label: string, action: () => Promise<T>): Promise<T | null> {
  try {
    return await action();
  } catch (error) {
    console.error(`[scorer] ${label} failed`, error);
    return null;
  }
}

async function refreshClusterPerformance() {
  const clusters = await listClusters();
  const results = await Promise.allSettled(
    clusters.map((cluster: any) => updateClusterPerformance(cluster.id))
  );
  const failures = results.filter((result) => result.status === 'rejected').length;
  if (failures > 0) {
    throw new Error(`${failures} cluster performance updates failed`);
  }
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
      const metrics = await getWalletMetrics(wallet.address, wallet.chain);
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
  await runStage('pause underperforming wallets', pauseUnderperformingWallets);
  await runStage('promote discovered wallets', promoteHighScoringDiscoveredWallets);
  await runStage('reactivate dormant wallets', reactivateDormantWallets);

  // Now that token-discovered 'token-big' wallets have been scored, drop the ones
  // that turned out unprofitable (ROI <= 0 OR win rate < 50%) before they enter
  // clustering. 'token-early' wallets are kept unconditionally.
  const pruned = await runStage('prune unprofitable token-big wallets', pruneUnprofitableBigBuyers);
  if (pruned !== null && pruned > 0) {
    console.log(`[scorer] Pruned ${pruned} unprofitable token-big wallets`);
  }

  console.log('[scorer] Running clustering engines...');
  await runStage('funding clustering', generateFundingClusters);
  await runStage('behavioral clustering', generateBehavioralClusters);
  await runStage('cluster performance refresh', refreshClusterPerformance);

  console.log('[scorer] Marking open positions to market...');
  await runStage('mark-to-market', runMarkToMarketGuarded);

  console.log('[scorer] Running nightly attribution and expectancy report...');
  await runStage('nightly attribution and expectancy report', () => runAttributionReporting({
    rebuildOutcomes: runNightlyAttribution,
    persistReport: persistExpectancyReport,
    publishDigest: (message) => redisPublishClient.publish(
      REDIS_CHANNELS.alertQueue,
      JSON.stringify({
        type: 'NIGHTLY_EXPECTANCY',
        title: 'Nightly Expectancy Report',
        message
      })
    )
  }));

  console.log('[scorer] Computing out-of-sample master metrics (24h / 7d / 30d)...');
  await runStage('master metrics', runMasterMetrics);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[scorer] Batch complete in ${elapsed}s.`);
}

/**
 * S4-M8 - out-of-sample master metrics over 24h / 7d / 30d. Runs on the nightly
 * batch because a track record does not change intraday in a way any user acts
 * on, and the round-trip reconstruction reads up to 180 days per master.
 */
async function runMasterMetrics() {
  const asOf = new Date();
  const result = await runMasterMetricsBatch({
    listMasters: () => listMasterCandidates({ asOf }),
    fetchTrades: fetchMasterTradeRows,
    asOf
  });

  console.log(
    `[scorer] Master metrics: ${result.masters} candidates, ${result.reports.length} reported, ` +
    `${result.decaying} decaying, ${result.improving} improving, ` +
    `${result.insufficientEverywhere} with insufficient history in every window, ` +
    `${result.failed} failed.`
  );
  // Divergence is itself the finding (ADR-0005 section 5.3), so a decaying
  // master is logged individually rather than only counted.
  for (const report of result.reports) {
    if (report.trend === 'decaying') console.log(`[scorer] decaying master - ${formatMasterMetricsLine(report)}`);
  }
}

/**
 * Refresh unrealised P&L on open positions. Runs inside the nightly batch and
 * on a short standalone cron so /v1/trading/performance stays current.
 */
async function runMarkToMarket() {
  let positions: Awaited<ReturnType<typeof markToMarketOpenPositions>>['positions'] = [];
  try {
    const result = await markToMarketOpenPositions();
    positions = result.positions;
    console.log(`[scorer] Mark-to-market: updated ${result.updated}, skipped ${result.skipped}.`);
  } catch (e) {
    console.error('[scorer] Mark-to-market failed:', e);
    return;
  }

  // Stop-loss is evaluated against the prices the pass above just fetched, so a
  // breach is acted on within one mark-to-market interval and never on a stale
  // quote. A failure here must not mask a successful mark-to-market.
  try {
    const sweep = await runStopLossSweep({
      positions,
      resolvePolicy: resolveRiskPolicy,
      claim: claimStopLossTrigger,
      release: releaseStopLossTrigger,
      enqueueSell: (job, jobId, chain) => {
        const queue = tradeQueues.get(chain);
        // Refuse rather than fall back to another chain's queue: the sweep
        // releases the claim on a throw, so the next pass retries the exit.
        if (!queue) throw new Error(`No trade queue configured for chain ${chain}`);
        return queue.add('stop-loss-sell', job, {
          jobId,
          removeOnComplete: true,
          attempts: 4,
          backoff: { type: 'exponential', delay: 5000 }
        });
      },
      publishAlert: (alert) => redisPublishClient.publish(
        REDIS_CHANNELS.alertQueue,
        JSON.stringify(alert)
      )
    });
    if (sweep.breached > 0) {
      console.log(
        `[scorer] Stop-loss: scanned ${sweep.scanned}, breached ${sweep.breached}, ` +
        `queued ${sweep.queued}, already triggered ${sweep.alreadyTriggered}, failed ${sweep.failed}.`
      );
    }
    // Logged outside the `breached` guard and on its own line: an unaccountable position
    // never reaches the breach check, so it would otherwise be invisible in exactly the
    // case where nothing breached. Worded as a ledger problem because that is the fix --
    // a `trades.user_id` that is neither a uuid nor NULL, which no retry will clear.
    if (sweep.unaccountable > 0) {
      console.error(
        `[scorer] Stop-loss: ${sweep.unaccountable} position(s) skipped with an unusable ` +
        `owner -- check trades.user_id on those signals; this will not self-resolve.`
      );
    }
  } catch (e) {
    console.error('[scorer] Stop-loss sweep failed:', e);
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

function subscribeScorerEvents() {
  subscriber.subscribe(REDIS_CHANNELS.clusterRefresh, REDIS_CHANNELS.scorerRun, (err) => {
    if (err) console.error('[scorer] subscribe failed', err);
    else console.log('[scorer] subscribed to cluster-refresh and scorer-run channels.');
  });
}
subscribeScorerEvents();
subscriber.on('ready', subscribeScorerEvents); // resubscribe after reconnect
subscriber.on('error', (e) => console.error('[scorer] redis error', e.message));
subscriber.on('message', (channel) => {
  if (channel === REDIS_CHANNELS.clusterRefresh) {
    if (clusterRefreshing) return;
    clusterRefreshing = true;
    regenerateClusters()
      .catch((e) => console.error('[scorer] cluster refresh failed', e))
      .finally(() => { clusterRefreshing = false; });
  } else if (channel === REDIS_CHANNELS.scorerRun) {
    console.log('[scorer] Manual scorer batch run triggered on-demand.');
    runScoringBatchGuarded()
      .catch((e) => console.error('[scorer] manual scoring batch failed', e));
  }
});

console.log('[scorer] Service running. Scheduled at 02:00 UTC daily; mark-to-market every 5m; listening for cluster-refresh.');

if (process.env.RUN_ON_STARTUP === 'true') {
  runScoringBatchGuarded().catch(console.error);
}
