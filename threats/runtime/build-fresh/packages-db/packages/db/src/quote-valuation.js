export const QUOTE_CURRENCIES = ['USD', 'SOL', 'ETH', 'BNB'];
export function isQuoteCurrency(value) {
    return typeof value === 'string' && QUOTE_CURRENCIES.includes(value);
}
/**
 * The currency a chain's *native* quote leg is denominated in.
 *
 * This is the map `persistTrade` encoded inline. It answers "if a caller hands me
 * a raw size for this chain, what unit is that size in" — it does NOT answer "what
 * unit did this stored row use", because a paper fill on Solana is sized in USD.
 * Callers that already know they hold USD must say so rather than ask this.
 */
export function nativeQuoteCurrencyForChain(chain) {
    switch (chain) {
        case 'solana':
            return 'SOL';
        case 'robinhood-chain':
        case 'base':
        case 'ethereum':
            return 'ETH';
        case 'bsc':
            return 'BNB';
        case 'polygon':
            // Polymarket sizes and settles in USDC, which the whole codebase treats as
            // USD 1:1 (see `persistTrade`: polygon needs no conversion).
            return 'USD';
        default: {
            const exhaustive = chain;
            throw new Error(`Unsupported chain for quote valuation: ${String(exhaustive)}`);
        }
    }
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
function normalizeUnsignedDecimal(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0)
            return null;
        return normalizeUnsignedDecimal(expandExponent(value.toString()));
    }
    const trimmed = value.trim();
    if (trimmed === '')
        return null;
    const expanded = expandExponent(trimmed);
    if (expanded === null)
        return null;
    if (!UNSIGNED_DECIMAL.test(expanded))
        return null;
    return expanded;
}
/** Rewrite `1.5e-7` as `0.00000015`. Returns the input unchanged when there is no exponent. */
function expandExponent(text) {
    const match = /^(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(text);
    if (!match)
        return text;
    const [, integerPart = '', fractionalPart = '', exponentText = '0'] = match;
    const digits = `${integerPart}${fractionalPart}`;
    if (digits === '')
        return null;
    const exponent = Number(exponentText);
    if (!Number.isFinite(exponent))
        return null;
    const pointIndex = integerPart.length + exponent;
    if (pointIndex <= 0)
        return `0.${'0'.repeat(-pointIndex)}${digits}`;
    if (pointIndex >= digits.length)
        return `${digits}${'0'.repeat(pointIndex - digits.length)}`;
    return `${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
}
function splitDecimal(text) {
    const [integerPart = '0', fractionalPart = ''] = text.split('.');
    const combined = `${integerPart}${fractionalPart}`;
    return { digits: BigInt(combined === '' ? '0' : combined), scale: fractionalPart.length };
}
function trimDecimal(text) {
    if (!text.includes('.'))
        return text.replace(/^0+(?=\d)/, '');
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
export function multiplyDecimalText(left, right) {
    const a = splitDecimal(left);
    const b = splitDecimal(right);
    const product = (a.digits * b.digits).toString();
    const scale = a.scale + b.scale;
    if (scale === 0)
        return trimDecimal(product);
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
export function valuateQuoteLeg(leg) {
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
        throw new Error(`quote leg currency must be one of ${QUOTE_CURRENCIES.join(', ')}, received ${JSON.stringify(leg.currency)}`);
    }
    const nativeAmount = normalizeUnsignedDecimal(leg.amount);
    if (nativeAmount === null) {
        throw new Error(`quote leg amount must be a non-negative decimal, received ${JSON.stringify(leg.amount)}`);
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
            reason: `Settled ${nativeAmount} ${leg.currency} but no usable USD rate was available, `
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
export function divideDecimalText(numerator, denominator, scale = 18) {
    const a = splitDecimal(numerator);
    const b = splitDecimal(denominator);
    if (b.digits === 0n)
        return null;
    const scaled = a.digits * 10n ** BigInt(b.scale) * 10n ** BigInt(scale);
    const quotient = (scaled / (b.digits * 10n ** BigInt(a.scale))).toString();
    if (scale === 0)
        return trimDecimal(quotient);
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
export function deriveFillPriceUsd(usdAmount, baseQuantity) {
    const usd = normalizeUnsignedDecimal(usdAmount);
    const base = normalizeUnsignedDecimal(baseQuantity);
    if (usd === null || base === null)
        return null;
    if (Number(base) <= 0)
        return null;
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
export function valuateChainNativeQuoteLeg(input) {
    return valuateQuoteLeg({
        amount: input.amount,
        currency: nativeQuoteCurrencyForChain(input.chain),
        nativeUsdPrice: input.nativeUsdPrice
    });
}
export function summarizeConfirmedQuoteTotal(input) {
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
            reason: `${unvalued} confirmed fill(s) carry no USD quote value, so the total is unknown `
                + 'rather than zero.'
        };
    }
    const sum = normalizeUnsignedDecimal(input.valuedUsdSum);
    if (sum === null) {
        throw new Error(`valuedUsdSum must be a non-negative decimal when valuedFillCount > 0, received ${JSON.stringify(input.valuedUsdSum)}`);
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
        reason: `${valued} confirmed fill(s) are valued and ${unvalued} are not, so ${sum} USD is a `
            + 'lower bound rather than the settled total.'
    };
}
function assertCount(name, value) {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(numeric) || numeric < 0) {
        throw new Error(`${name} must be a non-negative integer, received ${JSON.stringify(value)}`);
    }
    return numeric;
}
//# sourceMappingURL=quote-valuation.js.map