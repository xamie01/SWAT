import { Worker, Queue } from 'bullmq';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import cron from 'node-cron';
import { Redis } from 'ioredis';
import {
  LP_EXECUTION_QUEUES_BY_CHAIN,
  initLogger
} from '@swat/shared';
import {
  listTrackedLpWallets,
  recordLpWalletIndexPass,
  resolveChainMode,
  upsertLpPool,
  listPositionsForMonitor,
  transitionLpPosition,
  crossTenantScope
} from '@swat/db';
import { registerLpAuth, legacyKeyHash } from './auth.js';
import { createDeployGuard } from './guardrails/deploy-guard.js';
import { runRiskPass } from './risk/risk-pass.js';
import { registerLpRoutes } from './routes.js';
import { runPoolScan } from './scanner/scan-job.js';
import { createMeteoraPoolFetcher } from './scanner/meteora-pools.js';
import { createRobinhoodPoolFetcher, createViemRobinhoodPoolReader } from './scanner/robinhood-pools.js';
import { runMonitorPass } from './monitor/monitor-job.js';
import { runWalletIndexPass } from './wallets/wallet-indexer.js';
import { createPlanOnlyMeteoraPort, createPlanOnlyEvmPort } from './builder/plan-ports.js';
import { createMeteoraLadderBuilder } from './builder/meteora-ladder.js';
import { createEvmLadderBuilder } from './builder/evm-ladder.js';

/**
 * The LP service entry (Track H + scheduled wiring for B6/C6/F6/D4).
 *
 * One process hosts: the Fastify API, the four scheduled passes (pool scan,
 * risk attach, position monitor, wallet indexer), and one concurrency-1
 * BullMQ worker per LP execution queue. Cron passes use overlap guards
 * (single-process deployment, scorer pattern); execution jobs are durable
 * queue work because they sign and submit.
 *
 * Everything here runs under the existing execution-mode clamps
 * (`resolveChainMode`): with the platform at paper, the workers record plans
 * and the monitors act, but nothing is ever broadcast.
 */

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const port = Number(process.env.LP_PORT ?? 3010);
const apiKey = process.env.API_KEY;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !apiKey) {
  throw new Error('API_KEY is required in production');
}
if (!apiKey) {
  console.warn('[lp] API_KEY unset — service-key auth disabled; only session-cookie auth is available');
}

initLogger('lp');

const scanCron = process.env.LP_POOL_SCAN_CRON ?? '*/30 * * * *';
const monitorCron = process.env.LP_POSITION_MONITOR_CRON ?? '*/5 * * * *';
const walletIndexCron = process.env.LP_WALLET_INDEX_CRON ?? '*/15 * * * *';
const riskPassCron = process.env.LP_RISK_PASS_CRON ?? '*/10 * * * *';

// --- Chain boundary wiring -------------------------------------------------

const meteoraFetcher = createMeteoraPoolFetcher({
  apiBase: process.env.METEORA_API_URL ?? 'https://dlmm-api.meteora.ag',
  maxPairs: Number(process.env.LP_SCAN_MAX_PAIRS ?? 200)
});

const robinhoodPools = (process.env.ROBINHOOD_LP_POOL_ADDRESSES ?? '')
  .split(',')
  .map((address) => address.trim())
  .filter((address) => address.startsWith('0x'));

const robinhoodFetcher = createRobinhoodPoolFetcher({
  reader: createViemRobinhoodPoolReader({
    rpcUrl: process.env.ROBINHOOD_RPC_URL ?? '',
    configuredPools: robinhoodPools
  })
});

const scanStore = {
  upsert: async (input: Parameters<typeof upsertLpPool>[0]) => upsertLpPool(input)
};

const deployGuard = createDeployGuard();

// Pool view for ladder anchoring: served from the scan cache (Track B output).
const poolView = {
  getPool: async (chain: 'solana' | 'robinhood-chain', poolAddress: string) => {
    const { getLpPool } = await import('@swat/db');
    const pool = await getLpPool(chain, poolAddress);
    if (!pool) return null;
    return {
      protocol: pool.protocol,
      binStep: pool.binStep,
      tickSpacing: pool.tickSpacing,
      currentPrice: pool.currentPrice
    };
  }
};

// Plan-only builder ports: paper mode records the rung steps as the bundle.
// SDK-backed signing ports land behind the same interfaces at live certification.
const meteoraBuilder = createMeteoraLadderBuilder(createPlanOnlyMeteoraPort());
const evmBuilder = createEvmLadderBuilder(createPlanOnlyEvmPort());
const executionMode = {
  resolveMode: async (chain: 'solana' | 'robinhood-chain') => {
    const resolution = await resolveChainMode(chain);
    const mode = resolution.effectiveMode;
    // 'live+shadow' is observe-only: for LP it maps to paper — plans are
    // recorded, nothing is ever broadcast.
    if (mode === 'off' || mode === 'paper' || mode === 'live') return mode;
    return 'paper';
  }
};

// --- Scheduled passes -------------------------------------------------------

let scanRunning = false;
async function runScanGuarded(): Promise<void> {
  if (scanRunning) return;
  scanRunning = true;
  try {
    const summary = await runPoolScan({
      fetchers: [meteoraFetcher, robinhoodFetcher],
      store: scanStore
    });
    console.log('[lp] pool scan complete', JSON.stringify(summary));
  } catch (error) {
    console.error('[lp] pool scan failed:', error instanceof Error ? error.message : error);
  } finally {
    scanRunning = false;
  }
}

let riskRunning = false;
async function runRiskGuarded(): Promise<void> {
  if (riskRunning) return;
  riskRunning = true;
  try {
    const { holderConcentrationCheck, liquidityLockCheck, mintAuthorityCheck } = await import('./risk/solana-checks.js');
    const { createJsonRpcSolanaPort } = await import('./risk/solana-rpc.js');
    const port = createJsonRpcSolanaPort(
      process.env.HELIUS_API_KEY
        ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
        : process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com'
    );
    const summary = await runRiskPass({
      checksByChain: {
        solana: [
          holderConcentrationCheck(port),
          mintAuthorityCheck(port),
          liquidityLockCheck(port)
        ]
      }
    });
    console.log('[lp] risk pass complete', JSON.stringify(summary));
  } catch (error) {
    console.error('[lp] risk pass failed:', error instanceof Error ? error.message : error);
  } finally {
    riskRunning = false;
  }
}

let monitorRunning = false;
async function runMonitorGuarded(): Promise<void> {
  if (monitorRunning) return;
  monitorRunning = true;
  try {
    for (const chain of ['solana', 'robinhood-chain'] as const) {
      const summary = await runMonitorPass(
        {
          pricePoller: { currentPrice: async () => null }, // live price source lands with the SDK poller
          economics: {
            estimate: async () => ({
              expectedExtraFeesUsd: 0,
              impermanentLossUsd: 0,
              gasCostUsd: 0,
              rebalanceCostUsd: 0,
              inventoryChangeUsd: 0
            })
          },
          listPositions: async (c) => listPositionsForMonitor(crossTenantScope('lp position monitor sweep'), c),
          transition: (positionId, toState, reason) => transitionLpPosition(crossTenantScope('lp position monitor sweep'), positionId, { toState, reason }),
          queueRebalance: async (input) => {
            await executionQueueRefs[input.chain]?.add('lp-rebalance', input, {
              jobId: `lp-rebalance-${input.positionId}`,
              removeOnComplete: true,
              removeOnFail: 100
            });
          }
        },
        chain
      );
      console.log(`[lp] monitor pass complete for ${chain}`, JSON.stringify(summary));
    }
  } catch (error) {
    console.error('[lp] monitor pass failed:', error instanceof Error ? error.message : error);
  } finally {
    monitorRunning = false;
  }
}

let walletIndexRunning = false;
async function runWalletIndexGuarded(): Promise<void> {
  if (walletIndexRunning) return;
  walletIndexRunning = true;
  try {
    const summary = await runWalletIndexPass({
      readers: [], // chain readers land with SDK wiring; passes no-op cleanly
      listWallets: async () => {
        const wallets = await listTrackedLpWallets({ limit: 500 });
        return wallets.map((wallet) => ({ id: wallet.id, chain: wallet.chain, walletAddress: wallet.walletAddress }));
      },
      recordPass: recordLpWalletIndexPass
    });
    console.log('[lp] wallet index pass complete', JSON.stringify(summary));
  } catch (error) {
    console.error('[lp] wallet index pass failed:', error instanceof Error ? error.message : error);
  } finally {
    walletIndexRunning = false;
  }
}

// --- HTTP API ----------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  if (apiKey) {
    await registerLpAuth(app, { legacyKeyHash: legacyKeyHash(apiKey) });
  }
  await registerLpRoutes(app, {
    deployGuard,
    executionMode,
    poolView,
    meteoraBuilder,
    evmBuilder,
    userAddress: process.env.LP_SERVICE_USER_ADDRESS ?? ''
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    console.error('[lp] request error:', error.message);
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      return reply.code(500).send({ error: 'Internal Server Error' });
    }
    return reply.code(statusCode).send({ error: error.message });
  });

  return app;
}

// --- Execution queue workers ---------------------------------------------------

const executionQueueRefs: Record<string, import('bullmq').Queue | undefined> = {};

async function startExecutionWorkers(
  connection: Redis,
  closers: Array<() => Promise<void>>
): Promise<void> {
  for (const [chain, queueName] of Object.entries(LP_EXECUTION_QUEUES_BY_CHAIN)) {
    const queue = new Queue(queueName, { connection });
    executionQueueRefs[chain] = queue;
    closers.push(() => queue.close());

    const worker = new Worker(
      queueName,
      async (job) => {
        const mode = await executionMode.resolveMode(chain as 'solana' | 'robinhood-chain');
        if (mode !== 'live') {
          // Paper (or off): the job is a plan, not a submission. The monitor
          // already journaled the economic case; record the intent and stop.
          console.log(
            `[lp] execution job ${job.id ?? ''} for ${chain} recorded in ${mode} mode (not broadcast):`,
            JSON.stringify(job.data)
          );
          return { mode, broadcast: false };
        }
        // Live path: the build/rebalance plans from Tracks E/F would be signed
        // and submitted here through the SDK ports. Runtime-untested in this
        // environment (no live-certified chain); fail closed rather than guess.
        throw new Error('live LP submission requires a certified chain runtime; refusing to guess');
      },
      { connection, concurrency: 1 }
    );
    worker.on('error', (error) => console.error(`[lp] ${queueName} worker error`, error));
    closers.push(() => worker.close());
  }
}

// --- Boot ---------------------------------------------------------------------

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const closers: Array<() => Promise<void>> = [];

const app = await buildApp();
await app.listen({ host: '0.0.0.0', port });
console.log(`[lp] API listening on :${port}`);

if (apiKey) {
  console.log('[lp] service-key auth enabled');
}
console.log(`[lp] scan every ${scanCron}, monitor ${monitorCron}, risk ${riskPassCron}, wallets ${walletIndexCron}`);

cron.schedule(scanCron, () => void runScanGuarded(), { timezone: 'UTC' });
cron.schedule(monitorCron, () => void runMonitorGuarded(), { timezone: 'UTC' });
cron.schedule(riskPassCron, () => void runRiskGuarded(), { timezone: 'UTC' });
cron.schedule(walletIndexCron, () => void runWalletIndexGuarded(), { timezone: 'UTC' });

await startExecutionWorkers(connection, closers);

if (process.env.RUN_ON_STARTUP === 'true') {
  void runScanGuarded();
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[lp] ${signal} received; shutting down`);
  const results = await Promise.allSettled([...closers.map((closer) => closer()), connection.quit(), app.close()]);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[lp] shutdown error:', result.reason);
      process.exitCode = 1;
    }
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
