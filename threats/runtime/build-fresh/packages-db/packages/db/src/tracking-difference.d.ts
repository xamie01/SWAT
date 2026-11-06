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
export declare const BPS_PER_UNIT = 10000;
/**
 * Every number this module produces is **gross of fees**, on both sides.
 *
 * Stated as data rather than prose because the value ships to the UI.
 */
export declare const TRACKING_DIFFERENCE_FEE_BASIS: "gross-excludes-fees";
export type TrackingDifferenceFeeBasis = typeof TRACKING_DIFFERENCE_FEE_BASIS;
/**
 * What the schema would need before a fee-inclusive tracking difference is
 * possible. Stated, deliberately not written — migration numbers are contended.
 */
export declare const TRACKING_DIFFERENCE_FEE_GAP: string;
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
'computed'
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
 | 'master-price-unknown' | 'user-price-unknown' | 'both-prices-unknown'
/**
 * A price is present but not positive. A zero-USD fill is a data defect, not a
 * free trade, and it cannot be a ratio denominator. Kept apart from `unknown`
 * because the row *has* a value and somebody should look at it.
 */
 | 'master-price-not-positive' | 'user-price-not-positive';
/** Where the master's USD price came from, since two columns can supply it. */
export type MasterPriceBasis = 
/** `source_trades.price_usd` directly. */
'source-price-usd'
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
export declare class InvalidTrackingDifferenceError extends Error {
    constructor(message: string);
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
export declare const ADVERSE_SIGN: Readonly<Record<TradeableSide, 1 | -1>>;
/**
 * Whether a stored side is a trade at all. A narrowing guard rather than a
 * comparison so the compiler, not a comment, guarantees `ADVERSE_SIGN` is never
 * indexed with a transfer.
 */
export declare function isTradeableSide(side: SourceTradeSide): side is TradeableSide;
/**
 * Milliseconds between the master's event and our first fill, or `null`.
 *
 * Pure: both instants are arguments, so there is no clock in this module.
 */
export declare function entryLagMs(masterEventAt: Date | null, userFirstFillAt: Date | null): number | null;
/**
 * The master's USD fill price and where it came from.
 *
 * Exported because the UI shows the benchmark price next to the gap, and a second
 * derivation in the frontend would drift on the `amount_usd` fallback.
 */
export declare function resolveMasterPriceUsd(master: MasterFill): {
    readonly priceUsd: number | null;
    readonly basis: MasterPriceBasis;
};
/**
 * Our quantity-weighted USD fill price over the priced part of the fill, or `null`
 * when no part of it carried a price.
 */
export declare function resolveUserPriceUsd(user: UserFill): number | null;
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
export declare function computeTrackingDifference(input: TrackingDifferenceInput): TrackingDifference;
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
/**
 * Aggregate a set of per-trade differences, keeping the uncompared ones visible.
 *
 * Pure. An empty input returns nulls for every average, not zeros.
 */
export declare function summarizeTrackingDifferences(differences: readonly TrackingDifference[]): TrackingDifferenceSummary;
/**
 * The shape of `query` / `queryRead` in `./client.js`, as a parameter.
 *
 * Structural rather than a named import so a caller may also pass a
 * transaction-scoped executor, or a test stub, without this module depending on
 * `pg` at run time.
 */
export type TrackingDifferenceQuery = <R extends QueryResultRow>(text: string, values?: unknown[]) => Promise<R[]>;
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
 * Turn one row into the pure function's input. Exported so a fixture row can be
 * mapped in a test without a database, which is how the arithmetic is covered.
 */
export declare function mapTrackingDifferenceRow(row: TrackingDifferenceDbRow): TrackingDifferenceInput;
/** A row plus its computed difference. */
export declare function toTrackingDifferenceRecord(row: TrackingDifferenceDbRow): TrackingDifferenceRecord;
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
export declare function loadTrackingDifferences(execute: TrackingDifferenceQuery, filter?: TrackingDifferenceFilter): Promise<TrackingDifferenceRecord[]>;
/**
 * Convenience for the common surface: the differences for one signal, plus the
 * summary that keeps the uncompared ones visible alongside them.
 */
export declare function loadTrackingDifferenceSummary(execute: TrackingDifferenceQuery, filter?: TrackingDifferenceFilter): Promise<{
    readonly records: readonly TrackingDifferenceRecord[];
    readonly summary: TrackingDifferenceSummary;
}>;
//# sourceMappingURL=tracking-difference.d.ts.map