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
    expect(sql).toContain('ON CONFLICT (account, signal_id) DO NOTHING');
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
      8.5
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
    expect(params).toEqual(['operator', 'signal-1']);
  });
});
