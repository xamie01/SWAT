import { describe, expect, it, vi } from 'vitest';
// risk-pass.ts hard-imports the db module for its default ports; mocking keeps
// this a unit test — the real client throws without DATABASE_URL at import.
const dbMocks = vi.hoisted(() => ({
    attachLpPoolRisk: vi.fn(),
    listUnassessedLpPools: vi.fn()
}));
vi.mock('@swat/db', () => dbMocks);
import { runRiskPass } from './risk-pass.js';
function pool(overrides = {}) {
    return {
        id: 'pool-1',
        chain: 'solana',
        protocol: 'meteora-dlmm',
        poolAddress: 'solana:pool-a',
        pairLabel: 'SOL/USDC',
        baseTokenMint: 'solana:sol',
        quoteTokenMint: 'solana:usdc',
        feeBps: 20,
        binStep: 10,
        tickSpacing: null,
        currentPrice: 150,
        tvl: 1_000_000,
        activeTvl: 400_000,
        volume24h: 900_000,
        feeApr24h: 0.004,
        feeApr7d: 0.024,
        riskScore: null,
        riskFlags: [],
        lastScannedAt: new Date(),
        createdAt: new Date(),
        ...overrides
    };
}
describe('runRiskPass', () => {
    it('scores each unassessed pool with its chain\u2019s checks and attaches the result', async () => {
        const listUnassessed = vi.fn(async () => [pool()]);
        const attachRisk = vi.fn(async () => undefined);
        const mintFlag = async () => [
            { flag: 'mint_authority_active', detail: 'can mint' }
        ];
        const summary = await runRiskPass({
            checksByChain: { solana: [mintFlag] },
            listUnassessed,
            attachRisk
        });
        expect(summary).toEqual({ assessed: 1, failed: 0, skippedNoChecks: 0 });
        const [chain, address, score, flags] = attachRisk.mock.calls[0];
        expect(chain).toBe('solana');
        expect(address).toBe('solana:pool-a');
        expect(score).toBe(50);
        expect(flags).toEqual(['mint_authority_active']);
    });
    it('one pool failing its checks leaves it unassessed and reports the failure', async () => {
        const listUnassessed = vi.fn(async () => [
            pool(),
            pool({ id: 'pool-2', poolAddress: 'solana:pool-b' })
        ]);
        const attachRisk = vi.fn(async () => undefined);
        const failingCheck = async (context) => {
            if (context.poolAddress === 'solana:pool-b') {
                throw new Error('RPC timeout');
            }
            return [];
        };
        const summary = await runRiskPass({
            checksByChain: { solana: [failingCheck] },
            listUnassessed,
            attachRisk
        });
        expect(summary).toEqual({ assessed: 1, failed: 1, skippedNoChecks: 0 });
        expect(attachRisk).toHaveBeenCalledTimes(1);
        expect(attachRisk.mock.calls[0][1]).toBe('solana:pool-a');
    });
    it('a chain with no configured checks stays unassessed instead of scoring 0', async () => {
        const listUnassessed = vi.fn(async () => [pool({ chain: 'robinhood-chain' })]);
        const attachRisk = vi.fn(async () => undefined);
        const summary = await runRiskPass({
            checksByChain: { solana: [] },
            listUnassessed,
            attachRisk
        });
        // Score 0 would read as "clean" and put the pool on the Discover feed;
        // leaving risk_score NULL keeps it off until the chain has real checks.
        expect(summary).toEqual({ assessed: 0, failed: 0, skippedNoChecks: 1 });
        expect(attachRisk).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=risk-pass.test.js.map