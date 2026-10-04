import { describe, expect, it } from 'vitest';

import {
  createRobinhoodPoolFetcher,
  type RobinhoodPoolReader,
  type RobinhoodPoolState
} from './robinhood-pools.js';

const state = (overrides: Partial<RobinhoodPoolState> = {}): RobinhoodPoolState => ({
  address: '0x00000000000000000000000000000000000000aa',
  token0: '0x0000000000000000000000000000000000000001',
  token1: '0x0000000000000000000000000000000000000002',
  fee: 3000, // 30 bps
  tickSpacing: 60,
  sqrtPriceX96: 2n ** 96n, // exactly 1.0 quote-per-base for equal decimals
  tick: 0,
  inRangeLiquidity: 500n,
  token0Decimals: 18,
  token1Decimals: 18,
  ...overrides
});

const reader = (overrides: Partial<RobinhoodPoolReader> = {}): RobinhoodPoolReader => ({
  listConfiguredPools: async () => ['0x00000000000000000000000000000000000000aa'],
  readPoolState: async () => state(),
  liquidityBands: async () => [],
  ...overrides
});

describe('createRobinhoodPoolFetcher', () => {
  it('normalizes on-chain state into a chain-prefixed pool with v3 conventions', async () => {
    const pools = await createRobinhoodPoolFetcher({ reader: reader() }).fetch();

    expect(pools).toHaveLength(1);
    const pool = pools[0]!;
    expect(pool.chain).toBe('robinhood-chain');
    expect(pool.protocol).toBe('uniswap-v3');
    expect(pool.poolAddress).toBe('robinhood-chain:0x00000000000000000000000000000000000000aa');
    expect(pool.feeBps).toBe(30); // 3000 hundredths-of-a-bip = 30 bps
    expect(pool.tickSpacing).toBe(60);
    expect(pool.binStep).toBeNull();
    expect(pool.currentPrice).toBeCloseTo(1, 9);
    expect(pool.activeTvlExact).toBe(false); // no band walker yet
  });

  it('computes an exact active TVL when bands and prices are available', async () => {
    const pools = await createRobinhoodPoolFetcher({
      reader: reader({
        liquidityBands: async () => [
          { tickLower: -60, tickUpper: 60, liquidity: 1_000 }
        ]
      }),
      priceSource: {
        priceUsd: async () => 1
      }
    }).fetch();

    const pool = pools[0]!;
    expect(pool.activeTvlExact).toBe(true);
    // Straddle band at tick 0: base + quote both scale with sqrt(60) deltas.
    expect(pool.activeTvlUsd).toBeGreaterThan(0);
    expect(pool.tvl).toBeCloseTo(pool.activeTvlUsd, 9);
  });

  it('reports 0 volume when no volume source can price swaps', async () => {
    const pools = await createRobinhoodPoolFetcher({ reader: reader() }).fetch();
    expect(pools[0]?.volume24h).toBe(0);
  });

  it('passes the volume source through when one is configured', async () => {
    const pools = await createRobinhoodPoolFetcher({
      reader: reader(),
      volumeSource: { volume24hUsd: async () => 12_345 }
    }).fetch();
    expect(pools[0]?.volume24h).toBe(12_345);
  });

  it('carries the v4 protocol tag when configured', async () => {
    const pools = await createRobinhoodPoolFetcher({
      reader: reader(),
      protocol: 'uniswap-v4'
    }).fetch();
    expect(pools[0]?.protocol).toBe('uniswap-v4');
  });
});
