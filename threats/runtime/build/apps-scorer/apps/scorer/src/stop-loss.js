import { isStopLossBreached, positionDrawdownPct } from '@swat/db';
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
export const STOP_LOSS_ACCOUNT = 'operator';
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
export function stopLossAccountForPosition(userId) {
    if (userId === null)
        return STOP_LOSS_ACCOUNT;
    if (typeof userId !== 'string' || userId.trim().length === 0) {
        throw new Error('stopLossAccountForPosition requires a non-empty user id or null');
    }
    return userId;
}
/**
 * Separates the two halves of the policy cache key. NUL, matching
 * `COPY_IDENTITY_SEPARATOR` in `copy-trade-lifecycle.ts`: neither a UUID nor a chain
 * name can contain one, so two distinct (account, chain) pairs cannot collide.
 */
const POLICY_CACHE_SEPARATOR = String.fromCharCode(0);
export function formatStopLossAlert(position, thresholdPct, drawdownPct) {
    return {
        type: 'STOP_LOSS_TRIGGERED',
        title: `Stop-loss triggered: ${position.tokenMint}`,
        message: `Position on ${position.tokenMint} is down ${drawdownPct.toFixed(2)}% ` +
            `against a ${thresholdPct}% stop-loss.\n` +
            `Signal: ${position.signalId}\n` +
            `Open quantity: ${position.openQuantity}\n` +
            `Cost basis: $${position.openCostBasisUsd.toFixed(2)}\n` +
            `Unrealised P&L: $${position.unrealizedPnlUsd.toFixed(2)}\n` +
            `A full closing sell has been queued.`,
        severity: 'high',
        chain: position.chain
    };
}
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
export async function runStopLossSweep(dependencies) {
    const result = {
        scanned: dependencies.positions.length,
        breached: 0,
        queued: 0,
        alreadyTriggered: 0,
        failed: 0,
        unaccountable: 0
    };
    // Keyed by (account, chain), not by chain. `resolveRiskPolicy` is account-scoped, so
    // caching on chain alone would serve the first user's stop-loss threshold to every
    // other user on that chain — a user who set a tighter stop would be swept at
    // somebody else's.
    const policyByAccountChain = new Map();
    for (const position of dependencies.positions) {
        let account;
        try {
            account = stopLossAccountForPosition(position.userId);
        }
        catch (error) {
            console.error(`[scorer] stop-loss account unresolvable for ${position.signalId}`, error);
            result.unaccountable++;
            continue;
        }
        const policyKey = `${account}${POLICY_CACHE_SEPARATOR}${position.chain}`;
        let policy = policyByAccountChain.get(policyKey);
        if (!policy) {
            try {
                policy = await dependencies.resolvePolicy(account, position.chain);
            }
            catch (error) {
                console.error(`[scorer] stop-loss policy lookup failed for ${account} on ${position.chain}`, error);
                result.failed++;
                continue;
            }
            policyByAccountChain.set(policyKey, policy);
        }
        if (!isStopLossBreached(position, policy.stopLossPct))
            continue;
        const drawdownPct = positionDrawdownPct(position);
        if (drawdownPct === null)
            continue;
        result.breached++;
        let claimed;
        try {
            claimed = await dependencies.claim({
                account,
                signalId: position.signalId,
                chain: position.chain,
                tokenMint: position.tokenMint,
                thresholdPct: policy.stopLossPct,
                drawdownPct,
                openQuantity: position.openQuantity,
                openCostBasisUsd: position.openCostBasisUsd,
                priceUsd: position.currentPriceUsd,
                positionKey: position.positionKey
            });
        }
        catch (error) {
            console.error(`[scorer] stop-loss claim failed for ${account} on ${position.signalId}`, error);
            result.failed++;
            continue;
        }
        if (!claimed) {
            result.alreadyTriggered++;
            continue;
        }
        try {
            await dependencies.enqueueSell({
                signalId: position.signalId,
                tokenMint: position.tokenMint,
                score: 100,
                direction: 'sell',
                stopLoss: true,
                sellTokenAmount: position.openQuantity,
                // The executor reads this to pick the acting principal
                // (`resolveExecutionPrincipal`). Omitted for the operator so the job stays
                // byte-identical to what this sweep enqueued before fan-out.
                ...(position.userId === null ? {} : { userId: position.userId })
            }, position.positionKey === undefined || position.positionKey === null
                ? `stop-loss-${account}-${position.signalId}`
                : `stop-loss-${account}-${position.signalId}-${position.positionKey}`, position.chain);
        }
        catch (error) {
            console.error(`[scorer] stop-loss sell enqueue failed for ${position.signalId}`, error);
            const release = position.positionKey === undefined || position.positionKey === null
                ? dependencies.release(account, position.signalId)
                : dependencies.release(account, position.signalId, position.positionKey);
            await release.catch((releaseError) => {
                console.error(`[scorer] stop-loss claim release failed for ${position.signalId}`, releaseError);
            });
            result.failed++;
            continue;
        }
        result.queued++;
        // Alerting must not undo a queued exit, so a failure here is logged only.
        await dependencies
            .publishAlert(formatStopLossAlert(position, policy.stopLossPct, drawdownPct))
            .catch((error) => {
            console.error(`[scorer] stop-loss alert failed for ${position.signalId}`, error);
        });
    }
    return result;
}
//# sourceMappingURL=stop-loss.js.map