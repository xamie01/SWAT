/**
/**
 * Resilient Multi-Provider RPC Failover and Health Circuit Breaker.
 *
 * In production multi-tenant trading, single RPC endpoints are common single points
 * of failure (rate-limits, 429s, maintenance windows, networking partitions).
 *
 * This module provides:
 * 1. Multi-provider URL pooling with primary -> secondary fallback cascade.
 * 2. In-memory circuit breaker tracking consecutive failures, latency, and cooldowns.
 * 3. Execution wrapper with automatic failover and retry across healthy providers.
 * 4. Active telemetry probing (getSlot / eth_blockNumber) for system health reports.
 */
import type { Chain } from './types.js';
export interface RpcEndpointState {
    readonly url: string;
    consecutiveFailures: number;
    cooldownUntil: number;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    lastLatencyMs: number | null;
    lastError: string | null;
}
export interface RpcEndpointProbe {
    readonly url: string;
    readonly healthy: boolean;
    readonly latencyMs: number;
    readonly blockHeight?: number;
    readonly error?: string;
}
export interface RpcPoolReport {
    readonly chain: string;
    readonly primaryUrl: string;
    readonly activeHealthyUrl: string;
    readonly endpoints: ReadonlyArray<RpcEndpointProbe & {
        consecutiveFailures: number;
    }>;
}
export declare const DEFAULT_FALLBACK_RPCS: Record<Chain, readonly string[]>;
export declare function getOrCreateEndpointState(url: string): RpcEndpointState;
export declare function resetEndpointRegistry(): void;
/**
 * Parses comma-separated URLs or falls back to singular env var and built-in public fallbacks.
 */
export declare function resolveConfiguredRpcUrls(chain: Chain | 'robinhood', env?: Record<string, string | undefined>): string[];
/**
 * Returns endpoints ordered by priority:
 * 1. Healthy endpoints (no active cooldown), sorted by lowest consecutive failures then lastLatencyMs.
 * 2. Cooled-down endpoints where cooldown has elapsed.
 * 3. Currently cooling-off endpoints as a last resort if all endpoints have failed.
 */
export declare function prioritizeRpcEndpoints(urls: readonly string[], now?: number): string[];
/**
 * Marks an endpoint as failed, applying exponential cooldown.
 */
export declare function recordRpcFailure(url: string, error: unknown, now?: number): void;
/**
 * Marks an endpoint as successful, clearing failure counts and recording latency.
 */
export declare function recordRpcSuccess(url: string, latencyMs: number, now?: number): void;
/**
 * Executes an arbitrary asynchronous RPC operation with automatic failover.
 * Tries candidates sequentially across the prioritized pool.
 */
export declare function executeWithRpcFailover<T>(options: {
    chain: Chain | 'robinhood';
    action: (rpcUrl: string) => Promise<T>;
    maxAttempts?: number;
    env?: Record<string, string | undefined>;
    now?: () => number;
}): Promise<T>;
/**
 * Probes a single RPC URL for liveness and latency.
 */
export declare function probeRpcEndpoint(url: string, chain: Chain | 'robinhood', timeoutMs?: number): Promise<RpcEndpointProbe>;
/**
 * Probes all endpoints in the pool for a chain and returns a comprehensive report.
 */
export declare function probeRpcPool(chain: Chain | 'robinhood', env?: Record<string, string | undefined>): Promise<RpcPoolReport>;
/**
 * Returns the currently most preferred healthy RPC URL for a chain.
 */
export declare function getActiveRpcUrl(chain: Chain | 'robinhood', env?: Record<string, string | undefined>): string;
//# sourceMappingURL=rpc-failover.d.ts.map