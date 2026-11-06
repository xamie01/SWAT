import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { extractManualThresholds, registerAttributionRoutes } from './attribution-routes.js';
const report = {
    id: 'report-1',
    generated_at: '2026-07-26T02:00:00.000Z',
    config_snapshot: {
        signals: {
            value: { min_signal_score: 70, auto_execute_min_score: 90 },
            updated_at: '2026-07-25T12:00:00.000Z'
        },
        trading: {
            value: { max_position_pct: 5, max_daily_exposure_pct: 25 },
            updated_at: '2026-07-25T12:00:00.000Z'
        },
        risk: {
            value: { stop_loss_pct: 20 },
            updated_at: '2026-07-25T12:00:00.000Z'
        }
    },
    rows: []
};
function createDependencies() {
    return {
        getDashboard: vi.fn(async () => ({
            report,
            latency: [{ chain: 'solana' }],
            live_vs_shadow: [{ chain: 'solana' }],
            ledger: [{ trade_id: 'trade-1' }]
        })),
        getExpectancy: vi.fn(async () => report),
        getLatency: vi.fn(async () => []),
        getShadowCost: vi.fn(async () => [])
    };
}
describe('attribution routes', () => {
    it('returns actual dashboard sections with the report threshold snapshot', async () => {
        const app = Fastify();
        const dependencies = createDependencies();
        registerAttributionRoutes(app, dependencies);
        const response = await app.inject({ method: 'GET', url: '/v1/trading/attribution' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            report,
            latency: [{ chain: 'solana' }],
            live_vs_shadow: [{ chain: 'solana' }],
            ledger: [{ trade_id: 'trade-1' }],
            manual_thresholds: {
                min_signal_score: 70,
                auto_execute_min_score: 90,
                max_position_pct: 5,
                max_daily_exposure_pct: 25,
                stop_loss_pct: 20,
                captured_at: report.generated_at
            }
        });
        expect(dependencies.getDashboard).toHaveBeenCalledOnce();
        await app.close();
    });
    it('does not invent thresholds when a report or numeric values are absent', () => {
        expect(extractManualThresholds(null)).toEqual({
            min_signal_score: null,
            auto_execute_min_score: null,
            max_position_pct: null,
            max_daily_exposure_pct: null,
            stop_loss_pct: null,
            captured_at: null
        });
        expect(extractManualThresholds({
            ...report,
            config_snapshot: {
                signals: { value: { min_signal_score: '70' }, updated_at: report.generated_at }
            }
        }).min_signal_score).toBeNull();
    });
    it.each([
        ['/v1/trading/expectancy', 'getExpectancy'],
        ['/v1/trading/latency', 'getLatency'],
        ['/v1/trading/shadow-cost', 'getShadowCost']
    ])('registers %s before the server starts', async (url, dependency) => {
        const app = Fastify();
        const dependencies = createDependencies();
        registerAttributionRoutes(app, dependencies);
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(200);
        expect(dependencies[dependency]).toHaveBeenCalledOnce();
        await app.close();
    });
});
//# sourceMappingURL=attribution-routes.test.js.map