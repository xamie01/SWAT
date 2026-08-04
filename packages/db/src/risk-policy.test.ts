import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock('./client.js', () => ({
  query: mocks.query
}));

import { clearRiskPolicyCache, resolveRiskPolicy } from './risk-policy.js';

const ENV_KEYS = [
  'PAPER_MAX_POSITION_PCT',
  'USDC_BALANCE_RISK_PCT',
  'ETH_BALANCE_RISK_PCT',
  'DAILY_EXPOSURE_PCT',
  'STOP_LOSS_PCT'
] as const;

describe('resolveRiskPolicy', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    clearRiskPolicyCache();
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    mocks.query.mockResolvedValue([]);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    clearRiskPolicyCache();
  });

  it('prefers DB config over env and defaults', async () => {
    process.env.STOP_LOSS_PCT = '10';
    mocks.query.mockResolvedValue([
      { key: 'trading', value: { max_position_pct: 3, max_daily_exposure_pct: 12, min_liquidity_usd: 25000 } },
      { key: 'risk', value: { stop_loss_pct: 18, circuit_breaker_failures: 5 } }
    ]);

    await expect(resolveRiskPolicy('operator', 'solana')).resolves.toEqual({
      maxPositionPct: 3,
      maxDailyExposurePct: 12,
      stopLossPct: 18,
      maxConsecutiveFailures: 5,
      minLiquidityUsd: 25000
    });
  });

  it('falls back to env when the DB has no config row', async () => {
    process.env.STOP_LOSS_PCT = '12.5';
    process.env.PAPER_MAX_POSITION_PCT = '4';

    const policy = await resolveRiskPolicy('operator', 'solana');
    expect(policy.stopLossPct).toBe(12.5);
    expect(policy.maxPositionPct).toBe(4);
  });

  it('does not serve one chain the other chain policy from cache', async () => {
    // The chain-specific env fallbacks are the reason the cache must be keyed
    // by chain: a shared slot returned polygon's sizing for robinhood-chain.
    process.env.USDC_BALANCE_RISK_PCT = '2';
    process.env.ETH_BALANCE_RISK_PCT = '9';

    const polygon = await resolveRiskPolicy('operator', 'polygon');
    const robinhood = await resolveRiskPolicy('operator', 'robinhood-chain');

    expect(polygon.maxPositionPct).toBe(2);
    expect(robinhood.maxPositionPct).toBe(9);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it('serves a repeat lookup for the same chain from cache', async () => {
    await resolveRiskPolicy('operator', 'solana');
    await resolveRiskPolicy('operator', 'solana');
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent lookups for the same chain into one query', async () => {
    const [a, b] = await Promise.all([
      resolveRiskPolicy('operator', 'solana'),
      resolveRiskPolicy('operator', 'solana')
    ]);
    expect(a).toEqual(b);
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it('clamps the breaker threshold to at least one failure', async () => {
    mocks.query.mockResolvedValue([{ key: 'risk', value: { circuit_breaker_failures: 0 } }]);
    const policy = await resolveRiskPolicy('operator', 'solana');
    expect(policy.maxConsecutiveFailures).toBe(1);
  });

  it('ignores non-numeric config values', async () => {
    process.env.STOP_LOSS_PCT = 'not-a-number';
    mocks.query.mockResolvedValue([{ key: 'risk', value: { stop_loss_pct: '' } }]);

    const policy = await resolveRiskPolicy('operator', 'solana');
    expect(Number.isFinite(policy.stopLossPct)).toBe(true);
    expect(policy.stopLossPct).toBeGreaterThan(0);
  });
});
