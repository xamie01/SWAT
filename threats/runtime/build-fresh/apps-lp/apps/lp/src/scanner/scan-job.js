import { realizedFeeApr } from './fee-apr.js';
export async function runPoolScan(deps) {
    const scannedByChain = {};
    const failedFetchers = [];
    for (const fetcher of deps.fetchers) {
        try {
            const pools = await fetcher.fetch();
            let written = 0;
            for (const pool of pools) {
                const apr = realizedFeeApr({ fees24h: pool.fees24h, fees7d: pool.fees7d, tvl: pool.tvl });
                await deps.store.upsert({
                    chain: pool.chain,
                    protocol: pool.protocol,
                    poolAddress: pool.poolAddress,
                    pairLabel: pool.pairLabel,
                    baseTokenMint: pool.baseTokenMint,
                    quoteTokenMint: pool.quoteTokenMint,
                    feeBps: pool.feeBps,
                    binStep: pool.binStep,
                    tickSpacing: pool.tickSpacing,
                    currentPrice: pool.currentPrice,
                    tvl: pool.tvl,
                    activeTvl: pool.activeTvlUsd,
                    volume24h: pool.volume24h,
                    feeApr24h: apr.feeApr24h,
                    feeApr7d: apr.feeApr7d
                });
                written += 1;
            }
            scannedByChain[fetcher.chain] = (scannedByChain[fetcher.chain] ?? 0) + written;
        }
        catch (error) {
            failedFetchers.push(`${fetcher.chain}:${fetcher.protocol}`);
            console.error(`[lp] scan fetcher failed for ${fetcher.chain}/${fetcher.protocol}:`, error instanceof Error ? error.message : error);
        }
    }
    return { scannedByChain, failedFetchers };
}
//# sourceMappingURL=scan-job.js.map