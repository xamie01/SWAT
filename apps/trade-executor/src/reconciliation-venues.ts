import { transitionCopyExecution, type CopyExecutionRecord } from '@swat/db';
import type { VenueReconciler, VenueReconciliationOutcome } from './reconciliation-coordinator.js';
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

const failExecution: FailExecution = (executionId, reason) =>
  transitionCopyExecution({ executionId, nextState: 'failed', reason });

function requireSubmissionId(execution: CopyExecutionRecord): string | null {
  return execution.submissionId && execution.submissionId.trim().length > 0
    ? execution.submissionId
    : null;
}

/**
 * A claimed execution with no submission identity cannot be probed at all.
 *
 * This is not the same as "nothing was submitted": the row may have been written
 * by a process that died between the network call and the identity write, so the
 * order could well be live at the venue. Marking it failed would be a guess, so
 * it is reported unresolved and left for escalation.
 */
function missingSubmissionIdentity(execution: CopyExecutionRecord): VenueReconciliationOutcome {
  return {
    status: 'unresolved',
    reason:
      `${execution.chain} execution ${execution.id} has no submission identity, `
      + 'so the venue cannot be probed'
  };
}

export type EvmReceiptProbe = (
  transactionHash: string
) => Promise<{ status: 'success' | 'reverted' } | null>;

/**
 * Robinhood Chain and any other EVM venue: probe the transaction receipt.
 *
 * A null receipt means the node has not seen the transaction yet, which is
 * indistinguishable from "dropped from the mempool" without the original
 * blockhash window — so it stays `pending` and the attempt counter is what
 * eventually forces a human look.
 */
export function createEvmReceiptReconciler(input: {
  probe: EvmReceiptProbe;
  fail?: FailExecution;
}): VenueReconciler {
  const fail = input.fail ?? failExecution;
  return async (execution) => {
    const hash = requireSubmissionId(execution);
    if (!hash) return missingSubmissionIdentity(execution);

    const receipt = await input.probe(hash);
    if (!receipt) {
      return { status: 'pending' };
    }
    if (receipt.status === 'reverted') {
      await fail(execution.id, `transaction ${hash} reverted on ${execution.chain}`);
      return { status: 'resolved' };
    }
    return {
      status: 'unresolved',
      reason:
        `transaction ${hash} succeeded but its pending record is gone, `
        + 'so the filled quantities cannot be decoded'
    };
  };
}

export type SolanaConfirmationProbe = (
  transactionIdentity: string
) => Promise<{ status: 'confirmed' | 'failed' | 'not-found' }>;

/** Solana via Trojan: probe the signature's confirmation status. */
export function createSolanaConfirmationReconciler(input: {
  probe: SolanaConfirmationProbe;
  fail?: FailExecution;
}): VenueReconciler {
  const fail = input.fail ?? failExecution;
  return async (execution) => {
    const signature = requireSubmissionId(execution);
    if (!signature) return missingSubmissionIdentity(execution);

    const confirmation = await input.probe(signature);
    if (confirmation.status === 'failed') {
      await fail(execution.id, `Solana transaction ${signature} failed on chain`);
      return { status: 'resolved' };
    }
    if (confirmation.status === 'not-found') {
      return { status: 'pending' };
    }
    return {
      status: 'unresolved',
      reason:
        `Solana transaction ${signature} confirmed but its pending record is gone, `
        + 'so the swapped quantities cannot be decoded'
    };
  };
}

export type PolymarketExecutionProbe = (
  executionId: string
) => Promise<{ status: PolymarketReconciliationStatus; reason?: string } | null>;

/**
 * Polygon via Polymarket, the one venue that needs no store entry.
 *
 * Its pending state lives in the `trades` table alongside `copy_execution_id`,
 * and its reconcile path persists canonical state itself — so unlike the other
 * venues it can settle a fill outright, and this handler only has to translate
 * the outcome.
 */
export function createPolymarketReconciler(input: {
  probe: PolymarketExecutionProbe;
}): VenueReconciler {
  return async (execution) => {
    const outcome = await input.probe(execution.id);
    if (!outcome) {
      return {
        status: 'unresolved',
        reason: `no Polymarket order row is joined to execution ${execution.id}`
      };
    }
    switch (outcome.status) {
      case 'filled':
      case 'partial':
      case 'cancelled':
      case 'failed':
        return { status: 'resolved' };
      case 'pending_confirmation':
        return { status: 'pending' };
      default:
        return {
          status: 'unresolved',
          reason: outcome.reason ?? `Polymarket reported ${outcome.status}`
        };
    }
  };
}
