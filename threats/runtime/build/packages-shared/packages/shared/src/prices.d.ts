import type { Chain } from './types.js';
export type DexScreenerChainId = 'solana' | 'polygon' | 'robinhood' | 'base' | 'ethereum' | 'bsc';
export type DexScreenerPair = {
    chainId: string;
    priceUsd?: string | number | null;
    liquidity?: {
        usd?: string | number | null;
    } | null;
    baseToken?: {
        address?: string;
        name?: string;
        symbol?: string;
    } | null;
};
export declare function getDexScreenerChainId(chain: Chain): DexScreenerChainId;
export declare function selectDexScreenerPair(pairs: unknown, chain: Chain): DexScreenerPair | null;
export declare function fetchDexScreenerPrice(tokenMint: string, requestedChain?: Chain): Promise<number | null>;
export declare function fetchDexScreenerLiquidity(tokenMint: string, requestedChain?: Chain): Promise<number | null>;
export declare function fetchRobinhoodChainPrice(tokenMint: string): Promise<number | null>;
export declare function fetchCoinGeckoPrice(tokenMint: string, chain?: Exclude<Chain, 'robinhood-chain'>): Promise<number | null>;
export declare function fetchJupiterPrice(tokenMint: string): Promise<number | null>;
export declare function fetchTokenPriceUsd(tokenMint: string): Promise<number | null>;
export declare function fetchTokenMetadata(tokenMint: string): Promise<{
    name: string;
    symbol: string;
} | null>;
//# sourceMappingURL=prices.d.ts.map