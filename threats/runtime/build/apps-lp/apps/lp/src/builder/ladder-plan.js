function assertPositive(name, value) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive finite number, got ${value}`);
    }
}
/**
 * Weights per rung by distribution; sums to 1 within float error.
 *
 * `curve` requires the anchor (price + bounds) because "nearest the current
 * price" is meaningless without them; `spot` and `bidask` are anchor-free
 * shapes. `bidask` loads both edges symmetrically — one exponential anchored
 * at each edge, summed — so the shape is a dip in the middle, not a ramp.
 */
export function computeRungWeights(distribution, rungCount, anchor) {
    if (!Number.isInteger(rungCount) || rungCount < 1 || rungCount > 64) {
        throw new Error(`rungCount must be an integer in 1..64, got ${rungCount}`);
    }
    if (rungCount === 1)
        return [1];
    if (distribution === 'spot') {
        return Array.from({ length: rungCount }, () => 1 / rungCount);
    }
    // Exponential shape parameter: lambda = 1.2 gives a visible tilt without
    // degenerate rungs.
    const lambda = 1.2;
    const rawWeights = [];
    if (distribution === 'curve') {
        if (!anchor) {
            throw new Error('curve weights need the current price and rung bounds to anchor at');
        }
        if (anchor.bounds.length !== rungCount) {
            throw new Error(`curve weights need ${rungCount} rung bounds, got ${anchor.bounds.length}`);
        }
        if (!Number.isFinite(anchor.currentPrice) || anchor.currentPrice <= 0) {
            throw new Error(`currentPrice must be a positive finite number, got ${anchor.currentPrice}`);
        }
        // Distances are normalized by the ladder's total log width so lambda means
        // the same tilt on a ±2% scalp as on a ±60% passive range. A price outside
        // the range still loads the nearest rung most — the shape degrades, it
        // does not invert.
        const logWidth = Math.log(anchor.bounds[anchor.bounds.length - 1].priceUpper) -
            Math.log(anchor.bounds[0].priceLower);
        for (const bound of anchor.bounds) {
            const midpoint = Math.sqrt(bound.priceLower * bound.priceUpper);
            const distance = Math.abs(Math.log(midpoint) - Math.log(anchor.currentPrice));
            rawWeights.push(Math.exp(-lambda * (distance / logWidth)));
        }
    }
    else {
        // bidask: one decay anchored at each edge, summed — both edges heavy,
        // symmetric regardless of where the price sits.
        for (let index = 0; index < rungCount; index += 1) {
            const position = index / (rungCount - 1); // 0 .. 1 across the range
            rawWeights.push(Math.exp(-lambda * position) + Math.exp(-lambda * (1 - position)));
        }
    }
    const total = rawWeights.reduce((sum, weight) => sum + weight, 0);
    return rawWeights.map((weight) => weight / total);
}
/** Contiguous price bounds dividing [rangeLower, rangeUpper] into rungCount bands. */
export function computeRungPriceBounds(rangeLower, rangeUpper, rungCount) {
    assertPositive('rangeLower', rangeLower);
    assertPositive('rangeUpper', rangeUpper);
    if (rangeUpper <= rangeLower) {
        throw new Error(`range must satisfy rangeLower < rangeUpper, got ${rangeLower}..${rangeUpper}`);
    }
    if (!Number.isInteger(rungCount) || rungCount < 1 || rungCount > 64) {
        throw new Error(`rungCount must be an integer in 1..64, got ${rungCount}`);
    }
    // Geometric division, not arithmetic: equal log-widths keeps rung exposure
    // comparable at both ends of a wide range.
    const logLower = Math.log(rangeLower);
    const logUpper = Math.log(rangeUpper);
    const logStep = (logUpper - logLower) / rungCount;
    return Array.from({ length: rungCount }, (_, index) => ({
        priceLower: Math.exp(logLower + index * logStep),
        priceUpper: Math.exp(logLower + (index + 1) * logStep)
    }));
}
/** Meteora bin id at a price: id = ln(price) / ln(1 + binStep). */
export function priceToBinId(price, binStepBps) {
    assertPositive('price', price);
    if (!Number.isFinite(binStepBps) || binStepBps <= 0) {
        throw new Error(`binStepBps must be positive, got ${binStepBps}`);
    }
    return Math.round(Math.log(price) / Math.log(1 + binStepBps / 10_000));
}
/** Uniswap tick at a price: tick = ln(price) / ln(1.0001), floored to spacing. */
export function priceToTick(price, tickSpacing) {
    assertPositive('price', price);
    if (!Number.isFinite(tickSpacing) || tickSpacing <= 0) {
        throw new Error(`tickSpacing must be positive, got ${tickSpacing}`);
    }
    const raw = Math.log(price) / Math.log(1.0001);
    const floored = Math.floor(raw);
    return floored - (((floored % tickSpacing) + tickSpacing) % tickSpacing);
}
/** Builds the whole plan: bounds, weights, allocations, and chain snapping. */
export function buildLadderPlan(input) {
    if (input.protocol === 'meteora-dlmm' && input.binStep === undefined) {
        throw new Error('meteora ladder plans require binStep');
    }
    if (input.protocol !== 'meteora-dlmm' && input.tickSpacing === undefined) {
        throw new Error('uniswap ladder plans require tickSpacing');
    }
    const bounds = computeRungPriceBounds(input.rangeLower, input.rangeUpper, input.rungCount);
    const weights = computeRungWeights(input.distribution, input.rungCount, {
        currentPrice: input.currentPrice,
        bounds
    });
    const lastIndex = bounds.length - 1;
    const rungs = bounds.map((bound, index) => {
        const rung = {
            priceLower: bound.priceLower,
            priceUpper: bound.priceUpper,
            weight: weights[index],
            allocation: weights[index] * input.depositAmount
        };
        if (input.protocol === 'meteora-dlmm') {
            const binLower = priceToBinId(bound.priceLower, input.binStep);
            const binUpper = priceToBinId(bound.priceUpper, input.binStep);
            // Contiguous bin coverage: rung i ends one bin before rung i+1 starts.
            return {
                ...rung,
                binLower,
                binUpper: index === lastIndex ? binUpper : Math.max(binLower, binUpper - 1)
            };
        }
        const tickLower = priceToTick(bound.priceLower, input.tickSpacing);
        const tickUpper = priceToTick(bound.priceUpper, input.tickSpacing);
        // Unlike DLMM bin ids, Uniswap tick ranges may share a boundary tick with
        // the neighboring rung — positions are independent ranges, not exhaustive
        // coverage — so no −1 adjustment here.
        return {
            ...rung,
            tickLower,
            tickUpper: Math.max(tickLower + input.tickSpacing, tickUpper)
        };
    });
    return { rungs };
}
//# sourceMappingURL=ladder-plan.js.map