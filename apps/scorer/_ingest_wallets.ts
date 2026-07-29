/**
 * SWAT Wallet Ingestion Tool
 *
 * Reads the generated `wallet-starter-pack.json` from the repository root,
 * validates the chain-aware input, upserts the wallets, and enqueues them for
 * on-chain indexing via BullMQ.
 *
 * Run: npx tsx --env-file=../../.env _ingest_wallets.ts
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { readFile } from 'node:fs/promises';
import { upsertWallet } from '@swat/db';
import {
  createWalletBackfillJob,
  QUEUES
} from '@swat/shared';
import {
  parseStarterPackWallets,
  parseWalletChain,
  resolveStarterPackPath
} from './src/starter-pack.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const backfillQueue = new Queue(QUEUES.walletBackfill, { connection });

async function run() {
  const walletChain = parseWalletChain(process.env.WALLET_CHAIN);
  const jsonPath = resolveStarterPackPath(
    import.meta.url,
    process.env.STARTER_PACK_PATH
  );

  let wallets;
  try {
    wallets = parseStarterPackWallets(
      await readFile(jsonPath, 'utf8'),
      walletChain
    );
  } catch (error) {
    throw new Error(
      `Unable to load starter pack at ${jsonPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  console.log(`Starting ingestion of ${wallets.length} wallets from ${jsonPath}...`);

  let inserted = 0;
  for (const wallet of wallets) {
    try {
      await upsertWallet({
        address: wallet.address,
        chain: wallet.chain,
        source: 'discovered'
      });

      const job = createWalletBackfillJob(wallet.address, wallet.chain);
      await backfillQueue.add(job.name, job.data, job.options);

      console.log(`  Processed & enqueued: ${wallet.chain}:${wallet.address}`);
      inserted++;
    } catch (error) {
      console.error(
        `  Failed to process ${wallet.chain}:${wallet.address}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  console.log(
    `\nSuccessfully ingested and enqueued ${inserted}/${wallets.length} wallets for indexing.`
  );
}

run()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await backfillQueue.close();
    await connection.quit();
  });
