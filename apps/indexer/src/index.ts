import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import {
  insertParsedTransaction,
  refreshWalletActivity,
  upsertToken,
  upsertWallet,
  getTokenDecimals,
  updateTokenLaunchTimestamp,
  recordFundingEdge,
  logDiscoveryRun
} from '@swat/db';
import { REDIS_CHANNELS, QUEUES, walletInputSchema, fetchTokenPriceUsd } from '@swat/shared';
import {
  extractFundingTransfers,
  extractTokenBuyers,
  getWalletTokenDeltas,
  baseUnitsToFloat,
  SOL_MINT,
  type HeliusParsedTransaction
} from './parse.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const SWAP_PROGRAM_IDS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' // Meteora DLMM
]);

const heliusApiKey = process.env.HELIUS_API_KEY;
const heliusRpcUrl = heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}` : null;

const backfillQueue = new Queue('swat-backfill-wallet', { connection: redis });

export async function ingestWallets(input: Array<{ address: string; source?: 'shiller' | 'manual' | 'discovered'; nickname?: string }>) {
  const parsed = input.map((wallet) => walletInputSchema.safeParse(wallet));
  const valid = parsed.filter((p): p is { success: true; data: { address: string; source: 'shiller' | 'manual' | 'discovered'; nickname?: string } } => p.success).map((p) => p.data);

  for (const wallet of valid) {
    await upsertWallet(wallet);
    await backfillQueue.add('backfill-wallet', { address: wallet.address }, { jobId: `backfill-${wallet.address}`, removeOnComplete: true, removeOnFail: 1000 });
  }

  return { accepted: valid.length, rejected: parsed.length - valid.length };
}

// ─── Helius RPC helpers ───────────────────────────────────────────────────────

type HeliusSignature = { signature: string; slot: number; blockTime?: number };

const HELIUS_RPC_TIMEOUT_MS = Number(process.env.HELIUS_RPC_TIMEOUT_MS ?? 15000);
const HELIUS_MAX_RETRIES = Number(process.env.HELIUS_MAX_RETRIES ?? 5);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function heliusRpc<T>(method: string, params: unknown[]): Promise<T> {
  if (!heliusRpcUrl) throw new Error('HELIUS_API_KEY is not set');

  for (let attempt = 0; ; attempt++) {
    // Without a timeout a single stalled request hangs the whole backfill batch
    // (Promise.all never settles). Abort slow requests so they fail fast.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HELIUS_RPC_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(heliusRpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    // Back off and retry on rate limits (429) and transient 5xx — the Helius
    // free tier throttles aggressively during bulk backfills.
    if ((response.status === 429 || response.status >= 500) && attempt < HELIUS_MAX_RETRIES) {
      const retryAfter = Number(response.headers.get('retry-after')) * 1000;
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 500 * 2 ** attempt;
      await sleep(backoff);
      continue;
    }

    if (!response.ok) throw new Error(`Helius RPC failed: ${response.status}`);

    const json = (await response.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(`Helius RPC error (${method}): ${json.error.message ?? 'unknown'}`);
    return json.result as T;
  }
}

// ─── Token metadata fetcher ───────────────────────────────────────────────────

async function fetchTokenMintInfo(mint: string): Promise<{ decimals: number; mintAuthorityDisabled: boolean; freezeAuthorityDisabled: boolean } | null> {
  if (!heliusRpcUrl) return null;
  try {
    const response = await fetch(heliusRpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'getMintInfo',
        method: 'getAccountInfo',
        params: [mint, { encoding: 'jsonParsed' }]
      })
    });
    if (!response.ok) return null;
    const json = await response.json() as any;
    const info = json.result?.value?.data?.parsed?.info;
    if (!info) return null;
    return {
      decimals: info.decimals ?? 9,
      mintAuthorityDisabled: info.mintAuthority === null,
      freezeAuthorityDisabled: info.freezeAuthority === null
    };
  } catch {
    return null;
  }
}

function extractProgramId(tx: HeliusParsedTransaction): string | null {
  const instructions = tx.transaction?.message?.instructions ?? [];
  const ids = instructions
    .map((i) => i.programId)
    .filter((id): id is string => typeof id === 'string');

  return ids.find((id) => SWAP_PROGRAM_IDS.has(id)) ?? ids[0] ?? null;
}

// ─── SOL Price Cache ──────────────────────────────────────────────────────────

async function getCachedSolPrice(): Promise<number | null> {
  const cached = await redis.get('sol:price');
  if (cached) {
    const p = parseFloat(cached);
    if (Number.isFinite(p)) return p;
  }

  // Negative cache: if the price lookup just failed (e.g. APIs unreachable), a
  // marker is set for a short window so we don't re-hit the network — and
  // re-log the failure — on every single transaction in a backfill batch.
  if (await redis.get('sol:price:fail')) return null;

  // Do NOT fabricate a fallback price — a wrong SOL price silently corrupts every
  // SOL-leg trade's USD value (and gets cached for 30s). Return null on failure
  // and only cache a real price.
  const price = await fetchTokenPriceUsd(SOL_MINT);
  if (price === null || !Number.isFinite(price)) {
    await redis.setex('sol:price:fail', 15, '1');
    return null;
  }
  await redis.setex('sol:price', 30, price.toString());
  return price;
}

// ─── USD Enrichment ───────────────────────────────────────────────────────────

async function enrichTransactionUsd(
  tokenIn: string,
  tokenOut: string,
  amountInStr: string,
  amountOutStr: string,
  targetToken: string
): Promise<{ amountInUsd: number | null; amountOutUsd: number | null }> {
  const solPrice = await getCachedSolPrice();

  // SOL → token (buy) or token → SOL (sell) — both legs measured in SOL.
  // If the SOL price is unavailable, leave USD null rather than fabricating it.
  if (tokenIn === SOL_MINT) {
    if (solPrice === null) return { amountInUsd: null, amountOutUsd: null };
    const amountInUsd = baseUnitsToFloat(amountInStr, 9) * solPrice;
    return { amountInUsd, amountOutUsd: amountInUsd };
  }
  if (tokenOut === SOL_MINT) {
    if (solPrice === null) return { amountInUsd: null, amountOutUsd: null };
    const amountOutUsd = baseUnitsToFloat(amountOutStr, 9) * solPrice;
    return { amountInUsd: amountOutUsd, amountOutUsd };
  }

  // USDC-denominated pairs
  if (tokenIn === USDC_MINT) {
    const amountInUsd = baseUnitsToFloat(amountInStr, 6);
    return { amountInUsd, amountOutUsd: amountInUsd };
  }
  if (tokenOut === USDC_MINT) {
    const amountOutUsd = baseUnitsToFloat(amountOutStr, 6);
    return { amountInUsd: amountOutUsd, amountOutUsd };
  }

  // Token-to-token swaps (Jupiter routed) — use target token price + known decimals
  const targetPrice = await fetchTokenPriceUsd(targetToken);
  if (targetPrice) {
    // Decimals must be known: applying the wrong scale (e.g. defaulting 9-decimal
    // tokens to 6) produces a 1000x-wrong USD value. If we don't know the
    // decimals, leave USD null rather than recording a fabricated number — the
    // backfill-usd pass can fill it once the token's decimals are populated.
    const decimals = await getTokenDecimals(targetToken);
    if (decimals === null) return { amountInUsd: null, amountOutUsd: null };

    // Determine which side is the target
    if (targetToken === tokenOut) {
      const amountUsd = baseUnitsToFloat(amountOutStr, decimals) * targetPrice;
      return { amountInUsd: amountUsd, amountOutUsd: amountUsd };
    } else {
      const amountUsd = baseUnitsToFloat(amountInStr, decimals) * targetPrice;
      return { amountInUsd: amountUsd, amountOutUsd: amountUsd };
    }
  }

  return { amountInUsd: null, amountOutUsd: null };
}

// ─── Process Single Transaction (shared by backfill + webhook) ────────────────

export async function processTransaction(tx: HeliusParsedTransaction, address: string): Promise<'inserted' | 'skipped'> {
  const parsed = getWalletTokenDeltas(tx, address);
  if (!parsed) return 'skipped';

  const signature = tx.transaction?.signatures?.[0];
  if (!signature || !tx.blockTime) return 'skipped';

  // Upsert both tokens — fetch mint info for target token to populate safety data
  const [, targetMintInfo] = await Promise.all([
    upsertToken(parsed.tokenIn),
    fetchTokenMintInfo(parsed.targetToken)
  ]);

  await upsertToken(parsed.targetToken, targetMintInfo ? {
    decimals: targetMintInfo.decimals,
    mintAuthorityDisabled: targetMintInfo.mintAuthorityDisabled,
    freezeAuthorityDisabled: targetMintInfo.freezeAuthorityDisabled
  } : undefined);

  const blockTime = tx.blockTime;
  const timestamp = new Date(blockTime * 1000);

  const { amountInUsd, amountOutUsd } = await enrichTransactionUsd(
    parsed.tokenIn,
    parsed.tokenOut,
    parsed.amountIn,
    parsed.amountOut,
    parsed.targetToken
  );

  const persisted = await insertParsedTransaction({
    signature,
    walletAddress: address,
    tokenIn: parsed.tokenIn,
    tokenOut: parsed.tokenOut,
    amountIn: parsed.amountIn,
    amountOut: parsed.amountOut,
    amountInUsd,
    amountOutUsd,
    direction: parsed.direction,
    targetToken: parsed.targetToken,
    programId: extractProgramId(tx),
    slot: tx.slot ?? null,
    timestamp,
    blockTime
  });

  if (persisted) {
    // Record earliest-seen time for the traded token (powers early-entry score)
    // and any SOL-funding edges observed in this transaction.
    await updateTokenLaunchTimestamp(parsed.targetToken, timestamp);
    await recordFundingEdges(tx);

    await redis.publish(
      REDIS_CHANNELS.walletSwap,
      JSON.stringify({
        walletAddress: address,
        signature,
        direction: parsed.direction,
        targetToken: parsed.targetToken,
        amountInUsd,
        timestamp: timestamp.toISOString()
      })
    );
  }

  return persisted ? 'inserted' : 'skipped';
}

/**
 * Persist any meaningful SOL transfers in this transaction as funding edges.
 * Best-effort: failures are logged but never block ingestion.
 */
async function recordFundingEdges(tx: HeliusParsedTransaction) {
  const transfers = extractFundingTransfers(tx);
  for (const t of transfers) {
    try {
      await recordFundingEdge(t.source, t.destination, t.lamports);
    } catch (error) {
      console.error('[indexer] failed to record funding edge', error);
    }
  }
}

// ─── On-chain token discovery ─────────────────────────────────────────────────

// How many signatures, from the OLDEST (launch) forward, to scan for buyers.
const TOKEN_DISCOVERY_WINDOW = Number(process.env.TOKEN_DISCOVERY_WINDOW ?? 5000);
// Hard cap on total signatures paged while walking back to the launch, so a
// hyper-active token can't make us page forever. If we hit this before reaching
// the genesis the launch time is best-effort (logged).
const TOKEN_DISCOVERY_MAX_TOTAL_SIGNATURES = Number(process.env.TOKEN_DISCOVERY_MAX_TOTAL_SIGNATURES ?? 20000);
// 40 earliest big buyers (kept unconditionally) + 10 biggest buyers (profit-gated
// later by the scorer's pruneUnprofitableBigBuyers).
const EARLY_BUYER_SLOTS = Number(process.env.EARLY_BUYER_SLOTS ?? 40);
const BIG_BUYER_SLOTS = Number(process.env.BIG_BUYER_SLOTS ?? 10);

const SYSTEM_PROGRAM_ID_OWNER = '11111111111111111111111111111111';

// Owners that are never real trader wallets — the mint itself and the swap
// programs. Pool/vault accounts can still slip through; the backfill+scoring
// pass and the token-big profit prune filter those out downstream.
function isDiscardableOwner(owner: string, mint: string): boolean {
  return owner === mint || SWAP_PROGRAM_IDS.has(owner) || owner === SYSTEM_PROGRAM_ID_OWNER;
}

/**
 * Discover and seed a token's early & biggest buyers from on-chain history.
 *
 * 1. Page `getSignaturesForAddress(mint)` back to the launch (bounded by a safety
 *    cap), reverse to chronological order, take the first `TOKEN_DISCOVERY_WINDOW`
 *    signatures from launch forward.
 * 2. Fetch those txs, and for each gather the accounts that net-gained the mint
 *    (`extractTokenBuyers`). Aggregate per owner: earliest buy time + total base
 *    units acquired.
 * 3. Take the 40 EARLIEST distinct buyers (`token-early`, kept unconditionally)
 *    and, from the rest, the 10 LARGEST by acquired amount (`token-big`,
 *    profit-gated later). Upsert each and enqueue a normal history backfill so the
 *    scorer can score/cluster them like any other wallet.
 */
export async function discoverFromToken(mint: string) {
  if (!heliusRpcUrl) {
    console.warn('[indexer] skipping token discovery: HELIUS_API_KEY is not set');
    return { earlyBuyers: 0, bigBuyers: 0, scanned: 0 };
  }

  // ── 1. Walk signatures back to the launch ───────────────────────────────────
  const all: HeliusSignature[] = [];
  let before: string | undefined;
  let cappedOut = false;
  while (all.length < TOKEN_DISCOVERY_MAX_TOTAL_SIGNATURES) {
    const page = await heliusRpc<HeliusSignature[]>('getSignaturesForAddress', [
      mint,
      before ? { limit: 1000, before } : { limit: 1000 }
    ]);
    if (page.length === 0) break;
    all.push(...page);
    before = page[page.length - 1].signature;
    if (page.length < 1000) break; // reached the genesis of this account
    await sleep(150); // gentle pacing
  }
  if (all.length >= TOKEN_DISCOVERY_MAX_TOTAL_SIGNATURES) {
    cappedOut = true;
    console.warn(`[indexer] token ${mint}: hit signature cap (${TOKEN_DISCOVERY_MAX_TOTAL_SIGNATURES}); launch detection best-effort`);
  }
  if (all.length === 0) {
    console.warn(`[indexer] token ${mint}: no signatures found`);
    return { earlyBuyers: 0, bigBuyers: 0, scanned: 0 };
  }

  // Oldest-first. getSignaturesForAddress returns newest→oldest within a page and
  // we paged from newest→oldest, so the global ordering is already newest→oldest;
  // sort ascending by (blockTime, then reversed index) to get launch-forward.
  all.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
  const window = all.slice(0, TOKEN_DISCOVERY_WINDOW);
  const launchBlockTime = window[0]?.blockTime;

  // Ensure the token row + decimals exist so USD math elsewhere works, and record
  // the launch time (LEAST → only moves earlier).
  const mintInfo = await fetchTokenMintInfo(mint);
  await upsertToken(mint, mintInfo ? { decimals: mintInfo.decimals } : undefined);
  if (launchBlockTime) await updateTokenLaunchTimestamp(mint, new Date(launchBlockTime * 1000));

  console.log(`[indexer] token ${mint}: scanning ${window.length}/${all.length} sigs from launch${cappedOut ? ' (capped)' : ''}`);

  // ── 2. Fetch the window's transactions and aggregate buyers ──────────────────
  type Agg = { earliest: number; amount: bigint };
  const buyers = new Map<string, Agg>();
  const sigList = window.map((s) => s.signature);
  const BATCH = Number(process.env.BACKFILL_BATCH_SIZE ?? 5);
  for (let i = 0; i < sigList.length; i += BATCH) {
    if (i > 0) await sleep(150);
    const batch = sigList.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((sig) =>
        heliusRpc<HeliusParsedTransaction | null>('getTransaction', [
          sig,
          { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'jsonParsed' }
        ]).catch(() => null)
      )
    );
    for (const tx of results) {
      if (!tx?.blockTime) continue;
      for (const buyer of extractTokenBuyers(tx, mint)) {
        if (isDiscardableOwner(buyer.owner, mint)) continue;
        const cur = buyers.get(buyer.owner);
        if (cur) {
          cur.amount += buyer.amount;
          if (tx.blockTime < cur.earliest) cur.earliest = tx.blockTime;
        } else {
          buyers.set(buyer.owner, { earliest: tx.blockTime, amount: buyer.amount });
        }
      }
    }
    if ((i / BATCH) % 20 === 0) console.log(`[indexer] token ${mint}: scanned ${Math.min(i + BATCH, sigList.length)}/${sigList.length}`);
  }

  // ── 3. Allocate slots: 40 earliest, then 10 biggest of the rest ──────────────
  const entries = Array.from(buyers.entries()); // [owner, Agg]
  const byEarliest = [...entries].sort((a, b) => a[1].earliest - b[1].earliest);
  const early = byEarliest.slice(0, EARLY_BUYER_SLOTS).map(([owner]) => owner);
  const earlySet = new Set(early);

  const byAmount = [...entries]
    .filter(([owner]) => !earlySet.has(owner))
    .sort((a, b) => (b[1].amount > a[1].amount ? 1 : b[1].amount < a[1].amount ? -1 : 0));
  const big = byAmount.slice(0, BIG_BUYER_SLOTS).map(([owner]) => owner);

  // ── 4. Seed wallets + enqueue history backfill ───────────────────────────────
  for (const owner of early) {
    await upsertWallet({ address: owner, source: 'discovered', discoveryMethod: 'token-early' });
    await backfillQueue.add('backfill-wallet', { address: owner }, { jobId: `backfill-${owner}`, removeOnComplete: true, removeOnFail: 1000 });
  }
  for (const owner of big) {
    await upsertWallet({ address: owner, source: 'discovered', discoveryMethod: 'token-big' });
    await backfillQueue.add('backfill-wallet', { address: owner }, { jobId: `backfill-${owner}`, removeOnComplete: true, removeOnFail: 1000 });
  }

  await logDiscoveryRun('token', mint, early.length + big.length);
  // Tell the scorer to (re)cluster once backfills settle; the profit prune runs
  // there too. Best-effort — the nightly batch would pick it up regardless.
  await redis.publish(REDIS_CHANNELS.clusterRefresh, JSON.stringify({ reason: 'token-discovery', mint }));

  console.log(`[indexer] token ${mint}: seeded ${early.length} early + ${big.length} big buyers from ${buyers.size} candidates`);
  return { earlyBuyers: early.length, bigBuyers: big.length, scanned: window.length };
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

async function backfillWallet(address: string) {
  if (!heliusRpcUrl) {
    console.warn('[indexer] skipping backfill: HELIUS_API_KEY is not set');
    return { fetched: 0, inserted: 0, skipped: 0 };
  }

  const sigLimit = Number(process.env.BACKFILL_SIGNATURE_LIMIT ?? 1000);
  const signatures = await heliusRpc<HeliusSignature[]>('getSignaturesForAddress', [address, { limit: sigLimit }]);
  if (signatures.length === 0) {
    await refreshWalletActivity(address, null, 0);
    return { fetched: 0, inserted: 0, skipped: 0 };
  }

  const signatureList = signatures.map((s) => s.signature);
  console.log(`[indexer] fetching ${signatureList.length} transactions for ${address}`);
  // Solana JSON-RPC has no `getParsedTransactions` (plural) method — Helius
  // replies "Method not found". Fetch each signature with `getTransaction`
  // (jsonParsed), in bounded-concurrency batches to respect rate limits.
  const txs: Array<HeliusParsedTransaction | null> = [];
  const BATCH = Number(process.env.BACKFILL_BATCH_SIZE ?? 5);
  for (let i = 0; i < signatureList.length; i += BATCH) {
    if (i > 0) await sleep(150); // gentle pacing to stay under rate limits
    const batch = signatureList.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((sig) =>
        heliusRpc<HeliusParsedTransaction | null>('getTransaction', [
          sig,
          { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'jsonParsed' }
        ]).catch((err) => {
          console.warn(`[indexer] getTransaction failed for ${sig}:`, err instanceof Error ? err.message : err);
          return null;
        })
      )
    );
    txs.push(...results);
    console.log(`[indexer] ${address}: fetched ${txs.length}/${signatureList.length}`);
  }

  let inserted = 0;
  let skipped = 0;
  let latestBlockTime: number | null = null;

  for (const tx of txs) {
    if (!tx) continue;
    const result = await processTransaction(tx, address);
    if (result === 'inserted') {
      inserted++;
      if (tx.blockTime && (!latestBlockTime || tx.blockTime > latestBlockTime)) {
        latestBlockTime = tx.blockTime;
      }
    } else {
      skipped++;
    }
  }

  await refreshWalletActivity(address, latestBlockTime ? new Date(latestBlockTime * 1000) : null, inserted);
  return { fetched: signatureList.length, inserted, skipped };
}

// ─── BullMQ Worker ────────────────────────────────────────────────────────────

new Worker(
  'swat-backfill-wallet',
  async (job) => {
    const address = (job.data as { address: string }).address;
    console.log(`[indexer] backfill started for ${address}`);
    const result = await backfillWallet(address);
    console.log(`[indexer] backfill complete for ${address}:`, result);
    return { address, ...result };
  },
  // Concurrency 1: backfill one wallet at a time so we don't fan out hundreds of
  // concurrent Helius requests and trip the rate limiter.
  { connection: redis, concurrency: Number(process.env.BACKFILL_CONCURRENCY ?? 1) }
);

// Token-discovery worker: heavy on-chain scan that seeds early/big buyers.
new Worker(
  QUEUES.tokenDiscovery,
  async (job) => {
    const mint = (job.data as { tokenMint: string }).tokenMint;
    console.log(`[indexer] token discovery started for ${mint}`);
    const result = await discoverFromToken(mint);
    console.log(`[indexer] token discovery complete for ${mint}:`, result);
    return { mint, ...result };
  },
  // Concurrency 1: a single discovery already pages thousands of Helius requests;
  // running several in parallel would trip the rate limiter.
  { connection: redis, concurrency: 1 }
);

// ─── Startup seed from env ────────────────────────────────────────────────────

const fromEnv = (process.env.WALLET_ADDRESSES ?? '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean)
  .map((address) => ({ address, source: 'manual' as const }));

if (fromEnv.length > 0) {
  ingestWallets(fromEnv)
    .then((result) => console.log('[indexer] ingestion result', result))
    .catch((error) => {
      console.error('[indexer] ingestion failed', error);
      process.exit(1);
    });
}

console.log('[indexer] service running');
