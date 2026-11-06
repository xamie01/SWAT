import { beforeEach, describe, expect, it, vi } from 'vitest';
const dbMocks = vi.hoisted(() => ({
    createLpPosition: vi.fn(),
    transitionLpPosition: vi.fn()
}));
vi.mock('@swat/db', () => dbMocks);
import { buildPosition } from './build-position.js';
const scope = { userId: 'user-1' };
const poolView = {
    getPool: async () => ({
        protocol: 'meteora-dlmm',
        binStep: 50,
        tickSpacing: null,
        currentPrice: 100
    })
};
const allowGuard = {
    assertDeployAllowed: async () => ({ allowed: true, reasons: [] })
};
const paperMode = {
    resolveMode: async () => 'paper'
};
const meteoraBuilder = {
    buildLadder: vi.fn(async ({ plan }) => plan.rungs.map((rung, index) => ({
        rungIndex: index,
        kind: 'initialize-position-and-add-liquidity',
        totalXAmount: rung.allocation,
        totalYAmount: 0,
        binLower: rung.binLower,
        binUpper: rung.binUpper,
        strategy: 'spot',
        description: `rung ${index}`
    })))
};
const deps = (overrides = {}) => ({
    executionMode: paperMode,
    deployGuard: allowGuard,
    poolView,
    meteoraBuilder,
    createPosition: dbMocks.createLpPosition,
    transitionPosition: dbMocks.transitionLpPosition,
    userAddress: 'solana:user',
    ...overrides
});
const request = {
    chain: 'solana',
    poolAddress: 'solana:pair',
    template: 'tight-spot-scalp',
    depositAmount: 1_000,
    depositAsset: 'solana:usdc'
};
beforeEach(() => {
    dbMocks.createLpPosition.mockReset();
    dbMocks.transitionLpPosition.mockReset();
    meteoraBuilder.buildLadder.mockClear();
    dbMocks.createLpPosition.mockImplementation(async (_scope, input) => ({
        id: 'pos-1',
        state: 'building',
        ...input
    }));
    dbMocks.transitionLpPosition.mockImplementation(async (_scope, _id, transition) => ({
        id: 'pos-1',
        state: transition.toState
    }));
});
describe('buildPosition', () => {
    it('persists a building position and returns the paper-mode plan', async () => {
        const result = await buildPosition(deps(), scope, request);
        expect(result.mode).toBe('paper');
        expect(result.positionId).toBe('pos-1');
        expect(result.steps).toHaveLength(5); // tight-spot-scalp = 5 rungs
        expect(result.rejectionReasons).toEqual([]);
        expect(dbMocks.createLpPosition).toHaveBeenCalledWith(scope, expect.objectContaining({
            chain: 'solana',
            protocol: 'meteora-dlmm',
            poolAddress: 'solana:pair',
            strategyType: 'spot',
            depositAmount: 1_000,
            depositAsset: 'solana:usdc'
        }));
        // Paper: the recorded plan IS the build — the position must become
        // monitorable, or it would sit in `building` forever.
        expect(dbMocks.transitionLpPosition).toHaveBeenCalledWith(scope, 'pos-1', expect.objectContaining({ toState: 'active' }));
    });
    it('a live-mode build stays building — the executor confirms the transition', async () => {
        await buildPosition(deps({ executionMode: { resolveMode: async () => 'live' } }), scope, request);
        expect(dbMocks.transitionLpPosition).not.toHaveBeenCalled();
    });
    it('an off chain refuses before the guard even runs', async () => {
        const guard = { assertDeployAllowed: vi.fn() };
        await expect(buildPosition(deps({ executionMode: { resolveMode: async () => 'off' }, deployGuard: guard }), scope, request)).rejects.toThrow('off');
        expect(guard.assertDeployAllowed).not.toHaveBeenCalled();
    });
    it('a guard refusal returns the reasons with an empty bundle, no position written', async () => {
        const result = await buildPosition(deps({
            deployGuard: {
                assertDeployAllowed: async () => ({ allowed: false, reasons: ['exposure cap hit'] })
            }
        }), scope, request);
        expect(result.positionId).toBe('');
        expect(result.rejectionReasons).toEqual(['exposure cap hit']);
        expect(result.steps).toEqual([]);
        expect(dbMocks.createLpPosition).not.toHaveBeenCalled();
    });
    it('a pool missing from the scan cache is an error, not an empty plan', async () => {
        await expect(buildPosition(deps({ poolView: { getPool: async () => null } }), scope, request)).rejects.toThrow('not in the scan cache');
    });
    it('custom params override templates and both together is an error', async () => {
        const custom = { rangeLower: 90, rangeUpper: 110, rungCount: 2, distribution: 'spot' };
        const result = await buildPosition(deps(), scope, { ...request, template: undefined, custom });
        expect(result.rungs).toHaveLength(2);
        await expect(buildPosition(deps(), scope, { ...request, custom })).rejects.toThrow('not both');
    });
    it('a pool without a current price cannot anchor a ladder', async () => {
        await expect(buildPosition(deps({
            poolView: { getPool: async () => ({ protocol: 'meteora-dlmm', binStep: 50, tickSpacing: null, currentPrice: null }) }
        }), scope, request)).rejects.toThrow('no current price');
    });
    it('routes robinhood-chain pools through the evm builder', async () => {
        const evmBuilder = {
            buildLadder: vi.fn(async ({ plan }) => plan.rungs.map((_, index) => ({
                rungIndex: index,
                kind: 'mint-position',
                description: `rung ${index}`,
                payload: {}
            })))
        };
        const result = await buildPosition(deps({
            meteoraBuilder: undefined,
            evmBuilder,
            poolView: {
                getPool: async () => ({ protocol: 'uniswap-v3', binStep: null, tickSpacing: 60, currentPrice: 1 })
            }
        }), scope, { ...request, chain: 'robinhood-chain', poolAddress: 'robinhood-chain:0xpool', depositAsset: 'robinhood-chain:0xusdc' });
        expect(evmBuilder.buildLadder).toHaveBeenCalledTimes(1);
        expect(result.steps.every((step) => step.kind === 'mint-position')).toBe(true);
    });
});
//# sourceMappingURL=build-position.test.js.map