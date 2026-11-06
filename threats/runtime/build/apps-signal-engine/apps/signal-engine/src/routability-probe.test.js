import { describe, expect, it, vi } from 'vitest';
import { RoutabilityCache, probeTokenRoutability } from './routability-probe.js';
function fakeQuote(inputMint, outputMint) {
    return {
        inputMint,
        outputMint,
        inAmount: '1000000',
        outAmount: '500000',
        otherAmountThreshold: '490000',
        swapMode: 'ExactIn',
        slippageBps: 150,
        priceImpactPct: '0.01',
        routePlan: [],
        contextSlot: 100_000
    };
}
describe('probeTokenRoutability (S4-M31)', () => {
    it('passes non-Solana chains with chain-not-probed', async () => {
        const quoteFn = vi.fn();
        const resultPoly = await probeTokenRoutability('polygon:0x1234567890abcdef', { quoteFn });
        expect(resultPoly).toEqual({
            kind: 'pass',
            code: 'chain-not-probed',
            reason: 'Chain polygon is not probed for Jupiter routability'
        });
        const resultRobin = await probeTokenRoutability('robinhood-chain:0xabcdef', { quoteFn });
        expect(resultRobin).toEqual({
            kind: 'pass',
            code: 'chain-not-probed',
            reason: 'Chain robinhood-chain is not probed for Jupiter routability'
        });
        expect(quoteFn).not.toHaveBeenCalled();
    });
    it('passes routable Solana tokens with routable code', async () => {
        const quoteFn = vi.fn().mockResolvedValue(fakeQuote('SOL', 'TOKEN1'));
        const cache = new RoutabilityCache();
        const result = await probeTokenRoutability('solana:TOKEN1', { quoteFn, cache });
        expect(result).toEqual({
            kind: 'pass',
            code: 'routable',
            reason: 'Token has an active Jupiter route'
        });
        expect(quoteFn).toHaveBeenCalledTimes(1);
        expect(quoteFn).toHaveBeenCalledWith(expect.objectContaining({
            outputMint: 'TOKEN1',
            swapMode: 'ExactIn'
        }));
    });
    it('skips unroutable Solana tokens (LP / liquid staking) with no-route code', async () => {
        const quoteFn = vi.fn().mockResolvedValue(null);
        const cache = new RoutabilityCache();
        const result = await probeTokenRoutability('solana:LP_TOKEN_MINT', { quoteFn, cache });
        expect(result).toEqual({
            kind: 'skip',
            code: 'no-route',
            reason: 'Token has no Jupiter route (likely LP deposit token or illiquid staking)'
        });
        expect(quoteFn).toHaveBeenCalledTimes(1);
    });
    it('fails OPEN with probe-unavailable when quoteFn throws an error', async () => {
        const quoteFn = vi.fn().mockRejectedValue(new Error('Network timeout'));
        const cache = new RoutabilityCache();
        const result = await probeTokenRoutability('solana:TOKEN_ERR', { quoteFn, cache });
        expect(result).toEqual({
            kind: 'pass',
            code: 'probe-unavailable',
            reason: 'Routability probe unavailable: Network timeout'
        });
    });
    it('caches routable tokens for 2 hours and unroutable for 5 minutes (asymmetric caching)', async () => {
        const quoteFn = vi.fn()
            .mockResolvedValueOnce(fakeQuote('SOL', 'GOOD_TOKEN'))
            .mockResolvedValueOnce(null);
        let currentTime = new Date('2026-10-29T12:00:00Z');
        const now = () => currentTime;
        const cache = new RoutabilityCache();
        // 1. Probe GOOD_TOKEN
        const good1 = await probeTokenRoutability('solana:GOOD_TOKEN', { quoteFn, now, cache });
        expect(good1.code).toBe('routable');
        expect(quoteFn).toHaveBeenCalledTimes(1);
        // 2. Probe BAD_TOKEN
        const bad1 = await probeTokenRoutability('solana:BAD_TOKEN', { quoteFn, now, cache });
        expect(bad1.code).toBe('no-route');
        expect(quoteFn).toHaveBeenCalledTimes(2);
        // 3. Advance time by 6 minutes: BAD_TOKEN expired (5m TTL), GOOD_TOKEN still cached (2h TTL)
        currentTime = new Date('2026-10-29T12:06:00Z');
        const good2 = await probeTokenRoutability('solana:GOOD_TOKEN', { quoteFn, now, cache });
        expect(good2.code).toBe('routable');
        // Still 2 calls - GOOD_TOKEN was served from cache
        expect(quoteFn).toHaveBeenCalledTimes(2);
        // BAD_TOKEN re-probes
        quoteFn.mockResolvedValueOnce(fakeQuote('SOL', 'BAD_TOKEN')); // suppose liquidity was added!
        const bad2 = await probeTokenRoutability('solana:BAD_TOKEN', { quoteFn, now, cache });
        expect(bad2.code).toBe('routable');
        expect(quoteFn).toHaveBeenCalledTimes(3);
    });
});
//# sourceMappingURL=routability-probe.test.js.map