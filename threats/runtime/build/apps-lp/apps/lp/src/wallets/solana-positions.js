import { prefixChainValue } from '@swat/shared';
export function createSolanaLpPositionReader(options) {
    return {
        chain: 'solana',
        async readPositions(walletAddress) {
            const pairs = await options.port.fetchUserPositions(walletAddress);
            const observed = [];
            for (const pair of pairs) {
                const [basePriceUsd, quotePriceUsd] = await Promise.all([
                    options.prices.priceUsd(prefixChainValue(pair.baseMint, 'solana')),
                    options.prices.priceUsd(prefixChainValue(pair.quoteMint, 'solana'))
                ]);
                if (basePriceUsd === null || quotePriceUsd === null)
                    continue;
                // Each leg is priced once, in USD per token. `currentPrice` is
                // quote-per-base — multiplying it in as well would double-count the
                // quote leg's unit and inflate the base leg by the pool price.
                const positionValueUsd = pair.baseAmount * basePriceUsd + pair.quoteAmount * quotePriceUsd;
                const uncollectedFeesUsd = pair.uncollectedBaseFees * basePriceUsd
                    + pair.uncollectedQuoteFees * quotePriceUsd;
                observed.push({
                    positionAddress: prefixChainValue(pair.positionAddress, 'solana'),
                    poolAddress: prefixChainValue(pair.pairAddress, 'solana'),
                    positionValueUsd,
                    uncollectedFeesUsd,
                    inRange: pair.inRange
                });
            }
            return observed;
        }
    };
}
//# sourceMappingURL=solana-positions.js.map