/** Which side(s) of the current price a rung's bin range sits on. */
export function splitRungAmounts(rung, currentPrice) {
    if (rung.binLower === undefined || rung.binUpper === undefined) {
        throw new Error('meteora rung is missing its bin range');
    }
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        throw new Error(`currentPrice must be positive, got ${currentPrice}`);
    }
    if (rung.priceUpper <= currentPrice) {
        // Entirely below price: all base (X).
        return { totalXAmount: rung.allocation, totalYAmount: 0 };
    }
    if (rung.priceLower >= currentPrice) {
        // Entirely above price: all quote (Y).
        return { totalXAmount: 0, totalYAmount: rung.allocation };
    }
    // Straddling: split by log-share of the range below price.
    const shareBelow = Math.log(currentPrice / rung.priceLower) / Math.log(rung.priceUpper / rung.priceLower);
    return {
        totalXAmount: rung.allocation * shareBelow,
        totalYAmount: rung.allocation * (1 - shareBelow)
    };
}
export function createMeteoraLadderBuilder(port) {
    return {
        async buildLadder({ plan, userAddress, currentPrice, distribution, slippageBps = 100 }) {
            const steps = [];
            for (const [index, rung] of plan.rungs.entries()) {
                const amounts = splitRungAmounts(rung, currentPrice);
                const step = {
                    rungIndex: index,
                    kind: 'initialize-position-and-add-liquidity',
                    ...amounts,
                    binLower: rung.binLower,
                    binUpper: rung.binUpper,
                    strategy: distribution,
                    description: `rung ${index}: bins ${rung.binLower}..${rung.binUpper}`
                };
                steps.push(await port.buildRungStep(step, { userAddress, slippageBps }));
            }
            return steps;
        }
    };
}
//# sourceMappingURL=meteora-ladder.js.map