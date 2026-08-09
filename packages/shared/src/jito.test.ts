import { describe, it, expect } from 'vitest';
import {
  JITO_TIP_ACCOUNTS,
  selectJitoTip,
  selectTipAccount,
  type JitoTipFloor
} from './jito.js';

const floor: JitoTipFloor = {
  p25: 1_000,
  p50: 10_000,
  p75: 100_000,
  p95: 1_000_000,
  p99: 10_000_000
};

describe('jito tip sizing', () => {
  it('targets the requested percentile', () => {
    expect(
      selectJitoTip({ floor, percentile: 'p50', maxTipLamports: 50_000_000, fallbackTipLamports: 5_000 })
    ).toBe(10_000);
    expect(
      selectJitoTip({ floor, percentile: 'p95', maxTipLamports: 50_000_000, fallbackTipLamports: 5_000 })
    ).toBe(1_000_000);
  });

  it('never exceeds the cap, however high the floor climbs', () => {
    // The cap is the only thing standing between a congestion spike (or a
    // malformed floor response) and unbounded SOL spend per trade.
    expect(
      selectJitoTip({ floor, percentile: 'p95', maxTipLamports: 50_000, fallbackTipLamports: 5_000 })
    ).toBe(50_000);
  });

  it('falls back when the floor is unreadable rather than abandoning the trade', () => {
    expect(
      selectJitoTip({ floor: null, percentile: 'p75', maxTipLamports: 50_000_000, fallbackTipLamports: 7_777 })
    ).toBe(7_777);
  });

  it('treats a zero percentile as no-data, not as free', () => {
    // A zero tip never lands. Reading "0" as a valid tip would silently produce
    // bundles that are never built, which looks identical to a dead executor.
    const zeroFloor: JitoTipFloor = { p25: 0, p50: 0, p75: 0, p95: 0, p99: 0 };
    expect(
      selectJitoTip({ floor: zeroFloor, percentile: 'p50', maxTipLamports: 1_000_000, fallbackTipLamports: 9_000 })
    ).toBe(9_000);
  });

  it('never returns a tip below 1 lamport', () => {
    expect(
      selectJitoTip({ floor, percentile: 'p50', maxTipLamports: 0, fallbackTipLamports: 0 })
    ).toBe(1);
  });

  it('rounds to whole lamports', () => {
    const fractional: JitoTipFloor = { p25: 0, p50: 1234.7, p75: 0, p95: 0, p99: 0 };
    const tip = selectJitoTip({
      floor: fractional,
      percentile: 'p50',
      maxTipLamports: 1_000_000,
      fallbackTipLamports: 1
    });
    expect(Number.isInteger(tip)).toBe(true);
    expect(tip).toBe(1235);
  });
});

describe('tip account selection', () => {
  it('always returns a real tip account', () => {
    // A tip to any other address is simply a donation — the bundle is ignored.
    for (const seed of ['a', 'signal-123', '', 'x'.repeat(200)]) {
      expect(JITO_TIP_ACCOUNTS).toContain(selectTipAccount(seed));
    }
  });

  it('is deterministic for the same seed', () => {
    expect(selectTipAccount('signal-42')).toBe(selectTipAccount('signal-42'));
  });

  it('spreads across the account set', () => {
    const seen = new Set(
      Array.from({ length: 200 }, (_, i) => selectTipAccount(`signal-${i}`))
    );
    // Not a uniformity proof — just that it is not pinned to one account, which
    // would concentrate load and make the spread pointless.
    expect(seen.size).toBeGreaterThan(1);
  });
});
