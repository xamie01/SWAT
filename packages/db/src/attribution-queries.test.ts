import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAttributionLatencyReport,
  getAttributionLedger,
  getExpectancyReport,
  getLatestExpectancyReport,
  getLiveShadowCostReport,
  persistExpectancyReport,
  runNightlyAttribution
} from './attribution-queries.js';
import * as client from './client.js';

vi.mock('./client.js', () => ({
  query: vi.fn()
}));

describe('attribution queries', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('upserts one non-shadow outcome per signal, chain, and mode', async () => {
    vi.mocked(client.query).mockResolvedValue([]);

    await runNightlyAttribution();

    const sql = vi.mocked(client.query).mock.calls[0]?.[0] ?? '';
    expect(sql).toContain("t.execution_mode <> 'shadow'");
    expect(sql).toContain("t.status IN ('filled', 'partial')");
    expect(sql).toContain("COALESCE(t.execution_mode, 'paper') AS execution_mode");
    expect(sql).toContain('ps.chain = outcome.chain');
    expect(sql).toContain('wc.avg_composite_score >= 90');
    expect(sql).toContain('t.amount_usd + COALESCE(t.fee_usd, 0)');
    expect(sql).toContain('t.amount_usd - COALESCE(t.fee_usd, 0)');
    expect(sql).not.toContain('wc.tier');
    expect(sql).toContain('WHEN outcome.realized_pnl_usd IS NULL THEN NULL');
    expect(sql).toContain('ON CONFLICT (signal_id, chain, execution_mode)');
    expect(sql).not.toContain('COALESCE(t.realized_pnl_usd, 0)');
  });

  it('calculates expectancy from eligible realized outcomes only', async () => {
    const mockRows = [{
      pattern_type: 'snipe',
      tier: 'elite',
      chain: 'solana',
      execution_mode: 'live',
      eligible_outcomes: 5,
      hit_rate_pct: 60,
      avg_win_usd: 2,
      avg_loss_usd: -1,
      expectancy_usd: 0.8
    }];
    vi.mocked(client.query).mockResolvedValue(mockRows);

    await expect(getExpectancyReport()).resolves.toEqual(mockRows);

    const sql = vi.mocked(client.query).mock.calls[0]?.[0] ?? '';
    expect(sql).toContain("execution_mode <> 'shadow'");
    expect(sql).toContain('realized_pnl_usd IS NOT NULL');
    expect(sql).toContain('hit_result IS NOT NULL');
    expect(sql).toContain('realized_pnl_usd < 0');
    expect(sql).not.toContain('COALESCE(AVG');
  });

  it('persists report rows with the operator config snapshot and latest config pointer', async () => {
    const reportRows = [{
      pattern_type: 'accumulation',
      tier: null,
      chain: 'polygon',
      execution_mode: 'paper',
      eligible_outcomes: 2,
      hit_rate_pct: 50,
      avg_win_usd: 4,
      avg_loss_usd: -2,
      expectancy_usd: 1
    }];
    const generatedAt = new Date('2026-07-26T02:00:00.000Z');
    const saved = {
      id: 'report-1',
      generated_at: generatedAt,
      config_snapshot: {
        signals: {
          value: { min_signal_score: 70, auto_execute_min_score: 90 },
          updated_at: generatedAt
        }
      },
      rows: reportRows
    };
    vi.mocked(client.query)
      .mockResolvedValueOnce(reportRows)
      .mockResolvedValueOnce([{
        key: 'signals',
        value: { min_signal_score: 70, auto_execute_min_score: 90 },
        updated_at: generatedAt
      }])
      .mockResolvedValueOnce([saved]);

    await expect(persistExpectancyReport()).resolves.toEqual(saved);

    const [, values] = vi.mocked(client.query).mock.calls[2] ?? [];
    const sql = vi.mocked(client.query).mock.calls[2]?.[0] ?? '';
    expect(sql).toContain('INSERT INTO expectancy_reports');
    expect(sql).toContain("'expectancy_report'");
    expect(sql).toContain('ON CONFLICT (key) DO UPDATE');
    expect(JSON.parse(String(values?.[0]))).toEqual(
      JSON.parse(JSON.stringify(saved.config_snapshot))
    );
    expect(JSON.parse(String(values?.[1]))).toEqual(reportRows);
  });

  it('returns null explicitly when no persisted report exists', async () => {
    vi.mocked(client.query).mockResolvedValue([]);
    await expect(getLatestExpectancyReport()).resolves.toBeNull();
  });

  it('reports detection and submission latency from non-shadow filled trades', async () => {
    vi.mocked(client.query).mockResolvedValue([]);
    await getAttributionLatencyReport();

    const sql = vi.mocked(client.query).mock.calls[0]?.[0] ?? '';
    expect(sql).toContain('t.confirmed_at - s.detected_at');
    expect(sql).toContain('t.confirmed_at - t.submitted_at');
    expect(sql).toContain("t.execution_mode <> 'shadow'");
    expect(sql).toContain('t.confirmed_at >= s.detected_at');
    expect(sql).toContain('t.confirmed_at >= t.submitted_at');
    expect(sql).not.toContain('wc.tier');
  });

  it('uses direction-aware actual fill prices for live versus shadow cost', async () => {
    vi.mocked(client.query).mockResolvedValue([]);
    await getLiveShadowCostReport();

    const sql = vi.mocked(client.query).mock.calls[0]?.[0] ?? '';
    expect(sql).toContain("WHEN 'buy' THEN ((live.price_usd - shadow.price_usd)");
    expect(sql).toContain("WHEN 'sell' THEN ((shadow.price_usd - live.price_usd)");
    expect(sql).toContain("shadow.status IN ('filled', 'partial')");
    expect(sql).toContain('shadow.chain = live.chain');
  });

  it('bounds ledger requests and excludes shadow rows', async () => {
    vi.mocked(client.query).mockResolvedValue([]);
    await getAttributionLedger(5000);

    const [sql, values] = vi.mocked(client.query).mock.calls[0] ?? [];
    expect(sql).toContain("t.execution_mode <> 'shadow'");
    expect(values).toEqual([200]);
  });

  it('uses the default ledger limit for a non-finite request', async () => {
    vi.mocked(client.query).mockResolvedValue([]);
    await getAttributionLedger(Number.NaN);

    expect(vi.mocked(client.query).mock.calls[0]?.[1]).toEqual([50]);
  });
});
