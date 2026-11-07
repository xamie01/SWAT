import type { RedisHashClient } from './runtime-codec.js';
import { createSolanaSimulationGateFromEnvironment } from './solana-simulation.js';
import {
  createJupiterJitoRuntime,
  createRedisJupiterJitoStore,
  type JupiterJitoRuntime
} from './jupiter-jito-runtime.js';
import { createSolanaSignerFromEnvironment, type SolanaSigner } from './solana-signer.js';

/**
 * Environment wiring and live-readiness gate for the Jupiter + Jito path
 * (checklist S3-1…S3-5).
 *
 * Mirrors `configureTrojanRuntime` / `getTrojanLiveReadiness` so the executor's
 * existing mode-resolution gate keeps working with a one-symbol swap. The Trojan
 * path is retired only once this one is certified (`S3-6`), so both exist
 * side by side until then.
 */

let configured: JupiterJitoRuntime | null = null;
let signer: SolanaSigner | null = null;
let unavailableReason = 'Jupiter/Jito runtime is not configured';

/** Default tip ceiling: 0.005 SOL. Overridden by `JITO_MAX_TIP_LAMPORTS`. */
const DEFAULT_MAX_TIP_LAMPORTS = 5_000_000;
/** Used when the block engine's tip floor is unreadable. 0.0001 SOL. */
const DEFAULT_FALLBACK_TIP_LAMPORTS = 100_000;
const DEFAULT_PENDING_TTL_MS = 600_000;

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return parsed;
}

function readTipPercentile(): 'p50' | 'p75' | 'p95' {
  const raw = process.env.JITO_TIP_PERCENTILE ?? 'p75';
  if (raw !== 'p50' && raw !== 'p75' && raw !== 'p95') {
    throw new Error(`JITO_TIP_PERCENTILE must be p50, p75, or p95; got ${raw}`);
  }
  return raw;
}

export function configureJupiterJitoRuntime(
  runtime: JupiterJitoRuntime,
  runtimeSigner: SolanaSigner
): void {
  configured = runtime;
  signer = runtimeSigner;
  unavailableReason = '';
}

export function setJupiterJitoUnavailable(reason: string): void {
  configured = null;
  signer = null;
  unavailableReason = reason;
}

export function getConfiguredJupiterJitoRuntime(): JupiterJitoRuntime | null {
  return configured;
}

export function getJupiterJitoSigner(): SolanaSigner | null {
  return signer;
}

/**
 * Whether Solana may execute live.
 *
 * Fail-closed: an unconfigured runtime reports not-ready with a reason, and
 * `resolveChainMode` clamps the chain to paper rather than attempting a live
 * trade it cannot sign.
 */
export function getJupiterJitoLiveReadiness(): { ready: boolean; reason: string } {
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
export function createJupiterJitoRuntimeFromEnvironment(
  redis: RedisHashClient
): { runtime: JupiterJitoRuntime; signer: SolanaSigner } | null {
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

  // EXE-08: Ensure simulation gate is available and not silently omitted
  const simulationGate = createSolanaSimulationGateFromEnvironment();
  const simulationRequired = (process.env.SOLANA_SIMULATION_ENABLED ?? 'true') !== 'false';
  if (simulationRequired && !simulationGate) {
    setJupiterJitoUnavailable('Solana simulation gate failed to initialize or RPC is unconfigured');
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
    fallbackTipLamports: readPositiveInt(
      'JITO_FALLBACK_TIP_LAMPORTS',
      DEFAULT_FALLBACK_TIP_LAMPORTS
    ),
    tipPercentile: readTipPercentile(),
    pendingTtlMs: readPositiveInt('JITO_PENDING_TTL_MS', DEFAULT_PENDING_TTL_MS),
    jupiterApiKey: process.env.JUPITER_API_KEY,
    simulation: simulationGate ?? undefined
  });

  configureJupiterJitoRuntime(runtime, environmentSigner);
  return { runtime, signer: environmentSigner };
}

/** Resets module state. Test-only. */
export function resetJupiterJitoRuntimeForTests(): void {
  configured = null;
  signer = null;
  unavailableReason = 'Jupiter/Jito runtime is not configured';
}
