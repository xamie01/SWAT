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
export const RECONCILIATION_ACCOUNT = 'operator';
/**
 * Claim a batch of ambiguous canonical executions and route each to its venue.
 *
 * The claim must always be released, whatever the handler does — a claim left
 * held blocks that execution until `staleClaimBefore` expires it, which is the
 * exact stuck state this coordinator exists to prevent. So every path below
 * releases, and release failures are logged rather than thrown.
 */
export async function runReconciliationCoordinator(dependencies) {
    const account = dependencies.account ?? RECONCILIATION_ACCOUNT;
    const limit = dependencies.limit ?? 20;
    const retryDelayMs = dependencies.retryDelayMs ?? 60_000;
    const now = dependencies.now ?? (() => new Date());
    const result = {
        claimed: 0,
        resolved: 0,
        pending: 0,
        unresolved: 0,
        exhausted: 0,
        unsupported: 0
    };
    const claimed = await dependencies.claim({ limit });
    result.claimed = claimed.length;
    for (const execution of claimed) {
        const claimId = execution.reconciliationClaimId;
        if (!claimId) {
            // The claim returned a row without its own claim id, so this process
            // cannot prove ownership and must not act on it.
            console.error(`[trade-executor] reconciliation claim for ${execution.id} has no claim id`);
            result.unresolved++;
            continue;
        }
        const reconcile = dependencies.reconcilers[execution.chain];
        if (!reconcile) {
            result.unsupported++;
            await releaseClaim(dependencies, execution, claimId, new Date(now().getTime() + retryDelayMs));
            continue;
        }
        let outcome;
        try {
            outcome = await reconcile(execution);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.error(`[trade-executor] ${execution.chain} reconciliation threw for ${execution.id}`, error);
            outcome = { status: 'unresolved', reason };
        }
        if (outcome.status === 'resolved') {
            result.resolved++;
            // A resolved execution is terminal, so no retry is scheduled. The DB
            // helper nulls next_reconciliation_at for terminal states anyway.
            await releaseClaim(dependencies, execution, claimId, null);
            continue;
        }
        const retryAt = outcome.status === 'pending' && outcome.retryAt
            ? outcome.retryAt
            : new Date(now().getTime() + retryDelayMs);
        if (outcome.status === 'pending') {
            result.pending++;
            await releaseClaim(dependencies, execution, claimId, retryAt);
            continue;
        }
        result.unresolved++;
        // The claim already incremented reconciliation_attempts, so this row has
        // now consumed its last attempt and no future claim will pick it up. It
        // needs a human before it is silently abandoned.
        if (execution.reconciliationAttempts >= execution.maxReconciliationAttempts) {
            result.exhausted++;
            await dependencies
                .escalate(execution, `[${account}] ${outcome.reason}`)
                .catch((error) => {
                console.error(`[trade-executor] reconciliation escalation failed for ${execution.id}`, error);
            });
        }
        await releaseClaim(dependencies, execution, claimId, retryAt);
    }
    return result;
}
async function releaseClaim(dependencies, execution, claimId, retryAt) {
    try {
        await dependencies.release({ executionId: execution.id, claimId, retryAt });
    }
    catch (error) {
        console.error(`[trade-executor] failed to release reconciliation claim for ${execution.id}`, error);
    }
}
//# sourceMappingURL=reconciliation-coordinator.js.map