import { describe, it, expect } from 'vitest';
import { markToMarketPnl } from './pnl-math.js';

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
