import type { FastifyInstance } from 'fastify';
import type { AttributionDashboardData, AttributionLatencyRow, ExpectancyReport, LiveShadowCostRow } from '@swat/db';
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
export declare function extractManualThresholds(report: ExpectancyReport | null): ManualThresholds;
export declare function registerAttributionRoutes(app: FastifyInstance, dependencies: AttributionRouteDependencies): void;
//# sourceMappingURL=attribution-routes.d.ts.map