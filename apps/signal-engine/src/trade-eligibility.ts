/**
 * Which signal patterns may result in a trade (ADR-0005 §6.1).
 *
 * **Why this exists as a module rather than a literal at each call site.** The
 * decision that cluster patterns are discovery-only was originally expressed as
 * `suppressTrade: true` passed by each of the four cluster detectors. That works
 * until someone deletes one — and deleting one is easy, because the flag reads
 * like a local formatting choice rather than the load-bearing consequence of an
 * ADR. There is no test that can catch its removal at the call site, because the
 * detectors query the database directly and `index.ts` starts timers at import.
 *
 * So the gate lives here instead: a single set, consulted by `enqueueSignal`, and
 * unit-testable without importing the service. Removing `suppressTrade: true`
 * from a detector now changes a log line, not whether money moves.
 *
 * **Why cluster patterns cannot trade.** A cluster is built from wallets that
 * share a funder (`clustering-queries.ts` calls that "the Sybil/coordination
 * signal") or that repeatedly buy the same tokens together. The snipe detector
 * then fires when those wallets buy the same token together — so the grouping
 * predicate and the signal predicate are one statement at two time scales, and
 * firing carries almost no information beyond "this group did what defines it".
 * Worse, co-movement among wallets grouped *for* co-moving is evidence of shared
 * control rather than of a shared fact, and a coordinated group's next move is to
 * sell into the flow their buying attracted. Trading it made us their exit
 * liquidity. Copy trades come from `source_trade` — one master's own trade,
 * mirrored proportionally.
 */

/**
 * Every pattern `enqueueSignal` accepts. Declared here rather than inline at the
 * call site so that adding a pattern is a decision made against this list.
 */
export type SignalPatternType =
  | 'source_trade'
  | 'snipe'
  | 'accumulation'
  | 'rotation'
  | 'exit';

/**
 * The only pattern that may queue a trade.
 *
 * A frozen array rather than an exported `Set`, for a reason that matters more
 * than it looks: `ReadonlySet` is a compile-time claim only, and a `Set` handed
 * out of a module stays mutable at runtime, so one stray `.add()` anywhere in the
 * process would re-enable cluster trading globally with no diff to review. This
 * is frozen, and the lookup below is built from a *copy* — so neither mutating
 * this array nor reaching into the internal set can widen what trades.
 *
 * Deliberately a list rather than a boolean on `source_trade`: it makes "what
 * else could trade?" an explicit question with a visible answer, and the
 * accompanying test asserts the membership exactly, so widening it cannot happen
 * silently.
 */
export const TRADE_ELIGIBLE_PATTERNS: readonly SignalPatternType[] = Object.freeze<
  SignalPatternType[]
>(['source_trade']);

/** Private lookup, copied from the frozen list so external mutation cannot reach it. */
const ELIGIBLE: ReadonlySet<SignalPatternType> = new Set(TRADE_ELIGIBLE_PATTERNS);

/**
 * Whether a pattern may queue a trade.
 *
 * Takes `string` rather than `SignalPatternType` on purpose. `enqueueSignal`'s
 * `patternType` is typed as `string`, so an unrecognised value is reachable
 * without a compile error — and the honest answer for something we do not
 * recognise is "no". Fails closed: an unknown pattern alerts but never trades.
 */
import type { SafetyResult } from './safety.js';

/** This screen admits candidates, not orders or unverified source confirmations. */
export interface SignalTradeAdmission {
  readonly direction: 'buy' | 'sell';
  readonly score: number;
  readonly minimumScore: number;
  readonly suppressTrade: boolean;
  readonly safety: Pick<SafetyResult, 'isSafe'>;
}

export type SignalTradeEligibility =
  | { readonly allowed: false; readonly reason: string }
  | { readonly allowed: true; readonly requiresOwnedExit: boolean };

export function evaluateSignalTradeEligibility(
  patternType: string,
  input: SignalTradeAdmission
): SignalTradeEligibility {
  if (!ELIGIBLE.has(patternType as SignalPatternType)) return { allowed: false, reason: 'discovery-only' };
  if (input.suppressTrade !== false) return { allowed: false, reason: 'trade-suppressed' };
  // A source sell may reach inventory enumeration despite deterioration. Only a
  // fresh scoped held-lot read plus CURRENT policy can permit its execution.
  if (input.direction === 'sell') return { allowed: true, requiresOwnedExit: true };
  if (input.direction !== 'buy') return { allowed: false, reason: 'direction-invalid' };
  if (input.safety.isSafe !== true) return { allowed: false, reason: 'entry-safety-refused' };
  if (!Number.isFinite(input.score) || input.score < 0 || input.score > 100
    || !Number.isFinite(input.minimumScore) || input.minimumScore < 0 || input.minimumScore > 100
    || input.score < input.minimumScore) return { allowed: false, reason: 'entry-score-refused' };
  return { allowed: true, requiresOwnedExit: false };
}

export function mayPatternTrade(patternType: string, admission?: SignalTradeAdmission): boolean {
  return admission
    ? evaluateSignalTradeEligibility(patternType, admission).allowed
    : ELIGIBLE.has(patternType as SignalPatternType);
}
