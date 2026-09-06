import type { Chain, ExecutionMode } from '@swat/shared';
import { fetchDexScreenerLiquidity, stripChainPrefix } from '@swat/shared';
import {
  assessMasterCapacity,
  countActiveMasterFollowers,
  fetchMasterCapacityPolicy,
  fetchMasterWindowNotional,
  MASTER_CAPACITY_WINDOWS,
  planFanout,
  recordMasterCapacityLedgerEntry,
  unknownLiquidity,
  usableLiquidityFromPoolTvlUsd,
  type FanoutCandidate,
  type FanoutPlatformInputs,
  type FanoutSignal,
  type MasterCapacityDecision,
  type MasterCapacityObservation,
  type UsableLiquidity
} from '@swat/db';

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
export function usableLiquidityForFanout(input: {
  readonly chain: Chain;
  readonly tokenMint: string;
  /** DexScreener `liquidity.usd` for the deepest pair, or `null`. */
  readonly poolTvlUsd: number | null;
  /**
   * A Polymarket order-book verdict from `assessPolymarketBookDepth` (`S4-M38`).
   *
   * Passed as an already-assessed `UsableLiquidity` rather than as raw depth,
   * because the calibration is the whole point: the depth model publishes
   * `capacity * 10_000 / capBps`, an equivalent reserve for which
   * `priceImpactBps(N, reserve) <= capBps` holds **iff** `N` is within the true
   * book capacity. Accepting a raw depth number here and converting it locally
   * would put that algebra in two places, and the wrong one of the two would be
   * the one that silently disagrees.
   *
   * `undefined` means no subscriber is wired for this token, which is a different
   * fact from a subscriber reporting a stale or gapped book — the first is a
   * deployment gap, the second is a venue condition. Both fail closed; only their
   * notes differ, so an operator is not sent to the wrong place.
   */
  readonly polymarketBook?: UsableLiquidity | null;
}): UsableLiquidity {
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
      return unknownLiquidity(
        input.chain,
        input.tokenMint,
        'Polymarket book depth was assessed and came back unusable: '
          + `${input.polymarketBook.note ?? 'no note supplied'} (S4-M38). A stale, gapped or `
          + 'unsnapshotted book reads as unknown rather than as its last value, so this '
          + 'fails closed on a venue condition rather than on a missing feed.'
      );
    }
    return unknownLiquidity(
      input.chain,
      input.tokenMint,
      'Polymarket outcome shares trade on Polymarket\'s own CLOB, not on a DEX pair, so '
        + 'usable liquidity is resting order-book depth rather than a pool reserve. No '
        + 'pre-fan-out depth feed exists in this repo: the book is walked inside the '
        + 'executor at submission (polymarket-mirror-bound.ts), which is after this '
        + 'decision. Any DexScreener figure for this address would be an unrelated Polygon '
        + 'pair, so it is discarded unread rather than filtered — a fabricated liquidity '
        + 'number fails open, an unknown one fails closed. The feed is S4-M38, and a stale '
        + 'entry from it must also read as unknown.'
    );
  }
  return usableLiquidityFromPoolTvlUsd(input.chain, input.tokenMint, input.poolTvlUsd);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. The cohort-level projected notional
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The ordering problem, and the estimate chosen to live with it.
 *
 * **Capacity must be decided before fan-out; sizing happens after it.** The cap
 * asks "how much will this cohort push through the pair?", and the answer is the
 * sum of every admitted user's order — but each order is sized per user in
 * `trade-executor` (`S4-15`, `sizePerUserBuy`), from that user's balance, their
 * `max_position_pct`, their conviction resolution and their remaining daily
 * exposure. None of that has happened when `planFanout` runs, and it cannot: the
 * capacity verdict is one of the inputs deciding who is in the cohort at all.
 *
 * So the projection is **necessarily an estimate**, and the only question worth
 * arguing about is which way it errs.
 *
 * **Erring high is safe; erring low is not.** Too high refuses a cohort that
 * would have fitted — a missed copy, recoverable on the next signal. Too low
 * admits a cohort that then moves the market, which is the precise harm the item
 * exists to prevent: user #900 buys at a price users #1-899 created, and a master
 * who notices can farm it. A missed trade and a farmed cohort are not
 * symmetrical, so the estimate is deliberately an **upper bound** rather than a
 * best guess.
 *
 * **The bound: each admitted user's whole known balance.** Nobody's single order
 * can exceed the balance the sizing path is allowed to spend, so summing
 * `knownBalanceUsd` over the users who would be admitted is a true ceiling on the
 * cohort's combined notional, and it needs no price fetch and no fabricated rate.
 *
 * **How loose it is, stated rather than glossed.** `max_position_pct` defaults to
 * `DEFAULT_RISK_CONFIG.maxPositionPct` (5), so a typical cohort's real notional is
 * an order of magnitude under this bound. The bound is not tightened by that
 * default because 5 is a *default*, not a ceiling: `049` permits any percentage in
 * `(0, 100]`, so a user who set 60 would be under-charged and under-charging is
 * the direction that admits a market-moving cohort. The one change that would
 * tighten this honestly is threading `maxPositionPct` onto `FanoutCandidate` —
 * which lives in `packages/db/src/fanout-eligibility.ts` and is not this module's
 * to change. Until then the cap binds earlier than it strictly must, and that is
 * the acceptable failure.
 *
 * **The projection counts only users who would actually be admitted.** Running
 * `planFanout` with a provisional `admit` yields exactly the set that a real
 * `admit` would produce, because capacity is the last check `assessFanoutCandidate`
 * applies and every earlier exclusion is independent of it. That is a
 * counterfactual enumeration used only to measure the cohort — its verdicts are
 * discarded, and the real plan is built afterwards from the real capacity gate.
 * Charging the cap for users who are killed, opted out, below their own score
 * floor, over their position cap or on an uncertified tier would over-refuse for
 * orders nobody was going to place.
 *
 * **Coverage is `accounted`, not a lower bound**, and that is sound rather than
 * optimistic: `balance-unknown` excludes a user *before* capacity, so every user
 * in this sum has a known balance by construction. A user with an unpriced
 * balance is not silently counted as zero — they are not counted at all, and they
 * do not copy.
 */
export interface CohortNotionalProjection {
  /** The cohort's combined USD ceiling for this signal. */
  readonly projectedNotionalUsd: number;
  /** How many users the figure covers. Ops-only; never shown to a user (`S4-M9`). */
  readonly cohortSize: number;
  /** Named so a log line says which estimate produced the figure. */
  readonly basis: 'sum-of-admissible-known-balances';
  readonly note: string;
}

export function projectCohortNotionalUsd(
  candidates: readonly FanoutCandidate[],
  signal: FanoutSignal,
  platformWithoutCapacity: Omit<FanoutPlatformInputs, 'capacity'>
): CohortNotionalProjection {
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
    basis: 'sum-of-admissible-known-balances' as const,
    note:
      'Upper bound: the whole known balance of every user who would be admitted but for '
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
export function capacityGateFor(
  decision: MasterCapacityDecision
): FanoutPlatformInputs['capacity'] {
  if (decision.outcome === 'admit') return { outcome: 'admit' };
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
export function capacityAppliesToDirection(direction: 'buy' | 'sell'): boolean {
  return direction === 'buy';
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Which modes the ledger records
// ═══════════════════════════════════════════════════════════════════════════

/** The modes `053`'s `chk_master_capacity_ledger_mode` admits. */
export type CapacityLedgerMode = 'paper' | 'live' | 'shadow';

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
export function ledgerModesForEffectiveMode(
  mode: ExecutionMode
): readonly CapacityLedgerMode[] {
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
      const exhaustive: never = mode;
      throw new Error(`Unhandled execution mode for the capacity ledger: ${String(exhaustive)}`);
    }
  }
}

/**
 * The ledger rows for one fan-out event, or none.
 *
 * **`notionalUsd` is `null` with basis `unpriced`, and that is the honest value
 * rather than a shortcut.** `053`'s `chk_master_capacity_ledger_basis` admits
 * `quote-stablecoin`, `source-amount-usd`, `marked-to-price` and `unpriced`, and
 * enforces `(basis = 'unpriced') = (notional_usd IS NULL)`. What this call site
 * has is a **projection** — an upper bound over balances, not a fill — and none
 * of the three priced bases describes it. Recording the projection under
 * `marked-to-price` would put a number in the numerator that no order produced,
 * and every later window would then cap real cohorts against imagined flow.
 *
 * So the row records **that a fan-out happened and that its notional is not
 * known here**. `fetchMasterWindowNotional` counts it as an unpriced leg, reports
 * `coverage: 'partial-unpriced-legs'`, and `assessMasterCapacity` then marks its
 * impact figure a **LOWER BOUND** with a `copy-notional-partial` unassessed entry
 * — a pass that is visibly not a clean pass. That is exactly the mechanism
 * `053`'s Decision 2 was designed around.
 *
 * **What this does and does not fix.** It fixes the silent half of the trap: the
 * ledger is no longer empty, so a window no longer reads as a confident "no
 * capacity used". It does **not** yet supply a priced numerator, so the committed
 * term stays `$0` and the impact cap effectively measures the projection alone.
 * The priced writer belongs where a fill is confirmed, in `trade-executor`, and
 * the diff is in this task's report — until it lands, `S4-M6` is not closed.
 *
 * Pure. The write itself is `recordFanoutCapacityLedger` below.
 */
export interface CapacityLedgerEntry {
  readonly masterWalletAddress: string;
  readonly chain: Chain;
  readonly tokenMint: string;
  readonly sourceTradeId: string;
  readonly executionMode: CapacityLedgerMode;
  readonly notionalUsd: null;
  readonly notionalBasis: 'unpriced';
  readonly committedAt: Date;
}

export function planCapacityLedgerEntries(input: {
  readonly masterWalletAddress: string;
  readonly chain: Chain;
  readonly tokenMint: string;
  readonly sourceTradeId: string;
  readonly effectiveMode: ExecutionMode;
  /** How many user jobs were actually enqueued. Zero writes nothing. */
  readonly cohortSize: number;
  readonly committedAt: Date;
}): readonly CapacityLedgerEntry[] {
  // An empty cohort consumed nothing. A row would claim a fan-out that placed no
  // user order, and the reader would count it as an unpriced leg — degrading a
  // clean window into a lower bound for no reason.
  if (!Number.isInteger(input.cohortSize) || input.cohortSize <= 0) return [];

  return ledgerModesForEffectiveMode(input.effectiveMode).map((executionMode) =>
    Object.freeze({
      masterWalletAddress: input.masterWalletAddress,
      chain: input.chain,
      tokenMint: input.tokenMint,
      sourceTradeId: input.sourceTradeId,
      executionMode,
      notionalUsd: null as null,
      notionalBasis: 'unpriced' as const,
      committedAt: input.committedAt
    })
  );
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
export const FANOUT_CAPACITY_EXECUTION_MODES: readonly ['live'] = ['live'];

/** A caller with no safety result in hand. Returns `null` on any failure. */
export async function fetchPoolTvlUsdForCapacity(
  chain: Chain,
  tokenMint: string
): Promise<number | null> {
  // Polygon is never fetched: the figure would be discarded unread by
  // `usableLiquidityForFanout`, so the round trip is pure latency on the money
  // path.
  if (chain === 'polygon') return null;
  return fetchDexScreenerLiquidity(stripChainPrefix(tokenMint), chain);
}

export interface ResolveFanoutCapacityInput {
  readonly masterWalletAddress: string;
  readonly chain: Chain;
  readonly tokenMint: string;
  /** Already-fetched DexScreener pool TVL, e.g. `SafetyResult.liquidity`. */
  readonly poolTvlUsd: number | null;
  /**
   * A Polymarket order-book verdict from `assessPolymarketBookDepth` (`S4-M38`).
   *
   * Threaded here rather than fetched inside, for the same reason `poolTvlUsd` is:
   * the book lives in the indexer's in-process cache, and this runs in
   * signal-engine. A read from here would either import a second cache or open a
   * socket on the money path.
   *
   * Omitted means no subscriber is wired for this token, which polygon treats as
   * a deployment gap and every other chain ignores.
   */
  readonly polymarketBook?: UsableLiquidity | null;
  readonly projection: CohortNotionalProjection;
  /** End of the window. Injected so the decision stays reproducible in a log. */
  readonly now: Date;
}

export interface FanoutCapacityResolution {
  /** The gate `planFanout` reads. `null` excludes with `capacity-unknown`. */
  readonly capacity: FanoutPlatformInputs['capacity'];
  /** `null` only when a read failed hard enough that no decision could be formed. */
  readonly decision: MasterCapacityDecision | null;
  /** One ops line. Carries the internal detail, so never render it to a user. */
  readonly logLine: string;
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
export async function resolveFanoutCapacity(
  input: ResolveFanoutCapacityInput
): Promise<FanoutCapacityResolution> {
  const windowEndsAt = input.now;
  const windowStartsAt = new Date(windowEndsAt.getTime() - FANOUT_CAPACITY_WINDOW_MS);

  let observation: MasterCapacityObservation;
  let activeFollowerCount: number | null;
  let policyOverrides: { maxAggregateImpactBps?: number; followerSoftCap?: number };

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
  } catch (error) {
    return {
      capacity: null,
      decision: null,
      logLine:
        `capacity unresolved for ${input.masterWalletAddress} on ${input.chain}: `
        + `${error instanceof Error ? error.message : String(error)}. Excluding everyone as `
        + 'capacity-unknown rather than reading a failed window as no capacity used.'
    };
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
      polymarketBook: input.polymarketBook
    }),
    activeFollowerCount,
    policy: { ...policyOverrides, unassessablePolicy: 'skip' }
  });

  const unassessed = decision.unassessed.map((entry) => entry.reason).join(', ') || 'none';
  return {
    capacity: capacityGateFor(decision),
    decision,
    logLine:
      `capacity ${decision.outcome} (${decision.reasonCode}) | cohort ${input.projection.cohortSize} `
      + `projected $${input.projection.projectedNotionalUsd.toFixed(2)} `
      + `[${input.projection.basis}] | unassessed: ${unassessed} | ${decision.internal.detail}`
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
export async function recordFanoutCapacityLedger(
  entries: readonly CapacityLedgerEntry[]
): Promise<number> {
  let written = 0;
  for (const entry of entries) {
    try {
      await recordMasterCapacityLedgerEntry(entry);
      written += 1;
    } catch (error) {
      console.error(
        `[signal-engine] capacity ledger write failed for source trade ${entry.sourceTradeId} `
          + `(${entry.executionMode}); the window will under-count this fan-out:`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return written;
}
