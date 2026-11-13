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
import { diagnosticEndpoint } from './redaction.js';

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
  readonly endpoints: ReadonlyArray<RpcEndpointProbe & { consecutiveFailures: number }>;
}

const DEFAULT_COOLDOWN_BASE_MS = 15_000;
const MAX_COOLDOWN_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

export const DEFAULT_FALLBACK_RPCS: Record<Chain, readonly string[]> = {
  solana: [
    'https://api.mainnet-beta.solana.com'
  ],
  polygon: [
    'https://polygon-bor-rpc.publicnode.com',
    'https://1rpc.io/matic',
    'https://polygon.drpc.org'
  ],
  'robinhood-chain': [
    'https://rpc.mainnet.chain.robinhood.com'
  ],
  base: [
    'https://mainnet.base.org',
    'https://1rpc.io/base',
    'https://base.drpc.org'
  ],
  ethereum: [
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth',
    'https://ethereum.drpc.org'
  ],
  bsc: [
    'https://binance.llamarpc.com',
    'https://1rpc.io/bnb',
    'https://bsc-dataseed.binance.org'
  ]
};

// Global in-memory registry of endpoint states
const endpointRegistry = new Map<string, RpcEndpointState>();

export function getOrCreateEndpointState(url: string): RpcEndpointState {
  let state = endpointRegistry.get(url);
  if (!state) {
    state = {
      url,
      consecutiveFailures: 0,
      cooldownUntil: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastLatencyMs: null,
      lastError: null
    };
    endpointRegistry.set(url, state);
  }
  return state;
}

export function resetEndpointRegistry(): void {
  endpointRegistry.clear();
}

/**
 * Parses comma-separated URLs or falls back to singular env var and built-in public fallbacks.
 */
export function resolveConfiguredRpcUrls(
  chain: Chain | 'robinhood',
  env: Record<string, string | undefined> = process.env
): string[] {
  const normalizedChain: Chain = chain === 'robinhood' ? 'robinhood-chain' : chain;
  let pluralEnvKey = 'SOLANA_RPC_URLS';
  let singularEnvKey = 'SOLANA_RPC_URL';

  if (normalizedChain === 'polygon') {
    pluralEnvKey = 'POLYGON_RPC_URLS';
    singularEnvKey = 'POLYGON_RPC_URL';
  } else if (normalizedChain === 'robinhood-chain') {
    pluralEnvKey = 'ROBINHOOD_RPC_URLS';
    singularEnvKey = 'ROBINHOOD_RPC_URL';
  }

  const pluralVal = env[pluralEnvKey];
  const singularVal = env[singularEnvKey];

  const gathered: string[] = [];

  if (pluralVal && pluralVal.trim() !== '') {
    for (const raw of pluralVal.split(',')) {
      const trimmed = raw.trim();
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        gathered.push(trimmed);
      }
    }
  }

  if (singularVal && singularVal.trim() !== '') {
    const trimmed = singularVal.trim();
    if ((trimmed.startsWith('http://') || trimmed.startsWith('https://')) && !gathered.includes(trimmed)) {
      gathered.unshift(trimmed); // Primary first
    }
  }

  // Append built-in public fallbacks if not already present
  for (const fallback of (DEFAULT_FALLBACK_RPCS[normalizedChain] ?? [])) {
    if (!gathered.includes(fallback)) {
      gathered.push(fallback);
    }
  }

  return gathered;
}

/**
 * Returns endpoints ordered by priority:
 * 1. Healthy endpoints (no active cooldown), sorted by lowest consecutive failures then lastLatencyMs.
 * 2. Cooled-down endpoints where cooldown has elapsed.
 * 3. Currently cooling-off endpoints as a last resort if all endpoints have failed.
 */
export function prioritizeRpcEndpoints(
  urls: readonly string[],
  now: number = Date.now()
): string[] {
  const states = urls.map(getOrCreateEndpointState);

  const healthy: RpcEndpointState[] = [];
  const recovering: RpcEndpointState[] = [];
  const coolingOff: RpcEndpointState[] = [];

  for (const st of states) {
    if (st.consecutiveFailures === 0 && st.cooldownUntil <= now) {
      healthy.push(st);
    } else if (st.cooldownUntil <= now) {
      recovering.push(st);
    } else {
      coolingOff.push(st);
    }
  }

  // Sort healthy by latency if known
  healthy.sort((a, b) => (a.lastLatencyMs ?? 9999) - (b.lastLatencyMs ?? 9999));

  // Sort cooling off by earliest cooldown expiration
  coolingOff.sort((a, b) => a.cooldownUntil - b.cooldownUntil);

  return [...healthy, ...recovering, ...coolingOff].map((s) => s.url);
}

/**
 * Marks an endpoint as failed, applying exponential cooldown.
 */
export function recordRpcFailure(url: string, error: unknown, now: number = Date.now()): void {
  const state = getOrCreateEndpointState(url);
  state.consecutiveFailures += 1;
  state.lastFailureAt = now;
  state.lastError = 'RPC request failed';

  const delayMs = Math.min(
    DEFAULT_COOLDOWN_BASE_MS * Math.pow(2, state.consecutiveFailures - 1),
    MAX_COOLDOWN_MS
  );
  state.cooldownUntil = now + delayMs;
}

/**
 * Marks an endpoint as successful, clearing failure counts and recording latency.
 */
export function recordRpcSuccess(url: string, latencyMs: number, now: number = Date.now()): void {
  const state = getOrCreateEndpointState(url);
  state.consecutiveFailures = 0;
  state.cooldownUntil = 0;
  state.lastSuccessAt = now;
  state.lastLatencyMs = latencyMs;
  state.lastError = null;
}

/**
 * Executes an arbitrary asynchronous RPC operation with automatic failover.
 * Tries candidates sequentially across the prioritized pool.
 */
export async function executeWithRpcFailover<T>(options: {
  chain: Chain | 'robinhood';
  action: (rpcUrl: string) => Promise<T>;
  maxAttempts?: number;
  env?: Record<string, string | undefined>;
  now?: () => number;
}): Promise<T> {
  const getNow = options.now ?? Date.now;
  const urls = resolveConfiguredRpcUrls(options.chain, options.env);
  const prioritized = prioritizeRpcEndpoints(urls, getNow());
  const maxAttempts = Math.min(options.maxAttempts ?? prioritized.length, prioritized.length);

  const failureLog: Array<{ url: string; error: string }> = [];

  for (let i = 0; i < maxAttempts; i++) {
    const candidateUrl = prioritized[i];
    const start = getNow();
    try {
      const result = await options.action(candidateUrl);
      recordRpcSuccess(candidateUrl, getNow() - start, getNow());
      return result;
    } catch (err) {
      recordRpcFailure(candidateUrl, err, getNow());
      failureLog.push({
        url: diagnosticEndpoint(candidateUrl),
        error: 'RPC request failed'
      });
    }
  }

  const summary = failureLog.map((f) => `[${f.url}]: ${f.error}`).join('; ');
  throw new Error(`All ${maxAttempts} RPC endpoint(s) failed for ${options.chain}: ${summary}`);
}

/**
 * Probes a single RPC URL for liveness and latency.
 */
export async function probeRpcEndpoint(
  url: string,
  chain: Chain | 'robinhood',
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<RpcEndpointProbe> {
  const start = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('RPC timeout')); }, timeoutMs);
  });
  const endpoint = diagnosticEndpoint(url);
  try {
    const operation = async () => {
      const body = chain === 'solana'
        ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' })
        : JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal });
      if (!response.ok) throw new Error('RPC HTTP failure');
      const json = await response.json() as { result?: unknown; error?: unknown } | null;
      if (!json || json.error || !Object.prototype.hasOwnProperty.call(json, 'result')) throw new Error('RPC malformed result');
      const result = json.result;
      const height = chain === 'solana' && typeof result === 'number' ? result
        : chain !== 'solana' && typeof result === 'string' && /^0x[0-9a-f]+$/i.test(result) ? Number(BigInt(result)) : NaN;
      if (!Number.isSafeInteger(height) || height < 0) throw new Error('RPC malformed height');
      return height;
    };
    const blockHeight = await Promise.race([operation(), timeout]);
    const latencyMs = Date.now() - start;
    recordRpcSuccess(url, latencyMs);
    return { url: endpoint, healthy: true, latencyMs, blockHeight };
  } catch {
    const latencyMs = Date.now() - start;
    recordRpcFailure(url, 'RPC probe failed');
    return { url: endpoint, healthy: false, latencyMs, error: 'RPC probe failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes all endpoints in the pool for a chain and returns a comprehensive report.
 */
export async function probeRpcPool(
  chain: Chain | 'robinhood',
  env: Record<string, string | undefined> = process.env
): Promise<RpcPoolReport> {
  const urls = resolveConfiguredRpcUrls(chain, env);
  const probes: RpcEndpointProbe[] = [];
  for (const url of urls) probes.push(await probeRpcEndpoint(url, chain));

  const endpoints = probes.map((probe, index) => {
    const state = getOrCreateEndpointState(urls[index]!);
    return {
      ...probe,
      consecutiveFailures: state.consecutiveFailures
    };
  });

  const prioritized = prioritizeRpcEndpoints(urls);
  const activeHealthyUrl = prioritized.find(url => probes[urls.indexOf(url)]?.healthy);

  return {
    chain,
    primaryUrl: urls[0] ? diagnosticEndpoint(urls[0]) : '',
    activeHealthyUrl: activeHealthyUrl ? diagnosticEndpoint(activeHealthyUrl) : '',
    endpoints
  };
}

/**
 * Returns the currently most preferred healthy RPC URL for a chain.
 */
export function getActiveRpcUrl(
  chain: Chain | 'robinhood',
  env: Record<string, string | undefined> = process.env
): string {
  const urls = resolveConfiguredRpcUrls(chain, env);
  const prioritized = prioritizeRpcEndpoints(urls);
  return prioritized[0] ?? urls[0];
}
