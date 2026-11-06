import type { VenueReconciler } from './reconciliation-coordinator.js';
import type { PolymarketReconciliationStatus } from './polymarket.js';
/**
 * Venue handlers for the canonical reconciliation coordinator.
 *
 * These are deliberately narrower than the per-venue sweeps. A sweep reads its
 * own pending store, which carries the submission metadata needed to decode a
 * fill (account, token, submitted amounts). The coordinator claims from
 * `copy_executions` precisely because that store entry is *gone*, so a handler
 * here cannot reconstruct fill quantities.
 *
 * What it can do is settle the cases that need no quantities:
 *   - the venue says the submission failed  -> terminate as `failed`, with evidence
 *   - the venue says it is still in flight  -> `pending`, retry later
 *   - the venue says it succeeded           -> `unresolved`, because booking a
 *     fill without quantities would corrupt the position ledger
 *
 * `unresolved` is not a dead end: the coordinator escalates once an execution
 * exhausts its reconciliation attempts, which turns a silently stuck row into a
 * human-visible one. Never guess a quantity to avoid an escalation.
 */
type FailExecution = (executionId: string, reason: string) => Promise<unknown>;
export type EvmReceiptProbe = (transactionHash: string) => Promise<{
    status: 'success' | 'reverted';
} | null>;
/**
 * Robinhood Chain and any other EVM venue: probe the transaction receipt.
 *
 * A null receipt means the node has not seen the transaction yet, which is
 * indistinguishable from "dropped from the mempool" without the original
 * blockhash window — so it stays `pending` and the attempt counter is what
 * eventually forces a human look.
 */
export declare function createEvmReceiptReconciler(input: {
    probe: EvmReceiptProbe;
    fail?: FailExecution;
}): VenueReconciler;
export type SolanaConfirmationProbe = (transactionIdentity: string) => Promise<{
    status: 'confirmed' | 'failed' | 'not-found';
}>;
/** Solana via Trojan: probe the signature's confirmation status. */
export declare function createSolanaConfirmationReconciler(input: {
    probe: SolanaConfirmationProbe;
    fail?: FailExecution;
}): VenueReconciler;
export type PolymarketExecutionProbe = (executionId: string) => Promise<{
    status: PolymarketReconciliationStatus;
    reason?: string;
} | null>;
/**
 * Polygon via Polymarket, the one venue that needs no store entry.
 *
 * Its pending state lives in the `trades` table alongside `copy_execution_id`,
 * and its reconcile path persists canonical state itself — so unlike the other
 * venues it can settle a fill outright, and this handler only has to translate
 * the outcome.
 */
export declare function createPolymarketReconciler(input: {
    probe: PolymarketExecutionProbe;
}): VenueReconciler;
export {};
//# sourceMappingURL=reconciliation-venues.d.ts.map