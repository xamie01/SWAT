import {
  createEvmClmmPoolFetcher,
  createViemEvmPoolReader,
  compressedTick,
  bitmapPosition,
  initializedTicksFromBitmap,
  reconstructTickBands,
  type EvmPoolState,
  type EvmPoolReader,
  type EvmVolumeSource,
  type EvmTokenPriceSource,
  type EvmClmmPoolFetcherOptions
} from './evm-clmm-pools.js';
import type { PoolFetcher } from './types.js';

export type RobinhoodPoolState = EvmPoolState;
export type RobinhoodVolumeSource = EvmVolumeSource;
export type RobinhoodTokenPriceSource = EvmTokenPriceSource;
export type RobinhoodPoolReader = EvmPoolReader;

export interface RobinhoodPoolFetcherOptions extends Omit<EvmClmmPoolFetcherOptions, 'chain'> {
  readonly protocol?: 'uniswap-v3' | 'uniswap-v4';
}

export {
  compressedTick,
  bitmapPosition,
  initializedTicksFromBitmap,
  reconstructTickBands
};

export function createViemRobinhoodPoolReader(options: {
  readonly rpcUrl: string;
  readonly configuredPools: readonly string[];
}): RobinhoodPoolReader {
  return createViemEvmPoolReader(options);
}

export function createRobinhoodPoolFetcher(options: RobinhoodPoolFetcherOptions): PoolFetcher {
  return createEvmClmmPoolFetcher({
    ...options,
    chain: 'robinhood-chain'
  });
}
