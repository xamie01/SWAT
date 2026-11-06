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
const DEFAULT_COOLDOWN_BASE_MS = 15_000;
const MAX_COOLDOWN_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
export const DEFAULT_FALLBACK_RPCS = {
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
const endpointRegistry = new Map();
export function getOrCreateEndpointState(url) {
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
export function resetEndpointRegistry() {
    endpointRegistry.clear();
}
/**
 * Parses comma-separated URLs or falls back to singular env var and built-in public fallbacks.
 */
export function resolveConfiguredRpcUrls(chain, env = process.env) {
    const normalizedChain = chain === 'robinhood' ? 'robinhood-chain' : chain;
    let pluralEnvKey = 'SOLANA_RPC_URLS';
    let singularEnvKey = 'SOLANA_RPC_URL';
    if (normalizedChain === 'polygon') {
        pluralEnvKey = 'POLYGON_RPC_URLS';
        singularEnvKey = 'POLYGON_RPC_URL';
    }
    else if (normalizedChain === 'robinhood-chain') {
        pluralEnvKey = 'ROBINHOOD_RPC_URLS';
        singularEnvKey = 'ROBINHOOD_RPC_URL';
    }
    const pluralVal = env[pluralEnvKey];
    const singularVal = env[singularEnvKey];
    const gathered = [];
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
export function prioritizeRpcEndpoints(urls, now = Date.now()) {
    const states = urls.map(getOrCreateEndpointState);
    const healthy = [];
    const recovering = [];
    const coolingOff = [];
    for (const st of states) {
        if (st.consecutiveFailures === 0 && st.cooldownUntil <= now) {
            healthy.push(st);
        }
        else if (st.cooldownUntil <= now) {
            recovering.push(st);
        }
        else {
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
export function recordRpcFailure(url, error, now = Date.now()) {
    const state = getOrCreateEndpointState(url);
    state.consecutiveFailures += 1;
    state.lastFailureAt = now;
    state.lastError = error instanceof Error ? error.message : String(error);
    const delayMs = Math.min(DEFAULT_COOLDOWN_BASE_MS * Math.pow(2, state.consecutiveFailures - 1), MAX_COOLDOWN_MS);
    state.cooldownUntil = now + delayMs;
}
/**
 * Marks an endpoint as successful, clearing failure counts and recording latency.
 */
export function recordRpcSuccess(url, latencyMs, now = Date.now()) {
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
export async function executeWithRpcFailover(options) {
    const getNow = options.now ?? Date.now;
    const urls = resolveConfiguredRpcUrls(options.chain, options.env);
    const prioritized = prioritizeRpcEndpoints(urls, getNow());
    const maxAttempts = Math.min(options.maxAttempts ?? prioritized.length, prioritized.length);
    const failureLog = [];
    for (let i = 0; i < maxAttempts; i++) {
        const candidateUrl = prioritized[i];
        const start = getNow();
        try {
            const result = await options.action(candidateUrl);
            recordRpcSuccess(candidateUrl, getNow() - start, getNow());
            return result;
        }
        catch (err) {
            recordRpcFailure(candidateUrl, err, getNow());
            failureLog.push({
                url: candidateUrl,
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }
    const summary = failureLog.map((f) => `[${f.url}]: ${f.error}`).join('; ');
    throw new Error(`All ${maxAttempts} RPC endpoint(s) failed for ${options.chain}: ${summary}`);
}
/**
 * Probes a single RPC URL for liveness and latency.
 */
export async function probeRpcEndpoint(url, chain, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const body = chain === 'solana'
            ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' })
            : JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: controller.signal
        });
        clearTimeout(timer);
        const latencyMs = Date.now() - start;
        if (!res.ok) {
            recordRpcFailure(url, `HTTP ${res.status}: ${res.statusText}`);
            return { url, healthy: false, latencyMs, error: `HTTP ${res.status}` };
        }
        const json = (await res.json());
        if (json.error) {
            recordRpcFailure(url, json.error.message);
            return { url, healthy: false, latencyMs, error: json.error.message };
        }
        let blockHeight;
        if (typeof json.result === 'number') {
            blockHeight = json.result;
        }
        else if (typeof json.result === 'string') {
            blockHeight = parseInt(json.result, 16);
        }
        recordRpcSuccess(url, latencyMs);
        return { url, healthy: true, latencyMs, blockHeight };
    }
    catch (err) {
        clearTimeout(timer);
        const latencyMs = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        recordRpcFailure(url, msg);
        return { url, healthy: false, latencyMs, error: msg };
    }
}
/**
 * Probes all endpoints in the pool for a chain and returns a comprehensive report.
 */
export async function probeRpcPool(chain, env = process.env) {
    const urls = resolveConfiguredRpcUrls(chain, env);
    const probes = await Promise.all(urls.map((u) => probeRpcEndpoint(u, chain)));
    const endpoints = probes.map((probe) => {
        const state = getOrCreateEndpointState(probe.url);
        return {
            ...probe,
            consecutiveFailures: state.consecutiveFailures
        };
    });
    const prioritized = prioritizeRpcEndpoints(urls);
    const activeHealthyUrl = prioritized[0] ?? urls[0];
    return {
        chain,
        primaryUrl: urls[0],
        activeHealthyUrl,
        endpoints
    };
}
/**
 * Returns the currently most preferred healthy RPC URL for a chain.
 */
export function getActiveRpcUrl(chain, env = process.env) {
    const urls = resolveConfiguredRpcUrls(chain, env);
    const prioritized = prioritizeRpcEndpoints(urls);
    return prioritized[0] ?? urls[0];
}
//# sourceMappingURL=rpc-failover.js.map