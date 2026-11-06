/**
 * The leg split a straddling rung needs, in value terms — the same sqrt-band
 * math the active-TVL calculator uses, inverted: for a unit of liquidity
 * spanning the rung at the current price, how much value sits in each leg.
 */
export function splitRungLegs(rung, currentPrice) {
    if (rung.priceUpper <= currentPrice) {
        return { amountBase: rung.allocation, amountQuote: 0 };
    }
    if (rung.priceLower >= currentPrice) {
        return { amountBase: 0, amountQuote: rung.allocation };
    }
    const shareBase = Math.log(currentPrice / rung.priceLower) / Math.log(rung.priceUpper / rung.priceLower);
    return {
        amountBase: rung.allocation * shareBase,
        amountQuote: rung.allocation * (1 - shareBase)
    };
}
export function createEvmLadderBuilder(port) {
    return {
        async buildLadder({ plan, recipient, currentPrice, slippageBps = 100 }) {
            const steps = [];
            const deadlineSeconds = Math.floor(Date.now() / 1000) + 1800;
            for (const [index, rung] of plan.rungs.entries()) {
                const legs = splitRungLegs(rung, currentPrice);
                // The quote leg is the deposit asset for a single-token deposit: swap
                // the fraction of the allocation that must become base.
                const baseNeededShare = rung.allocation > 0 ? legs.amountBase / rung.allocation : 0;
                if (baseNeededShare > 0.0001) {
                    steps.push(await port.buildSwapStep({
                        rungIndex: index,
                        kind: 'swap',
                        amountIn: rung.allocation * baseNeededShare,
                        description: `rung ${index}: swap to base for ${Math.round(baseNeededShare * 100)}% of allocation`,
                        payload: { priceLower: rung.priceLower, priceUpper: rung.priceUpper }
                    }, { recipient, slippageBps }));
                }
                steps.push(await port.buildMintStep({
                    rungIndex: index,
                    kind: 'mint-position',
                    description: `rung ${index}: mint ticks [${rung.tickLower}, ${rung.tickUpper}]`,
                    payload: {
                        priceLower: rung.priceLower,
                        priceUpper: rung.priceUpper,
                        tickLower: rung.tickLower,
                        tickUpper: rung.tickUpper,
                        amountBase: legs.amountBase,
                        amountQuote: legs.amountQuote
                    }
                }, { recipient, deadlineSeconds }));
            }
            return steps;
        }
    };
}
//# sourceMappingURL=evm-ladder.js.map