/**
 * Which Polymarket markets the book feed subscribes to (`S4-M38`).
 *
 * ── The question this answers ─────────────────────────────────────────────
 *
 * The subscriber streams order books into Redis so `signal-engine` can gate
 * fan-out on real depth. It cannot stream *every* Polymarket market — there are
 * tens of thousands, most of them irrelevant to this platform — so something has
 * to choose. This module is that choice, and it is deliberately a DB query plus
 * a **pure** decider rather than a config list, because a hand-maintained list
 * goes stale silently and a stale list reads exactly like a working one.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * Subscribe to the markets this platform might actually have to price, which is
 * the union of two sets:
 *
 *   1. **Markets a tracked master has traded recently** (`source_trades`). These
 *      are the fan-out candidates: a signal fires on a token a master just
 *      traded, and the capacity gate needs that token's book seconds later.
 *   2. **Markets somebody still holds** (`wallet_positions` with a non-zero
 *      balance). An open position has to be exitable, and an exit is priced
 *      against the same book.
 *
 * Set 1 without set 2 would blind the platform to exits on a market that has
 * gone quiet, which is precisely when an exit matters most.
 *
 * ── Eviction, and why it is safe ──────────────────────────────────────────
 *
 * The set is capped (`POLYMARKET_BOOK_MAX_SUBSCRIPTIONS`). When it overflows,
 * the **least recently active** market is dropped, not the newest. A token
 * nobody has traded or held for days has no imminent fan-out to gate, so its
 * book is the least costly one to lose; dropping the newest would blind the gate
 * on exactly the market that just became active.
 *
 * Eviction is safe in the direction that matters: an unsubscribed market has no
 * cache entry, the reader answers `book-not-cached`, and the capacity gate
 * excludes the cohort with `capacity-unknown`. Losing a subscription costs a
 * missed copy, never an unmeasured fill. That asymmetry is what makes a cap
 * acceptable here at all.
 */
/**
 * How many markets the feed holds at once.
 *
 * Not derived from a documented venue limit — the market channel publishes none
 * (see `POLYMARKET_MARKET_WS_DEFAULT_SUBSCRIBE_BATCH`'s note). It is a
 * deliberately conservative default bounded by the *resync* path instead, which
 * does have a documented ceiling: `POST /books` takes 500 ids per request, so
 * 2000 markets is four requests per resync cycle. Raising it raises the resync
 * cost linearly and should be done only with the cadence budget re-checked.
 */
export declare const POLYMARKET_BOOK_MAX_SUBSCRIPTIONS = 2000;
/** How far back a trade still counts as "recent" for subscription purposes. */
export declare const POLYMARKET_BOOK_ACTIVITY_WINDOW_MS: number;
export interface PolymarketBookSubscriptionCandidate {
    /** Chain-prefixed as stored (`polygon:<tokenId>`). */
    readonly tokenMint: string;
    /** Epoch ms of the most recent activity. Drives eviction order. */
    readonly lastActiveAt: number;
    readonly source: 'recent-trade' | 'open-position';
}
export interface PolymarketBookSubscriptionSet {
    /** Bare CLOB token ids, which is what `assets_ids` speaks. */
    readonly tokenIds: readonly string[];
    /** How many candidates the cap excluded. Non-zero is an ops signal. */
    readonly evicted: number;
    readonly counts: {
        readonly recentTrade: number;
        readonly openPosition: number;
    };
}
/**
 * Pick the subscription set from the candidates. Pure.
 *
 * Dedupes by token (a market that is both recently traded and held appears
 * twice), orders by most-recent activity, and applies the cap. Split from the
 * query so the ordering and eviction rules are testable with no database —
 * which matters here, because the eviction rule is the part with a consequence.
 */
export declare function selectPolymarketBookSubscriptions(candidates: readonly PolymarketBookSubscriptionCandidate[], maxSubscriptions?: number): PolymarketBookSubscriptionSet;
/**
 * Read the candidate markets from Postgres.
 *
 * One query with a `UNION ALL` rather than two round trips, and the pure
 * selector above does the merging — so the SQL stays a plain read with no
 * ranking logic to disagree with the tested decider.
 */
export declare function fetchPolymarketBookSubscriptionCandidates(params: {
    readonly now: Date;
    readonly activityWindowMs?: number;
}): Promise<readonly PolymarketBookSubscriptionCandidate[]>;
/**
 * The seed set for the book feed at startup: read, then decide.
 *
 * Returns an empty set rather than throwing when the read fails. An indexer that
 * refuses to boot because one seed query failed would stop ingesting every
 * chain; an empty seed degrades to "no Polymarket depth", which the capacity
 * gate already handles by admitting nobody on polygon. Live discovery
 * (`subscriber.subscribe(...)` as trades arrive) repopulates it regardless.
 */
export declare function loadPolymarketBookSubscriptionSet(params: {
    readonly now: Date;
    readonly activityWindowMs?: number;
    readonly maxSubscriptions?: number;
    readonly onFailure?: (detail: string) => void;
}): Promise<PolymarketBookSubscriptionSet>;
//# sourceMappingURL=polymarket-book-subscriptions.d.ts.map