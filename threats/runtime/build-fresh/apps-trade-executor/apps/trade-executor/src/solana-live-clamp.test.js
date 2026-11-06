import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// `index.ts` opens a pool at import time, so `@swat/db` is stubbed — the same
// pattern `risk.test.ts` uses. Only the clamp is under test here; nothing in it
// touches the database.
vi.mock('@swat/db', () => ({
    resolveChainMode: vi.fn(),
    insertTrade: vi.fn(),
    insertTradeAndMarkSignalExecuted: vi.fn(),
    insertTradeAndReleaseSignalClaim: vi.fn(),
    claimSignalForExecution: vi.fn(),
    releaseSignalClaim: vi.fn(),
    getTokenDecimals: vi.fn(),
    resolveRiskPolicy: vi.fn(),
    claimCircuitBreakerProbe: vi.fn(),
    readCircuitBreakerState: vi.fn(),
    recordCircuitBreakerFailure: vi.fn(),
    recordCircuitBreakerSuccess: vi.fn(),
    hasRecentBuy: vi.fn(),
    getRollingExposureUsd: vi.fn(),
    claimCopyExecutionsForReconciliation: vi.fn(),
    releaseCopyExecutionReconciliationClaim: vi.fn(),
    query: vi.fn(),
    pool: {}
}));
import { clampExecutionModeForStartup } from './index.js';
import { resetJupiterJitoRuntimeForTests, setJupiterJitoUnavailable } from './jupiter-jito-config.js';
import { setTrojanRuntimeUnavailable } from './trojan-runtime.js';
/**
 * Startup clamp coverage for the Solana live-execution gate.
 *
 * Written because a mutation test exposed a hole: making this gate fail **open**
 * — which would let a live Solana trade proceed with no configured signer —
 * passed all 252 existing tests. The clamp is a live-money control and had no
 * direct coverage at all.
 *
 * Solana can execute live through either the legacy Trojan path or Jupiter+Jito.
 * Until Trojan retires (S3-6), EITHER being ready is sufficient, and NEITHER
 * being ready must clamp to paper.
 */
beforeEach(() => {
    resetJupiterJitoRuntimeForTests();
    setTrojanRuntimeUnavailable('not configured in test');
});
afterEach(() => {
    resetJupiterJitoRuntimeForTests();
});
describe('solana live clamp', () => {
    it('clamps live to paper when neither runtime is ready', () => {
        // The mutation this pins: without the guard, this returns 'live' and the
        // executor attempts a trade it cannot sign.
        const result = clampExecutionModeForStartup('solana', 'live');
        expect(result.effectiveMode).toBe('paper');
        expect(result.reason).toMatch(/readiness failed/i);
    });
    it('clamps live+shadow to paper when neither runtime is ready', () => {
        const result = clampExecutionModeForStartup('solana', 'live+shadow');
        expect(result.effectiveMode).toBe('paper');
    });
    it('names both runtimes in the reason, so the cause is diagnosable', () => {
        // "readiness failed" alone does not say which path is missing, and with two
        // possible providers that is the first question an operator asks.
        const result = clampExecutionModeForStartup('solana', 'live');
        expect(result.reason).toMatch(/jupiter-jito=/);
        expect(result.reason).toMatch(/trojan=/);
    });
    it('leaves paper alone — the clamp only ever narrows', () => {
        expect(clampExecutionModeForStartup('solana', 'paper').effectiveMode).toBe('paper');
    });
    it('leaves off alone', () => {
        // `off` is the kill switch; a readiness check must never widen it to paper.
        expect(clampExecutionModeForStartup('solana', 'off').effectiveMode).toBe('off');
    });
    it('does not clamp solana when a non-solana chain is unready', () => {
        // Chain isolation: Solana's missing signer must not affect Polygon.
        const result = clampExecutionModeForStartup('polygon', 'paper');
        expect(result.effectiveMode).toBe('paper');
    });
    it('reports the specific unavailability reason it was given', () => {
        setJupiterJitoUnavailable('block engine unreachable');
        const result = clampExecutionModeForStartup('solana', 'live');
        expect(result.effectiveMode).toBe('paper');
        expect(result.reason).toContain('block engine unreachable');
    });
});
//# sourceMappingURL=solana-live-clamp.test.js.map