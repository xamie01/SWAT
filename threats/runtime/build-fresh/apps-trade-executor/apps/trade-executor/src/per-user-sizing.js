import { RECONCILIATION_ACCOUNT } from './reconciliation-coordinator.js';
import { capPositionToAvailableBalance, requestedBalanceAwareSize } from './policy.js';
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
export const RISK_POLICY_ACCOUNT = 'operator';
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
export function riskPolicyAccountForUser(userId) {
    if (userId === null)
        return RISK_POLICY_ACCOUNT;
    if (typeof userId !== 'string' || userId.trim().length === 0) {
        throw new Error('riskPolicyAccountForUser requires a non-empty user id or null');
    }
    return userId;
}
/** Alias with the breaker's vocabulary. Same key, so the two cannot drift apart. */
export function circuitBreakerAccountForUser(userId) {
    return riskPolicyAccountForUser(userId);
}
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
export function reconciliationAccountForUser(_userId) {
    return RECONCILIATION_ACCOUNT;
}
const MODE_RANK = Object.freeze({
    off: 0,
    paper: 1,
    live: 2,
    'live+shadow': 2
});
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
export function narrowExecutionMode(platformEffective, userRequested) {
    if (userRequested === 'off' || platformEffective === 'off')
        return 'off';
    const userRank = MODE_RANK[userRequested];
    const platformRank = MODE_RANK[platformEffective];
    // The user can only ever narrow. When their rank is lower the request binds;
    // otherwise the platform's verdict is returned untouched, which is what stops a
    // stored `live` preference from re-widening a clamped `paper`.
    return userRank < platformRank ? userRequested : platformEffective;
}
/**
 * Resolves the mode and records what narrowed it.
 *
 * Exported separately from `sizePerUserBuy` because the `S4-14` job builder needs
 * the same decision without sizing anything, and two derivations of "is this user
 * live right now" is exactly the divergence `S4-17` is about.
 */
export function resolvePerUserMode(input) {
    const userRequested = input.killed ? 'off' : input.userRequested;
    const platformEffective = input.platform.effectiveMode;
    const effective = narrowExecutionMode(platformEffective, userRequested);
    const wantedLive = userRequested === 'live';
    const platformIsPaper = platformEffective === 'paper';
    const downgraded = wantedLive && platformIsPaper;
    let clamp = null;
    if (downgraded)
        clamp = 'platform-clamped-live-to-paper';
    else if (userRequested === 'paper' && MODE_RANK[platformEffective] > MODE_RANK.paper) {
        clamp = 'user-requested-paper';
    }
    return {
        userRequested,
        platformEffective,
        effective,
        downgraded,
        clamp,
        platformReason: input.platform.reason ?? null,
        certified: input.platform.certified ?? null
    };
}
function isFraction(value) {
    return value !== null && Number.isFinite(value) && value >= 0 && value <= 1;
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
export function resolveConvictionRiskPct(userMaxPositionPct, conviction) {
    if (!Number.isFinite(userMaxPositionPct)
        || userMaxPositionPct <= 0
        || userMaxPositionPct > 100) {
        throw new Error(`maxPositionPct must be a percentage in (0, 100], got ${userMaxPositionPct}`);
    }
    const flat = (reason) => ({
        riskPct: userMaxPositionPct,
        userMaxPositionPct,
        sizedWithoutConviction: true,
        fallbackReason: reason,
        convictionPct: null
    });
    if (conviction === null || !isFraction(conviction.masterFraction)) {
        return flat('master-fraction-unknown');
    }
    if (!isFraction(conviction.portfolioCoverage))
        return flat('portfolio-coverage-unknown');
    if (!Number.isFinite(conviction.coverageThreshold)) {
        throw new Error('conviction coverageThreshold must be a finite number');
    }
    if (!(conviction.portfolioCoverage >= conviction.coverageThreshold)) {
        return flat('portfolio-coverage-below-threshold');
    }
    if (!Number.isFinite(conviction.scale) || conviction.scale < 0) {
        throw new Error(`conviction scale must be a non-negative finite number, got ${conviction.scale}`);
    }
    // Capped at 100 before the min, so a scale above 1 on a concentrated master
    // cannot produce a percentage `requestedBalanceAwareSize` refuses outright.
    const convictionPct = Math.min(100, conviction.masterFraction * conviction.scale * 100);
    return {
        riskPct: Math.min(userMaxPositionPct, convictionPct),
        userMaxPositionPct,
        sizedWithoutConviction: false,
        fallbackReason: null,
        convictionPct
    };
}
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
export function userDailyExposureCapUsd(settings, knownBalanceUsd) {
    if (knownBalanceUsd === null || !Number.isFinite(knownBalanceUsd) || knownBalanceUsd < 0) {
        return null;
    }
    const pct = settings.maxDailyExposurePct;
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        throw new Error(`maxDailyExposurePct must be a percentage in (0, 100], got ${pct}`);
    }
    return knownBalanceUsd * (pct / 100);
}
function refuse(code, reason, mode, riskAccount) {
    return { kind: 'refuse', code, reason, mode, riskAccount };
}
function knownNonNegative(value) {
    return value !== null && Number.isFinite(value) && value >= 0;
}
/**
 * A rate of exactly 0 is not a rate.
 *
 * It would make the USD exposure cap 0 and the headroom in units `Infinity` — a
 * cap that both refuses everything and permits everything depending on which term
 * you read. Treated as unknown, which fails closed.
 */
function knownPositive(value) {
    return value !== null && Number.isFinite(value) && value > 0;
}
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
export function sizePerUserBuy(input) {
    const riskAccount = riskPolicyAccountForUser(input.userId);
    const mode = resolvePerUserMode({
        userRequested: input.userRequestedMode,
        platform: input.platform,
        killed: input.settings.killed
    });
    if (mode.effective === 'off') {
        // Which side said `off` decides the code. The user's own switches are reported
        // first because an operator debugging "this user is not trading" should see the
        // user's setting before being sent to look at a platform gate that is fine.
        if (input.settings.killed) {
            return refuse('user-killed', 'The per-user kill switch is set', mode, riskAccount);
        }
        if (mode.userRequested === 'off') {
            return refuse('user-chain-mode-off', `The user has not enabled ${input.chain}`, mode, riskAccount);
        }
        return refuse('platform-chain-mode-off', mode.platformReason ?? `The platform resolved ${input.chain} to off`, mode, riskAccount);
    }
    const live = mode.effective !== 'paper';
    const basis = live ? 'live-balance' : 'paper-bankroll';
    const basisUnits = live ? input.balance.liveUnits : input.balance.paperUnits;
    if (!knownNonNegative(basisUnits)) {
        // Not a size of zero. See distinction 2 in the module note.
        return refuse('balance-unknown', `No known ${basis} for ${input.chain}; refusing to size against an unknown balance`, mode, riskAccount);
    }
    if (basisUnits === 0) {
        // Checked before the exposure block on purpose. A zero balance produces a zero
        // daily allowance, and reporting that as `daily-exposure-cap-reached` would tell
        // an operator the user had spent an allowance they never had. The honest answer
        // is that there is nothing to size, and it is decisive regardless of whether a
        // USD rate or an exposure figure is available.
        return refuse('size-rounds-to-zero', `The ${basis} for ${input.chain} is zero`, mode, riskAccount);
    }
    if (!knownPositive(input.usdPerUnit)) {
        return refuse('usd-rate-unknown', `No USD rate for one ${input.chain} sizing unit, so the daily exposure cap cannot be applied`, mode, riskAccount);
    }
    if (!knownNonNegative(input.dailyExposureUsdUsed)) {
        return refuse('daily-exposure-unknown', 'This user\'s committed exposure for the rolling window is unknown', mode, riskAccount);
    }
    const basisUsd = basisUnits * input.usdPerUnit;
    const dailyExposureCapUsd = userDailyExposureCapUsd(input.settings, basisUsd);
    if (dailyExposureCapUsd === null) {
        return refuse('daily-exposure-unknown', 'The user\'s daily exposure cap could not be derived from a known balance', mode, riskAccount);
    }
    const dailyExposureRemainingUsd = dailyExposureCapUsd - input.dailyExposureUsdUsed;
    if (!(dailyExposureRemainingUsd > 0)) {
        return refuse('daily-exposure-cap-reached', `This user has committed $${input.dailyExposureUsdUsed} of their `
            + `$${dailyExposureCapUsd} daily allowance on ${input.chain}`, mode, riskAccount);
    }
    const conviction = resolveConvictionRiskPct(input.settings.maxPositionPct, input.conviction);
    const sizingInput = {
        balance: basisUnits,
        base: input.baseUnits,
        maximum: input.platformMaximumUnits,
        riskPct: conviction.riskPct,
        tierMultiplier: input.tierMultiplier,
        scoreMultiplier: input.scoreMultiplier,
        precision: input.precision,
        dynamic: input.dynamic
    };
    const requestedUnits = requestedBalanceAwareSize(sizingInput);
    const exposureHeadroomUnits = dailyExposureRemainingUsd / input.usdPerUnit;
    // The min is taken by `capPositionToAvailableBalance`, which is the one place in
    // the repo that decides how a requested size meets its caps. The walk below only
    // *explains* the number it returns.
    const maximumUnits = Math.min(input.platformMaximumUnits, exposureHeadroomUnits);
    const sizeUnits = capPositionToAvailableBalance({
        requested: requestedUnits,
        available: basisUnits,
        maximum: maximumUnits,
        precision: input.precision
    });
    const clamps = [];
    if (conviction.convictionPct !== null
        && conviction.convictionPct < conviction.userMaxPositionPct
        && input.dynamic) {
        // Reported in units so it reads alongside the other clamps: what flat sizing
        // would have asked for, versus what conviction asked for.
        const flatRequest = requestedBalanceAwareSize({
            ...sizingInput,
            riskPct: conviction.userMaxPositionPct
        });
        clamps.push({
            code: 'master-conviction-fraction',
            beforeUnits: flatRequest,
            afterUnits: requestedUnits
        });
    }
    let current = requestedUnits;
    const bounds = [
        ['available-balance', basisUnits],
        ['platform-maximum-notional', input.platformMaximumUnits],
        ['daily-exposure-remaining', exposureHeadroomUnits]
    ];
    for (const [code, limit] of bounds) {
        if (limit < current) {
            clamps.push({ code, beforeUnits: current, afterUnits: limit });
            current = limit;
        }
    }
    // `current` is now min(requested, available, platformMaximum, headroom), which is
    // exactly what `capPositionToAvailableBalance` floored. Only a genuine reduction is
    // recorded: see `boundedUnits` on the outcome for why flooring can move the value
    // the other way in the last bit.
    if (sizeUnits < current) {
        clamps.push({ code: 'precision-floor', beforeUnits: current, afterUnits: sizeUnits });
    }
    if (!(sizeUnits > 0)) {
        return refuse('size-rounds-to-zero', `Every input was known and sizing came to ${sizeUnits} ${input.chain} units`, mode, riskAccount);
    }
    return {
        kind: 'size',
        sizeUnits,
        requestedUnits,
        boundedUnits: current,
        basis,
        basisUnits,
        appliedRiskPct: conviction.riskPct,
        conviction,
        sizedWithoutConviction: conviction.sizedWithoutConviction,
        mode,
        riskAccount,
        clamps,
        dailyExposureCapUsd,
        dailyExposureRemainingUsd
    };
}
//# sourceMappingURL=per-user-sizing.js.map