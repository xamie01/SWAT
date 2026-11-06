import { type JitoClientOptions, type JupiterQuote } from '@swat/shared';
import { type RedisHashClient } from './runtime-codec.js';
import type { SolanaSimulationGate } from './solana-simulation.js';
export interface JupiterJitoSubmitInput {
    /** Stable idempotency key. Must be `(signalId, target_account)`-derived. */
    readonly clientOrderId: string;
    readonly quote: JupiterQuote;
    readonly signerPublicKey: string;
}
export type JupiterJitoSubmission = {
    readonly status: 'submitted';
    readonly clientOrderId: string;
    readonly bundleId: string;
    readonly lastValidBlockHeight: number;
} | {
    readonly status: 'pending_confirmation';
    readonly clientOrderId: string;
    readonly bundleId: string;
    readonly lastValidBlockHeight: number;
} | {
    readonly status: 'rejected';
    readonly clientOrderId: string;
    readonly reason: string;
    /**
     * Stable machine-readable code, when the rejection has one.
     *
     * Optional and additive so existing consumers that only read `reason` keep
     * working; `S4-M24` reads this to render an actionable skip reason instead
     * of parsing prose.
     */
    readonly code?: string;
} | {
    readonly status: 'submission_unknown';
    readonly clientOrderId: string;
    readonly reason: string;
} | {
    readonly status: 'already_resolved';
    readonly clientOrderId: string;
    readonly resolution: JupiterJitoResolution;
};
/**
 * Terminal outcomes.
 *
 * **Only `filled` carries a tip** (checklist S4-P18). Jito bundles are atomic and
 * all-or-nothing, so a bundle that never landed was never charged a tip, and
 * booking one against a `failed` or `ambiguous` outcome would fabricate a cost
 * against a position that does not exist. Keeping the fields off the non-landed
 * variants makes that a type-level guarantee rather than a convention a future
 * call site can forget.
 *
 * `ambiguous` is the case worth being explicit about: it covers a confirmation
 * timeout and a bundle that landed without an observable signature. Neither is a
 * *free* outcome — the second one almost certainly did pay a tip — but neither is
 * an observed one either, and there is no position to attribute a cost to. The
 * cost of an ambiguous outcome is settled by an operator reading the chain, not
 * guessed here.
 */
export type JupiterJitoResolution = {
    readonly status: 'filled';
    readonly clientOrderId: string;
    readonly signature: string;
    readonly slot: number | null;
    /** Tip actually paid by the landed bundle. Absent on records written before S4-P18. */
    readonly tipLamports?: number | null;
    /**
     * The tip in USD, for `persistTrade`'s `feeUsd`.
     *
     * `null` when the SOL price was unavailable: a missing fee is visibly
     * absent, a guessed one silently misstates P&L.
     */
    readonly feeUsd?: number | null;
} | {
    readonly status: 'failed';
    readonly clientOrderId: string;
    readonly reason: string;
} | {
    readonly status: 'ambiguous';
    readonly clientOrderId: string;
    readonly reason: string;
};
export interface PendingJupiterJitoSubmission {
    readonly clientOrderId: string;
    readonly bundleId: string;
    /** Beyond this block height the transaction can never land — see below. */
    readonly lastValidBlockHeight: number;
    readonly expiresAt: Date;
    /**
     * Tip carried by the submitted bundle, in lamports.
     *
     * Optional because records already in Redis when this shipped do not have it,
     * and an in-flight bundle must reconcile normally rather than crash the sweep.
     * A missing value resolves to no fee rather than to a guessed one.
     */
    readonly tipLamports?: number | null;
}
export interface JupiterJitoPendingStore {
    findPending(clientOrderId: string): Promise<PendingJupiterJitoSubmission | null>;
    findResolution(clientOrderId: string): Promise<JupiterJitoResolution | null>;
    listPending(): Promise<PendingJupiterJitoSubmission[]>;
    save(pending: PendingJupiterJitoSubmission): Promise<void>;
    resolve(clientOrderId: string, resolution: JupiterJitoResolution): Promise<void>;
}
export declare function createRedisJupiterJitoStore(redis: RedisHashClient, key?: string): JupiterJitoPendingStore;
export interface JupiterJitoRuntimeOptions {
    readonly pendingStore: JupiterJitoPendingStore;
    readonly jito: JitoClientOptions;
    /**
     * Signs a base64 transaction and returns it base64-encoded.
     *
     * A **parameter**, not a module-level key (Standing Rule 2): the operator
     * wallet today, a per-user custodial key at Stage 4, with no call-site change.
     */
    readonly signTransaction: (transactionBase64: string) => Promise<string>;
    /** Builds the base64 tip transfer to the given tip account. */
    readonly buildTipTransaction: (input: {
        tipAccount: string;
        lamports: number;
    }) => Promise<string>;
    readonly maxTipLamports: number;
    readonly fallbackTipLamports: number;
    readonly tipPercentile?: 'p50' | 'p75' | 'p95';
    readonly pendingTtlMs: number;
    readonly jupiterApiKey?: string;
    /**
     * Pre-trade simulation gate (checklist S4-M15).
     *
     * A **parameter**, not a module-level `Connection` (Standing Rule 2), and
     * optional: when absent the swap is submitted unsimulated, which is the
     * behaviour every caller had before this existed. Supply it from
     * `createSolanaSimulationGateFromEnvironment()`.
     */
    readonly simulation?: SolanaSimulationGate;
    readonly now?: () => Date;
}
export declare function createJupiterJitoRuntime(options: JupiterJitoRuntimeOptions): {
    submit: (input: JupiterJitoSubmitInput) => Promise<JupiterJitoSubmission>;
    reconcile: (pending: PendingJupiterJitoSubmission, currentBlockHeight?: number) => Promise<JupiterJitoResolution | null>;
    sweep: (currentBlockHeight?: number) => Promise<JupiterJitoResolution[]>;
};
export type JupiterJitoRuntime = ReturnType<typeof createJupiterJitoRuntime>;
//# sourceMappingURL=jupiter-jito-runtime.d.ts.map