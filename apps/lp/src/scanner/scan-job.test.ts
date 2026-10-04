import { describe, expect, it, vi } from 'vitest';

import { runPoolScan, type UpsertLpPoolPort } from './scan-job.js';
import type { NormalizedPool, PoolFetcher } from './types.js';

function pool(overrides: Partial<NormalizedPool> = {}): NormalizedPool {
  return {
    chain: 'solana',
    protocol: 'meteora-dlmm',
    poolAddress: 'solana:pool-a',
    pairLabel: 'SOL/USDC',
    baseTokenMint: 'solana:sol',
    quoteTokenMint: 'solana:usdc',
    feeBps: 20,
    binStep: 10,
    tickSpacing: null,
    currentPrice: 150,
    tvl: 1_000_000,
    activeTvlUsd: 400_000,
    activeTvlExact: true,
    volume24h: 900_000,
    fees24h: 400,
    fees7d: 2_400,
    ...overrides
  };
}

describe('runPoolScan', () => {
  it('writes every fetched pool with the shared fee APR applied', async () => {
    const upsert = vi.fn<UpsertLpPoolPort['upsert']>(async () => ({}));
    const fetcher: PoolFetcher = {
      chain: 'solana',
      protocol: 'meteora-dlmm',
      fetch: async () => [pool()]
    };

    const summary = await runPoolScan({ fetchers: [fetcher], store: { upsert } });

    expect(summary.scannedByChain.solana).toBe(1);
    expect(summary.failedFetchers).toEqual([]);
    const written = upsert.mock.calls[0][0];
    expect(written.poolAddress).toBe('solana:pool-a');
    expect(written.feeApr24h).toBeCloseTo(400 / 1_000_000, 12);
    expect(written.feeApr7d).toBeCloseTo(2_400 / 1_000_000, 12);
    expect(written.activeTvl).toBe(400_000);
  });

  it('one fetcher failing does not lose the other chain\u2019s scan', async () => {
    const upsert = vi.fn<UpsertLpPoolPort['upsert']>(async () => ({}));
    const failing: PoolFetcher = {
      chain: 'solana',
      protocol: 'meteora-dlmm',
      fetch: async () => {
        throw new Error('API down');
      }
    };
    const working: PoolFetcher = {
      chain: 'robinhood-chain',
      protocol: 'uniswap-v3',
      fetch: async () => [pool({ chain: 'robinhood-chain', protocol: 'uniswap-v3', poolAddress: 'robinhood-chain:0xp' })]
    };

    const summary = await runPoolScan({ fetchers: [failing, working], store: { upsert } });

    expect(summary.scannedByChain['robinhood-chain']).toBe(1);
    expect(summary.failedFetchers).toEqual(['solana:meteora-dlmm']);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
