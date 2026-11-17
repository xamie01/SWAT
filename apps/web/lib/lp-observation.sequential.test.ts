import { expect, it } from 'vitest';
import { lpBuilderHref, lpMasterCount, lpWinRate, observedBuilderBounds, recordedRiskNotice, lpListState } from './lp-observation.js';
import { loadingObservation, observe } from './portfolio-model.js';
it('uses actual closed position count and unit-ratio win rate DTO', () => {
  expect(lpMasterCount(12)).toBe('12'); expect(lpWinRate(0.75)).toBe('75.0%'); expect(lpWinRate(0)).toBe('0.0%'); expect(lpWinRate(1)).toBe('100.0%');
  for (const value of [null, undefined, NaN, Infinity, -1, 75]) expect(lpWinRate(value)).toBe('Unassessed');
  for (const value of [null, undefined, NaN, -1, 1.5]) expect(lpMasterCount(value)).toBe('Unassessed');
});
it('unknown price is absent from builder link and cannot create fabricated range', () => {
  for (const value of [null, undefined, NaN, Infinity, 0, -1]) {
    const href = lpBuilderHref({ poolAddress: 'solana:pool', chain: 'solana', currentPrice: value });
    expect(new URL(href, 'https://fixture.invalid').searchParams.has('price')).toBe(false);
  }
  for (const value of [null, '', ' ', 'Infinity', 'NaN', '0', '-1']) expect(observedBuilderBounds(value)).toBeNull();
  expect(observedBuilderBounds('100')).toEqual({ lower: 90, upper: 110 });
  expect(new URL(lpBuilderHref({ poolAddress: 'pool', chain: 'solana', currentPrice: 100 }), 'https://fixture.invalid').searchParams.get('price')).toBe('100');
});
it('finite extreme prices cannot produce nonfinite or rounded zero bounds', () => {
  for (const value of ['1.7e308', String(Number.MAX_VALUE), '1e-308']) expect(observedBuilderBounds(value)).toBeNull();
  const bounds = observedBuilderBounds('1e300');
  expect(bounds).not.toBeNull(); expect(Number.isFinite(bounds!.lower)).toBe(true); expect(Number.isFinite(bounds!.upper)).toBe(true);
});
it('loading/failure/successful empty have exclusive presentation states', async () => {
  expect(lpListState(loadingObservation())).toBe('loading');
  const failed = await observe<string[]>(async () => { throw new Error('offline fixture'); }, 'Unavailable');
  expect(lpListState(failed)).toBe('unavailable');
  expect(lpListState(await observe(async () => [], 'Unavailable'))).toBe('empty');
  expect(lpListState(await observe(async () => ['record'], 'Unavailable'))).toBe('records');
});
it('recorded risk score never becomes accepted protection badge', () => {
  for (const score of [0, 30, 80, null, NaN]) {
    expect(recordedRiskNotice(score)).toContain('protection unverified'); expect(recordedRiskNotice(score)).not.toMatch(/PASSED|AUDIT/);
  }
});
