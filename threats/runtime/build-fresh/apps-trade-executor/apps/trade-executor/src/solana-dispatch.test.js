import { describe, it, expect, vi } from 'vitest';
import { buildSolanaQuote, mapSubmissionToOutcome, dispatchSolanaTrade, SOL_MINT } from './solana-dispatch.js';
const MOCK_QUOTE = {
    inputMint: SOL_MINT,
    outputMint: 'token-abc',
    inAmount: '1000000000',
    outAmount: '950000',
    otherAmountThreshold: '940000',
    swapMode: 'ExactIn',
    slippageBps: 1500,
    priceImpactPct: '0.5',
    routePlan: [],
    contextSlot: 12345
};
function mockDeps(overrides) {
    return {
        runtime: { submit: vi.fn() },
        signerPublicKey: 'signer-abc',
        quote: vi.fn().mockResolvedValue(MOCK_QUOTE),
        ...overrides
    };
}
describe('buildSolanaQuote', () => {
    it('builds an ExactIn SOL buy', async () => {
        const mockQuote = vi.fn().mockResolvedValue(MOCK_QUOTE);
        const input = {
            clientOrderId: 'order-1',
            tokenMint: 'token-abc',
            direction: 'buy',
            amountSol: 1.5,
            slippageBps: 1500
        };
        await buildSolanaQuote(input, { ...mockDeps(), quote: mockQuote });
        expect(mockQuote).toHaveBeenCalledWith({
            inputMint: SOL_MINT,
            outputMint: 'token-abc',
            amountLamports: 1_500_000_000,
            slippageBps: 1500,
            swapMode: 'ExactIn'
        }, undefined);
    });
    it('builds an ExactIn token sell with the given base units', async () => {
        const mockQuote = vi.fn().mockResolvedValue(MOCK_QUOTE);
        const input = {
            clientOrderId: 'order-2',
            tokenMint: 'token-abc',
            direction: 'sell',
            amountSol: 0,
            sellBaseUnits: '950000',
            slippageBps: 1500
        };
        await buildSolanaQuote(input, { ...mockDeps(), quote: mockQuote });
        expect(mockQuote).toHaveBeenCalledWith({
            inputMint: 'token-abc',
            outputMint: SOL_MINT,
            amountLamports: 950_000,
            slippageBps: 1500,
            swapMode: 'ExactIn'
        }, undefined);
    });
    it('rejects a sell with no base units', async () => {
        const input = {
            clientOrderId: 'order-3',
            tokenMint: 'token-abc',
            direction: 'sell',
            amountSol: 1.5,
            slippageBps: 1500
        };
        expect(await buildSolanaQuote(input, mockDeps())).toBe(null);
    });
    it('rejects a buy with zero SOL', async () => {
        const input = {
            clientOrderId: 'order-4',
            tokenMint: 'token-abc',
            direction: 'buy',
            amountSol: 0,
            slippageBps: 1500
        };
        expect(await buildSolanaQuote(input, mockDeps())).toBe(null);
    });
    it('rejects a sell quantity beyond Number.MAX_SAFE_INTEGER', async () => {
        // A rounded sell is a wrong-sized trade against a real position.
        const input = {
            clientOrderId: 'order-5',
            tokenMint: 'token-abc',
            direction: 'sell',
            amountSol: 0,
            sellBaseUnits: '9007199254740992',
            slippageBps: 1500
        };
        expect(await buildSolanaQuote(input, mockDeps())).toBe(null);
    });
    it('passes the Jupiter API key through', async () => {
        const mockQuote = vi.fn().mockResolvedValue(MOCK_QUOTE);
        const input = {
            clientOrderId: 'order-6',
            tokenMint: 'token-abc',
            direction: 'buy',
            amountSol: 1,
            slippageBps: 1500
        };
        await buildSolanaQuote(input, { ...mockDeps(), quote: mockQuote, jupiterApiKey: 'jup-key' });
        expect(mockQuote.mock.calls[0][1]).toBe('jup-key');
    });
});
describe('mapSubmissionToOutcome', () => {
    it('maps submitted to a bundleId with no signature yet', () => {
        const submission = {
            status: 'submitted',
            clientOrderId: 'order-1',
            bundleId: 'bundle-abc',
            lastValidBlockHeight: 1000
        };
        expect(mapSubmissionToOutcome(submission)).toEqual({
            kind: 'submitted',
            signature: null,
            bundleId: 'bundle-abc',
            venueStatus: 'submitted'
        });
    });
    it('maps pending_confirmation the same way — the signature comes from the sweep', () => {
        const submission = {
            status: 'pending_confirmation',
            clientOrderId: 'order-2',
            bundleId: 'bundle-def',
            lastValidBlockHeight: 1000
        };
        const outcome = mapSubmissionToOutcome(submission);
        // Narrowed with an assertion rather than `expect`, which does not inform the
        // type system — `outcome.signature` does not exist on the rejected variant.
        if (outcome.kind !== 'submitted')
            throw new Error(`expected submitted, got ${outcome.kind}`);
        expect(outcome.signature).toBe(null);
        expect(outcome.bundleId).toBe('bundle-def');
    });
    it('maps rejected to rejected', () => {
        const submission = {
            status: 'rejected',
            clientOrderId: 'order-3',
            reason: 'bad-quote'
        };
        expect(mapSubmissionToOutcome(submission)).toEqual({
            kind: 'rejected',
            reason: 'bad-quote'
        });
    });
    it('maps submission_unknown to ambiguous, never rejected', () => {
        // The bundle may have been received — retrying would duplicate the position.
        const submission = {
            status: 'submission_unknown',
            clientOrderId: 'order-4',
            reason: 'timeout'
        };
        expect(mapSubmissionToOutcome(submission)).toEqual({
            kind: 'ambiguous',
            reason: 'timeout'
        });
    });
    it('flattens already_resolved filled to filled with its signature', () => {
        const submission = {
            status: 'already_resolved',
            clientOrderId: 'order-5',
            resolution: { status: 'filled', clientOrderId: 'order-5', signature: 'sig-abc', slot: 7 }
        };
        expect(mapSubmissionToOutcome(submission)).toEqual({
            kind: 'filled',
            signature: 'sig-abc',
            slot: 7
        });
    });
    it('flattens already_resolved failed to rejected', () => {
        const submission = {
            status: 'already_resolved',
            clientOrderId: 'order-6',
            resolution: { status: 'failed', clientOrderId: 'order-6', reason: 'blockhash-expired' }
        };
        expect(mapSubmissionToOutcome(submission)).toEqual({
            kind: 'rejected',
            reason: 'blockhash-expired'
        });
    });
    it('flattens already_resolved ambiguous to ambiguous', () => {
        const submission = {
            status: 'already_resolved',
            clientOrderId: 'order-7',
            resolution: { status: 'ambiguous', clientOrderId: 'order-7', reason: 'confirmation-timeout' }
        };
        expect(mapSubmissionToOutcome(submission)).toEqual({
            kind: 'ambiguous',
            reason: 'confirmation-timeout'
        });
    });
});
describe('dispatchSolanaTrade', () => {
    it('quotes, submits, and maps in one call', async () => {
        const mockSubmit = vi.fn().mockResolvedValue({
            status: 'submitted',
            clientOrderId: 'order-1',
            bundleId: 'bundle-abc',
            lastValidBlockHeight: 1000
        });
        const deps = {
            ...mockDeps(),
            runtime: { submit: mockSubmit }
        };
        const input = {
            clientOrderId: 'order-1',
            tokenMint: 'token-abc',
            direction: 'buy',
            amountSol: 1.5,
            slippageBps: 1500
        };
        const outcome = await dispatchSolanaTrade(input, deps);
        expect(mockSubmit).toHaveBeenCalledWith({
            clientOrderId: 'order-1',
            quote: MOCK_QUOTE,
            signerPublicKey: 'signer-abc'
        });
        expect(outcome).toMatchObject({ kind: 'submitted', bundleId: 'bundle-abc' });
    });
    it('reports a quote failure as rejected, not ambiguous', async () => {
        // Nothing was transmitted, so there is no venue-side state to reconcile.
        const deps = { ...mockDeps(), quote: vi.fn().mockResolvedValue(null) };
        const input = {
            clientOrderId: 'order-2',
            tokenMint: 'token-abc',
            direction: 'buy',
            amountSol: 0,
            slippageBps: 1500
        };
        expect(await dispatchSolanaTrade(input, deps)).toEqual({
            kind: 'rejected',
            reason: 'jupiter-quote-unavailable'
        });
    });
});
describe('simulation skip codes (S4-M15)', () => {
    it('carries the simulation reason code onto the dispatch outcome', () => {
        const submission = {
            status: 'rejected',
            clientOrderId: 'order-sim',
            reason: 'solana-simulation-reverted: simulation reverted: "AccountNotFound"',
            code: 'solana-simulation-reverted'
        };
        expect(mapSubmissionToOutcome(submission)).toEqual({
            kind: 'rejected',
            reason: 'solana-simulation-reverted: simulation reverted: "AccountNotFound"',
            code: 'solana-simulation-reverted'
        });
    });
    it('distinguishes an unreachable simulator from a reverted route', () => {
        const submission = {
            status: 'rejected',
            clientOrderId: 'order-sim',
            reason: 'solana-simulator-unreachable: simulateTransaction failed: fetch failed',
            code: 'solana-simulator-unreachable'
        };
        const outcome = mapSubmissionToOutcome(submission);
        expect(outcome.kind).toBe('rejected');
        if (outcome.kind !== 'rejected')
            throw new Error('expected a rejection');
        expect(outcome.code).toBe('solana-simulator-unreachable');
    });
    it('omits the code entirely for rejections that have none', () => {
        const submission = {
            status: 'rejected',
            clientOrderId: 'order-x',
            reason: 'swap-build-failed'
        };
        // No `code: undefined` key: the executor's existing persistence path reads
        // `reason` only, and an undefined property would show up in a strict equality
        // assertion elsewhere.
        expect(mapSubmissionToOutcome(submission)).toEqual({
            kind: 'rejected',
            reason: 'swap-build-failed'
        });
        expect('code' in mapSubmissionToOutcome(submission)).toBe(false);
    });
});
//# sourceMappingURL=solana-dispatch.test.js.map