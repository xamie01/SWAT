/**
 * Rebuilds outcomes from filled live and paper trades. A row is realized only
 * when complete buy and sell amounts are available; open or incomplete
 * positions retain NULL P&L and never become losses by default.
 */
export declare function runNightlyAttribution(): Promise<void>;
export interface ExpectancyRow {
    pattern_type: string;
    tier: string | null;
    chain: string;
    execution_mode: string;
    eligible_outcomes: number;
    hit_rate_pct: number;
    avg_win_usd: number | null;
    avg_loss_usd: number | null;
    expectancy_usd: number;
}
export interface ExpectancyConfigEntry {
    value: unknown;
    updated_at: Date | string;
}
export type ExpectancyConfigSnapshot = Record<string, ExpectancyConfigEntry>;
export interface ExpectancyReport {
    id: string;
    generated_at: Date | string;
    config_snapshot: ExpectancyConfigSnapshot;
    rows: ExpectancyRow[];
}
export declare function getExpectancyReport(): Promise<ExpectancyRow[]>;
/** Persists an immutable report and atomically updates the latest-report config. */
export declare function persistExpectancyReport(): Promise<ExpectancyReport>;
export declare function getLatestExpectancyReport(): Promise<ExpectancyReport | null>;
export interface AttributionLatencyRow {
    chain: string;
    pattern_type: string;
    tier: string | null;
    execution_mode: string;
    sample_count: number;
    p50_detection_to_confirmation_ms: number;
    p95_detection_to_confirmation_ms: number;
    p50_submission_to_confirmation_ms: number;
    p95_submission_to_confirmation_ms: number;
}
export declare function getAttributionLatencyReport(): Promise<AttributionLatencyRow[]>;
export interface LiveShadowCostRow {
    chain: string;
    matched_trades: number;
    avg_execution_cost_bps: number;
}
export declare function getLiveShadowCostReport(): Promise<LiveShadowCostRow[]>;
export interface AttributionLedgerRow {
    trade_id: string;
    signal_id: string;
    chain: string;
    pattern_type: string;
    execution_mode: string;
    executed_at: Date | string;
    detected_at: Date | string | null;
    submitted_at: Date | string | null;
    confirmed_at: Date | string | null;
    slippage_bps: number | null;
    realized_pnl_usd: number | null;
}
export declare function getAttributionLedger(limit?: number): Promise<AttributionLedgerRow[]>;
export interface AttributionDashboardData {
    report: ExpectancyReport | null;
    latency: AttributionLatencyRow[];
    live_vs_shadow: LiveShadowCostRow[];
    ledger: AttributionLedgerRow[];
}
export declare function getAttributionDashboard(): Promise<AttributionDashboardData>;
//# sourceMappingURL=attribution-queries.d.ts.map