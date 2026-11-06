import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { insertParsedTransaction, refreshWalletActivity, upsertToken, upsertWallet, getTokenDecimals, updateTokenLaunchTimestamp, recordFundingEdge, recordIngestionBatch, logDiscoveryRun, loadPolymarketBookSubscriptionSet } from '@swat/db';
import { createWalletBackfillJob, clampInteger, REDIS_CHANNELS, QUEUES, walletInputSchema, fetchTokenPriceUsd, initLogger, prefixChainValue } from '@swat/shared';
import { extractFundingTransfers, extractTokenBuyers, parseCanonicalSolanaSwapEvent, baseUnitsToFloat, SOL_MINT } from './parse.js';
import { backfillEvmWallet, discoverFromEvmToken } from './evm.js';
import { createPolymarketBookRuntimeOnRedis } from './polymarket-book-runtime.js';
import { backfillPolymarketWallet, pollPolymarketResolutions } from './polymarket.js';
import { IngestionBatchError } from './ingestion-health.js';
import { parseSeedWalletAddresses } from './seed-wallets.js';
import { createWalletBackfillProcessor } from './backfill-worker.js';
import { persistSolanaSourceTrade, SourceTradePersistenceError } from './source-trade-lifecycle.js';
initLogger('indexer');
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
const backfillQueue = new Queue(QUEUES.walletBackfill, { connection: redis });
export async function ingestWallets(input) {
    const parsed = input.map((wallet) => walletInputSchema.safeParse(wallet));
    const valid = parsed.filter((p) => p.success).map((p) => p.data);
    for (const wallet of valid) {
        await upsertWallet(wallet);
        const job = createWalletBackfillJob(wallet.address, wallet.chain);
        await backfillQueue.add(job.name, job.data, job.options);
    }
    return { accepted: valid.length, rejected: parsed.length - valid.length };
}
const HELIUS_RPC_TIMEOUT_MS = Number(process.env.HELIUS_RPC_TIMEOUT_MS ?? 15000);
const HELIUS_MAX_RETRIES = Number(process.env.HELIUS_MAX_RETRIES ?? 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function heliusRpc(method, params) {
    if (!heliusRpcUrl)
        throw new Error('HELIUS_API_KEY is not set');
    for (let attempt = 0;; attempt++) {
        // Without a timeout a single stalled request hangs the whole backfill batch
        // (Promise.all never settles). Abort slow requests so they fail fast.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HELIUS_RPC_TIMEOUT_MS);
        let response;
        try {
            response = await fetch(heliusRpcUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
                signal: controller.signal
            });
        }
        finally {
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
        if (!response.ok)
            throw new Error(`Helius RPC failed: ${response.status}`);
        const json = (await response.json());
        if (json.error)
            throw new Error(`Helius RPC error (${method}): ${json.error.message ?? 'unknown'}`);
        return json.result;
    }
}
// ─── Token metadata fetcher ───────────────────────────────────────────────────
async function fetchTokenMintInfo(mint) {
    if (!heliusRpcUrl)
        return null;
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
        if (!response.ok)
            return null;
        const json = await response.json();
        const info = json.result?.value?.data?.parsed?.info;
        if (!info)
            return null;
        return {
            decimals: info.decimals ?? 9,
            mintAuthorityDisabled: info.mintAuthority === null,
            freezeAuthorityDisabled: info.freezeAuthority === null
        };
    }
    catch {
        return null;
    }
}
function extractProgramId(tx) {
    const instructions = tx.transaction?.message?.instructions ?? [];
    const ids = instructions
        .map((i) => i.programId)
        .filter((id) => typeof id === 'string');
    return ids.find((id) => SWAP_PROGRAM_IDS.has(id)) ?? ids[0] ?? null;
}
// ─── SOL Price Cache ──────────────────────────────────────────────────────────
async function getCachedSolPrice() {
    const cached = await redis.get('sol:price');
    if (cached) {
        const p = parseFloat(cached);
        if (Number.isFinite(p))
            return p;
    }
    // Negative cache: if the price lookup just failed (e.g. APIs unreachable), a
    // marker is set for a short window so we don't re-hit the network — and
    // re-log the failure — on every single transaction in a backfill batch.
    if (await redis.get('sol:price:fail'))
        return null;
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
async function enrichTransactionUsd(tokenIn, tokenOut, amountInStr, amountOutStr, targetToken) {
    const solPrice = await getCachedSolPrice();
    // SOL → token (buy) or token → SOL (sell) — both legs measured in SOL.
    // If the SOL price is unavailable, leave USD null rather than fabricating it.
    if (tokenIn === SOL_MINT) {
        if (solPrice === null)
            return { amountInUsd: null, amountOutUsd: null };
        const amountInUsd = baseUnitsToFloat(amountInStr, 9) * solPrice;
        return { amountInUsd, amountOutUsd: amountInUsd };
    }
    if (tokenOut === SOL_MINT) {
        if (solPrice === null)
            return { amountInUsd: null, amountOutUsd: null };
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
        if (decimals === null)
            return { amountInUsd: null, amountOutUsd: null };
        // Determine which side is the target
        if (targetToken === tokenOut) {
            const amountUsd = baseUnitsToFloat(amountOutStr, decimals) * targetPrice;
            return { amountInUsd: amountUsd, amountOutUsd: amountUsd };
        }
        else {
            const amountUsd = baseUnitsToFloat(amountInStr, decimals) * targetPrice;
            return { amountInUsd: amountUsd, amountOutUsd: amountUsd };
        }
    }
    return { amountInUsd: null, amountOutUsd: null };
}
// ─── Process Single Transaction (shared by backfill + webhook) ────────────────
export async function processTransaction(tx, address, source = 'solana-backfill') {
    const canonicalEvent = parseCanonicalSolanaSwapEvent(tx, address);
    if (!canonicalEvent)
        return 'skipped';
    const parsed = canonicalEvent;
    const signature = canonicalEvent.transactionIdentity;
    // Upsert both tokens — fetch mint info for target token to populate safety data
    const [, , targetMintInfo] = await Promise.all([
        upsertToken(parsed.tokenIn),
        upsertToken(parsed.tokenOut),
        fetchTokenMintInfo(parsed.targetToken)
    ]);
    await upsertToken(parsed.targetToken, targetMintInfo ? {
        decimals: targetMintInfo.decimals,
        mintAuthorityDisabled: targetMintInfo.mintAuthorityDisabled,
        freezeAuthorityDisabled: targetMintInfo.freezeAuthorityDisabled
    } : undefined);
    const blockTime = tx.blockTime;
    const timestamp = canonicalEvent.occurredAt;
    const { amountInUsd, amountOutUsd } = await enrichTransactionUsd(parsed.tokenIn, parsed.tokenOut, parsed.amountIn, parsed.amountOut, parsed.targetToken);
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
    const sourceTrade = await persistSolanaSourceTrade({
        event: canonicalEvent,
        source
    });
    if (persisted) {
        // Record earliest-seen time for the traded token (powers early-entry score)
        // and any SOL-funding edges observed in this transaction.
        await updateTokenLaunchTimestamp(parsed.targetToken, timestamp);
        await recordFundingEdges(tx);
        await redis.publish(REDIS_CHANNELS.walletSwap, JSON.stringify({
            chain: 'solana',
            walletAddress: prefixChainValue(address, 'solana'),
            signature,
            sourceTradeId: sourceTrade.event.id,
            tokenMint: prefixChainValue(parsed.targetToken, 'solana'),
            direction: parsed.direction,
            amountUsd: amountInUsd,
            timestamp: timestamp.toISOString()
        }));
    }
    return persisted ? 'inserted' : 'skipped';
}
/**
 * Persist any meaningful SOL transfers in this transaction as funding edges.
 * Best-effort: failures are logged but never block ingestion.
 */
async function recordFundingEdges(tx) {
    const transfers = extractFundingTransfers(tx);
    for (const t of transfers) {
        try {
            await recordFundingEdge(t.source, t.destination, t.lamports);
        }
        catch (error) {
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
function isDiscardableOwner(owner, mint) {
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
export async function discoverFromToken(mint) {
    if (!heliusRpcUrl) {
        console.warn('[indexer] skipping token discovery: HELIUS_API_KEY is not set');
        return { earlyBuyers: 0, bigBuyers: 0, scanned: 0 };
    }
    // ── 1. Walk signatures back to the launch ───────────────────────────────────
    const all = [];
    let before;
    let cappedOut = false;
    while (all.length < TOKEN_DISCOVERY_MAX_TOTAL_SIGNATURES) {
        const page = await heliusRpc('getSignaturesForAddress', [
            mint,
            before ? { limit: 1000, before } : { limit: 1000 }
        ]);
        if (page.length === 0)
            break;
        all.push(...page);
        before = page[page.length - 1].signature;
        if (page.length < 1000)
            break; // reached the genesis of this account
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
    // we paged from newest→oldest, so the global ordering is already newest→oldest.
    // Reversing ensures intra-slot order is oldest→newest.
    all.reverse();
    all.sort((a, b) => {
        if (a.blockTime != null && b.blockTime != null && a.blockTime !== b.blockTime) {
            return a.blockTime - b.blockTime;
        }
        return a.slot - b.slot;
    });
    const window = all.slice(0, TOKEN_DISCOVERY_WINDOW);
    const launchBlockTime = window[0]?.blockTime;
    // Ensure the token row + decimals exist so USD math elsewhere works, and record
    // the launch time (LEAST → only moves earlier).
    const mintInfo = await fetchTokenMintInfo(mint);
    await upsertToken(mint, mintInfo ? { decimals: mintInfo.decimals } : undefined);
    if (launchBlockTime)
        await updateTokenLaunchTimestamp(mint, new Date(launchBlockTime * 1000));
    console.log(`[indexer] token ${mint}: scanning ${window.length}/${all.length} sigs from launch${cappedOut ? ' (capped)' : ''}`);
    const buyers = new Map();
    const sigList = window.map((s) => s.signature);
    const BATCH = Number(process.env.BACKFILL_BATCH_SIZE ?? 5);
    for (let i = 0; i < sigList.length; i += BATCH) {
        if (i > 0)
            await sleep(150);
        const batch = sigList.slice(i, i + BATCH);
        const results = await Promise.all(batch.map((sig) => heliusRpc('getTransaction', [
            sig,
            { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'jsonParsed' }
        ]).catch(() => null)));
        for (const tx of results) {
            if (!tx?.blockTime)
                continue;
            for (const buyer of extractTokenBuyers(tx, mint)) {
                if (isDiscardableOwner(buyer.owner, mint))
                    continue;
                const cur = buyers.get(buyer.owner);
                if (cur) {
                    cur.amount += buyer.amount;
                    if (tx.blockTime < cur.earliest)
                        cur.earliest = tx.blockTime;
                }
                else {
                    buyers.set(buyer.owner, { earliest: tx.blockTime, amount: buyer.amount });
                }
            }
        }
        if ((i / BATCH) % 20 === 0)
            console.log(`[indexer] token ${mint}: scanned ${Math.min(i + BATCH, sigList.length)}/${sigList.length}`);
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
        await upsertWallet({ address: owner, chain: 'solana', source: 'discovered', discoveryMethod: 'token-early' });
        const job = createWalletBackfillJob(owner, 'solana');
        await backfillQueue.add(job.name, job.data, job.options);
    }
    for (const owner of big) {
        await upsertWallet({ address: owner, chain: 'solana', source: 'discovered', discoveryMethod: 'token-big' });
        const job = createWalletBackfillJob(owner, 'solana');
        await backfillQueue.add(job.name, job.data, job.options);
    }
    await logDiscoveryRun('token', mint, early.length + big.length);
    // Tell the scorer to (re)cluster once backfills settle; the profit prune runs
    // there too. Best-effort — the nightly batch would pick it up regardless.
    await redis.publish(REDIS_CHANNELS.clusterRefresh, JSON.stringify({ reason: 'token-discovery', mint }));
    console.log(`[indexer] token ${mint}: seeded ${early.length} early + ${big.length} big buyers from ${buyers.size} candidates`);
    return { earlyBuyers: early.length, bigBuyers: big.length, scanned: window.length };
}
// ─── Backfill ─────────────────────────────────────────────────────────────────
export async function backfillWallet(address) {
    if (!heliusRpcUrl) {
        throw new Error('HELIUS_API_KEY is not set');
    }
    const sigLimit = clampInteger(process.env.BACKFILL_SIGNATURE_LIMIT, 1000, 1, 1000);
    const signatures = await heliusRpc('getSignaturesForAddress', [address, { limit: sigLimit }]);
    if (signatures.length === 0) {
        await refreshWalletActivity(address.includes(':') ? address : `solana:${address}`, null, 0);
        return {
            fetched: 0,
            inserted: 0,
            skipped: 0,
            failed: 0,
            lastEventAt: null
        };
    }
    const signatureList = signatures.map((s) => s.signature);
    console.log(`[indexer] fetching ${signatureList.length} transactions for ${address}`);
    // Solana JSON-RPC has no `getParsedTransactions` (plural) method — Helius
    // replies "Method not found". Fetch each signature with `getTransaction`
    // (jsonParsed), in bounded-concurrency batches to respect rate limits.
    const txs = [];
    let failed = 0;
    const BATCH = Number(process.env.BACKFILL_BATCH_SIZE ?? 5);
    for (let i = 0; i < signatureList.length; i += BATCH) {
        if (i > 0)
            await sleep(150); // gentle pacing to stay under rate limits
        const batch = signatureList.slice(i, i + BATCH);
        const results = await Promise.all(batch.map((sig) => heliusRpc('getTransaction', [
            sig,
            { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'jsonParsed' }
        ]).catch((err) => {
            console.warn(`[indexer] getTransaction failed for ${sig}:`, err instanceof Error ? err.message : err);
            failed++;
            return undefined;
        })));
        txs.push(...results);
        console.log(`[indexer] ${address}: fetched ${txs.length}/${signatureList.length}`);
    }
    let inserted = 0;
    let skipped = 0;
    let latestBlockTime = null;
    let lastEventAt = null;
    let sourceTradeFailure = null;
    for (const tx of txs) {
        if (tx === undefined)
            continue;
        if (tx === null) {
            skipped++;
            continue;
        }
        if (tx.blockTime) {
            const eventAt = new Date(tx.blockTime * 1000);
            if (!lastEventAt || eventAt > lastEventAt)
                lastEventAt = eventAt;
        }
        try {
            const result = await processTransaction(tx, address);
            if (result === 'inserted') {
                inserted++;
                if (tx.blockTime && (!latestBlockTime || tx.blockTime > latestBlockTime)) {
                    latestBlockTime = tx.blockTime;
                }
            }
            else {
                skipped++;
            }
        }
        catch (error) {
            failed++;
            if (error instanceof SourceTradePersistenceError) {
                sourceTradeFailure ??= error;
            }
            console.warn(`[indexer] failed to process Solana transaction ${tx.transaction?.signatures?.[0] ?? 'unknown'}:`, error);
        }
    }
    const result = {
        fetched: signatureList.length,
        inserted,
        skipped,
        failed,
        lastEventAt
    };
    try {
        await refreshWalletActivity(address.includes(':') ? address : `solana:${address}`, latestBlockTime ? new Date(latestBlockTime * 1000) : null, inserted);
    }
    catch (error) {
        throw new IngestionBatchError(`Failed to refresh Solana wallet activity for ${address}`, { ...result, failed: result.failed + 1 }, { cause: error });
    }
    if (sourceTradeFailure) {
        throw new IngestionBatchError(`Canonical Solana source-trade persistence failed for ${address}`, result, { cause: sourceTradeFailure });
    }
    return result;
}
// ─── BullMQ Worker ────────────────────────────────────────────────────────────
new Worker(QUEUES.walletBackfill, createWalletBackfillProcessor({
    backfillSolana: backfillWallet,
    backfillPolygon: backfillPolymarketWallet,
    backfillRobinhood: (address) => backfillEvmWallet(address, 'robinhood-chain'),
    recordBatch: recordIngestionBatch
}), 
// Concurrency 1: backfill one wallet at a time so we don't fan out hundreds of
// concurrent RPC requests and trip the rate limiter.
{ connection: redis, concurrency: Number(process.env.BACKFILL_CONCURRENCY ?? 1) }).on('error', (err) => console.error('[indexer] backfill worker error', err));
// Token-discovery worker: heavy on-chain scan that seeds early/big buyers.
new Worker(QUEUES.tokenDiscovery, async (job) => {
    const { tokenMint, chain = 'solana' } = job.data;
    console.log(`[indexer] token discovery started for ${tokenMint} on ${chain}`);
    const result = chain === 'solana'
        ? await discoverFromToken(tokenMint)
        : await discoverFromEvmToken(tokenMint, chain, { backfillQueue });
    console.log(`[indexer] token discovery complete for ${tokenMint} on ${chain}:`, result);
    return { mint: tokenMint, chain, ...result };
}, 
// Concurrency 1: a single discovery already pages thousands of Helius requests;
// running several in parallel would trip the rate limiter.
{ connection: redis, concurrency: 1 }).on('error', (err) => console.error('[indexer] discovery worker error', err));
// ─── Startup seed from env ────────────────────────────────────────────────────
const fromEnv = parseSeedWalletAddresses(process.env.WALLET_ADDRESSES);
if (fromEnv.length > 0) {
    ingestWallets(fromEnv)
        .then((result) => console.log('[indexer] ingestion result', result))
        .catch((error) => {
        console.error('[indexer] ingestion failed', error);
        process.exit(1);
    });
}
// ─── Polymarket resolution polling ────────────────────────────────────────────
// Check active markets every 15 minutes for resolution.
setInterval(() => {
    pollPolymarketResolutions().catch(console.error);
}, 15 * 60 * 1000);
pollPolymarketResolutions().catch(console.error);
// ─── Polymarket order-book feed (S4-M38) ──────────────────────────────────────
/**
 * Streams Polymarket order books into Redis so `signal-engine` can gate fan-out
 * on real depth before admitting copiers.
 *
 * **Why this lives here.** The book is the only honest liquidity figure for a
 * Polymarket outcome share — it trades on Polymarket's own CLOB, not a DEX pair,
 * so DexScreener TVL is either absent or belongs to an unrelated Polygon pair.
 * Without this feed every polygon cohort reads `capacity-unknown` and nobody
 * copies a Polymarket signal.
 *
 * **Failure is bounded on purpose.** Everything below degrades rather than
 * throws: a failed seed starts with no markets, a dropped socket invalidates
 * books to `awaiting-snapshot`, a failed resync lets entries age into
 * `book-snapshot-stale`. Every one of those reads as *unknown* downstream, which
 * excludes copiers rather than admitting them against depth nobody measured. A
 * throw here, by contrast, would take down the process that also ingests Solana
 * and Robinhood Chain.
 */
/**
 * How often the subscription set is recomputed.
 *
 * Five minutes, not the resync cadence: this is a *membership* refresh (which
 * markets exist and matter), not a *freshness* refresh (what the book says).
 * Freshness is the subscriber's own 15s resync. A market that becomes active
 * between refreshes is simply unsubscribed until the next one, which reads as
 * `book-not-cached` and excludes its cohort — fail-closed, and the cost of a
 * tighter cadence is a repeated scan of two tables for a set that rarely moves.
 */
const POLYMARKET_BOOK_SUBSCRIPTION_REFRESH_MS = 5 * 60 * 1000;
const polymarketBookRuntime = createPolymarketBookRuntimeOnRedis(redis, {
    logger: {
        info: (message) => console.log(`[indexer] ${message}`),
        warn: (message, error) => console.warn(`[indexer] ${message}`, error ?? '')
    }
});
polymarketBookRuntime.start();
/**
 * Seed the subscription set, then refresh it periodically.
 *
 * The set is the union of markets a tracked master traded recently and markets
 * somebody still holds — the first are fan-out candidates, the second have to
 * stay exitable. Refreshed on a cadence because a market that becomes active
 * after boot would otherwise never be subscribed until the next restart.
 */
async function refreshPolymarketBookSubscriptions() {
    const set = await loadPolymarketBookSubscriptionSet({
        now: new Date(),
        onFailure: (detail) => console.warn(`[indexer] ${detail}`)
    });
    polymarketBookRuntime.subscriber.subscribe(set.tokenIds);
    console.log(`[indexer] polymarket book subscriptions: ${set.tokenIds.length} market(s) `
        + `(${set.counts.recentTrade} recently traded, ${set.counts.openPosition} held)`
        + `${set.evicted === 0 ? '' : `, ${set.evicted} evicted by the cap`}`);
}
void refreshPolymarketBookSubscriptions().catch((error) => {
    console.warn('[indexer] polymarket book subscription seed failed', error);
});
setInterval(() => {
    void refreshPolymarketBookSubscriptions().catch((error) => {
        console.warn('[indexer] polymarket book subscription refresh failed', error);
    });
}, POLYMARKET_BOOK_SUBSCRIPTION_REFRESH_MS);
// ─── Shutdown ─────────────────────────────────────────────────────────────────
/**
 * Stop the book feed on the way out.
 *
 * `stop()` invalidates every cached book before closing the socket, so a
 * deliberate shutdown cannot leave entries in Redis that look fresh while
 * nothing is updating them. Registered for both signals because a container stop
 * sends SIGTERM and an interactive run sends SIGINT.
 */
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    console.log(`[indexer] ${signal} received; stopping the polymarket book feed`);
    try {
        polymarketBookRuntime.stop();
    }
    catch (error) {
        console.warn('[indexer] book feed shutdown failed', error);
    }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
console.log('[indexer] service running');
//# sourceMappingURL=index.js.map