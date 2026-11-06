import { describe, expect, it, vi } from 'vitest';
import { POLYMARKET_EXIT_ESCALATION_BPS, POLYMARKET_EXIT_RUNG_EFFECTIVE_MS, POLYMARKET_GTD_SECURITY_THRESHOLD_MS, escalatePolymarketExit, planPolymarketExitEscalation, polymarketGtdExpiration } from './polymarket-exit-escalation.js';
/**
 * `S4-M17` — an unfilled exit escalates, then alerts.
 *
 * The cases below are the branches that decide whether a user keeps holding a
 * position their master has left: each ladder bound, each terminal, and the
 * driver's guarantee that it alerts exactly once and never past a bound.
 */
const NOW = 1_700_000_000_000;
const OPEN_MARKET = {
    conditionId: `0x${'1'.repeat(64)}`,
    acceptingOrders: true,
    closed: false,
    resolutionStatus: 'unresolved'
};
const BASE = {
    attempt: 0,
    remainingShares: 50,
    minimumShares: 5,
    tickSize: 0.01,
    referencePrice: 0.59,
    bestBid: 0.58,
    minimumExitPrice: 0.01,
    market: OPEN_MARKET,
    now: NOW
};
function rung(step) {
    expect(step.kind).toBe('limit');
    return step;
}
describe('polymarket exit escalation ladder', () => {
    it('prices the first rung strictly below the bound that just failed', () => {
        // The reference is the bound of the failed FAK, not the master's raw fill, so
        // rung zero is a real concession rather than a re-offer of the same price.
        const step = rung(planPolymarketExitEscalation(BASE));
        expect(step.rungBps).toBe(POLYMARKET_EXIT_ESCALATION_BPS[0]);
        expect(step.price).toBe(0.58); // floor(0.59 × 0.985 = 0.58115)
        expect(step.price).toBeLessThan(BASE.referencePrice);
        expect(step.shares).toBe(50);
    });
    it('deepens each rung and never rises', () => {
        const prices = POLYMARKET_EXIT_ESCALATION_BPS.map((_, attempt) => rung(planPolymarketExitEscalation({ ...BASE, attempt })).price);
        expect(prices).toEqual([0.58, 0.56, 0.53]);
        for (let index = 1; index < prices.length; index += 1) {
            expect(prices[index]).toBeLessThan(prices[index - 1]);
        }
    });
    it('floors each rung to the tick grid so the price is submittable', () => {
        for (const tickSize of [0.1, 0.01, 0.005, 0.0025, 0.001, 0.0001]) {
            for (let attempt = 0; attempt < POLYMARKET_EXIT_ESCALATION_BPS.length; attempt += 1) {
                const step = planPolymarketExitEscalation({ ...BASE, tickSize, attempt });
                if (step.kind !== 'limit')
                    continue;
                const ticks = step.price / tickSize;
                expect(Math.abs(ticks - Math.round(ticks)), `tick ${tickSize} rung ${attempt}`)
                    .toBeLessThan(1e-6);
                // Floored, so a rung never asks for more than the sanctioned concession.
                expect(step.price).toBeLessThanOrEqual(BASE.referencePrice * (1 - POLYMARKET_EXIT_ESCALATION_BPS[attempt] / 10_000) + 1e-9);
            }
        }
    });
    it('sets a GTD expiration using the documented now + 60 + N formula', () => {
        const step = rung(planPolymarketExitEscalation(BASE));
        expect(step.effectiveLifetimeMs).toBe(POLYMARKET_EXIT_RUNG_EFFECTIVE_MS);
        expect(step.expiration).toBe(Math.floor((NOW + POLYMARKET_EXIT_RUNG_EFFECTIVE_MS + POLYMARKET_GTD_SECURITY_THRESHOLD_MS) / 1000));
        // Documented venue floor: at least 3 minutes ahead, or the order is rejected.
        expect(step.expiration - NOW / 1000).toBeGreaterThanOrEqual(180);
    });
    it('refuses a rung lifetime the venue would reject outright', () => {
        // Two minutes is the documented minimum effective lifetime. Silently raising a
        // shorter one would hide a misconfiguration behind a longer-resting order.
        expect(() => polymarketGtdExpiration(NOW, 119_000)).toThrow(/at least 3 minutes/);
        expect(polymarketGtdExpiration(NOW, 120_000)).toBe(Math.floor((NOW + 180_000) / 1000));
    });
    it('reports whether a rung should fill on arrival or rest', () => {
        expect(rung(planPolymarketExitEscalation({ ...BASE, bestBid: 0.58 })).crossesBook).toBe(true);
        expect(rung(planPolymarketExitEscalation({ ...BASE, bestBid: 0.5 })).crossesBook).toBe(false);
    });
    it('alerts rather than pricing below the operator exit floor', () => {
        // The floor is the line between "a stuck position" and "a realised loss we
        // chose for the user". Crossing it is a human's decision.
        const step = planPolymarketExitEscalation({
            ...BASE,
            referencePrice: 0.05,
            minimumExitPrice: 0.05,
            attempt: 0
        });
        expect(step).toMatchObject({
            kind: 'alert',
            code: 'exit-price-floor-reached',
            severity: 'critical'
        });
    });
    it('alerts when every rung has been tried and none filled', () => {
        const step = planPolymarketExitEscalation({
            ...BASE,
            attempt: POLYMARKET_EXIT_ESCALATION_BPS.length
        });
        expect(step).toMatchObject({
            kind: 'alert',
            code: 'exit-escalation-exhausted',
            severity: 'critical',
            remainingShares: 50
        });
    });
    it('routes a market that stopped accepting orders to redemption, not to a rung', () => {
        // No price fills once orders are refused, so escalating is pure latency, and
        // redemption has no deadline.
        for (const market of [
            { ...OPEN_MARKET, acceptingOrders: false },
            { ...OPEN_MARKET, closed: true },
            { ...OPEN_MARKET, resolutionStatus: 'proposed' }
        ]) {
            expect(planPolymarketExitEscalation({ ...BASE, market })).toMatchObject({
                kind: 'redeem',
                conditionId: OPEN_MARKET.conditionId
            });
        }
    });
    it('checks the redemption path before the ladder is exhausted', () => {
        // Ordering matters: a resolved market on the last rung must redeem rather than
        // page a human about an order that cannot exist.
        expect(planPolymarketExitEscalation({
            ...BASE,
            attempt: POLYMARKET_EXIT_ESCALATION_BPS.length,
            market: { ...OPEN_MARKET, closed: true }
        }).kind).toBe('redeem');
    });
    it('warns rather than pages on a residual the venue will not accept', () => {
        const step = planPolymarketExitEscalation({ ...BASE, remainingShares: 4.5 });
        expect(step).toMatchObject({
            kind: 'alert',
            code: 'residual-below-venue-minimum',
            severity: 'warning'
        });
    });
    it('pages when there is no bid to escalate into', () => {
        expect(planPolymarketExitEscalation({ ...BASE, bestBid: null })).toMatchObject({
            kind: 'alert',
            code: 'no-bid-liquidity',
            severity: 'critical'
        });
    });
    it('reports a fully exited position as complete', () => {
        expect(planPolymarketExitEscalation({ ...BASE, remainingShares: 0 }).kind).toBe('complete');
    });
    it('rejects a ladder that does not deepen', () => {
        expect(() => planPolymarketExitEscalation({ ...BASE, escalationBps: [150, 150] }))
            .toThrow(/increase strictly/);
        expect(() => planPolymarketExitEscalation({ ...BASE, escalationBps: [400, 150] }))
            .toThrow(/increase strictly/);
        expect(() => planPolymarketExitEscalation({ ...BASE, escalationBps: [0] }))
            .toThrow(/from 1 to 10000/);
    });
});
function ports(overrides) {
    const fills = overrides.fills ?? [];
    const submitted = [];
    const alerts = [];
    const redemptions = [];
    let observationIndex = 0;
    let remainingShares = 50;
    return {
        submitted,
        alerts,
        redemptions,
        ports: {
            submitRung: vi.fn(async (step) => {
                submitted.push(step);
                const filledShares = fills[submitted.length - 1] ?? 0;
                remainingShares = Math.max(0, remainingShares - filledShares);
                return { filledShares };
            }),
            observe: vi.fn(async () => {
                const override = overrides.observations?.[observationIndex] ?? {};
                observationIndex += 1;
                return {
                    remainingShares,
                    bestBid: 0.58,
                    minimumShares: 5,
                    tickSize: 0.01,
                    market: OPEN_MARKET,
                    ...override
                };
            }),
            emitAlert: vi.fn(async (alert) => { alerts.push(alert); }),
            requestRedemption: vi.fn(async (redeem) => { redemptions.push(redeem); }),
            now: () => NOW
        }
    };
}
const DRIVER_INPUT = {
    remainingShares: 50,
    minimumShares: 5,
    tickSize: 0.01,
    referencePrice: 0.59,
    bestBid: 0.58,
    minimumExitPrice: 0.01,
    market: OPEN_MARKET
};
describe('polymarket exit escalation driver', () => {
    it('stops at the first rung that clears the position and raises no alert', () => {
        const harness = ports({ fills: [50] });
        return escalatePolymarketExit(DRIVER_INPUT, harness.ports).then((outcome) => {
            expect(outcome).toMatchObject({
                rungsSubmitted: 1,
                filledShares: 50,
                terminal: 'complete',
                alert: null
            });
            expect(harness.ports.emitAlert).not.toHaveBeenCalled();
        });
    });
    it('walks every rung and alerts exactly once when none fill', async () => {
        const harness = ports({ fills: [0, 0, 0] });
        const outcome = await escalatePolymarketExit(DRIVER_INPUT, harness.ports);
        expect(outcome.rungsSubmitted).toBe(POLYMARKET_EXIT_ESCALATION_BPS.length);
        expect(outcome.terminal).toBe('alert');
        expect(outcome.alert?.code).toBe('exit-escalation-exhausted');
        // Once. An alert per rung would train an operator to ignore the channel.
        expect(harness.alerts).toHaveLength(1);
        expect(harness.submitted.map((step) => step.price)).toEqual([0.58, 0.56, 0.53]);
    });
    it('continues escalating after a partial fill and reports the total', async () => {
        const harness = ports({ fills: [20, 30] });
        const outcome = await escalatePolymarketExit(DRIVER_INPUT, harness.ports);
        expect(outcome.filledShares).toBe(50);
        expect(outcome.rungsSubmitted).toBe(2);
        expect(outcome.terminal).toBe('complete');
    });
    it('redeems instead of escalating when the market resolves mid-ladder', async () => {
        // A rung rests for two minutes, which is long enough for a market to stop
        // accepting orders. Escalating against the stale reading would price into a
        // market that no longer exists.
        const harness = ports({
            fills: [0, 0, 0],
            observations: [{ market: { ...OPEN_MARKET, closed: true } }]
        });
        const outcome = await escalatePolymarketExit(DRIVER_INPUT, harness.ports);
        expect(outcome.terminal).toBe('redeem');
        expect(outcome.rungsSubmitted).toBe(1);
        expect(harness.redemptions).toHaveLength(1);
        expect(harness.ports.emitAlert).not.toHaveBeenCalled();
    });
    it('advances rather than re-offering a price a coarse grid repeats', async () => {
        // On a 0.1 grid every rung off 0.59 floors to 0.5. Submitting it three times
        // would spend six minutes re-offering a price that already failed.
        const harness = ports({ fills: [0, 0, 0], observations: [{ tickSize: 0.1 }, { tickSize: 0.1 }] });
        const outcome = await escalatePolymarketExit({ ...DRIVER_INPUT, tickSize: 0.1 }, harness.ports);
        expect(harness.submitted.map((step) => step.price)).toEqual([0.5]);
        expect(outcome.terminal).toBe('alert');
        expect(outcome.alert?.code).toBe('exit-escalation-exhausted');
    });
    it('alerts without submitting anything when there is no bid', async () => {
        const harness = ports({});
        const outcome = await escalatePolymarketExit({ ...DRIVER_INPUT, bestBid: null }, harness.ports);
        expect(harness.ports.submitRung).not.toHaveBeenCalled();
        expect(outcome.alert?.code).toBe('no-bid-liquidity');
    });
});
//# sourceMappingURL=polymarket-exit-escalation.test.js.map