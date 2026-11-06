import type { RedisHashClient } from './runtime-codec.js';
import { type JupiterJitoRuntime } from './jupiter-jito-runtime.js';
import { type SolanaSigner } from './solana-signer.js';
export declare function configureJupiterJitoRuntime(runtime: JupiterJitoRuntime, runtimeSigner: SolanaSigner): void;
export declare function setJupiterJitoUnavailable(reason: string): void;
export declare function getConfiguredJupiterJitoRuntime(): JupiterJitoRuntime | null;
export declare function getJupiterJitoSigner(): SolanaSigner | null;
/**
 * Whether Solana may execute live.
 *
 * Fail-closed: an unconfigured runtime reports not-ready with a reason, and
 * `resolveChainMode` clamps the chain to paper rather than attempting a live
 * trade it cannot sign.
 */
export declare function getJupiterJitoLiveReadiness(): {
    ready: boolean;
    reason: string;
};
/**
 * Builds the runtime from the environment.
 *
 * Returns null when the Solana key or Jito endpoint is absent — the normal
 * posture for a paper-mode deployment, which must not be forced to hold a
 * signing key it never uses.
 */
export declare function createJupiterJitoRuntimeFromEnvironment(redis: RedisHashClient): {
    runtime: JupiterJitoRuntime;
    signer: SolanaSigner;
} | null;
/** Resets module state. Test-only. */
export declare function resetJupiterJitoRuntimeForTests(): void;
//# sourceMappingURL=jupiter-jito-config.d.ts.map