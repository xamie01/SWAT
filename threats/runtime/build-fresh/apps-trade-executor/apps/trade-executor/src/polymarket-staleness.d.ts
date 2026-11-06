/**
 * Polymarket signal staleness, expressed as a fraction of the remaining
 * time-to-resolution rather than as a constant (checklist `S4-M18`).
 *
 * **Why a constant is the wrong shape here.** Every other venue in this repo is
 * a spot market, where a signal's information decays against price volatility
 * and nothing else — so a flat `SOURCE_COPY_MAX_EVENT_AGE_MS` (10 min default,
 * `index.ts`) is a defensible approximation. A prediction market has a second
 * clock the spot venues do not have: the market resolves, and as it approaches
 * resolution the price stops being a forecast and becomes a report. Six hours
 * late on a market resolving in two days has consumed 12.5% of the remaining
 * uncertainty; six hours late on a market resolving in eight hours has consumed
 * 75% of it, and the price we would pay has already absorbed most of what the
 * master was early to. One constant cannot separate those two cases, and the
 * constant that is right for the second is far too tight for the first.
 *
 * **The budget is a tightening, never a loosening.** `maxBudgetMs` keeps the
 * existing flat ceiling in force, and the fractional term can only reduce it.
 * That is deliberate and mirrors the one grid move `polymarket-mirror-bound.ts`
 * makes: a control added for safety must not become a licence to accept a signal
 * today's code would have refused. A long-dated market therefore behaves exactly
 * as it does now, and only near-resolution markets get stricter.
 *
 * **Why the floor exists.** As `msToResolution` falls, `fraction × msToResolution`
 * approaches zero, and a budget below our own irreducible submission latency
 * (book fetch, live market-state read, sign, post) rejects every signal it is
 * ever shown — including ones that would have filled. `minBudgetMs` defaults to
 * the order-book age allowance (`POLYMARKET_MAX_BOOK_AGE_MS`, 15 s default),
 * because a staleness budget tighter than that is self-contradictory: it would
 * refuse a signal younger than the order book we are about to trade against.
 *
 * **Verified venue facts this is built on** (live docs, 2026-08-20):
 *
 *   * `/concepts/resolution` → *Resolution Rules* defines a market's **end date**
 *     as "when the market is eligible for resolution". That makes `endDate` the
 *     correct denominator for time-to-resolution; it is the earliest moment the
 *     outcome can be locked in, not merely a display date.
 *   * `/api-reference/markets/get-market-by-id` types Gamma's `endDate` as
 *     `string<date-time> | null` and `endDateIso` as `string | null` — **both
 *     nullable**, and both present on the same market object. So a resolution
 *     time is not guaranteed and either field may be the one that carries it.
 *   * `/market-data/market-details` → *Market Timing* documents `secondsDelay` as
 *     "delay, in seconds, before a newly placed marketable order can match", and
 *     `/trading/place-orders` documents an order status of `delayed` for exactly
 *     that case. A market with a configured delay adds that much latency between
 *     our submission and any fill, so it is charged against the budget as
 *     `matchingDelayMs` rather than ignored.
 *   * `gameStartTime` is documented as the "scheduled start time of the
 *     underlying game for a sports market" and is `string | null`. It is the
 *     start of the event, not its resolution, and is absent on every
 *     non-sports market — so it is **not** used as the denominator here.
 *
 * **What the docs do not say, and how that is handled.** Nothing in the docs
 * states what a null `endDate` means, and `umaEndDate` / `umaEndDateIso` appear
 * in every Gamma market schema with no prose describing them anywhere on the
 * site. Neither is guessed at: a market with no readable resolution time is
 * refused as `resolution-time-unknown`. Falling back to the flat ceiling would
 * reinstate precisely the behaviour this item replaces, and it would do so on
 * the markets where the risk is least measurable. This also agrees with the gate
 * next to it — `parsePolymarketMarketState` already throws on a missing end date,
 * so a Polymarket order cannot reach submission without one.
 *
 * Pure and dependency-injected throughout: `now` and every threshold is a
 * parameter, so a per-user policy needs no call-site change (Standing Rule 2).
 * Nothing here reads the clock or the environment on its own.
 */
/** Default share of the remaining time-to-resolution a signal may consume. */
export declare const POLYMARKET_DEFAULT_STALENESS_FRACTION = 0.05;
/**
 * Default floor on the budget. Matches the `POLYMARKET_MAX_BOOK_AGE_MS` default
 * in `polymarket.ts`; see the floor rationale above.
 */
export declare const POLYMARKET_DEFAULT_STALENESS_FLOOR_MS = 15000;
/**
 * Default ceiling on the budget. Matches the `SOURCE_COPY_MAX_EVENT_AGE_MS`
 * default in `index.ts` so this control starts out no looser than the flat rule
 * it refines.
 */
export declare const POLYMARKET_DEFAULT_STALENESS_CEILING_MS: number;
export type PolymarketStalenessCode = 
/** No readable resolution time, so the fraction has no denominator. Fails closed. */
'resolution-time-unknown'
/** Resolution is at or before `now`; there is no remaining uncertainty to trade. */
 | 'market-already-resolved'
/** A negative or non-finite age is not a measurement. Fails closed. */
 | 'signal-age-invalid'
/** Age exceeded the fractional budget — the near-resolution case this item adds. */
 | 'signal-age-exceeds-resolution-fraction'
/** Age exceeded the flat ceiling, which a long-dated market cannot relax. */
 | 'signal-age-exceeds-absolute-ceiling';
export interface PolymarketStalenessPolicy {
    /** Share of remaining time-to-resolution a signal may consume, in (0, 1]. */
    readonly maxResolutionFraction: number;
    /** Lower clamp on the derived budget. */
    readonly minBudgetMs: number;
    /** Upper clamp on the derived budget — the flat rule this refines. */
    readonly maxBudgetMs: number;
}
export declare const POLYMARKET_DEFAULT_STALENESS_POLICY: PolymarketStalenessPolicy;
export interface PolymarketStalenessInput {
    /** How old the source event is, in ms. Injected, never measured here. */
    readonly signalAgeMs: number;
    /** Remaining ms until the market is eligible for resolution, or null if unknown. */
    readonly msToResolution: number | null | undefined;
    /**
     * The market's configured matching delay in ms (`secondsDelay × 1000`). Charged
     * against the budget because an order cannot match until it elapses.
     */
    readonly matchingDelayMs?: number;
    readonly policy?: Partial<PolymarketStalenessPolicy>;
}
export interface PolymarketStalenessFresh {
    readonly kind: 'fresh';
    /** `signalAgeMs + matchingDelayMs` — the age at the earliest possible fill. */
    readonly effectiveAgeMs: number;
    readonly msToResolution: number;
    /** The clamped budget this decision was measured against. */
    readonly budgetMs: number;
    /** `effectiveAgeMs / msToResolution`, for observability and `S4-M23`. */
    readonly consumedFraction: number;
}
export interface PolymarketStalenessStale {
    readonly kind: 'stale';
    readonly code: PolymarketStalenessCode;
    /** Operator- and user-readable, and specific enough to act on. */
    readonly reason: string;
    readonly effectiveAgeMs: number | null;
    readonly msToResolution: number | null;
    readonly budgetMs: number | null;
    readonly consumedFraction: number | null;
}
export type PolymarketStalenessDecision = PolymarketStalenessFresh | PolymarketStalenessStale;
/**
 * Derive the staleness budget for a market resolving in `msToResolution`.
 *
 * Exported so an operator or a test can see the curve directly rather than
 * inferring it from accept/reject boundaries.
 */
export declare function polymarketStalenessBudgetMs(msToResolution: number, policy?: Partial<PolymarketStalenessPolicy>): number;
/**
 * Decide whether a Polymarket signal is still fresh enough to act on.
 *
 * Returns a decision rather than throwing so the caller can record a stable
 * reason code alongside the skip, in the same shape as the mirror-bound skips
 * (`S4-M16`). Only a misconfigured *policy* throws.
 */
export declare function evaluatePolymarketStaleness(input: PolymarketStalenessInput): PolymarketStalenessDecision;
/** Boolean convenience over `evaluatePolymarketStaleness` for predicate call sites. */
export declare function isPolymarketSignalStale(input: PolymarketStalenessInput): boolean;
/**
 * Build the decision from the timestamps a caller actually holds.
 *
 * `resolutionAt` is the market's end date — per `/concepts/resolution` the point
 * at which it becomes eligible for resolution. A null or unparseable value is
 * passed through as an unknown resolution time and fails closed above.
 */
export declare function evaluatePolymarketSignalStaleness(input: {
    readonly signalAt: Date | number;
    readonly resolutionAt: Date | number | null | undefined;
    readonly now: number;
    readonly matchingDelaySeconds?: number | null;
    readonly policy?: Partial<PolymarketStalenessPolicy>;
}): PolymarketStalenessDecision;
/**
 * Read the policy from the environment once, at the edge, so the pure functions
 * above stay parameterised. Intended for a module-scope constant in `index.ts`
 * exactly like `COPY_ELIGIBILITY_THRESHOLDS`.
 */
export declare function resolvePolymarketStalenessPolicy(env?: NodeJS.ProcessEnv): PolymarketStalenessPolicy;
//# sourceMappingURL=polymarket-staleness.d.ts.map