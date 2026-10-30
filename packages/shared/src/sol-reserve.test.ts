import { describe, expect, it } from 'vitest';
import {
  evaluateSolReserve,
  DEFAULT_SOL_MINIMUM_RESERVE_USD
} from './sol-reserve.js';

describe('Per-User SOL Reserve Gate (S4-P20)', () => {
  it('passes when user has sufficient SOL at current price', () => {
    // $10 minimum / $200 per SOL = 0.05 SOL required
    const verdict = evaluateSolReserve({
      currentSolBalance: 0.1,
      solPriceUsd: 200
    });

    expect(verdict.status).toBe('funded');
    if (verdict.status === 'funded') {
      expect(verdict.currentSol).toBe(0.1);
      expect(verdict.requiredSol).toBeCloseTo(0.05, 5);
      expect(verdict.solPriceUsd).toBe(200);
    }
  });

  it('fails with actionable message and code when user is underfunded', () => {
    // $10 minimum / $200 per SOL = 0.05 SOL required; user has 0.02
    const verdict = evaluateSolReserve({
      currentSolBalance: 0.02,
      solPriceUsd: 200
    });

    expect(verdict.status).toBe('underfunded');
    if (verdict.status === 'underfunded') {
      expect(verdict.code).toBe('sol-reserve-underfunded');
      expect(verdict.requiredSol).toBeCloseTo(0.05, 5);
      expect(verdict.neededSol).toBeCloseTo(0.03, 5);
      expect(verdict.reason).toContain('Insufficient SOL');
      expect(verdict.reason).toContain('hold at least ~0.0300 more SOL ($10 reserve required)');
    }
  });

  it('handles zero SOL balance accurately', () => {
    const verdict = evaluateSolReserve({
      currentSolBalance: 0,
      solPriceUsd: 150
    });

    expect(verdict.status).toBe('underfunded');
    if (verdict.status === 'underfunded') {
      expect(verdict.currentSol).toBe(0);
      expect(verdict.neededSol).toBeCloseTo(10 / 150, 5);
      expect(verdict.reason).toContain('($10 reserve required)');
    }
  });

  it('dynamically scales required SOL with live SOL price', () => {
    // At $100/SOL, need 0.1 SOL
    const v1 = evaluateSolReserve({ currentSolBalance: 0.06, solPriceUsd: 100 });
    expect(v1.status).toBe('underfunded');

    // At $400/SOL, need 0.025 SOL (0.06 is plenty)
    const v2 = evaluateSolReserve({ currentSolBalance: 0.06, solPriceUsd: 400 });
    expect(v2.status).toBe('funded');
  });

  it('fails closed when SOL price is unavailable, null, or invalid (no 150 fallback)', () => {
    const vNull = evaluateSolReserve({ currentSolBalance: 1.0, solPriceUsd: null });
    expect(vNull.status).toBe('price-unavailable');
    if (vNull.status === 'price-unavailable') {
      expect(vNull.code).toBe('sol-price-unavailable');
      expect(vNull.reason).toContain('SOL price feed is currently unavailable');
    }

    const vZero = evaluateSolReserve({ currentSolBalance: 1.0, solPriceUsd: 0 });
    expect(vZero.status).toBe('price-unavailable');

    const vNaN = evaluateSolReserve({ currentSolBalance: 1.0, solPriceUsd: Number.NaN });
    expect(vNaN.status).toBe('price-unavailable');
  });

  it('respects a custom targetUsd override if provided', () => {
    const verdict = evaluateSolReserve({
      currentSolBalance: 0.05,
      solPriceUsd: 200,
      targetUsd: 20 // requires 0.1 SOL
    });

    expect(verdict.status).toBe('underfunded');
    if (verdict.status === 'underfunded') {
      expect(verdict.requiredSol).toBeCloseTo(0.1, 5);
      expect(verdict.reason).toContain('$20 reserve required');
    }
  });
});
