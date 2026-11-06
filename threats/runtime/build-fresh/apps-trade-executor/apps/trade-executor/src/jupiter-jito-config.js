import { createSolanaSimulationGateFromEnvironment } from './solana-simulation.js';
import { createJupiterJitoRuntime, createRedisJupiterJitoStore } from './jupiter-jito-runtime.js';
import { createSolanaSignerFromEnvironment } from './solana-signer.js';
/**
 * Environment wiring and live-readiness gate for the Jupiter + Jito path
 * (checklist S3-1…S3-5).
 *
 * Mirrors `configureTrojanRuntime` / `getTrojanLiveReadiness` so the executor's
 * existing mode-resolution gate keeps working with a one-symbol swap. The Trojan
 * path is retired only once this one is certified (`S3-6`), so both exist
 * side by side until then.
 */
let configured = null;
let signer = null;
let unavailableReason = 'Jupiter/Jito runtime is not configured';
/** Default tip ceiling: 0.005 SOL. Overridden by `JITO_MAX_TIP_LAMPORTS`. */
const DEFAULT_MAX_TIP_LAMPORTS = 5_000_000;
/** Used when the block engine's tip floor is unreadable. 0.0001 SOL. */
const DEFAULT_FALLBACK_TIP_LAMPORTS = 100_000;
const DEFAULT_PENDING_TTL_MS = 600_000;
function readPositiveInt(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer, got ${raw}`);
    }
    return parsed;
}
function readTipPercentile() {
    const raw = process.env.JITO_TIP_PERCENTILE ?? 'p75';
    if (raw !== 'p50' && raw !== 'p75' && raw !== 'p95') {
        throw new Error(`JITO_TIP_PERCENTILE must be p50, p75, or p95; got ${raw}`);
    }
    return raw;
}
export function configureJupiterJitoRuntime(runtime, runtimeSigner) {
    configured = runtime;
    signer = runtimeSigner;
    unavailableReason = '';
}
export function setJupiterJitoUnavailable(reason) {
    configured = null;
    signer = null;
    unavailableReason = reason;
}
export function getConfiguredJupiterJitoRuntime() {
    return configured;
}
export function getJupiterJitoSigner() {
    return signer;
}
/**
 * Whether Solana may execute live.
 *
 * Fail-closed: an unconfigured runtime reports not-ready with a reason, and
 * `resolveChainMode` clamps the chain to paper rather than attempting a live
 * trade it cannot sign.
 */
export function getJupiterJitoLiveReadiness() {
    return configured && signer
        ? { ready: true, reason: '' }
        : { ready: false, reason: unavailableReason || 'Jupiter/Jito runtime is not configured' };
}
/**
 * Builds the runtime from the environment.
 *
 * Returns null when the Solana key or Jito endpoint is absent — the normal
 * posture for a paper-mode deployment, which must not be forced to hold a
 * signing key it never uses.
 */
export function createJupiterJitoRuntimeFromEnvironment(redis) {
    const environmentSigner = createSolanaSignerFromEnvironment();
    if (!environmentSigner) {
        setJupiterJitoUnavailable('SOLANA_PRIVATE_KEY or an RPC URL is not configured');
        return null;
    }
    const baseUrl = process.env.JITO_BLOCK_ENGINE_URL;
    if (!baseUrl) {
        // Deliberately not defaulted. A wrong block-engine URL fails every bundle
        // at submit time, and silently guessing one turns a config omission into a
        // runtime mystery.
        setJupiterJitoUnavailable('JITO_BLOCK_ENGINE_URL is not configured');
        return null;
    }
    const runtime = createJupiterJitoRuntime({
        pendingStore: createRedisJupiterJitoStore(redis),
        jito: {
            baseUrl,
            apiKey: process.env.JITO_AUTH_KEY,
            timeoutMs: readPositiveInt('JITO_TIMEOUT_MS', 10_000)
        },
        signTransaction: (transaction) => environmentSigner.sign(transaction),
        buildTipTransaction: (input) => environmentSigner.buildTip(input),
        maxTipLamports: readPositiveInt('JITO_MAX_TIP_LAMPORTS', DEFAULT_MAX_TIP_LAMPORTS),
        fallbackTipLamports: readPositiveInt('JITO_FALLBACK_TIP_LAMPORTS', DEFAULT_FALLBACK_TIP_LAMPORTS),
        tipPercentile: readTipPercentile(),
        pendingTtlMs: readPositiveInt('JITO_PENDING_TTL_MS', DEFAULT_PENDING_TTL_MS),
        jupiterApiKey: process.env.JUPITER_API_KEY,
        // S4-M15. Without this the runtime's simulation branch is dead code on a live
        // box: `submit()` guards on `options.simulation` being present, so an absent
        // gate means every Solana bundle goes out unsimulated exactly as before. The
        // factory returns null when unconfigured, which is the same
        // explicitly-disabled shape `createSolanaSignerFromEnvironment` uses.
        simulation: createSolanaSimulationGateFromEnvironment() ?? undefined
    });
    configureJupiterJitoRuntime(runtime, environmentSigner);
    return { runtime, signer: environmentSigner };
}
/** Resets module state. Test-only. */
export function resetJupiterJitoRuntimeForTests() {
    configured = null;
    signer = null;
    unavailableReason = 'Jupiter/Jito runtime is not configured';
}
//# sourceMappingURL=jupiter-jito-config.js.map