import { describe, expect, it } from 'vitest';

import { computeWalletPositionPnl } from './pnl.js';

const t0 = Date.parse('2026-10-01T00:00:00Z');

function point(hoursAfter: number, value: number, fees: number) {
  return {
    capturedAt: new Date(t0 + hoursAfter * 3_600_000),
    positionValueUsd: value,
    uncollectedFeesUsd: fees,
    inRange: true
  };
}

describe('computeWalletPositionPnl', () => {
  it('nets fee growth and inventory growth through the shared netLpResult', () => {
    const pnl = computeWalletPositionPnl([
      point(0, 1_000, 0),
      point(24, 1_050, 12)
    ]);
    expect(pnl?.feesEarnedUsd).toBe(12);
    expect(pnl?.inventoryChangeUsd).toBe(50);
    expect(pnl?.netResultUsd).toBe(62);
    expect(pnl?.closed).toBe(false);
  });

  it('a shrinking position nets negative', () => {
    const pnl = computeWalletPositionPnl([
      point(0, 2_000, 40),
      point(48, 1_700, 45)
    ]);
    expect(pnl?.inventoryChangeUsd).toBe(-300);
    expect(pnl?.feesEarnedUsd).toBe(5);
    expect(pnl?.netResultUsd).toBe(-295);
  });

  it('orders the series by capture time regardless of input order', () => {
    const pnl = computeWalletPositionPnl([
      point(24, 1_050, 12),
      point(0, 1_000, 0)
    ]);
    expect(pnl?.firstObservedAt).toEqual(new Date(t0));
    expect(pnl?.lastObservedAt).toEqual(new Date(t0 + 24 * 3_600_000));
    expect(pnl?.netResultUsd).toBe(62);
  });

  it('a single snapshot is an observation, not a result', () => {
    expect(computeWalletPositionPnl([point(0, 1_000, 0)])).toBeNull();
    expect(computeWalletPositionPnl([])).toBeNull();
  });

  it('a series ending emptied out is marked closed', () => {
    const pnl = computeWalletPositionPnl([
      point(0, 1_000, 0),
      point(24, 0, 0)
    ]);
    expect(pnl?.closed).toBe(true);
    expect(pnl?.netResultUsd).toBe(-1_000);
  });
});
