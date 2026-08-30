import type { QueryResultRow } from 'pg';
import type { Chain, CopyExecutionMode, CopyExecutionState, SourceTradeSide } from '@swat/shared';

/**
 * Tracking difference (`S4-M23`): what the user's fill cost against what the
 * master's fill cost, on the same trade.
 *
 * A copy is always entered *after* the master. That is structural, not a bug, and
 * it has a price: by the time the copy reaches the venue the book has moved, and it
 * has usually moved against the copier. This module computes that gap so the
 * product can state it, rather than letting it hide inside a P&L number where it
 * reads as the user's own bad luck.
 *
 * ## Which price is whose — get this backwards and the feature inverts
 *
 *   * **The master's fill** is `source_trades.price_usd` (migration `023`, nullable
 *     NUMERIC), surfaced as `CanonicalSourceTrade.priceUsd` in
 *     `copy-trade-lifecycle.ts`. That file's own comment on
 *     `getCanonicalSourceTradeById` is the authority: "`source_trades.price_usd` is
 *     the master's".
 *   * **Our fill** is `copy_execution_evidence.price_usd` (migration `028`, nullable
 *     NUMERIC, `CHECK (price_usd IS NULL OR price_usd >= 0)`), one row per fill,
 *     joined through `copy_execution_evidence.execution_id`.
 *
 * Throughout this module the two are named `master` and `user` and never merely
 * "price", precisely so a later edit cannot swap them without the swap being
 * visible at every call site.
 *
 * **Correction to the S4-M23 brief:** the brief names `copy_executions.price_usd`
 * as our fill. That column does not exist. `copy_executions` carries
 * `confirmed_base_quantity` and `confirmed_quote_quantity` (both NUMERIC NOT NULL
 * DEFAULT 0) and no price at all; the per-fill price lives on
 * `copy_execution_evidence`. See the note on quote quantity below for why the
 * quantities on `copy_executions` are *not* an acceptable substitute.
 *
 * ## Why `confirmed_quote_quantity / confirmed_base_quantity` is refused
 *
 * It looks like a free VWAP and it is still not used here.
 *
 * Until S4-M35 the reason was that the column was a mixed-unit lie: the executor
 * wrote `quoteQuantity` in whatever unit that venue settled in — USD from
 * Polymarket and from paper simulation, **SOL** from Solana live, **ETH** from
 * robinhood-chain live — and nothing in the schema recorded which. Dividing those
 * sums would have produced a SOL-per-token figure published as a USD tracking
 * difference.
 *
 * Migration `054` fixed that at the source: `quote_quantity` is now USD on every
 * row written from that point, with the native amount, its currency and the
 * conversion rate preserved beside it (`packages/db/src/quote-valuation.ts`). Two
 * reasons the ratio is still refused:
 *
 *   1. **Rows written before `054`.** The migration recovers each legacy row's unit
 *      from (`evidence_type`, `chain`) and moves the amount into
 *      `quote_native_quantity`, but it cannot recover the *historical* SOL or ETH
 *      price, so those rows carry a NULL USD value. A sum across the boundary would
 *      silently omit them.
 *   2. **A ratio of sums is a VWAP, not a fill price.** This module compares the
 *      master's fill against ours fill-by-fill; collapsing several partials into one
 *      average is a different measurement, not a cheaper route to the same one.
 *
 * `price_usd` is per-fill and USD-denominated by the schema, so it remains the only
 * field used. The cost of that choice is stated honestly in
 * `TrackingDifferenceCode`. Note that S4-M35 also threaded a `priceUsd` through the
 * Solana-live and robinhood-live fill recorders, so `user-price-unknown` on those
 * paths now means the price feed was actually unavailable rather than that the
 * executor never passed one.
 *
 * ## Fees are NOT included, and cannot be
 *
 * `fee_usd` exists on `trades` only (migration `031`). `source_trades` has no fee
 * column of any kind, so the master's fee is not recorded anywhere and a
 * net-of-fees comparison is impossible today. Every result therefore carries
 * `feeBasis: 'gross-excludes-fees'` — a field rather than a comment, so a caller
 * cannot render this number as a net figure without ignoring something it was
 * handed. See `TRACKING_DIFFERENCE_FEE_GAP` for the entry this needs in the
 * schema before that changes.
 *
 * ## Structure
 *
 * `computeTrackingDifference` and `summarizeTrackingDifferences` are **pure**: no
 * database, no clock, no network, no `Date.now()`. Every timestamp arrives as an
 * argument. The DB half at the bottom of the file is a single read that takes its
 * query executor as a parameter, so it does not import `./client.js` and neither
 * half needs Postgres to be tested.
 *
 * Reused from `pnl-math.ts` rather than reimplemented: its **ratio-not-amounts**
 * convention (`markToMarketPnl` divides prices instead of tracking token amounts,
 * "so it is robust to decimals/rounding") and its **null-not-zero** convention (it
 * "Returns null when the inputs can't produce a meaningful number"). Its
 * average-cost aggregation in `calculateAverageCostPnl` is *not* reused, because a
 * tracking difference compares two fills of one trade at a point in time and never
 * walks a position ledger; borrowing the ledger walk would have imported a
 * chronological cost basis this question does not have.
 */

/**
 * The one basis-point convention for this module.
 *
 * Exported so a caller converting a threshold does not re-type 10000 and land on
 * 1000 or 100000.
 */
export const BPS_PER_UNIT = 10_000;

/**
 * Every number this module produces is **gross of fees**, on both sides.
 *
 * Stated as data rather than prose because the value ships to the UI.
 */
export const TRACKING_DIFFERENCE_FEE_BASIS = 'gross-excludes-fees' as const;
export type TrackingDifferenceFeeBasis = typeof TRACKING_DIFFERENCE_FEE_BASIS;

/**
 * What the schema would need before a fee-inclusive tracking difference is
 * possible. Stated, deliberately not written — migration numbers are contended.
 */
export const TRACKING_DIFFERENCE_FEE_GAP =
  'source_trades has no fee column. trades.fee_usd (migration 031) records our fee '
  + 'only, and copy_execution_evidence has no fee column either, so neither side of '
  + 'a fee-inclusive comparison is fully available: the master fee is never observed '
  + 'and our fee is not on the canonical execution ledger. A net-of-fees tracking '
  + 'difference needs source_trades.fee_usd (nullable, since most venues do not '
  + 'expose the maker fee of a third-party wallet) plus '
  + 'copy_execution_evidence.fee_usd (nullable, per fill). Until both exist, '
  + 'reporting a net figure would be inventing the master fee.';

/**
 * Why a tracking difference is, or is not, a number.
 *
 * `'computed'` is the **only** code under which `adverseBps` is non-null. Every
 * other code is a refusal to compare, and each names a different cause because
 * each has a different fix — a missing master price is an indexer gap, a missing
 * user price is an executor that did not record one, and a side mismatch is a
 * copy-planner defect.
 */
/**
 * The two sides a fill price can exist for.
 *
 * Narrower than `SourceTradeSide` from `@swat/shared`, which is
 * `'buy' | 'sell' | 'transfer_in' | 'transfer_out'`. Migration `028` widened
 * `source_trades.direction` to admit all four
 * (`chk_source_trades_direction`), but left `copy_executions.direction` at
 * `CHECK (direction IN ('buy', 'sell'))`, so a master transfer can be stored and can
 * never be copied — `listSourceTradeSignalCandidates` filters
 * `source.direction IN ('buy', 'sell')` for exactly that reason.
 *
 * A transfer has no counterparty and no fill price, so it has no *worse* direction
 * either: `ADVERSE_SIGN` is keyed on this type rather than the wide one so there is
 * no sign to accidentally default to. A master transfer gets its own code instead.
 */
export type TradeableSide = Extract<SourceTradeSide, 'buy' | 'sell'>;

export type TrackingDifferenceCode =
  /** Both fills carry a positive USD price. `adverseBps` is a real number. */
  | 'computed'
  /**
   * The master's row is a transfer (`transfer_in` / `transfer_out`), not a trade.
   * It has no fill price and no counterparty, so there is no price to track. Checked
   * before the side comparison, because "the sides differ" would be a misleading
   * description of a row that is not a trade at all.
   */
  | 'master-side-not-tradeable'
  /**
   * Our execution copied the opposite side of the master's trade. Comparing a buy
   * price to a sell price produces a number with no meaning, so none is produced.
   * Structural, and checked before anything else: no price data rescues it.
   */
  | 'side-mismatch'
  /**
   * Nothing of ours filled — no confirmed or finalized evidence quantity. There is
   * no user fill to compare, which is different from having one at an unknown
   * price.
   */
  | 'no-user-fill'
  /** Neither side's USD price is known. Named separately so coverage reporting can
   * distinguish "the indexer is behind" from "the executor is silent". */
  | 'master-price-unknown'
  | 'user-price-unknown'
  | 'both-prices-unknown'
  /**
   * A price is present but not positive. A zero-USD fill is a data defect, not a
   * free trade, and it cannot be a ratio denominator. Kept apart from `unknown`
   * because the row *has* a value and somebody should look at it.
   */
  | 'master-price-not-positive'
  | 'user-price-not-positive';

/** Where the master's USD price came from, since two columns can supply it. */
export type MasterPriceBasis =
  /** `source_trades.price_usd` directly. */
  | 'source-price-usd'
  /**
   * `source_trades.amount_usd / source_trades.token_amount`, used only when
   * `price_usd` is NULL and both of those are present and positive. Consistent
   * with the ledger convention in `copy-trade-lifecycle.ts`, which treats
   * `amount_usd` as the authoritative USD notional and the price only as its
   * fallback (`COALESCE(event.amount_usd, event.token_amount * event.price_usd, 0)`).
   */
  | 'source-amount-over-quantity'
  /** No basis: neither column pair yields a price. */
  | 'unavailable';

/** The master's side of the comparison. Nulls are honest and expected. */
export interface MasterFill {
  /**
   * `source_trades.direction`, which admits transfers as well as trades — hence the
   * wide type here against the narrow one on `UserFill`.
   */
  readonly side: SourceTradeSide;
  /** `source_trades.price_usd`. NULL on robinhood-chain and non-stablecoin Solana routes. */
  readonly priceUsd: number | null;
  /** `source_trades.amount_usd`. Nullable on the same routes. */
  readonly amountUsd: number | null;
  /** `source_trades.token_amount` (NOT NULL in the schema, but validated here). */
  readonly quantity: number | null;
  /** `source_trades.event_at`. Observational only; never enters the difference. */
  readonly eventAt: Date | null;
}

/** Our side of the comparison, already aggregated over confirmed fills. */
export interface UserFill {
  /** `copy_executions.direction`, which the schema restricts to buy or sell. */
  readonly side: TradeableSide;
  /**
   * Base quantity across all confirmed or finalized evidence rows, priced or not.
   * Zero means nothing filled.
   */
  readonly filledQuantity: number;
  /**
   * The part of `filledQuantity` whose evidence row carried a
   * `copy_execution_evidence.price_usd`. May be less than `filledQuantity`; see
   * `pricedQuantityFraction` on the result.
   */
  readonly pricedQuantity: number;
  /**
   * Sum of `base_quantity * price_usd` over the priced rows. Divided by
   * `pricedQuantity` this is our quantity-weighted USD fill price.
   */
  readonly pricedNotionalUsd: number;
  /** Earliest confirmed `occurred_at`. Observational only. */
  readonly firstFillAt: Date | null;
}

export interface TrackingDifferenceInput {
  readonly master: MasterFill;
  readonly user: UserFill;
}

export interface TrackingDifference {
  readonly code: TrackingDifferenceCode;
  /** `true` if and only if `code === 'computed'`. Present so a caller can branch
   * without knowing the code set, and asserted in tests against every code. */
  readonly comparable: boolean;
  /** The side both fills agree on, or the master's when they do not. */
  readonly side: SourceTradeSide;
  readonly masterPriceUsd: number | null;
  readonly masterPriceBasis: MasterPriceBasis;
  /** Our quantity-weighted USD fill price over `pricedQuantity`. */
  readonly userPriceUsd: number | null;
  readonly userFilledQuantity: number;
  readonly userPricedQuantity: number;
  /**
   * `pricedQuantity / filledQuantity`, or `null` when nothing filled.
   *
   * Below 1 means part of our fill had no recorded USD price, so `userPriceUsd` is
   * the average of a *subset* of the fill and `adverseUsd` covers only that subset.
   */
  readonly pricedQuantityFraction: number | null;
  /**
   * **How much worse the user's fill was than the master's, in basis points of the
   * master's price. Positive is always worse for the user, on both sides.**
   *
   * `null` for every code other than `'computed'` — see the class comment on
   * `unknownTrackingDifference`. A value of `0` means the two fills were compared
   * and matched to the cent; it never means "not compared".
   */
  readonly adverseBps: number | null;
  /**
   * The same gap in dollars, over `userPricedQuantity`: extra dollars paid on a
   * buy, dollars of proceeds forgone on a sell. Positive is worse, on both sides.
   *
   * `null` when the quantity is unknown or nothing was priced. Never `0` as a
   * stand-in for unknown.
   */
  readonly adverseUsd: number | null;
  /**
   * `true` when `adverseUsd` covers less than the whole fill because part of it
   * had no recorded price. The dollar figure is then a floor, not the total.
   */
  readonly adverseUsdPartial: boolean;
  /** `adverseBps > 0`. `null` whenever `adverseBps` is. */
  readonly worseForUser: boolean | null;
  /**
   * `firstFillAt - eventAt` in milliseconds: how far behind the master we entered.
   *
   * Observational. It is the *cause* of a tracking difference, not a term in it,
   * and it is reported even when the difference itself is unknown — on the two
   * chains where prices are missing, the lag is often the only honest thing we can
   * show. Negative would mean our fill predates the master's event, which is a
   * clock or ordering defect and is passed through rather than clamped.
   */
  readonly entryLagMs: number | null;
  readonly feeBasis: TrackingDifferenceFeeBasis;
  /** One sentence for the surface, including the reason when there is no number. */
  readonly explanation: string;
}

/**
 * An input is not a coherent description of a fill.
 *
 * Separate from the `code` set on purpose, and the same split `position-cap.ts`
 * makes: a missing price is a *fact about the world* and gets a code, whereas a
 * negative quantity or a `NaN` price is a caller defect and must not be smoothed
 * into "unknown", where it would be indistinguishable from an honest gap and would
 * never be fixed.
 */
export class InvalidTrackingDifferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTrackingDifferenceError';
  }
}

/**
 * `+1` on a buy, `-1` on a sell — the whole of the sign convention.
 *
 * `adverse = SIGN[side] * (userPrice - masterPrice)`, so:
 *
 *   * **buy** — paying above the master is positive. User 0.42 against master
 *     0.40 gives `+1 * 0.02 = +0.02`: worse.
 *   * **sell** — receiving below the master is positive. User 0.38 against master
 *     0.40 gives `-1 * -0.02 = +0.02`: worse, by the same amount.
 *
 * This is the answer to "how do we keep the UI from rendering one side backwards":
 * a raw signed `userPrice - masterPrice` means *worse* on a buy and *better* on a
 * sell, so any surface showing it has to re-derive the side to know which way to
 * colour the number, and one of the two will eventually be wrong. Normalising here
 * means there is exactly one place that knows the sides differ, the field name says
 * which direction is bad (`adverse`, not `difference`), and a UI that renders
 * `adverseBps > 0` as red is correct on both sides without asking what the side was.
 *
 * Typed `Record<TradeableSide, ...>` so adding a tradeable side to the union fails
 * to compile here rather than defaulting to buy semantics. Transfers are excluded by
 * the type, not by a fallback — see `TradeableSide`.
 */
export const ADVERSE_SIGN: Readonly<Record<TradeableSide, 1 | -1>> = Object.freeze({
  buy: 1,
  sell: -1
});

/**
 * Comparison tolerance for the quantity checks, so a fill that divides to exactly
 * its own total in exact arithmetic is not called partial because float division
 * landed a hair under. Far below any tradeable quantity, so it cannot mask a real
 * shortfall.
 */
const QUANTITY_EPSILON = 1e-12;

/**
 * Whether a stored side is a trade at all. A narrowing guard rather than a
 * comparison so the compiler, not a comment, guarantees `ADVERSE_SIGN` is never
 * indexed with a transfer.
 */
export function isTradeableSide(side: SourceTradeSide): side is TradeableSide {
  return side === 'buy' || side === 'sell';
}

function assertOptionalPrice(name: string, value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) {
    throw new InvalidTrackingDifferenceError(`${name} must be a finite number or null, got ${value}`);
  }
  if (value < 0) {
    throw new InvalidTrackingDifferenceError(`${name} must be non-negative or null, got ${value}`);
  }
  return value;
}

function assertQuantity(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidTrackingDifferenceError(
      `${name} must be a non-negative finite number, got ${value}`
    );
  }
  return value;
}

/**
 * Milliseconds between the master's event and our first fill, or `null`.
 *
 * Pure: both instants are arguments, so there is no clock in this module.
 */
export function entryLagMs(masterEventAt: Date | null, userFirstFillAt: Date | null): number | null {
  if (masterEventAt === null || userFirstFillAt === null) return null;
  const master = masterEventAt.getTime();
  const user = userFirstFillAt.getTime();
  if (!Number.isFinite(master) || !Number.isFinite(user)) return null;
  return user - master;
}

/**
 * The master's USD fill price and where it came from.
 *
 * Exported because the UI shows the benchmark price next to the gap, and a second
 * derivation in the frontend would drift on the `amount_usd` fallback.
 */
export function resolveMasterPriceUsd(
  master: MasterFill
): { readonly priceUsd: number | null; readonly basis: MasterPriceBasis } {
  const priceUsd = assertOptionalPrice('master.priceUsd', master.priceUsd);
  if (priceUsd !== null) return { priceUsd, basis: 'source-price-usd' };

  const amountUsd = assertOptionalPrice('master.amountUsd', master.amountUsd);
  const quantity = master.quantity === null ? null : assertQuantity('master.quantity', master.quantity);
  if (amountUsd !== null && amountUsd > 0 && quantity !== null && quantity > 0) {
    return { priceUsd: amountUsd / quantity, basis: 'source-amount-over-quantity' };
  }
  return { priceUsd: null, basis: 'unavailable' };
}

/**
 * Our quantity-weighted USD fill price over the priced part of the fill, or `null`
 * when no part of it carried a price.
 */
export function resolveUserPriceUsd(user: UserFill): number | null {
  const pricedQuantity = assertQuantity('user.pricedQuantity', user.pricedQuantity);
  const pricedNotionalUsd = assertQuantity('user.pricedNotionalUsd', user.pricedNotionalUsd);
  if (pricedQuantity <= 0) return null;
  return pricedNotionalUsd / pricedQuantity;
}

/**
 * The single construction site for "we did not compare".
 *
 * **This is the mechanism that keeps unknown out of zero.** Every numeric output
 * is hard-coded `null` here and there is no parameter that could make one of them
 * `0`; the only code path that can put a number in `adverseBps` is the tail of
 * `computeTrackingDifference`, which is reached only after both prices are known to
 * be positive. So a caller seeing `adverseBps === 0` knows two prices were compared
 * and matched, and a caller seeing `null` knows nothing was compared and can read
 * `code` for why. Reporting an unmeasured gap as `0` would tell a user on
 * robinhood-chain — where the master price is NULL on every row — that they matched
 * the master exactly, which is the single most damaging lie this feature could
 * tell, and it is the common case rather than an edge case.
 */
function unknownTrackingDifference(
  code: Exclude<TrackingDifferenceCode, 'computed'>,
  parts: {
    readonly side: SourceTradeSide;
    readonly masterPriceUsd: number | null;
    readonly masterPriceBasis: MasterPriceBasis;
    readonly userPriceUsd: number | null;
    readonly userFilledQuantity: number;
    readonly userPricedQuantity: number;
    readonly pricedQuantityFraction: number | null;
    readonly entryLagMs: number | null;
    readonly explanation: string;
  }
): TrackingDifference {
  return {
    code,
    comparable: false,
    side: parts.side,
    masterPriceUsd: parts.masterPriceUsd,
    masterPriceBasis: parts.masterPriceBasis,
    userPriceUsd: parts.userPriceUsd,
    userFilledQuantity: parts.userFilledQuantity,
    userPricedQuantity: parts.userPricedQuantity,
    pricedQuantityFraction: parts.pricedQuantityFraction,
    adverseBps: null,
    adverseUsd: null,
    adverseUsdPartial: false,
    worseForUser: null,
    entryLagMs: parts.entryLagMs,
    feeBasis: TRACKING_DIFFERENCE_FEE_BASIS,
    explanation: parts.explanation
  };
}

/**
 * The tracking difference for one copied trade.
 *
 * Fails **loud** on an incoherent input (`InvalidTrackingDifferenceError`) and
 * **closed** on a missing one: an absent price yields a code and null numbers, never
 * a zero. Pure — no database, no clock.
 *
 * Check order, which is the precedence when more than one thing is wrong:
 *
 *   1. master side is not a trade (a transfer) — there is no such thing as a fill
 *      price for it, so nothing downstream applies
 *   2. side mismatch — structural, no price data rescues it
 *   3. no user fill — nothing happened, so there is nothing to price
 *   4. missing prices — both, then master, then user
 *   5. non-positive prices — master, then user
 *   6. computed
 */
export function computeTrackingDifference(input: TrackingDifferenceInput): TrackingDifference {
  const { master, user } = input;
  const filledQuantity = assertQuantity('user.filledQuantity', user.filledQuantity);
  const pricedQuantity = assertQuantity('user.pricedQuantity', user.pricedQuantity);
  if (pricedQuantity > filledQuantity + QUANTITY_EPSILON) {
    throw new InvalidTrackingDifferenceError(
      `user.pricedQuantity (${pricedQuantity}) cannot exceed user.filledQuantity (${filledQuantity})`
    );
  }

  const lagMs = entryLagMs(master.eventAt, user.firstFillAt);
  const resolvedMaster = resolveMasterPriceUsd(master);
  const resolvedUserPrice = resolveUserPriceUsd(user);
  const pricedQuantityFraction = filledQuantity > 0 ? pricedQuantity / filledQuantity : null;

  const shared = {
    masterPriceUsd: resolvedMaster.priceUsd,
    masterPriceBasis: resolvedMaster.basis,
    userPriceUsd: resolvedUserPrice,
    userFilledQuantity: filledQuantity,
    userPricedQuantity: pricedQuantity,
    entryLagMs: lagMs,
    pricedQuantityFraction
  };

  if (!isTradeableSide(master.side)) {
    return unknownTrackingDifference('master-side-not-tradeable', {
      ...shared,
      side: master.side,
      explanation:
        `Not compared: the master's row is a ${master.side}, not a trade. A transfer `
        + 'has no fill price and no counterparty, so there is no price to track '
        + 'against.'
    });
  }

  if (master.side !== user.side) {
    return unknownTrackingDifference('side-mismatch', {
      ...shared,
      side: master.side,
      explanation:
        `Not compared: the master ${master.side} was copied as a ${user.side}. A buy `
        + 'price against a sell price is not a tracking difference, so none is shown. '
        + 'This is a copy-planner defect, not missing data.'
    });
  }
  const side: TradeableSide = master.side;

  if (filledQuantity <= 0) {
    return unknownTrackingDifference('no-user-fill', {
      ...shared,
      side,
      explanation:
        'Not compared: none of this copy filled, so there is no fill of ours to '
        + 'compare against the master. Different from a fill at an unknown price.'
    });
  }

  const masterMissing = resolvedMaster.priceUsd === null;
  const userMissing = resolvedUserPrice === null;
  if (masterMissing && userMissing) {
    return unknownTrackingDifference('both-prices-unknown', {
      ...shared,
      side,
      explanation:
        'Not compared: no USD price is recorded for either fill. Shown as unknown, '
        + 'not as zero — nothing was compared, so nothing matched.'
    });
  }
  if (masterMissing) {
    return unknownTrackingDifference('master-price-unknown', {
      ...shared,
      side,
      explanation:
        'Not compared: the master trade has no USD price recorded '
        + '(source_trades.price_usd and amount_usd are both absent). Usual on '
        + 'robinhood-chain and on Solana routes that do not pass through a '
        + 'stablecoin. Shown as unknown, not as zero.'
    });
  }
  if (userMissing) {
    return unknownTrackingDifference('user-price-unknown', {
      ...shared,
      side,
      explanation:
        'Not compared: this copy filled, but no fill recorded a USD price '
        + '(copy_execution_evidence.price_usd is absent on every confirmed fill). '
        + 'Shown as unknown, not as zero.'
    });
  }

  const masterPriceUsd = resolvedMaster.priceUsd as number;
  const userPriceUsd = resolvedUserPrice as number;

  if (masterPriceUsd <= 0) {
    return unknownTrackingDifference('master-price-not-positive', {
      ...shared,
      side,
      explanation:
        `Not compared: the master's recorded fill price is ${masterPriceUsd}, which `
        + 'cannot be a benchmark or a ratio denominator. A zero-USD fill is a data '
        + 'defect rather than a free trade.'
    });
  }
  if (userPriceUsd <= 0) {
    return unknownTrackingDifference('user-price-not-positive', {
      ...shared,
      side,
      explanation:
        `Not compared: our recorded fill price is ${userPriceUsd}, which is a data `
        + 'defect rather than a free fill.'
    });
  }

  // Ratio against the MASTER's price, not the user's and not a midpoint: the
  // master's fill is the benchmark the product promises to track, so the reference
  // has to be theirs. Using the user's price as the denominator would make the same
  // 2-cent gap read as a different percentage depending on which side of it you
  // landed, and the two would not reconcile across a book.
  //
  // Following pnl-math.ts markToMarketPnl, this is a price ratio rather than an
  // arithmetic difference of notionals, so it is robust to decimals and rounding.
  const adverseBps = (ADVERSE_SIGN[side] * (userPriceUsd - masterPriceUsd) / masterPriceUsd)
    * BPS_PER_UNIT;
  const adverseUsd = pricedQuantity > 0
    ? ADVERSE_SIGN[side] * (userPriceUsd - masterPriceUsd) * pricedQuantity
    : null;
  const adverseUsdPartial = adverseUsd !== null
    && pricedQuantity + QUANTITY_EPSILON < filledQuantity;

  const worseForUser = adverseBps > 0;
  const magnitude = Math.abs(adverseBps);
  const verb = side === 'buy' ? 'paid' : 'received';
  const comparative = worseForUser
    ? (side === 'buy' ? 'more than' : 'less than')
    : (side === 'buy' ? 'less than' : 'more than');
  const explanation = magnitude === 0
    ? `Matched the master's ${side} price of $${masterPriceUsd} exactly `
      + '(gross of fees, which are not recorded for the master).'
    : `You ${verb} $${userPriceUsd} against the master's $${masterPriceUsd} — `
      + `${magnitude.toFixed(1)} bps ${comparative} the master`
      + `${worseForUser ? '' : ', in your favour'}`
      + (adverseUsd === null
        ? '.'
        : `, ${adverseUsd >= 0 ? 'costing' : 'gaining'} $${Math.abs(adverseUsd)}`
          + `${adverseUsdPartial ? ' on the priced part of the fill' : ''}.`)
      + ' Gross of fees: the master\'s fee is not recorded anywhere, so no '
      + 'net-of-fees comparison is possible.';

  return {
    code: 'computed',
    comparable: true,
    side,
    masterPriceUsd,
    masterPriceBasis: resolvedMaster.basis,
    userPriceUsd,
    userFilledQuantity: filledQuantity,
    userPricedQuantity: pricedQuantity,
    pricedQuantityFraction,
    adverseBps,
    adverseUsd,
    adverseUsdPartial,
    worseForUser,
    entryLagMs: lagMs,
    feeBasis: TRACKING_DIFFERENCE_FEE_BASIS,
    explanation
  };
}

/**
 * What a set of tracking differences says, and — as importantly — what it does not.
 *
 * Modelled on `PositionCapAssessment.unassessed` in `position-cap.ts`: the counts
 * of what could not be compared travel with the counts of what could, so an empty
 * or flattering set of numbers cannot be read as "we checked every trade and the
 * user is tracking the master". Two of three chains supply no master price at all,
 * so on most accounts `uncomparedCount` will exceed `comparedCount`, and a summary
 * that hid that would be describing a sample it never disclosed.
 */
export interface TrackingDifferenceSummary {
  readonly total: number;
  readonly comparedCount: number;
  /** `total - comparedCount`. Never folded into a zero difference. */
  readonly uncomparedCount: number;
  /** Which refusals, and how many of each, so the gap is attributable. */
  readonly uncomparedByCode: Readonly<Partial<Record<TrackingDifferenceCode, number>>>;
  readonly worseForUserCount: number;
  readonly betterForUserCount: number;
  /**
   * Trades whose two prices were compared and came out identical. This is the
   * **only** field in this module that means "zero difference", and it counts
   * comparisons, so it can never absorb an uncompared trade.
   */
  readonly matchedCount: number;
  /**
   * Median adverse bps over the compared trades, `null` when none were compared.
   *
   * Median rather than mean is the headline because the distribution is skewed: one
   * copy into a thin book at 900 bps drags a mean far above what a user typically
   * experiences. The mean is provided alongside rather than instead, since the mean
   * is what reconciles against the dollar total.
   *
   * Per trade, not notional-weighted. A $3 copy and a $3,000 copy each count once.
   * Notional weighting would need a USD figure on every trade, and `adverseUsd` is
   * missing or partial often enough that a weighted average would silently be
   * computed over a different, better-priced subset than the count claims.
   */
  readonly medianAdverseBps: number | null;
  readonly meanAdverseBps: number | null;
  /**
   * Sum of the known `adverseUsd` values, `null` when none is known.
   *
   * A **floor**, not a total, whenever `adverseUsdMissingCount` or
   * `adverseUsdPartialCount` is above zero. Both counts are returned so the caller
   * can label it as such instead of presenting a partial sum as the bill.
   */
  readonly totalAdverseUsd: number | null;
  readonly adverseUsdMissingCount: number;
  readonly adverseUsdPartialCount: number;
  readonly feeBasis: TrackingDifferenceFeeBasis;
}

/** Median of a non-empty numeric list. Pure; does not mutate the input. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * Aggregate a set of per-trade differences, keeping the uncompared ones visible.
 *
 * Pure. An empty input returns nulls for every average, not zeros.
 */
export function summarizeTrackingDifferences(
  differences: readonly TrackingDifference[]
): TrackingDifferenceSummary {
  const uncomparedByCode: Partial<Record<TrackingDifferenceCode, number>> = {};
  const comparedBps: number[] = [];
  let worseForUserCount = 0;
  let betterForUserCount = 0;
  let matchedCount = 0;
  let adverseUsdSum = 0;
  let adverseUsdKnown = 0;
  let adverseUsdMissingCount = 0;
  let adverseUsdPartialCount = 0;

  for (const difference of differences) {
    if (difference.code !== 'computed' || difference.adverseBps === null) {
      uncomparedByCode[difference.code] = (uncomparedByCode[difference.code] ?? 0) + 1;
      continue;
    }
    comparedBps.push(difference.adverseBps);
    if (difference.adverseBps > 0) worseForUserCount += 1;
    else if (difference.adverseBps < 0) betterForUserCount += 1;
    else matchedCount += 1;

    if (difference.adverseUsd === null) {
      adverseUsdMissingCount += 1;
    } else {
      adverseUsdSum += difference.adverseUsd;
      adverseUsdKnown += 1;
      if (difference.adverseUsdPartial) adverseUsdPartialCount += 1;
    }
  }

  return {
    total: differences.length,
    comparedCount: comparedBps.length,
    uncomparedCount: differences.length - comparedBps.length,
    uncomparedByCode,
    worseForUserCount,
    betterForUserCount,
    matchedCount,
    medianAdverseBps: median(comparedBps),
    meanAdverseBps: comparedBps.length === 0
      ? null
      : comparedBps.reduce((sum, value) => sum + value, 0) / comparedBps.length,
    totalAdverseUsd: adverseUsdKnown === 0 ? null : adverseUsdSum,
    adverseUsdMissingCount,
    adverseUsdPartialCount,
    feeBasis: TRACKING_DIFFERENCE_FEE_BASIS
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// DB half — one read, and the executor is injected
// ═══════════════════════════════════════════════════════════════════════════
//
// This module deliberately does not import ./client.js. The pure half above is the
// part with decisions in it, and a module that reaches for a connection pool at
// import time cannot be unit tested without a database standing by. Callers pass
// `query` (or `queryRead`) from ./client.js at the call site; tests pass a stub.

/**
 * The shape of `query` / `queryRead` in `./client.js`, as a parameter.
 *
 * Structural rather than a named import so a caller may also pass a
 * transaction-scoped executor, or a test stub, without this module depending on
 * `pg` at run time.
 */
export type TrackingDifferenceQuery = <R extends QueryResultRow>(
  text: string,
  values?: unknown[]
) => Promise<R[]>;

/** The raw row this module reads. Every numeric column is cast to text in SQL. */
export interface TrackingDifferenceDbRow extends QueryResultRow {
  execution_id: string;
  signal_id: string | null;
  source_trade_id: string;
  chain: Chain;
  target_account: string;
  user_id: string | null;
  token_mint: string;
  execution_mode: CopyExecutionMode;
  state: CopyExecutionState;
  /**
   * `copy_executions.direction`. Typed as the wide union because that is what a
   * VARCHAR column can hand back; `mapTrackingDifferenceRow` enforces the
   * `CHECK (direction IN ('buy', 'sell'))` from migration `028` and throws if it is
   * ever violated, rather than declaring the narrow type and quietly being wrong.
   */
  user_side: SourceTradeSide;
  /** `source_trades.direction`, which genuinely admits transfers. */
  master_side: SourceTradeSide;
  master_price_usd: string | null;
  master_amount_usd: string | null;
  master_quantity: string | null;
  master_event_at: Date | null;
  user_filled_quantity: string;
  user_priced_quantity: string;
  user_priced_notional_usd: string;
  user_first_fill_at: Date | null;
}

/** A row, its identity, and the difference computed from it. */
export interface TrackingDifferenceRecord {
  readonly executionId: string;
  readonly signalId: string | null;
  readonly sourceTradeId: string;
  readonly chain: Chain;
  readonly targetAccount: string;
  readonly userId: string | null;
  readonly tokenMint: string;
  readonly executionMode: CopyExecutionMode;
  /**
   * The execution's lifecycle state, passed through un-interpreted.
   *
   * Not branched on here: a `reconciliation_required` execution has a fill ledger
   * the system already distrusts, but whether that invalidates a price comparison is
   * a product call for the surface, not arithmetic. Passed through so the surface
   * can make it rather than being unable to.
   */
  readonly state: CopyExecutionState;
  readonly difference: TrackingDifference;
}

/**
 * NUMERIC arrives as text (cast in SQL) and is parsed here.
 *
 * Throws rather than returning null on unparseable text: a NUMERIC column always
 * renders as valid decimal text, so anything else is a defect in the query or the
 * driver and must not be laundered into "price unknown", where it would be
 * indistinguishable from an honest gap.
 *
 * Caveat, same one the rest of this package lives with (see `numeric.ts`): a NUMERIC
 * wider than a double loses precision here. Irrelevant at price and quantity
 * magnitudes, and the alternative is decimal arithmetic this package does not have.
 */
function parseNumericText(name: string, value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidTrackingDifferenceError(
      `${name} is not a finite numeric value: ${JSON.stringify(value)}`
    );
  }
  return parsed;
}

function parseRequiredNumericText(name: string, value: string | null): number {
  const parsed = parseNumericText(name, value);
  if (parsed === null) {
    throw new InvalidTrackingDifferenceError(`${name} must not be null`);
  }
  return parsed;
}

/**
 * Turn one row into the pure function's input. Exported so a fixture row can be
 * mapped in a test without a database, which is how the arithmetic is covered.
 */
export function mapTrackingDifferenceRow(row: TrackingDifferenceDbRow): TrackingDifferenceInput {
  if (!isTradeableSide(row.user_side)) {
    // Not a code: `copy_executions.direction` is CHECK-constrained to buy or sell,
    // so this is a broken constraint rather than a fact about a trade, and it must
    // not be laundered into an uncomparable result where nobody would find it.
    throw new InvalidTrackingDifferenceError(
      `copy_executions.direction must be buy or sell (migration 028 CHECK), got `
      + `${JSON.stringify(row.user_side)} for execution ${row.execution_id}`
    );
  }
  return {
    master: {
      side: row.master_side,
      priceUsd: parseNumericText('master_price_usd', row.master_price_usd),
      amountUsd: parseNumericText('master_amount_usd', row.master_amount_usd),
      quantity: parseNumericText('master_quantity', row.master_quantity),
      eventAt: row.master_event_at
    },
    user: {
      side: row.user_side,  // narrowed by the guard above
      filledQuantity: parseRequiredNumericText('user_filled_quantity', row.user_filled_quantity),
      pricedQuantity: parseRequiredNumericText('user_priced_quantity', row.user_priced_quantity),
      pricedNotionalUsd: parseRequiredNumericText(
        'user_priced_notional_usd',
        row.user_priced_notional_usd
      ),
      firstFillAt: row.user_first_fill_at
    }
  };
}

/** A row plus its computed difference. */
export function toTrackingDifferenceRecord(row: TrackingDifferenceDbRow): TrackingDifferenceRecord {
  return {
    executionId: row.execution_id,
    signalId: row.signal_id,
    sourceTradeId: row.source_trade_id,
    chain: row.chain,
    targetAccount: row.target_account,
    userId: row.user_id,
    tokenMint: row.token_mint,
    executionMode: row.execution_mode,
    state: row.state,
    difference: computeTrackingDifference(mapTrackingDifferenceRow(row))
  };
}

export interface TrackingDifferenceFilter {
  /** Specific `copy_executions.id` values. Empty array is treated as no filter. */
  readonly executionIds?: readonly string[];
  readonly signalId?: string;
  readonly targetAccount?: string;
  /**
   * Tenant filter. `undefined` means do not filter at all; an explicit `null` means
   * the pre-multi-tenant operator rows only (`copy_executions.user_id IS NULL`,
   * migration `050`). Those are different questions and conflating them would show
   * one tenant another tenant's fills.
   */
  readonly userId?: string | null;
  /** Defaults to 100, capped at 1000. */
  readonly limit?: number;
}

const MAX_TRACKING_DIFFERENCE_LIMIT = 1_000;

/**
 * The fill-price pair for each matching copy execution, and the difference.
 *
 * One statement. The master side comes from the joined `source_trades` row; our
 * side is aggregated from `copy_execution_evidence` over the confirmed and
 * finalized rows only -- the same predicate `recordCopyExecutionEvidence` uses when
 * it recomputes `confirmed_base_quantity`, so this cannot disagree with the
 * execution totals about what filled.
 *
 * The aggregate splits the fill into a priced and an unpriced part rather than
 * averaging over everything, because SUM ignores NULLs: summing price times
 * quantity across rows where some prices are NULL and dividing by the full
 * quantity would understate our price by exactly the unpriced share, and understating
 * our buy price makes the user look like they beat the master. The split makes that
 * shortfall a reported fraction instead.
 */
export async function loadTrackingDifferences(
  execute: TrackingDifferenceQuery,
  filter: TrackingDifferenceFilter = {}
): Promise<TrackingDifferenceRecord[]> {
  const executionIds = filter.executionIds && filter.executionIds.length > 0
    ? [...filter.executionIds]
    : null;
  const limit = filter.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRACKING_DIFFERENCE_LIMIT) {
    throw new InvalidTrackingDifferenceError(
      `limit must be an integer between 1 and ${MAX_TRACKING_DIFFERENCE_LIMIT}, got ${limit}`
    );
  }
  const filterByUser = Object.prototype.hasOwnProperty.call(filter, 'userId');

  const rows = await execute<TrackingDifferenceDbRow>(
    `SELECT
       ce.id AS execution_id,
       ce.signal_id,
       ce.source_trade_id,
       ce.chain,
       ce.target_account,
       ce.user_id,
       ce.token_mint,
       ce.execution_mode,
       ce.state,
       ce.direction AS user_side,
       st.direction AS master_side,
       st.price_usd::text AS master_price_usd,
       st.amount_usd::text AS master_amount_usd,
       st.token_amount::text AS master_quantity,
       st.event_at AS master_event_at,
       fill.filled_quantity::text AS user_filled_quantity,
       fill.priced_quantity::text AS user_priced_quantity,
       fill.priced_notional_usd::text AS user_priced_notional_usd,
       fill.first_fill_at AS user_first_fill_at
     FROM copy_executions ce
     JOIN source_trades st ON st.id = ce.source_trade_id
     LEFT JOIN LATERAL (
       SELECT
         COALESCE(SUM(evidence.base_quantity), 0) AS filled_quantity,
         COALESCE(
           SUM(evidence.base_quantity) FILTER (WHERE evidence.price_usd IS NOT NULL),
           0
         ) AS priced_quantity,
         COALESCE(
           SUM(evidence.base_quantity * evidence.price_usd)
             FILTER (WHERE evidence.price_usd IS NOT NULL),
           0
         ) AS priced_notional_usd,
         MIN(evidence.occurred_at) AS first_fill_at
       FROM copy_execution_evidence evidence
       WHERE evidence.execution_id = ce.id
         AND evidence.confirmation_state IN ('confirmed', 'finalized')
     ) fill ON TRUE
     WHERE ($1::uuid[] IS NULL OR ce.id = ANY($1::uuid[]))
       AND ($2::uuid IS NULL OR ce.signal_id = $2::uuid)
       AND ($3::text IS NULL OR ce.target_account = $3::text)
       AND (NOT $4::boolean OR ce.user_id IS NOT DISTINCT FROM $5::uuid)
     ORDER BY st.event_at DESC, ce.id
     LIMIT $6`,
    [
      executionIds,
      filter.signalId ?? null,
      filter.targetAccount ?? null,
      filterByUser,
      filter.userId ?? null,
      limit
    ]
  );
  return rows.map(toTrackingDifferenceRecord);
}

/**
 * Convenience for the common surface: the differences for one signal, plus the
 * summary that keeps the uncompared ones visible alongside them.
 */
export async function loadTrackingDifferenceSummary(
  execute: TrackingDifferenceQuery,
  filter: TrackingDifferenceFilter = {}
): Promise<{
  readonly records: readonly TrackingDifferenceRecord[];
  readonly summary: TrackingDifferenceSummary;
}> {
  const records = await loadTrackingDifferences(execute, filter);
  return {
    records,
    summary: summarizeTrackingDifferences(records.map((record) => record.difference))
  };
}
