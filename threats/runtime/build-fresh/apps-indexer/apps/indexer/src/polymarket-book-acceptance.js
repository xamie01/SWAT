/**
 * End-to-end smoke test for the Polymarket book feed (`S4-M38`).
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The feed has 115 unit tests across three modules and every one of them runs
 * against injected fakes: a fake WebSocket, a fake `fetch`, an in-memory
 * key/value store. That is the right way to test the *decisions*, and it is
 * structurally incapable of answering the questions that actually matter on
 * first deployment:
 *
 *   1. Does the venue's WebSocket accept our subscribe frame, and does it push
 *      `book` events for the tokens we asked for?
 *   2. Does `POST /books` accept our body shape and return rows our parser
 *      recognises?
 *   3. Does an entry written by `indexer`'s publisher come back out of Redis
 *      decodable by `signal-engine`'s reader — same key, same wire version?
 *   4. Does the whole chain produce a **priced** verdict, or does it produce a
 *      plausible-looking unknown?
 *
 * Every one of those is a live-infrastructure question. A unit test that mocks
 * the socket cannot fail when the venue renames a field.
 *
 * ── What it needs, and what it does NOT need ──────────────────────────────
 *
 * Needs: **Redis**, and outbound network to Polymarket. That is all.
 *
 * Does **not** need Postgres. The token ids are discovered from the venue's own
 * public Gamma API rather than from `source_trades`, so this runs before any
 * migration has ever been applied — which is deliberate, because the point is to
 * de-risk the feed independently of the database work.
 *
 * ── Read-only and side-effect-bounded ─────────────────────────────────────
 *
 * Writes nothing but its own book keys, which carry the feed's normal TTL and
 * expire on their own. Places no orders, touches no wallet, needs no private
 * key, and never consults `TRADING_MODE` because it cannot trade: there is no
 * order path in this file. Safe to run against production Redis, though a local
 * instance is the obvious choice.
 */
import { Redis } from 'ioredis';
import { assessPolymarketBookDepth, loadPolymarketBookEntry, polymarketBookKey, polymarketBookRedisTransport, POLYMARKET_BOOK_MAX_AGE_MS } from '@swat/shared';
import { createPolymarketBookRuntimeOnRedis, createPolymarketBooksFetcher } from './polymarket-book-runtime.js';
/** Polygon's aggregate-impact ceiling: `DEFAULT_SLIPPAGE_BPS.polygon` x 1/3. */
const CAP_BPS = 100;
/** How long to wait for the stream to deliver a first snapshot. */
const STREAM_WAIT_MS = 20_000;
/** Public market list. No auth, no key — this is the same endpoint the UI uses. */
const GAMMA_MARKETS_URL = 'https://gamma-api.polymarket.com/markets?closed=false&order=volume24hr&ascending=false&limit=5';
const steps = [];
function record(name, ok, detail) {
    steps.push({ name, ok, detail });
    console.log(`[book-acceptance] ${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
}
/**
 * Discover a few live, liquid token ids from the public Gamma API.
 *
 * Deliberately not hardcoded: a token id baked into this file would resolve to a
 * market that has since closed, and the harness would then "fail" for a reason
 * that has nothing to do with our code — the worst kind of smoke test, because
 * it trains you to ignore it.
 */
async function discoverLiveTokenIds() {
    const response = await fetch(GAMMA_MARKETS_URL);
    if (!response.ok) {
        throw new Error(`Gamma returned HTTP ${response.status} listing open markets`);
    }
    const body = await response.json();
    if (!Array.isArray(body)) {
        throw new Error(`Gamma returned a ${typeof body} rather than an array of markets`);
    }
    const tokenIds = [];
    for (const market of body) {
        if (typeof market !== 'object' || market === null)
            continue;
        const raw = market.clobTokenIds;
        // Gamma serialises this as a JSON *string* containing an array.
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(parsed))
            continue;
        for (const id of parsed) {
            if (typeof id === 'string' && id.length > 0)
                tokenIds.push(id);
        }
    }
    if (tokenIds.length === 0) {
        throw new Error('Gamma listed open markets but none carried a clobTokenIds pair');
    }
    // Two tokens is enough to prove the batch path without being noisy.
    return tokenIds.slice(0, 2);
}
/** Poll a predicate until it holds or the budget runs out. */
async function waitFor(label, predicate, budgetMs) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (predicate())
            return true;
        await new Promise((resolve) => {
            setTimeout(resolve, 250);
        });
    }
    console.warn(`[book-acceptance] timed out after ${budgetMs}ms waiting for ${label}`);
    return false;
}
export async function runPolymarketBookAcceptance() {
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    let tokenIds = [];
    let runtime = null;
    try {
        // ── 0. Redis reachable ────────────────────────────────────────────────
        await redis.connect();
        const pong = await redis.ping();
        record('redis reachable', pong === 'PONG', `${redisUrl} replied ${pong}`);
        // ── 1. Discover live markets ──────────────────────────────────────────
        tokenIds = await discoverLiveTokenIds();
        record('discovered live token ids', tokenIds.length > 0, `${tokenIds.length} token(s) from the public Gamma market list`);
        // ── 2. POST /books over the real endpoint ─────────────────────────────
        // Run before the socket, because it is the simpler failure to diagnose: if
        // the REST shape has changed, the stream shape almost certainly has too.
        const rows = await createPolymarketBooksFetcher({
            logger: { warn: (message, error) => console.warn(`[book-acceptance] ${message}`, error ?? '') }
        })(tokenIds);
        const hasRows = rows.length > 0;
        record('POST /books returned rows', hasRows, `${rows.length} row(s) for ${tokenIds.length} token(s)`);
        if (!hasRows) {
            throw new Error(`POST /books returned no rows for ${tokenIds.length} discovered token(s); `
                + 'the REST prerequisite failed, so the stream phase was not started.');
        }
        const firstRow = rows[0];
        const rowHasLadder = typeof firstRow === 'object'
            && firstRow !== null
            && Array.isArray(firstRow.bids)
            && Array.isArray(firstRow.asks);
        record('POST /books row carries a ladder', rowHasLadder, rowHasLadder
            ? 'bids and asks are both arrays, as the parser expects'
            : `row shape is ${JSON.stringify(firstRow).slice(0, 200)}`);
        // ── 3. The live stream, writing through to Redis ──────────────────────
        runtime = createPolymarketBookRuntimeOnRedis(redis, {
            tokenIds,
            logger: {
                info: (message) => console.log(`[book-acceptance] ${message}`),
                warn: (message, error) => console.warn(`[book-acceptance] ${message}`, error ?? '')
            }
        });
        runtime.start();
        const streamed = await waitFor('a book snapshot from the market stream', () => tokenIds.some((id) => runtime?.subscriber.cache.get(id)?.status === 'book'), STREAM_WAIT_MS);
        const stats = runtime.subscriber.stats();
        record('market stream delivered a snapshot', streamed, `applied-snapshot=${stats['applied-snapshot']} applied-delta=${stats['applied-delta']} `
            + `refused-malformed=${stats['refused-malformed-frame']}`);
        // ── 4. Cross-process round trip: writer -> Redis -> reader ────────────
        // This is the step the unit tests structurally cannot cover, because it is
        // the only one where the bytes leave the process.
        const subscribed = tokenIds.find((id) => runtime?.subscriber.cache.get(id)?.status === 'book')
            ?? tokenIds[0];
        const rawFromRedis = await redis.get(polymarketBookKey(subscribed));
        record('publisher wrote the entry to Redis', rawFromRedis !== null, rawFromRedis === null
            ? `no value at ${polymarketBookKey(subscribed)} — the writer half is not reaching Redis`
            : `${rawFromRedis.length} bytes at ${polymarketBookKey(subscribed)}`);
        const transport = polymarketBookRedisTransport({
            get: (key) => redis.get(key),
            set: (key, value, mode, ttlMs) => redis.set(key, value, mode, ttlMs),
            mget: (...keys) => redis.mget(...keys)
        });
        const snapshot = await loadPolymarketBookEntry({ transport, now: () => Date.now(), maxAgeMs: POLYMARKET_BOOK_MAX_AGE_MS }, subscribed);
        const status = snapshot.statusFor(subscribed);
        record('reader decoded the entry', status?.code === 'entry-decoded', `transport code ${status?.code ?? 'none'} — ${status?.detail ?? 'no detail'}`);
        // ── 5. The whole point: a PRICED verdict, not a plausible unknown ─────
        // Gamma's highest-volume markets can still be one-sided at the instant of
        // the smoke test. Evaluate every streamed token and use an assessed book;
        // failing because the first token has no asks would test market selection,
        // not the feed.
        const verdicts = tokenIds.flatMap((tokenId) => ['buy', 'sell'].map((cohortDirection) => ({
            tokenId,
            cohortDirection,
            verdict: assessPolymarketBookDepth(snapshot.cache, {
                tokenMint: `polygon:${tokenId}`,
                cohortDirection,
                impactCapBps: CAP_BPS,
                now: snapshot.readAt
            })
        })));
        const priced = verdicts.find(({ verdict }) => verdict.outcome === 'assessed');
        const verdict = priced?.verdict ?? verdicts[0].verdict;
        record('depth model priced the book', priced !== undefined, priced !== undefined
            ? `token ${priced.tokenId} (${priced.cohortDirection}): usable liquidity $${priced.verdict.liquidity.usableLiquidityUsd?.toFixed(2) ?? '?'} `
                + `at ${CAP_BPS}bps; capacity $${priced.verdict.capacity?.capacityNotionalUsd.toFixed(2) ?? '?'}`
            : `${verdict.reasonCode} — ${verdict.detail}`);
        // A no-depth-within-bound outcome is a legitimate venue condition rather
        // than a feed fault, but it cannot prove the priced depth path in this run.
        if (priced === undefined && verdict.outcome === 'no-depth-within-bound') {
            console.log('[book-acceptance] NOTE every discovered ladder was genuinely empty inside the bound. '
                + 'That is a real market condition, not a feed fault — re-run against a busier market.');
        }
    }
    finally {
        try {
            runtime?.stop();
        }
        catch (error) {
            console.warn('[book-acceptance] runtime shutdown failed', error);
        }
        // Leave no keys behind: this harness should not seed the cache that a real
        // fan-out might then read and trust.
        try {
            if (tokenIds.length > 0) {
                await redis.del(...tokenIds.map((id) => polymarketBookKey(id)));
            }
        }
        catch (error) {
            console.warn('[book-acceptance] key cleanup failed', error);
        }
        redis.disconnect();
    }
    const failed = steps.filter((step) => !step.ok);
    console.log(`\n[book-acceptance] ${steps.length - failed.length}/${steps.length} step(s) passed`);
    if (failed.length > 0) {
        for (const step of failed)
            console.error(`[book-acceptance]   FAILED: ${step.name}`);
        throw new Error(`${failed.length} acceptance step(s) failed. The feed is not proven end to end; `
            + 'see the per-step detail above.');
    }
    console.log('[book-acceptance] the Polymarket book feed works end to end.');
}
//# sourceMappingURL=polymarket-book-acceptance.js.map