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
/** One DLMM bin, human-scale. `price` is quote-per-base at that bin. */
export interface MeteoraBin {
    readonly binId: number;
    readonly price: number;
    readonly baseAmount: number;
    readonly quoteAmount: number;
}
export interface MeteoraActiveTvlContext {
    readonly protocol: 'meteora-dlmm';
    readonly bins: readonly MeteoraBin[];
    readonly activeBinId: number;
    /** Half-width of the window, in bins. Bins with |binId − activeBinId| ≤ range count. */
    readonly range: number;
    readonly basePriceUsd: number | null;
    readonly quotePriceUsd: number | null;
}
/** One tick band from a `liquidityNet` walk, human-scale. */
export interface TickBand {
    readonly tickLower: number;
    readonly tickUpper: number;
    /** Net liquidity active for the whole band. */
    readonly liquidity: number;
}
export interface UniswapActiveTvlContext {
    readonly protocol: 'uniswap-v3' | 'uniswap-v4' | 'pancakeswap-v3' | 'raydium-clmm';
    readonly bands: readonly TickBand[];
    readonly currentTick: number;
    /** Half-width of the window, in ticks. */
    readonly range: number;
    readonly basePriceUsd: number | null;
    readonly quotePriceUsd: number | null;
    /** Token decimals for raw Uniswap/CLMM liquidity math; defaults to human-scale (0). */
    readonly baseTokenDecimals?: number;
    readonly quoteTokenDecimals?: number;
}
export type TickActiveTvlContext = UniswapActiveTvlContext;
export type ActiveTvlContext = MeteoraActiveTvlContext | UniswapActiveTvlContext;
export interface ActiveTvlCalculator {
    /** USD value of liquidity near the current price, or null when unpriced. */
    calculateActiveTvl(context: ActiveTvlContext): number | null;
}
export declare function createActiveTvlCalculator(): ActiveTvlCalculator;
//# sourceMappingURL=active-tvl.d.ts.map