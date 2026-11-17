import { describe, expect, it } from 'vitest';
import { lpAmountForBudget, lpDecimal, lpEconomics, lpExactHash, lpMicro, lpRaw, lpStoredMicro, lpValueMicro, lpProtocol, lpRecenterStrategy } from './lp-exact.js';

describe('exact LP rawscale and economic contracts', () => {
  it('preserves fractional quantities above float64 safe raw range', () => {
    const amount = { raw: '900719925474099312345', scale: 18 };
    expect(lpDecimal(amount)).toBe('900.719925474099312345');
    expect(lpRaw(amount)).toBe(900719925474099312345n);
    expect(lpValueMicro(amount, { raw: '1234567', scale: 6 })).toBe('1111999096');
  });
  it.each(['', '01', '-1', '1.2', '1e9', '+1', ' 1', '9'.repeat(79)])('rejects noncanonical raw %s', raw => {
    expect(() => lpRaw({ raw, scale: 6 })).toThrow('rawscale');
  });
  it.each([-1, 31, 1.5, NaN])('rejects asset scale %s', scale => expect(() => lpRaw({ raw: '1', scale })).toThrow('rawscale'));
  it('converts NUMERIC text and refuses nonzero excess fractional USD digits', () => {
    expect(lpStoredMicro('12345678901234567890.123456000')).toBe('12345678901234567890123456');
    expect(() => lpStoredMicro('1.0000001')).toThrow('scale');
    expect(() => lpStoredMicro('NaN')).toThrow('unavailable');
  });
  it('floors once and never exceeds exact copy budget', () => {
    const price = { raw: '1234567', scale: 6 };
    const amount = lpAmountForBudget('6000000', price, 18);
    expect(lpMicro(lpValueMicro(amount, price))).toBeLessThanOrEqual(6000000n);
    expect(lpValueMicro(amount, price)).toBe('5999999');
  });
  it('microdollar strings remain canonical, bounded and signed only when requested', () => {
    for (const raw of ['-0', '+1', '01', '1.0', '1e6', '9'.repeat(79)]) expect(() => lpMicro(raw, true)).toThrow('canonical');
    expect(() => lpMicro('-1')).toThrow('canonical'); expect(lpMicro('-1', true)).toBe(-1n);
    expect(() => lpValueMicro({ raw: '1', scale: 30 }, { raw: '1', scale: 30 })).toThrow('below one');
    expect(() => lpValueMicro({ raw: '9'.repeat(78), scale: 0 }, { raw: '9'.repeat(78), scale: 0 })).toThrow('canonical');
  });
  it('recenter geometry avoids intermediate multiplication overflow', () => {
    const next = lpRecenterStrategy({ distribution: 'spot', rangeLower: 1e200, rangeUpper: 4e200, rungCount: 1 }, 2e200);
    expect(next.rangeLower).toBeGreaterThan(0); expect(Number.isFinite(next.rangeUpper)).toBe(true);
    expect(next.rangeUpper / next.rangeLower).toBeCloseTo(4);
  });
  it('unknown economics is not zero-safe', () => {
    expect(lpEconomics(null)).toEqual({ assessed: false, shouldRebalance: false, netMicroUsd: null, reason: 'economics-unassessed' });
  });
  const input = { basis: 'incremental-rebalance' as const, windowStart: '2026-11-17T12:00:00.000Z', windowEnd: '2026-11-18T12:00:00.000Z',
    extraFeesMicroUsd: '9007199254740993000000', inventoryChangeMicroUsd: '-100', impermanentLossMicroUsd: '200', gasMicroUsd: '300', repositionMicroUsd: '400' };
  it('evaluates signed incremental economics with exact integers', () => {
    expect(lpEconomics(input)).toEqual({ assessed: true, shouldRebalance: true, netMicroUsd: '9007199254740992999000', reason: 'positive' });
    expect(lpEconomics({ ...input, extraFeesMicroUsd: '1000' }).shouldRebalance).toBe(false);
  });
  it('rejects negative cost and mixed/reversed horizon', () => {
    expect(() => lpEconomics({ ...input, gasMicroUsd: '-1' })).toThrow('microdollars');
    expect(() => lpEconomics({ ...input, windowEnd: input.windowStart })).toThrow('aligned');
  });
  it('distinct Raydium layout/v4 hook capability cannot masquerade as configured v3/DLMM', () => {
    expect(() => lpProtocol('solana', 'raydium-clmm')).toThrow('capability unavailable');
    expect(() => lpProtocol('base', 'uniswap-v4')).toThrow('capability unavailable');
    expect(() => lpProtocol('base', 'pancakeswap-v3')).toThrow('capability unavailable');
    expect(() => lpProtocol('bsc', 'pancakeswap-v3')).not.toThrow();
  });
  it('canonical intent hash ignores object key order but not rawscale or mode', () => {
    expect(lpExactHash({ b: 2, a: 1 })).toBe(lpExactHash({ a: 1, b: 2 }));
    expect(lpExactHash({ raw: '1', scale: 1 })).not.toBe(lpExactHash({ raw: '1', scale: 2 }));
    expect(() => lpExactHash({ undefinedField: undefined })).toThrow('plain JSON');
  });
});
