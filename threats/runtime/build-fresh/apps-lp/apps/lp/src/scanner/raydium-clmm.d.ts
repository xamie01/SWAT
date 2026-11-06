import type { PoolFetcher } from './types.js';
export declare const RAYDIUM_CLMM_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export interface RaydiumPoolState {
    readonly address: string;
    readonly tokenMint0: string;
    readonly tokenMint1: string;
    readonly mint0Decimals: number;
    readonly mint1Decimals: number;
    readonly tickSpacing: number;
    readonly liquidity: bigint;
    readonly sqrtPriceX64: bigint;
    readonly tickCurrent: number;
    readonly feeRate: number;
}
export interface RaydiumRpcPort {
    getAccountInfoBase64(address: string): Promise<string | null>;
    getProgramAccountsMemcmp?(programId: string, offset: number, bytesBase58: string): Promise<{
        pubkey: string;
        dataBase64: string;
    }[]>;
}
export interface RaydiumPriceSource {
    priceUsd(mint: string): Promise<number | null>;
}
export interface RaydiumVolumeSource {
    volume24hUsd(poolAddress: string): Promise<number | null>;
}
export interface RaydiumClmmPoolFetcherOptions {
    readonly rpcPort: RaydiumRpcPort;
    readonly configuredPools: readonly string[];
    readonly priceSource?: RaydiumPriceSource;
    readonly volumeSource?: RaydiumVolumeSource;
    readonly activeTickRange?: number;
}
export declare function decodeRaydiumPoolState(address: string, buffer: Buffer): RaydiumPoolState;
export declare function createRpcRaydiumPort(rpcUrl: string): RaydiumRpcPort;
export declare function createRaydiumClmmPoolFetcher(options: RaydiumClmmPoolFetcherOptions): PoolFetcher;
//# sourceMappingURL=raydium-clmm.d.ts.map