import { describe, expect, it } from 'vitest';

import { createMeteoraPoolFetcher, type MeteoraPairApiRow } from './meteora-pools.js';

const apiRow = (overrides: Partial<MeteoraPairApiRow> = {}): MeteoraPairApiRow => ({
  address: '3ucNos4Nbum3ZNF6ndRiMKK4sjKbLRPmv4V7WtH2sApY',
  name: 'SOL/USDC',
  mint_x: 'So11111111111111111111111111111111111111112',
  mint_y: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  bin_step: 10,
  base_fee_percentage: 0.0002,
  current_price: 150.25,
  tvl: 1_000_000,
  trade_volume_24h: 900_000,
  fees_24h: 420,
  fees_7d: 2_800,
  ...overrides
});

function fetcherWith(rows: readonly MeteoraPairApiRow[], options = {}) {
  return createMeteoraPoolFetcher({
    apiBase: 'https://dlmm-api.test',
    fetchImpl: (async () =>
      new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch,
    ...options
  });
}

describe('createMeteoraPoolFetcher', () => {
  it('normalizes API rows into chain-prefixed pools', async () => {
    const pools = await fetcherWith([apiRow()]).fetch();

    expect(pools).toHaveLength(1);
    const pool = pools[0]!;
    expect(pool.poolAddress).toBe('solana:3ucNos4Nbum3ZNF6ndRiMKK4sjKbLRPmv4V7WtH2sApY');
    expect(pool.baseTokenMint).toBe('solana:So11111111111111111111111111111111111111112');
    expect(pool.quoteTokenMint).toBe('solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(pool.feeBps).toBeCloseTo(2, 9); // 0.0002 fraction = 2 bps
    expect(pool.binStep).toBe(10);
    expect(pool.tickSpacing).toBeNull();
    expect(pool.tvl).toBe(1_000_000);
    expect(pool.fees24h).toBe(420);
    expect(pool.fees7d).toBe(2_800);
    expect(pool.activeTvlExact).toBe(false); // no bin source in this fixture
    expect(pool.activeTvlUsd).toBe(1_000_000); // ceiling fallback
  });

  it('uses the bin source and prices for an exact active TVL', async () => {
    const pools = await fetcherWith([apiRow()], {
      tokenPrices: {
        prices: new Map([
          ['solana:So11111111111111111111111111111111111111112', 150],
          ['solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 1]
        ])
      },
      binSource: {
        fetchBins: async () => ({
          activeBinId: 100,
          bins: [
            { binId: 100, price: 150, baseAmount: 2, quoteAmount: 100 },
            { binId: 300, price: 160, baseAmount: 50, quoteAmount: 0 } // out of range
          ]
        })
      },
      activeBinRange: 10
    }).fetch();

    const pool = pools[0]!;
    expect(pool.activeTvlExact).toBe(true);
    // 2 * 150 * 150 + 100 * 1 = 45000 + 100 = 45100
    expect(pool.activeTvlUsd).toBeCloseTo(45_100, 9);
  });

  it('skips malformed rows instead of failing the whole scan', async () => {
    const pools = await fetcherWith([
      apiRow(),
      { ...apiRow({ address: '', name: 'broken' }) }
    ]).fetch();
    expect(pools).toHaveLength(1);
  });

  it('throws on an API error status so the scan job can report the failed fetcher', async () => {
    const failing = createMeteoraPoolFetcher({
      apiBase: 'https://dlmm-api.test',
      fetchImpl: (async () => new Response('boom', { status: 503 })) as typeof fetch
    });
    await expect(failing.fetch()).rejects.toThrow('503');
  });
});
