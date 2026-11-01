import { describe, expect, it } from 'vitest';

import { combineTokenRisk } from './score.js';
import {
  BUNDLED_WALLETS_FLAG,
  FREEZE_AUTHORITY_FLAG,
  HOLDER_CONCENTRATION_FLAG,
  LIQUIDITY_UNLOCKED_FLAG,
  MINT_AUTHORITY_FLAG
} from './types.js';

describe('combineTokenRisk', () => {
  it('an empty finding list scores 0 and passes', () => {
    const combined = combineTokenRisk([]);
    expect(combined.score).toBe(0);
    expect(combined.allowed).toBe(true);
  });

  it('weights each triggered flag once and caps at 100', () => {
    const combined = combineTokenRisk([
      { flag: MINT_AUTHORITY_FLAG, detail: 'can mint' },
      { flag: LIQUIDITY_UNLOCKED_FLAG, detail: 'LP movable' },
      { flag: HOLDER_CONCENTRATION_FLAG, detail: 'top-10 heavy' },
      { flag: BUNDLED_WALLETS_FLAG, detail: 'bundle' },
      { flag: FREEZE_AUTHORITY_FLAG, detail: 'can freeze' }
    ]);
    // 50 + 40 + 35 + 25 + 25 = 175 -> capped 100
    expect(combined.score).toBe(100);
    expect(combined.allowed).toBe(false);
  });

  it('a repeated flag from two checkers is counted once', () => {
    const combined = combineTokenRisk([
      { flag: MINT_AUTHORITY_FLAG, detail: 'first' },
      { flag: MINT_AUTHORITY_FLAG, detail: 'second' }
    ]);
    expect(combined.score).toBe(50);
    expect(combined.flags).toEqual([MINT_AUTHORITY_FLAG]);
  });

  it('the gate blocks above the threshold while keeping the score visible', () => {
    const combined = combineTokenRisk(
      [{ flag: LIQUIDITY_UNLOCKED_FLAG, detail: 'LP movable' }],
      { maxScore: 20 }
    );
    expect(combined.score).toBe(40);
    expect(combined.allowed).toBe(false);
    expect(combined.rejectionReasons[0]).toContain('exceeds_gate_20');
  });
});
