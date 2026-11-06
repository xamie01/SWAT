import { getJupiterQuote, type JupiterQuote } from '@swat/shared';
import type { JupiterJitoRuntime, JupiterJitoSubmission } from './jupiter-jito-runtime.js';
/**
 * Solana dispatch adapter for the Jupiter + Jito path (checklist S3-7).
 *
 * Sits between the executor's job handler and the runtime, and owns exactly two
 * things the runtime does not: turning a trade intent into a Jupiter quote, and
 * flattening the runtime's submission union into the `{signature, venueStatus,
 * status}` shape `persistTrade` already expects.
 *
 * Extracted as its own module rather than inlined because the Solana branch of
 * `handleJob` is ~200 lines of interleaved canonical-execution bookkeeping, and
 * a swap done in place there is untestable without standing up the whole job.
 */
export declare const SOL_MINT = "So11111111111111111111111111111111111111112";
export interface SolanaDispatchInput {
    /** Stable idempotency key — the canonical client order id when one exists. */
    readonly clientOrderId: string;
    /** Unprefixed mint. */
    readonly tokenMint: string;
    readonly direction: 'buy' | 'sell';
    /** BUY: SOL to spend. Ignored for a sell. */
    readonly amountSol: number;
    /** SELL: exact base units to sell. Required for a sell. */
    readonly sellBaseUnits?: string;
    readonly slippageBps: number;
}
export type SolanaDispatchOutcome = {
    readonly kind: 'submitted';
    /** Present once the bundle lands; null while only the bundle id is known. */
    readonly signature: string | null;
    readonly bundleId: string;
    readonly venueStatus: string;
} | {
    readonly kind: 'rejected';
    readonly reason: string;
    /**
     * Stable machine-readable code when the rejection carries one — today the
     * pre-trade simulation codes from `solana-simulation.ts` (checklist
     * S4-M15). Optional and additive: consumers that only read `reason` are
     * unaffected, and `S4-M24` can render an actionable skip reason without
     * parsing prose.
     */
    readonly code?: string;
} | {
    readonly kind: 'ambiguous';
    readonly reason: string;
} | {
    readonly kind: 'filled';
    readonly signature: string;
    readonly slot: number | null;
};
export interface SolanaDispatchDependencies {
    readonly runtime: JupiterJitoRuntime;
    readonly signerPublicKey: string;
    readonly jupiterApiKey?: string;
    /** Injected for tests; defaults to the real quote client. */
    readonly quote?: typeof getJupiterQuote;
}
/**
 * Builds the quote for a trade intent.
 *
 * A BUY is `ExactIn` on SOL — we know what we are willing to spend. A SELL is
 * `ExactIn` on the token, because the source wallet's proportional exit gives us
 * an exact base-unit quantity to dispose of, not a target SOL amount. Using
 * `ExactOut` for a sell would mean naming a SOL figure we do not have, and would
 * let the venue take more tokens than the position holds.
 */
export declare function buildSolanaQuote(input: SolanaDispatchInput, dependencies: SolanaDispatchDependencies): Promise<JupiterQuote | null>;
/**
 * Maps a runtime submission onto the executor's persistence shape.
 *
 * `already_resolved` is flattened to its underlying resolution so a redelivered
 * job records the same terminal outcome it did the first time, rather than a
 * second trade row.
 */
export declare function mapSubmissionToOutcome(submission: JupiterJitoSubmission): SolanaDispatchOutcome;
/**
 * Quotes, submits, and maps in one call.
 *
 * A quote failure is `rejected`, not `ambiguous` — nothing was transmitted, so
 * there is no venue-side state to reconcile.
 */
export declare function dispatchSolanaTrade(input: SolanaDispatchInput, dependencies: SolanaDispatchDependencies): Promise<SolanaDispatchOutcome>;
//# sourceMappingURL=solana-dispatch.d.ts.map