/**
 * Active TVL (Track B3) — liquidity actually tradeable at the current price,
 * computed per chain: bins near the active bin on Meteora DLMM, ticks near the
 * current tick on Uniswap v3/v4. Two implementations behind one interface,
 * because every consumer (scanner, ranking, rebalance economics) wants the same
 * number regardless of chain.
 *
 * All amounts are human-scale and priced: callers inject USD prices for base
 * and quote. A missing price is a real answer — the calculator returns null
 * ("cannot be priced") rather than valuing the unpriced leg at 0, which would
 * read as an empty pool.
 */
/** One price, quoted in USD. Null propagates: unpriced legs void the whole valuation. */
function priceOrThrow(name, value) {
    if (value === null || !Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a non-negative finite USD price or null, got ${value}`);
    }
    return value;
}
function meteoraActiveTvl(context) {
    if (context.basePriceUsd === null || context.quotePriceUsd === null)
        return null;
    const basePriceUsd = priceOrThrow('basePriceUsd', context.basePriceUsd);
    const quotePriceUsd = priceOrThrow('quotePriceUsd', context.quotePriceUsd);
    let total = 0;
    for (const bin of context.bins) {
        if (Math.abs(bin.binId - context.activeBinId) > context.range)
            continue;
        if (!Number.isFinite(bin.price) || bin.price < 0) {
            throw new Error(`bin price must be a non-negative finite number, got ${bin.price}`);
        }
        total += bin.baseAmount * bin.price * basePriceUsd + bin.quoteAmount * quotePriceUsd;
    }
    return total;
}
/** Uniswap v3 math in human units: sqrt price at a tick, quote-per-base. */
function sqrtPriceAtTick(tick) {
    return Math.sqrt(1.0001 ** tick);
}
function bandAmounts(band, currentTick) {
    const sqrtLower = sqrtPriceAtTick(band.tickLower);
    const sqrtUpper = sqrtPriceAtTick(band.tickUpper);
    if (currentTick >= band.tickUpper) {
        // Entirely below the current price: the position is fully in base.
        return { baseAmount: band.liquidity * (1 / sqrtLower - 1 / sqrtUpper), quoteAmount: 0 };
    }
    if (currentTick < band.tickLower) {
        // Entirely above the current price: fully in quote.
        return { baseAmount: 0, quoteAmount: band.liquidity * (sqrtUpper - sqrtLower) };
    }
    // Current band: split at the current price.
    const sqrtCurrent = sqrtPriceAtTick(currentTick);
    return {
        baseAmount: band.liquidity * (1 / sqrtCurrent - 1 / sqrtUpper),
        quoteAmount: band.liquidity * (sqrtUpper - sqrtCurrent)
    };
}
function uniswapActiveTvl(context) {
    if (context.basePriceUsd === null || context.quotePriceUsd === null)
        return null;
    const basePriceUsd = priceOrThrow('basePriceUsd', context.basePriceUsd);
    const quotePriceUsd = priceOrThrow('quotePriceUsd', context.quotePriceUsd);
    const baseTokenDecimals = context.baseTokenDecimals ?? 0;
    const quoteTokenDecimals = context.quoteTokenDecimals ?? 0;
    if (!Number.isInteger(baseTokenDecimals) || baseTokenDecimals < 0 || baseTokenDecimals > 80) {
        throw new Error(`baseTokenDecimals must be an integer in 0..80, got ${baseTokenDecimals}`);
    }
    if (!Number.isInteger(quoteTokenDecimals) || quoteTokenDecimals < 0 || quoteTokenDecimals > 80) {
        throw new Error(`quoteTokenDecimals must be an integer in 0..80, got ${quoteTokenDecimals}`);
    }
    const baseScale = 10 ** baseTokenDecimals;
    const quoteScale = 10 ** quoteTokenDecimals;
    let total = 0;
    for (const band of context.bands) {
        if (band.tickLower >= band.tickUpper) {
            throw new Error(`tick band must satisfy tickLower < tickUpper, got ${band.tickLower}..${band.tickUpper}`);
        }
        if (band.tickUpper - band.tickLower > context.range * 2)
            continue;
        const { baseAmount, quoteAmount } = bandAmounts(band, context.currentTick);
        total += (baseAmount / baseScale) * basePriceUsd + (quoteAmount / quoteScale) * quotePriceUsd;
    }
    return total;
}
export function createActiveTvlCalculator() {
    return {
        calculateActiveTvl(context) {
            return context.protocol === 'meteora-dlmm'
                ? meteoraActiveTvl(context)
                : uniswapActiveTvl(context);
        }
    };
}
//# sourceMappingURL=active-tvl.js.map