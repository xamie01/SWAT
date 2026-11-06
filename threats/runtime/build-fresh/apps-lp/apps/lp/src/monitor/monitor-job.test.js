import { describe, expect, it, vi } from 'vitest';
import { runMonitorPass } from './monitor-job.js';
function position(overrides = {}) {
    return {
        id: 'pos-1',
        chain: 'solana',
        poolAddress: 'solana:pool1',
        strategyType: 'spot',
        rangeLower: 90,
        rangeUpper: 110,
        state: 'active',
        onChainPositionAddress: 'solana:pos1',
        autoRebalance: false,
        ...overrides
    };
}
function ports(overrides = {}) {
    return {
        pricePoller: { currentPrice: vi.fn(async () => 100) },
        economics: {
            estimate: vi.fn(async () => ({
                expectedExtraFeesUsd: 60,
                impermanentLossUsd: 15,
                gasCostUsd: 5,
                rebalanceCostUsd: 10,
                inventoryChangeUsd: 0
            }))
        },
        listPositions: vi.fn(async () => [position()]),
        transition: vi.fn(async () => ({})),
        queueRebalance: vi.fn(async () => undefined),
        ...overrides
    };
}
describe('runMonitorPass (F1/F6)', () => {
    it('an in-range price leaves an active position untouched', async () => {
        const ports_ = ports();
        const summary = await runMonitorPass(ports_, 'solana');
        expect(summary.positionsChecked).toBe(1);
        expect(summary.transitions).toEqual([]);
        expect(ports_.transition).not.toHaveBeenCalled();
        expect(ports_.queueRebalance).not.toHaveBeenCalled();
    });
    it('a drift to near_edge transitions the state and queues a positive rebalance', async () => {
        const ports_ = ports({
            pricePoller: { currentPrice: vi.fn(async () => 91) },
            listPositions: vi.fn(async () => [position({ autoRebalance: true })])
        });
        const summary = await runMonitorPass(ports_, 'solana');
        expect(summary.transitions).toEqual([
            { positionId: 'pos-1', from: 'active', to: 'near_edge' }
        ]);
        expect(summary.rebalancesQueued).toBe(1);
        expect(ports_.queueRebalance).toHaveBeenCalledWith(expect.objectContaining({ positionId: 'pos-1', chain: 'solana', netBenefitUsd: 30 }));
    });
    it('a state observation matching the stored state skips the transition but still gates rebalancing', async () => {
        const ports_ = ports({ pricePoller: { currentPrice: vi.fn(async () => 50) } });
        // Position stored as out_of_range already: observation matches, no transition,
        // but the economic gate still runs for out_of_range positions.
        const summary = await runMonitorPass({ ...ports_, listPositions: vi.fn(async () => [position({ state: 'out_of_range', autoRebalance: true })]) }, 'solana');
        expect(summary.transitions).toEqual([]);
        expect(summary.rebalancesQueued).toBe(1);
    });
    it('a position without the auto-rebalance opt-in is flagged, never queued', async () => {
        const ports_ = ports({ pricePoller: { currentPrice: vi.fn(async () => 91) } });
        const summary = await runMonitorPass(ports_, 'solana');
        // state still transitions (that IS the recommendation), economics untouched
        expect(summary.transitions).toEqual([
            { positionId: 'pos-1', from: 'active', to: 'near_edge' }
        ]);
        expect(summary.rebalancesQueued).toBe(0);
        expect(summary.rebalancesDeclined).toEqual([
            { positionId: 'pos-1', reason: 'auto-rebalance-not-opted-in' }
        ]);
        expect(ports_.economics.estimate).not.toHaveBeenCalled();
        expect(ports_.queueRebalance).not.toHaveBeenCalled();
    });
    it('an opted-in position auto-fires exactly as before', async () => {
        const ports_ = ports({
            pricePoller: { currentPrice: vi.fn(async () => 91) },
            listPositions: vi.fn(async () => [position({ autoRebalance: true })])
        });
        const summary = await runMonitorPass(ports_, 'solana');
        expect(summary.rebalancesQueued).toBe(1);
        expect(summary.rebalancesDeclined).toEqual([]);
        expect(ports_.queueRebalance).toHaveBeenCalledWith(expect.objectContaining({ positionId: 'pos-1', netBenefitUsd: 30 }));
    });
    it('a declining economic projection records the decline instead of queueing', async () => {
        const ports_ = ports({
            pricePoller: { currentPrice: vi.fn(async () => 91) },
            listPositions: vi.fn(async () => [position({ autoRebalance: true })]),
            economics: {
                estimate: vi.fn(async () => ({
                    expectedExtraFeesUsd: 5,
                    impermanentLossUsd: 15,
                    gasCostUsd: 5,
                    rebalanceCostUsd: 10,
                    inventoryChangeUsd: 0
                }))
            }
        });
        const summary = await runMonitorPass(ports_, 'solana');
        expect(summary.rebalancesQueued).toBe(0);
        expect(summary.rebalancesDeclined[0]?.positionId).toBe('pos-1');
        expect(summary.rebalancesDeclined[0]?.reason).toContain('net-benefit-not-positive');
    });
    it('an unreadable price is counted and skipped, never treated as in-range', async () => {
        const ports_ = ports({ pricePoller: { currentPrice: vi.fn(async () => null) } });
        const summary = await runMonitorPass(ports_, 'solana');
        expect(summary.unreadablePrices).toBe(1);
        expect(ports_.transition).not.toHaveBeenCalled();
    });
    it('a refused transition (racing a close) does not abort the sweep', async () => {
        const ports_ = ports({
            pricePoller: { currentPrice: vi.fn(async () => 91) },
            transition: vi.fn(async () => {
                throw new Error('invalid lp position transition: closed -> near_edge');
            }),
            listPositions: vi.fn(async () => [
                position(),
                position({ id: 'pos-2', poolAddress: 'solana:pool2' })
            ])
        });
        const summary = await runMonitorPass(ports_, 'solana');
        expect(summary.transitions).toEqual([]);
        expect(summary.positionsChecked).toBe(2);
    });
});
//# sourceMappingURL=monitor-job.test.js.map