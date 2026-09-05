import { describe, expect, it } from 'vitest';
import {
  RISK_POLICY_ACCOUNT,
  circuitBreakerAccountForUser,
  narrowExecutionMode,
  reconciliationAccountForUser,
  resolveConvictionRiskPct,
  resolvePerUserMode,
  riskPolicyAccountForUser,
  sizePerUserBuy,
  userDailyExposureCapUsd,
  type PerUserSizingInput,
  type PerUserSizingOutcome
} from './per-user-sizing.js';
import { RECONCILIATION_ACCOUNT } from './reconciliation-coordinator.js';
import { calculateBalanceAwareSize, capPositionToAvailableBalance, floorToPrecision } from './policy.js';

/**
 * `S4-15` / `S4-16` / `S4-17`.
 *
 * Every test here is pure — no database, no Redis, no clock. That is not a
 * convenience: there is no database available, and this module decides how much of
 * a user's money moves.
 *
 * **Tier gating is deliberately absent.** Whether a user's tier permits a chain is
 * `S4-13`'s decision (`assessFanoutCandidate` → `tier-excludes-chain`), and it has
 * already happened by the time a candidate reaches sizing. A tier assertion here
 * would either duplicate that suite or encode a tier-table decision the operator
 * has not made.
 */

const USER = '7c9e1f52-0000-4000-8000-000000000001';

/**
 * A live, certified, well-funded baseline.
 *
 * Numbers chosen so each clamp can be made the *binding* one by moving a single
 * field: with a 10 SOL balance at 10% the request is 1.0, comfortably under the
 * platform ceiling of 5 and the 2.5-unit daily headroom. A fixture where several
 * caps coincide makes every assertion pass for the wrong reason.
 */
function baseInput(overrides: Partial<PerUserSizingInput> = {}): PerUserSizingInput {
  return {
    userId: USER,
    chain: 'solana',
    settings: { maxPositionPct: 10, maxDailyExposurePct: 25, killed: false },
    userRequestedMode: 'live',
    platform: { effectiveMode: 'live', certified: true },
    balance: { liveUnits: 10, paperUnits: 100 },
    usdPerUnit: 100,
    dailyExposureUsdUsed: 0,
    conviction: null,
    tierMultiplier: 1,
    scoreMultiplier: 1,
    baseUnits: 0.5,
    platformMaximumUnits: 5,
    precision: 6,
    dynamic: true,
    ...overrides
  };
}

function sized(outcome: PerUserSizingOutcome): Extract<PerUserSizingOutcome, { kind: 'size' }> {
  if (outcome.kind !== 'size') {
    throw new Error(`expected a size, got refusal ${outcome.code}: ${outcome.reason}`);
  }
  return outcome;
}

function refused(
  outcome: PerUserSizingOutcome
): Extract<PerUserSizingOutcome, { kind: 'refuse' }> {
  if (outcome.kind !== 'refuse') {
    throw new Error(`expected a refusal, got a size of ${outcome.sizeUnits}`);
  }
  return outcome;
}

describe('S4-16 account keys — the two constants must not collapse', () => {
  it('substitutes the user id into the risk policy account', () => {
    // The whole of `S4-16`: `resolveRiskPolicy` / the breaker already take
    // `account: string`, so per-user risk is a value substitution.
    expect(riskPolicyAccountForUser(USER)).toBe(USER);
    expect(riskPolicyAccountForUser(USER)).not.toBe(RECONCILIATION_ACCOUNT);
  });

  it('keeps the reconciliation account as operator even with a user id in hand', () => {
    // The §1 exception. `copy_executions.target_account` holds a wallet address, so
    // filtering it by a user id claims zero rows and the escalation stream silently
    // fragments into N while scoping nothing.
    expect(reconciliationAccountForUser(USER)).toBe(RECONCILIATION_ACCOUNT);
    expect(reconciliationAccountForUser(USER)).toBe('operator');
    expect(reconciliationAccountForUser(null)).toBe('operator');
  });

  it('keeps the two keys distinct for the same user', () => {
    // The find-and-replace guard. Collapsing the two constants into one makes this
    // equality hold and the test fail.
    expect(riskPolicyAccountForUser(USER)).not.toBe(reconciliationAccountForUser(USER));
  });

  it('falls back to the operator account only for the pre-tenancy path', () => {
    expect(riskPolicyAccountForUser(null)).toBe(RISK_POLICY_ACCOUNT);
    expect(RISK_POLICY_ACCOUNT).toBe('operator');
  });

  it('keys the breaker on the same account as the risk policy', () => {
    // Two keys for one user would give them a policy under one name and a breaker
    // under another, so a tripped breaker would not stop the trades it was sized for.
    expect(circuitBreakerAccountForUser(USER)).toBe(riskPolicyAccountForUser(USER));
  });

  it('refuses an empty user id rather than silently keying on the operator', () => {
    expect(() => riskPolicyAccountForUser('')).toThrow(/non-empty user id/);
    expect(() => riskPolicyAccountForUser('   ')).toThrow(/non-empty user id/);
  });

  it('reports the risk account on the sizing outcome', () => {
    expect(sized(sizePerUserBuy(baseInput())).riskAccount).toBe(USER);
    expect(sized(sizePerUserBuy(baseInput({ userId: null }))).riskAccount).toBe('operator');
  });
});

describe('S4-17 platform clamp — narrowing only', () => {
  it('never re-widens a platform paper verdict to live', () => {
    // The mutation this file exists to catch. The user's stored preference is
    // `live`; the platform said `paper` because a certification lapsed. Returning
    // the user's preference opens a real position on an uncertified chain.
    expect(narrowExecutionMode('paper', 'live')).toBe('paper');
  });

  it('lets the user narrow live to paper', () => {
    expect(narrowExecutionMode('live', 'paper')).toBe('paper');
  });

  it('treats off on either side as off', () => {
    expect(narrowExecutionMode('off', 'live')).toBe('off');
    expect(narrowExecutionMode('live', 'off')).toBe('off');
    expect(narrowExecutionMode('paper', 'off')).toBe('off');
    expect(narrowExecutionMode('off', 'off')).toBe('off');
  });

  it('preserves live+shadow under a live request', () => {
    // Shadow is an operator diagnostic riding a live execution. Collapsing it to
    // `live` would switch the diagnostic off without anyone asking.
    expect(narrowExecutionMode('live+shadow', 'live')).toBe('live+shadow');
    expect(narrowExecutionMode('live+shadow', 'paper')).toBe('paper');
  });

  it('never returns a mode wider than the platform verdict, over the whole matrix', () => {
    const rank = { off: 0, paper: 1, live: 2, 'live+shadow': 2 } as const;
    const platformModes = ['off', 'paper', 'live', 'live+shadow'] as const;
    const userModes = ['off', 'paper', 'live'] as const;
    for (const platform of platformModes) {
      for (const user of userModes) {
        const result = narrowExecutionMode(platform, user);
        expect(rank[result]).toBeLessThanOrEqual(rank[platform]);
        expect(rank[result]).toBeLessThanOrEqual(rank[user]);
      }
    }
  });

  it('records a platform downgrade instead of excluding the user', () => {
    // `S4-13`'s rule, restated at this layer: a failing platform gate downgrades,
    // it never makes a user ineligible. Treating it as an exclusion stops paper
    // copying for everyone the moment a certification lapses.
    const outcome = sized(sizePerUserBuy(baseInput({
      platform: {
        effectiveMode: 'paper',
        certified: false,
        reason: 'Chain solana has no active reviewed certification record'
      }
    })));

    expect(outcome.mode.effective).toBe('paper');
    expect(outcome.mode.downgraded).toBe(true);
    expect(outcome.mode.clamp).toBe('platform-clamped-live-to-paper');
    expect(outcome.mode.certified).toBe(false);
    expect(outcome.sizeUnits).toBeGreaterThan(0);
  });

  it('makes the platform clamp visible with the platform\'s own reason', () => {
    // "Why did I get paper?" has to be answerable from the output alone.
    const outcome = sized(sizePerUserBuy(baseInput({
      platform: {
        effectiveMode: 'paper',
        certified: false,
        reason: 'Chain solana is not enabled in LIVE_ENABLED_CHAINS'
      }
    })));
    expect(outcome.mode.platformReason).toBe('Chain solana is not enabled in LIVE_ENABLED_CHAINS');
    expect(outcome.mode.platformEffective).toBe('paper');
    expect(outcome.mode.userRequested).toBe('live');
  });

  it('sizes a downgraded user off the paper bankroll, not their live funds', () => {
    // The clamp applies on top of sizing, not only to the mode label. A user sized
    // off live funds but executed in paper would record a position nothing backs.
    const outcome = sized(sizePerUserBuy(baseInput({
      platform: { effectiveMode: 'paper', certified: false }
    })));
    expect(outcome.basis).toBe('paper-bankroll');
    expect(outcome.basisUnits).toBe(100);
  });

  it('does not call a user-chosen paper mode a downgrade', () => {
    const outcome = sized(sizePerUserBuy(baseInput({ userRequestedMode: 'paper' })));
    expect(outcome.mode.effective).toBe('paper');
    expect(outcome.mode.downgraded).toBe(false);
    expect(outcome.mode.clamp).toBe('user-requested-paper');
  });

  it('refuses with platform-chain-mode-off when the global kill switch is set', () => {
    const outcome = refused(sizePerUserBuy(baseInput({
      platform: { effectiveMode: 'off', certified: true, reason: 'Global kill switch active (*)' }
    })));
    expect(outcome.code).toBe('platform-chain-mode-off');
    expect(outcome.reason).toBe('Global kill switch active (*)');
  });

  it('distinguishes the user\'s own off from the platform\'s', () => {
    // Same outcome, different cause, different fix. One code for both sends an
    // operator to check a platform gate that is fine.
    expect(refused(sizePerUserBuy(baseInput({ userRequestedMode: 'off' }))).code)
      .toBe('user-chain-mode-off');
    expect(refused(sizePerUserBuy(baseInput({
      settings: { maxPositionPct: 10, maxDailyExposurePct: 25, killed: true }
    }))).code).toBe('user-killed');
  });

  it('applies the kill switch ahead of a live platform verdict', () => {
    const decision = resolvePerUserMode({
      userRequested: 'live',
      platform: { effectiveMode: 'live', certified: true },
      killed: true
    });
    expect(decision.userRequested).toBe('off');
    expect(decision.effective).toBe('off');
  });
});

describe('S4-15 sizing — the user\'s own balance and their own percentages', () => {
  it('sizes as a percentage of that user\'s balance', () => {
    // 10 units at 10% is 1.0. Nothing else binds at this fixture.
    const outcome = sized(sizePerUserBuy(baseInput()));
    expect(outcome.requestedUnits).toBeCloseTo(1, 9);
    expect(outcome.sizeUnits).toBeCloseTo(1, 9);
    expect(outcome.basis).toBe('live-balance');
    expect(outcome.clamps).toEqual([]);
  });

  it('scales with the user\'s balance, holding the percentage fixed', () => {
    // Two users, same agreed percentage, different deposits: exposure is
    // proportional to what each deposited.
    const small = sized(sizePerUserBuy(baseInput({ balance: { liveUnits: 2, paperUnits: 100 } })));
    const large = sized(sizePerUserBuy(baseInput({ balance: { liveUnits: 20, paperUnits: 100 } })));
    expect(small.sizeUnits).toBeCloseTo(0.2, 9);
    expect(large.sizeUnits).toBeCloseTo(2, 9);
  });

  it('scales with the user\'s agreed percentage, holding the balance fixed', () => {
    const cautious = sized(sizePerUserBuy(baseInput({
      settings: { maxPositionPct: 1, maxDailyExposurePct: 25, killed: false }
    })));
    const bold = sized(sizePerUserBuy(baseInput({
      settings: { maxPositionPct: 20, maxDailyExposurePct: 25, killed: false }
    })));
    expect(cautious.sizeUnits).toBeCloseTo(0.1, 9);
    expect(bold.sizeUnits).toBeCloseTo(2, 9);
  });

  it('reuses the existing sizing formula rather than a second one', () => {
    // Pins the reuse required by `S4-15`. If this module ever grows its own
    // arithmetic, this diverges — which is the point: two formulas that agree today
    // will not agree after the next edit to one of them.
    const input = baseInput();
    const outcome = sized(sizePerUserBuy(input));
    expect(outcome.sizeUnits).toBe(calculateBalanceAwareSize({
      balance: 10,
      base: input.baseUnits,
      maximum: input.platformMaximumUnits,
      riskPct: input.settings.maxPositionPct,
      tierMultiplier: input.tierMultiplier,
      scoreMultiplier: input.scoreMultiplier,
      precision: input.precision,
      dynamic: true
    }));
  });

  it('the explanatory clamp walk lands on exactly the returned size', () => {
    // The clamps list is derived, not authoritative — `capPositionToAvailableBalance`
    // decides the number. A drift between them would make the explanation lie about a
    // size that is nonetheless correct, which is the worst of both.
    //
    // Stated against `boundedUnits` rather than `sizeUnits` because
    // `floorToPrecision` divides after flooring and can land one ulp *above* its
    // input: at precision 6, 0.06999999999999999 comes back as 0.07. Comparing the
    // walk to `sizeUnits` by float identity therefore fails on a correct result,
    // which is how this was found.
    for (const platformMaximumUnits of [0.03, 0.4, 5, 500]) {
      for (const liveUnits of [0.0000004, 0.7, 10, 4000]) {
        const outcome = sizePerUserBuy(baseInput({
          platformMaximumUnits,
          balance: { liveUnits, paperUnits: 100 }
        }));
        if (outcome.kind !== 'size') continue;
        expect(outcome.sizeUnits).toBe(floorToPrecision(outcome.boundedUnits, 6));
        const lastBound = [...outcome.clamps]
          .reverse()
          .find((clamp) => clamp.code !== 'precision-floor'
            && clamp.code !== 'master-conviction-fraction');
        expect(lastBound ? lastBound.afterUnits : outcome.requestedUnits)
          .toBe(outcome.boundedUnits);
      }
    }
  });

  it('applies the tier and score multipliers', () => {
    const half = sized(sizePerUserBuy(baseInput({ tierMultiplier: 0.5 })));
    expect(half.sizeUnits).toBeCloseTo(0.5, 9);
    const quarter = sized(sizePerUserBuy(baseInput({
      tierMultiplier: 0.5,
      scoreMultiplier: 0.5
    })));
    expect(quarter.sizeUnits).toBeCloseTo(0.25, 9);
  });

  it('ignores the percentage under static sizing, as the existing helper does', () => {
    const outcome = sized(sizePerUserBuy(baseInput({ dynamic: false })));
    expect(outcome.sizeUnits).toBeCloseTo(0.5, 9);
    expect(outcome.clamps).toEqual([]);
  });
});

describe('unknown is never a number', () => {
  it('refuses an unknown live balance rather than sizing it to zero', () => {
    // The mutation guard. Coalescing `null` to 0 makes this return
    // `size-rounds-to-zero`, which sends an operator to look at funding instead of
    // at the balance poller.
    const outcome = refused(sizePerUserBuy(baseInput({
      balance: { liveUnits: null, paperUnits: 100 }
    })));
    expect(outcome.code).toBe('balance-unknown');
    expect(outcome.reason).toMatch(/unknown balance/);
  });

  it('refuses an unknown paper bankroll for a downgraded user', () => {
    // The basis follows the clamped mode, so the unknown that matters is the paper
    // one even though the user asked for live and has live funds.
    const outcome = refused(sizePerUserBuy(baseInput({
      platform: { effectiveMode: 'paper', certified: false },
      balance: { liveUnits: 10, paperUnits: null }
    })));
    expect(outcome.code).toBe('balance-unknown');
    expect(outcome.reason).toMatch(/paper-bankroll/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'treats %p as an unknown balance, not a number',
    (liveUnits) => {
      expect(refused(sizePerUserBuy(baseInput({
        balance: { liveUnits, paperUnits: 100 }
      }))).code).toBe('balance-unknown');
    }
  );

  it('reports a genuine zero balance as a zero, not as unknown', () => {
    // The rule holds in both directions. A zero balance is a fact about funding; an
    // unknown one is a fact about our data.
    const outcome = refused(sizePerUserBuy(baseInput({
      balance: { liveUnits: 0, paperUnits: 100 }
    })));
    expect(outcome.code).toBe('size-rounds-to-zero');
  });

  it('does not report a zero balance as an exhausted daily allowance', () => {
    // A zero balance yields a zero allowance. Calling that `daily-exposure-cap-reached`
    // would tell an operator the user spent an allowance they never had.
    const outcome = refused(sizePerUserBuy(baseInput({
      balance: { liveUnits: 0, paperUnits: 100 },
      dailyExposureUsdUsed: 0
    })));
    expect(outcome.code).not.toBe('daily-exposure-cap-reached');
  });

  it('refuses an unknown USD rate rather than assuming one', () => {
    // `index.ts` substitutes `?? 150` for SOL and `?? 3000` for ETH when a price
    // fetch fails. A fabricated rate silently mis-scales the exposure cap.
    expect(refused(sizePerUserBuy(baseInput({ usdPerUnit: null }))).code)
      .toBe('usd-rate-unknown');
    expect(refused(sizePerUserBuy(baseInput({ usdPerUnit: 0 }))).code)
      .toBe('usd-rate-unknown');
    expect(refused(sizePerUserBuy(baseInput({ usdPerUnit: Number.NaN }))).code)
      .toBe('usd-rate-unknown');
  });

  it('refuses an unknown committed exposure rather than treating it as nothing spent', () => {
    expect(refused(sizePerUserBuy(baseInput({ dailyExposureUsdUsed: null }))).code)
      .toBe('daily-exposure-unknown');
    expect(refused(sizePerUserBuy(baseInput({ dailyExposureUsdUsed: Number.NaN }))).code)
      .toBe('daily-exposure-unknown');
  });

  it('propagates an unknown balance out of the exposure cap helper', () => {
    expect(userDailyExposureCapUsd({ maxDailyExposurePct: 25 }, null)).toBeNull();
    expect(userDailyExposureCapUsd({ maxDailyExposurePct: 25 }, Number.NaN)).toBeNull();
    expect(userDailyExposureCapUsd({ maxDailyExposurePct: 25 }, 1_000)).toBe(250);
  });
});

describe('S4-16 per-user exposure cap', () => {
  it('derives the cap from this user\'s own percentage and balance', () => {
    const outcome = sized(sizePerUserBuy(baseInput()));
    // 10 units at $100 is $1,000; 25% of that is $250.
    expect(outcome.dailyExposureCapUsd).toBe(250);
    expect(outcome.dailyExposureRemainingUsd).toBe(250);
  });

  it('charges only this user\'s own committed exposure against it', () => {
    const outcome = sized(sizePerUserBuy(baseInput({ dailyExposureUsdUsed: 200 })));
    expect(outcome.dailyExposureRemainingUsd).toBe(50);
    // $50 of headroom at $100/unit is 0.5 units, which now binds below the 1.0 request.
    expect(outcome.sizeUnits).toBeCloseTo(0.5, 9);
    expect(outcome.clamps).toEqual([
      { code: 'daily-exposure-remaining', beforeUnits: 1, afterUnits: 0.5 }
    ]);
  });

  it('refuses once the user has spent their own allowance', () => {
    expect(refused(sizePerUserBuy(baseInput({ dailyExposureUsdUsed: 250 }))).code)
      .toBe('daily-exposure-cap-reached');
    expect(refused(sizePerUserBuy(baseInput({ dailyExposureUsdUsed: 400 }))).code)
      .toBe('daily-exposure-cap-reached');
  });

  it('gives two users with different balances different allowances', () => {
    // The property the process-wide `DAILY_EXPOSURE_CAP_USD` cannot express: one
    // funded user must not consume every other user's headroom.
    const poor = sized(sizePerUserBuy(baseInput({ balance: { liveUnits: 1, paperUnits: 100 } })));
    const rich = sized(sizePerUserBuy(baseInput({ balance: { liveUnits: 50, paperUnits: 100 } })));
    expect(poor.dailyExposureCapUsd).toBe(25);
    expect(rich.dailyExposureCapUsd).toBe(1_250);
  });

  it('rejects an incoherent exposure percentage instead of sizing with it', () => {
    expect(() => userDailyExposureCapUsd({ maxDailyExposurePct: 0 }, 1_000)).toThrow(/percentage/);
    expect(() => userDailyExposureCapUsd({ maxDailyExposurePct: 101 }, 1_000)).toThrow(/percentage/);
  });
});

describe('clamps are visible, not silent', () => {
  it('names the platform per-order ceiling when it binds', () => {
    const outcome = sized(sizePerUserBuy(baseInput({ platformMaximumUnits: 0.25 })));
    expect(outcome.sizeUnits).toBe(0.25);
    expect(outcome.clamps).toEqual([
      { code: 'platform-maximum-notional', beforeUnits: 1, afterUnits: 0.25 }
    ]);
  });

  it('names the balance when the request exceeds it', () => {
    // Only reachable with a multiplier above 1 or a percentage of 100; the point is
    // that the bound is reported rather than absorbed.
    const outcome = sized(sizePerUserBuy(baseInput({
      settings: { maxPositionPct: 100, maxDailyExposurePct: 100, killed: false },
      scoreMultiplier: 2,
      platformMaximumUnits: 50
    })));
    expect(outcome.clamps[0]).toEqual({
      code: 'available-balance',
      beforeUnits: 20,
      afterUnits: 10
    });
  });

  it('names precision flooring when it removes a remainder', () => {
    const outcome = sized(sizePerUserBuy(baseInput({
      balance: { liveUnits: 1.23456789, paperUnits: 100 },
      precision: 2
    })));
    const floorClamp = outcome.clamps.find((clamp) => clamp.code === 'precision-floor');
    expect(floorClamp).toBeDefined();
    expect(outcome.sizeUnits).toBe(0.12);
  });

  it('lists every clamp in the order applied when several bind', () => {
    // The answer to "why did I get 0.05 and not 0.2" is this list, read top to
    // bottom.
    const outcome = sized(sizePerUserBuy(baseInput({
      settings: { maxPositionPct: 100, maxDailyExposurePct: 100, killed: false },
      scoreMultiplier: 2,
      platformMaximumUnits: 4,
      dailyExposureUsdUsed: 800,
      precision: 1
    })));
    expect(outcome.clamps.map((clamp) => clamp.code)).toEqual([
      'available-balance',
      'platform-maximum-notional',
      'daily-exposure-remaining'
    ]);
    // $1,000 cap less $800 spent is $200, i.e. 2 units at $100.
    expect(outcome.sizeUnits).toBe(2);
  });

  it('reports no clamps when nothing reduced the size', () => {
    expect(sized(sizePerUserBuy(baseInput())).clamps).toEqual([]);
  });
});

describe('ADR-0005 §3.1 conviction sizing', () => {
  it('transmits the master\'s conviction when it is below the user\'s ceiling', () => {
    // A 2% punt and a 40% core position must not allocate identically.
    const punt = sized(sizePerUserBuy(baseInput({
      conviction: {
        masterFraction: 0.02,
        portfolioCoverage: 0.9,
        coverageThreshold: 0.8,
        scale: 1
      }
    })));
    const core = sized(sizePerUserBuy(baseInput({
      conviction: {
        masterFraction: 0.4,
        portfolioCoverage: 0.9,
        coverageThreshold: 0.8,
        scale: 1
      }
    })));
    expect(punt.appliedRiskPct).toBe(2);
    expect(punt.sizeUnits).toBeCloseTo(0.2, 9);
    // The user's own 10% ceiling still binds above their conviction.
    expect(core.appliedRiskPct).toBe(10);
    expect(core.sizeUnits).toBeCloseTo(1, 9);
    expect(punt.sizeUnits).toBeLessThan(core.sizeUnits);
  });

  it('keeps the user\'s ceiling binding above the master\'s fraction', () => {
    const resolution = resolveConvictionRiskPct(10, {
      masterFraction: 0.9,
      portfolioCoverage: 1,
      coverageThreshold: 0.8,
      scale: 1
    });
    expect(resolution.riskPct).toBe(10);
    expect(resolution.convictionPct).toBe(90);
    expect(resolution.sizedWithoutConviction).toBe(false);
  });

  it('names the conviction clamp when it is the binding term', () => {
    const outcome = sized(sizePerUserBuy(baseInput({
      conviction: {
        masterFraction: 0.02,
        portfolioCoverage: 0.9,
        coverageThreshold: 0.8,
        scale: 1
      }
    })));
    expect(outcome.clamps[0]?.code).toBe('master-conviction-fraction');
    expect(outcome.clamps[0]?.beforeUnits).toBeCloseTo(1, 9);
    expect(outcome.clamps[0]?.afterUnits).toBeCloseTo(0.2, 9);
  });

  it('falls back to flat sizing and marks the trade when coverage is short', () => {
    // Presenting a fraction of a portfolio we cannot see would be a fabricated input
    // to a real position size.
    const outcome = sized(sizePerUserBuy(baseInput({
      conviction: {
        masterFraction: 0.02,
        portfolioCoverage: 0.3,
        coverageThreshold: 0.8,
        scale: 1
      }
    })));
    expect(outcome.sizedWithoutConviction).toBe(true);
    expect(outcome.conviction.fallbackReason).toBe('portfolio-coverage-below-threshold');
    expect(outcome.appliedRiskPct).toBe(10);
    expect(outcome.sizeUnits).toBeCloseTo(1, 9);
  });

  it.each([
    ['master-fraction-unknown', { masterFraction: null, portfolioCoverage: 0.9 }],
    ['portfolio-coverage-unknown', { masterFraction: 0.02, portfolioCoverage: null }]
  ] as const)('falls back with %s', (reason, partial) => {
    const resolution = resolveConvictionRiskPct(10, {
      ...partial,
      coverageThreshold: 0.8,
      scale: 1
    });
    expect(resolution.sizedWithoutConviction).toBe(true);
    expect(resolution.fallbackReason).toBe(reason);
    expect(resolution.riskPct).toBe(10);
  });

  it('falls back on a NaN coverage rather than multiplying it through', () => {
    // A NaN that reached the multiplication would make riskPct NaN and
    // `requestedBalanceAwareSize` would throw, where a fallback is the right answer.
    const resolution = resolveConvictionRiskPct(10, {
      masterFraction: 0.02,
      portfolioCoverage: Number.NaN,
      coverageThreshold: 0.8,
      scale: 1
    });
    expect(resolution.sizedWithoutConviction).toBe(true);
    expect(resolution.fallbackReason).toBe('portfolio-coverage-unknown');
  });

  it('marks a trade sized without conviction when no conviction was supplied', () => {
    const outcome = sized(sizePerUserBuy(baseInput({ conviction: null })));
    expect(outcome.sizedWithoutConviction).toBe(true);
    expect(outcome.conviction.fallbackReason).toBe('master-fraction-unknown');
  });

  it('applies ADR-0005\'s scale to the master fraction', () => {
    expect(resolveConvictionRiskPct(50, {
      masterFraction: 0.1,
      portfolioCoverage: 1,
      coverageThreshold: 0.8,
      scale: 2
    }).riskPct).toBe(20);
  });

  it('caps the conviction percentage at 100 so sizing cannot be handed 200', () => {
    expect(resolveConvictionRiskPct(100, {
      masterFraction: 1,
      portfolioCoverage: 1,
      coverageThreshold: 0.8,
      scale: 5
    }).convictionPct).toBe(100);
  });

  it('rejects an out-of-range fraction as unknown rather than clamping it', () => {
    // A fraction above 1 is not a portfolio share; guessing which number was meant
    // would size a real position on a misread input.
    expect(resolveConvictionRiskPct(10, {
      masterFraction: 1.5,
      portfolioCoverage: 1,
      coverageThreshold: 0.8,
      scale: 1
    }).fallbackReason).toBe('master-fraction-unknown');
  });

  it('rejects an incoherent user percentage loudly', () => {
    expect(() => resolveConvictionRiskPct(0, null)).toThrow(/percentage/);
    expect(() => resolveConvictionRiskPct(101, null)).toThrow(/percentage/);
    expect(() => resolveConvictionRiskPct(Number.NaN, null)).toThrow(/percentage/);
  });

  it('rejects a negative scale rather than sizing to zero', () => {
    expect(() => resolveConvictionRiskPct(10, {
      masterFraction: 0.1,
      portfolioCoverage: 1,
      coverageThreshold: 0.8,
      scale: -1
    })).toThrow(/scale/);
  });
});

describe('the cap helper this module reuses', () => {
  it('agrees with capPositionToAvailableBalance on the final number', () => {
    const outcome = sized(sizePerUserBuy(baseInput({ dailyExposureUsdUsed: 200 })));
    expect(outcome.sizeUnits).toBe(capPositionToAvailableBalance({
      requested: outcome.requestedUnits,
      available: outcome.basisUnits,
      // $50 of headroom at $100/unit.
      maximum: Math.min(5, 0.5),
      precision: 6
    }));
  });
});
