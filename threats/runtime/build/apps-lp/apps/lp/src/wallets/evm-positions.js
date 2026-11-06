import { prefixChainValue } from '@swat/shared';
export function createRobinhoodLpPositionReader(options) {
    void options.protocol; // valuation is protocol-agnostic through the port
    return {
        chain: 'robinhood-chain',
        async readPositions(walletAddress) {
            const views = await options.port.fetchWalletPositions(walletAddress);
            const observed = [];
            for (const view of views) {
                const [price0, price1] = await Promise.all([
                    options.prices.priceUsd(view.token0.toLowerCase()),
                    options.prices.priceUsd(view.token1.toLowerCase())
                ]);
                if (price0 === null || price1 === null)
                    continue;
                observed.push({
                    // An EVM position's identity is its tokenId inside the position
                    // manager, not an address. The chain prefix stays first and the
                    // (contract, tokenId) pair rides behind it:
                    // `robinhood-chain:<positionManager>:<tokenId>`.
                    positionAddress: `robinhood-chain:${options.port.positionManagerAddress.toLowerCase()}:${view.tokenId}`,
                    poolAddress: prefixChainValue(view.poolAddress.toLowerCase(), 'robinhood-chain'),
                    positionValueUsd: view.amount0 * price0 + view.amount1 * price1,
                    uncollectedFeesUsd: view.uncollectedFees0 * price0 + view.uncollectedFees1 * price1,
                    inRange: view.inRange
                });
            }
            return observed;
        }
    };
}
//# sourceMappingURL=evm-positions.js.map