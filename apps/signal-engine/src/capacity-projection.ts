import { planFanout, type FanoutCandidate, type FanoutPlatformInputs, type FanoutSignal }
  from '@swat/db/dist/fanout-eligibility.js';

/** Shared pool-free projection. A cohort bound is not exact follower sizing. */
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

