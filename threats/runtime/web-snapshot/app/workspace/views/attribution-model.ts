export type NumericValue = number | string;

export type ExpectancyRow = {
  pattern_type: string;
  tier: string | null;
  chain: string;
  execution_mode: string;
  eligible_outcomes: NumericValue;
  hit_rate_pct: NumericValue;
  avg_win_usd: NumericValue | null;
  avg_loss_usd: NumericValue | null;
  expectancy_usd: NumericValue;
};

export type ConfigEntry = { value: unknown; updated_at: string };

export type ExpectancyReport = {
  id: string;
  generated_at: string;
  config_snapshot: Record<string, ConfigEntry>;
  rows: ExpectancyRow[];
};

export type LatencyRow = {
  chain: string;
  pattern_type: string;
  tier: string | null;
  execution_mode: string;
  sample_count: NumericValue;
  p50_detection_to_confirmation_ms: NumericValue;
  p95_detection_to_confirmation_ms: NumericValue;
  p50_submission_to_confirmation_ms: NumericValue;
  p95_submission_to_confirmation_ms: NumericValue;
};

export type ShadowCostRow = {
  chain: string;
  matched_trades: NumericValue;
  avg_execution_cost_bps: NumericValue;
};

export type LedgerRow = {
  trade_id: string;
  signal_id: string;
  chain: string;
  pattern_type: string;
  execution_mode: string;
  executed_at: string;
  detected_at: string | null;
  submitted_at: string | null;
  confirmed_at: string | null;
  slippage_bps: NumericValue | null;
  realized_pnl_usd: NumericValue | null;
};

export type ManualThresholds = {
  min_signal_score: number | null;
  auto_execute_min_score: number | null;
  max_position_pct: number | null;
  max_daily_exposure_pct: number | null;
  stop_loss_pct: number | null;
  captured_at: string | null;
};

export type AttributionData = {
  report: ExpectancyReport | null;
  latency: LatencyRow[];
  live_vs_shadow: ShadowCostRow[];
  ledger: LedgerRow[];
  manual_thresholds: ManualThresholds;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAttributionData(value: unknown): AttributionData {
  if (!isRecord(value)
    || (value.report !== null && !isRecord(value.report))
    || !Array.isArray(value.latency)
    || !Array.isArray(value.live_vs_shadow)
    || !Array.isArray(value.ledger)
    || !isRecord(value.manual_thresholds)) {
    throw new Error('Attribution API returned an invalid response');
  }
  if (isRecord(value.report) && !Array.isArray(value.report.rows)) {
    throw new Error('Attribution API returned an invalid report');
  }
  return value as AttributionData;
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function calculateAttributionSummary(rows: ExpectancyRow[]) {
  let eligible = 0;
  let hitRateWeight = 0;
  let weightedHitRate = 0;
  let expectancyWeight = 0;
  let weightedExpectancy = 0;

  for (const row of rows) {
    const count = toFiniteNumber(row.eligible_outcomes);
    if (count === null || count <= 0) continue;
    eligible += count;

    const hitRate = toFiniteNumber(row.hit_rate_pct);
    if (hitRate !== null) {
      hitRateWeight += count;
      weightedHitRate += hitRate * count;
    }

    const expectancy = toFiniteNumber(row.expectancy_usd);
    if (expectancy !== null) {
      expectancyWeight += count;
      weightedExpectancy += expectancy * count;
    }
  }

  return {
    eligible,
    hitRate: hitRateWeight > 0 ? weightedHitRate / hitRateWeight : null,
    expectancy: expectancyWeight > 0 ? weightedExpectancy / expectancyWeight : null
  };
}

export function formatUsd(value: unknown): string {
  const amount = toFiniteNumber(value);
  if (amount === null) return 'Unavailable';
  return `${amount >= 0 ? '+' : '-'}$${Math.abs(amount).toFixed(2)}`;
}

export function formatMs(value: unknown): string {
  const milliseconds = toFiniteNumber(value);
  if (milliseconds === null) return 'Unavailable';
  return milliseconds >= 1000
    ? `${(milliseconds / 1000).toFixed(2)}s`
    : `${milliseconds.toFixed(0)}ms`;
}

export function formatDate(value: string | null): string {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
}
