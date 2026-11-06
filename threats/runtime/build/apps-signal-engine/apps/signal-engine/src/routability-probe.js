import { chainFromTokenMint, stripChainPrefix, getJupiterQuote } from '@swat/shared';
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
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const DEFAULT_ROUTABLE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const DEFAULT_UNROUTABLE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export class RoutabilityCache {
    entries = new Map();
    get(mint, nowMs) {
        const entry = this.entries.get(mint);
        if (!entry)
            return null;
        if (nowMs >= entry.expiresAtMs) {
            this.entries.delete(mint);
            return null;
        }
        return entry.result;
    }
    set(mint, result, ttlMs, nowMs) {
        if (ttlMs <= 0)
            return;
        this.entries.set(mint, {
            result,
            expiresAtMs: nowMs + ttlMs
        });
    }
    clear() {
        this.entries.clear();
    }
}
export const defaultRoutabilityCache = new RoutabilityCache();
/**
 * Evaluates whether a target token is routable on Solana.
 */
export async function probeTokenRoutability(tokenMint, options = {}) {
    let chain;
    try {
        chain = chainFromTokenMint(tokenMint);
    }
    catch {
        chain = 'solana';
    }
    if (chain !== 'solana') {
        return {
            kind: 'pass',
            code: 'chain-not-probed',
            reason: `Chain ${chain} is not probed for Jupiter routability`
        };
    }
    const clean = stripChainPrefix(tokenMint);
    const now = options.now ? options.now() : new Date();
    const nowMs = now.getTime();
    const cache = options.cache ?? defaultRoutabilityCache;
    const cached = cache.get(clean, nowMs);
    if (cached)
        return cached;
    const routableTtlMs = options.routableTtlMs ?? DEFAULT_ROUTABLE_TTL_MS;
    const unroutableTtlMs = options.unroutableTtlMs ?? DEFAULT_UNROUTABLE_TTL_MS;
    const quoteFn = options.quoteFn ?? getJupiterQuote;
    try {
        const quote = await quoteFn({
            inputMint: SOL_MINT,
            outputMint: clean,
            amountLamports: 1_000_000, // 0.001 SOL test quote
            slippageBps: 150,
            swapMode: 'ExactIn'
        });
        if (quote) {
            const result = {
                kind: 'pass',
                code: 'routable',
                reason: 'Token has an active Jupiter route'
            };
            cache.set(clean, result, routableTtlMs, nowMs);
            return result;
        }
        const result = {
            kind: 'skip',
            code: 'no-route',
            reason: 'Token has no Jupiter route (likely LP deposit token or illiquid staking)'
        };
        cache.set(clean, result, unroutableTtlMs, nowMs);
        return result;
    }
    catch (error) {
        // Fail open on probe error: a transport failure must never halt copy execution
        return {
            kind: 'pass',
            code: 'probe-unavailable',
            reason: `Routability probe unavailable: ${error instanceof Error ? error.message : 'error'}`
        };
    }
}
//# sourceMappingURL=routability-probe.js.map