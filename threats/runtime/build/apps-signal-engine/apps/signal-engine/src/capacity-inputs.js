import { fetchDexScreenerLiquidity, stripChainPrefix } from '@swat/shared';
import { assessMasterCapacity, countActiveMasterFollowers, fetchMasterCapacityPolicy, fetchMasterWindowNotional, MASTER_CAPACITY_WINDOWS, PLATFORM_MAX_AGGREGATE_IMPACT_BPS, planFanout, recordMasterCapacityLedgerEntry, unknownLiquidity, usableLiquidityFromPoolTvlUsd } from '@swat/db';
/**
 * The four inputs `assessMasterCapacity` (`S4-M6`) needs, and the ledger writer
 * without which the cap permits everything.
 *
 * `packages/db/src/master-capacity.ts` is the decision and it is already written
 * and tested. **Nothing here re-decides anything.** This module supplies:
 *
 *   1. a **usable-liquidity** figure, or an honest unknown (`usableLiquidityForFanout`);
 *   2. a **cohort-level projected notional** (`projectCohortNotionalUsd`);
 *   3. the **active-follower count**, via `countActiveMasterFollowers`;
 *   4. the **ledger writer** (`recordFanoutCapacityLedger`) — the part the
 *      checklist calls out as wiring rather than an extra, because an empty
 *      `master_capacity_ledger` sums to "no capacity used" and a cap with no
 *      numerator permits every cohort while looking like a control.
 *
 * ── Pure / IO split ──────────────────────────────────────────────────────
 *
 * Everything above `--- IO ---` is pure: no network, no database, no clock it was
 * not given. That is not tidiness — there is no database and no DexScreener on
 * this branch, so anything expressed inside an `await` cannot be tested at all.
 * The same split `fanout-enqueue.ts` and `mirrorable-activity.ts` already use.
 *
 * ── Why the liquidity read is not a second fetch ─────────────────────────
 *
 * `checkTokenSafety` already calls `fetchDexScreenerLiquidity` on every signal
 * and returns the figure as `SafetyResult.liquidity`, and it runs **before** the
 * fan-out in `enqueueSignal`. So the pool TVL is already in hand on the hot path
 * and is passed in rather than re-fetched: a second round trip would add latency
 * to the money path for a number we just read, and the two reads could disagree.
 * `fetchPoolTvlUsdForCapacity` exists for a caller that does not have one.
 */
// ═══════════════════════════════════════════════════════════════════════════
// 1. Liquidity — and the reason Polymarket is an honest unknown
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Builds the `UsableLiquidity` input from a DexScreener pool TVL, per chain.
 *
 * **Polymarket (`polygon`) never uses the TVL argument — it is not even read.**
 * Since `S4-M38` it accepts an order-book verdict instead (`polymarketBook`);
 * before that it was hard-gated to `unknownLiquidity`. The gate is gone, the
 * reasoning behind it is not, and it is why the pool figure is still discarded
 * unread on this chain rather than filtered:
 *
 *   * A Polymarket outcome share is a **conditional token that trades on
 *     Polymarket's own CLOB**. Its liquidity is resting order-book depth inside a
 *     price bound, which is a different quantity from a pool reserve — the
 *     constant-product algebra in `priceImpactBps` does not describe it.
 *   * A comment claiming a gate that no longer exists is worse than no comment,
 *     so: what changed is that a **calibrated** figure can now arrive from the
 *     depth model. What did not change is that a **pool** figure is still wrong
 *     for this chain, and an unmeasured book still reads as unknown.
 *   * `fetchDexScreenerLiquidity(mint, 'polygon')` therefore either returns
 *     `null`, or — worse — returns the TVL of **some unrelated Polygon DEX pair
 *     that happens to match the address**. Passing that number through would put
 *     a real figure with a real basis in front of the cap, and the cap would then
 *     admit a cohort size against liquidity that does not exist for this market.
 *     A fabricated liquidity number is worse than an unknown one, because
 *     unknown fails closed and fabricated fails open. So the figure is discarded
 *     unread rather than filtered on being non-null.
 *   * The right number does exist at the venue and the executor already walks it
 *     (`polymarket-mirror-bound.ts`), but **at submission time, per order** —
 *     after fan-out has already decided. The pre-fan-out feed is `S4-M38`, an
 *     open item: a background service streaming books into Redis, with a
 *     **per-market** staleness rule, so a quiet market and a dead subscription
 *     cannot look alike. When it lands, this function gains a branch that returns
 *     `basis: 'order-book-depth'` from that cache, and a stale entry must keep
 *     returning `unknownLiquidity` — never truth.
 *
 * The consequence is stated rather than hidden: **Polymarket fan-out cannot be
 * capacity-assessed today**, so with `unassessablePolicy: 'skip'` no user copies
 * a Polymarket signal. That is a real cost with a named fix, and it is the
 * fail-closed direction.
 *
 * Solana and Robinhood Chain both route through AMM pairs, so the pool-TVL basis
 * applies — approximately, and `usableLiquidityFromPoolTvlUsd` already marks it
 * so. Robinhood Chain routes through Uniswap V3, where concentrated liquidity
 * makes a constant-product read of the same TVL only a rough guide; that caveat
 * is already carried on the value's `approximate` flag and `note`.
 */
export function usableLiquidityForFanout(input) {
    if (input.chain === 'polygon') {
        // S4-M38: a book verdict is now accepted where previously polygon was hard
        // -gated. The gate was correct while no honest depth figure existed — it
        // discarded the DexScreener value **unread** rather than filtering on it,
        // because a fabricated liquidity number fails OPEN and an unknown one fails
        // closed. That reasoning still holds for the pool figure, which is why
        // `poolTvlUsd` is still never consulted on this chain.
        if (input.polymarketBook) {
            // Trusted only when the model itself says it measured something. A verdict
            // of `unknown` — stale, gapped, or no snapshot — falls through to the note
            // below rather than being published as a figure.
            if (input.polymarketBook.basis === 'order-book-depth' && input.polymarketBook.usableLiquidityUsd !== null) {
                return input.polymarketBook;
            }
            return unknownLiquidity(input.chain, input.tokenMint, 'Polymarket book depth was assessed and came back unusable: '
                + `${input.polymarketBook.note ?? 'no note supplied'} (S4-M38). A stale, gapped or `
                + 'unsnapshotted book reads as unknown rather than as its last value, so this '
                + 'fails closed on a venue condition rather than on a missing feed.');
        }
        return unknownLiquidity(input.chain, input.tokenMint, 'Polymarket outcome shares trade on Polymarket\'s own CLOB, not on a DEX pair, so '
            + 'usable liquidity is resting order-book depth rather than a pool reserve. No '
            + 'pre-fan-out depth feed exists in this repo: the book is walked inside the '
            + 'executor at submission (polymarket-mirror-bound.ts), which is after this '
            + 'decision. Any DexScreener figure for this address would be an unrelated Polygon '
            + 'pair, so it is discarded unread rather than filtered — a fabricated liquidity '
            + 'number fails open, an unknown one fails closed. The feed is S4-M38, and a stale '
            + 'entry from it must also read as unknown.');
    }
    return usableLiquidityFromPoolTvlUsd(input.chain, input.tokenMint, input.poolTvlUsd);
}
export function projectCohortNotionalUsd(candidates, signal, platformWithoutCapacity) {
    // Provisional `admit` on purpose — see the note above. This plan is measured,
    // never enqueued.
    const provisional = planFanout(candidates, signal, {
        ...platformWithoutCapacity,
        capacity: { outcome: 'admit' }
    });
    const byUser = new Map(candidates.map((candidate) => [candidate.userId, candidate]));
    let total = 0;
    for (const verdict of provisional.eligible) {
        const balance = byUser.get(verdict.userId)?.knownBalanceUsd;
        // `null` is unreachable here: `balance-unknown` excludes before capacity. The
        // guard exists so a future reordering degrades to an over-estimate rather
        // than to a silent zero, which is the direction that admits a cohort.
        if (balance === null || balance === undefined || !Number.isFinite(balance) || balance < 0) {
            continue;
        }
        total += balance;
    }
    return Object.freeze({
        projectedNotionalUsd: total,
        cohortSize: provisional.eligible.length,
        basis: 'sum-of-admissible-known-balances',
        note: 'Upper bound: the whole known balance of every user who would be admitted but for '
            + 'capacity. Per-user sizing (S4-15) happens downstream in trade-executor, so no real '
            + 'order size exists yet; this errs high, which refuses a cohort that would have '
            + 'fitted rather than admitting one that moves the market.'
    });
}
// ═══════════════════════════════════════════════════════════════════════════
// 3. Mapping a decision onto the fan-out gate
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Turns a capacity decision into the gate `planFanout` reads, keeping the two
 * kinds of "no" apart.
 *
 * `FanoutPlatformInputs.capacity` has three states and they are not
 * interchangeable, because each produces a different exclusion code and sends an
 * operator somewhere different:
 *
 *   * `{ outcome: 'admit' }` — assessed and within limits, or assessed and within
 *     limits as a **lower bound** (some window legs were unpriced). Either way
 *     the cap was evaluated.
 *   * `{ outcome: 'skip' }` — a real breach. Users are excluded as
 *     `capacity-exhausted`, which is the truth: this master's cohort has consumed
 *     the pair's allowance, or the crude follower soft cap bound.
 *   * `null` — the cap **could not be evaluated**. Users are excluded as
 *     `capacity-unknown`, and `summariseFanout` then flags a platform fault
 *     rather than a quiet market. Reporting this as `capacity-exhausted` would
 *     send an operator to look at a pair's liquidity when the real answer is
 *     "Polymarket has no pre-fan-out depth feed" (`S4-M38`).
 *
 * Both `skip` shapes fail closed identically. The distinction is diagnostic, and
 * it is the whole reason `capacity-unknown` exists as a separate code.
 */
export function capacityGateFor(decision) {
    if (decision.outcome === 'admit')
        return { outcome: 'admit' };
    return decision.reasonCode === 'capacity-not-assessable' ? null : { outcome: 'skip' };
}
/**
 * Whether the impact cap is assessed for this signal's direction.
 *
 * **The cap is a buy-side control, and a sell is admitted without assessment.**
 * This is a policy choice, so the argument is written out:
 *
 *   * The two errors are not symmetrical. Refusing a buy is a missed copy,
 *     recoverable on the next signal. Refusing a **sell** strands an open position
 *     with no exit — the worst outcome available on this path, and the one
 *     `fanout-eligibility.ts`, `S4-M44`/`S4-M45` and the `winding_down` rules all
 *     bend to avoid: a leaving user holds no slot and still gets their sells.
 *   * A sell's notional is bounded by the position the user actually holds, which
 *     no input here can see — `copy_positions` is per user and the projection
 *     above is a balance sum, which describes a buy and is meaningless for a sell.
 *     Feeding it in would produce a confident wrong number, and feeding `null` in
 *     would make every sell `unassessed` and therefore skipped under
 *     `unassessablePolicy: 'skip'`.
 *   * The cohort's sells are bounded by the cohort's buys, and the buys were
 *     already gated by this cap on the way in. So the exposure is not unbounded;
 *     it is bounded one step earlier.
 *
 * **What this does not claim.** A cohort exit genuinely moves a price, and the
 * farming pattern `053` describes — buy small, let copy flow lift the price, sell
 * into it — has a sell leg this does not cap. Capping it needs per-user held
 * quantity at fan-out time, which is a different input than any of the four this
 * item names. Recorded here rather than left implicit.
 */
export function capacityAppliesToDirection(direction) {
    return direction === 'buy';
}
/**
 * The ledger rows one fan-out implies, from the chain's effective mode.
 *
 * `053` records the mode so the reader can filter to market-moving flow: paper
 * and shadow copies never reach a venue, so counting them would skip live users
 * over volume that never existed. `execution_mode` is CHECKed to
 * `paper|live|shadow`, which is a narrower set than `ExecutionMode` — so the
 * mapping is explicit rather than a cast:
 *
 *   * `off` writes **nothing**. No order was placed, so no capacity was consumed,
 *     and a row would be a claim that one was.
 *   * `live+shadow` writes **two** rows, matching
 *     `executionModesForChainMode` in `trade-executor/src/canonical-copy.ts` —
 *     that mode really does produce both a live and a shadow execution, and the
 *     unique index is `(source_trade_id, execution_mode)`, so both fit.
 *
 * Exhaustive over `ExecutionMode` via the `never` branch, so adding a mode to the
 * union fails to compile until somebody decides whether it moves a market. A
 * silent default here would either lose live flow from the numerator or invent
 * paper flow into it.
 */
export function ledgerModesForEffectiveMode(mode) {
    switch (mode) {
        case 'off':
            return [];
        case 'paper':
            return ['paper'];
        case 'live':
            return ['live'];
        case 'live+shadow':
            return ['live', 'shadow'];
        default: {
            const exhaustive = mode;
            throw new Error(`Unhandled execution mode for the capacity ledger: ${String(exhaustive)}`);
        }
    }
}
export function planCapacityLedgerEntries(input) {
    // An empty cohort consumed nothing. A row would claim a fan-out that placed no
    // user order, and the reader would count it as an unpriced leg — degrading a
    // clean window into a lower bound for no reason.
    if (!Number.isInteger(input.cohortSize) || input.cohortSize <= 0)
        return [];
    return ledgerModesForEffectiveMode(input.effectiveMode).map((executionMode) => Object.freeze({
        masterWalletAddress: input.masterWalletAddress,
        chain: input.chain,
        tokenMint: input.tokenMint,
        sourceTradeId: input.sourceTradeId,
        executionMode,
        notionalUsd: null,
        notionalBasis: 'unpriced',
        committedAt: input.committedAt
    }));
}
// ═══════════════════════════════════════════════════════════════════════════
// --- IO --- three thin reads, one thin write
// ═══════════════════════════════════════════════════════════════════════════
//
// None of the following has ever been executed: there is no database and no
// network on this branch. Every rule worth testing sits above this line.
/**
 * The window this fan-out is assessed over.
 *
 * `fanoutDrainMs` (5 minutes) rather than `selfImpactDecayMs` (1 hour), because
 * the question at this call site is *this* copied trade's own fan-out: about 50
 * orders through one concurrency-1 worker, which is the same drain arithmetic
 * behind `DEFAULT_FOLLOWER_SOFT_CAP` and the mark-to-market cadence. The wider
 * window is the one for the repeated-buy farming pattern and belongs to a caller
 * that is asking about a master's behaviour over time, not to a single dispatch.
 */
export const FANOUT_CAPACITY_WINDOW_MS = MASTER_CAPACITY_WINDOWS.fanoutDrainMs;
/**
 * Which recorded flow counts against the cap: **live only**.
 *
 * Required by `fetchMasterWindowNotional` with no default, and the answer here is
 * the market-moving set. Paper and shadow rows never reached a venue, so counting
 * them would skip live users over volume that never existed.
 */
export const FANOUT_CAPACITY_EXECUTION_MODES = ['live'];
/** A caller with no safety result in hand. Returns `null` on any failure. */
export async function fetchPoolTvlUsdForCapacity(chain, tokenMint) {
    // Polygon is never fetched: the figure would be discarded unread by
    // `usableLiquidityForFanout`, so the round trip is pure latency on the money
    // path.
    if (chain === 'polygon')
        return null;
    return fetchDexScreenerLiquidity(stripChainPrefix(tokenMint), chain);
}
/**
 * Resolves master capacity for one fan-out: three reads, then the pure decision.
 *
 * **`unassessablePolicy` is `'skip'` and must stay `'skip'`.** Declaring `'admit'`
 * would move real money through a cohort whose impact nobody measured, in exchange
 * for a fan-out that merely looks finished. If a chain still cannot admit anyone
 * after this, the missing liquidity feed is the finding — not the policy.
 *
 * A read failure yields `capacity: null`, which excludes everyone with
 * `capacity-unknown` rather than assuming an empty window. An empty window is
 * precisely the reading that makes an unwired cap permit everything.
 */
export async function resolveFanoutCapacity(input) {
    const windowEndsAt = input.now;
    const windowStartsAt = new Date(windowEndsAt.getTime() - FANOUT_CAPACITY_WINDOW_MS);
    let observation;
    let activeFollowerCount;
    let policyOverrides;
    try {
        const [window, followers, policy] = await Promise.all([
            fetchMasterWindowNotional({
                masterWalletAddress: input.masterWalletAddress,
                chain: input.chain,
                tokenMint: input.tokenMint,
                windowStartsAt,
                windowEndsAt,
                executionModes: FANOUT_CAPACITY_EXECUTION_MODES
            }),
            countActiveMasterFollowers({
                masterWalletAddress: input.masterWalletAddress,
                chain: input.chain
            }),
            fetchMasterCapacityPolicy({
                masterWalletAddress: input.masterWalletAddress,
                chain: input.chain
            })
        ]);
        observation = { ...window, projectedNotionalUsd: input.projection.projectedNotionalUsd };
        activeFollowerCount = followers;
        policyOverrides = policy.policy;
    }
    catch (error) {
        return {
            capacity: null,
            decision: null,
            logLine: `capacity unresolved for ${input.masterWalletAddress} on ${input.chain}: `
                + `${error instanceof Error ? error.message : String(error)}. Excluding everyone as `
                + 'capacity-unknown rather than reading a failed window as no capacity used.'
        };
    }
    // The cap in force, resolved before the book is read so the reserve is
    // calibrated against the same figure the cap will judge it by. This mirrors
    // `assessMasterCapacity`'s own resolution exactly; the two disagreeing is what
    // `assertPolymarketBookLiquidityCalibration` exists to catch.
    const impactCapBps = policyOverrides.maxAggregateImpactBps ?? PLATFORM_MAX_AGGREGATE_IMPACT_BPS[input.chain];
    let polymarketBook = input.polymarketBook;
    let bookLogLine = null;
    if (polymarketBook === undefined
        && input.readPolymarketBook !== undefined
        && input.chain === 'polygon') {
        try {
            polymarketBook = await input.readPolymarketBook({
                tokenMint: input.tokenMint,
                cohortDirection: input.cohortDirection ?? 'buy',
                impactCapBps
            });
        }
        catch (error) {
            // The reader's own contract is not to throw, so this is belt-and-braces.
            // Left as `undefined` rather than as an unknown value, because the two
            // notes differ: a reader that failed is a deployment problem, an unknown
            // book is a venue condition, and `usableLiquidityForFanout` says so.
            bookLogLine =
                `polymarket book read threw (${error instanceof Error ? error.message : String(error)}); `
                    + 'treated as no feed wired';
        }
    }
    const decision = assessMasterCapacity({
        masterWalletAddress: input.masterWalletAddress,
        chain: input.chain,
        tokenMint: input.tokenMint,
        windowMs: FANOUT_CAPACITY_WINDOW_MS,
        windowEndsAt,
        observation,
        liquidity: usableLiquidityForFanout({
            chain: input.chain,
            tokenMint: input.tokenMint,
            poolTvlUsd: input.poolTvlUsd,
            polymarketBook
        }),
        activeFollowerCount,
        policy: { ...policyOverrides, unassessablePolicy: 'skip' }
    });
    const unassessed = decision.unassessed.map((entry) => entry.reason).join(', ') || 'none';
    return {
        capacity: capacityGateFor(decision),
        decision,
        logLine: `capacity ${decision.outcome} (${decision.reasonCode}) | cohort ${input.projection.cohortSize} `
            + `projected $${input.projection.projectedNotionalUsd.toFixed(2)} `
            + `[${input.projection.basis}] | unassessed: ${unassessed}`
            + `${bookLogLine === null ? '' : ` | ${bookLogLine}`} | ${decision.internal.detail}`
    };
}
/**
 * Writes the fan-out's ledger rows. Never throws.
 *
 * Called **after** the jobs are enqueued, because the row asserts that a cohort
 * order was committed and an enqueue failure means it was not. The insert is
 * idempotent on `(source_trade_id, execution_mode)`, which is what stops a
 * retried fan-out — and `enqueueSignal` really does retry, since
 * `markSourceTradeSignalDispatched` runs only after the enqueue — from
 * double-counting itself into its own cap.
 *
 * A write failure is logged and swallowed rather than propagated: the orders are
 * already queued, so throwing here would re-run the whole dispatch and the jobs
 * would dedupe while nothing about the ledger improved. It returns how many rows
 * it attempted so the caller can log a shortfall.
 */
export async function recordFanoutCapacityLedger(entries) {
    let written = 0;
    for (const entry of entries) {
        try {
            await recordMasterCapacityLedgerEntry(entry);
            written += 1;
        }
        catch (error) {
            console.error(`[signal-engine] capacity ledger write failed for source trade ${entry.sourceTradeId} `
                + `(${entry.executionMode}); the window will under-count this fan-out:`, error instanceof Error ? error.message : error);
        }
    }
    return written;
}
//# sourceMappingURL=capacity-inputs.js.map