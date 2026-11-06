import { describe, expect, it } from 'vitest';
import { classifyRangeState, DEFAULT_EDGE_THRESHOLD } from './classifier.js';
import { evaluateRebalanceEconomics } from './economic-check.js';
import { buildMeteoraRebalancePlan } from './meteora-rebalance.js';
import { buildEvmRebalancePlan } from './evm-rebalance.js';
import { buildLadderPlan } from '../builder/ladder-plan.js';
describe('classifyRangeState (F2)', () => {
    const range = { rangeLower: 90, rangeUpper: 110 };
    it('labels mid-range prices active', () => {
        expect(classifyRangeState({ currentPrice: 100, ...range })).toBe('active');
    });
    it('labels prices within the edge band near_edge', () => {
        // Default threshold 0.1 of a 20-wide range = within 2 of an edge.
        expect(DEFAULT_EDGE_THRESHOLD).toBe(0.1);
        expect(classifyRangeState({ currentPrice: 91.5, ...range })).toBe('near_edge');
        expect(classifyRangeState({ currentPrice: 108.5, ...range })).toBe('near_edge');
    });
    it('labels crossed prices out_of_range on either side', () => {
        expect(classifyRangeState({ currentPrice: 89, ...range })).toBe('out_of_range');
        expect(classifyRangeState({ currentPrice: 111, ...range })).toBe('out_of_range');
    });
    it('rejects degenerate ranges and thresholds', () => {
        expect(() => classifyRangeState({ currentPrice: 100, rangeLower: 110, rangeUpper: 90 })).toThrow('rangeLower < rangeUpper');
        expect(() => classifyRangeState({ currentPrice: 100, ...range, edgeThreshold: 1 })).toThrow('edgeThreshold');
    });
});
describe('evaluateRebalanceEconomics (F3) — mock-data tested before wiring', () => {
    it('approves when projected fee uplift clears IL, gas, and churn', () => {
        const economics = evaluateRebalanceEconomics({
            expectedExtraFeesUsd: 60,
            impermanentLossUsd: 15,
            gasCostUsd: 5,
            rebalanceCostUsd: 10,
            inventoryChangeUsd: 0
        });
        expect(economics.shouldRebalance).toBe(true);
        expect(economics.netBenefitUsd).toBe(30);
        expect(economics.reasons).toEqual([]);
    });
    it('declines when the re-centering does not pay for itself', () => {
        const economics = evaluateRebalanceEconomics({
            expectedExtraFeesUsd: 20,
            impermanentLossUsd: 15,
            gasCostUsd: 5,
            rebalanceCostUsd: 10,
            inventoryChangeUsd: 0
        });
        expect(economics.shouldRebalance).toBe(false);
        expect(economics.netBenefitUsd).toBe(-10);
        expect(economics.reasons).toContain('net-benefit-not-positive');
    });
    it('declines when no fee uplift is projected even if the ledger nets positive', () => {
        const economics = evaluateRebalanceEconomics({
            expectedExtraFeesUsd: 0,
            impermanentLossUsd: 0,
            gasCostUsd: 0,
            rebalanceCostUsd: 0,
            inventoryChangeUsd: 50
        });
        expect(economics.shouldRebalance).toBe(false);
        expect(economics.reasons).toContain('no-fee-uplift-projected');
    });
});
describe('rebalance plan builders (F4/F5)', () => {
    const position = {
        onChainPositionAddress: 'solana:pos1',
        poolAddress: 'solana:pool1'
    };
    const plan = buildLadderPlan({
        protocol: 'meteora-dlmm',
        rangeLower: 90,
        rangeUpper: 110,
        rungCount: 2,
        distribution: 'spot',
        currentPrice: 100,
        binStep: 100,
        depositAmount: 1_000
    });
    it('meteora: remove steps precede add steps with a clean sequence', async () => {
        const port = {
            buildRemoveSteps: async () => [
                { sequence: 99, kind: 'remove-liquidity', description: 'remove', payload: {} },
                { sequence: 99, kind: 'collect-fees', description: 'collect', payload: {} }
            ],
            buildAddSteps: async () => [
                { sequence: 99, kind: 'add-liquidity', description: 'add rung 0', payload: {} },
                { sequence: 99, kind: 'add-liquidity', description: 'add rung 1', payload: {} }
            ]
        };
        const result = await buildMeteoraRebalancePlan(port, {
            position,
            plan,
            userAddress: 'user',
            signReady: true
        });
        expect(result.signReady).toBe(true);
        expect(result.steps.map((step) => step.sequence)).toEqual([0, 1, 2, 3]);
        expect(result.steps[0]?.kind).toBe('remove-liquidity');
        expect(result.steps.at(-1)?.kind).toBe('add-liquidity');
    });
    it('meteora: refuses to rebalance a position with no on-chain address', async () => {
        const port = {
            buildRemoveSteps: async () => [],
            buildAddSteps: async () => []
        };
        await expect(buildMeteoraRebalancePlan(port, {
            position: { onChainPositionAddress: null, poolAddress: 'solana:pool1' },
            plan,
            userAddress: 'user',
            signReady: false
        })).rejects.toThrow('no on-chain address');
    });
    it('evm: close, re-center swap, then remint, in order', async () => {
        const port = {
            buildCloseSteps: async () => [
                { sequence: 0, kind: 'remove-liquidity', description: 'decrease', payload: {} },
                { sequence: 1, kind: 'collect-fees', description: 'collect', payload: {} }
            ],
            buildRemintSteps: async () => [
                { sequence: 9, kind: 'mint-position', description: 'mint rung 0', payload: {} }
            ]
        };
        const result = await buildEvmRebalancePlan(port, {
            position: { onChainPositionAddress: 'robinhood-chain:0xpos', poolAddress: 'robinhood-chain:0xpool' },
            plan,
            recipient: '0xuser',
            signReady: false
        });
        expect(result.signReady).toBe(false);
        expect(result.steps.map((step) => step.kind)).toEqual([
            'remove-liquidity',
            'collect-fees',
            'swap',
            'mint-position'
        ]);
        expect(result.steps.map((step) => step.sequence)).toEqual([0, 1, 2, 3]);
    });
});
//# sourceMappingURL=monitor.test.js.map