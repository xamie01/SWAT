import type { Chain } from '@swat/shared';
import type { OpenPositionSnapshot, StopLossClaimInput } from '@swat/db';
/**
 * Stop-loss sweep. Runs on the back of the scorer's existing 5-minute
 * mark-to-market pass, so it reuses the prices that pass already fetched
 * instead of adding a second polling loop.
 *
 * Every dependency is injected so the sweep can be tested without Postgres,
 * Redis or BullMQ — same shape as `runAttributionReporting`.
 *
 * ## Per-position accounts (`S4-M46`)
 *
 * The account used to be resolved ONCE before the loop and every position claimed
 * under it. `signal_stop_losses` is `PRIMARY KEY (account, signal_id)`, so under
 * fan-out the first holder to breach claimed the signal and every other holder was
 * never sold — the sweep reporting success, having protected one of them. The account
 * is now derived per position from `position.userId`, which `markToMarketOpenPositions`
 * fills from `trades.user_id`.
 *
 * ## Driven by positions, never by subscription state
 *
 * This sweep does not enumerate users and never reads `user_wallet_subscriptions`. Its
 * input is the set of positions that mark-to-market just priced, so a user is swept
 * because they hold something.
 *
 * The alternative — enumerate subscribers, then look for their positions — is the trap
 * `S4-M45` named. Written the natural way (`state = 'active'`) it silently drops every
 * `winding_down` user, which is precisely the cohort whose master may have gone quiet
 * and whose open positions most need a stop-loss. `state <> 'ended'`, the predicate
 * `pauseUnsubscribedWallets` already uses, fixes that one instance — and `ended` is
 * still wrong, because a subscription reaches `ended` on the claim that nothing is open,
 * and if that claim is ever false the position it left behind is exactly the one nobody
 * is protecting. Driving from positions removes the class: there is no state to get
 * wrong, because there is no state consulted.
 */
/**
 * The account key for a position with no tenant — the pre-tenancy operator.
 *
 * A tenancy key, matching the executor's `RISK_POLICY_ACCOUNT`. **Not**
 * `RECONCILIATION_ACCOUNT`, which is the same string and must stay `'operator'` for a
 * different reason (it labels an escalation stream keyed by wallet address, so
 * substituting a user id there scopes nothing). Keeping the two apart is what stops a
 * find-and-replace over `'operator'` from breaking reconciliation.
 */
export declare const STOP_LOSS_ACCOUNT = "operator";
/**
 * The `signal_stop_losses.account` key for one position.
 *
 * Mirrors `riskPolicyAccountForUser` in `apps/trade-executor/src/per-user-sizing.ts`
 * deliberately rather than importing it: the scorer does not depend on the executor,
 * and a second copy of the *rule* would be the problem — a second copy of a two-line
 * mapping with a test asserting it agrees is not. `account` is a `VARCHAR(64)` label
 * here, not a `users(id)` foreign key, which is why the user id is used as-is.
 *
 * Throws on an empty or blank string rather than falling back to the operator. A blank
 * user id means the caller thought it had a tenant; keying that position on the
 * operator would file one user's stop-loss claim under another account, and then the
 * `(account, signal_id)` primary key would block the real owner's claim — the exact
 * defect this item exists to close, reintroduced by a fallback.
 */
export declare function stopLossAccountForPosition(userId: string | null): string;
/** The sell handed to the trade executor. Always closes the whole position. */
export type StopLossSellJob = {
    signalId: string;
    tokenMint: string;
    score: number;
    direction: 'sell';
    stopLoss: true;
    sellTokenAmount: number;
    /**
     * Whose exit this is. **Absent, not `null`, for the operator** — the executor's
     * `resolveExecutionPrincipal` reads `typeof payload.userId === 'string'`, and the
     * operator job is deliberately kept byte-identical to the pre-fan-out one so a
     * replayed BullMQ job cannot change principal across a deploy.
     */
    userId?: string;
    positionKey?: string;
};
export type StopLossAlert = {
    type: 'STOP_LOSS_TRIGGERED';
    title: string;
    message: string;
    severity: 'high';
    chain: Chain;
};
export type StopLossSweepDependencies = {
    positions: OpenPositionSnapshot[];
    resolvePolicy: (account: string, chain: Chain) => Promise<{
        stopLossPct: number;
    }>;
    claim: (input: StopLossClaimInput) => Promise<boolean>;
    release: (account: string, signalId: string, positionKey?: string | null) => Promise<void>;
    /**
     * `chain` is passed explicitly rather than left for the caller to re-derive
     * from `job.tokenMint`: since S3-25 the queue is chosen per chain, and the
     * position already carries the authoritative chain. Re-deriving it would be a
     * second implementation of the same decision.
     */
    enqueueSell: (job: StopLossSellJob, jobId: string, chain: Chain) => Promise<unknown>;
    publishAlert: (alert: StopLossAlert) => Promise<unknown>;
};
export type StopLossSweepResult = {
    scanned: number;
    breached: number;
    queued: number;
    alreadyTriggered: number;
    failed: number;
    /**
     * Positions whose account key could not be derived — a blank user id from
     * `stopLossAccountForPosition`.
     *
     * Counted separately from `failed` because it is a different event with a different
     * fix: `failed` means an infrastructure call did not land and the next sweep retries
     * it, while this means the position arrived with an unusable owner and every sweep
     * will reject it identically until the ledger row is corrected. Folding it into
     * `failed` would make a permanent condition look like a transient one.
     */
    unaccountable: number;
};
export declare function formatStopLossAlert(position: OpenPositionSnapshot, thresholdPct: number, drawdownPct: number): StopLossAlert;
/**
 * Evaluate every open position against its chain's stop-loss threshold and
 * queue one closing sell per breach.
 *
 * The claim is what makes this exactly-once: `claim` inserts the single
 * (account, signal) row and only the winner queues a sell. If queueing then
 * fails the claim is released so the next sweep can retry — a position is never
 * left both unclaimed and unsold.
 *
 * Every account-scoped call inside the loop uses that **position's** account: the
 * policy lookup, the claim, the job id and the release. A single one of them left on a
 * shared account reopens `S4-M46` on its own — a shared job id would have BullMQ
 * dedupe two users' distinct exits into one, and a shared release would delete another
 * user's live claim.
 */
export declare function runStopLossSweep(dependencies: StopLossSweepDependencies): Promise<StopLossSweepResult>;
//# sourceMappingURL=stop-loss.d.ts.map