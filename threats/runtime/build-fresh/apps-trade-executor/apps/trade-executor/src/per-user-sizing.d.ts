import type { Chain, ExecutionMode } from '@swat/shared';
import type { ChainModeResolution, UserChainMode, UserExecutionSettings } from '@swat/db';
/**
 * Per-user sizing, per-user risk keys, and the platform clamp that sits above both
 * (`S4-15`, `S4-16`, `S4-17`).
 *
 * **Pure by construction.** No database, no clock it was not given, no environment
 * read, no network. Same reason as `fanout-eligibility.ts`, `position-cap.ts` and
 * `stop-loss.ts`: there is no database available while this is being built, and
 * this logic decides how much of a user's money moves. Every number it needs
 * arrives as an argument, which is also why the whole thing is exercised by unit
 * tests with no infrastructure.
 *
 * **One sizing formula, not two.** The arithmetic is
 * `requestedBalanceAwareSize` + `capPositionToAvailableBalance` from `policy.ts`,
 * which is what `index.ts` already sizes with. Nothing here re-derives a position
 * size; this module chooses *whose* balance and *whose* percentages go in, and
 * reports what reduced the answer.
 *
 * ## Three distinctions this module exists to keep apart
 *
 *   1. **A platform gate downgrades; it never excludes.** `S4-13` already encodes
 *      this and `narrowExecutionMode` must not contradict it. A lapsed
 *      certification turns a live user into a paper user — it does not stop them
 *      copying. The reverse error is worse: re-widening a clamped `paper` back to
 *      `live` because the user's stored preference says `live` opens a real
 *      position on an uncertified chain. The narrowing is one-directional and
 *      tested in both directions.
 *   2. **Unknown is not zero.** An unknown balance produces a refusal with its own
 *      code, never a size of `0`. `resolveKnownBalanceUsd` returns `null` rather
 *      than a partial sum for exactly this reason; a `0` here would be
 *      indistinguishable from a genuinely empty account and would report the wrong
 *      cause. The rule holds in the other direction too: a real zero balance sizes
 *      to zero and refuses with `size-rounds-to-zero`, which is a different code.
 *   3. **A clamp is an output, not a side effect.** Every reduction is listed in
 *      `clamps` with the value before and after it. An operator asking "why did I
 *      get 0.05 and not 0.2" reads the list; a silent `Math.min` gives them
 *      nothing to read.
 *
 * ## What this module deliberately does NOT do
 *
 *   * **Sell sizing.** A copied sell is proportional to the position the user
 *     actually holds, which `sourceSellFractionToBps` (`canonical-copy.ts`) already
 *     computes correctly. A second sell path here would be a way to sell more than
 *     is held.
 *   * **Venue minimum order size.** The binding minimum is per market and is read
 *     from the order book at submission (`polymarket-mirror-bound.ts`). The
 *     configuration-time figure in `position-cap.ts` is explicitly approximate, and
 *     refusing a trade on an approximation would skip orders the venue would have
 *     accepted.
 */
/**
 * Whose risk policy, breaker and exposure ledger a sizing decision reads.
 *
 * `'operator'` is the pre-tenancy account: `050_copy_tenancy.sql` leaves legacy
 * rows at `user_id NULL` and backfills nothing, so the operator path keeps its own
 * key rather than being retro-assigned to a tenant.
 *
 * **This constant is a tenancy key and it becomes the user id.** It is deliberately
 * separate from `RECONCILIATION_ACCOUNT`, which is the same string today and must
 * NOT follow it — see `reconciliationAccountForUser`. Collapsing the two is how
 * that distinction gets lost, and `per-user-sizing.test.ts` guards it in both
 * directions.
 */
export declare const RISK_POLICY_ACCOUNT = "operator";
/**
 * The account key for `resolveRiskPolicy`, `readCircuitBreakerState`,
 * `recordCircuitBreakerFailure` / `Success`, `claimCircuitBreakerProbe` and the
 * per-user exposure ledger.
 *
 * This is the whole of `S4-16`'s "substitute the user key for `'operator'`": those
 * functions already take `account: string` (Standing Rule 2), so per-user risk is a
 * value substitution rather than a signature rewrite. Passing a user id gives that
 * user their own `breaker:${userId}:${chain}` state and their own cached policy —
 * one user tripping a breaker no longer halts every other user on the chain.
 *
 * `null` means the pre-tenancy operator path, which keeps `RISK_POLICY_ACCOUNT`.
 */
export declare function riskPolicyAccountForUser(userId: string | null): string;
/** Alias with the breaker's vocabulary. Same key, so the two cannot drift apart. */
export declare function circuitBreakerAccountForUser(userId: string | null): string;
/**
 * The reconciliation account. **Ignores `userId` on purpose.**
 *
 * One of the two verified exceptions in the checklist's §1. `RECONCILIATION_ACCOUNT`
 * is an *escalation label*, not a tenancy key: `copy_executions.target_account`
 * holds a chain-prefixed **wallet address** (`resolveLiveCopyTargetAccount` /
 * `resolvePaperCopyTargetAccount`), so filtering that column by an account value
 * claims zero rows. Substituting a user id here would fragment one alert stream
 * into N while scoping nothing, and the rows it was meant to sweep would sit at
 * `reconciliation_required` forever with nobody looking at them.
 *
 * It takes the parameter it discards so a fan-out call site that has a user id in
 * hand still lands on the right answer instead of reaching for
 * `riskPolicyAccountForUser`. That is the whole point of the two functions being
 * separate: a find-and-replace over the string `'operator'` cannot make them agree.
 */
export declare function reconciliationAccountForUser(_userId: string | null): string;
/**
 * A definite refusal. Nothing was sized, and the reason is specific.
 *
 * Split from the clamp codes below for the same reason `solana-simulation.ts`
 * splits `refuse` from `unavailable`: a refusal and a reduction are different
 * events, and folding them together means an operator cannot tell "we did not
 * trade" from "we traded smaller".
 */
export type PerUserSizingRefusalCode = 
/** The user's own kill switch is set. No chain executes (`S6-8`). */
'user-killed'
/** The user has not opted this chain in, or set it to `off`. */
 | 'user-chain-mode-off'
/**
 * The platform resolved this chain to `off` — a global kill switch (`'*' = 'off'`)
 * or an operator-set chain mode. Distinct from `user-chain-mode-off`: one is the
 * user's choice, the other is ours, and an operator debugging a silent chain
 * needs to know which.
 */
 | 'platform-chain-mode-off'
/**
 * The balance for the resolved mode could not be established. Fails closed.
 *
 * **Never reported as a size of zero.** An unknown balance is not an empty one:
 * `resolveKnownBalanceUsd` returns `null` rather than a partial sum, and coalescing
 * that to `0` here would size against a number nobody computed and then report
 * `size-rounds-to-zero`, sending the operator to look at funding instead of at the
 * balance poller.
 */
 | 'balance-unknown'
/** How much USD this user has already committed today is unknown. Fails closed. */
 | 'daily-exposure-unknown'
/** The user has spent their own agreed daily exposure allowance. */
 | 'daily-exposure-cap-reached'
/**
 * The sizing unit is not USD and no rate to USD was supplied, so the
 * USD-denominated exposure cap cannot be applied. Fails closed.
 *
 * A separate code from `daily-exposure-unknown` because the fix differs: this is a
 * missing price, that is a missing ledger read.
 */
 | 'usd-rate-unknown'
/**
 * Everything was known and the answer is genuinely zero — an empty balance, a
 * percentage too small for the venue's precision, or no headroom left after the
 * clamps. The honest counterpart to `balance-unknown`.
 */
 | 'size-rounds-to-zero';
/** Why the size that came out is smaller than the one that went in. */
export type PerUserSizingClampCode = 
/**
 * The master's conviction was the binding term, not the user's ceiling
 * (ADR-0005 §3.1: `min(max_position_pct, master_fraction × scale)`). A reduction
 * worth naming — it is the mechanism transmitting conviction, and without it
 * a 2% speculative punt and a 40% core position allocate identically.
 */
'master-conviction-fraction'
/** Clamped to the balance the user actually has. */
 | 'available-balance'
/** Clamped to the platform's absolute per-order ceiling for this chain. */
 | 'platform-maximum-notional'
/** Clamped to what is left of the user's own daily exposure allowance. */
 | 'daily-exposure-remaining'
/** Flooring to the venue's precision removed the remainder. */
 | 'precision-floor';
/** Why the execution mode that came out is narrower than the one requested. */
export type PerUserModeClampCode = 
/**
 * `S4-17`. The user asked for live and the platform gates
 * (`LIVE_ENABLED_CHAINS` + an active `chain_certifications` row) reduced it to
 * paper. The user stays **eligible** — this is a downgrade, never an exclusion.
 */
'platform-clamped-live-to-paper'
/** The user themselves asked for paper while the platform permitted live. */
 | 'user-requested-paper';
export interface PerUserSizingClamp {
    readonly code: PerUserSizingClampCode;
    /** Sizing units before this clamp. */
    readonly beforeUnits: number;
    /** Sizing units after it. */
    readonly afterUnits: number;
}
export interface PerUserModeDecision {
    /** What the user's stored per-chain setting asks for, after their kill switch. */
    readonly userRequested: UserChainMode;
    /**
     * The platform's already-clamped verdict — `planFanout`'s `executionMode`, or
     * `resolveChainMode`'s `effectiveMode`. Carried unchanged so the output shows what
     * this layer was handed, not only what it did with it.
     */
    readonly platformEffective: ExecutionMode;
    /** The narrower of the two. Never wider than `platformEffective`. */
    readonly effective: ExecutionMode;
    /** True only when the **platform** reduced a live request. Mirrors `FanoutVerdict.downgraded`. */
    readonly downgraded: boolean;
    readonly clamp: PerUserModeClampCode | null;
    /**
     * `ChainModeResolution.reason`, verbatim, when one was supplied — e.g. "Chain
     * solana has no active reviewed certification record".
     *
     * The clamp code says *that* the platform reduced the mode; this says *why*, in
     * the platform's own words, so an operator is not left guessing which of the two
     * gates lapsed.
     */
    readonly platformReason: string | null;
    /** `chain_certifications` + `LIVE_ENABLED_CHAINS` both satisfied, when supplied. */
    readonly certified: boolean | null;
}
/**
 * The platform's verdict for this chain.
 *
 * Shaped to accept a whole `ChainModeResolution` **and** the
 * `{ effectiveMode }` object `planFanout` consumes, so the same value can be
 * threaded from either without being rebuilt — a rebuild is where a `requestedMode`
 * gets substituted for an `effectiveMode` by accident.
 */
export type PlatformChainVerdict = Pick<ChainModeResolution, 'effectiveMode'> & Partial<Pick<ChainModeResolution, 'certified' | 'reason'>>;
/**
 * The platform verdict narrowed by the user's request. **Never widened.**
 *
 * This is `S4-17` in one expression, and the direction is the whole point:
 *
 *   * Either side saying `off` wins. A platform `off` is a kill switch; a user
 *     `off` is consent not given.
 *   * A platform verdict of `paper` stays `paper` however the user's row reads.
 *     This is the case a re-widening bug lives in — the user's stored preference is
 *     `live`, so a naive `userMode` return opens a real position on a chain whose
 *     certification lapsed.
 *   * A user asking for `paper` under a live-capable platform gets `paper`. Users
 *     may narrow their own exposure; that is not a downgrade.
 *   * `live+shadow` survives a `live` request unchanged. It is an operator
 *     diagnostic that executes live and records a parallel shadow fill, and
 *     collapsing it to `live` would silently switch the diagnostic off — narrowing
 *     is about *permission*, and both are equally live.
 */
export declare function narrowExecutionMode(platformEffective: ExecutionMode, userRequested: UserChainMode): ExecutionMode;
/**
 * Resolves the mode and records what narrowed it.
 *
 * Exported separately from `sizePerUserBuy` because the `S4-14` job builder needs
 * the same decision without sizing anything, and two derivations of "is this user
 * live right now" is exactly the divergence `S4-17` is about.
 */
export declare function resolvePerUserMode(input: {
    readonly userRequested: UserChainMode;
    readonly platform: PlatformChainVerdict;
    /** The per-user kill switch. Applied here so no call site has to remember it. */
    readonly killed: boolean;
}): PerUserModeDecision;
/**
 * How the master's own allocation is transmitted, and whether it could be.
 *
 * ADR-0005 §3.1: buy sizing is `min(max_position_pct, master_fraction × scale)`.
 * `master_fraction` is computed over **the assets we index**, so below a coverage
 * threshold it is a fraction of a portfolio we cannot see. In that case sizing falls
 * back to flat `max_position_pct` and the trade is marked
 * **sized-without-conviction** rather than presenting the fabricated fraction.
 */
export interface MasterConvictionInput {
    /**
     * The share of the master's indexed portfolio this buy represents, in `[0, 1]`.
     * `null` is unknown and triggers the flat fallback — it is never read as 0, which
     * would size every trade to nothing.
     */
    readonly masterFraction: number | null;
    /**
     * Share of the master's portfolio value our index covers, in `[0, 1]`. `null` is
     * unknown, which is the same fallback: an uncovered portfolio and an unmeasured
     * one are equally unusable as a conviction signal.
     */
    readonly portfolioCoverage: number | null;
    /** Coverage at or above which `masterFraction` is trusted. */
    readonly coverageThreshold: number;
    /** ADR-0005's `scale`, default 1.0. Multiplies the master's fraction. */
    readonly scale: number;
}
/** Why conviction sizing did not apply. `null` when it did. */
export type ConvictionFallbackReason = 
/** No fraction was supplied for this buy. */
'master-fraction-unknown'
/** Coverage was not supplied, so the fraction cannot be trusted. */
 | 'portfolio-coverage-unknown'
/** Coverage is below the threshold: the fraction is over a portfolio we cannot see. */
 | 'portfolio-coverage-below-threshold';
export interface ConvictionResolution {
    /** The percentage of balance to size with, before any cap. */
    readonly riskPct: number;
    /** The user's own ceiling, for comparison. */
    readonly userMaxPositionPct: number;
    /** True when the flat fallback applied — ADR-0005's "sized-without-conviction" mark. */
    readonly sizedWithoutConviction: boolean;
    readonly fallbackReason: ConvictionFallbackReason | null;
    /** The conviction percentage, when one was computable. */
    readonly convictionPct: number | null;
}
/**
 * `min(max_position_pct, master_fraction × scale)`, or the flat fallback.
 *
 * Written as `!(coverage >= threshold)` in effect — via `isFraction` plus an
 * explicit comparison — so a `NaN` coverage falls back rather than passing through.
 * A `NaN` that reached the multiplication would make `riskPct` `NaN`, and
 * `requestedBalanceAwareSize` would then throw where a fallback was the correct
 * answer.
 */
export declare function resolveConvictionRiskPct(userMaxPositionPct: number, conviction: MasterConvictionInput | null): ConvictionResolution;
/**
 * One user's daily exposure allowance, in USD.
 *
 * Derived from the user's own `max_daily_exposure_pct` against their own balance —
 * not from the process-wide `DAILY_EXPOSURE_CAP_USD`, which is one number for the
 * whole platform and would let a single funded user consume every other user's
 * headroom.
 *
 * `null` when the balance is unknown, propagating the unknown rather than reporting
 * a cap of 0 (which reads as "allowance exhausted" and is a different fact).
 */
export declare function userDailyExposureCapUsd(settings: Pick<UserExecutionSettings, 'maxDailyExposurePct'>, knownBalanceUsd: number | null): number | null;
/**
 * The balance available to size against, per mode.
 *
 * Two fields rather than one because the platform clamp changes which applies: a
 * user who asked for live on an uncertified chain is sized off the **paper**
 * bankroll, since that is the mode they will actually execute in. Passing one
 * pre-selected balance would mean the caller picking the basis from the *unclamped*
 * mode, which is the same re-widening bug wearing a different hat.
 *
 * Both are in **sizing units** — the unit the venue's order is denominated in (SOL
 * on Solana, USDC on Polymarket, ETH on Robinhood Chain), matching what
 * `index.ts` already passes to `calculateBalanceAwareSize`. `null` is unknown.
 */
export interface PerUserBalanceInput {
    /** Spendable balance for a live order, net of any gas reserve. `null` = unknown. */
    readonly liveUnits: number | null;
    /**
     * Notional paper bankroll, in sizing units. `null` = unknown.
     *
     * Supplied per call rather than read from `PAPER_BANKROLL_USD` because a per-user
     * paper bankroll is the point of `S4-16` — but note that **no per-user bankroll
     * column exists** (`049` has none), so today every caller will pass the same
     * platform figure. Parameterising it now means the day a column lands, nothing in
     * this module changes.
     */
    readonly paperUnits: number | null;
}
export interface PerUserSizingInput {
    /** `null` is the pre-tenancy operator path; see `riskPolicyAccountForUser`. */
    readonly userId: string | null;
    readonly chain: Chain;
    /**
     * The user's own limits, straight from `getUserExecutionSettings`.
     *
     * Already clamped on write, so a stored value is inside the platform ceiling
     * before it gets here — this module does not re-clamp the percentages, it applies
     * them.
     */
    readonly settings: Pick<UserExecutionSettings, 'maxPositionPct' | 'maxDailyExposurePct' | 'killed'>;
    /** The user's stored mode for this chain, from `requestedUserChainMode`. */
    readonly userRequestedMode: UserChainMode;
    /** The platform's already-clamped verdict. Never widened here. */
    readonly platform: PlatformChainVerdict;
    readonly balance: PerUserBalanceInput;
    /**
     * USD value of one sizing unit. `1` for a USD-denominated venue.
     *
     * `null` is unknown and refuses with `usd-rate-unknown` rather than defaulting.
     * `index.ts` currently substitutes `?? 150` for SOL and `?? 3000` for ETH when a
     * price fetch fails; a fabricated rate silently mis-scales the exposure cap, and
     * this module will not do that.
     */
    readonly usdPerUnit: number | null;
    /**
     * USD this user has already committed in the rolling window. `null` = unknown,
     * which fails closed.
     *
     * Must be **this user's** figure. `getRollingExposureUsd(chain)` as it stands sums
     * every trade on the chain, so passing it here would charge one user's spending
     * against every other user's allowance.
     */
    readonly dailyExposureUsdUsed: number | null;
    /** `null` skips conviction sizing and marks the trade sized-without-conviction. */
    readonly conviction: MasterConvictionInput | null;
    /** Cluster/tier multiplier, as `index.ts` computes it. */
    readonly tierMultiplier: number;
    /** Signal-score multiplier, as `index.ts` computes it. */
    readonly scoreMultiplier: number;
    /** Static base size in sizing units, used when `dynamic` is false. */
    readonly baseUnits: number;
    /** The platform's absolute per-order ceiling in sizing units, e.g. `MAX_POSITION_SOL`. */
    readonly platformMaximumUnits: number;
    readonly precision: number;
    /** `USE_DYNAMIC_BALANCE_SIZING`. When false the percentage does not apply. */
    readonly dynamic: boolean;
}
export type PerUserSizingOutcome = {
    readonly kind: 'refuse';
    readonly code: PerUserSizingRefusalCode;
    /** Operator-readable, specific enough to act on without re-reading the inputs. */
    readonly reason: string;
    /** Present even on a refusal: a refusal caused by an `off` mode is explained by it. */
    readonly mode: PerUserModeDecision;
    /** The risk-policy / breaker account this user's decision was keyed on. */
    readonly riskAccount: string;
} | {
    readonly kind: 'size';
    /** The number to trade, in sizing units, after every clamp. Always > 0. */
    readonly sizeUnits: number;
    /** What sizing asked for before any clamp, for comparison against `sizeUnits`. */
    readonly requestedUnits: number;
    /**
     * The size after every bound but before precision flooring.
     *
     * Carried so the clamp list is checkable against the returned size:
     * `sizeUnits === floorToPrecision(boundedUnits, precision)` holds exactly, and the
     * last bound clamp's `afterUnits` is this number. Without it the two can only be
     * compared approximately — `floorToPrecision` divides after flooring, so its
     * result can sit up to one ulp *above* its input (0.06999999999999999 at
     * precision 6 comes back as 0.07). That is a rounding artefact worth naming
     * rather than chasing: it is far below any venue's precision, but it means
     * `sizeUnits <= boundedUnits` is **not** guaranteed in the last bit.
     */
    readonly boundedUnits: number;
    /** Which balance the size was derived from, chosen by the **clamped** mode. */
    readonly basis: 'live-balance' | 'paper-bankroll';
    readonly basisUnits: number;
    /** The percentage actually applied, after the conviction rule. */
    readonly appliedRiskPct: number;
    readonly conviction: ConvictionResolution;
    /** ADR-0005 §3.1's mark. Convenience mirror of `conviction.sizedWithoutConviction`. */
    readonly sizedWithoutConviction: boolean;
    readonly mode: PerUserModeDecision;
    readonly riskAccount: string;
    /** Every reduction, in the order applied. Empty when nothing clamped. */
    readonly clamps: readonly PerUserSizingClamp[];
    readonly dailyExposureCapUsd: number;
    readonly dailyExposureRemainingUsd: number;
};
/**
 * Sizes one user's copy of one buy.
 *
 * The whole of `S4-15`, `S4-16` and `S4-17` in one decision, in this order:
 *
 *   1. **Mode** — the platform verdict narrowed by the user's request (`S4-17`).
 *      `off` on either side refuses; a platform `paper` is never re-widened.
 *   2. **Basis** — the balance for the *clamped* mode, so a downgraded user is
 *      sized off the paper bankroll rather than their live funds.
 *   3. **Percentage** — `min(max_position_pct, master_fraction × scale)`
 *      (ADR-0005 §3.1), falling back to flat `max_position_pct` and marking the
 *      trade sized-without-conviction when coverage is short.
 *   4. **Size** — `requestedBalanceAwareSize` + `capPositionToAvailableBalance`
 *      from `policy.ts`. No second formula.
 *   5. **Clamps** — available balance, then the platform ceiling, then the user's
 *      remaining daily allowance, then precision. Every reduction is recorded.
 *
 * Sells do not come here; see the module note.
 */
export declare function sizePerUserBuy(input: PerUserSizingInput): PerUserSizingOutcome;
//# sourceMappingURL=per-user-sizing.d.ts.map