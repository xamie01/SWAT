import { type PolymarketBookCache, type PolymarketBookEntry } from './polymarket-book-depth.js';
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
export declare const POLYMARKET_BOOK_WIRE_VERSION = 1;
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
export declare const POLYMARKET_BOOK_KEY_PREFIX = "swat:polymarket:book:v1";
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
export declare const POLYMARKET_BOOK_ENTRY_TTL_MS: number;
/** A caller-side mistake: a bad token, a TTL that breaks the budget relation. */
export declare class PolymarketBookTransportError extends Error {
    constructor(message: string);
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
export declare function polymarketBookKey(tokenMint: string): string;
/**
 * Assert the TTL can hold every entry the reader is still willing to price.
 *
 * Throws rather than warning, for the reason `assertPolymarketBookResyncBudget`
 * throws: the symptom of a too-short TTL is `book-not-cached` on a subscribed
 * market, which reads as a deployment gap and would send an operator to debug a
 * subscriber that is working.
 */
export declare function assertPolymarketBookTtlBudget(input: {
    readonly ttlMs: number;
    readonly maxAgeMs: number;
}): void;
/**
 * The narrowest key-value port that can carry this cache.
 *
 * Structurally satisfied by an `ioredis` `Redis` instance (`get`, `mget` and a
 * `set(key, value, 'PX', ttl)` wrapper) and by an in-memory fake. `ttlMs` is
 * expressed in milliseconds and left to the adapter to translate, so no Redis
 * argument spelling leaks into this module.
 *
 * `mget` returns one slot per requested key, in order, `null` for a key that does
 * not exist -- the `MGET` contract. An adapter that reorders or compacts the
 * result would silently attribute one token's book to another, so the ordering is
 * part of the contract and `loadPolymarketBookSnapshot` checks the length.
 */
export interface PolymarketBookKeyValueTransport {
    readonly get: (key: string) => Promise<string | null>;
    readonly set: (key: string, value: string, ttlMs: number) => Promise<void>;
    readonly mget: (keys: readonly string[]) => Promise<readonly (string | null)[]>;
}
/**
 * In-memory transport for tests and for a single-process deployment.
 *
 * Honours TTL against an injected clock rather than a timer, so expiry is testable
 * without waiting. Not a Redis substitute for production: nothing here is shared
 * across processes, which is the entire problem this module solves.
 */
export declare function createInMemoryPolymarketBookTransport(now: () => number): PolymarketBookKeyValueTransport & {
    readonly size: () => number;
};
/**
 * Why a transport read produced no usable entry, or what it produced.
 *
 * **Stable strings**, per the `refuse` / `unavailable` split in
 * `apps/trade-executor/src/solana-simulation.ts`: telemetry keys on them, so they
 * are appended to rather than renamed. Each one is a *different operator action*,
 * which is the reason there is no single `unavailable`.
 */
export type PolymarketBookTransportCode = 
/** An entry decoded. Says nothing about whether it is fresh or priceable. */
'entry-decoded'
/**
 * No key. Cold start, an unsubscribed market, an unwired subscriber, or a TTL
 * expiry after the writer died. **Never zero depth**: nothing was observed.
 */
 | 'key-missing'
/**
 * A value exists and is not decodable JSON, or is not an object. A
 * serialisation bug on the writer, or a foreign value at our key.
 */
 | 'value-malformed'
/**
 * A value decoded but carries a different `POLYMARKET_BOOK_WIRE_VERSION`.
 * Version skew between two deployed services -- not a market condition, and
 * distinct from `value-malformed` so a rolling deploy is diagnosable.
 */
 | 'version-skew'
/**
 * The payload's own fields are wrong: an unknown `status`, a `book` with no
 * `ladders`, an `awaiting-snapshot` carrying one, a non-finite `observedAt`, a
 * level that is not `{price, size}` numbers. **Refused, never defaulted** -- a
 * defaulted ladder is a fabricated ladder, and an `awaiting-snapshot` that
 * decodes into an empty `book` is a gap reading as a thin book.
 */
 | 'entry-invalid'
/**
 * Decoded, and older than the freshness budget on our clock. Reported for
 * observability only: the entry is still handed to `assessPolymarketBookDepth`,
 * which owns the budget and answers `book-snapshot-stale` **with the age**. An
 * absent key would be strictly less informative and would name the wrong cause.
 */
 | 'entry-stale';
/** What `polymarketBookEntryFreshness` concluded. Never a number, never a pass. */
export type PolymarketBookFreshness = 'fresh' | 'stale'
/** An `awaiting-snapshot` entry has no ladder, so freshness is not a question. */
 | 'awaiting-snapshot'
/** `observedAt` is not a finite number, so no age can be computed at all. */
 | 'age-unknown';
/**
 * The wire payload, as a discriminated union mirroring `PolymarketBookEntry`.
 *
 * `ladders` appears **only** on the `book` arm and `since` **only** on the
 * `awaiting-snapshot` arm, so the variant distinction is structural on the wire
 * exactly as it is in memory. Optional metadata is written only when present:
 * `undefined` and `null` are different facts on `venueTimestamp` (the venue
 * documents the field as nullable), so the codec preserves an explicit `null` and
 * omits an absent field.
 */
export type PolymarketBookWirePayload = {
    readonly v: number;
    readonly status: 'book';
    readonly tokenId: string;
    readonly observedAt: number;
    readonly ladders: {
        readonly bids: readonly {
            readonly price: number;
            readonly size: number;
        }[];
        readonly asks: readonly {
            readonly price: number;
            readonly size: number;
        }[];
    };
    readonly venueTimestamp?: number | null;
    readonly tickSize?: number | null;
    readonly minOrderSize?: number | null;
} | {
    readonly v: number;
    readonly status: 'awaiting-snapshot';
    readonly tokenId: string;
    readonly since: number;
    readonly bestBid?: number | null;
    readonly bestAsk?: number | null;
};
/**
 * Encode one entry to its wire payload.
 *
 * Separate from `serializePolymarketBookEntry` so a test can assert the *shape*
 * -- specifically that an `awaiting-snapshot` payload has no `ladders` key at all
 * -- without going through JSON.
 */
export declare function encodePolymarketBookEntry(entry: PolymarketBookEntry): PolymarketBookWirePayload;
/** JSON, over the discriminated payload. No `Date`, no `bigint`, so no custom codec. */
export declare function serializePolymarketBookEntry(entry: PolymarketBookEntry): string;
/** A decode either produced an entry, or produced a reason it could not. */
export type PolymarketBookDecodeResult = {
    readonly ok: true;
    readonly entry: PolymarketBookEntry;
} | {
    readonly ok: false;
    readonly code: Extract<PolymarketBookTransportCode, 'value-malformed' | 'version-skew' | 'entry-invalid'>;
    readonly detail: string;
};
/**
 * Decode one stored string back to an entry, or say precisely why not.
 *
 * The three refusal codes are kept apart because they are three different jobs:
 * fix the JSON writer, finish the deploy, or fix the entry producer. Nothing is
 * defaulted anywhere in here -- see the `entry-invalid` docs.
 */
export declare function deserializePolymarketBookEntry(raw: string): PolymarketBookDecodeResult;
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
export declare function polymarketBookEntryFreshness(input: {
    readonly entry: PolymarketBookEntry;
    readonly now: number;
    readonly maxAgeMs?: number;
}): PolymarketBookFreshness;
export interface PolymarketBookPublisherOptions {
    readonly transport: PolymarketBookKeyValueTransport;
    /** Defaults to `POLYMARKET_BOOK_ENTRY_TTL_MS`. Checked against the budget. */
    readonly ttlMs?: number;
    /** The reader's budget, for the TTL assertion. */
    readonly maxAgeMs?: number;
    /**
     * Called when a publish rejects or the transport throws. A write failure must
     * not propagate into the subscriber's `onEntry` -- a Redis blip would otherwise
     * take the socket handler down and stop the local cache updating too. Failing
     * to publish degrades the reader to `key-missing`, which fails closed.
     */
    readonly onFailure?: (failure: PolymarketBookPublishResult) => void;
}
export type PolymarketBookPublishResult = {
    readonly ok: true;
    readonly key: string;
    readonly code: 'entry-published';
} | {
    readonly ok: false;
    readonly key: string | null;
    readonly code: 'publish-refused' | 'transport-failed';
    readonly detail: string;
};
export interface PolymarketBookPublisher {
    /**
     * Publish one entry. Never throws -- see `onFailure`. Shaped to be handed
     * straight to the subscriber's `onEntry` hook via a void wrapper.
     */
    readonly publish: (entry: PolymarketBookEntry) => Promise<PolymarketBookPublishResult>;
    /** The TTL in force, so a service can log what it actually configured. */
    readonly ttlMs: number;
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
export declare function createPolymarketBookPublisher(options: PolymarketBookPublisherOptions): PolymarketBookPublisher;
/** What one requested token yielded, keyed by bare token id. */
export interface PolymarketBookSnapshotEntryStatus {
    readonly tokenId: string;
    readonly key: string;
    readonly code: PolymarketBookTransportCode;
    /** Populated only when `code === 'entry-decoded'` or `'entry-stale'`. */
    readonly entry: PolymarketBookEntry | null;
    readonly freshness: PolymarketBookFreshness | null;
    /** Ops-facing. Carries figures, so never rendered to a user. */
    readonly detail: string;
}
/**
 * A point-in-time read of the transport, exposing a **synchronous**
 * `PolymarketBookCache`.
 *
 * `cache` is exactly the port `assessPolymarketBookDepth` takes, so the consumer
 * is unchanged. `statuses` carries the per-token transport codes the port cannot
 * express, and `readAt` is stamped so a caller can prove it did not hold the
 * snapshot across decisions.
 */
export interface PolymarketBookSnapshot {
    readonly cache: PolymarketBookCache;
    readonly readAt: number;
    readonly statuses: readonly PolymarketBookSnapshotEntryStatus[];
    /** Convenience lookup for one token's transport code. */
    readonly statusFor: (tokenMint: string) => PolymarketBookSnapshotEntryStatus | undefined;
    /** Counts per code, for the ingestion-health surface. */
    readonly counts: Readonly<Record<PolymarketBookTransportCode, number>>;
}
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
export declare function buildPolymarketBookSnapshot(input: {
    readonly slots: readonly {
        readonly tokenId: string;
        readonly key: string;
        readonly value: string | null;
    }[];
    readonly readAt: number;
    readonly maxAgeMs?: number;
}): PolymarketBookSnapshot;
export interface PolymarketBookReaderOptions {
    readonly transport: PolymarketBookKeyValueTransport;
    /** Injected clock. The snapshot stamps `readAt`; nothing here calls `Date.now`. */
    readonly now: () => number;
    /** Freshness budget used for the observability counts only. */
    readonly maxAgeMs?: number;
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
export declare function loadPolymarketBookSnapshot(options: PolymarketBookReaderOptions, tokenMints: readonly string[], onTransportFailure?: (detail: string) => void): Promise<PolymarketBookSnapshot>;
/**
 * Single-token convenience: one `get`, one snapshot.
 *
 * Exists because the wired call site in `signal-engine` assesses **one** token per
 * fan-out. `loadPolymarketBookSnapshot` remains the batch form for a caller that
 * has several.
 */
export declare function loadPolymarketBookEntry(options: PolymarketBookReaderOptions, tokenMint: string, onTransportFailure?: (detail: string) => void): Promise<PolymarketBookSnapshot>;
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
export declare function polymarketBookRedisTransport(client: {
    readonly get: (key: string) => Promise<string | null>;
    readonly set: (key: string, value: string, mode: 'PX', ttlMs: number) => Promise<unknown>;
    readonly mget: (...keys: string[]) => Promise<(string | null)[]>;
}): PolymarketBookKeyValueTransport;
//# sourceMappingURL=polymarket-book-transport.d.ts.map