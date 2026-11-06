import type { Chain } from './types.js';
/**
 * Polymarket order-book depth cache -- the pre-fan-out depth read (`S4-M38`),
 * and the input that unblocks `S4-M6`'s polygon half.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 *
 * `usableLiquidityForFanout` (`apps/signal-engine/src/capacity-inputs.ts`) hard
 * gates polygon to `unknownLiquidity` and does not read a TVL argument at all,
 * for a reason that is correct: a Polymarket outcome share trades on the CLOB,
 * so its liquidity is **resting book depth inside a price bound**, and a
 * DexScreener figure for the same address is either null or the TVL of an
 * unrelated Polygon pair. With `unassessablePolicy: 'skip'` that means **no user
 * can copy a Polymarket signal today**. This module supplies the missing figure
 * from a locally-held book snapshot instead of a round trip on the money path.
 *
 * ── What the venue actually provides (confirmed in the live docs) ──────────
 *
 *   * `wss://ws-subscriptions-clob.polymarket.com/ws/market`, subscribed with
 *     `{"assets_ids": [...], "type": "market"}`. Application-level heartbeat:
 *     send the text frame `PING` every 10 s, the server replies `PONG`
 *     (`/market-data/realtime-data` -> *Market Stream*). The heartbeat proves the
 *     **connection**, not the book -- the feed is event-driven, so a quiet market
 *     sends nothing for minutes. Freshness can never be inferred from the clock.
 *   * `book` event payload: `market`, `asset_id` / `tokenId`, `bids[]`, `asks[]`
 *     as `{price, size}` decimal strings, `hash`, and **nullable** `timestamp`,
 *     `minOrderSize`, `tickSize`, `negRisk`, `lastTradePrice`.
 *   * `price_change` is **incremental** and carries `best_bid` / `best_ask` on
 *     every message, so after a reconnect top-of-book survives and only the
 *     depth ladder needs rebuilding.
 *   * `tick_size_change`, `market_resolved`, `new_market`, `best_bid_ask` (the
 *     last three under `custom_feature_enabled`).
 *   * `initial_dump` (default `true`) controls whether a subscribe replies with
 *     the current book, and the 100-token subscription limit on the market
 *     channel was removed (changelog, 28 May 2025).
 *   * Batch resync: `POST /books` / `fetchOrderBooks`, **max 500 items per
 *     request**, rate limit **500 req / 10 s** (`/api-reference/rate-limits`).
 *   * A CLOB `size` is a **share count** and `price` is USD per share, so a
 *     level's USD notional is `price * size` -- the same arithmetic
 *     `planPolymarketBookOrder` already uses (`levelNotional = size * price`).
 *
 * ── The central design question, answered plainly ─────────────────────────
 *
 * **`priceImpactBps`'s constant-product algebra CANNOT consume a book-depth
 * figure.** That function is `notional / reserve * 10_000`, exact for `x*y=k`
 * because average execution price over spot is exactly `1 + dx/x`. An order book
 * has no `x`. If you substitute depth-within-bound `D(b)` for the reserve you get
 * "fraction of the bounded book consumed, printed in bps" -- a different
 * quantity, compared against a ceiling (`PLATFORM_MAX_AGGREGATE_IMPACT_BPS`,
 * 100 bps on polygon) that is denominated in **price impact**. Consuming all of
 * `D(b)` returns 10_000 bps when the true average impact is at most `b`: wrong by
 * a factor of `10_000 / b`.
 *
 * Nor can a linear interpolation rescue it. `L(N) = N / D(b) * b` looks
 * conservative but is not: a book with a sliver at the best price and a wall one
 * tick below the bound has `A(N) ~ b` for almost every `N`, while `L(N)` is still
 * near zero. That is the fail-open direction, which is the direction that admits
 * a market-moving cohort. **The shape of the ladder determines the impact, and no
 * scalar summary preserves the shape.** So book depth gets its own impact
 * function here: `polymarketBookAverageImpactBps` walks the ladder, and
 * `polymarketBookCapacityNotionalUsd` inverts it.
 *
 * **What is then handed to `S4-M6`, and why it is not a fake conversion.** The
 * consumer's decision is a single threshold test: `committed + projected` impact
 * over `capBps`. So this module computes the true book capacity `C` -- the largest
 * cohort notional whose walked **average** impact stays within `capBps` and which
 * touches no level worse than the marginal bound -- and publishes
 * `usableLiquidityUsd = C * 10_000 / capBps`. That is the reserve for which
 * `priceImpactBps(N, reserve) <= capBps` **if and only if** `N <= C`, and for
 * which `capacityNotionalUsd(reserve, capBps) === C` exactly. The admit/skip
 * boundary is therefore the true book boundary, not an approximation of it, and
 * because the AMM ratio is additive in notional the consumer's
 * `committedImpactBps + projectedImpactBps` test reduces to `committed +
 * projected <= C`, which is exactly how a cohort walks a book.
 *
 * The cost is stated rather than buried: **away from the boundary the bps figures
 * the consumer prints are budget-consumption readings, not price impact**, and
 * `usableLiquidityUsd` is a calibrated equivalent reserve roughly `10_000/capBps`
 * times the real depth. `note` carries the real depth and the derivation, and
 * `calibratedForImpactCapBps` is echoed back so a caller that overrode
 * `maxAggregateImpactBps` can detect the mismatch -- see
 * `assertPolymarketBookLiquidityCalibration`.
 *
 * ── Unknown is never a number, and never "fine" ───────────────────────────
 *
 * A stale entry reads **unknown**, never its last value (`S4-M6`'s note, and the
 * `S4-M41`/`S4-M42` discipline). An absent entry, a post-reconnect ladder, an
 * empty side, a crossed book and a malformed level each get their own stable
 * code. A book that genuinely holds nothing inside the bound is a *third* state
 * (`no-depth-within-bound`) -- known, and known to be zero -- because "go look at
 * the feed" and "this market is empty" demand opposite responses.
 *
 * ── Pure ─────────────────────────────────────────────────────────────────
 *
 * No network, no clock, no environment. `now` is a required argument, the cache
 * is an injected port, and the fetch/subscribe/reconnect machinery is the
 * caller's job. That is what makes this testable with no infrastructure, and it
 * matches `pusd-liquidity.ts`, `polymarket-staleness.ts` and `master-capacity.ts`.
 */
/**
 * How old a cached book may be before it reads unknown, in ms.
 *
 * **Not a round number, and not the executor's 15 s copied across.** The
 * derivation, because the threshold is the single most consequential constant
 * here:
 *
 *   1. This figure is read **before fan-out**, in `signal-engine`. The orders it
 *      admits then drain through one concurrency-1 worker per chain at a
 *      conservative ~6 s each, up to the `DEFAULT_FOLLOWER_SOFT_CAP` of 50 --
 *      about 5 minutes (`MASTER_CAPACITY_WINDOWS.fanoutDrainMs`). So no cache
 *      threshold, however tight, can make the *last* copier's book fresh. Per-fill
 *      freshness is not this budget's job and never can be: it stays with the
 *      executor's own `POLYMARKET_MAX_BOOK_AGE_MS` check inside
 *      `validateBookTimestamp`, which is unchanged.
 *   2. What this budget must guarantee is narrower and achievable: that the
 *      cohort-admission decision rested on a book the codebase would have been
 *      willing to *trade* against. That pins the ceiling at the executor's own
 *      allowance -- 15 s (`POLYMARKET_MAX_BOOK_AGE_MS` default, also
 *      `POLYMARKET_DEFAULT_STALENESS_FLOOR_MS`). Admitting a cohort against a book
 *      older than the one the money path refuses is admitting against nothing.
 *   3. But the feed is **event-driven with no per-token heartbeat**, so a quiet
 *      market cannot prove its own freshness. Freshness therefore means "we
 *      resynced recently", and the operator's real control is the ingestion
 *      service's `POST /books` cadence. Setting the threshold *equal* to that
 *      cadence makes every ordinary scheduling jitter flap the whole polygon
 *      cohort to unknown.
 *
 * So: **two resync periods of 15 s = 30 s**, which tolerates exactly one missed
 * resync and no more. It is the loosest value that still keeps every admitted
 * cohort within two of the executor's own book-age allowances, and the tightest
 * value that does not turn ordinary jitter into a copy outage. The paired
 * requirement on the ingestion service is `POLYMARKET_BOOK_RESYNC_INTERVAL_MS`
 * below.
 */
export declare const POLYMARKET_BOOK_MAX_AGE_MS = 30000;
/**
 * The resync cadence the threshold above is derived from, and the requirement it
 * places on whoever fills the cache: **every subscribed token must be
 * re-snapshotted at least this often**, from `POST /books` rather than from the
 * stream, because the stream cannot keep a quiet market fresh.
 *
 * Affordable at the documented limits: 500 items per request and 500 req / 10 s,
 * so 500 markets cost one request every 15 s. Exported here, not read from the
 * environment, so the reader's threshold and the filler's cadence cannot drift
 * apart silently.
 */
export declare const POLYMARKET_BOOK_RESYNC_INTERVAL_MS = 15000;
/**
 * Tolerance for a venue timestamp that is ahead of our clock, in ms. Mirrors the
 * `timestamp > now + 5_000` guard already in `validateBookTimestamp`, so the two
 * freshness gates in this repo agree about clock skew instead of disagreeing.
 */
export declare const POLYMARKET_BOOK_CLOCK_SKEW_ALLOWANCE_MS = 5000;
/**
 * Default marginal price bound: size resting further than this from the best
 * price is **not counted at all**.
 *
 * Set to the executor's own book-walk slippage cap (`POLYMARKET_SLIPPAGE_BPS`
 * default 200 in `apps/trade-executor/src/polymarket.ts`) so the pre-fan-out
 * admission can never count depth that the executor's own walk would refuse to
 * cross. Admitting a cohort against size at a price the money path will reject is
 * the exact failure a "total depth" number produces.
 */
export declare const POLYMARKET_BOOK_DEFAULT_BOUND_BPS = 200;
/**
 * Hard ceiling on `boundBps`.
 *
 * The point of a bound is that a cohort is never admitted against size resting at
 * prices nobody would accept, so a bound wide enough to swallow the whole ladder
 * defeats the control. 2_000 bps is 20% away from best -- far past anything this
 * repo tolerates anywhere (the loosest chain default slippage is 1_500 bps on
 * Solana, and Polymarket's own mirror tolerance is 150). Passing more throws
 * rather than returning a verdict: it is an operator error, not a market
 * condition.
 */
export declare const POLYMARKET_BOOK_MAX_BOUND_BPS = 2000;
/**
 * A caller-side mistake: a nonsensical bound, a non-positive impact cap, a token
 * from another chain. Throws rather than returning a code, for the reason
 * `polymarket-staleness.ts` gives: a misconfigured threshold would otherwise
 * disable Polymarket depth silently for every trade.
 */
export declare class PolymarketBookDepthInputError extends Error {
    constructor(message: string);
}
/** One resting price level. `size` is a share count; `price` is USD per share. */
export interface PolymarketBookLevel {
    readonly price: number;
    /** Share count, exactly as the venue reports `size`. Never a notional. */
    readonly size: number;
}
/**
 * A reconstructed book, with the two sides under the venue's own field names.
 *
 * Sort order is **not** part of the contract: both ladders are sorted internally
 * before use, so a filler that forwards the venue's arrays verbatim cannot
 * introduce an ordering bug. What *is* checked is that the sides are not swapped
 * -- a book whose best bid is at or above its best ask is refused as crossed,
 * which is what a bids/asks transposition looks like.
 */
export interface PolymarketBookLadders {
    readonly bids: readonly PolymarketBookLevel[];
    readonly asks: readonly PolymarketBookLevel[];
}
/**
 * A cache entry, as a discriminated union rather than a flag.
 *
 * This is `S4-M38`'s trap (b) made structural. `price_change` is incremental, so
 * after a reconnect the depth ladder is not reconstructed until a fresh snapshot
 * arrives -- while `best_bid` / `best_ask` on every `price_change` mean
 * top-of-book survives. Treating a post-reconnect book as valid is the bug that
 * bites hardest, because it presents as a working system with slightly wrong
 * numbers. Here the `awaiting-snapshot` variant **has no ladder field at all**,
 * so there is nothing to read by accident.
 */
export type PolymarketBookEntry = {
    readonly status: 'book';
    /** Bare CLOB token id (`asset_id`), never chain-prefixed. */
    readonly tokenId: string;
    readonly ladders: PolymarketBookLadders;
    /**
     * When **we** applied this state, on our clock. Required, and the figure
     * staleness is measured against, because it is the only clock we control.
     */
    readonly observedAt: number;
    /**
     * The venue's `timestamp` on the frame, if it carried one -- the field is
     * documented nullable on both `book` and `price_change`. Used only to reject
     * an implausible clock, never as the age.
     */
    readonly venueTimestamp?: number | null;
    /** From the `book` event / `POST /books`. Carried through, not required. */
    readonly tickSize?: number | null;
    /** `min_order_size`, a **share count**. Carried through, not required. */
    readonly minOrderSize?: number | null;
} | {
    readonly status: 'awaiting-snapshot';
    readonly tokenId: string;
    /** When the ladder was invalidated (reconnect, or a gap in the sequence). */
    readonly since: number;
    /** Survives a reconnect via `price_change`. Present for observability only. */
    readonly bestBid?: number | null;
    readonly bestAsk?: number | null;
};
/**
 * The read side of the cache, as a port.
 *
 * `S4-M38`'s cache is Redis-backed and lives in a background service; this module
 * must stay pure, so it takes the narrowest possible read interface. A Redis
 * reader and the in-memory reference implementation below satisfy the same
 * contract, which is what keeps the tests honest about what the real one does.
 *
 * Keys are **bare CLOB token ids**, because that is what `assets_ids` speaks.
 * Callers hand this module the chain-prefixed `polygon:<id>` the rest of the repo
 * uses and the prefix is stripped here, so neither side has to remember.
 */
export interface PolymarketBookCache {
    readonly get: (tokenId: string) => PolymarketBookEntry | undefined;
}
/**
 * In-memory reference implementation. Not the production cache -- it exists so
 * the contract has exactly one definition and tests exercise the same lookup the
 * Redis reader will.
 */
export declare function createInMemoryPolymarketBookCache(entries?: readonly PolymarketBookEntry[]): PolymarketBookCache & {
    readonly put: (entry: PolymarketBookEntry) => void;
};
/**
 * Why no depth figure could be produced. **Stable strings** -- telemetry and the
 * skip-reason breakdown key on them, so they are appended to rather than renamed.
 *
 * Every one of these is a *distinct* operator action, which is the reason there
 * is no single "unavailable": subscribe the market, fix the resync cadence, wait
 * for a snapshot, or stop trusting the filler.
 */
export type PolymarketBookUnknownCode = 
/** No entry at all: the market was never subscribed, or the cache is empty. */
'book-not-cached'
/** Entry exists but is older than the freshness budget. Never its last value. */
 | 'book-snapshot-stale'
/** Post-reconnect: top-of-book survives, the depth ladder does not. */
 | 'book-awaiting-snapshot'
/**
 * **Both** sides empty after deletions are dropped. Unknown rather than zero,
 * because that is what a truncated or failed snapshot looks like and a live
 * market with no resting orders on either side is the rarer explanation. A
 * one-sided empty is a different thing entirely -- see
 * `'no-depth-within-bound'`.
 */
 | 'book-empty'
/** A venue timestamp ahead of our clock beyond the skew allowance. */
 | 'book-clock-implausible'
/** Best bid at or above best ask -- crossed, or the two sides were swapped. */
 | 'book-crossed'
/**
 * A level's price is outside (0,1), or its size is negative or non-finite.
 *
 * A size of **zero is not invalid**: `price_change` publishes `size: "0"` to
 * delete a level, so a zero-size entry is a deletion a filler has not yet
 * garbage-collected. Those are dropped before the walk, and a ladder in which
 * every level is deleted is known-zero depth rather than unknown -- which is
 * what makes `no-depth-within-bound` reachable.
 */
 | 'book-level-invalid';
/** The outcome. Three states, because zero and unknown are different answers. */
export type PolymarketBookDepthOutcome = 
/** A ladder was read and priced. `depth` and `capacity` are populated. */
'assessed'
/**
 * The ladder is valid and fresh, and **genuinely holds nothing** inside the
 * bound. Known, and known to be zero. Not `unknown`: the operator action is
 * "this market is too thin to copy", not "go look at the feed".
 */
 | 'no-depth-within-bound'
/** No figure. One of `PolymarketBookUnknownCode` says why. */
 | 'unknown';
/** Ops-facing reason code, one per outcome plus one per unknown cause. */
export type PolymarketBookReasonCode = 'polymarket-book-depth-assessed' | 'polymarket-book-depth-empty-within-bound' | `polymarket-${PolymarketBookUnknownCode}`;
/** Which constraint stopped the walk. Both are ordinary, neither is an error. */
export type PolymarketBookCapacityBound = 
/** The average-impact ceiling bound first. */
'impact-cap'
/** The marginal price bound bound first: the next level is outside it. */
 | 'price-bound'
/** The visible ladder ran out first, so the figure is a lower bound on depth. */
 | 'book-exhausted';
/**
 * Structurally assignable to `UsableLiquidity` in `packages/db/src/master-capacity.ts`.
 *
 * It is a mirror rather than an import because `@swat/db` depends on
 * `@swat/shared` and not the other way round, so the type cannot be imported
 * here without a cycle. The `basis` literals are deliberately narrowed to the two
 * members of `UsableLiquidityBasis` this module can produce -- `'order-book-depth'`
 * already exists there and is documented as "resting size within a price bound
 * ... accepted here so that wiring a pre-fan-out book read later needs no change
 * to this module", so **no new basis value is required**.
 *
 * The extra `calibratedForImpactCapBps` field is not part of `UsableLiquidity`;
 * excess properties are fine across an assignment, and it is what makes a
 * cap mismatch detectable rather than silent.
 */
export interface PolymarketBookUsableLiquidity {
    readonly chain: Chain;
    /** Chain-prefixed, per the repo-wide address invariant: `polygon:<tokenId>`. */
    readonly tokenMint: string;
    /**
     * The **calibrated equivalent one-sided reserve**, not the depth. `null`
     * whenever the basis is `'unknown'`, and never coerced to 0.
     *
     * See the module header: this is `capacityNotionalUsd * 10_000 / impactCapBps`,
     * chosen so `priceImpactBps(N, this) <= impactCapBps` exactly when the cohort
     * notional `N` fits the real book walk. The raw depth is in `note`.
     */
    readonly usableLiquidityUsd: number | null;
    readonly basis: 'order-book-depth' | 'unknown';
    readonly approximate: boolean;
    readonly note: string;
    /**
     * The cap the reserve was calibrated against. `null` when unknown. A consumer
     * that overrides `maxAggregateImpactBps` must compare it -- see
     * `assertPolymarketBookLiquidityCalibration`.
     */
    readonly calibratedForImpactCapBps: number | null;
}
/** What the bounded ladder holds. Populated only on `'assessed'`. */
export interface PolymarketBookDepth {
    /**
     * Cumulative USD notional resting **within the bound**, on the side the cohort
     * consumes. The name carries the bound on purpose: there is no total-depth
     * figure anywhere in this module, and `boundBps` has no permissive default.
     */
    readonly notionalWithinBoundUsd: number;
    /** Cumulative shares behind that notional. */
    readonly sharesWithinBound: number;
    /** Best price on the consumed side. */
    readonly bestPrice: number;
    /** Worst price counted, i.e. the last level inside the bound. */
    readonly worstPriceWithinBound: number;
    readonly levelsWithinBound: number;
    /** True when every visible level qualified, so real depth may be greater. */
    readonly ladderExhausted: boolean;
}
/** The cohort capacity the cap actually permits. Populated only on `'assessed'`. */
export interface PolymarketBookCapacity {
    readonly impactCapBps: number;
    /**
     * Largest cohort notional whose walked **average** execution impact stays
     * within `impactCapBps` and which touches no level outside `boundBps`.
     */
    readonly capacityNotionalUsd: number;
    readonly capacityShares: number;
    /** Average execution impact of exactly `capacityNotionalUsd`, in bps. */
    readonly capacityImpactBps: number;
    readonly boundedBy: PolymarketBookCapacityBound;
    /**
     * `capacityNotionalUsd * 10_000 / impactCapBps`. Published as
     * `usableLiquidityUsd`; see the module header for why this is the sound way to
     * reach `S4-M6` and why the raw depth is not.
     */
    readonly equivalentReserveUsd: number;
}
export interface PolymarketBookDepthVerdict {
    readonly outcome: PolymarketBookDepthOutcome;
    readonly reasonCode: PolymarketBookReasonCode;
    /** `null` unless `outcome === 'unknown'`. */
    readonly unknownCode: PolymarketBookUnknownCode | null;
    /**
     * What this verdict says **nothing** about. Empty is the only thing that means
     * "fully assessed", which is why `polymarketBookDepthFullyAssessed` tests it --
     * the same discipline as `pusd-liquidity.ts`.
     */
    readonly unassessed: readonly PolymarketBookUnknownCode[];
    /** Chain-prefixed, as the rest of the repo stores it. */
    readonly tokenMint: string;
    /** The direction the *cohort* trades, which picks the side consumed. */
    readonly cohortDirection: 'buy' | 'sell';
    readonly boundBps: number;
    /** Age of the entry on our clock. `null` when there was no entry. */
    readonly ageMs: number | null;
    readonly depth: PolymarketBookDepth | null;
    readonly capacity: PolymarketBookCapacity | null;
    /** Always present, and `basis: 'unknown'` unless `outcome === 'assessed'`. */
    readonly liquidity: PolymarketBookUsableLiquidity;
    /** Ops-facing detail. Carries figures, so it is never rendered to a user. */
    readonly detail: string;
}
/**
 * Average execution impact, in bps, of pushing `notionalUsd` through this ladder.
 *
 * **This is the book's own impact model, and it exists because
 * `priceImpactBps` cannot serve.** No reserve, no ratio: it walks the levels and
 * compares the achieved average price against the best price, which is the same
 * quantity `priceImpactBps` computes for an AMM (average execution price over
 * spot) obtained the only way a book allows.
 *
 * Returns `null` when the ladder cannot absorb `notionalUsd` at all -- an
 * unfillable size has no average price, and returning a large number instead
 * would be a fabricated figure.
 */
export declare function polymarketBookAverageImpactBps(input: {
    readonly ladders: PolymarketBookLadders;
    readonly cohortDirection: 'buy' | 'sell';
    readonly notionalUsd: number;
}): number | null;
export interface PolymarketBookDepthRequest {
    /**
     * The outcome token. Accepts the repo-wide `polygon:<tokenId>` form or the bare
     * CLOB `asset_id`; the cache is keyed on the bare id and the prefix is applied
     * to the reported `tokenMint`, so neither side has to remember which it holds.
     * A prefix from another chain throws -- a Solana mint reaching the Polymarket
     * book cache is a routing bug, not a market condition.
     */
    readonly tokenMint: string;
    /** The direction the cohort trades. Required: it selects the side consumed. */
    readonly cohortDirection: 'buy' | 'sell';
    /**
     * The aggregate-impact ceiling this figure will be judged against -- on the
     * wired path, `PLATFORM_MAX_AGGREGATE_IMPACT_BPS[chain]` for polygon.
     *
     * **Required, with no default.** The published reserve is calibrated to it, so
     * a default would let the calibration and the cap drift apart invisibly, which
     * is the one way this module can lie.
     */
    readonly impactCapBps: number;
    /** Marginal price bound. Defaults to `POLYMARKET_BOOK_DEFAULT_BOUND_BPS`. */
    readonly boundBps?: number;
    /** Injected. This module never reads a clock. */
    readonly now: number;
    /** Defaults to `POLYMARKET_BOOK_MAX_AGE_MS`. */
    readonly maxAgeMs?: number;
}
/**
 * Read cached book depth for one outcome token and turn it into a capacity
 * figure, or into an honest unknown.
 *
 * Returns a verdict rather than throwing, in the same shape as the mirror-bound
 * and staleness skips (`S4-M16`, `S4-M18`), so a caller can record a stable code
 * beside the skip. Only a caller-side mistake throws.
 */
export declare function assessPolymarketBookDepth(cache: PolymarketBookCache, request: PolymarketBookDepthRequest): PolymarketBookDepthVerdict;
/**
 * True only for a complete read.
 *
 * The single predicate callers should use, so `no-depth-within-bound` cannot be
 * waved through by testing `outcome !== 'unknown'` -- the same reason
 * `pusdWithdrawalsHealthy` exists rather than a negated check.
 */
export declare function polymarketBookDepthFullyAssessed(verdict: PolymarketBookDepthVerdict): boolean;
/**
 * Throws when a liquidity value is used against a cap it was not calibrated for.
 *
 * The calibration is exact only for the cap it was built with, so a caller that
 * overrides `maxAggregateImpactBps` must re-read the cache with the same value
 * rather than reuse this figure. This turns that mistake from a silently wrong
 * admission into a loud failure.
 */
export declare function assertPolymarketBookLiquidityCalibration(liquidity: PolymarketBookUsableLiquidity, impactCapBps: number): void;
//# sourceMappingURL=polymarket-book-depth.d.ts.map