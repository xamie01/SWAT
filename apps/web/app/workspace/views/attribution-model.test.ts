import { describe, expect, it } from 'vitest';
import {
  calculateAttributionSummary,
  formatMs,
  formatUsd,
  parseAttributionData,
  toFiniteNumber,
  type ExpectancyRow
} from './attribution-model';

const baseRow: ExpectancyRow = {
  pattern_type: 'snipe',
  tier: 'elite',
  chain: 'solana',
  execution_mode: 'live',
  eligible_outcomes: 2,
  hit_rate_pct: 50,
  avg_win_usd: 2,
  avg_loss_usd: -1,
  expectancy_usd: 0.5
};

describe('attribution view model', () => {
  it('weights report statistics only by eligible outcome counts', () => {
    expect(calculateAttributionSummary([
      baseRow,
      { ...baseRow, chain: 'polygon', eligible_outcomes: '1', hit_rate_pct: '100', expectancy_usd: '2' }
    ])).toEqual({
      eligible: 3,
      hitRate: 200 / 3,
      expectancy: 1
    });
  });

  it('keeps unavailable numeric data unavailable instead of fabricating zero', () => {
    expect(toFiniteNumber('not-a-number')).toBeNull();
    expect(formatUsd(null)).toBe('Unavailable');
    expect(formatMs(Number.NaN)).toBe('Unavailable');
    expect(calculateAttributionSummary([])).toEqual({
      eligible: 0,
      hitRate: null,
      expectancy: null
    });
  });

  it('rejects malformed API payloads before the component consumes them', () => {
    expect(() => parseAttributionData({ report: null, latency: [] })).toThrow(
      'Attribution API returned an invalid response'
    );
    expect(() => parseAttributionData({
      report: { rows: 'invalid' },
      latency: [],
      live_vs_shadow: [],
      ledger: [],
      manual_thresholds: {}
    })).toThrow('Attribution API returned an invalid report');
  });
});
