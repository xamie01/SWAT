import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  return {
    clientQuery,
    query: vi.fn(),
    connect: vi.fn(async () => ({
      query: clientQuery,
      release: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    }))
  };
});

vi.mock('./client.js', () => ({
  query: mocks.query,
  pool: { connect: mocks.connect }
}));

import {
  attachLpPoolRisk,
  getLpPool,
  listDiscoverPools,
  listStaleLpPools,
  pruneStaleLpPools,
  upsertLpPool
} from './lp-pools.js';

const poolRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'pool-1',
  chain: 'solana',
  protocol: 'meteora-dlmm',
  pool_address: 'solana:3ucNos4Nbum3ZNF6ndRiMKK4sjKbLRPmv4V7WtH2sApY',
  pair_label: 'SOL/USDC',
  base_token_mint: 'solana:So11111111111111111111111111111111111111112',
  quote_token_mint: 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  fee_bps: 20,
  bin_step: 10,
  tick_spacing: null,
  tvl: 1_000_000,
  active_tvl: 400_000,
  volume_24h: 900_000,
  fee_apr_24h: 0.42,
  fee_apr_7d: 0.39,
  risk_score: null,
  risk_flags: [],
  last_scanned_at: new Date('2026-10-04T00:00:00Z'),
  created_at: new Date('2026-10-04T00:00:00Z'),
  ...overrides
});

beforeEach(() => {
  mocks.query.mockReset();
  mocks.clientQuery.mockReset();
});

describe('lp-pools', () => {
  it('refuses an unprefixed pool address before touching the database', async () => {
    await expect(
      upsertLpPool({
        chain: 'solana',
        protocol: 'meteora-dlmm',
        poolAddress: '3ucNos4Nbum3ZNF6ndRiMKK4sjKbLRPmv4V7WtH2sApY',
        pairLabel: 'SOL/USDC',
        baseTokenMint: 'solana:So11111111111111111111111111111111111111112',
        quoteTokenMint: 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        feeBps: 20,
        binStep: 10,
        tvl: 1,
        activeTvl: 1,
        volume24h: 1
      })
    ).rejects.toThrow('chain-prefixed');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('refuses negative scanner numbers', async () => {
    await expect(
      upsertLpPool({
        chain: 'solana',
        protocol: 'meteora-dlmm',
        poolAddress: 'solana:pool',
        pairLabel: 'SOL/USDC',
        baseTokenMint: 'solana:a',
        quoteTokenMint: 'solana:b',
        feeBps: 20,
        binStep: 10,
        tvl: -1,
        activeTvl: 1,
        volume24h: 1
      })
    ).rejects.toThrow('non-negative');
  });

  it('upserts a scan observation with last_scanned_at set by the database', async () => {
    const row = poolRow();
    mocks.query.mockResolvedValueOnce([row]);

    const stored = await upsertLpPool({
      chain: 'solana',
      protocol: 'meteora-dlmm',
      poolAddress: 'solana:pool',
      pairLabel: 'SOL/USDC',
      baseTokenMint: 'solana:a',
      quoteTokenMint: 'solana:b',
      feeBps: 20,
      binStep: 10,
      tvl: 1_000_000,
      activeTvl: 400_000,
      volume24h: 900_000,
      feeApr24h: 0.42
    });

    expect(stored.poolAddress).toBe('solana:3ucNos4Nbum3ZNF6ndRiMKK4sjKbLRPmv4V7WtH2sApY');
    expect(stored.riskScore).toBeNull();
    expect(stored.riskFlags).toEqual([]);
    const sql = String(mocks.query.mock.calls[0][0]);
    expect(sql).toContain('ON CONFLICT (chain, protocol, pool_address)');
    expect(sql).toContain('EXCLUDED.last_scanned_at');
  });

  it('excludes unassessed pools from the Discover feed in SQL, not in the caller', async () => {
    mocks.query.mockResolvedValueOnce([poolRow({ risk_score: 12 })]);
    await listDiscoverPools({ chain: 'solana', limit: 10 });
    const sql = String(mocks.query.mock.calls[0][0]);
    expect(sql).toContain('risk_score IS NOT NULL');
    expect(sql).toContain('ORDER BY volume_24h DESC');
  });

  it('rejects an out-of-range page limit', async () => {
    await expect(listDiscoverPools({ limit: 0 })).rejects.toThrow('limit');
    await expect(listDiscoverPools({ limit: 201 })).rejects.toThrow('limit');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('attaches risk only for a finite score in 0..100', async () => {
    mocks.query.mockResolvedValueOnce([]);
    await attachLpPoolRisk('solana', 'solana:pool', 35, ['bundled-launch']);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain('SET risk_score = $3');
    expect(params[2]).toBe(35);
    expect(params[3]).toBe(JSON.stringify(['bundled-launch']));

    await expect(attachLpPoolRisk('solana', 'solana:pool', 101, [])).rejects.toThrow('0..100');
  });

  it('lists stale pools oldest-first and prunes by the same window', async () => {
    mocks.query.mockResolvedValueOnce([poolRow()]);
    await listStaleLpPools(600, 50);
    expect(String(mocks.query.mock.calls[0][0])).toContain('ORDER BY last_scanned_at');

    mocks.query.mockResolvedValueOnce([{ pool_address: 'solana:pool' }]);
    await expect(pruneStaleLpPools(86_400)).resolves.toBe(1);
    expect(String(mocks.query.mock.calls[1][0])).toContain('DELETE FROM lp_pools');
  });

  it('returns null for an unknown pool without throwing', async () => {
    mocks.query.mockResolvedValueOnce([]);
    await expect(getLpPool('solana', 'solana:missing')).resolves.toBeNull();
  });
});
