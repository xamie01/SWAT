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
export type QuoteCurrency = 'USD' | 'SOL' | 'ETH';

export const QUOTE_CURRENCIES: readonly QuoteCurrency[] = ['USD', 'SOL', 'ETH'];

export function isQuoteCurrency(value: unknown): value is QuoteCurrency {
  return typeof value === 'string' && (QUOTE_CURRENCIES as readonly string[]).includes(value);
}

/**
 * The currency a chain's *native* quote leg is denominated in.
 *
 * This is the map `persistTrade` encoded inline. It answers "if a caller hands me
 * a raw size for this chain, what unit is that size in" — it does NOT answer "what
 * unit did this stored row use", because a paper fill on Solana is sized in USD.
 * Callers that already know they hold USD must say so rather than ask this.
 */
export function nativeQuoteCurrencyForChain(chain: Chain): QuoteCurrency {
  switch (chain) {
    case 'solana':
      return 'SOL';
    case 'robinhood-chain':
      return 'ETH';
    case 'polygon':
      // Polymarket sizes and settles in USDC, which the whole codebase treats as
      // USD 1:1 (see `persistTrade`: polygon needs no conversion).
      return 'USD';
    default: {
      const exhaustive: never = chain;
      throw new Error(`Unsupported chain for quote valuation: ${String(exhaustive)}`);
    }
  }
}

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
  | 'valued'
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

const UNSIGNED_DECIMAL = /^(?:\d+\.?\d*|\d*\.\d+)$/;

/**
 * Normalise a decimal to canonical unsigned text, or return `null` if it is not a
 * usable non-negative finite decimal.
 *
 * Exponent notation is expanded rather than rejected because `Number.toString()`
 * produces it for small numbers (`1e-7`), and a lamport-scale amount landing here
 * as `1e-9` must not be read as unparseable.
 */
function normalizeUnsignedDecimal(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    return normalizeUnsignedDecimal(expandExponent(value.toString()));
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const expanded = expandExponent(trimmed);
  if (expanded === null) return null;
  if (!UNSIGNED_DECIMAL.test(expanded)) return null;
  return expanded;
}

/** Rewrite `1.5e-7` as `0.00000015`. Returns the input unchanged when there is no exponent. */
function expandExponent(text: string): string | null {
  const match = /^(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(text);
  if (!match) return text;
  const [, integerPart = '', fractionalPart = '', exponentText = '0'] = match;
  const digits = `${integerPart}${fractionalPart}`;
  if (digits === '') return null;
  const exponent = Number(exponentText);
  if (!Number.isFinite(exponent)) return null;
  const pointIndex = integerPart.length + exponent;
  if (pointIndex <= 0) return `0.${'0'.repeat(-pointIndex)}${digits}`;
  if (pointIndex >= digits.length) return `${digits}${'0'.repeat(pointIndex - digits.length)}`;
  return `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
}

function splitDecimal(text: string): { digits: bigint; scale: number } {
  const [integerPart = '0', fractionalPart = ''] = text.split('.');
  const combined = `${integerPart}${fractionalPart}`;
  return { digits: BigInt(combined === '' ? '0' : combined), scale: fractionalPart.length };
}

function trimDecimal(text: string): string {
  if (!text.includes('.')) return text.replace(/^0+(?=\d)/, '');
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
  const normalized = trimmed === '' ? '0' : trimmed;
  return normalized.replace(/^0+(?=\d)/, '');
}

/**
 * Exact decimal multiply on text, via BigInt.
 *
 * Money is not multiplied in binary floating point here. `0.1 * 3` in JS is
 * `0.30000000000000004`, and a cost basis assembled from thousands of those drifts
 * visibly. Both inputs must already be canonical unsigned decimals.
 */
export function multiplyDecimalText(left: string, right: string): string {
  const a = splitDecimal(left);
  const b = splitDecimal(right);
  const product = (a.digits * b.digits).toString();
  const scale = a.scale + b.scale;
  if (scale === 0) return trimDecimal(product);
  const padded = product.padStart(scale + 1, '0');
  const pointIndex = padded.length - scale;
  return trimDecimal(`${padded.slice(0, pointIndex)}.${padded.slice(pointIndex)}`);
}

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
export function valuateQuoteLeg(leg: QuoteLegInput | null | undefined): QuoteLegValuation {
  if (leg === null || leg === undefined) {
    return {
      code: 'no-quote-leg',
      currency: null,
      nativeAmount: null,
      nativeUsdPrice: null,
      usdAmount: null,
      reason: 'The venue reported no quote amount for this fill.'
    };
  }

  if (!isQuoteCurrency(leg.currency)) {
    throw new Error(
      `quote leg currency must be one of ${QUOTE_CURRENCIES.join(', ')}, received ${JSON.stringify(leg.currency)}`
    );
  }

  const nativeAmount = normalizeUnsignedDecimal(leg.amount);
  if (nativeAmount === null) {
    throw new Error(
      `quote leg amount must be a non-negative decimal, received ${JSON.stringify(leg.amount)}`
    );
  }

  if (leg.currency === 'USD') {
    return {
      code: 'valued',
      currency: 'USD',
      nativeAmount,
      nativeUsdPrice: '1',
      usdAmount: nativeAmount,
      reason: 'Settled in USD; no conversion applied.'
    };
  }

  const rate = normalizeUnsignedDecimal(leg.nativeUsdPrice);
  if (rate === null || Number(rate) <= 0) {
    return {
      code: 'native-price-unknown',
      currency: leg.currency,
      nativeAmount,
      nativeUsdPrice: null,
      usdAmount: null,
      reason:
        `Settled ${nativeAmount} ${leg.currency} but no usable USD rate was available, `
        + 'so the USD value is unknown rather than zero.'
    };
  }

  return {
    code: 'valued',
    currency: leg.currency,
    nativeAmount,
    nativeUsdPrice: rate,
    usdAmount: multiplyDecimalText(nativeAmount, rate),
    reason: `Converted ${nativeAmount} ${leg.currency} at ${rate} USD per ${leg.currency}.`
  };
}

/**
 * Exact decimal divide on text, truncated to `scale` fractional digits.
 *
 * Truncated rather than rounded, and truncated at a scale far beyond any venue's
 * tick, because the result is a derived diagnostic price rather than a settlement
 * figure. Both inputs must already be canonical unsigned decimals.
 */
export function divideDecimalText(
  numerator: string,
  denominator: string,
  scale = 18
): string | null {
  const a = splitDecimal(numerator);
  const b = splitDecimal(denominator);
  if (b.digits === 0n) return null;
  const scaled = a.digits * 10n ** BigInt(b.scale) * 10n ** BigInt(scale);
  const quotient = (scaled / (b.digits * 10n ** BigInt(a.scale))).toString();
  if (scale === 0) return trimDecimal(quotient);
  const padded = quotient.padStart(scale + 1, '0');
  const pointIndex = padded.length - scale;
  return trimDecimal(`${padded.slice(0, pointIndex)}.${padded.slice(pointIndex)}`);
}

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
export function deriveFillPriceUsd(
  usdAmount: string | null | undefined,
  baseQuantity: string | number | null | undefined
): string | null {
  const usd = normalizeUnsignedDecimal(usdAmount);
  const base = normalizeUnsignedDecimal(baseQuantity);
  if (usd === null || base === null) return null;
  if (Number(base) <= 0) return null;
  return divideDecimalText(usd, base);
}

/**
 * Build a quote leg from a chain-native size, for callers that hold a raw size and
 * know it is denominated in the chain's native unit.
 *
 * This is the `persistTrade` shape. It is deliberately *not* the shape the copy
 * write path uses, because a paper fill on Solana is sized in USD and would be
 * mislabelled `SOL` by a chain lookup.
 */
export function valuateChainNativeQuoteLeg(input: {
  readonly chain: Chain;
  readonly amount: string | number;
  readonly nativeUsdPrice?: string | number | null;
}): QuoteLegValuation {
  return valuateQuoteLeg({
    amount: input.amount,
    currency: nativeQuoteCurrencyForChain(input.chain),
    nativeUsdPrice: input.nativeUsdPrice
  });
}

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
  | 'no-fills'
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

export function summarizeConfirmedQuoteTotal(
  input: ConfirmedQuoteTotalInput
): ConfirmedQuoteTotal {
  const valued = assertCount('valuedFillCount', input.valuedFillCount);
  const unvalued = assertCount('unvaluedFillCount', input.unvaluedFillCount);

  if (valued === 0 && unvalued === 0) {
    return {
      code: 'no-fills',
      usdAmount: '0',
      unvaluedFillCount: 0,
      complete: true,
      reason: 'No confirmed fills yet, so the quote total is a known zero.'
    };
  }

  if (valued === 0) {
    return {
      code: 'unvalued',
      usdAmount: null,
      unvaluedFillCount: unvalued,
      complete: false,
      reason:
        `${unvalued} confirmed fill(s) carry no USD quote value, so the total is unknown `
        + 'rather than zero.'
    };
  }

  const sum = normalizeUnsignedDecimal(input.valuedUsdSum);
  if (sum === null) {
    throw new Error(
      `valuedUsdSum must be a non-negative decimal when valuedFillCount > 0, received ${JSON.stringify(input.valuedUsdSum)}`
    );
  }

  if (unvalued === 0) {
    return {
      code: 'complete',
      usdAmount: sum,
      unvaluedFillCount: 0,
      complete: true,
      reason: `All ${valued} confirmed fill(s) are valued in USD.`
    };
  }

  return {
    code: 'partially-valued',
    usdAmount: sum,
    unvaluedFillCount: unvalued,
    complete: false,
    reason:
      `${valued} confirmed fill(s) are valued and ${unvalued} are not, so ${sum} USD is a `
      + 'lower bound rather than the settled total.'
  };
}

function assertCount(name: string, value: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new Error(`${name} must be a non-negative integer, received ${JSON.stringify(value)}`);
  }
  return numeric;
}
