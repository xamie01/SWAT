import { POLYMARKET_BOOK_MAX_AGE_MS, POLYMARKET_BOOK_RESYNC_INTERVAL_MS } from './polymarket-book-depth.js';
import { getChainPrefix, stripChainPrefix } from './address.js';
/**
 * Cross-service transport for the `S4-M38` order-book depth cache.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 *
 * `polymarket-book-subscriber.ts` fills an **in-process** `Map` inside `indexer`.
 * `assessPolymarketBookDepth` is called from **`signal-engine`**, a different
 * process. Without a bridge the subscriber is a cache nothing reads and every
 * polygon fan-out still excludes everyone as `capacity-unknown` -- the exact
 * outcome `S4-M38` was supposed to end. This module is that bridge, and nothing
 * more: a writer that publishes a `PolymarketBookEntry` and a reader that serves
 * one back in the shape the depth model already consumes.
 *
 * It re-implements **none** of the depth maths, the freshness policy or the
 * variant semantics. Those are settled in `polymarket-book-depth.ts`; this file's
 * only job is to move an entry across a process boundary without changing what it
 * means.
 *
 * ── The transport is a port, not a Redis client ────────────────────────────
 *
 * `ioredis` is deliberately **not imported here**, exactly as the subscriber
 * refuses to import it. The seam is `PolymarketBookKeyValueTransport` below: three
 * methods, all of which a `Redis` instance satisfies structurally and a ten-line
 * fake satisfies in a test. That is the same seam shape the repo already uses for
 * `fetchImpl` in `polymarket-clob-credentials.ts`, `EvmNonceLock` in
 * `robinhood.ts` and `transportFactory` in the subscriber, and it is what lets
 * every rule in this file be exercised with no Redis running.
 *
 * ── The sync/async tension, resolved rather than papered over ──────────────
 *
 * `PolymarketBookCache.get` is **synchronous** (`(tokenId) => PolymarketBookEntry
 * | undefined`) and Redis is not. Four options were considered:
 *
 *   1. **Change the interface to async.** Rejected: `assessPolymarketBookDepth` is
 *      a pure synchronous function 37 tests deep, and the instruction for this
 *      item is that it consumes the reader *unchanged*.
 *   2. **Block on the promise.** Not possible in Node without a worker, and it
 *      would put a synchronous network wait on the money path.
 *   3. **A background-refreshed local mirror** (`setInterval` polling Redis into a
 *      `Map`). Rejected: it adds a *second* staleness budget on top of
 *      `POLYMARKET_BOOK_MAX_AGE_MS`, and the age the reader then measures is the
 *      age of the mirror's copy rather than of the observation. Two freshness
 *      clocks that can disagree is how a stale book reads fresh.
 *   4. **Snapshot, then read.** Chosen. `loadPolymarketBookSnapshot` does one
 *      `mget` for the tokens a caller is about to assess, decodes them, and
 *      returns a frozen, *synchronous* `PolymarketBookCache` over the decoded map.
 *      The `await` sits where it belongs -- at the call site, before the pure
 *      assessment -- and the entry the reader ages is the entry the writer stored,
 *      with `observedAt` untouched. A snapshot is explicitly a point-in-time read:
 *      it is built per fan-out and thrown away, never held across decisions,
 *      because a retained snapshot would silently age.
 *
 * The snapshot also records, per token, **why** a token has no entry -- see
 * `PolymarketBookTransportCode`. The bare `PolymarketBookCache` contract can only
 * say `undefined`, which the depth model correctly reads as `book-not-cached`; but
 * "the key was missing" and "the value would not decode" are different operator
 * actions, so the snapshot keeps them apart alongside the cache view rather than
 * inside it.
 *
 * ── Serialisation must not lose the variant ────────────────────────────────
 *
 * The subscriber's whole structural defence is that an `awaiting-snapshot` entry
 * **has no ladder field at all**, so a gap cannot be misread as a thin book. A
 * codec that emitted `{status, bids: [], asks: []}` for both variants would
 * reintroduce that bug at the wire: the gap would deserialise into a valid,
 * fresh, *empty* book, and the reader would answer `book-empty` (or worse, a
 * priced zero) instead of `book-awaiting-snapshot`. So:
 *
 *   * the encoder writes a **discriminated payload**, and writes `ladders` only
 *     for `status: 'book'` and `since` only for `status: 'awaiting-snapshot'`;
 *   * the decoder **refuses** a `book` payload with no `ladders` object and an
 *     `awaiting-snapshot` payload carrying one, rather than filling in a default.
 *     A defaulted ladder is a fabricated ladder.
 *
 * ── Three distinct facts, three distinct codes ─────────────────────────────
 *
 * A missing key, a malformed value and a stale entry are **never** coalesced, and
 * none of them is ever a zero:
 *
 *   * `key-missing` -- cold start, or the subscriber is not wired. Nobody has
 *     written this token.
 *   * `value-malformed` / `version-skew` -- something *was* written and cannot be
 *     trusted. A serialisation bug or a rolling deploy of two incompatible
 *     versions, not a market condition.
 *   * `entry-stale` -- the writer is alive but behind. A venue or subscriber
 *     problem.
 *
 * The reader deliberately **does not withhold** a stale entry from the cache view:
 * `assessPolymarketBookDepth` owns the freshness budget and answers
 * `book-snapshot-stale` with the age, which is strictly more informative than an
 * absent key. `polymarketBookEntryFreshness` exists so the snapshot can *report*
 * staleness for observability without becoming a second gate. A malformed value,
 * by contrast, is withheld -- there is no entry to hand over.
 *
 * ── Pure where it can be ──────────────────────────────────────────────────
 *
 * Key derivation, encoding, decoding and the freshness decision are pure
 * functions with their own tests. `now` is always an argument; this module never
 * reads a clock or an environment variable. Only `publish` and `load` touch the
 * transport.
 */
// ═══════════════════════════════════════════════════════════════════════════
// Wire version and keys
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The serialised-form version, written on every payload and checked on every read.
 *
 * **Why a version tag at all.** The two processes deploy separately, so during any
 * rollout an old writer and a new reader coexist. Without a tag, a shape change
 * that happens to be structurally compatible -- renaming `since`, moving `bids`
 * up a level, switching `size` to a string -- deserialises into *something*, and
 * the something is a wrong number that nothing complains about. With a tag, skew
 * is a **named** failure (`version-skew`) that fails closed to
 * `capacity-unknown`, which is the direction this repo always chooses.
 *
 * Bump this whenever the payload shape changes. Do not add fields silently.
 */
export const POLYMARKET_BOOK_WIRE_VERSION = 1;
/**
 * Key namespace, following the repo's existing `swat:<domain>:<detail>` convention
 * (`swat:trade-executor:pending:trojan:v1`, `swat:alert:claim:<id>`,
 * `swat:siwe:<nonce>`).
 *
 * The trailing `v1` mirrors the runtime stores' own suffix and is a **second,
 * coarser** guard than the payload version: a shape change severe enough that old
 * keys must not be read at all bumps the prefix, so the new reader simply sees
 * `key-missing` on old data instead of decoding it. The payload version handles
 * the finer case where the key is right and the body is not.
 */
export const POLYMARKET_BOOK_KEY_PREFIX = 'swat:polymarket:book:v1';
/**
 * TTL for a published entry, and the reasoning it is tied to rather than picked.
 *
 * TTL and staleness are related but **not the same question**. Staleness
 * (`POLYMARKET_BOOK_MAX_AGE_MS`, 30s) asks "may this be priced?" and is the
 * reader's to answer. TTL asks "should this key still exist?" and is a
 * garbage-collection decision. Getting the relationship wrong breaks diagnosis in
 * one direction or the other:
 *
 *   * **TTL below the age budget** turns a stale-but-readable entry into a missing
 *     key. The reader would then answer `book-not-cached` -- "subscribe this
 *     market" -- for a market that *is* subscribed by a subscriber that has fallen
 *     behind. That sends the operator to the wrong place, and it is the specific
 *     mistake this constant exists to prevent. Hence the assertion in
 *     `assertPolymarketBookTtlBudget`.
 *   * **TTL far above the age budget** leaves dead keys around after a subscriber
 *     dies, so `mget` keeps returning entries long after anything is writing them.
 *     Those read `book-snapshot-stale` rather than `book-not-cached`, which is
 *     survivable but still points at the venue instead of at the dead process.
 *
 * So: `POLYMARKET_BOOK_MAX_AGE_MS + POLYMARKET_BOOK_RESYNC_INTERVAL_MS` = 45s.
 * Derived from the two existing constants, never a fresh number. It is the
 * tightest value that still guarantees **every** entry inside the age budget is
 * readable -- the budget itself, plus exactly one resync period of slack so an
 * entry written just before a missed resync survives long enough to be *reported
 * as stale* rather than vanishing -- and it expires a dead subscriber's keys
 * within one and a half budgets, so `book-not-cached` reappears promptly when the
 * writer is genuinely gone.
 */
export const POLYMARKET_BOOK_ENTRY_TTL_MS = POLYMARKET_BOOK_MAX_AGE_MS + POLYMARKET_BOOK_RESYNC_INTERVAL_MS;
/** A caller-side mistake: a bad token, a TTL that breaks the budget relation. */
export class PolymarketBookTransportError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PolymarketBookTransportError';
    }
}
/**
 * The transport key for one bare CLOB token id.
 *
 * Accepts the repo-wide `polygon:<id>` form or the bare `asset_id`, and strips the
 * prefix -- the same tolerance `assessPolymarketBookDepth` offers, so neither side
 * has to remember which form it holds. A prefix from another chain throws: a
 * Solana mint reaching the Polymarket book transport is a routing bug, not a
 * market condition.
 */
export function polymarketBookKey(tokenMint) {
    if (typeof tokenMint !== 'string' || tokenMint.length === 0 || tokenMint.trim() !== tokenMint) {
        throw new PolymarketBookTransportError('tokenMint must be a non-empty string with no surrounding whitespace');
    }
    const prefix = getChainPrefix(tokenMint);
    if (prefix !== null && prefix !== 'polygon') {
        throw new PolymarketBookTransportError(`tokenMint ${tokenMint} is prefixed ${prefix}, but Polymarket order books exist only on `
            + 'polygon. A non-polygon token reaching the book transport is a routing bug.');
    }
    // `stripChainPrefix` throws a bare `Error` for a prefix with nothing after it
    // (`polygon:`). Re-wrapped so every caller-side mistake on this path carries
    // one error type and a `catch` in the publisher cannot miss half of them.
    let tokenId;
    try {
        tokenId = stripChainPrefix(tokenMint);
    }
    catch (error) {
        throw new PolymarketBookTransportError(`tokenMint ${tokenMint} is not a usable token id: `
            + `${error instanceof Error ? error.message : String(error)}`);
    }
    if (tokenId.length === 0) {
        throw new PolymarketBookTransportError(`tokenMint ${tokenMint} has no token id after the prefix`);
    }
    return `${POLYMARKET_BOOK_KEY_PREFIX}:${tokenId}`;
}
/**
 * Assert the TTL can hold every entry the reader is still willing to price.
 *
 * Throws rather than warning, for the reason `assertPolymarketBookResyncBudget`
 * throws: the symptom of a too-short TTL is `book-not-cached` on a subscribed
 * market, which reads as a deployment gap and would send an operator to debug a
 * subscriber that is working.
 */
export function assertPolymarketBookTtlBudget(input) {
    const { ttlMs, maxAgeMs } = input;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new PolymarketBookTransportError(`ttlMs must be a positive finite number, got ${ttlMs}`);
    }
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
        throw new PolymarketBookTransportError(`maxAgeMs must be a positive finite number, got ${maxAgeMs}`);
    }
    if (ttlMs < maxAgeMs) {
        throw new PolymarketBookTransportError(`A ${ttlMs}ms TTL is shorter than the reader's ${maxAgeMs}ms freshness budget, so an entry `
            + 'the reader would still report as stale would instead be a missing key. That reports the '
            + 'wrong cause: book-not-cached says "subscribe this market", book-snapshot-stale says "the '
            + 'subscriber is behind". The TTL must be at least the age budget.');
    }
}
/**
 * In-memory transport for tests and for a single-process deployment.
 *
 * Honours TTL against an injected clock rather than a timer, so expiry is testable
 * without waiting. Not a Redis substitute for production: nothing here is shared
 * across processes, which is the entire problem this module solves.
 */
export function createInMemoryPolymarketBookTransport(now) {
    const store = new Map();
    const read = (key) => {
        const held = store.get(key);
        if (held === undefined)
            return null;
        if (held.expiresAt <= now()) {
            store.delete(key);
            return null;
        }
        return held.value;
    };
    return {
        get: async (key) => read(key),
        set: async (key, value, ttlMs) => {
            store.set(key, { value, expiresAt: now() + ttlMs });
        },
        mget: async (keys) => keys.map(read),
        size: () => store.size
    };
}
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function encodeLevels(levels) {
    return levels.map((level) => ({ price: level.price, size: level.size }));
}
/**
 * Encode one entry to its wire payload.
 *
 * Separate from `serializePolymarketBookEntry` so a test can assert the *shape*
 * -- specifically that an `awaiting-snapshot` payload has no `ladders` key at all
 * -- without going through JSON.
 */
export function encodePolymarketBookEntry(entry) {
    if (entry.status === 'awaiting-snapshot') {
        return {
            v: POLYMARKET_BOOK_WIRE_VERSION,
            status: 'awaiting-snapshot',
            tokenId: entry.tokenId,
            since: entry.since,
            ...(entry.bestBid === undefined ? {} : { bestBid: entry.bestBid }),
            ...(entry.bestAsk === undefined ? {} : { bestAsk: entry.bestAsk })
        };
    }
    return {
        v: POLYMARKET_BOOK_WIRE_VERSION,
        status: 'book',
        tokenId: entry.tokenId,
        observedAt: entry.observedAt,
        ladders: {
            bids: encodeLevels(entry.ladders.bids),
            asks: encodeLevels(entry.ladders.asks)
        },
        ...(entry.venueTimestamp === undefined ? {} : { venueTimestamp: entry.venueTimestamp }),
        ...(entry.tickSize === undefined ? {} : { tickSize: entry.tickSize }),
        ...(entry.minOrderSize === undefined ? {} : { minOrderSize: entry.minOrderSize })
    };
}
/** JSON, over the discriminated payload. No `Date`, no `bigint`, so no custom codec. */
export function serializePolymarketBookEntry(entry) {
    return JSON.stringify(encodePolymarketBookEntry(entry));
}
function decodeLevels(raw) {
    if (!Array.isArray(raw))
        return null;
    const levels = [];
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            return null;
        const candidate = item;
        // Refused rather than filtered, and NOT coerced from a string: the venue
        // reports decimal strings and the subscriber parses them, so a string here
        // means an unparsed frame reached the wire. `Number('')` is 0, which is
        // exactly the fabricated-zero this refusal prevents.
        if (!finite(candidate.price) || !finite(candidate.size))
            return null;
        levels.push({ price: candidate.price, size: candidate.size });
    }
    return levels;
}
/**
 * Decode one stored string back to an entry, or say precisely why not.
 *
 * The three refusal codes are kept apart because they are three different jobs:
 * fix the JSON writer, finish the deploy, or fix the entry producer. Nothing is
 * defaulted anywhere in here -- see the `entry-invalid` docs.
 */
export function deserializePolymarketBookEntry(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        return {
            ok: false,
            code: 'value-malformed',
            detail: `Stored Polymarket book value is not JSON: `
                + `${error instanceof Error ? error.message : String(error)}`
        };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            ok: false,
            code: 'value-malformed',
            detail: `Stored Polymarket book value decoded to ${Array.isArray(parsed) ? 'an array' : typeof parsed}, not an object`
        };
    }
    const payload = parsed;
    // Version first, before any field is read. A skewed payload's fields may be
    // *structurally* fine and *semantically* wrong, so checking the shape first
    // would accept it.
    if (payload.v !== POLYMARKET_BOOK_WIRE_VERSION) {
        return {
            ok: false,
            code: 'version-skew',
            detail: `Stored Polymarket book value carries wire version ${String(payload.v)}, but this reader `
                + `speaks ${POLYMARKET_BOOK_WIRE_VERSION}. Refused rather than decoded: a shape change that `
                + 'happens to be structurally compatible would produce a wrong number silently. Finish the '
                + 'rollout, or bump POLYMARKET_BOOK_KEY_PREFIX so old keys are not read at all.'
        };
    }
    const tokenId = payload.tokenId;
    if (typeof tokenId !== 'string' || tokenId.length === 0) {
        return {
            ok: false,
            code: 'entry-invalid',
            detail: `Stored Polymarket book value has no usable tokenId (got ${String(tokenId)})`
        };
    }
    if (payload.status === 'awaiting-snapshot') {
        // The load-bearing refusal, in the gap-to-book direction. An
        // `awaiting-snapshot` payload that arrives carrying a ladder is a writer that
        // has confused the two variants, and accepting it would mean the reader could
        // later be handed a ladder for a book that has none.
        if (payload.ladders !== undefined) {
            return {
                ok: false,
                code: 'entry-invalid',
                detail: `Stored Polymarket book value for ${tokenId} is awaiting-snapshot but carries a ladders `
                    + 'field. The variant has no ladder by construction; a ladder here means the writer '
                    + 'confused the two variants.'
            };
        }
        if (!finite(payload.since)) {
            return {
                ok: false,
                code: 'entry-invalid',
                detail: `Stored Polymarket book value for ${tokenId} is awaiting-snapshot with a non-finite `
                    + `since (${String(payload.since)}), so the gap has no start time.`
            };
        }
        const entry = {
            status: 'awaiting-snapshot',
            tokenId,
            since: payload.since,
            ...(payload.bestBid === undefined ? {} : { bestBid: payload.bestBid }),
            ...(payload.bestAsk === undefined ? {} : { bestAsk: payload.bestAsk })
        };
        return { ok: true, entry };
    }
    if (payload.status !== 'book') {
        return {
            ok: false,
            code: 'entry-invalid',
            detail: `Stored Polymarket book value for ${tokenId} has status ${String(payload.status)}, which is `
                + 'neither book nor awaiting-snapshot. Guessing which was meant is how a gap becomes a book.'
        };
    }
    // The load-bearing refusal, in the book-to-gap direction. A `book` payload with
    // no ladder must NOT be filled in with empty arrays: that is exactly the bug the
    // subscriber's structural design prevents, reintroduced at the wire. An entry
    // with `ladders: {bids: [], asks: []}` is fresh, valid and reads as an observed
    // book with nothing in it -- a number where there should have been a gap.
    const ladders = payload.ladders;
    if (ladders === null || typeof ladders !== 'object' || Array.isArray(ladders)) {
        return {
            ok: false,
            code: 'entry-invalid',
            detail: `Stored Polymarket book value for ${tokenId} has status book but no ladders object. `
                + 'Refused rather than defaulted to empty sides: an empty ladder reads as an observed thin '
                + 'book rather than as a gap, which is the exact distinction the awaiting-snapshot variant '
                + 'exists to keep.'
        };
    }
    const bids = decodeLevels(ladders.bids);
    const asks = decodeLevels(ladders.asks);
    if (bids === null || asks === null) {
        return {
            ok: false,
            code: 'entry-invalid',
            detail: `Stored Polymarket book value for ${tokenId} has a ladder side that is not an array of `
                + '{price, size} numbers. Refused rather than filtered: dropping the level we failed to '
                + 'read is how an understated book becomes an overstated one.'
        };
    }
    if (!finite(payload.observedAt)) {
        return {
            ok: false,
            code: 'entry-invalid',
            detail: `Stored Polymarket book value for ${tokenId} has a non-finite observedAt `
                + `(${String(payload.observedAt)}). observedAt is the only clock we control and the figure `
                + 'staleness is measured against, so an entry without one cannot be aged.'
        };
    }
    const ladderValue = { bids, asks };
    const entry = {
        status: 'book',
        tokenId,
        observedAt: payload.observedAt,
        ladders: ladderValue,
        ...(payload.venueTimestamp === undefined
            ? {}
            : { venueTimestamp: payload.venueTimestamp }),
        ...(payload.tickSize === undefined ? {} : { tickSize: payload.tickSize }),
        ...(payload.minOrderSize === undefined
            ? {}
            : { minOrderSize: payload.minOrderSize })
    };
    return { ok: true, entry };
}
/**
 * Freshness of a decoded entry, for observability only.
 *
 * **Not a gate.** `assessPolymarketBookDepth` owns the budget and produces the
 * reason code with the age attached; this exists so a snapshot can *count* stale
 * entries without a second threshold that could disagree with the first. It
 * therefore defaults to the same `POLYMARKET_BOOK_MAX_AGE_MS` rather than to a
 * number of its own.
 *
 * `awaiting-snapshot` returns its own value rather than `fresh` or `stale`,
 * because the variant has no ladder and so has nothing whose age would matter --
 * calling it `fresh` would read as "fine".
 */
export function polymarketBookEntryFreshness(input) {
    if (input.entry.status === 'awaiting-snapshot')
        return 'awaiting-snapshot';
    if (!finite(input.entry.observedAt) || !finite(input.now))
        return 'age-unknown';
    const maxAgeMs = input.maxAgeMs ?? POLYMARKET_BOOK_MAX_AGE_MS;
    if (!finite(maxAgeMs) || maxAgeMs <= 0)
        return 'age-unknown';
    return input.now - input.entry.observedAt > maxAgeMs ? 'stale' : 'fresh';
}
/**
 * The writer half: one `set` per entry, at the derived key, with the derived TTL.
 *
 * **Round-trips its own payload before writing.** Cheap (one parse of a small
 * object, off the money path -- this runs in `indexer`, not in the fan-out) and it
 * converts the worst failure mode from silent to loud: an entry that this
 * process's own reader could not decode is refused at the writer with
 * `publish-refused` rather than sitting in Redis until `signal-engine` chokes on
 * it in a different process, where the origin is much harder to find.
 */
export function createPolymarketBookPublisher(options) {
    const ttlMs = options.ttlMs ?? POLYMARKET_BOOK_ENTRY_TTL_MS;
    const maxAgeMs = options.maxAgeMs ?? POLYMARKET_BOOK_MAX_AGE_MS;
    assertPolymarketBookTtlBudget({ ttlMs, maxAgeMs });
    const fail = (result) => {
        if (!result.ok && options.onFailure !== undefined)
            options.onFailure(result);
        return result;
    };
    return {
        ttlMs,
        publish: async (entry) => {
            let key;
            let payload;
            try {
                key = polymarketBookKey(entry.tokenId);
                payload = serializePolymarketBookEntry(entry);
                const roundTrip = deserializePolymarketBookEntry(payload);
                if (!roundTrip.ok) {
                    return fail({
                        ok: false,
                        key,
                        code: 'publish-refused',
                        detail: `Refusing to publish a Polymarket book entry this reader cannot decode `
                            + `(${roundTrip.code}): ${roundTrip.detail}`
                    });
                }
                if (roundTrip.entry.status !== entry.status) {
                    // Cannot happen through the codec above; asserted anyway because a
                    // variant flip is the one corruption that produces a plausible number.
                    return fail({
                        ok: false,
                        key,
                        code: 'publish-refused',
                        detail: `Round-trip of ${entry.tokenId} changed status from ${entry.status} to `
                            + `${roundTrip.entry.status}. A variant flip turns a gap into a book, so the write is refused.`
                    });
                }
            }
            catch (error) {
                return fail({
                    ok: false,
                    key: null,
                    code: 'publish-refused',
                    detail: error instanceof Error ? error.message : String(error)
                });
            }
            try {
                await options.transport.set(key, payload, ttlMs);
                return { ok: true, key, code: 'entry-published' };
            }
            catch (error) {
                return fail({
                    ok: false,
                    key,
                    code: 'transport-failed',
                    detail: `Transport write failed for ${entry.tokenId}: `
                        + `${error instanceof Error ? error.message : String(error)}. The reader will see `
                        + 'key-missing, which fails closed to capacity-unknown.'
                });
            }
        }
    };
}
const ZERO_COUNTS = Object.freeze({
    'entry-decoded': 0,
    'key-missing': 0,
    'value-malformed': 0,
    'version-skew': 0,
    'entry-invalid': 0,
    'entry-stale': 0
});
/**
 * Turn a batch of raw transport slots into a snapshot. Pure.
 *
 * Split out from the I/O so every decision -- which code a slot gets, whether a
 * stale entry is still served, how a duplicate token is handled -- is testable
 * without a transport at all.
 *
 * A **malformed or skewed value is withheld** from the cache view: there is no
 * entry to hand over, and the reader then answers `book-not-cached`. That is a
 * mild misattribution (nothing was written vs something unreadable was), which is
 * why the precise code stays on `statuses` where an operator sees it. A **stale
 * entry is served**, because the reader's own `book-snapshot-stale` carries the
 * age and is strictly more informative than an absent key.
 */
export function buildPolymarketBookSnapshot(input) {
    const entries = new Map();
    const statuses = [];
    const counts = { ...ZERO_COUNTS };
    for (const slot of input.slots) {
        const record = (code, entry, freshness, detail) => {
            counts[code] += 1;
            statuses.push(Object.freeze({ tokenId: slot.tokenId, key: slot.key, code, entry, freshness, detail }));
        };
        if (slot.value === null) {
            record('key-missing', null, null, `No transport value at ${slot.key}. Cold start, an unsubscribed market, an unwired `
                + 'publisher, or a TTL expiry after the writer died. This is not zero depth: nothing has '
                + 'been observed.');
            continue;
        }
        const decoded = deserializePolymarketBookEntry(slot.value);
        if (!decoded.ok) {
            record(decoded.code, null, null, decoded.detail);
            continue;
        }
        // The wire carries its own tokenId, and the key carries one too. A mismatch
        // means a writer stored one token's book under another's key, which would
        // price a cohort against the wrong market -- so it is refused rather than
        // resolved in favour of either side.
        if (decoded.entry.tokenId !== slot.tokenId) {
            record('entry-invalid', null, null, `Transport value at ${slot.key} carries tokenId ${decoded.entry.tokenId}, which is not the `
                + `${slot.tokenId} the key names. Refused: a mismatch would price a cohort against another `
                + 'market\'s book.');
            continue;
        }
        const freshness = polymarketBookEntryFreshness({
            entry: decoded.entry,
            now: input.readAt,
            ...(input.maxAgeMs === undefined ? {} : { maxAgeMs: input.maxAgeMs })
        });
        entries.set(slot.tokenId, decoded.entry);
        if (freshness === 'stale') {
            record('entry-stale', decoded.entry, freshness, `Transport value at ${slot.key} decoded but was observed `
                + `${input.readAt - (decoded.entry.status === 'book' ? decoded.entry.observedAt : decoded.entry.since)}ms `
                + 'ago, past the freshness budget. Still handed to the depth reader, which reports '
                + 'book-snapshot-stale with the age -- an absent key would name the wrong cause.');
        }
        else {
            record('entry-decoded', decoded.entry, freshness, `Transport value at ${slot.key} decoded as ${decoded.entry.status} (${freshness}).`);
        }
    }
    const byToken = new Map(statuses.map((status) => [status.tokenId, status]));
    return Object.freeze({
        // Frozen map view: `get` takes the bare token id, exactly as
        // `PolymarketBookCache` documents and as `assessPolymarketBookDepth` calls it
        // after stripping the prefix itself.
        cache: Object.freeze({ get: (tokenId) => entries.get(tokenId) }),
        readAt: input.readAt,
        statuses: Object.freeze(statuses),
        statusFor: (tokenMint) => byToken.get(stripChainPrefix(tokenMint)),
        counts: Object.freeze(counts)
    });
}
/**
 * Load a snapshot for the given tokens: **one** `mget`, then a pure build.
 *
 * One round trip per fan-out rather than one per token, which is what makes this
 * affordable on the pre-fan-out path. Duplicate tokens are collapsed before the
 * `mget` so a caller passing the same market twice does not pay twice.
 *
 * On a transport failure every requested token reads `key-missing` rather than
 * throwing: a Redis outage must degrade polygon to `capacity-unknown`, not abort
 * the whole fan-out for every chain. The failure is still reported on
 * `statuses[].detail` and via `onTransportFailure`.
 */
export async function loadPolymarketBookSnapshot(options, tokenMints, onTransportFailure) {
    const readAt = options.now();
    const seen = new Map();
    for (const mint of tokenMints) {
        const key = polymarketBookKey(mint);
        seen.set(stripChainPrefix(mint), key);
    }
    const tokenIds = [...seen.keys()];
    const keys = [...seen.values()];
    if (keys.length === 0) {
        return buildPolymarketBookSnapshot({
            slots: [],
            readAt,
            ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs })
        });
    }
    let values;
    try {
        values = await options.transport.mget(keys);
    }
    catch (error) {
        const detail = `Polymarket book transport mget failed for ${keys.length} key(s): `
            + `${error instanceof Error ? error.message : String(error)}. Every token reads key-missing, `
            + 'which fails closed to capacity-unknown rather than aborting the fan-out.';
        if (onTransportFailure !== undefined)
            onTransportFailure(detail);
        values = keys.map(() => null);
    }
    // `MGET` promises one slot per key, in order. An adapter that reorders or
    // compacts would attribute one token's book to another, so a length mismatch is
    // refused wholesale rather than zipped best-effort.
    if (values.length !== keys.length) {
        const detail = `Polymarket book transport returned ${values.length} slot(s) for ${keys.length} key(s). `
            + 'MGET must return one slot per key in order; a mismatch could attribute one market\'s book '
            + 'to another, so every token reads key-missing instead.';
        if (onTransportFailure !== undefined)
            onTransportFailure(detail);
        values = keys.map(() => null);
    }
    return buildPolymarketBookSnapshot({
        slots: tokenIds.map((tokenId, index) => ({
            tokenId,
            key: keys[index],
            value: values[index] ?? null
        })),
        readAt,
        ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs })
    });
}
/**
 * Single-token convenience: one `get`, one snapshot.
 *
 * Exists because the wired call site in `signal-engine` assesses **one** token per
 * fan-out. `loadPolymarketBookSnapshot` remains the batch form for a caller that
 * has several.
 */
export async function loadPolymarketBookEntry(options, tokenMint, onTransportFailure) {
    const readAt = options.now();
    const key = polymarketBookKey(tokenMint);
    const tokenId = stripChainPrefix(tokenMint);
    let value;
    try {
        value = await options.transport.get(key);
    }
    catch (error) {
        const detail = `Polymarket book transport get failed for ${key}: `
            + `${error instanceof Error ? error.message : String(error)}. Reads key-missing, which fails `
            + 'closed to capacity-unknown.';
        if (onTransportFailure !== undefined)
            onTransportFailure(detail);
        value = null;
    }
    return buildPolymarketBookSnapshot({
        slots: [{ tokenId, key, value }],
        readAt,
        ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs })
    });
}
/**
 * Adapt an `ioredis`-shaped client to the port.
 *
 * Takes the *methods* rather than a `Redis` instance, so `ioredis` is still not
 * imported anywhere in this package's book code and the adapter itself is
 * testable. `set(key, value, 'PX', ttlMs)` is the millisecond form; `PX` rather
 * than `EX` because the TTL here is derived from millisecond constants and
 * rounding it to seconds would let a 45_000ms budget become 45s-or-44s depending
 * on the client.
 */
export function polymarketBookRedisTransport(client) {
    return {
        get: (key) => client.get(key),
        set: async (key, value, ttlMs) => {
            // Redis rejects a non-integer PX, and a 0 would delete on write.
            await client.set(key, value, 'PX', Math.max(1, Math.ceil(ttlMs)));
        },
        mget: (keys) => client.mget(...keys)
    };
}
//# sourceMappingURL=polymarket-book-transport.js.map