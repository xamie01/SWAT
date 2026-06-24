import cron from 'node-cron';
import { Redis } from 'ioredis';
import { REDIS_CHANNELS } from '@swat/shared';
import {
  findFundedUnknownWallets,
  findFrequentCounterparties,
  logDiscoveryRun,
  upsertWallet
} from '@swat/db';

async function ingestDiscoveredWallets(addresses: string[], source: string, seedValue: string) {
  let ingested = 0;
  for (const address of addresses) {
    try {
      await upsertWallet({ address, source: 'discovered' });
      ingested++;
    } catch (e) {
      console.error(`[discovery] Failed to ingest ${address}:`, e);
    }
  }
  
  await logDiscoveryRun(source, seedValue, ingested);
  return ingested;
}

export async function runFundingGraphExpansion() {
  console.log('[discovery] Running funding graph expansion...');
  const addresses = await findFundedUnknownWallets();
  if (addresses.length > 0) {
    const ingested = await ingestDiscoveredWallets(addresses, 'funding', 'elite_wallets');
    console.log(`[discovery] Ingested ${ingested} wallets from funding graph.`);
  } else {
    console.log('[discovery] No new wallets found from funding graph.');
  }
}

export async function runCounterpartyDiscovery() {
  console.log('[discovery] Running counterparty discovery...');
  const addresses = await findFrequentCounterparties();
  if (addresses.length > 0) {
    const ingested = await ingestDiscoveredWallets(addresses, 'counterparty', 'elite_wallets');
    console.log(`[discovery] Ingested ${ingested} wallets from counterparties.`);
  } else {
    console.log('[discovery] No new counterparties found.');
  }
}

async function runNightlyDiscovery() {
  console.log('[discovery] Starting nightly discovery batch...');
  await runFundingGraphExpansion();
  await runCounterpartyDiscovery();
  console.log('[discovery] Batch complete.');
}

cron.schedule('30 2 * * *', () => {
  runNightlyDiscovery().catch(console.error);
}, {
  timezone: "UTC"
});

// On-demand discovery: the API's POST /v1/discovery/run publishes here. Without
// this subscriber the endpoint was a silent no-op (returned success, did
// nothing). A simple in-flight guard prevents overlapping manual+nightly runs.
let discoveryRunning = false;
async function runNightlyDiscoverySafe() {
  if (discoveryRunning) {
    console.log('[discovery] run already in progress, ignoring trigger.');
    return;
  }
  discoveryRunning = true;
  try {
    await runNightlyDiscovery();
  } catch (e) {
    console.error('[discovery] run failed', e);
  } finally {
    discoveryRunning = false;
  }
}

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });

function subscribeChannels() {
  subscriber.subscribe(REDIS_CHANNELS.discoveryRun, REDIS_CHANNELS.discoverySeedToken, (err) => {
    if (err) console.error('[discovery] subscribe failed', err);
    else console.log('[discovery] subscribed to discovery channels.');
  });
}
subscribeChannels();
// ioredis does not auto-resubscribe after a reconnect — do it explicitly.
subscriber.on('ready', subscribeChannels);
subscriber.on('error', (e) => console.error('[discovery] redis error', e.message));

subscriber.on('message', (channel) => {
  if (channel === REDIS_CHANNELS.discoveryRun || channel === REDIS_CHANNELS.discoverySeedToken) {
    void runNightlyDiscoverySafe();
  }
});

console.log('[discovery] Service running. Scheduled at 02:30 UTC daily; listening for on-demand triggers.');

if (process.env.RUN_ON_STARTUP === 'true') {
  void runNightlyDiscoverySafe();
}
