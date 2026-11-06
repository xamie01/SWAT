import type { CopyExecutionRecord } from '@swat/db';
import type { Chain } from '@swat/shared';
/**
 * Canonical reconciliation coordinator.
 *
 * Each venue already sweeps its own pending store (Trojan and Robinhood in
 * Redis, Polymarket from the `trades` table). Those sweeps are the fast path
 * and stay authoritative. This coordinator is the backstop for the case they
 * structurally cannot cover: a `copy_executions` row that is still ambiguous
 * while its venue-side pending entry is gone — expired from Redis, dropped by a
 * flush, or written by a process that died before the store was updated. Such a
 * row is invisible to every venue sweeper and would otherwise stay
 * `reconciliation_required` forever.
 *
 * It claims work through `claimCopyExecutionsForReconciliation`, which is a
 * `FOR UPDATE SKIP LOCKED` claim, so several executor processes can run this
 * concurrently without double-reconciling a row.
 *
 * Every dependency is injected so the coordinator can be tested without
 * Postgres, Redis, or a venue client.
 */
export declare const RECONCILIATION_ACCOUNT = "operator";
/** What a venue handler concluded about one canonical execution. */
export type VenueReconciliationOutcome = 
/** Terminal: the handler resolved the execution and already persisted it. */
{
    status: 'resolved';
}
/** Not terminal yet — still genuinely in flight. Retry after `retryAt`. */
 | {
    status: 'pending';
    retryAt?: Date;
}
/**
 * The handler could not reach a conclusion (venue unreachable, evidence
 * missing). Distinct from 'pending': this is a failure to observe, not an
 * observation of incompleteness.
 */
 | {
    status: 'unresolved';
    reason: string;
};
export type VenueReconciler = (execution: CopyExecutionRecord) => Promise<VenueReconciliationOutcome>;
export type ReconciliationCoordinatorDependencies = {
    claim: (input: {
        limit: number;
    }) => Promise<CopyExecutionRecord[]>;
    release: (input: {
        executionId: string;
        claimId: string;
        retryAt?: Date | null;
    }) => Promise<boolean>;
    /** Venue handler per chain. A chain with no handler is left claimed-and-released. */
    reconcilers: Partial<Record<Chain, VenueReconciler>>;
    /** Escalation for an execution that has burned every reconciliation attempt. */
    escalate: (execution: CopyExecutionRecord, reason: string) => Promise<unknown>;
    /**
     * Operator account this sweep runs on behalf of (Standing Rule 2). It is a
     * logical label, not a filter: `copy_executions.target_account` holds a
     * chain-prefixed wallet address, so matching it against `'operator'` would
     * claim nothing. Executions are scoped by chain instead, via the handler set.
     */
    account?: string;
    limit?: number;
    /** Backoff before the next sweep may retry an unresolved execution. */
    retryDelayMs?: number;
    now?: () => Date;
};
export type ReconciliationCoordinatorResult = {
    claimed: number;
    resolved: number;
    pending: number;
    unresolved: number;
    exhausted: number;
    unsupported: number;
};
/**
 * Claim a batch of ambiguous canonical executions and route each to its venue.
 *
 * The claim must always be released, whatever the handler does — a claim left
 * held blocks that execution until `staleClaimBefore` expires it, which is the
 * exact stuck state this coordinator exists to prevent. So every path below
 * releases, and release failures are logged rather than thrown.
 */
export declare function runReconciliationCoordinator(dependencies: ReconciliationCoordinatorDependencies): Promise<ReconciliationCoordinatorResult>;
//# sourceMappingURL=reconciliation-coordinator.d.ts.map