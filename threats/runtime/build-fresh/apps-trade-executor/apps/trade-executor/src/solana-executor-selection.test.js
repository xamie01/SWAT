import { describe, it, expect } from 'vitest';
import { resolveSolanaExecutor, shouldUseJupiterJito, solanaExecutorName } from './solana-executor-selection.js';
/**
 * Cutover seam for the Solana executor (S3-7).
 *
 * The property that matters: an uncertified path must never carry a live trade
 * by accident. `S3-9` requires a capped live canary before Jupiter+Jito is
 * certified, so every default and every malformed input has to resolve to the
 * incumbent.
 */
describe('resolveSolanaExecutor', () => {
    it('defaults to the certified path when unset', () => {
        expect(resolveSolanaExecutor({})).toBe('trojan');
    });
    it('defaults to the certified path when blank or whitespace', () => {
        // An empty value in a deploy template must not be read as intent.
        expect(resolveSolanaExecutor({ SOLANA_EXECUTOR: '' })).toBe('trojan');
        expect(resolveSolanaExecutor({ SOLANA_EXECUTOR: '   ' })).toBe('trojan');
    });
    it('honours an explicit opt-in', () => {
        expect(resolveSolanaExecutor({ SOLANA_EXECUTOR: 'jupiter-jito' })).toBe('jupiter-jito');
        expect(resolveSolanaExecutor({ SOLANA_EXECUTOR: 'trojan' })).toBe('trojan');
    });
    it('throws on a typo rather than silently routing somewhere unintended', () => {
        // Failing closed to 'trojan' here would hide the misconfiguration; failing
        // loudly at startup is the only way the operator learns of it.
        expect(() => resolveSolanaExecutor({ SOLANA_EXECUTOR: 'jupiter' })).toThrow(/SOLANA_EXECUTOR/);
        expect(() => resolveSolanaExecutor({ SOLANA_EXECUTOR: 'jito' })).toThrow(/SOLANA_EXECUTOR/);
    });
    it('does not accept a near-miss with different casing', () => {
        expect(() => resolveSolanaExecutor({ SOLANA_EXECUTOR: 'Jupiter-Jito' })).toThrow();
    });
});
describe('shouldUseJupiterJito', () => {
    it('requires both operator intent and actual readiness', () => {
        // Neither control implies the other: the flag is intent, readiness is
        // whether a signer and block engine exist. Accepting one alone would either
        // route to an unusable path or promote an uncertified one unasked.
        expect(shouldUseJupiterJito({ chain: 'solana', configured: 'jupiter-jito', jitoReady: true })).toBe(true);
        expect(shouldUseJupiterJito({ chain: 'solana', configured: 'jupiter-jito', jitoReady: false })).toBe(false);
        expect(shouldUseJupiterJito({ chain: 'solana', configured: 'trojan', jitoReady: true })).toBe(false);
    });
    it('never applies to a non-Solana chain', () => {
        expect(shouldUseJupiterJito({ chain: 'polygon', configured: 'jupiter-jito', jitoReady: true })).toBe(false);
        expect(shouldUseJupiterJito({ chain: 'robinhood-chain', configured: 'jupiter-jito', jitoReady: true })).toBe(false);
    });
});
describe('solanaExecutorName', () => {
    it('maps to the value persisted in trades.executor', () => {
        expect(solanaExecutorName('trojan')).toBe('trojan');
        expect(solanaExecutorName('jupiter-jito')).toBe('jupiter-jito');
    });
    it('fits the varchar(20) column', () => {
        // The column is varchar(20); a longer name would be silently truncated or
        // rejected at insert depending on the driver.
        expect(solanaExecutorName('jupiter-jito').length).toBeLessThanOrEqual(20);
        expect(solanaExecutorName('trojan').length).toBeLessThanOrEqual(20);
    });
});
//# sourceMappingURL=solana-executor-selection.test.js.map