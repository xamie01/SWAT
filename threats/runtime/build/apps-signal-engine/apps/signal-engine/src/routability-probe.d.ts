import { type JupiterQuote } from '@swat/shared';
/**
 * Solana LP & liquid-staking routability probe (checklist S4-M31).
 *
 * Swap-shaped LP deposits and liquid staking events are ingested by indexers
 * as `buy`/`sell` trades because they involve balance movements. These cannot
 * be distinguished from real trades downstream by side alone.
 *
 * Instead of maintaining a brittle token allowlist or reverse-engineering
 * external protocol programs, we ask whether Jupiter can route the token at all.
 * An LP token has no market/route on Jupiter, so quote resolution returns null.
 *
 * Critical safety invariants:
 * 1. Scoped to Solana only: other chains return `chain-not-probed` (passing).
 * 2. Fail OPEN on probe transport error (`probe-unavailable`): an outage of the
 *    probe must NEVER halt all copy trading across Solana.
 * 3. Asymmetric caching:
 *    - Routable tokens: cached for hours (default 2h).
 *    - Unroutable tokens: cached briefly (default 5m) so brand new pools can be detected.
 *    - Clock-injected for deterministic testing without real time.
 */
export declare const SOL_MINT = "So11111111111111111111111111111111111111112";
export declare const DEFAULT_ROUTABLE_TTL_MS: number;
export declare const DEFAULT_UNROUTABLE_TTL_MS: number;
export type RoutabilityProbeResult = {
    readonly kind: 'pass';
    readonly code: 'routable' | 'chain-not-probed' | 'probe-unavailable';
    readonly reason: string;
} | {
    readonly kind: 'skip';
    readonly code: 'no-route';
    readonly reason: string;
};
export declare class RoutabilityCache {
    private readonly entries;
    get(mint: string, nowMs: number): RoutabilityProbeResult | null;
    set(mint: string, result: RoutabilityProbeResult, ttlMs: number, nowMs: number): void;
    clear(): void;
}
export declare const defaultRoutabilityCache: RoutabilityCache;
export interface RoutabilityProbeOptions {
    readonly quoteFn?: (params: {
        inputMint: string;
        outputMint: string;
        amountLamports: number;
        slippageBps?: number;
        swapMode?: 'ExactIn' | 'ExactOut';
    }) => Promise<JupiterQuote | null>;
    readonly now?: () => Date;
    readonly cache?: RoutabilityCache;
    readonly routableTtlMs?: number;
    readonly unroutableTtlMs?: number;
}
/**
 * Evaluates whether a target token is routable on Solana.
 */
export declare function probeTokenRoutability(tokenMint: string, options?: RoutabilityProbeOptions): Promise<RoutabilityProbeResult>;
//# sourceMappingURL=routability-probe.d.ts.map