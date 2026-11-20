import type { Chain, ExecutionMode } from '@swat/shared';
import { capabilitiesFor, effectiveTier, tierAllowsChain, type UserTier } from '@swat/shared';
import { evaluateForwardOnlyMirror, type ForwardOnlySkipCode } from './forward-only.js';
import { mirrorEligibilityForState, type MirrorEligibility } from './subscription-state.js';

/**
 * Fan-out eligibility (`S4-13`) — who copies this signal, and why not.
 *
 * The seven conditions the checklist names: subscribed to the signal's master
 * wallet, auto-execute on, chain enabled, tier allows, balance at or above the
 * minimum, position cap not reached, capacity not exhausted.
 *
 * **Pure by construction, and that is the load-bearing decision.** Every input
 * arrives already fetched; nothing here reads a database, a clock it was not
 * given, or an environment variable. The repo pattern is `stop-loss.ts` and
 * `position-cap.ts`, and the reason is not tidiness: this logic decides whether
 * to move a user's money, and a decision expressed in SQL cannot be tested
 * without Postgres. Everything below is exercised by unit tests.
 *
 * **Three distinctions this module exists to keep apart.** Collapsing any of
 * them produces a bug whose symptom is silence:
 *
 *   1. **Ineligible vs. eligible-but-paper.** Platform gates
 *      (`LIVE_ENABLED_CHAINS` + an active `chain_certifications` row) *downgrade*
 *      a user to paper — they never make one ineligible. Treating a downgrade as
 *      an exclusion silently stops paper copying for everyone the moment a
 *      certification lapses; treating an exclusion as a downgrade opens a paper
 *      position for a user who asked not to copy at all.
 *   2. **Unknown vs. zero.** An unknown balance is not a small balance. Every
 *      unknown fails **closed** with its own code — see `resolveKnownBalanceUsd`,
 *      which already returns `null` rather than a partial sum for exactly this
 *      reason.
 *   3. **Buys-and-sells vs. sells-only.** A `winding_down` subscription still
 *      mirrors sells. Excluding it strands the user's open positions with no
 *      exit, which is the worst outcome available here.
 *
 * **Every exclusion carries a stable code, never a boolean.** An operator asking
 * "why didn't this user copy that trade?" must get a specific answer, and "no
 * signal" has to be distinguishable from "balance too low" and from "capacity
 * exhausted". A silent filter is indistinguishable from a defect.
 */

/** Why a subscriber was not enumerated for this signal. */
export type FanoutExclusionCode =
  /** Subscription state mirrors nothing: `ended`, or a state this build cannot read. */
  | 'subscription-not-mirroring'
  /** `winding_down` mirrors sells only, and this signal is a buy. */
  | 'winding-down-buy-refused'
  /** The user turned auto-execute off. Their manual copies are unaffected. */
  | 'auto-execute-off'
  /** The per-user kill switch (`S6-8`). No chain executes. */
  | 'user-killed'
  /** Signal score below the user's own floor. */
  | 'below-user-min-score'
  /** The user's tier does not include this chain. */
  | 'tier-excludes-chain'
  /** A global kill switch or an `off` mode for this chain. */
  | 'chain-execution-off'
  /** Balance is known and below the platform minimum. */
  | 'balance-below-minimum'
  /** Balance could not be established — stale, unpriced, or absent. Fails closed. */
  | 'balance-unknown'
  /** Already holding the maximum number of concurrent positions. */
  | 'position-cap-reached'
  /** Master capacity exhausted for this token in this window. */
  | 'capacity-exhausted'
  /** Capacity could not be assessed. Fails closed. */
  | 'capacity-unknown'
  /** Chain mode could not be resolved. Fails closed. */
  | 'chain-mode-unknown'
  /**
   * The master made this entry before the subscription's current active period
   * began (`S4-M2`). Following it would be catch-up buying into a position at a
   * cost basis the user never had.
   */
  | 'source-event-precedes-active-since'
  /** The signal's own event time is missing or unreadable, so the entry cannot be shown to postdate the subscription. Fails closed. */
  | 'source-event-time-unknown'
  /** The subscription's `active_since` is missing or unreadable, so no window can be evaluated. Fails closed. */
  | 'subscription-window-unknown';

/** One subscriber's inputs, all pre-fetched. */
export interface FanoutCandidate {
  readonly userId: string;
  readonly subscriptionState: unknown;
  /**
   * Start of the subscription's **current** active period (`051`.`active_since`),
   * or `null` when it could not be read.
   *
   * Consumed by the `S4-M2` gate below on buys only. `null` fails closed with
   * `subscription-window-unknown` — never treated as "the beginning of time",
   * which would mirror the master's entire history to a brand-new subscriber.
   */
  readonly activeSince: Date | null;
  readonly tier: UserTier;
  readonly tierExpiresAt: Date | null;
  readonly autoExecute: boolean;
  readonly killed: boolean;
  readonly minSignalScore: number;
  readonly maxConcurrentPositions: number;
  readonly openPositionCount: number;
  /**
   * Total USD the sizing path may use, or `null` when it may not.
   *
   * `null` means *unknown*, never zero — pass `resolveKnownBalanceUsd`'s result
   * straight through rather than coalescing it, or a stale row becomes a real
   * balance of 0 and the user is excluded for the wrong reason.
   */
  readonly knownBalanceUsd: number | null;
}

export interface FanoutSignal {
  readonly chain: Chain;
  readonly masterWalletAddress: string;
  readonly tokenMint: string;
  readonly direction: 'buy' | 'sell';
  readonly score: number;
  /** The master's source event time, used for forward-only buy gating. */
  readonly eventAt: Date | null;
}

export interface FanoutPlatformInputs {
  /**
   * Resolved mode for the signal's chain, or `null` if it could not be resolved.
   *
   * `null` excludes everyone with `chain-mode-unknown` rather than assuming
   * paper: a resolution failure means we do not know whether a global kill
   * switch is set, and guessing "paper" would keep writing ledger rows through
   * an outage the operator meant to stop everything with.
   */
  readonly chainMode: { readonly effectiveMode: ExecutionMode } | null;
  /** Platform floor in USD. A user below it is excluded, not sized down. */
  readonly minimumBalanceUsd: number;
  /**
   * Master capacity for this (master, token, window).
   *
   * `'admit'` proceeds; `'skip'` excludes; `null` excludes with
   * `capacity-unknown`. A capacity check that could not run is not a pass —
   * `assessMasterCapacity` deliberately reports `unassessed` entries rather
   * than smoothing them away, and this mirrors that.
   */
  readonly capacity: { readonly outcome: 'admit' | 'skip' } | null;
}

export type FanoutVerdict =
  | {
    readonly kind: 'eligible';
    readonly userId: string;
    /** What the user's subscription state permits. Carried so `S4-14` need not re-derive it. */
    readonly mirrors: MirrorEligibility;
    /**
     * The mode this user's job runs in.
     *
     * Already clamped by the platform gates (`S4-17`), so a downstream consumer
     * must not re-widen it. A user who wanted live but whose chain is
     * uncertified appears here as `paper` — eligible, downgraded, and told so
     * via `downgraded`.
     */
    readonly executionMode: ExecutionMode;
    /** True when the user asked for live and the platform clamped it. */
    readonly downgraded: boolean;
  }
  | {
    readonly kind: 'excluded';
    readonly userId: string;
    readonly code: FanoutExclusionCode;
  };

function excluded(userId: string, code: FanoutExclusionCode): FanoutVerdict {
  return { kind: 'excluded', userId, code };
}

function forwardOnlyExclusionCode(code: ForwardOnlySkipCode): FanoutExclusionCode {
  switch (code) {
    case 'source-event-precedes-active-since':
      return 'source-event-precedes-active-since';
    case 'source-event-timestamp-unreadable':
      return 'source-event-time-unknown';
    case 'active-since-unreadable':
    case 'no-subscription-window':
      return 'subscription-window-unknown';
    case 'subscription-entries-stopped':
    case 'subscription-not-mirroring':
      return 'subscription-window-unknown';
    case 'source-side-unrecognised':
      return 'source-event-time-unknown';
    default: {
      const exhaustive: never = code;
      throw new Error(`Unhandled forward-only skip code: ${String(exhaustive)}`);
    }
  }
}

/**
 * Decides one candidate. Order matters only for which code is reported first;
 * every check is independent, and the cheapest and most-specific come first so
 * an operator reading a log sees the user's own setting before a platform one.
 */
export function assessFanoutCandidate(
  candidate: FanoutCandidate,
  signal: FanoutSignal,
  platform: FanoutPlatformInputs
): FanoutVerdict {
  const mirrors = mirrorEligibilityForState(candidate.subscriptionState);
  if (mirrors === 'none') return excluded(candidate.userId, 'subscription-not-mirroring');
  // A winding-down subscription exits positions but opens none. Checked here
  // rather than folded into the state test so the two produce different codes:
  // one means "not subscribed", the other means "subscribed, buys only".
  if (mirrors === 'sells-only' && signal.direction === 'buy') {
    return excluded(candidate.userId, 'winding-down-buy-refused');
  }

  if (signal.direction === 'buy') {
    if (signal.eventAt === null) return excluded(candidate.userId, 'source-event-time-unknown');
    if (candidate.activeSince === null) {
      return excluded(candidate.userId, 'subscription-window-unknown');
    }
    const forwardOnly = evaluateForwardOnlyMirror({
      side: signal.direction,
      eventAt: signal.eventAt,
      subscription: {
        userId: candidate.userId,
        walletAddress: signal.masterWalletAddress,
        state: candidate.subscriptionState,
        activeSince: candidate.activeSince
      }
    });
    if (forwardOnly.kind === 'skip') {
      return excluded(candidate.userId, forwardOnlyExclusionCode(forwardOnly.code));
    }
  }

  if (candidate.killed) return excluded(candidate.userId, 'user-killed');
  if (!candidate.autoExecute) return excluded(candidate.userId, 'auto-execute-off');

  // Entry checks: score threshold, balance minimums, and concurrent position limits apply to buys only.
  // Reducing exits (sells) must not be blocked by low score, low buying balance, or position caps.
  if (signal.direction === 'buy') {
    if (!(signal.score >= candidate.minSignalScore)) {
      // Written as `!(>=)` so a NaN score excludes rather than passes.
      return excluded(candidate.userId, 'below-user-min-score');
    }
  }

  const tier = effectiveTier(candidate.tier, candidate.tierExpiresAt);
  if (!tierAllowsChain(capabilitiesFor(tier, candidate.tierExpiresAt), signal.chain)) {
    return excluded(candidate.userId, 'tier-excludes-chain');
  }

  if (!platform.chainMode) return excluded(candidate.userId, 'chain-mode-unknown');
  if (platform.chainMode.effectiveMode === 'off') {
    return excluded(candidate.userId, 'chain-execution-off');
  }

  if (signal.direction === 'buy') {
    if (candidate.knownBalanceUsd === null) {
      return excluded(candidate.userId, 'balance-unknown');
    }
    if (candidate.knownBalanceUsd < platform.minimumBalanceUsd) {
      return excluded(candidate.userId, 'balance-below-minimum');
    }

    if (candidate.openPositionCount >= candidate.maxConcurrentPositions) {
      return excluded(candidate.userId, 'position-cap-reached');
    }
  }

  if (!platform.capacity) return excluded(candidate.userId, 'capacity-unknown');
  if (platform.capacity.outcome === 'skip') {
    return excluded(candidate.userId, 'capacity-exhausted');
  }

  return {
    kind: 'eligible',
    userId: candidate.userId,
    mirrors,
    executionMode: platform.chainMode.effectiveMode,
    downgraded: false
  };
}

export interface FanoutPlan {
  readonly eligible: readonly Extract<FanoutVerdict, { kind: 'eligible' }>[];
  readonly excluded: readonly Extract<FanoutVerdict, { kind: 'excluded' }>[];
  /** Counts per exclusion code. One log line can then summarise a whole fan-out. */
  readonly exclusionCounts: Readonly<Partial<Record<FanoutExclusionCode, number>>>;
}

/**
 * Enumerates a signal's fan-out.
 *
 * Returns the excluded set alongside the eligible one rather than filtering it
 * away: "nobody copied this signal" and "nobody was subscribed" look identical
 * from an empty array, and the difference is the whole of an operator's
 * diagnosis.
 */
export function planFanout(
  candidates: readonly FanoutCandidate[],
  signal: FanoutSignal,
  platform: FanoutPlatformInputs
): FanoutPlan {
  const eligible: Extract<FanoutVerdict, { kind: 'eligible' }>[] = [];
  const rejected: Extract<FanoutVerdict, { kind: 'excluded' }>[] = [];
  const counts: Partial<Record<FanoutExclusionCode, number>> = {};

  for (const candidate of candidates) {
    const verdict = assessFanoutCandidate(candidate, signal, platform);
    if (verdict.kind === 'eligible') eligible.push(verdict);
    else {
      rejected.push(verdict);
      counts[verdict.code] = (counts[verdict.code] ?? 0) + 1;
    }
  }

  return { eligible, excluded: rejected, exclusionCounts: counts };
}
