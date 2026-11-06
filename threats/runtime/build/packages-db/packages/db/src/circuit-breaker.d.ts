import type { Chain } from '@swat/shared';
export interface CircuitBreakerState {
    consecutiveFailures: number;
    trippedAt: string | null;
}
export declare class CircuitBreakerStateCorruptionError extends Error {
    constructor(account: string, chain: Chain);
}
/** Reads directly from PostgreSQL on every call so state is shared across processes and restarts. */
export declare function readCircuitBreakerState(account: string, chain: Chain): Promise<CircuitBreakerState>;
/** Atomically increments one chain and records the first threshold-crossing timestamp. */
export declare function recordCircuitBreakerFailure(account: string, chain: Chain, threshold: number, failedAt?: Date): Promise<CircuitBreakerState>;
/** Atomically clears one chain after validating and locking its persisted state. */
export declare function recordCircuitBreakerSuccess(account: string, chain: Chain): Promise<CircuitBreakerState>;
/**
 * Claims one half-open recovery probe after the cooldown. Updating `trippedAt`
 * acts as a cross-process lease so concurrent workers continue delaying.
 */
export declare function claimCircuitBreakerProbe(account: string, chain: Chain, cooldownMs: number, now?: Date): Promise<boolean>;
//# sourceMappingURL=circuit-breaker.d.ts.map