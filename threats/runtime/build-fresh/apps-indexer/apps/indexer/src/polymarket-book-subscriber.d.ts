import { type PolymarketBookCache, type PolymarketBookEntry, type PolymarketBookLevel } from '@swat/shared';
/**
 * Polymarket market-channel subscriber -- the thing that fills the `S4-M38`
 * order-book depth cache that `packages/shared/src/polymarket-book-depth.ts`
 * reads.
 *
 * ── Division of labour ────────────────────────────────────────────────────
 *
 * `polymarket-book-depth.ts` is the *reader*: it prices a ladder, or returns an
 * honest unknown. It is pure, it owns the freshness budget, and it is settled.
 * This module is the *writer*: it maintains one local book per outcome token and
 * produces exactly the `PolymarketBookEntry` shape that module consumes. Nothing
 * here re-implements or second-guesses the depth maths.
 *
 * ── What the venue actually provides (confirmed in the live docs via MCP) ──
 *
 *   * `wss://ws-subscriptions-clob.polymarket.com/ws/market`
 *     (`/getting-started/api` line 44, `/market-data/realtime-data` line 741).
 *   * Subscribe frame `{"assets_ids": ["<token_id>"], "type": "market"}`, and
 *     `custom_feature_enabled: true` additionally enables `best_bid_ask`,
 *     `new_market` and `market_resolved`
 *     (`/market-data/realtime-data`, *Market Stream* -> API tab).
 *   * Application-level heartbeat: send the **text frame `PING` every 10 s**, the
 *     server replies `PONG`. Documented as a keepalive, so it proves the
 *     *connection* and says nothing about any individual book.
 *   * Tokens may be added or removed on a live connection with
 *     `{"assets_ids": [...], "operation": "subscribe" | "unsubscribe"}`; the docs
 *     state these "update only the token set for the current market-stream
 *     connection", which is why the tracked set is re-sent on every reconnect.
 *   * `book` frame: `event_type: "book"`, `market`, `asset_id`, `timestamp`
 *     (epoch-ms **string**), `hash`, `bids[]`, `asks[]` of `{price, size}`
 *     decimal strings. The SDK-shaped variant of the same event adds
 *     `minOrderSize`, `tickSize`, `negRisk`, `lastTradePrice`, all nullable.
 *   * `price_change` frame: `event_type: "price_change"`, `market`, `timestamp`,
 *     and `price_changes[]` of `{asset_id, price, size, side: "BUY" | "SELL",
 *     hash, best_bid, best_ask}`. One frame can carry changes for several tokens.
 *   * `tick_size_change`, `last_trade_price`, `best_bid_ask`, `new_market`,
 *     `market_resolved` are the other documented event types.
 *   * Batch resync: `POST https://clob.polymarket.com/books`, body
 *     `[{"token_id": "..."}]`, **max 500 items per request**
 *     (`/market-data/prices-order-books`, *Fetch Multiple Order Books*), rate
 *     limited **500 req / 10 s** (`/api-reference/rate-limits`). Each row carries
 *     `market`, `asset_id`, `timestamp`, `hash`, `bids`, `asks`, `min_order_size`,
 *     `tick_size`, `neg_risk`, `last_trade_price`.
 *
 * ── What the docs do NOT say, and how each gap is handled ──────────────────
 *
 * These are the load-bearing unknowns. Every one of them is resolved in the
 * fail-closed direction, because the consumer of this cache prices a cohort
 * against it and a silently-wrong book is worse than an absent one.
 *
 *   1. **There is no sequence number on the market channel.** Searched the whole
 *      docs filesystem: `sequence` appears only on the *perps* `GET /v1/info/book`
 *      response, a different product on a different host. So classic
 *      sequence-gap detection is **not available**, and this module does not
 *      pretend otherwise. What it uses instead is the frame `timestamp`, which is
 *      documented on both `book` and `price_change`: a delta stamped **older**
 *      than the last state we applied for that token cannot be applied in order,
 *      so it forces a resync rather than a patch.
 *   2. **`hash` is not documented as a chain.** For the REST book the docs say
 *      only "compare it with the previous response's hash to determine whether
 *      the book changed between reads" -- a state fingerprint, not a predecessor
 *      link. The `price_change` hash is a different shape again (40 hex chars in
 *      the example, against 64 for the book). Nothing here treats hash equality
 *      or inequality as evidence about ordering; it is carried for observability
 *      only.
 *   3. **`price_change.size` semantics are NOT stated anywhere.** The repo (and
 *      the depth model's own comment) reads it as *the new resting size at that
 *      price, with `"0"` meaning the level is gone* -- level replacement, not an
 *      increment. That reading is **assumed, not confirmed**, and it is the single
 *      biggest latent bug in this file. Two things bound the damage:
 *        * `observedAt` is **never advanced by a delta** (see `applyDelta`), so a
 *          delta cannot extend a book's life. Every book ages out on its
 *          *snapshot's* clock and is overwritten wholesale by the next resync.
 *        * `deltaPolicy: 'never'` turns every delta into a resync trigger, which
 *          is the operator's escape hatch if the reading turns out to be wrong.
 *   4. **Bid/ask array order is contradictory between two doc pages.**
 *      `/market-data/prices-order-books` -> *Order Book* says "bids are ordered by
 *      ascending price and asks by descending price, so the best bid and ask are
 *      the last entries", while the `POST /books` schema on
 *      `/api-reference/market-data/get-order-books-request-body` says bids are
 *      "sorted by price descending" and asks "sorted by price ascending". They
 *      cannot both be right. Nothing here depends on either: levels are stored in
 *      a price-keyed map and the depth model sorts both ladders itself before use.
 *   5. **No WebSocket limits are documented** -- no max connections, no max
 *      subscriptions, no message-rate cap. The rate-limits page is HTTP-only.
 *      Batch sizing for the subscribe frame is therefore an operator dial with a
 *      conservative default, not a derived number.
 *
 * ── The state machine, which is the whole point ────────────────────────────
 *
 * Two message kinds move depth, and the transitions are the classic order-book
 * trap made structural:
 *
 *   * **snapshot** (`book`, or a `POST /books` row) -> replaces the ladder
 *     wholesale, sets `status: 'book'` and `observedAt: now`.
 *   * **delta** (`price_change`) -> applied **only** to a book that already holds
 *     a snapshot. A delta arriving against `awaiting-snapshot`, or against a
 *     token with no entry at all, is **discarded and the book stays unknown**. It
 *     is never applied to an empty ladder, because an empty ladder plus a
 *     deletion reads as a valid thin book -- a number -- rather than as a gap.
 *
 * Everything else (`tick_size_change`, `best_bid_ask`, `last_trade_price`,
 * `new_market`) either touches metadata only or is ignored, and an unrecognised
 * `event_type` is ignored rather than guessed at. `market_resolved` invalidates
 * the affected books: a resolved market's ladder cannot be traded.
 *
 * ── Three ways depth goes unknown, each with its own code ──────────────────
 *
 *   * **Cold start** -- no entry exists. The reader answers `book-not-cached`.
 *     Operator action: subscribe the market.
 *   * **Disconnect** -- an `awaiting-snapshot` entry with `since = disconnect
 *     time`. The reader answers `book-awaiting-snapshot`. The pre-disconnect
 *     ladder is *structurally* unreachable, because that variant of
 *     `PolymarketBookEntry` has no ladder field at all.
 *   * **Out-of-order or unorderable delta** -- same `awaiting-snapshot` entry,
 *     but this module's own `PolymarketBookApplyCode` records which of the four
 *     resync causes it was, so "the feed skipped" and "we just reconnected" are
 *     never the same line in a log.
 *
 * A stale-but-connected book needs no action here at all: the reader compares
 * `observedAt` against its own budget and answers `book-snapshot-stale`.
 *
 * ── Resync cadence is tied to the reader's budget, not chosen separately ───
 *
 * The reader's budget is two resync periods
 * (`POLYMARKET_BOOK_MAX_AGE_MS` = 30 s = 2 x `POLYMARKET_BOOK_RESYNC_INTERVAL_MS`
 * = 15 s), so exactly one missed resync is tolerated. Both constants are imported
 * from the reader rather than restated, and
 * `assertPolymarketBookResyncBudget` throws if a caller sets an interval that
 * cannot keep the cache inside the budget. Independent numbers on the two sides
 * is the drift this check exists to prevent.
 *
 * ── Pure core, thin shell ─────────────────────────────────────────────────
 *
 * `applyPolymarketBookMessage` is a pure function: (state, message, now) -> new
 * state + a stable code. It reads no clock, no environment and no socket. The
 * shell (`createPolymarketBookSubscriber`) owns the token set, the transport and
 * the frames, and **owns no timers** -- `sendHeartbeat()` and `runDueResyncs()`
 * are methods the service's `setInterval` calls, exactly like
 * `pollPolymarketResolutions` in `index.ts`. No WebSocket library is imported
 * here; the transport is injected, the same way `solana-signer.ts`, the
 * `EvmNonceLock` port and `fetchImpl` in `polymarket.ts` are.
 */
/** Market channel endpoint. Documented at `/getting-started/api` line 44. */
export declare const POLYMARKET_MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
/** Batch resync endpoint. Documented at `/market-data/prices-order-books`. */
export declare const POLYMARKET_BOOKS_REST_URL = "https://clob.polymarket.com/books";
/**
 * Heartbeat cadence. The docs are explicit: "Send the text frame `PING` every 10
 * seconds; the server replies with `PONG`."
 */
export declare const POLYMARKET_MARKET_WS_HEARTBEAT_MS = 10000;
/**
 * Hard maximum items per `POST /books` request -- "Maximum 500 items per
 * request", stated on `/market-data/prices-order-books`.
 */
export declare const POLYMARKET_BOOKS_MAX_BATCH = 500;
/**
 * Tokens per subscribe frame.
 *
 * **Not a documented limit.** No WebSocket limit of any kind appears in the docs,
 * so this is a deliberately conservative default rather than a derived figure,
 * and it is overridable. The checklist's own instruction stands: the real ceiling
 * has to be established empirically by subscribing in increasing batches and
 * watching for *silent drops* as well as errors.
 */
export declare const POLYMARKET_MARKET_WS_DEFAULT_SUBSCRIBE_BATCH = 100;
/**
 * A caller-side mistake: a resync interval that cannot keep the cache inside the
 * reader's budget, a non-positive batch size, an empty token id. Throws rather
 * than returning a code, for the same reason `polymarket-staleness.ts` throws on
 * a bad policy -- a misconfigured cadence would otherwise disable Polymarket
 * depth silently for every trade.
 */
export declare class PolymarketBookSubscriberConfigError extends Error {
    constructor(message: string);
}
/** A parsed `book` frame, or one row of a `POST /books` response. */
export interface PolymarketBookSnapshotMessage {
    readonly kind: 'snapshot';
    readonly tokenId: string;
    readonly bids: readonly PolymarketBookLevel[];
    readonly asks: readonly PolymarketBookLevel[];
    /** Epoch ms, or `null`. Documented nullable, so never required. */
    readonly venueTimestamp: number | null;
    /** Carried for observability only -- never used as an ordering signal. */
    readonly hash: string | null;
    readonly tickSize: number | null;
    readonly minOrderSize: number | null;
}
/** One level replacement out of a `price_change` frame. */
export interface PolymarketBookDeltaLevel {
    readonly tokenId: string;
    readonly price: number;
    /** The new resting size at `price`. `0` removes the level. **Assumed** -- see header. */
    readonly size: number;
    readonly side: 'BUY' | 'SELL';
    readonly bestBid: number | null;
    readonly bestAsk: number | null;
}
/** A parsed `price_change` frame. One frame may carry several tokens. */
export interface PolymarketBookDeltaMessage {
    readonly kind: 'delta';
    readonly changes: readonly PolymarketBookDeltaLevel[];
    readonly venueTimestamp: number | null;
}
/** A parsed `tick_size_change` frame. Metadata only; depth is untouched. */
export interface PolymarketBookTickSizeMessage {
    readonly kind: 'tick-size';
    readonly tokenId: string;
    readonly newTickSize: number;
    readonly venueTimestamp: number | null;
}
/** A parsed `market_resolved` frame. Invalidates every listed token's book. */
export interface PolymarketBookResolvedMessage {
    readonly kind: 'resolved';
    readonly tokenIds: readonly string[];
    readonly winningTokenId: string | null;
    readonly venueTimestamp: number | null;
}
/**
 * A frame we recognise as a documented event type that does not move depth
 * (`best_bid_ask`, `last_trade_price`, `new_market`), or one we do not recognise
 * at all. Both are inert by construction: there is no book field to touch.
 */
export interface PolymarketBookInertMessage {
    readonly kind: 'inert';
    /** The raw `event_type` / `type`, or `null` when the frame carried none. */
    readonly eventType: string | null;
    readonly recognised: boolean;
}
/** A frame that could not be parsed into any of the above. */
export interface PolymarketBookMalformedMessage {
    readonly kind: 'malformed';
    readonly detail: string;
}
export type PolymarketBookMessage = PolymarketBookSnapshotMessage | PolymarketBookDeltaMessage | PolymarketBookTickSizeMessage | PolymarketBookResolvedMessage | PolymarketBookInertMessage | PolymarketBookMalformedMessage;
/**
 * Parse one market-channel frame.
 *
 * Accepts both documented dialects: the raw WebSocket JSON (`event_type` at the
 * top level, snake_case fields) and the SDK-shaped event (`type` plus a
 * `payload` object, camelCase fields). Anything unrecognised comes back as
 * `inert` with `recognised: false`, so an event type the venue adds later can
 * never touch a book.
 */
export declare function parsePolymarketMarketMessage(raw: unknown): PolymarketBookMessage;
/**
 * How a delta whose ordering cannot be proved is treated.
 *
 * A delta stamped strictly *older* than the state it would patch is refused
 * under every policy -- that is not a knob. What this chooses is the treatment of
 * the two cases the docs leave open:
 *
 *   * `'apply-ordered'` (default) -- apply a delta only when its timestamp is at
 *     or after the applied state's. A delta with **no** timestamp is unorderable,
 *     so it forces a resync. Conservative, and the cost is bounded: the book is
 *     unknown for at most one resync period.
 *   * `'apply-always'` -- apply an unorderable (timestamp-free) delta anyway.
 *     For the case where the venue turns out to omit `timestamp` routinely and
 *     the strict policy would keep every book permanently unknown.
 *   * `'never'` -- any delta forces a resync; only snapshots ever build a ladder.
 *     The escape hatch for gap 3 in the header: if the level-replacement reading
 *     of `price_change.size` is wrong, this mode makes it harmless at the cost of
 *     depth being at most one resync period fresh.
 */
export type PolymarketBookDeltaPolicy = 'apply-ordered' | 'apply-always' | 'never';
export declare const POLYMARKET_BOOK_DEFAULT_DELTA_POLICY: PolymarketBookDeltaPolicy;
/**
 * The subscriber's whole state. Immutable: every transition returns a new value,
 * which is what makes the state machine testable without a socket, a clock or a
 * running service.
 */
export interface PolymarketBookSubscriberState {
    /** Tokens we intend to hold books for. Keyed by bare CLOB `asset_id`. */
    readonly tracked: ReadonlySet<string>;
    /** Bare token id -> entry, in exactly the shape the depth reader consumes. */
    readonly books: ReadonlyMap<string, PolymarketBookEntry>;
    /**
     * Last venue timestamp we accepted for each token, snapshot or delta. The only
     * ordering signal this channel offers -- there is no sequence number.
     */
    readonly lastVenueTimestamp: ReadonlyMap<string, number>;
    /** Last snapshot `hash`, for observability. Never an ordering signal. */
    readonly lastHash: ReadonlyMap<string, string | null>;
    /** Whether the transport is currently believed to be up. */
    readonly connected: boolean;
}
export declare function createPolymarketBookSubscriberState(tracked?: Iterable<string>): PolymarketBookSubscriberState;
/**
 * Stable string codes for what one message did.
 *
 * Split the way `solana-simulation.ts` splits `refuse` from `unavailable`: an
 * `applied-*` code means depth moved, a `resync-*` code means depth is now
 * unknown **and why**, an `ignored-*` code means nothing happened by design, and
 * a `refused-*` code means the frame itself was unusable. Telemetry keys on
 * these, so they are appended to rather than renamed.
 */
export type PolymarketBookApplyCode = 
/** A snapshot replaced the ladder. `observedAt` advanced. */
'applied-snapshot'
/** A delta patched an existing ladder. `observedAt` deliberately unchanged. */
 | 'applied-delta'
/** Tick size recorded on an existing book. Depth untouched. */
 | 'applied-tick-size'
/**
 * A delta arrived for a token with no snapshot -- no entry at all, or an
 * `awaiting-snapshot` entry. Discarded. This is the classic order-book bug the
 * type system also prevents: an empty ladder plus a deletion is a thin book,
 * which reads as a number rather than as a gap.
 */
 | 'resync-delta-before-snapshot'
/** A delta stamped older than the state it would patch. Never patched. */
 | 'resync-delta-out-of-order'
/** A delta with no readable timestamp, under `'apply-ordered'`. */
 | 'resync-delta-unorderable'
/** A delta under `deltaPolicy: 'never'`. */
 | 'resync-delta-policy'
/** The market resolved; a resolved ladder is not tradeable depth. */
 | 'resync-market-resolved'
/** The transport dropped. Every tracked book is unknown until re-snapshotted. */
 | 'resync-transport-disconnected'
/** A frame for a token we do not track. Never creates an entry. */
 | 'ignored-untracked-token'
/** A documented event type that does not move depth. */
 | 'ignored-non-depth-event'
/** An event type not in the docs. Ignored rather than guessed at. */
 | 'ignored-unknown-event'
/** Unparseable frame. Prior state is left intact rather than overwritten. */
 | 'refused-malformed-frame'
/** Tick size for a token whose book is not currently snapshotted. */
 | 'ignored-tick-size-without-book';
export interface PolymarketBookApplyResult {
    readonly state: PolymarketBookSubscriberState;
    /** One code per token the frame touched, or one code for the frame. */
    readonly codes: readonly PolymarketBookApplyCode[];
    /** Tokens whose depth this frame made unknown. Drives the resync queue. */
    readonly invalidated: readonly string[];
    /**
     * Every token whose entry this frame changed, invalidations included. The
     * write-through hook publishes exactly these, so a Redis writer sees one write
     * per transition rather than the whole cache on every frame.
     */
    readonly touched: readonly string[];
    /** Ops-facing detail. Carries figures, so it is never rendered to a user. */
    readonly detail: string;
}
/**
 * Mark every tracked token's depth unknown -- the reconnect transition.
 *
 * **Nothing is carried across the gap.** `price_change` is incremental, so a
 * pre-disconnect ladder plus post-reconnect deltas is a book that looks fine and
 * is wrong, which is the failure that bites hardest because it presents as a
 * working system with slightly wrong numbers.
 */
export declare function invalidateAllPolymarketBooks(state: PolymarketBookSubscriberState, now: number): PolymarketBookApplyResult;
/**
 * The state machine. Pure: no clock, no socket, no environment.
 *
 * `now` is the caller's clock and becomes `observedAt` on a snapshot, which is
 * the figure the depth reader measures its budget against.
 */
export declare function applyPolymarketBookMessage(state: PolymarketBookSubscriberState, input: {
    readonly raw: unknown;
    readonly now: number;
    readonly deltaPolicy?: PolymarketBookDeltaPolicy;
}): PolymarketBookApplyResult;
/**
 * Assert the resync cadence can keep the cache inside the reader's budget.
 *
 * The reader's `POLYMARKET_BOOK_MAX_AGE_MS` is documented as **two resync
 * periods**, so the two numbers are one decision, not two. An interval above
 * half the budget cannot keep a book fresh even when nothing goes wrong, and the
 * symptom would be every polygon cohort flapping to `capacity-unknown` with no
 * error anywhere -- so this throws rather than warning.
 */
export declare function assertPolymarketBookResyncBudget(input: {
    readonly resyncIntervalMs: number;
    readonly maxAgeMs: number;
}): void;
/**
 * Which tracked tokens need a `POST /books` resync now.
 *
 * A token is due when it has no entry, is awaiting a snapshot, or its snapshot is
 * at least one resync period old. Pure, so the schedule is testable without a
 * timer: the shell just calls this with `Date.now()`.
 */
export declare function polymarketBooksDueForResync(state: PolymarketBookSubscriberState, input: {
    readonly now: number;
    readonly resyncIntervalMs?: number;
}): readonly string[];
/** Chunk a token list to the venue's documented `POST /books` maximum. */
export declare function chunkPolymarketBookBatch(tokenIds: readonly string[], batchSize?: number): readonly (readonly string[])[];
/**
 * What the subscriber needs from a socket, and nothing more.
 *
 * **No WebSocket library is imported in this module.** The transport is a port,
 * the same shape `solana-signer.ts`, the `EvmNonceLock` port and `fetchImpl` in
 * `polymarket.ts` already use. That is what lets the whole state machine and the
 * whole frame protocol be tested with a fake and zero network -- and it is the
 * reason no real socket has ever been opened by this code.
 */
export interface PolymarketBookTransport {
    /** Send one text frame. `PING` and the subscribe frames both go through here. */
    readonly send: (frame: string) => void;
    readonly close: () => void;
}
/** Callbacks the transport drives. The shell supplies them; the transport calls them. */
export interface PolymarketBookTransportHandlers {
    readonly onOpen: () => void;
    /** One text frame in. `PONG` and JSON events both arrive here. */
    readonly onMessage: (frame: string) => void;
    readonly onClose: (reason: string) => void;
    readonly onError: (error: unknown) => void;
}
export type PolymarketBookTransportFactory = (handlers: PolymarketBookTransportHandlers) => PolymarketBookTransport;
/** Injected batch resync. Returns raw `POST /books` rows; parsing is shared. */
export type PolymarketBookResyncFetcher = (tokenIds: readonly string[]) => Promise<readonly unknown[]>;
export interface PolymarketBookSubscriberOptions {
    readonly transportFactory: PolymarketBookTransportFactory;
    /**
     * Batch resync. Required, not optional: the stream alone cannot keep a quiet
     * market fresh, so a subscriber without a resync path would publish books that
     * age out and never come back.
     */
    readonly fetchBooks: PolymarketBookResyncFetcher;
    /** Injected clock. This module never calls `Date.now()` in logic. */
    readonly now: () => number;
    readonly tokenIds?: readonly string[];
    readonly deltaPolicy?: PolymarketBookDeltaPolicy;
    readonly resyncIntervalMs?: number;
    /** The reader's budget, for the two-period assertion. */
    readonly maxAgeMs?: number;
    readonly subscribeBatchSize?: number;
    readonly customFeatureEnabled?: boolean;
    /**
     * Called for every state change, so a Redis writer can be added without
     * touching this module. `ioredis` is deliberately not imported here.
     */
    readonly onEntry?: (entry: PolymarketBookEntry) => void;
    readonly logger?: {
        readonly info: (message: string) => void;
        readonly warn: (message: string, error?: unknown) => void;
    };
}
export interface PolymarketBookSubscriber {
    /** Read side, in exactly the port shape `assessPolymarketBookDepth` takes. */
    readonly cache: PolymarketBookCache;
    readonly state: () => PolymarketBookSubscriberState;
    /** Open the transport and send the subscribe frames. */
    readonly start: () => void;
    readonly stop: () => void;
    /** Add tokens on the live connection, per the documented `operation` frame. */
    readonly subscribe: (tokenIds: readonly string[]) => void;
    readonly unsubscribe: (tokenIds: readonly string[]) => void;
    /** The documented `PING` keepalive. The service's interval calls this. */
    readonly sendHeartbeat: () => void;
    /** `POST /books` for every token past its cadence. The service's interval calls this. */
    readonly runDueResyncs: () => Promise<readonly PolymarketBookApplyCode[]>;
    /** Counters, for the ingestion-health surface. */
    readonly stats: () => Readonly<Record<PolymarketBookApplyCode, number>>;
}
/**
 * Build the documented subscribe frame.
 *
 * `{"assets_ids": [...], "type": "market"}` for the initial subscription;
 * `{"assets_ids": [...], "operation": "subscribe" | "unsubscribe"}` to change the
 * token set on a live connection. Exported so a test can assert the exact bytes
 * without a socket.
 */
export declare function polymarketMarketSubscribeFrame(input: {
    readonly tokenIds: readonly string[];
    readonly operation?: 'subscribe' | 'unsubscribe';
    readonly customFeatureEnabled?: boolean;
}): string;
/**
 * The thin I/O shell.
 *
 * It owns the token set, the transport and the frames. It owns **no timers**:
 * `sendHeartbeat()` and `runDueResyncs()` are called by the service's
 * `setInterval`, the way `pollPolymarketResolutions` already is in `index.ts`.
 * Anything decided inside a socket callback would be untestable without a
 * network, so the callbacks do exactly two things: hand the frame to the pure
 * state machine, and record the result.
 */
export declare function createPolymarketBookSubscriber(options: PolymarketBookSubscriberOptions): PolymarketBookSubscriber;
//# sourceMappingURL=polymarket-book-subscriber.d.ts.map