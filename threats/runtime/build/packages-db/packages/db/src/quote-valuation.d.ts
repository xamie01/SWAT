import type { Chain } from '@swat/shared';
/**
 * The quote leg of a copy fill: what was paid, in which token, and what that
 * came to in USD.
 *
 * ## Why this module exists (S4-M35)
 *
 * `copy_execution_evidence.quote_quantity` used to be a mixed-unit column. Each
 * executor path wrote whatever its venue settled in and nothing recorded the
 * unit:
 *
 *   * Polymarket live wrote `spendAmountUsd` — USD.
 *   * Paper simulation wrote `simAmountUsd` — USD.
 *   * Solana live wrote `nativeLamportsDelta / 1e9` — **SOL**.
 *   * robinhood-chain live wrote `result.amountEth` — **ETH**.
 *
 * `rebuildCopyPosition` then summed that column into `copy_positions.cost_basis_usd`,
 * *preferring* it over the `base_quantity * price_usd` fallback, so a column named
 * `_usd` accumulated SOL and ETH.
 *
 * The unit is a property of the executor path, not of the chain — the Solana paper
 * path settles in USD while the Solana live path settles in SOL — so it cannot be
 * inferred at read time and has to be declared at write time. That is what
 * {@link QuoteLegInput} forces: there is no way to hand the write path an amount
 * without also handing it the currency.
 *
 * ## Both halves are kept, deliberately
 *
 * A USD figure alone is lossy: it cannot be re-derived if the conversion rate was
 * wrong, it cannot be audited, and it cannot answer "how much SOL did this position
 * actually cost". So every valued fill persists three things — the native amount,
 * its currency, and the rate used — and the USD figure is the *derived* one.
 *
 * ## One conversion rule
 *
 * {@link nativeQuoteCurrencyForChain} and {@link valuateQuoteLeg} are the single
 * conversion rule in the codebase. `persistTrade` in `apps/trade-executor` used to
 * carry its own per-chain `if` chain (Solana x SOL price, robinhood x ETH price,
 * polygon already USD) and now calls these instead, so the two write paths cannot
 * drift apart.
 *
 * Everything here is pure: no database, no clock, no network, no price fetching.
 * The caller supplies the rate; this module decides what it means.
 */
/** Currencies a venue can settle a copy fill's quote leg in. */
export type QuoteCurrency = 'USD' | 'SOL' | 'ETH' | 'BNB';
export declare const QUOTE_CURRENCIES: readonly QuoteCurrency[];
export declare function isQuoteCurrency(value: unknown): value is QuoteCurrency;
/**
 * The currency a chain's *native* quote leg is denominated in.
 *
 * This is the map `persistTrade` encoded inline. It answers "if a caller hands me
 * a raw size for this chain, what unit is that size in" — it does NOT answer "what
 * unit did this stored row use", because a paper fill on Solana is sized in USD.
 * Callers that already know they hold USD must say so rather than ask this.
 */
export declare function nativeQuoteCurrencyForChain(chain: Chain): QuoteCurrency;
/**
 * What the caller observed: an amount, the token it is denominated in, and the USD
 * price of one unit of that token at fill time.
 *
 * `nativeUsdPrice` is meaningless for `USD` and required for everything else. It is
 * accepted as `null` rather than made mandatory because "we could not get a SOL
 * price" is a real outcome the caller must be able to express — and one that must
 * produce an *unknown* USD value, never a zero.
 */
export interface QuoteLegInput {
    readonly amount: string | number;
    readonly currency: QuoteCurrency;
    readonly nativeUsdPrice?: string | number | null;
}
/**
 * Why a quote leg does or does not have a USD value. Mirrors the
 * `TrackingDifferenceCode` discipline in `tracking-difference.ts`: unknown is a
 * named code, never a number.
 */
export type QuoteValuationCode = 
/** Native amount, currency and rate all present; `usdAmount` is trustworthy. */
'valued'
/** The venue reported no quote amount at all. Nothing is known, not even zero. */
 | 'no-quote-leg'
/**
 * The native amount is known but no usable USD rate was supplied, so the USD
 * value is unknown. The native amount is still persisted — it is the part that
 * was actually observed.
 */
 | 'native-price-unknown';
export interface QuoteLegValuation {
    readonly code: QuoteValuationCode;
    /** `null` only when there was no quote leg. */
    readonly currency: QuoteCurrency | null;
    /** Amount as settled, in `currency`. `null` only when there was no quote leg. */
    readonly nativeAmount: string | null;
    /** USD price of one unit of `currency`. `'1'` for USD. `null` when unknown. */
    readonly nativeUsdPrice: string | null;
    /** `nativeAmount * nativeUsdPrice`, exact. `null` when unknown — never `0`. */
    readonly usdAmount: string | null;
    /** One sentence, safe to log or surface. */
    readonly reason: string;
}
/**
 * Exact decimal multiply on text, via BigInt.
 *
 * Money is not multiplied in binary floating point here. `0.1 * 3` in JS is
 * `0.30000000000000004`, and a cost basis assembled from thousands of those drifts
 * visibly. Both inputs must already be canonical unsigned decimals.
 */
export declare function multiplyDecimalText(left: string, right: string): string;
/**
 * Turn an observed quote leg into a USD value plus the native record that makes it
 * checkable.
 *
 * Throws on an amount that is not a non-negative decimal — that is a caller bug,
 * not an unknown, and silently mapping it to `null` would hide a broken executor
 * path behind the same code that means "the price feed was down". A missing or
 * unusable *rate*, by contrast, is an expected outcome and yields
 * `native-price-unknown`.
 */
export declare function valuateQuoteLeg(leg: QuoteLegInput | null | undefined): QuoteLegValuation;
/**
 * Exact decimal divide on text, truncated to `scale` fractional digits.
 *
 * Truncated rather than rounded, and truncated at a scale far beyond any venue's
 * tick, because the result is a derived diagnostic price rather than a settlement
 * figure. Both inputs must already be canonical unsigned decimals.
 */
export declare function divideDecimalText(numerator: string, denominator: string, scale?: number): string | null;
/**
 * The realised USD price of one base unit in a fill: USD paid over units received.
 *
 * This exists because the Solana-live and robinhood-live fill recorders passed no
 * `priceUsd` at all, leaving `copy_execution_evidence.price_usd` NULL on both --
 * which is why `S4-M23`'s tracking difference could only be computed on Polymarket
 * and in paper mode. The two numbers needed are already in hand at that point, so
 * the price is derived rather than fetched, and a derived *fill* price is strictly
 * better for that comparison than a spot quote taken moments later.
 *
 * Returns `null` -- never `0` -- when either input is unusable, which is the whole
 * point: a missing price must stay missing rather than become a free trade.
 */
export declare function deriveFillPriceUsd(usdAmount: string | null | undefined, baseQuantity: string | number | null | undefined): string | null;
/**
 * Build a quote leg from a chain-native size, for callers that hold a raw size and
 * know it is denominated in the chain's native unit.
 *
 * This is the `persistTrade` shape. It is deliberately *not* the shape the copy
 * write path uses, because a paper fill on Solana is sized in USD and would be
 * mislabelled `SOL` by a chain lookup.
 */
export declare function valuateChainNativeQuoteLeg(input: {
    readonly chain: Chain;
    readonly amount: string | number;
    readonly nativeUsdPrice?: string | number | null;
}): QuoteLegValuation;
/**
 * Why a summed USD quote total is or is not the whole truth.
 *
 * `SUM` skips NULLs, so `COALESCE(SUM(quote_quantity), 0)` reported a complete
 * number whether every fill was valued, some were, or none were. These codes make
 * the three cases distinguishable, which is the point: a partial sum is a floor and
 * must not be rendered as a settled figure.
 */
export type ConfirmedQuoteTotalCode = 
/** No confirmed fills at all. The total is a genuine, known zero. */
'no-fills'
/** Every confirmed fill carries a USD value. The total is complete. */
 | 'complete'
/** Some fills carry a USD value and some do not. The total is a lower bound. */
 | 'partially-valued'
/** At least one confirmed fill exists and none carries a USD value. */
 | 'unvalued';
export interface ConfirmedQuoteTotalInput {
    /** Confirmed fills whose USD quote value is known. */
    readonly valuedFillCount: number;
    /** Confirmed fills whose USD quote value is unknown. */
    readonly unvaluedFillCount: number;
    /** `SUM` over the valued fills only, as Postgres text. `null` when there were none. */
    readonly valuedUsdSum: string | null;
}
export interface ConfirmedQuoteTotal {
    readonly code: ConfirmedQuoteTotalCode;
    /**
     * USD total over the fills that have a value. `null` when nothing is known —
     * never `0` standing in for unknown.
     */
    readonly usdAmount: string | null;
    /** Number of confirmed fills the total omits. `0` means it omits nothing. */
    readonly unvaluedFillCount: number;
    /** `true` only when the total accounts for every confirmed fill. */
    readonly complete: boolean;
    readonly reason: string;
}
export declare function summarizeConfirmedQuoteTotal(input: ConfirmedQuoteTotalInput): ConfirmedQuoteTotal;
//# sourceMappingURL=quote-valuation.d.ts.map