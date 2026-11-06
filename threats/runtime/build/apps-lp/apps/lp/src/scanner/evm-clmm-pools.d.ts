import { type TickBand } from './active-tvl.js';
import { type EvmSupportedChain } from './evm-clmm-registry.js';
import type { PoolFetcher, LpProtocol } from './types.js';
export interface EvmPoolState {
    readonly address: string;
    readonly token0: string;
    readonly token1: string;
    readonly fee: number;
    readonly tickSpacing: number;
    readonly sqrtPriceX96: bigint;
    readonly tick: number;
    readonly inRangeLiquidity: bigint;
    readonly token0Decimals: number;
    readonly token1Decimals: number;
}
export interface EvmVolumeSource {
    volume24hUsd(address: string): Promise<number | null>;
}
export interface EvmTokenPriceSource {
    priceUsd(token: string): Promise<number | null>;
}
export interface EvmPoolReader {
    listConfiguredPools(): Promise<readonly string[]>;
    readPoolState(address: string): Promise<EvmPoolState>;
    liquidityBands(address: string, currentTick: number, range: number): Promise<readonly TickBand[]>;
}
export interface EvmClmmPoolFetcherOptions {
    readonly chain: EvmSupportedChain;
    readonly protocol?: LpProtocol;
    readonly reader: EvmPoolReader;
    readonly volumeSource?: EvmVolumeSource;
    readonly priceSource?: EvmTokenPriceSource;
    readonly stableQuoteToken?: string;
    readonly activeTickRange?: number;
}
export declare const V3_POOL_ABI: readonly [{
    readonly name: "token0";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "token1";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "fee";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint24";
    }];
}, {
    readonly name: "tickSpacing";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "int24";
    }];
}, {
    readonly name: "slot0";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "sqrtPriceX96";
        readonly type: "uint160";
    }, {
        readonly name: "tick";
        readonly type: "int24";
    }, {
        readonly name: "observationIndex";
        readonly type: "uint16";
    }, {
        readonly name: "observationCardinality";
        readonly type: "uint16";
    }, {
        readonly name: "observationCardinalityNext";
        readonly type: "uint16";
    }, {
        readonly name: "feeProtocol";
        readonly type: "uint8";
    }, {
        readonly name: "unlocked";
        readonly type: "bool";
    }];
}, {
    readonly name: "liquidity";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint128";
    }];
}, {
    readonly name: "decimals";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "uint8";
    }];
}, {
    readonly name: "tickBitmap";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "wordPosition";
        readonly type: "int16";
    }];
    readonly outputs: readonly [{
        readonly type: "uint256";
    }];
}, {
    readonly name: "ticks";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "tick";
        readonly type: "int24";
    }];
    readonly outputs: readonly [{
        readonly name: "liquidityGross";
        readonly type: "uint128";
    }, {
        readonly name: "liquidityNet";
        readonly type: "int128";
    }, {
        readonly name: "feeGrowthOutside0X128";
        readonly type: "uint256";
    }, {
        readonly name: "feeGrowthOutside1X128";
        readonly type: "uint256";
    }, {
        readonly name: "tickCumulativeOutside";
        readonly type: "int56";
    }, {
        readonly name: "secondsPerLiquidityOutsideX128";
        readonly type: "uint160";
    }, {
        readonly name: "secondsOutside";
        readonly type: "uint32";
    }, {
        readonly name: "initialized";
        readonly type: "bool";
    }];
}];
export declare function compressedTick(tick: number, tickSpacing: number): number;
export declare function bitmapPosition(compressed: number): {
    wordPosition: number;
    bitPosition: number;
};
export declare function initializedTicksFromBitmap(wordPosition: number, bitmap: bigint, tickSpacing: number): number[];
export declare function reconstructTickBands(input: {
    readonly currentTick: number;
    readonly tickSpacing: number;
    readonly range: number;
    readonly currentLiquidity: number;
    readonly liquidityNetByTick: ReadonlyMap<number, bigint>;
}): readonly TickBand[];
export declare function createViemEvmPoolReader(options: {
    readonly rpcUrl: string;
    readonly configuredPools: readonly string[];
}): EvmPoolReader;
export declare function createEvmClmmPoolFetcher(options: EvmClmmPoolFetcherOptions): PoolFetcher;
//# sourceMappingURL=evm-clmm-pools.d.ts.map