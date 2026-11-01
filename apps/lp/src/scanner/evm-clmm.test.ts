import { describe, expect, it } from 'vitest';
import {
  createEvmClmmPoolFetcher,
  type EvmPoolReader,
  type EvmPoolState
} from './evm-clmm-pools.js';
import { EVM_CLMM_NETWORKS } from './evm-clmm-registry.js';

const mockState = (overrides: Partial<EvmPoolState> = {}): EvmPoolState => ({
  address: '0x00000000000000000000000000000000000000aa',
  token0: '0x0000000000000000000000000000000000000001',
  token1: '0x0000000000000000000000000000000000000002',
  fee: 3000,
  tickSpacing: 60,
  sqrtPriceX96: 2n ** 96n,
  tick: 0,
  inRangeLiquidity: 1000n,
  token0Decimals: 18,
  token1Decimals: 18,
  ...overrides
});

const mockReader = (overrides: Partial<EvmPoolReader> = {}): EvmPoolReader => ({
  listConfiguredPools: async () => ['0x00000000000000000000000000000000000000aa'],
  readPoolState: async () => mockState(),
  liquidityBands: async () => [
    { tickLower: -60, tickUpper: 60, liquidity: 1000 }
  ],
  ...overrides
});

describe('EVM CLMM Registry', () => {
  it('registers Base, Ethereum, BSC, and Robinhood Chain with default configs', () => {
    expect(EVM_CLMM_NETWORKS.base.defaultProtocol).toBe('uniswap-v3');
    expect(EVM_CLMM_NETWORKS.ethereum.defaultProtocol).toBe('uniswap-v3');
    expect(EVM_CLMM_NETWORKS.bsc.defaultProtocol).toBe('pancakeswap-v3');
    expect(EVM_CLMM_NETWORKS['robinhood-chain'].defaultProtocol).toBe('uniswap-v3');
  });
});

describe('createEvmClmmPoolFetcher', () => {
  it('fetches and normalizes a Base Uniswap v3 pool', async () => {
    const fetcher = createEvmClmmPoolFetcher({
      chain: 'base',
      reader: mockReader(),
      priceSource: {
        priceUsd: async () => 2500
      }
    });

    expect(fetcher.chain).toBe('base');
    expect(fetcher.protocol).toBe('uniswap-v3');

    const pools = await fetcher.fetch();
    expect(pools).toHaveLength(1);
    expect(pools[0]!.chain).toBe('base');
    expect(pools[0]!.protocol).toBe('uniswap-v3');
    expect(pools[0]!.poolAddress).toBe('base:0x00000000000000000000000000000000000000aa');
    expect(pools[0]!.currentPrice).toBe(1);
    expect(pools[0]!.feeBps).toBe(30);
  });

  it('fetches and normalizes a BSC PancakeSwap v3 pool', async () => {
    const fetcher = createEvmClmmPoolFetcher({
      chain: 'bsc',
      reader: mockReader(),
      priceSource: {
        priceUsd: async () => 600
      }
    });

    expect(fetcher.chain).toBe('bsc');
    expect(fetcher.protocol).toBe('pancakeswap-v3');

    const pools = await fetcher.fetch();
    expect(pools).toHaveLength(1);
    expect(pools[0]!.chain).toBe('bsc');
    expect(pools[0]!.protocol).toBe('pancakeswap-v3');
    expect(pools[0]!.poolAddress).toBe('bsc:0x00000000000000000000000000000000000000aa');
  });

  it('fetches and normalizes an Ethereum Uniswap v3 pool', async () => {
    const fetcher = createEvmClmmPoolFetcher({
      chain: 'ethereum',
      reader: mockReader(),
      priceSource: {
        priceUsd: async () => 3000
      }
    });

    expect(fetcher.chain).toBe('ethereum');
    expect(fetcher.protocol).toBe('uniswap-v3');

    const pools = await fetcher.fetch();
    expect(pools).toHaveLength(1);
    expect(pools[0]!.chain).toBe('ethereum');
    expect(pools[0]!.poolAddress).toBe('ethereum:0x00000000000000000000000000000000000000aa');
  });
});
