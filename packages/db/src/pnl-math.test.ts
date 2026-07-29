import { describe, it, expect } from 'vitest';
import { calculateAverageCostPnl, markToMarketPnl } from './pnl-math.js';

describe('markToMarketPnl', () => {
  it('returns a positive P&L when price rose', () => {
    // $100 cost basis, entry $1, now $2 → +$100
    expect(markToMarketPnl(100, 1, 2)).toBeCloseTo(100, 6);
  });

  it('returns a negative P&L when price fell', () => {
    // $100 cost basis, entry $1, now $0.5 → -$50
    expect(markToMarketPnl(100, 1, 0.5)).toBeCloseTo(-50, 6);
  });

  it('returns zero when price is unchanged', () => {
    expect(markToMarketPnl(100, 2, 2)).toBeCloseTo(0, 6);
  });

  it('handles a total loss (current price 0)', () => {
    expect(markToMarketPnl(100, 1, 0)).toBeCloseTo(-100, 6);
  });

  it('returns null for missing cost basis', () => {
    expect(markToMarketPnl(null, 1, 2)).toBeNull();
    expect(markToMarketPnl(undefined, 1, 2)).toBeNull();
  });

  it('returns null for a non-positive entry price (avoids divide-by-zero)', () => {
    expect(markToMarketPnl(100, 0, 2)).toBeNull();
    expect(markToMarketPnl(100, -1, 2)).toBeNull();
  });

  it('returns null for missing or negative current price', () => {
    expect(markToMarketPnl(100, 1, null)).toBeNull();
    expect(markToMarketPnl(100, 1, undefined)).toBeNull();
    expect(markToMarketPnl(100, 1, -5)).toBeNull();
  });

  it('returns null for non-finite inputs', () => {
    expect(markToMarketPnl(Number.NaN, 1, 2)).toBeNull();
    expect(markToMarketPnl(100, Number.POSITIVE_INFINITY, 2)).toBeNull();
    expect(markToMarketPnl(100, 1, Number.NaN)).toBeNull();
  });
});

describe('calculateAverageCostPnl', () => {
  it('separates realized and unrealized P&L after a partial sell', () => {
    expect(calculateAverageCostPnl([
      { direction: 'buy', tokenAmount: 100, amountUsd: 100 },
      { direction: 'sell', tokenAmount: 40, amountUsd: 80 }
    ], 1.5)).toEqual({
      openQuantity: 60,
      openCostBasisUsd: 60,
      realizedPnlUsd: 40,
      unrealizedPnlUsd: 30,
      totalPnlUsd: 70
    });
  });

  it('uses the cost basis that existed at each chronological reduction', () => {
    const pnl = calculateAverageCostPnl([
      { direction: 'buy', tokenAmount: 10, amountUsd: 100 },
      { direction: 'sell', tokenAmount: 5, amountUsd: 75 },
      { direction: 'buy', tokenAmount: 10, amountUsd: 200 }
    ], 20);

    expect(pnl?.realizedPnlUsd).toBeCloseTo(25, 8);
    expect(pnl?.openQuantity).toBe(15);
    expect(pnl?.openCostBasisUsd).toBeCloseTo(250, 8);
    expect(pnl?.unrealizedPnlUsd).toBeCloseTo(50, 8);
    expect(pnl?.totalPnlUsd).toBeCloseTo(75, 8);
  });

  it('calculates a fully closed position without a current market price', () => {
    expect(calculateAverageCostPnl([
      { direction: 'buy', tokenAmount: 10, amountUsd: 100 },
      { direction: 'sell', tokenAmount: 4, amountUsd: 60 },
      { direction: 'sell', tokenAmount: 6, amountUsd: 72 }
    ], null)).toEqual({
      openQuantity: 0,
      openCostBasisUsd: 0,
      realizedPnlUsd: 32,
      unrealizedPnlUsd: 0,
      totalPnlUsd: 32
    });
  });

  it('includes known entry and exit fees in realized P&L', () => {
    expect(calculateAverageCostPnl([
      { direction: 'buy', tokenAmount: 10, amountUsd: 100, feeUsd: 1 },
      { direction: 'sell', tokenAmount: 10, amountUsd: 130, feeUsd: 2 }
    ], null)).toEqual({
      openQuantity: 0,
      openCostBasisUsd: 0,
      realizedPnlUsd: 27,
      unrealizedPnlUsd: 0,
      totalPnlUsd: 27
    });
  });

  it('fails closed for oversells and invalid monetary inputs', () => {
    expect(calculateAverageCostPnl([
      { direction: 'buy', tokenAmount: 5, amountUsd: 50 },
      { direction: 'sell', tokenAmount: 6, amountUsd: 60 }
    ], 10)).toBeNull();
    expect(calculateAverageCostPnl([
      { direction: 'buy', tokenAmount: 5, amountUsd: Number.NaN }
    ], 10)).toBeNull();
    expect(calculateAverageCostPnl([
      { direction: 'buy', tokenAmount: 5, amountUsd: 50, feeUsd: -1 }
    ], 10)).toBeNull();
  });
});
