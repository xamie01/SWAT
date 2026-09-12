import { UnrecoverableError } from 'bullmq';

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
export const POLYMARKET_MIRROR_DEFAULT_TOLERANCE_BPS = 150;

export type PolymarketMirrorSkipCode =
  /** The mirror path ran without the master's fill price. Fails closed. */
  | 'master-fill-price-unavailable'
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

export type PolymarketMirrorBoundDecision =
  | PolymarketMirrorBoundSubmit
  | PolymarketMirrorBoundSkip;

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

const TOLERANCE_EPSILON = 1e-9;

function ticksPerUnit(tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0 || tickSize >= 1) {
    throw new UnrecoverableError(`Polymarket tick size ${tickSize} is not a valid price increment`);
  }
  const reciprocal = 1 / tickSize;
  const rounded = Math.round(reciprocal);
  // Every documented increment (0.1, 0.01, 0.005, 0.0025, 0.001, 0.0001) divides
  // 1 exactly. An increment that does not means the grid is not the one this
  // module knows how to land on, so it refuses rather than guessing.
  if (rounded < 1 || Math.abs(reciprocal - rounded) > 1e-6) {
    throw new UnrecoverableError(`Polymarket tick size ${tickSize} does not divide the price range`);
  }
  return rounded;
}

/** Largest grid price at or below `price`. */
export function floorToPolymarketTick(price: number, tickSize: number): number {
  const scale = ticksPerUnit(tickSize);
  return Math.floor(price * scale + 1e-6) / scale;
}

/** Smallest grid price at or above `price`. */
export function ceilToPolymarketTick(price: number, tickSize: number): number {
  const scale = ticksPerUnit(tickSize);
  return Math.ceil(price * scale - 1e-6) / scale;
}

function resolveToleranceBps(value: number | undefined): number {
  const toleranceBps = value ?? POLYMARKET_MIRROR_DEFAULT_TOLERANCE_BPS;
  // A misconfigured tolerance is an operator error, not a market condition.
  // Returning a skip would silently disable mirroring for every trade, so this
  // raises instead.
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0 || toleranceBps > 5_000) {
    throw new UnrecoverableError(
      'POLYMARKET_MIRROR_TOLERANCE_BPS must be an integer from 0 to 5000'
    );
  }
  return toleranceBps;
}

export function planPolymarketMirrorBound(
  input: PolymarketMirrorBoundInput
): PolymarketMirrorBoundDecision {
  const toleranceBps = resolveToleranceBps(input.toleranceBps);

  if (input.masterFillPrice === null || input.masterFillPrice === undefined) {
    return {
      kind: 'skip',
      code: 'master-fill-price-unavailable',
      reason: 'the price the tracked wallet filled at is not recorded, so this copy has no reference price to bound against'
    };
  }
  const masterFillPrice = input.masterFillPrice;
  if (!Number.isFinite(masterFillPrice) || masterFillPrice <= 0 || masterFillPrice >= 1) {
    return {
      kind: 'skip',
      code: 'master-fill-price-invalid',
      reason: `the tracked wallet's recorded fill price ${masterFillPrice} is not a valid outcome price between 0 and 1`
    };
  }
  if (!Number.isFinite(input.bookLimitPrice) || input.bookLimitPrice <= 0 || input.bookLimitPrice >= 1) {
    throw new UnrecoverableError(
      `Polymarket book limit price ${input.bookLimitPrice} is not a valid outcome price`
    );
  }
  // Caller contract, not a market condition: `planPolymarketBookOrder` already
  // refuses a book whose levels are off the grid, so an off-grid level here means
  // the bound was derived from something other than a validated book walk. Stated
  // as a precondition because the grid arithmetic below relies on it — with an
  // on-grid book level, a floored BUY ceiling can never land under the level the
  // order must reach, which is what makes that branch unnecessary rather than
  // untested.
  if (
    Math.abs(input.bookLimitPrice - floorToPolymarketTick(input.bookLimitPrice, input.tickSize))
    > TOLERANCE_EPSILON
  ) {
    throw new UnrecoverableError(
      `Polymarket book limit price ${input.bookLimitPrice} is off the ${input.tickSize} tick grid`
    );
  }
  if (!Number.isFinite(input.shares) || input.shares <= 0) {
    throw new UnrecoverableError('Polymarket mirror share quantity must be positive');
  }
  if (!Number.isFinite(input.minimumShares) || input.minimumShares <= 0) {
    throw new UnrecoverableError('Polymarket minimum order size must be positive');
  }

  // Checked before the price work so a sub-minimum order reports the reason the
  // user can act on (raise the per-trade size) rather than a price complaint.
  if (input.shares + 1e-9 < input.minimumShares) {
    return {
      kind: 'skip',
      code: 'below-venue-minimum-order-size',
      reason: `this copy comes to ${input.shares} shares, below Polymarket's ${input.minimumShares}-share minimum for this market; a larger per-trade size would clear it`
    };
  }

  const toleranceFactor = toleranceBps / 10_000;
  const tolerated = input.direction === 'buy'
    ? masterFillPrice * (1 + toleranceFactor)
    : masterFillPrice * (1 - toleranceFactor);

  // Grid selection, always in the direction that cannot loosen the bound: a BUY
  // ceiling floors down, a SELL floor ceilings up. Neither can pay a worse price
  // than the tolerance the user was quoted.
  const boundPrice = input.direction === 'buy'
    ? floorToPolymarketTick(tolerated, input.tickSize)
    : ceilToPolymarketTick(tolerated, input.tickSize);

  // The market's grid cannot express a mirror of this fill at all — the whole
  // tolerance window falls between 0 and the first grid line, or above the last.
  // Checked before the book comparison because it is a property of the market and
  // the master's fill, true no matter where the book sits, and the operator's fix
  // is different: widen the tolerance, not wait for the book.
  if (boundPrice <= 0 || boundPrice >= 1) {
    return {
      kind: 'skip',
      code: 'no-tick-inside-mirror-tolerance',
      reason: `no price on this market's ${input.tickSize} tick grid sits inside the ${toleranceBps} bps mirror tolerance around ${masterFillPrice}; rounding to the grid would change the price you pay`
    };
  }

  // The book has run away from the bound we are willing to sign. This is the case
  // a resting order would "solve" by waiting, which is the failure the FAK
  // decision exists to prevent, so it is a skip rather than a queued order.
  if (input.direction === 'buy' && input.bookLimitPrice > boundPrice + TOLERANCE_EPSILON) {
    return {
      kind: 'skip',
      code: 'book-moved-past-master-fill',
      reason: `the cheapest available price ${input.bookLimitPrice} is above the ${toleranceBps} bps mirror tolerance around the tracked wallet's fill at ${masterFillPrice}`
    };
  }
  if (input.direction === 'sell' && input.bookLimitPrice < boundPrice - TOLERANCE_EPSILON) {
    return {
      kind: 'skip',
      code: 'book-moved-past-master-fill',
      reason: `the best available price ${input.bookLimitPrice} is below the ${toleranceBps} bps mirror tolerance around the tracked wallet's fill at ${masterFillPrice}`
    };
  }

  const trackingBps = input.direction === 'buy'
    ? ((boundPrice / masterFillPrice) - 1) * 10_000
    : (1 - (boundPrice / masterFillPrice)) * 10_000;

  return { kind: 'submit', boundPrice, masterFillPrice, toleranceBps, trackingBps };
}

/**
 * Read the mirror tolerance from the environment.
 *
 * Separate from `planPolymarketMirrorBound` so the planner stays pure and a
 * per-user tolerance can be threaded through the same parameter later.
 */
export function resolvePolymarketMirrorToleranceBps(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.POLYMARKET_MIRROR_TOLERANCE_BPS?.trim();
  if (!raw) return POLYMARKET_MIRROR_DEFAULT_TOLERANCE_BPS;
  return resolveToleranceBps(Number(raw));
}
