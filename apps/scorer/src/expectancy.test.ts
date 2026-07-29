import { describe, expect, it, vi } from 'vitest';
import { formatExpectancyDigest, runAttributionReporting } from './expectancy.js';

describe('formatExpectancyDigest', () => {
  it('renders eligible outcome counts from a persisted report', () => {
    const digest = formatExpectancyDigest({
      id: 'report-1',
      generated_at: '2026-07-26T02:00:00.000Z',
      config_snapshot: {},
      rows: [{
        pattern_type: 'snipe',
        tier: 'elite',
        chain: 'solana',
        execution_mode: 'live',
        eligible_outcomes: 41,
        hit_rate_pct: 62,
        avg_win_usd: 2,
        avg_loss_usd: -1,
        expectancy_usd: 0.8
      }]
    });

    expect(digest).toContain('snipe | elite | solana | live');
    expect(digest).toContain('Count: 41 | HR: 62.0% | Exp: $0.80');
  });

  it('does not send a fabricated digest when no eligible outcomes exist', () => {
    expect(formatExpectancyDigest({
      id: 'report-empty',
      generated_at: '2026-07-26T02:00:00.000Z',
      config_snapshot: {},
      rows: []
    })).toBeNull();
  });

  it('rebuilds outcomes before persisting and publishing a report', async () => {
    const calls: string[] = [];
    const report = {
      id: 'report-1',
      generated_at: '2026-07-26T02:00:00.000Z',
      config_snapshot: {},
      rows: [{
        pattern_type: 'snipe',
        tier: 'elite',
        chain: 'solana',
        execution_mode: 'live',
        eligible_outcomes: 1,
        hit_rate_pct: 100,
        avg_win_usd: 2,
        avg_loss_usd: null,
        expectancy_usd: 2
      }]
    };

    await expect(runAttributionReporting({
      rebuildOutcomes: async () => { calls.push('rebuild'); },
      persistReport: async () => { calls.push('persist'); return report; },
      publishDigest: async () => { calls.push('publish'); }
    })).resolves.toEqual(report);

    expect(calls).toEqual(['rebuild', 'persist', 'publish']);
  });

  it('does not persist or publish when rebuilding outcomes fails', async () => {
    const persistReport = vi.fn();
    const publishDigest = vi.fn();

    await expect(runAttributionReporting({
      rebuildOutcomes: async () => { throw new Error('rebuild failed'); },
      persistReport,
      publishDigest
    })).rejects.toThrow('rebuild failed');

    expect(persistReport).not.toHaveBeenCalled();
    expect(publishDigest).not.toHaveBeenCalled();
  });

  it('persists empty reports without publishing a fabricated digest', async () => {
    const publishDigest = vi.fn();
    const report = {
      id: 'report-empty',
      generated_at: '2026-07-26T02:00:00.000Z',
      config_snapshot: {},
      rows: []
    };

    await runAttributionReporting({
      rebuildOutcomes: async () => undefined,
      persistReport: async () => report,
      publishDigest
    });

    expect(publishDigest).not.toHaveBeenCalled();
  });
});
