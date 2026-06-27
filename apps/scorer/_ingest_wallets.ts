/**
 * SWAT Wallet Ingestion Tool
 * 
 * Reads the generated `wallet-starter-pack.json` from the project root,
 * upserts the wallets into the PostgreSQL database, and enqueues them
 * for on-chain indexing via BullMQ.
 * 
 * Run: npx tsx --env-file=../../.env _ingest_wallets.ts
 */
import { upsertWallet } from '@swat/db';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const backfillQueue = new Queue('swat-backfill-wallet', { connection });

async function run() {
  // Look for starter pack in the project root (two levels up from apps/scorer)
  const jsonPath = path.resolve(process.cwd(), '../../wallet-starter-pack.json');
  
  if (!fs.existsSync(jsonPath)) {
    console.error(`\n❌ ERROR: ${jsonPath} not found.`);
    console.error('Please run the discoverer first to generate it:');
    console.error('npx tsx --env-file=.env discover-starter-pack.ts\n');
    process.exit(1);
  }

  const wallets = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as string[];
  console.log(`Starting ingestion of ${wallets.length} wallets from ${jsonPath}...`);
  
  let inserted = 0;
  for (const address of wallets) {
    try {
      await upsertWallet({
        address,
        source: 'discovered'
      });
      
      // Enqueue a backfill job
      await backfillQueue.add(
        'backfill-wallet',
        { address },
        { 
          jobId: `backfill-${address}`, 
          removeOnComplete: true, 
          removeOnFail: 1000 
        }
      );
      
      console.log(`  Processed & enqueued: ${address}`);
      inserted++;
    } catch (e: any) {
      console.error(`  Failed to process ${address}:`, e.message);
    }
  }

  console.log(`\nSuccessfully ingested and enqueued ${inserted}/${wallets.length} wallets for indexing.`);
  await connection.quit();
  process.exit(0);
}

run().catch(console.error);
