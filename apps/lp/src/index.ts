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
  getLpPositionAnyOwner,
  listTrackedLpWallets,
  pruneStaleLpPools,
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
import { buildLivePreview } from './builder/live-preview.js';
import { createLiveContextSource } from './builder/live-context.js';
import { createLpCopyWorker } from './copy/copy-worker.js';
import { createExactLpDomain } from './builder/exact-paper.js';
import { createLpPaperSqlStore } from '@swat/db/dist/lp-paper-store.js';
import { createLpExecutionMode, createPaperReplanner, requestLpOperation, processLpOperationJob, recoverLpOperations, type LpOperationDeps } from './operations.js';
import { forUser } from '@swat/db';
import { createRpcSolanaBinSource } from './scanner/solana-bins.js';

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

const solanaRpcUrl = (process.env.SOLANA_RPC_URL && process.env.SOLANA_RPC_URL.trim().length > 0)
  ? process.env.SOLANA_RPC_URL.trim()
  : (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 'https://api.mainnet-beta.solana.com');

const meteoraFetcher = createMeteoraPoolFetcher({
  apiBase: process.env.METEORA_API_URL ?? 'https://dlmm.datapi.meteora.ag',
  maxPairs: Number(process.env.LP_SCAN_MAX_PAIRS ?? 200),
  // Live bins for active-TVL now that the RPC bin source exists (Track I1).
  binSource: solanaRpcUrl
    ? createRpcSolanaBinSource({ rpcUrl: solanaRpcUrl, binsEachSide: 10 })
    : undefined
  // binSource (the live DLMM SDK bin feed) is intentionally not wired yet:
  // @meteora-ag/dlmm@1.9.14 cannot be imported in this environment at all —
  // its ESM build re-exports anchor paths that only CJS resolution accepts,
  // and its CJS build does not export the DLMM class. The `binSource` port on
  // createMeteoraPoolFetcher is the fixture-tested seam; adopt the SDK (or a
  // patched build) behind it without touching the scanner.
});

const robinhoodPools = (process.env.ROBINHOOD_LP_POOL_ADDRESSES ?? '')
  .split(',')
  .map((address) => address.trim())
  .filter((address) => address.startsWith('0x'));

const robinhoodFetcher = createRobinhoodPoolFetcher({
  reader: createViemRobinhoodPoolReader({
    rpcUrl: process.env.ROBINHOOD_RPC_URL ?? '',
    configuredPools: robinhoodPools
  }),
  stableQuoteToken: process.env.ROBINHOOD_SANITY_TOKEN ?? '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
});

const scanStore = {
  upsert: async (input: Parameters<typeof upsertLpPool>[0]) => upsertLpPool(input)
};

const deployGuard = createDeployGuard();

// Track I: live context for the ladder preview. Solana bins come from the
// mainnet-verified RPC decode; EVM context from the viem pool reader. The
// scan cache is the fallback when a live fetch fails.
const liveContextSource = createLiveContextSource({
  solanaBinSource: createRpcSolanaBinSource({
    rpcUrl: solanaRpcUrl ?? 'https://api.mainnet-beta.solana.com'
  }),
  evmReaders: { 'robinhood-chain': robinhoodPools.length > 0
    ? createViemRobinhoodPoolReader({
        rpcUrl: process.env.ROBINHOOD_RPC_URL ?? '',
        configuredPools: robinhoodPools
      })
    : undefined }
});

// Pool view for ladder anchoring: served from the scan cache (Track B output).
const poolView = {
  getPool: async (chain: import('@swat/shared').LpChain, poolAddress: string) => {
    const { getLpPool } = await import('@swat/db');
    const pool = await getLpPool(chain, poolAddress);
    if (!pool) return null;
    const context = await liveContextSource.fetchLiveContext(chain, poolAddress);
    if (!context) return null;
    return {
      protocol: pool.protocol,
      binStep: context.binStep,
      tickSpacing: context.tickSpacing,
      currentPrice: context.currentPrice,
      observedAt: context.fetchedAt
    };
  }
};

// Plan-only builder ports: paper mode records the rung steps as the bundle.
// SDK-backed signing ports land behind the same interfaces at live certification.
const meteoraBuilder = createMeteoraLadderBuilder(createPlanOnlyMeteoraPort());
const evmBuilder = createEvmLadderBuilder(createPlanOnlyEvmPort());
const executionMode = createLpExecutionMode(resolveChainMode);
const enqueueExactOperation: LpOperationDeps['enqueue'] = async input => {
  const queue = executionQueueRefs[input.chain];
  if (!queue) throw new Error('LP durable operation queue unavailable');
  await queue.add('lp-paper-operation', input, { jobId: `lp-op-${input.operationId}`, removeOnComplete: true, removeOnFail: true });
};
// Default has no quote/receipt or master-event port. SQL/plan factories do not manufacture provider acceptance.
const exactPaper = createExactLpDomain({ store: createLpPaperSqlStore(), mode: chain => executionMode.resolveMode(chain), enqueue: enqueueExactOperation });
const builderDeps = {
  deployGuard, executionMode, poolView, meteoraBuilder, evmBuilder, exactPaper,
  userAddress: process.env.LP_SERVICE_USER_ADDRESS ?? '',
  valuation: { value: async () => null }
};
const operationDeps: LpOperationDeps = {
  executionMode, exactPaper,
  replan: createPaperReplanner(builderDeps), enqueue: enqueueExactOperation
  // No wildcard recovery scope: independent operator enumeration capability remains unavailable.
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
    // Pools the scanner has not seen for a week leave the cache: an upsert-only
    // writer can never remove a pool that dropped off the source list, and a
    // vanished pool on the Discover feed is a position waiting to happen.
    // Generous window: a pool temporarily missing from one API page must not
    // flap out of the feed.
    const pruned = await pruneStaleLpPools(7 * 24 * 3600);
    console.log('[lp] pool scan complete', JSON.stringify({ ...summary, prunedStalePools: pruned }));
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
    const port = createJsonRpcSolanaPort(solanaRpcUrl);
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
    await recoverLpOperations(operationDeps);
    for (const chain of ['solana', 'robinhood-chain'] as const) {
      const summary = await runMonitorPass(
        {
          pricePoller: { currentPrice: async poolAddress => {
            const context = await liveContextSource.fetchLiveContext(chain, poolAddress);
            const age = context ? Date.now() - context.fetchedAt.getTime() : NaN;
            return context && Number.isFinite(age) && age >= 0 && age <= 60_000 ? context.currentPrice : null;
          } },
          economics: { estimate: async () => null }, // no trustworthy fee/IL/cost provider configured
          listPositions: async (c) => listPositionsForMonitor(crossTenantScope('lp position monitor sweep'), c),
          transition: async (positionId, toState, reason) => {
            const position = await getLpPositionAnyOwner(crossTenantScope('LP monitor owner resolution'), positionId);
            if (!position) throw new Error('LP monitor owner unavailable');
            return transitionLpPosition(forUser(position.userId), positionId, { toState, reason });
          },
          queueExactRebalance: async (input) => {
            const position = await getLpPositionAnyOwner(crossTenantScope('LP monitor operation lookup'), input.positionId);
            if (!position) throw new Error('LP position gone');
            await requestLpOperation(operationDeps, forUser(position.userId), {
              positionId: position.id, kind: 'rebalance', automatic: true, operationKey: `monitor-${position.id}-${position.updatedAt.getTime()}`
            });
          },
          queueRebalance: async () => { throw new Error('LP legacy float economic scheduling unavailable'); }
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
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  // CORS is opt-in per origin: reflecting `origin: true` with credentials
  // would let any site read cookie-authenticated responses. The operator
  // console (e.g. the Next.js app on its own port) names itself in
  // LP_CORS_ORIGIN; with nothing configured, no cross-origin browser client
  // is allowed (service-key callers are unaffected — they are not browsers).
  const rawCors = process.env.LP_CORS_ORIGIN ?? process.env.CORS_ORIGIN;
  const corsOrigins = rawCors
    ? rawCors.split(',').map((origin) => origin.trim()).filter(Boolean)
    : [
        process.env.AUTH_URI ?? 'http://localhost:3000',
        'http://localhost:3000',
        'http://127.0.0.1:3000'
      ];
  await (app.register as any)(cors, {
    origin: (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => {
      if (!origin) return cb(null, true);
      const isAllowed = corsOrigins.includes(origin) ||
        origin === 'http://localhost:3000' ||
        origin === 'http://127.0.0.1:3000';
      if (isAllowed) {
        return cb(null, true);
      }
      return cb(new Error('Not allowed by CORS'), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Api-Key', 'x-csrf-token'],
    credentials: true
  });
  await (app.register as any)(cookie);
  await registerLpAuth(app, { legacyKeyHash: apiKey ? legacyKeyHash(apiKey) : undefined });
  await registerLpRoutes(app, {
    ...builderDeps,
    operations: operationDeps,
    livePreview: async (input) => {
      const context = await liveContextSource.fetchLiveContext(input.chain, input.poolAddress);
      if (!context) {
        throw new Error(`no live or cached context for ${input.poolAddress}; run a scan first`);
      }
      return buildLivePreview({
        chain: input.chain,
        protocol: context.chain === 'solana' ? 'meteora-dlmm' : 'uniswap-v3',
        poolAddress: input.poolAddress,
        template: input.template as never,
        // buildLivePreview re-validates distribution at runtime (the preview
        // route surfaces it as 400), so the HTTP-boundary string casts here.
        custom: input.custom as Parameters<typeof buildLivePreview>[0]['custom'],
        currentPrice: context.currentPrice,
        depositAmount: input.depositAmount,
        binStep: context.binStep,
        tickSpacing: context.tickSpacing,
        bins: context.bins,
        bands: context.bands,
        warnings: context.warnings
      });
    },
    queueManualRebalance: async (input) => {
      const queue = executionQueueRefs[input.chain];
      if (!queue) throw new Error(`LP execution queue for ${input.chain} is not running`);
      await queue.add('lp-rebalance-manual', input, {
        jobId: `lp-rebalance-${input.positionId}-${Date.now()}`,
        removeOnComplete: true,
        removeOnFail: 100
      });
    }
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
  const copyWorker = createLpCopyWorker(connection, { executionMode, exactPaper });
  closers.push(() => copyWorker.close());
  for (const [chain, queueName] of Object.entries(LP_EXECUTION_QUEUES_BY_CHAIN)) {
    const queue = new Queue(queueName, { connection });
    executionQueueRefs[chain] = queue;
    closers.push(() => queue.close());

    const worker = new Worker(
      queueName,
      async (job) => {
        if (job.name !== 'lp-paper-operation') throw new Error('legacy LP execution intent unsupported');
        const payload = job.data as { operationId: string; userId: string; chain: import('@swat/shared').LpChain };
        if (payload.chain !== chain) throw new Error('LP operation queue chain mismatch');
        return processLpOperationJob(operationDeps, payload);
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

// Execution workers start BEFORE the cron passes: a monitor pass firing in the
// startup gap would find no queue refs and silently drop its rebalance adds.
await startExecutionWorkers(connection, closers);

cron.schedule(scanCron, () => void runScanGuarded(), { timezone: 'UTC' });
cron.schedule(monitorCron, () => void runMonitorGuarded(), { timezone: 'UTC' });
cron.schedule(riskPassCron, () => void runRiskGuarded(), { timezone: 'UTC' });
cron.schedule(walletIndexCron, () => void runWalletIndexGuarded(), { timezone: 'UTC' });

if (process.env.RUN_ON_STARTUP === 'true') {
  void runScanGuarded();
  void runRiskGuarded();
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
