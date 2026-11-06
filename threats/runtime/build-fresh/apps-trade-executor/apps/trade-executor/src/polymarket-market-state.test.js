import { describe, expect, it, vi } from 'vitest';
import { assertPolymarketMarketOpenForSubmission, assertPolymarketMarketTradable, fetchPolymarketMarketState, parsePolymarketMarketState, PolymarketMarketClosedError } from './polymarket-market-state.js';
const CONDITION_ID = `0x${'a'.repeat(64)}`;
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
function gammaMarket(overrides = {}) {
    return {
        conditionId: CONDITION_ID,
        active: true,
        closed: false,
        acceptingOrders: true,
        umaResolutionStatus: 'unresolved',
        endDate: FUTURE,
        secondsDelay: 0,
        ...overrides
    };
}
function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}
function state(overrides = {}) {
    return {
        conditionId: CONDITION_ID,
        active: true,
        closed: false,
        acceptingOrders: true,
        resolutionStatus: 'unresolved',
        endDate: new Date(Date.now() + 86_400_000),
        secondsDelay: 0,
        ...overrides
    };
}
describe('Polymarket market-state gate', () => {
    it('permits an open, active, unresolved market that has not ended', () => {
        expect(() => assertPolymarketMarketTradable(state())).not.toThrow();
    });
    it.each([
        ['closed', { closed: true }, 'is closed'],
        ['inactive', { active: false }, 'is not active'],
        ['paused for orders', { acceptingOrders: false }, 'is paused for orders'],
        ['resolving', { resolutionStatus: 'proposed' }, 'is resolving (proposed)'],
        ['ended', { endDate: new Date(Date.now() - 1_000) }, 'ended at']
    ])('refuses a market that is %s', (_label, overrides, message) => {
        expect(() => assertPolymarketMarketTradable(state(overrides))).toThrow(message);
    });
    it('treats an unreadable market as untradable rather than open', async () => {
        // Defaulting to "open" on a failed lookup would turn every Gamma outage
        // into permission to trade blind.
        const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, 503));
        await expect(fetchPolymarketMarketState(CONDITION_ID, fetchImpl))
            .rejects.toBeInstanceOf(PolymarketMarketClosedError);
    });
    it('rejects a response for a different condition', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse([
            gammaMarket({ conditionId: `0x${'b'.repeat(64)}` })
        ]));
        await expect(fetchPolymarketMarketState(CONDITION_ID, fetchImpl))
            .rejects.toThrow('for requested');
    });
    it('derives acceptingOrders from active/closed when the flag is absent', () => {
        const derived = parsePolymarketMarketState({ conditionId: CONDITION_ID, active: true, closed: true, endDate: FUTURE }, CONDITION_ID);
        expect(derived.acceptingOrders).toBe(false);
        // A closed market with no explicit UMA status is 'unknown', not 'unresolved'.
        expect(derived.resolutionStatus).toBe('unknown');
        expect(() => assertPolymarketMarketTradable(derived)).toThrow('is closed');
    });
    it('refuses a market missing or carrying an invalid end date', () => {
        expect(() => parsePolymarketMarketState({ conditionId: CONDITION_ID, active: true, closed: false }, CONDITION_ID)).toThrow('missing its end date');
        expect(() => parsePolymarketMarketState({ conditionId: CONDITION_ID, active: true, closed: false, endDate: 'soon' }, CONDITION_ID)).toThrow('invalid end date');
    });
    it('queries the condition and passes an open market through', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse([gammaMarket()]));
        const resolved = await assertPolymarketMarketOpenForSubmission({
            conditionId: CONDITION_ID.toUpperCase(),
            fetchImpl
        });
        expect(String(fetchImpl.mock.calls[0][0])).toContain(`condition_id=${CONDITION_ID}`);
        expect(resolved.acceptingOrders).toBe(true);
    });
    it('falls back to endDateIso when endDate is absent', () => {
        // Gamma types BOTH `endDate` and `endDateIso` as nullable
        // (`/api-reference/markets/get-market-by-id`), so a market can populate one
        // and not the other. Reading only `endDate` would report a market with a
        // perfectly good `endDateIso` as untradable.
        const parsed = parsePolymarketMarketState({ conditionId: CONDITION_ID, active: true, closed: false, endDateIso: FUTURE }, CONDITION_ID);
        expect(parsed.endDate.toISOString()).toBe(new Date(FUTURE).toISOString());
    });
    it('reports secondsDelay as null when absent or nonsensical, never as zero', () => {
        // Zero is a positive claim that orders match immediately. Null says we do not
        // know, which is what the S4-M18 staleness rule needs in order to stay honest
        // about how much latency it has actually accounted for.
        const absent = parsePolymarketMarketState({ conditionId: CONDITION_ID, active: true, closed: false, endDate: FUTURE }, CONDITION_ID);
        expect(absent.secondsDelay).toBeNull();
        const negative = parsePolymarketMarketState(gammaMarket({ secondsDelay: -5 }), CONDITION_ID);
        expect(negative.secondsDelay).toBeNull();
        const configured = parsePolymarketMarketState(gammaMarket({ secondsDelay: 30 }), CONDITION_ID);
        expect(configured.secondsDelay).toBe(30);
    });
    it('blocks a submission into a market that stopped accepting orders', async () => {
        // The window this gate exists for: healthy book, market paused between the
        // signal and its execution.
        const fetchImpl = vi.fn(async () => jsonResponse([
            gammaMarket({ acceptingOrders: false })
        ]));
        await expect(assertPolymarketMarketOpenForSubmission({
            conditionId: CONDITION_ID,
            fetchImpl
        })).rejects.toThrow('paused for orders');
    });
});
//# sourceMappingURL=polymarket-market-state.test.js.map