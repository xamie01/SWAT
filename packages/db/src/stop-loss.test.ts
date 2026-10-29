import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock('./client.js', () => ({
  query: mocks.query
}));

import {
  claimStopLossTrigger,
  isStopLossBreached,
  positionDrawdownPct,
  releaseStopLossTrigger
} from './stop-loss.js';
import type { OpenPositionSnapshot } from './stop-loss.js';

function position(overrides: Partial<OpenPositionSnapshot> = {}): OpenPositionSnapshot {
  return {
    signalId: 'signal-1',
    // `null` IS the pre-tenancy operator account, not an absent value (`S4-M46`).
    userId: null,
    tokenMint: 'solana:token-1',
    chain: 'solana',
    openQuantity: 100,
    openCostBasisUsd: 1000,
    unrealizedPnlUsd: -150,
    currentPriceUsd: 8.5,
    ...overrides
  };
}

describe('positionDrawdownPct', () => {
  it('reports the loss as a percentage of cost basis', () => {
    expect(positionDrawdownPct(position())).toBeCloseTo(15, 10);
  });

  it('reports a negative drawdown for a position in profit', () => {
    expect(positionDrawdownPct(position({ unrealizedPnlUsd: 200 }))).toBeCloseTo(-20, 10);
  });

  it('returns null when there is nothing left to sell', () => {
    expect(positionDrawdownPct(position({ openQuantity: 0 }))).toBeNull();
    expect(positionDrawdownPct(position({ openQuantity: -5 }))).toBeNull();
  });

  it('returns null rather than dividing by a zero or missing cost basis', () => {
    expect(positionDrawdownPct(position({ openCostBasisUsd: 0 }))).toBeNull();
    expect(positionDrawdownPct(position({ openCostBasisUsd: Number.NaN }))).toBeNull();
  });

  it('returns null when P&L is not a finite number', () => {
    expect(positionDrawdownPct(position({ unrealizedPnlUsd: Number.NaN }))).toBeNull();
  });
});

describe('isStopLossBreached', () => {
  it('breaches once the drawdown reaches the threshold', () => {
    expect(isStopLossBreached(position(), 15)).toBe(true);
  });

  it('does not breach just under the threshold', () => {
    expect(isStopLossBreached(position({ unrealizedPnlUsd: -149.9 }), 15)).toBe(false);
  });

  it('never breaches on a winning position', () => {
    expect(isStopLossBreached(position({ unrealizedPnlUsd: 500 }), 15)).toBe(false);
  });

  it('treats a non-positive threshold as stop-loss disabled', () => {
    expect(isStopLossBreached(position({ unrealizedPnlUsd: -1000 }), 0)).toBe(false);
    expect(isStopLossBreached(position({ unrealizedPnlUsd: -1000 }), -5)).toBe(false);
    expect(isStopLossBreached(position({ unrealizedPnlUsd: -1000 }), Number.NaN)).toBe(false);
  });

  it('does not breach when the drawdown cannot be computed', () => {
    expect(isStopLossBreached(position({ openCostBasisUsd: 0 }), 15)).toBe(false);
  });
});

describe('claimStopLossTrigger', () => {
  const claim = {
    account: 'operator',
    signalId: 'signal-1',
    chain: 'solana' as const,
    tokenMint: 'solana:token-1',
    thresholdPct: 15,
    drawdownPct: 22.5,
    openQuantity: 100,
    openCostBasisUsd: 1000,
    priceUsd: 8.5
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claims a position exactly once', async () => {
    mocks.query.mockResolvedValueOnce([{ signal_id: 'signal-1' }]);
    await expect(claimStopLossTrigger(claim)).resolves.toBe(true);

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (account, signal_id, position_key) DO NOTHING');
    expect(sql).toContain('RETURNING signal_id');
    expect(params).toEqual([
      'operator',
      'signal-1',
      'solana',
      'solana:token-1',
      15,
      22.5,
      100,
      1000,
      8.5,
      ''
    ]);
  });

  it('reports a losing race as already claimed', async () => {
    mocks.query.mockResolvedValueOnce([]);
    await expect(claimStopLossTrigger(claim)).resolves.toBe(false);
  });

  it('releases a claim so the next sweep can retry', async () => {
    mocks.query.mockResolvedValueOnce([]);
    await releaseStopLossTrigger('operator', 'signal-1');

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM signal_stop_losses');
    expect(params).toEqual(['operator', 'signal-1', '']);
  });

  it('carries a user id into the account column, on one signal, for two tenants (S4-M46)', async () => {
    // The DB half was already account-parameterised, which is what made `S4-M46` a
    // caller-side defect. This pins the column the sweep now varies: two tenants on ONE
    // signal must reach `ON CONFLICT (account, signal_id)` with different first
    // parameters, or the second insert is swallowed and that holder is never sold.
    //
    // `account` is `VARCHAR(64)` (034) and a UUID is 36 characters, so a `users.id`
    // fits. It is a label rather than a `users(id)` foreign key, which is why the raw id
    // is written without `normalizeTenantId`.
    mocks.query.mockResolvedValue([{ signal_id: 'shared-signal' }]);

    await claimStopLossTrigger({
      ...claim,
      account: '11111111-1111-4111-8111-111111111111',
      signalId: 'shared-signal'
    });
    await claimStopLossTrigger({
      ...claim,
      account: '22222222-2222-4222-8222-222222222222',
      signalId: 'shared-signal'
    });

    const accounts = mocks.query.mock.calls.map(([, params]) => (params as unknown[])[0]);
    expect(accounts).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222'
    ]);
    expect(String(accounts[0]).length).toBeLessThanOrEqual(64);
  });

  it('releases only the account it was given, never a co-holder’s claim', async () => {
    mocks.query.mockResolvedValueOnce([]);
    await releaseStopLossTrigger('11111111-1111-4111-8111-111111111111', 'shared-signal');

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('WHERE account = $1 AND signal_id = $2');
    expect(params).toEqual(['11111111-1111-4111-8111-111111111111', 'shared-signal', '']);
  });
});
