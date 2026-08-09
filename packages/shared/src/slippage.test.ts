import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  isValidSlippageBps,
  resolveSlippageBps
} from './slippage.js';

describe('slippage resolution (S4-P4)', () => {
  it('falls back to the chain default when the user has set nothing', () => {
    // null and undefined are the same case — "never expressed a preference".
    expect(resolveSlippageBps('solana', null)).toBe(1500);
    expect(resolveSlippageBps('solana', undefined)).toBe(1500);
    expect(resolveSlippageBps('polygon', null)).toBe(300);
    expect(resolveSlippageBps('robinhood-chain', null)).toBe(300);
  });

  it('preserves the constants it replaces, so nobody who never sets it sees a change', () => {
    // These were the hard-coded values at the venue call sites. If they drift, a
    // user who never touched the setting silently gets different risk.
    expect(DEFAULT_SLIPPAGE_BPS.solana).toBe(1500);
    expect(DEFAULT_SLIPPAGE_BPS['robinhood-chain']).toBe(300);
  });

  it('honours a TIGHTER user value — the default is never a floor', () => {
    // The important one. Treating the chain constant as a minimum would widen
    // every cautious user's risk to the platform's own appetite.
    expect(resolveSlippageBps('solana', 50)).toBe(50);
    expect(resolveSlippageBps('robinhood-chain', 10)).toBe(10);
  });

  it('honours a looser user value up to the platform ceiling', () => {
    expect(resolveSlippageBps('robinhood-chain', 900)).toBe(900);
    expect(resolveSlippageBps('solana', 2500)).toBe(2500);
  });

  it('clamps past the platform ceiling rather than obeying it', () => {
    // A user "choosing" 90% is not a risk anyone takes knowingly; the resulting
    // fill reads as a platform failure whatever the setting said.
    expect(resolveSlippageBps('solana', 9000)).toBe(MAX_SLIPPAGE_BPS);
    expect(resolveSlippageBps('solana', Number.MAX_SAFE_INTEGER)).toBe(MAX_SLIPPAGE_BPS);
  });

  it('clamps zero and negatives to the floor, since zero makes every order unfillable', () => {
    expect(resolveSlippageBps('solana', 0)).toBe(MIN_SLIPPAGE_BPS);
    expect(resolveSlippageBps('solana', -100)).toBe(MIN_SLIPPAGE_BPS);
  });

  it('throws on a fractional value rather than rounding it away', () => {
    // A non-integer is a caller bug. Silently rounding, or falling back to the
    // default, would hide it — and the venues take integers regardless.
    expect(() => resolveSlippageBps('solana', 150.5)).toThrow(/integer/);
  });

  it('resolves per chain, so one user can be tight on one venue and loose on another', () => {
    // The reason this lives on (user_id, chain) rather than on the user.
    expect(resolveSlippageBps('solana', 2000)).toBe(2000);
    expect(resolveSlippageBps('polygon', 100)).toBe(100);
  });
});

describe('isValidSlippageBps', () => {
  it('accepts integers within the bounds', () => {
    expect(isValidSlippageBps(1)).toBe(true);
    expect(isValidSlippageBps(300)).toBe(true);
    expect(isValidSlippageBps(5000)).toBe(true);
  });

  it('rejects out-of-range, fractional, and non-numeric input', () => {
    // The API validates before persisting, so an out-of-range value never reaches
    // the column's CHECK and never becomes a confusing 500.
    expect(isValidSlippageBps(0)).toBe(false);
    expect(isValidSlippageBps(5001)).toBe(false);
    expect(isValidSlippageBps(-1)).toBe(false);
    expect(isValidSlippageBps(150.5)).toBe(false);
    expect(isValidSlippageBps('300')).toBe(false);
    expect(isValidSlippageBps(null)).toBe(false);
    expect(isValidSlippageBps(undefined)).toBe(false);
    expect(isValidSlippageBps(Number.NaN)).toBe(false);
  });
});
