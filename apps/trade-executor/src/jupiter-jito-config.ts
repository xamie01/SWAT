import { createDatabaseJitoStore, type DurableJitoPending } from '@swat/db';
import type { RedisHashClient } from './runtime-codec.js';
import { createJupiterJitoRuntime, requireDurableJitoPending,
  type JupiterJitoRuntime, type JupiterJitoRuntimeOptions, type JupiterJitoResolution } from './jupiter-jito-runtime.js';
import { SOLANA_SIGNING_UNAVAILABLE, type SolanaSigner } from './solana-signer.js';
import { createCanonicalJitoQuote, createJitoReceiptCommit, type CanonicalJitoQuoteDependencies } from './solana-dispatch.js';
import type { CanonicalWorkerPorts } from './worker-policy.js';

let configured: JupiterJitoRuntime | null = null;
let signer: SolanaSigner | null = null;
let canonicalQuote: CanonicalWorkerPorts['quote'] = async () => null;
let commitReceipt: ReturnType<typeof createJitoReceiptCommit> | null = null;
let unavailableReason = SOLANA_SIGNING_UNAVAILABLE;

/** Only explicit reviewed dependencies can install local adapters. This function
 * is NOT provider certification or source/custody/live readiness. Environment
 * startup never supplies these ports while final-message authority is absent. */
export function configureJupiterJitoRuntime(runtime: JupiterJitoRuntime, runtimeSigner: SolanaSigner): void {
  configured = runtime; signer = runtimeSigner;
  canonicalQuote = async () => null; commitReceipt = null;
  unavailableReason = 'jito-canonical-provider-and-receipt-scope-unavailable';
}
export interface ReviewedJitoAdapters {
  readonly transaction: CanonicalWorkerPorts['transaction'];
  readonly signer: SolanaSigner;
  readonly observe: CanonicalJitoQuoteDependencies['observe'];
  readonly runtimeOptions: Omit<JupiterJitoRuntimeOptions, 'pendingStore' | 'signTransaction' | 'buildTipTransaction'>;
}
export function createReviewedJitoAdapters(input: ReviewedJitoAdapters): JupiterJitoRuntime {
  const store = createDatabaseJitoStore({ transaction: input.transaction });
  const runtime = createJupiterJitoRuntime({ ...input.runtimeOptions,
    pendingStore: { ...store,
      prepare: pending => store.prepare(requireDurableJitoPending(pending)),
      save: pending => store.save(requireDurableJitoPending(pending)),
      async resolve(id, resolution) {
        if (resolution.status !== 'filled' || !resolution.receipt || resolution.slot === null) throw new Error('Jito quantified acknowledgement required');
        await store.resolve(id, { status: 'filled', clientOrderId: id,
          signature: resolution.signature, slot: resolution.slot, receipt: resolution.receipt });
      }
    },
    signTransaction: tx => input.signer.sign(tx), buildTipTransaction: tip => input.signer.buildTip(tip) });
  configured = runtime; signer = input.signer;
  canonicalQuote = createCanonicalJitoQuote({ runtime, signerPublicKey: input.signer.publicKey, observe: input.observe });
  commitReceipt = createJitoReceiptCommit(input.transaction);
  unavailableReason = 'jito-live-provider-certification-unavailable';
  return runtime;
}
export function getConfiguredCanonicalJitoQuote(): CanonicalWorkerPorts['quote'] { return canonicalQuote; }
export async function settleConfiguredJitoResolution(resolution: JupiterJitoResolution): Promise<boolean> {
  return configured && commitReceipt ? configured.settle(resolution, commitReceipt) : false;
}
export function setJupiterJitoUnavailable(reason: string): void {
  configured = null; signer = null; canonicalQuote = async () => null; commitReceipt = null; unavailableReason = reason;
}
export function getConfiguredJupiterJitoRuntime(): JupiterJitoRuntime | null { return configured; }
export function getJupiterJitoSigner(): SolanaSigner | null { return signer; }
/** Injected adapters are local capability seams, not live certification. */
export function getJupiterJitoLiveReadiness(): { ready: boolean; reason: string } {
  return { ready: false, reason: unavailableReason || 'jito-live-provider-certification-unavailable' };
}
export function createJupiterJitoRuntimeFromEnvironment(_redis: RedisHashClient): { runtime: JupiterJitoRuntime; signer: SolanaSigner } | null {
  // No credentials, URL flags, Redis claims or pretend receipt provider can
  // enable absent final-message signing and scoped accounting authority.
  setJupiterJitoUnavailable(SOLANA_SIGNING_UNAVAILABLE);
  return null;
}
export function resetJupiterJitoRuntimeForTests(): void { setJupiterJitoUnavailable(SOLANA_SIGNING_UNAVAILABLE); }
