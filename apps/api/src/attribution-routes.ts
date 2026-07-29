import type { FastifyInstance } from 'fastify';
import type {
  AttributionDashboardData,
  AttributionLatencyRow,
  ExpectancyReport,
  LiveShadowCostRow
} from '@swat/db';

export type AttributionRouteDependencies = {
  getDashboard: () => Promise<AttributionDashboardData>;
  getExpectancy: () => Promise<ExpectancyReport | null>;
  getLatency: () => Promise<AttributionLatencyRow[]>;
  getShadowCost: () => Promise<LiveShadowCostRow[]>;
};

export type ManualThresholds = {
  min_signal_score: number | null;
  auto_execute_min_score: number | null;
  max_position_pct: number | null;
  max_daily_exposure_pct: number | null;
  stop_loss_pct: number | null;
  captured_at: Date | string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function extractManualThresholds(report: ExpectancyReport | null): ManualThresholds {
  const signals = asRecord(report?.config_snapshot.signals?.value);
  const trading = asRecord(report?.config_snapshot.trading?.value);
  const risk = asRecord(report?.config_snapshot.risk?.value);

  return {
    min_signal_score: finiteNumber(signals?.min_signal_score),
    auto_execute_min_score: finiteNumber(signals?.auto_execute_min_score),
    max_position_pct: finiteNumber(trading?.max_position_pct),
    max_daily_exposure_pct: finiteNumber(trading?.max_daily_exposure_pct),
    stop_loss_pct: finiteNumber(risk?.stop_loss_pct),
    captured_at: report?.generated_at ?? null
  };
}

export function registerAttributionRoutes(
  app: FastifyInstance,
  dependencies: AttributionRouteDependencies
): void {
  app.get('/v1/trading/expectancy', async () => ({
    report: await dependencies.getExpectancy()
  }));

  app.get('/v1/trading/latency', async () => ({
    items: await dependencies.getLatency()
  }));

  app.get('/v1/trading/shadow-cost', async () => ({
    report: await dependencies.getShadowCost()
  }));

  app.get('/v1/trading/attribution', async () => {
    const dashboard = await dependencies.getDashboard();
    return {
      ...dashboard,
      manual_thresholds: extractManualThresholds(dashboard.report)
    };
  });
}
