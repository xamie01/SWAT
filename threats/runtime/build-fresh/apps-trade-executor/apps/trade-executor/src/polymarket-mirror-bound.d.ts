/**
 * The protective price bound a Polymarket mirror submits, derived from the
 * master's fill rather than from our own order-book snapshot (checklist
 * `S4-M16`).
 *
 * **Why the bound cannot come from the book.** `planPolymarketBookOrder` already
 * walks the book and produces `limitPrice` — the worst level our size has to
 * reach. Submitting that as `maxPrice` bounds the order against *our snapshot*,
 * which is the wrong reference twice over:
 *
 *   * It is stale. The book we walked is up to `POLYMARKET_MAX_BOOK_AGE_MS` old,
 *     so a bound equal to the walked level turns any adverse tick between the
 *     walk and the submission into a no-fill — a missed mirror caused by our own
 *     latency rather than by the market.
 *   * It has no relationship to what the user was promised. A copy trade's
 *     premise is "you get what your master got, within a stated tolerance". A
 *     book-derived bound will happily pay 0.71 for an outcome the master bought
 *     at 0.42, because the book says 0.71 is available. That is chasing, and it
 *     is the single most expensive way to mirror.
 *
 * So the bound is `master fill × (1 ± tolerance)`, and the book walk keeps its
 * separate job of proving the depth exists.
 *
 * **Why FAK and not a resting order.** A resting order is not mirroring: it
 * converts "buy what he bought" into "maybe buy it later, at a price nobody
 * sanctioned". Worse, on a market heading to resolution a late fill is exactly
 * the stale-signal failure `S4-P15` rejected queuing for — the order fills
 * precisely when the outcome is no longer uncertain. `OrderType.FAK` takes the
 * liquidity that exists now and cancels the remainder, which is verified in the
 * live docs (`trading/place-orders` → *Market Order Types*) as
 * "fills against the available liquidity immediately and cancels any unfilled
 * remainder", with `maxPrice` documented as preventing "a BUY from crossing a
 * higher price" and `minPrice` the mirror of that for a SELL.
 *
 * **Why off-tick and sub-minimum skip instead of rounding.** Rounding a bound to
 * the grid in the loosening direction pays a price the user never agreed to, and
 * rounding a *size* up sells shares the position does not hold. The venue
 * contract (`trading/place-orders`, verified) is that `min_order_size` is a
 * minimum **share count** and that a price must be a multiple of the market's
 * current tick — so an order that cannot be expressed on that grid inside the
 * mirror tolerance is refused with a reason, never nudged until it fits.
 *
 * The one grid move this module *does* make is conservative by construction: a
 * BUY ceiling is floored to the grid and a SELL floor is raised to it, so the
 * selected bound is never looser than the tolerance the user was quoted. That is
 * a tightening, not a re-pricing.
 *
 * Pure and dependency-injected: every input is a parameter, so Stage 4 can pass
 * a per-user tolerance with no call-site change (Standing Rule 2).
 */
/** Default mirror tolerance. Deliberately tighter than the 200 bps book-walk slippage cap. */
export declare const POLYMARKET_MIRROR_DEFAULT_TOLERANCE_BPS = 150;
export type PolymarketMirrorSkipCode = 
/** The mirror path ran without the master's fill price. Fails closed. */
'master-fill-price-unavailable'
/** A price outside (0,1) is not an outcome price, so no bound can be derived. */
 | 'master-fill-price-invalid'
/** The book has already moved past what the master's fill justifies paying. */
 | 'book-moved-past-master-fill'
/** No price on the market's tick grid sits inside the mirror tolerance. */
 | 'no-tick-inside-mirror-tolerance'
/** Below the venue's minimum share count after the documented downward rounding. */
 | 'below-venue-minimum-order-size';
export interface PolymarketMirrorBoundSubmit {
    readonly kind: 'submit';
    /** `maxPrice` for a BUY, `minPrice` for a SELL. Always on the tick grid. */
    readonly boundPrice: number;
    readonly masterFillPrice: number;
    readonly toleranceBps: number;
    /**
     * Signed distance from the master's fill to our bound, in basis points, and
     * positive when the bound is worse for the user than the master's fill. This
     * is the pre-trade half of the tracking difference `S4-M23` surfaces.
     */
    readonly trackingBps: number;
}
export interface PolymarketMirrorBoundSkip {
    readonly kind: 'skip';
    readonly code: PolymarketMirrorSkipCode;
    /** Operator- and user-readable, and specific enough to act on. */
    readonly reason: string;
}
export type PolymarketMirrorBoundDecision = PolymarketMirrorBoundSubmit | PolymarketMirrorBoundSkip;
export interface PolymarketMirrorBoundInput {
    readonly direction: 'buy' | 'sell';
    /** The master's realized price for the event being mirrored. */
    readonly masterFillPrice: number | null | undefined;
    /** Worst level the requested size must reach, from `planPolymarketBookOrder`. */
    readonly bookLimitPrice: number;
    /** The market's current tick size, as reported by the order book. */
    readonly tickSize: number;
    /** Share count after the venue's documented round-down. */
    readonly shares: number;
    /** `min_order_size` from the order book — a share count, not a notional. */
    readonly minimumShares: number;
    readonly toleranceBps?: number;
}
/** Largest grid price at or below `price`. */
export declare function floorToPolymarketTick(price: number, tickSize: number): number;
/** Smallest grid price at or above `price`. */
export declare function ceilToPolymarketTick(price: number, tickSize: number): number;
export declare function planPolymarketMirrorBound(input: PolymarketMirrorBoundInput): PolymarketMirrorBoundDecision;
/**
 * Read the mirror tolerance from the environment.
 *
 * Separate from `planPolymarketMirrorBound` so the planner stays pure and a
 * per-user tolerance can be threaded through the same parameter later.
 */
export declare function resolvePolymarketMirrorToleranceBps(env?: NodeJS.ProcessEnv): number;
//# sourceMappingURL=polymarket-mirror-bound.d.ts.map