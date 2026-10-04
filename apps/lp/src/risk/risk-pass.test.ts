import { describe, expect, it, vi } from 'vitest';

// risk-pass.ts hard-imports the db module for its default ports; mocking keeps
// this a unit test — the real client throws without DATABASE_URL at import.
const dbMocks = vi.hoisted(() => ({
  attachLpPoolRisk: vi.fn(),
  listUnassessedLpPools: vi.fn()
}));
vi.mock('@swat/db', () => dbMocks);

import { runRiskPass } from './risk-pass.js';
import { attachLpPoolRisk, listUnassessedLpPools, type LpPool } from '@swat/db';
import type { TokenRiskCheck } from './types.js';

function pool(overrides: Partial<LpPool> = {}): LpPool {
  return {
    id: 'pool-1',
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
    activeTvl: 400_000,
    volume24h: 900_000,
    feeApr24h: 0.004,
    feeApr7d: 0.024,
    riskScore: null,
    riskFlags: [],
    lastScannedAt: new Date(),
    createdAt: new Date(),
    ...overrides
  };
}

describe('runRiskPass', () => {
  it('scores each unassessed pool with its chain\u2019s checks and attaches the result', async () => {
    const listUnassessed = vi.fn<typeof listUnassessedLpPools>(async () => [pool()]);
    const attachRisk = vi.fn<typeof attachLpPoolRisk>(async () => undefined);
    const mintFlag: TokenRiskCheck = async () => [
      { flag: 'mint_authority_active', detail: 'can mint' }
    ];

    const summary = await runRiskPass({
      checksByChain: { solana: [mintFlag] },
      listUnassessed,
      attachRisk
    });

    expect(summary).toEqual({ assessed: 1, failed: 0 });
    const [chain, address, score, flags] = attachRisk.mock.calls[0];
    expect(chain).toBe('solana');
    expect(address).toBe('solana:pool-a');
    expect(score).toBe(50);
    expect(flags).toEqual(['mint_authority_active']);
  });

  it('one pool failing its checks leaves it unassessed and reports the failure', async () => {
    const listUnassessed = vi.fn<typeof listUnassessedLpPools>(async () => [
      pool(),
      pool({ id: 'pool-2', poolAddress: 'solana:pool-b' })
    ]);
    const attachRisk = vi.fn<typeof attachLpPoolRisk>(async () => undefined);
    const failingCheck: TokenRiskCheck = async (context) => {
      if (context.poolAddress === 'solana:pool-b') {
        throw new Error('RPC timeout');
      }
      return [];
    };

    const summary = await runRiskPass({
      checksByChain: { solana: [failingCheck] },
      listUnassessed,
      attachRisk
    });

    expect(summary).toEqual({ assessed: 1, failed: 1 });
    expect(attachRisk).toHaveBeenCalledTimes(1);
    expect(attachRisk.mock.calls[0][1]).toBe('solana:pool-a');
  });

  it('a chain with no configured checks produces a clean score rather than an exception', async () => {
    const listUnassessed = vi.fn<typeof listUnassessedLpPools>(async () => [pool({ chain: 'robinhood-chain' })]);
    const attachRisk = vi.fn<typeof attachLpPoolRisk>(async () => undefined);

    const summary = await runRiskPass({
      checksByChain: { solana: [] },
      listUnassessed,
      attachRisk
    });

    expect(summary).toEqual({ assessed: 1, failed: 0 });
    expect(attachRisk.mock.calls[0][2]).toBe(0);
  });
});
