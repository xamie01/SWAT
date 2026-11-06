function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : null;
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function extractManualThresholds(report) {
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
export function registerAttributionRoutes(app, dependencies) {
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
//# sourceMappingURL=attribution-routes.js.map