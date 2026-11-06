import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
/**
 * `S4-M17` — proof that the *call site* walks the ladder.
 *
 * `polymarket-exit-escalation.test.ts` already covers the planner and the driver.
 * These cases are about the thing that was missing: `runPolymarketExitEscalationSweep`
 * turning a reconciled-unfilled sell into real rungs, and terminating in an alert
 * instead of escalating forever. `escalatePolymarketExit` is deliberately NOT
 * stubbed here — if the wiring stopped calling it, every assertion below fails.
 */
process.env.EVM_PRIVATE_KEY = 'test-only-placeholder';
process.env.POLYMARKET_SIGNATURE_TYPE = 'EOA';
process.env.POLYMARKET_BUILDER_CODE = `0x${'a'.repeat(64)}`;
process.env.POLYMARKET_MIN_EXIT_PRICE = '0.01';
vi.mock('ethers', () => {
    const mockProvider = { getNetwork: vi.fn().mockResolvedValue({ chainId: 137 }) };
    const mockWallet = {
        address: '0x1111111111111111111111111111111111111111',
        connect: vi.fn().mockReturnThis()
    };
    return {
        ethers: {
            providers: { JsonRpcProvider: vi.fn().mockReturnValue(mockProvider) },
            Wallet: vi.fn().mockReturnValue(mockWallet),
            utils: { getAddress: vi.fn((value) => value) }
        }
    };
});
vi.mock('@swat/db', () => ({
    query: vi.fn().mockResolvedValue([]),
    recordCopyExecutionEvidence: vi.fn().mockResolvedValue(undefined),
    transitionCopyExecution: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('@polymarket/client/actions', () => ({
    fetchBalanceAllowance: vi.fn(),
    fetchBuilderFeeRates: vi.fn()
}));
vi.mock('bullmq', () => ({
    UnrecoverableError: class UnrecoverableError extends Error {
    }
}));
const { POLYMARKET_EXIT_ESCALATION_MAX_AGE_MS, resetPolymarketExitEscalationMemoryForTesting, resolvePolymarketExitReferencePrice, runPolymarketExitEscalationSweep, setPolymarketLiveReadiness } = await import('./polymarket.js');
const { POLYMARKET_EXIT_ESCALATION_BPS } = await import('./polymarket-exit-escalation.js');
const NOW = 1_700_000_000_000;
const CONDITION_ID = `0x${'1'.repeat(64)}`;
const OPEN_MARKET = {
    conditionId: CONDITION_ID,
    active: true,
    closed: false,
    acceptingOrders: true,
    resolutionStatus: 'unresolved',
    endDate: new Date(NOW + 86_400_000),
    secondsDelay: null
};
function candidate(overrides = {}) {
    return {
        id: 'trade-1',
        copy_execution_id: 'exec-1',
        signal_id: 'signal-1',
        token_mint: 'polygon:99887766',
        status: 'partial',
        venue_order_id: 'order-fak-1',
        // The average price of the confirmed portion, which is the only price the
        // trade row actually persists — see `resolvePolymarketExitReferencePrice`.
        price_usd: '0.59',
        token_amount: '40',
        target_amount_usd: '82.6',
        ...overrides
    };
}
function book(overrides = {}) {
    return {
        tokenId: '99887766',
        conditionId: CONDITION_ID,
        tickSize: '0.01',
        minOrderSize: '5',
        timestamp: String(NOW),
        asks: [{ price: '0.62', size: '500' }],
        bids: overrides.bids ?? [{ price: '0.40', size: '1000' }]
    };
}
function harness(options = {}) {
    const submitted = [];
    const alerts = [];
    const redemptions = [];
    const submitRung = vi.fn(async (rung) => {
        submitted.push(rung);
        return { filledShares: options.fillPerRung ?? 0 };
    });
    return {
        submitted,
        alerts,
        redemptions,
        submitRung,
        ports: {
            loadCandidates: vi.fn(async () => options.candidates ?? [candidate()]),
            fetchBook: vi.fn(async () => book({ bids: options.bids })),
            fetchSellableShares: vi.fn(async () => options.sellableShares ?? 40),
            fetchMarketState: vi.fn(async () => options.market ?? OPEN_MARKET),
            submitRungFor: vi.fn(() => submitRung),
            emitAlert: vi.fn(async (alert) => { alerts.push(alert); }),
            requestRedemption: vi.fn(async (redeem) => { redemptions.push(redeem); }),
            now: () => NOW,
            log: () => { }
        }
    };
}
beforeEach(() => {
    resetPolymarketExitEscalationMemoryForTesting();
    setPolymarketLiveReadiness(true, 'test');
});
afterEach(() => {
    setPolymarketLiveReadiness(false, 'test teardown');
    resetPolymarketExitEscalationMemoryForTesting();
    vi.clearAllMocks();
});
describe('runPolymarketExitEscalationSweep — the call site of the ladder', () => {
    it('advances a rung for an unfilled sell and terminates in an alert, not in more rungs', async () => {
        const h = harness();
        const result = await runPolymarketExitEscalationSweep(h.ports);
        // Rung advanced: one rung per ladder step, each strictly cheaper than the
        // last, on the 0.01 tick grid, measured down from the 0.59 reference.
        expect(h.submitted.map((rung) => rung.price)).toEqual([0.58, 0.56, 0.53]);
        expect(h.submitted.map((rung) => rung.attempt)).toEqual([0, 1, 2]);
        expect(h.submitted.map((rung) => rung.rungBps)).toEqual([...POLYMARKET_EXIT_ESCALATION_BPS]);
        // And it stopped. The ladder alerted once instead of escalating forever.
        expect(h.submitRung).toHaveBeenCalledTimes(POLYMARKET_EXIT_ESCALATION_BPS.length);
        expect(h.alerts).toHaveLength(1);
        expect(h.alerts[0].code).toBe('exit-escalation-exhausted');
        expect(h.alerts[0].severity).toBe('critical');
        expect(h.alerts[0].remainingShares).toBe(40);
        expect(h.ports.emitAlert).toHaveBeenCalledTimes(1);
        expect(h.ports.emitAlert.mock.calls[0][1].id).toBe('trade-1');
        expect(result).toMatchObject({
            scanned: 1, escalated: 1, alerted: 1, redeemed: 0, failed: 0, skipped: 0
        });
        expect(result.outcomes[0].outcome.terminal).toBe('alert');
        expect(result.outcomes[0].outcome.rungsSubmitted).toBe(3);
    });
    it('re-observes between rungs, so a rung that fills the position ends the ladder', async () => {
        // The sweep observes once to build the ladder's input, then the driver
        // re-observes after each rung: 40 held, rung fills it, 0 left.
        const shares = [40, 0];
        const h = harness({ fillPerRung: 40 });
        h.ports.fetchSellableShares = vi.fn(async () => shares.shift() ?? 0);
        const result = await runPolymarketExitEscalationSweep(h.ports);
        expect(h.submitted).toHaveLength(1);
        expect(h.alerts).toHaveLength(0);
        expect(result).toMatchObject({ escalated: 1, completed: 1, alerted: 0 });
        expect(result.outcomes[0].outcome.terminal).toBe('complete');
        expect(result.outcomes[0].outcome.filledShares).toBe(40);
    });
    it('does not walk the same exit twice, so a later pass cannot re-alert it', async () => {
        const h = harness();
        const first = await runPolymarketExitEscalationSweep(h.ports);
        const second = await runPolymarketExitEscalationSweep(h.ports);
        expect(first.alerted).toBe(1);
        expect(second).toMatchObject({ scanned: 1, escalated: 0, alerted: 0, skipped: 1 });
        expect(second.skips[0].reason).toContain('already walked a ladder');
        // Still three rungs total across both passes, not six.
        expect(h.submitRung).toHaveBeenCalledTimes(3);
        expect(h.alerts).toHaveLength(1);
    });
    it('routes a market that stopped accepting orders to redemption instead of a rung', async () => {
        const h = harness({
            market: { ...OPEN_MARKET, acceptingOrders: false, closed: true, resolutionStatus: 'resolved' }
        });
        const result = await runPolymarketExitEscalationSweep(h.ports);
        expect(h.submitted).toHaveLength(0);
        expect(h.alerts).toHaveLength(0);
        expect(h.redemptions).toHaveLength(1);
        expect(h.redemptions[0].conditionId).toBe(CONDITION_ID);
        expect(result).toMatchObject({ escalated: 0, redeemed: 1, alerted: 0 });
    });
    it('alerts rather than escalating when there is no bid to escalate into', async () => {
        const h = harness({ bids: [] });
        const result = await runPolymarketExitEscalationSweep(h.ports);
        expect(h.submitted).toHaveLength(0);
        expect(h.alerts[0].code).toBe('no-bid-liquidity');
        expect(result).toMatchObject({ escalated: 0, alerted: 1 });
    });
    it('submits nothing when Polymarket live execution is not ready', async () => {
        setPolymarketLiveReadiness(false, 'uncertified in this environment');
        const h = harness();
        const result = await runPolymarketExitEscalationSweep(h.ports);
        expect(h.ports.loadCandidates).not.toHaveBeenCalled();
        expect(h.submitRung).not.toHaveBeenCalled();
        expect(result).toMatchObject({ scanned: 0, escalated: 0, alerted: 0 });
    });
    it('honours the per-pass limit so one ladder cannot monopolise the reconciliation pass', async () => {
        const h = harness({
            candidates: [candidate(), candidate({ id: 'trade-2', venue_order_id: 'order-fak-2' })]
        });
        const result = await runPolymarketExitEscalationSweep(h.ports);
        expect(result.scanned).toBe(2);
        expect(result.escalated).toBe(1);
        expect(h.submitRung).toHaveBeenCalledTimes(3);
    });
});
describe('the escalation reference price is the missing state', () => {
    it('skips a zero-fill exit, because no price it offered was ever persisted', async () => {
        const h = harness({ candidates: [candidate({ status: 'cancelled', price_usd: null })] });
        const result = await runPolymarketExitEscalationSweep(h.ports);
        expect(h.submitRung).not.toHaveBeenCalled();
        expect(h.alerts).toHaveLength(0);
        expect(result).toMatchObject({ scanned: 1, escalated: 0, skipped: 1 });
        expect(result.skips[0].reason).toContain('no confirmed fill');
        expect(result.skips[0].reason).toContain('signed mirror bound');
    });
    it('reads the reference from the confirmed average price of a partial fill', () => {
        expect(resolvePolymarketExitReferencePrice({ id: 't', status: 'partial', price_usd: '0.59' }))
            .toEqual({ kind: 'reference', referencePrice: 0.59 });
    });
    it('refuses a persisted price that is not a valid outcome price', () => {
        expect(resolvePolymarketExitReferencePrice({ id: 't', status: 'partial', price_usd: '1.4' }))
            .toMatchObject({ kind: 'unavailable' });
        expect(resolvePolymarketExitReferencePrice({ id: 't', status: 'partial', price_usd: '0' }))
            .toMatchObject({ kind: 'unavailable' });
    });
    it('bounds how far back a failed exit stays escalatable', () => {
        expect(POLYMARKET_EXIT_ESCALATION_MAX_AGE_MS).toBe(60 * 60 * 1000);
    });
});
/**
 * Audit finding `C1`: reconciliation work runs inside the one guarded
 * `reconcilePending` pass. A previous violation added a second timer, so this is
 * asserted against the source rather than trusted to review.
 */
describe('C1 — the sweep runs inside the existing guarded pass', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    it('adds no timer', () => {
        // The two that already existed: periodic reconciliation and order polling.
        expect(source.match(/setInterval\(/g)).toHaveLength(2);
    });
    it('calls the sweep from inside the reconciliation guard', () => {
        const guardStart = source.indexOf('const reconcilePending = async () => {');
        const guardEnd = source.indexOf('reconciliationRunning = false;', guardStart);
        expect(guardStart).toBeGreaterThan(-1);
        expect(guardEnd).toBeGreaterThan(guardStart);
        const call = source.indexOf('runPolymarketExitEscalationSweep({');
        expect(call).toBeGreaterThan(guardStart);
        expect(call).toBeLessThan(guardEnd);
        // After the canonical coordinator, so a resting rung cannot delay the fast
        // per-venue sweeps.
        expect(call).toBeGreaterThan(source.indexOf('runReconciliationCoordinator({'));
    });
});
//# sourceMappingURL=polymarket-exit-escalation-wiring.test.js.map