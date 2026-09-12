import {
  POLYMARKET_BOOK_MAX_AGE_MS,
  POLYMARKET_BOOK_RESYNC_INTERVAL_MS,
  type PolymarketBookCache,
  type PolymarketBookEntry,
  type PolymarketBookLevel
} from '@swat/shared';

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

// ═══════════════════════════════════════════════════════════════════════════
// Venue constants
// ═══════════════════════════════════════════════════════════════════════════

/** Market channel endpoint. Documented at `/getting-started/api` line 44. */
export const POLYMARKET_MARKET_WS_URL =
  'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/** Batch resync endpoint. Documented at `/market-data/prices-order-books`. */
export const POLYMARKET_BOOKS_REST_URL = 'https://clob.polymarket.com/books';

/**
 * Heartbeat cadence. The docs are explicit: "Send the text frame `PING` every 10
 * seconds; the server replies with `PONG`."
 */
export const POLYMARKET_MARKET_WS_HEARTBEAT_MS = 10_000;

/**
 * Hard maximum items per `POST /books` request -- "Maximum 500 items per
 * request", stated on `/market-data/prices-order-books`.
 */
export const POLYMARKET_BOOKS_MAX_BATCH = 500;

/**
 * Tokens per subscribe frame.
 *
 * **Not a documented limit.** No WebSocket limit of any kind appears in the docs,
 * so this is a deliberately conservative default rather than a derived figure,
 * and it is overridable. The checklist's own instruction stands: the real ceiling
 * has to be established empirically by subscribing in increasing batches and
 * watching for *silent drops* as well as errors.
 */
export const POLYMARKET_MARKET_WS_DEFAULT_SUBSCRIBE_BATCH = 100;

// ═══════════════════════════════════════════════════════════════════════════
// Errors
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A caller-side mistake: a resync interval that cannot keep the cache inside the
 * reader's budget, a non-positive batch size, an empty token id. Throws rather
 * than returning a code, for the same reason `polymarket-staleness.ts` throws on
 * a bad policy -- a misconfigured cadence would otherwise disable Polymarket
 * depth silently for every trade.
 */
export class PolymarketBookSubscriberConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolymarketBookSubscriberConfigError';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Parsed messages
// ═══════════════════════════════════════════════════════════════════════════

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

export type PolymarketBookMessage =
  | PolymarketBookSnapshotMessage
  | PolymarketBookDeltaMessage
  | PolymarketBookTickSizeMessage
  | PolymarketBookResolvedMessage
  | PolymarketBookInertMessage
  | PolymarketBookMalformedMessage;

// ═══════════════════════════════════════════════════════════════════════════
// Parsing
// ═══════════════════════════════════════════════════════════════════════════

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decimal strings are the wire format for every price and size on this channel
 * (`DecimalString` in the SDK types, quoted numbers in the raw JSON), so a bare
 * `Number()` on an absent field would silently produce `0` -- a real price and a
 * real size. `null` is returned instead and the caller decides.
 */
function decimal(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The frame `timestamp` is documented as an epoch-ms **string** on the raw
 * channel and as an ISO instant in the SDK/Python shapes, and it is nullable on
 * every event that carries it. Both are accepted; anything else is `null`.
 */
function venueTimestamp(value: unknown): number | null {
  const numeric = decimal(value);
  if (numeric !== null) return numeric;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function tokenId(source: Record<string, unknown>): string | null {
  // Both dialects are accepted: the raw channel sends `asset_id`, the SDK-shaped
  // event sends `tokenId` / `token_id`. Picking one and being wrong would drop
  // every frame, so all three are read.
  const candidate = source.asset_id ?? source.tokenId ?? source.token_id;
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function levels(value: unknown): readonly PolymarketBookLevel[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: PolymarketBookLevel[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const price = decimal(raw.price);
    const size = decimal(raw.size);
    if (price === null || size === null) return null;
    // A zero-size level in a snapshot is a deletion the venue has not garbage
    // collected. Dropped here so a stored ladder never carries one; the depth
    // model drops them again on read, which is a second line of defence rather
    // than a duplicate.
    if (size === 0) continue;
    parsed.push({ price, size });
  }
  return parsed;
}

function side(value: unknown): 'BUY' | 'SELL' | null {
  if (value === 'BUY' || value === 'SELL') return value;
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return upper === 'BUY' || upper === 'SELL' ? upper : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function tokenIdList(source: Record<string, unknown>): readonly string[] {
  const candidate = source.assets_ids ?? source.tokenIds ?? source.token_ids;
  if (!Array.isArray(candidate)) return [];
  const ids: string[] = [];
  for (const raw of candidate) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) ids.push(trimmed);
  }
  return ids;
}

/**
 * Parse one market-channel frame.
 *
 * Accepts both documented dialects: the raw WebSocket JSON (`event_type` at the
 * top level, snake_case fields) and the SDK-shaped event (`type` plus a
 * `payload` object, camelCase fields). Anything unrecognised comes back as
 * `inert` with `recognised: false`, so an event type the venue adds later can
 * never touch a book.
 */
export function parsePolymarketMarketMessage(raw: unknown): PolymarketBookMessage {
  let source: unknown = raw;
  if (typeof raw === 'string') {
    try {
      source = JSON.parse(raw) as unknown;
    } catch {
      return { kind: 'malformed', detail: 'frame is not JSON' };
    }
  }
  if (!isRecord(source)) return { kind: 'malformed', detail: 'frame is not a JSON object' };

  const eventType = stringOrNull(source.event_type) ?? stringOrNull(source.type);
  // The SDK dialect nests everything under `payload`; the raw dialect is flat.
  const body = isRecord(source.payload) ? source.payload : source;
  const frameTimestamp = venueTimestamp(body.timestamp ?? source.timestamp);

  if (eventType === 'book') {
    const id = tokenId(body);
    if (id === null) return { kind: 'malformed', detail: 'book frame has no asset id' };
    const bids = levels(body.bids);
    const asks = levels(body.asks);
    if (bids === null || asks === null) {
      return { kind: 'malformed', detail: `book frame for ${id} has an unreadable level` };
    }
    return {
      kind: 'snapshot',
      tokenId: id,
      bids,
      asks,
      venueTimestamp: frameTimestamp,
      hash: stringOrNull(body.hash),
      tickSize: decimal(body.tick_size ?? body.tickSize),
      minOrderSize: decimal(body.min_order_size ?? body.minOrderSize)
    };
  }

  if (eventType === 'price_change') {
    const rawChanges = body.price_changes ?? body.priceChanges;
    if (!Array.isArray(rawChanges)) {
      return { kind: 'malformed', detail: 'price_change frame has no price_changes array' };
    }
    const changes: PolymarketBookDeltaLevel[] = [];
    for (const rawChange of rawChanges) {
      if (!isRecord(rawChange)) {
        return { kind: 'malformed', detail: 'price_change entry is not an object' };
      }
      const id = tokenId(rawChange);
      const price = decimal(rawChange.price);
      const size = decimal(rawChange.size);
      const changeSide = side(rawChange.side);
      if (id === null || price === null || size === null || changeSide === null) {
        return {
          kind: 'malformed',
          detail: 'price_change entry is missing an asset id, price, size or side'
        };
      }
      changes.push({
        tokenId: id,
        price,
        size,
        side: changeSide,
        bestBid: decimal(rawChange.best_bid ?? rawChange.bestBid),
        bestAsk: decimal(rawChange.best_ask ?? rawChange.bestAsk)
      });
    }
    return { kind: 'delta', changes, venueTimestamp: frameTimestamp };
  }

  if (eventType === 'tick_size_change') {
    const id = tokenId(body);
    const newTickSize = decimal(body.new_tick_size ?? body.newTickSize);
    if (id === null || newTickSize === null) {
      return { kind: 'malformed', detail: 'tick_size_change frame is missing an id or tick size' };
    }
    return { kind: 'tick-size', tokenId: id, newTickSize, venueTimestamp: frameTimestamp };
  }

  if (eventType === 'market_resolved') {
    return {
      kind: 'resolved',
      tokenIds: tokenIdList(body),
      winningTokenId: stringOrNull(body.winning_asset_id ?? body.winningTokenId),
      venueTimestamp: frameTimestamp
    };
  }

  const recognised = eventType === 'best_bid_ask'
    || eventType === 'last_trade_price'
    || eventType === 'new_market';
  return { kind: 'inert', eventType, recognised };
}

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════

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

export const POLYMARKET_BOOK_DEFAULT_DELTA_POLICY: PolymarketBookDeltaPolicy = 'apply-ordered';

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

export function createPolymarketBookSubscriberState(
  tracked: Iterable<string> = []
): PolymarketBookSubscriberState {
  return {
    tracked: new Set(tracked),
    books: new Map(),
    lastVenueTimestamp: new Map(),
    lastHash: new Map(),
    connected: false
  };
}

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
  | 'applied-snapshot'
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

// ═══════════════════════════════════════════════════════════════════════════
// Transitions
// ═══════════════════════════════════════════════════════════════════════════

function withBook(
  state: PolymarketBookSubscriberState,
  tokenIdValue: string,
  entry: PolymarketBookEntry
): PolymarketBookSubscriberState {
  const books = new Map(state.books);
  books.set(tokenIdValue, entry);
  return { ...state, books };
}

/**
 * Mark one token's depth unknown.
 *
 * `bestBid` / `bestAsk` survive because `price_change` carries them on every
 * message, so top-of-book outlives a gap even when the ladder does not. They are
 * observability only: the reader's `awaiting-snapshot` variant has **no ladder
 * field**, so there is nothing for a consumer to mistake for depth.
 */
function invalidate(
  state: PolymarketBookSubscriberState,
  tokenIdValue: string,
  since: number
): PolymarketBookSubscriberState {
  const previous = state.books.get(tokenIdValue);
  const carried = previous !== undefined && previous.status === 'awaiting-snapshot'
    ? { bestBid: previous.bestBid ?? null, bestAsk: previous.bestAsk ?? null }
    : { bestBid: null, bestAsk: null };
  const books = new Map(state.books);
  books.set(tokenIdValue, {
    status: 'awaiting-snapshot',
    tokenId: tokenIdValue,
    since,
    bestBid: carried.bestBid,
    bestAsk: carried.bestAsk
  });
  const lastVenueTimestamp = new Map(state.lastVenueTimestamp);
  // The ordering watermark goes with the ladder. Keeping it would let the next
  // snapshot be refused as "old" against a watermark set by a state we threw away.
  lastVenueTimestamp.delete(tokenIdValue);
  return { ...state, books, lastVenueTimestamp };
}

/**
 * Mark every tracked token's depth unknown -- the reconnect transition.
 *
 * **Nothing is carried across the gap.** `price_change` is incremental, so a
 * pre-disconnect ladder plus post-reconnect deltas is a book that looks fine and
 * is wrong, which is the failure that bites hardest because it presents as a
 * working system with slightly wrong numbers.
 */
export function invalidateAllPolymarketBooks(
  state: PolymarketBookSubscriberState,
  now: number
): PolymarketBookApplyResult {
  let next: PolymarketBookSubscriberState = { ...state, connected: false };
  const invalidated: string[] = [];
  for (const trackedToken of state.tracked) {
    next = invalidate(next, trackedToken, now);
    invalidated.push(trackedToken);
  }
  // A book held for a token that is no longer tracked is invalidated too, so an
  // untracked leftover can never outlive a reconnect as apparently-fresh depth.
  for (const heldToken of state.books.keys()) {
    if (state.tracked.has(heldToken)) continue;
    next = invalidate(next, heldToken, now);
    invalidated.push(heldToken);
  }
  return {
    state: next,
    codes: invalidated.map(() => 'resync-transport-disconnected' as const),
    invalidated,
    touched: invalidated,
    detail:
      `Polymarket market stream disconnected at ${now}; ${invalidated.length} book(s) are awaiting a `
      + 'snapshot. price_change is incremental, so no pre-disconnect ladder is carried across the gap.'
  };
}

function applySnapshot(
  state: PolymarketBookSubscriberState,
  message: PolymarketBookSnapshotMessage,
  now: number
): PolymarketBookApplyResult {
  if (!state.tracked.has(message.tokenId)) {
    return {
      state,
      codes: ['ignored-untracked-token'],
      invalidated: [],
      touched: [],
      detail:
        `Ignored a Polymarket book snapshot for untracked token ${message.tokenId}. The tracked set is `
        + 'maintained by this subscriber, so an unexpected token is a venue or routing surprise rather '
        + 'than a race, and creating an entry for it would publish depth nobody asked for.'
    };
  }
  const lastHash = new Map(state.lastHash);
  lastHash.set(message.tokenId, message.hash);
  const lastVenueTimestamp = new Map(state.lastVenueTimestamp);
  if (message.venueTimestamp !== null) {
    lastVenueTimestamp.set(message.tokenId, message.venueTimestamp);
  } else {
    // No stamp means no watermark: a later delta is then unorderable rather than
    // measured against a stale one.
    lastVenueTimestamp.delete(message.tokenId);
  }
  const withEntry = withBook(state, message.tokenId, {
    status: 'book',
    tokenId: message.tokenId,
    ladders: { bids: message.bids, asks: message.asks },
    // Our clock, not the venue's. This is the figure the reader measures
    // staleness against, and it is the only clock we control.
    observedAt: now,
    venueTimestamp: message.venueTimestamp,
    tickSize: message.tickSize,
    minOrderSize: message.minOrderSize
  });
  return {
    state: { ...withEntry, lastHash, lastVenueTimestamp },
    codes: ['applied-snapshot'],
    invalidated: [],
    touched: [message.tokenId],
    detail:
      `Applied a Polymarket book snapshot for ${message.tokenId} at ${now}: ${message.bids.length} `
      + `bid level(s), ${message.asks.length} ask level(s), venue timestamp `
      + `${String(message.venueTimestamp)}.`
  };
}

/** Replace one level on one side. `size === 0` removes it. */
function replaceLevel(
  ladder: readonly PolymarketBookLevel[],
  price: number,
  size: number
): readonly PolymarketBookLevel[] {
  const kept = ladder.filter((level) => level.price !== price);
  if (size <= 0) return kept;
  return [...kept, { price, size }];
}

function applyDelta(
  state: PolymarketBookSubscriberState,
  message: PolymarketBookDeltaMessage,
  now: number,
  policy: PolymarketBookDeltaPolicy
): PolymarketBookApplyResult {
  let next = state;
  const codes: PolymarketBookApplyCode[] = [];
  const invalidated: string[] = [];
  const touched: string[] = [];
  const details: string[] = [];

  // Group by token: one frame can carry changes for several assets, and a gap on
  // one of them must not invalidate the others.
  const byToken = new Map<string, PolymarketBookDeltaLevel[]>();
  for (const change of message.changes) {
    const bucket = byToken.get(change.tokenId);
    if (bucket === undefined) byToken.set(change.tokenId, [change]);
    else bucket.push(change);
  }

  for (const [token, changes] of byToken) {
    if (!next.tracked.has(token)) {
      codes.push('ignored-untracked-token');
      details.push(`price_change for untracked token ${token} ignored`);
      continue;
    }

    if (policy === 'never') {
      codes.push('resync-delta-policy');
      invalidated.push(token);
      touched.push(token);
      next = invalidate(next, token, now);
      details.push(
        `price_change for ${token} forced a resync: deltaPolicy is 'never', so only snapshots build a `
        + 'ladder here.'
      );
      continue;
    }

    const entry = next.books.get(token);
    if (entry === undefined || entry.status !== 'book') {
      // The trap, made explicit. A delta is NEVER applied to a book we have not
      // snapshotted: an empty ladder plus a deletion is a valid-looking thin book,
      // i.e. a number, where the truth is a gap. Top-of-book from the delta is
      // kept on the awaiting-snapshot entry because it is honest and useful, and
      // that variant has no ladder for anyone to misread as depth.
      const last = changes[changes.length - 1];
      const since = entry !== undefined && entry.status === 'awaiting-snapshot'
        ? entry.since
        : now;
      const books = new Map(next.books);
      books.set(token, {
        status: 'awaiting-snapshot',
        tokenId: token,
        since,
        bestBid: last?.bestBid ?? null,
        bestAsk: last?.bestAsk ?? null
      });
      next = { ...next, books };
      codes.push('resync-delta-before-snapshot');
      invalidated.push(token);
      touched.push(token);
      details.push(
        `price_change for ${token} discarded: no snapshot to patch (${entry === undefined
          ? 'no entry at all'
          : `awaiting a snapshot since ${entry.since}`}). Applying it to an empty ladder would produce a `
        + 'thin book instead of a gap.'
      );
      continue;
    }

    const watermark = next.lastVenueTimestamp.get(token);
    if (message.venueTimestamp === null) {
      if (policy === 'apply-ordered') {
        codes.push('resync-delta-unorderable');
        invalidated.push(token);
        touched.push(token);
        next = invalidate(next, token, now);
        details.push(
          `price_change for ${token} carried no timestamp, so its position in the sequence cannot be `
          + 'shown. This channel publishes no sequence number, so unorderable is treated as unknown.'
        );
        continue;
      }
    } else if (watermark !== undefined && message.venueTimestamp < watermark) {
      // Out of order. Never patched: the venue offers no sequence number, so this
      // timestamp comparison is the only gap evidence available, and a
      // best-effort repair here is exactly the silently-wrong book the reader
      // would price a cohort against.
      codes.push('resync-delta-out-of-order');
      invalidated.push(token);
      touched.push(token);
      next = invalidate(next, token, now);
      details.push(
        `price_change for ${token} is stamped ${message.venueTimestamp}, before the applied state's `
        + `${watermark}. The book is unknown until the next snapshot rather than patched.`
      );
      continue;
    }

    let bids = entry.ladders.bids;
    let asks = entry.ladders.asks;
    for (const change of changes) {
      // `side: "BUY"` is a bid (someone bidding to buy), `"SELL"` is an ask.
      if (change.side === 'BUY') bids = replaceLevel(bids, change.price, change.size);
      else asks = replaceLevel(asks, change.price, change.size);
    }

    const books = new Map(next.books);
    books.set(token, {
      status: 'book',
      tokenId: token,
      ladders: { bids, asks },
      // **`observedAt` is deliberately NOT advanced.** A delta refines a snapshot;
      // it does not re-observe the book. Advancing it would let a stream of
      // deltas keep a book readable indefinitely on the strength of a
      // `price_change.size` reading the docs never state -- and would make a
      // drifting ladder present as fresh. Ageing on the snapshot's clock keeps
      // the resync the authority and biases every error toward unknown.
      observedAt: entry.observedAt,
      venueTimestamp: message.venueTimestamp ?? entry.venueTimestamp ?? null,
      tickSize: entry.tickSize ?? null,
      minOrderSize: entry.minOrderSize ?? null
    });
    next = { ...next, books };
    if (message.venueTimestamp !== null) {
      const lastVenueTimestamp = new Map(next.lastVenueTimestamp);
      lastVenueTimestamp.set(token, message.venueTimestamp);
      next = { ...next, lastVenueTimestamp };
    }
    codes.push('applied-delta');
    touched.push(token);
    details.push(
      `Applied ${changes.length} level change(s) to ${token}; observedAt stays ${entry.observedAt} so `
      + 'the snapshot cadence remains the freshness authority.'
    );
  }

  return { state: next, codes, invalidated, touched, detail: details.join(' ') };
}

function applyTickSize(
  state: PolymarketBookSubscriberState,
  message: PolymarketBookTickSizeMessage
): PolymarketBookApplyResult {
  const entry = state.books.get(message.tokenId);
  if (entry === undefined || entry.status !== 'book') {
    // Nothing to attach it to, and it is not depth. Recording it would mean
    // inventing an entry, which would turn "never snapshotted" into something
    // that looks observed.
    return {
      state,
      codes: ['ignored-tick-size-without-book'],
      invalidated: [],
      touched: [],
      detail: `tick_size_change for ${message.tokenId} ignored: no snapshotted book to record it on.`
    };
  }
  return {
    state: withBook(state, message.tokenId, { ...entry, tickSize: message.newTickSize }),
    codes: ['applied-tick-size'],
    invalidated: [],
    touched: [message.tokenId],
    detail:
      `Recorded tick size ${message.newTickSize} for ${message.tokenId}. Depth is unchanged; the mirror `
      + 'bound snaps prices to this grid, so a tick change we did not see would make us sign off-grid.'
  };
}

function applyResolved(
  state: PolymarketBookSubscriberState,
  message: PolymarketBookResolvedMessage,
  now: number
): PolymarketBookApplyResult {
  let next = state;
  const invalidated: string[] = [];
  for (const token of message.tokenIds) {
    if (!next.books.has(token) && !next.tracked.has(token)) continue;
    next = invalidate(next, token, now);
    invalidated.push(token);
  }
  return {
    state: next,
    codes: invalidated.map(() => 'resync-market-resolved' as const),
    invalidated,
    touched: invalidated,
    detail:
      `market_resolved invalidated ${invalidated.length} book(s) (winning token `
      + `${String(message.winningTokenId)}). A resolved market's ladder is not tradeable depth, so the `
      + "reader answers unknown. Note the honest limit: the reader's vocabulary has no 'resolved' code, "
      + "so it reports 'book-awaiting-snapshot' -- this module's 'resync-market-resolved' is where the "
      + 'real cause lives.'
  };
}

/**
 * The state machine. Pure: no clock, no socket, no environment.
 *
 * `now` is the caller's clock and becomes `observedAt` on a snapshot, which is
 * the figure the depth reader measures its budget against.
 */
export function applyPolymarketBookMessage(
  state: PolymarketBookSubscriberState,
  input: {
    readonly raw: unknown;
    readonly now: number;
    readonly deltaPolicy?: PolymarketBookDeltaPolicy;
  }
): PolymarketBookApplyResult {
  if (!Number.isFinite(input.now)) {
    throw new PolymarketBookSubscriberConfigError(
      `now must be a finite epoch-ms value, got ${input.now}`
    );
  }
  const policy = input.deltaPolicy ?? POLYMARKET_BOOK_DEFAULT_DELTA_POLICY;
  const message = parsePolymarketMarketMessage(input.raw);

  switch (message.kind) {
    case 'snapshot':
      return applySnapshot(state, message, input.now);
    case 'delta':
      return applyDelta(state, message, input.now, policy);
    case 'tick-size':
      return applyTickSize(state, message);
    case 'resolved':
      return applyResolved(state, message, input.now);
    case 'inert':
      return {
        state,
        codes: [message.recognised ? 'ignored-non-depth-event' : 'ignored-unknown-event'],
        invalidated: [],
        touched: [],
        detail: message.recognised
          ? `Ignored documented non-depth event ${String(message.eventType)}.`
          : `Ignored unrecognised event ${String(message.eventType)}. An event type the venue adds `
            + 'later must never touch a book.'
      };
    case 'malformed':
      // Prior state is left intact rather than overwritten. Replacing a
      // known-good ladder with nothing on a bad frame would turn a parser bug
      // into an outage; leaving it means staleness handles it on the reader side.
      return {
        state,
        codes: ['refused-malformed-frame'],
        invalidated: [],
        touched: [],
        detail: `Refused a malformed market frame: ${message.detail}. Prior books are untouched.`
      };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Resync scheduling
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Assert the resync cadence can keep the cache inside the reader's budget.
 *
 * The reader's `POLYMARKET_BOOK_MAX_AGE_MS` is documented as **two resync
 * periods**, so the two numbers are one decision, not two. An interval above
 * half the budget cannot keep a book fresh even when nothing goes wrong, and the
 * symptom would be every polygon cohort flapping to `capacity-unknown` with no
 * error anywhere -- so this throws rather than warning.
 */
export function assertPolymarketBookResyncBudget(input: {
  readonly resyncIntervalMs: number;
  readonly maxAgeMs: number;
}): void {
  const { resyncIntervalMs, maxAgeMs } = input;
  if (!Number.isFinite(resyncIntervalMs) || resyncIntervalMs <= 0) {
    throw new PolymarketBookSubscriberConfigError(
      `resyncIntervalMs must be a positive finite number, got ${resyncIntervalMs}`
    );
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new PolymarketBookSubscriberConfigError(
      `maxAgeMs must be a positive finite number, got ${maxAgeMs}`
    );
  }
  if (resyncIntervalMs * 2 > maxAgeMs) {
    throw new PolymarketBookSubscriberConfigError(
      `A ${resyncIntervalMs}ms resync cadence cannot hold a book inside the reader's ${maxAgeMs}ms `
      + 'budget: POLYMARKET_BOOK_MAX_AGE_MS is derived as two resync periods, so the cadence must be '
      + 'at most half the budget. Picking the two numbers independently is the drift this check exists '
      + 'to prevent.'
    );
  }
}

/**
 * Which tracked tokens need a `POST /books` resync now.
 *
 * A token is due when it has no entry, is awaiting a snapshot, or its snapshot is
 * at least one resync period old. Pure, so the schedule is testable without a
 * timer: the shell just calls this with `Date.now()`.
 */
export function polymarketBooksDueForResync(
  state: PolymarketBookSubscriberState,
  input: { readonly now: number; readonly resyncIntervalMs?: number }
): readonly string[] {
  const resyncIntervalMs = input.resyncIntervalMs ?? POLYMARKET_BOOK_RESYNC_INTERVAL_MS;
  const due: string[] = [];
  for (const token of state.tracked) {
    const entry = state.books.get(token);
    if (entry === undefined || entry.status !== 'book') {
      due.push(token);
      continue;
    }
    if (input.now - entry.observedAt >= resyncIntervalMs) due.push(token);
  }
  return due;
}

/** Chunk a token list to the venue's documented `POST /books` maximum. */
export function chunkPolymarketBookBatch(
  tokenIds: readonly string[],
  batchSize: number = POLYMARKET_BOOKS_MAX_BATCH
): readonly (readonly string[])[] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new PolymarketBookSubscriberConfigError(
      `batchSize must be a positive integer, got ${batchSize}`
    );
  }
  if (batchSize > POLYMARKET_BOOKS_MAX_BATCH) {
    throw new PolymarketBookSubscriberConfigError(
      `batchSize ${batchSize} exceeds the documented POST /books maximum of `
      + `${POLYMARKET_BOOKS_MAX_BATCH} items per request`
    );
  }
  const batches: string[][] = [];
  for (let index = 0; index < tokenIds.length; index += batchSize) {
    batches.push(tokenIds.slice(index, index + batchSize));
  }
  return batches;
}

// ═══════════════════════════════════════════════════════════════════════════
// The injected transport
// ═══════════════════════════════════════════════════════════════════════════

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

export type PolymarketBookTransportFactory = (
  handlers: PolymarketBookTransportHandlers
) => PolymarketBookTransport;

/** Injected batch resync. Returns raw `POST /books` rows; parsing is shared. */
export type PolymarketBookResyncFetcher = (
  tokenIds: readonly string[]
) => Promise<readonly unknown[]>;

// ═══════════════════════════════════════════════════════════════════════════
// The shell
// ═══════════════════════════════════════════════════════════════════════════

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

const ZERO_STATS: Readonly<Record<PolymarketBookApplyCode, number>> = Object.freeze({
  'applied-snapshot': 0,
  'applied-delta': 0,
  'applied-tick-size': 0,
  'resync-delta-before-snapshot': 0,
  'resync-delta-out-of-order': 0,
  'resync-delta-unorderable': 0,
  'resync-delta-policy': 0,
  'resync-market-resolved': 0,
  'resync-transport-disconnected': 0,
  'ignored-untracked-token': 0,
  'ignored-non-depth-event': 0,
  'ignored-unknown-event': 0,
  'refused-malformed-frame': 0,
  'ignored-tick-size-without-book': 0
});

/**
 * Build the documented subscribe frame.
 *
 * `{"assets_ids": [...], "type": "market"}` for the initial subscription;
 * `{"assets_ids": [...], "operation": "subscribe" | "unsubscribe"}` to change the
 * token set on a live connection. Exported so a test can assert the exact bytes
 * without a socket.
 */
export function polymarketMarketSubscribeFrame(input: {
  readonly tokenIds: readonly string[];
  readonly operation?: 'subscribe' | 'unsubscribe';
  readonly customFeatureEnabled?: boolean;
}): string {
  if (input.operation !== undefined) {
    return JSON.stringify({ assets_ids: input.tokenIds, operation: input.operation });
  }
  return JSON.stringify({
    assets_ids: input.tokenIds,
    type: 'market',
    ...(input.customFeatureEnabled === true ? { custom_feature_enabled: true } : {})
  });
}

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
export function createPolymarketBookSubscriber(
  options: PolymarketBookSubscriberOptions
): PolymarketBookSubscriber {
  const resyncIntervalMs = options.resyncIntervalMs ?? POLYMARKET_BOOK_RESYNC_INTERVAL_MS;
  const maxAgeMs = options.maxAgeMs ?? POLYMARKET_BOOK_MAX_AGE_MS;
  assertPolymarketBookResyncBudget({ resyncIntervalMs, maxAgeMs });
  const subscribeBatchSize =
    options.subscribeBatchSize ?? POLYMARKET_MARKET_WS_DEFAULT_SUBSCRIBE_BATCH;
  const deltaPolicy = options.deltaPolicy ?? POLYMARKET_BOOK_DEFAULT_DELTA_POLICY;
  const log = options.logger ?? {
    info: (message: string) => console.log(`[polymarket-book] ${message}`),
    warn: (message: string, error?: unknown) =>
      console.warn(`[polymarket-book] ${message}`, error ?? '')
  };

  let state = createPolymarketBookSubscriberState(options.tokenIds ?? []);
  let transport: PolymarketBookTransport | null = null;
  const stats: Record<PolymarketBookApplyCode, number> = { ...ZERO_STATS };

  function record(result: PolymarketBookApplyResult): readonly PolymarketBookApplyCode[] {
    state = result.state;
    for (const code of result.codes) stats[code] += 1;
    if (options.onEntry !== undefined) {
      for (const token of result.touched) {
        const entry = state.books.get(token);
        if (entry !== undefined) options.onEntry(entry);
      }
    }
    return result.codes;
  }

  function sendFrames(tokenIds: readonly string[], operation?: 'subscribe' | 'unsubscribe'): void {
    if (transport === null || tokenIds.length === 0) return;
    for (const batch of chunkPolymarketBookBatch(tokenIds, subscribeBatchSize)) {
      const frame = polymarketMarketSubscribeFrame({
        tokenIds: batch,
        ...(operation === undefined ? {} : { operation }),
        ...(options.customFeatureEnabled === true ? { customFeatureEnabled: true } : {})
      });
      transport.send(frame);
    }
  }

  const handlers: PolymarketBookTransportHandlers = {
    onOpen: () => {
      state = { ...state, connected: true };
      // Re-sent on every open: the docs say the `operation` frames "update only
      // the token set for the current market-stream connection", so a reconnect
      // starts from an empty subscription.
      sendFrames([...state.tracked]);
      log.info(`connected; subscribed ${state.tracked.size} token(s)`);
    },
    onMessage: (frame: string) => {
      // The heartbeat reply is a bare text frame, not JSON. It proves the
      // connection and says nothing about any book, so it never touches state.
      if (frame.trim().toUpperCase() === 'PONG') return;
      const result = applyPolymarketBookMessage(state, {
        raw: frame,
        now: options.now(),
        deltaPolicy
      });
      record(result);
      if (result.codes.some((code) => code.startsWith('resync-') || code.startsWith('refused-'))) {
        log.warn(result.detail);
      }
    },
    onClose: (reason: string) => {
      // Every disconnect makes every book unknown. Not best-effort: the ladder is
      // dropped, and the reader's `awaiting-snapshot` variant has no ladder field.
      record(invalidateAllPolymarketBooks(state, options.now()));
      transport = null;
      log.warn(`market stream closed (${reason}); all books awaiting snapshot`);
    },
    onError: (error: unknown) => {
      log.warn('market stream error', error);
    }
  };

  return {
    cache: { get: (token: string) => state.books.get(token) },
    state: () => state,
    start: () => {
      if (transport !== null) return;
      transport = options.transportFactory(handlers);
    },
    stop: () => {
      const current = transport;
      transport = null;
      // Stopping is a disconnect: books must not survive it as apparently-fresh
      // depth just because the shutdown was deliberate.
      record(invalidateAllPolymarketBooks(state, options.now()));
      current?.close();
    },
    subscribe: (tokenIds: readonly string[]) => {
      const added = tokenIds.filter((token) => token.length > 0 && !state.tracked.has(token));
      if (added.length === 0) return;
      const tracked = new Set(state.tracked);
      for (const token of added) tracked.add(token);
      state = { ...state, tracked };
      sendFrames(added, 'subscribe');
    },
    unsubscribe: (tokenIds: readonly string[]) => {
      const removed = tokenIds.filter((token) => state.tracked.has(token));
      if (removed.length === 0) return;
      const tracked = new Set(state.tracked);
      const books = new Map(state.books);
      const lastVenueTimestamp = new Map(state.lastVenueTimestamp);
      for (const token of removed) {
        tracked.delete(token);
        // The entry goes too, so an unsubscribed market reads `book-not-cached`
        // rather than a ladder nothing is updating any more.
        books.delete(token);
        lastVenueTimestamp.delete(token);
      }
      state = { ...state, tracked, books, lastVenueTimestamp };
      sendFrames(removed, 'unsubscribe');
    },
    sendHeartbeat: () => {
      transport?.send('PING');
    },
    runDueResyncs: async () => {
      const due = polymarketBooksDueForResync(state, { now: options.now(), resyncIntervalMs });
      if (due.length === 0) return [];
      const codes: PolymarketBookApplyCode[] = [];
      for (const batch of chunkPolymarketBookBatch(due, POLYMARKET_BOOKS_MAX_BATCH)) {
        let rows: readonly unknown[];
        try {
          rows = await options.fetchBooks(batch);
        } catch (error) {
          // A failed resync changes nothing: the books already held keep ageing
          // and the reader answers `book-snapshot-stale` on its own. Inventing an
          // invalidation here would flap the cohort on one bad request.
          log.warn(`POST /books failed for ${batch.length} token(s)`, error);
          continue;
        }
        for (const row of rows) {
          // A `POST /books` row is the same shape as a `book` frame minus the
          // discriminator, so the one parser serves both and the two paths cannot
          // drift.
          const raw = isRecord(row) ? { ...row, event_type: 'book' } : row;
          codes.push(...record(applyPolymarketBookMessage(state, {
            raw,
            now: options.now(),
            deltaPolicy
          })));
        }
      }
      return codes;
    },
    stats: () => ({ ...stats })
  };
}
