import { randomBytes } from 'node:crypto';
import { Queue, QueueEvents, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import {
  closePool,
  insertParsedTransaction,
  query,
  refreshWalletActivity,
  upsertToken,
  upsertWallet
} from '@swat/db';
import {
  createWalletBackfillJob,
  QUEUES,
  resolveChainAddress,
  resolveChainValue,
  type Chain
} from '@swat/shared';
import { createWalletBackfillProcessor } from './backfill-worker.js';
import type { IngestionBatchResult } from './ingestion-health.js';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

type Fixture = {
  chain: Chain;
  address: string;
  signature: string;
  tokenIn: string;
  tokenOut: string;
  targetToken: string;
};

function createFixtures(runId: string): Fixture[] {
  const evmAddress = () => `0x${randomBytes(20).toString('hex')}`;
  return [
    {
      chain: 'solana',
      address: encodeBase58(randomBytes(32)),
      signature: `${runId}-solana`,
      tokenIn: encodeBase58(randomBytes(32)),
      tokenOut: encodeBase58(randomBytes(32)),
      targetToken: encodeBase58(randomBytes(32))
    },
    {
      chain: 'polygon',
      address: evmAddress(),
      signature: `${runId}-polygon`,
      tokenIn: evmAddress(),
      tokenOut: evmAddress(),
      targetToken: evmAddress()
    },
    {
      chain: 'robinhood-chain',
      address: evmAddress(),
      signature: `${runId}-robinhood`,
      tokenIn: evmAddress(),
      tokenOut: evmAddress(),
      targetToken: evmAddress()
    }
  ];
}

export async function runG0D11Acceptance(): Promise<void> {
  const runId = `g0d11-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const fixtures = createFixtures(runId);
  const fixtureByWallet = new Map(
    fixtures.map((fixture) => [`${fixture.chain}:${fixture.address.toLowerCase()}`, fixture])
  );
  const executionCounts = new Map<Chain, number>();
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const queueName = `${QUEUES.walletBackfill}-acceptance-${runId}`;
  const queueConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const eventsConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(queueName, { connection: queueConnection });
  const queueEvents = new QueueEvents(queueName, { connection: eventsConnection });
  let worker: Worker | null = null;
  const jobs: Job[] = [];
  let passSummary: Record<string, unknown> | null = null;
  let primaryError: unknown;

  const backfillFixture = async (address: string, chain: Chain): Promise<IngestionBatchResult> => {
    const fixture = fixtureByWallet.get(`${chain}:${address.toLowerCase()}`);
    if (!fixture) throw new Error(`No ${chain} acceptance fixture for ${address}`);
    executionCounts.set(chain, (executionCounts.get(chain) ?? 0) + 1);

    await Promise.all([
      upsertToken(fixture.tokenIn, { chain, decimals: 6, symbol: 'G0IN' }),
      upsertToken(fixture.tokenOut, { chain, decimals: 6, symbol: 'G0OUT' }),
      upsertToken(fixture.targetToken, { chain, decimals: 6, symbol: 'G0TARGET' })
    ]);
    const eventAt = new Date();
    const inserted = await insertParsedTransaction({
      chain,
      signature: fixture.signature,
      walletAddress: fixture.address,
      tokenIn: fixture.tokenIn,
      tokenOut: fixture.tokenOut,
      amountIn: '1000000',
      amountOut: '2000000',
      amountInUsd: 1,
      amountOutUsd: 2,
      direction: 'buy',
      targetToken: fixture.targetToken,
      programId: 'g0-d11-fixture',
      timestamp: eventAt,
      blockTime: Math.floor(eventAt.getTime() / 1000)
    });
    await refreshWalletActivity(
      resolveChainAddress(fixture.address, chain).prefixed,
      eventAt,
      inserted ? 1 : 0
    );
    return {
      fetched: 1,
      inserted: inserted ? 1 : 0,
      skipped: inserted ? 0 : 1,
      failed: 0,
      lastEventAt: eventAt
    };
  };

  try {
    await queueEvents.waitUntilReady();
    const [existingWorkers, existingJobs] = await Promise.all([
      queue.getWorkers(),
      queue.getJobs(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'])
    ]);
    if (existingWorkers.length > 0 || existingJobs.length > 0) {
      const jobSummary = await Promise.all(existingJobs.map(async (job) => ({
        id: job.id,
        state: await job.getState()
      })));
      throw new Error(
        `Backfill queue is not isolated: ${JSON.stringify({
          workers: existingWorkers.map((workerInfo) => ({
            id: workerInfo.id,
            name: workerInfo.name
          })),
          jobs: jobSummary
        })}`
      );
    }

    for (const fixture of fixtures) {
      await upsertWallet({
        address: fixture.address,
        chain: fixture.chain,
        source: 'discovered',
        discoveryMethod: 'g0-d11-acceptance'
      });
      const spec = createWalletBackfillJob(fixture.address, fixture.chain);
      const first = await queue.add(spec.name, spec.data, spec.options);
      const duplicate = await queue.add(spec.name, spec.data, spec.options);
      if (first.id !== spec.options.jobId || duplicate.id !== first.id) {
        throw new Error(`Queue did not deduplicate ${fixture.chain} job ${spec.options.jobId}`);
      }
      jobs.push(first);
    }

    const queuedIds = new Set(
      (await queue.getJobs(['waiting', 'prioritized'])).map((job) => job.id)
    );
    if (queuedIds.size !== jobs.length || jobs.some((job) => !queuedIds.has(job.id))) {
      throw new Error(`Expected ${jobs.length} unique queued jobs before worker startup`);
    }

    const waits = jobs.map((job) => job.waitUntilFinished(queueEvents, 30_000));
    const processor = createWalletBackfillProcessor({
      backfillSolana: (address) => backfillFixture(address, 'solana'),
      backfillPolygon: (address) => backfillFixture(address, 'polygon'),
      backfillRobinhood: (address) => backfillFixture(address, 'robinhood-chain'),
      recordBatch: async () => {},
      sourceForChain: (chain) => `g0-d11-acceptance-${chain}`
    });
    worker = new Worker(queueName, processor, {
      connection: workerConnection,
      concurrency: 1
    });
    await worker.waitUntilReady();
    const results = await Promise.all(waits);

    for (const fixture of fixtures) {
      if (executionCounts.get(fixture.chain) !== 1) {
        throw new Error(`${fixture.chain} fixture executed ${executionCounts.get(fixture.chain) ?? 0} times`);
      }
    }
    if (results.some((result) => result.inserted !== 1 || result.failed !== 0)) {
      throw new Error(`Backfill results were not successful: ${JSON.stringify(results)}`);
    }

    const signatures = fixtures.map((fixture) => fixture.signature);
    const transactions = await query<{
      chain: Chain;
      signature: string;
      wallet_address: string;
    }>(
      `SELECT chain, signature, wallet_address
         FROM transactions
        WHERE signature = ANY($1::varchar[])
        ORDER BY chain`,
      [signatures]
    );
    if (transactions.length !== fixtures.length) {
      throw new Error(`Expected ${fixtures.length} transaction rows, found ${transactions.length}`);
    }
    for (const fixture of fixtures) {
      const expectedWallet = resolveChainAddress(fixture.address, fixture.chain).prefixed;
      const transaction = transactions.find((row) => row.signature === fixture.signature);
      if (transaction?.chain !== fixture.chain || transaction.wallet_address !== expectedWallet) {
        throw new Error(`Transaction identity mismatch for ${fixture.chain}`);
      }
    }

    passSummary = {
      runId,
      queueName,
      deduplicatedJobs: jobs.map((job) => job.id),
      transactions: transactions.map((row) => ({
        chain: row.chain,
        signature: row.signature,
        walletAddress: row.wallet_address
      }))
    };
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: Error[] = [];
  const cleanupStep = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(new Error(`G0-D11 cleanup failed: ${label}`, { cause: error }));
    }
  };

  await cleanupStep('close worker', async () => {
    await worker?.close();
  });
  await cleanupStep('obliterate isolated queue', async () => {
    await queue.obliterate({ force: true });
  });

  const signatures = fixtures.map((fixture) => fixture.signature);
  const tokenMints = fixtures.flatMap((fixture) => [
    resolveChainValue(fixture.tokenIn, fixture.chain).prefixed,
    resolveChainValue(fixture.tokenOut, fixture.chain).prefixed,
    resolveChainValue(fixture.targetToken, fixture.chain).prefixed
  ]);
  const walletAddresses = fixtures.map((fixture) =>
    resolveChainAddress(fixture.address, fixture.chain).prefixed
  );
  await cleanupStep('delete transaction fixtures', async () => {
    await query('DELETE FROM transactions WHERE signature = ANY($1::varchar[])', [signatures]);
  });
  await cleanupStep('delete token fixtures', async () => {
    await query('DELETE FROM tokens WHERE mint = ANY($1::varchar[])', [tokenMints]);
  });
  await cleanupStep('delete wallet fixtures', async () => {
    await query('DELETE FROM wallets WHERE address = ANY($1::varchar[])', [walletAddresses]);
  });
  await cleanupStep('verify database fixture cleanup', async () => {
    const [counts] = await query<{
      transaction_count: string;
      token_count: string;
      wallet_count: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM transactions WHERE signature = ANY($1::varchar[])) AS transaction_count,
         (SELECT COUNT(*) FROM tokens WHERE mint = ANY($2::varchar[])) AS token_count,
         (SELECT COUNT(*) FROM wallets WHERE address = ANY($3::varchar[])) AS wallet_count`,
      [signatures, tokenMints, walletAddresses]
    );
    if (
      !counts
      || Number(counts.transaction_count) !== 0
      || Number(counts.token_count) !== 0
      || Number(counts.wallet_count) !== 0
    ) {
      throw new Error(`Fixture rows remain after cleanup: ${JSON.stringify(counts)}`);
    }
  });
  await cleanupStep('close queue events', () => queueEvents.close());
  await cleanupStep('close queue', () => queue.close());
  await cleanupStep('close queue Redis connection', () => queueConnection.quit());
  await cleanupStep('close event Redis connection', () => eventsConnection.quit());
  await cleanupStep('close worker Redis connection', () => workerConnection.quit());
  await cleanupStep('close PostgreSQL pool', () => closePool());

  const errors = [primaryError, ...cleanupErrors].filter((error) => error !== undefined);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'G0-D11 acceptance and cleanup encountered multiple failures');
  }

  console.log('[G0-D11] PASS', JSON.stringify(passSummary));
}
