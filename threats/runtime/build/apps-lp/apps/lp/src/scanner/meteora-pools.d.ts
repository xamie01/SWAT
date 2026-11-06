import type { MeteoraBin } from './active-tvl.js';
import type { PoolFetcher } from './types.js';
type NumericWindow = Readonly<Record<string, number | string | undefined>>;
export interface MeteoraTokenApiRow {
    readonly address: string;
    readonly price?: number | string;
}
export interface MeteoraPairApiRow {
    readonly address: string;
    readonly name: string;
    readonly token_x: MeteoraTokenApiRow;
    readonly token_y: MeteoraTokenApiRow;
    readonly pool_config: {
        readonly bin_step: number;
        readonly base_fee_pct?: number | string;
    };
    readonly current_price?: number | string;
    readonly tvl?: number | string;
    readonly volume?: NumericWindow;
    readonly fees?: NumericWindow;
}
export interface MeteoraPoolsApiResponse {
    readonly total: number;
    readonly pages: number;
    readonly current_page: number;
    readonly page_size: number;
    readonly data: readonly MeteoraPairApiRow[];
}
export interface MeteoraTokenPrices {
    /** USD price by chain-prefixed mint; null when unknown. */
    readonly prices: ReadonlyMap<string, number>;
    /** Assumed USD price for the quote leg when it has no oracle entry (stables). */
    readonly stableQuotePriceUsd?: number;
}
export interface MeteoraBinSource {
    fetchBins(poolAddress: string): Promise<{
        bins: readonly MeteoraBin[];
        activeBinId: number;
        binStep?: number;
    }>;
}
export interface MeteoraPoolFetcherOptions {
    readonly apiBase?: string;
    readonly fetchImpl?: typeof fetch;
    /** Restrict the scan to one pair, e.g. `SOL/USDC`. */
    readonly searchTerm?: string;
    /** Maximum number of pools returned across all API pages. */
    readonly maxPairs?: number;
    readonly tokenPrices?: MeteoraTokenPrices;
    readonly binSource?: MeteoraBinSource;
    readonly activeBinRange?: number;
}
export declare function createMeteoraPoolFetcher(options?: MeteoraPoolFetcherOptions): PoolFetcher;
export {};
//# sourceMappingURL=meteora-pools.d.ts.map