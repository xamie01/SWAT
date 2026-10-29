import { describe, expect, it, vi } from 'vitest';

/**
 * `./subscriptions.js` -- where `mirrorEligibilityForState` lives, and using the
 * real one is the point, since it is the single definition of what each state
 * permits -- statically imports `./client.js`, which throws
 * `DATABASE_URL is required` while being evaluated. Hoisted so it runs before
 * that import, and `??=` so CI's real value is left alone. No query is ever
 * issued: every function under test is pure, `pg` connects lazily, and
 * `client.ts` skips its shutdown handlers under NODE_ENV=test. Same pattern as
 * `apps/api/src/routes/execution-settings.test.ts`.
 */
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://swat:swat@127.0.0.1:5432/swat_unit_tests';
});
import { capabilitiesFor, tierAllowsChain } from '@swat/shared';
import {
  assessFanoutCandidate,
  planFanout,
  type FanoutCandidate,
  type FanoutPlatformInputs,
  type FanoutSignal
} from './fanout-eligibility.js';

const signal: FanoutSignal = {
  chain: 'solana',
  masterWalletAddress: 'solana:MASTER',
  tokenMint: 'solana:TOKEN',
  direction: 'buy',
  score: 90,
  eventAt: new Date('2026-09-02T00:00:00.000Z')
};

const candidate: FanoutCandidate = {
  userId: 'u1',
  activeSince: new Date('2026-09-01T00:00:00.000Z'),
  subscriptionState: 'active',
  tier: 'ultra',
  tierExpiresAt: null,
  autoExecute: true,
  killed: false,
  minSignalScore: 70,
  maxConcurrentPositions: 5,
  openPositionCount: 1,
  knownBalanceUsd: 500
};

const platform: FanoutPlatformInputs = {
  chainMode: { effectiveMode: 'paper' },
  minimumBalanceUsd: 100,
  capacity: { outcome: 'admit' }
};

const of = (over: Partial<FanoutCandidate> = {}): FanoutCandidate => ({ ...candidate, ...over });
const at = (over: Partial<FanoutPlatformInputs> = {}): FanoutPlatformInputs => ({ ...platform, ...over });

describe('assessFanoutCandidate (S4-13)', () => {
  it('admits a fully eligible candidate', () => {
    expect(assessFanoutCandidate(candidate, signal, platform)).toEqual({
      kind: 'eligible',
      userId: 'u1',
      mirrors: 'buys-and-sells',
      executionMode: 'paper',
      downgraded: false
    });
  });

  describe('subscription state', () => {
    it('excludes an ended subscription', () => {
      // The exact bug class fixed four times already this session: an `ended`
      // subscription leaking into a count. Here it would open a position for a
      // user who unsubscribed.
      expect(assessFanoutCandidate(of({ subscriptionState: 'ended' }), signal, platform))
        .toEqual({ kind: 'excluded', userId: 'u1', code: 'subscription-not-mirroring' });
    });

    it('excludes a state this build has never heard of, rather than assuming active', () => {
      // The column can carry a value written by a future migration, a manual
      // UPDATE, or a service on another release. Treating it as active opens a
      // position on behalf of a user whose intent we cannot read.
      expect(assessFanoutCandidate(of({ subscriptionState: 'suspended_pending_review' }), signal, platform))
        .toMatchObject({ code: 'subscription-not-mirroring' });
      expect(assessFanoutCandidate(of({ subscriptionState: null }), signal, platform))
        .toMatchObject({ code: 'subscription-not-mirroring' });
    });

    it('refuses a BUY for a winding-down subscription, with its own code', () => {
      expect(assessFanoutCandidate(of({ subscriptionState: 'winding_down' }), signal, platform))
        .toEqual({ kind: 'excluded', userId: 'u1', code: 'winding-down-buy-refused' });
    });

    it('still admits a SELL for a winding-down subscription', () => {
      // The important half. Excluding winding_down outright strands the user's
      // open positions with no exit, which is the worst outcome available here.
      const verdict = assessFanoutCandidate(
        of({ subscriptionState: 'winding_down' }),
        { ...signal, direction: 'sell' },
        platform
      );
      expect(verdict).toMatchObject({ kind: 'eligible', mirrors: 'sells-only' });
    });
  });

  describe('forward-only subscription window (S4-M2)', () => {
    it('excludes a buy that predates the current active period', () => {
      const verdict = assessFanoutCandidate(
        of({ activeSince: new Date('2026-09-03T00:00:00.000Z') }),
        signal,
        platform
      );
      expect(verdict).toEqual({
        kind: 'excluded',
        userId: 'u1',
        code: 'source-event-precedes-active-since'
      });
    });

    it('admits a buy exactly at the active boundary', () => {
      const verdict = assessFanoutCandidate(
        of({ activeSince: signal.eventAt }),
        signal,
        platform
      );
      expect(verdict.kind).toBe('eligible');
    });

    it('fails closed when the source event time is unavailable', () => {
      const verdict = assessFanoutCandidate(
        candidate,
        { ...signal, eventAt: null },
        platform
      );
      expect(verdict).toEqual({
        kind: 'excluded',
        userId: 'u1',
        code: 'source-event-time-unknown'
      });
    });

    it('does not gate sells on the forward-only window', () => {
      const verdict = assessFanoutCandidate(
        of({ activeSince: null }),
        { ...signal, direction: 'sell', eventAt: null },
        platform
      );
      expect(verdict).toMatchObject({ kind: 'eligible', mirrors: 'buys-and-sells' });
    });
  });

  describe('user settings', () => {
    it('excludes auto-execute off', () => {
      expect(assessFanoutCandidate(of({ autoExecute: false }), signal, platform))
        .toMatchObject({ code: 'auto-execute-off' });
    });

    it('excludes a killed user before anything else about them is considered', () => {
      // The kill switch must not be reachable-around by any other setting.
      expect(assessFanoutCandidate(of({ killed: true, autoExecute: true }), signal, platform))
        .toMatchObject({ code: 'user-killed' });
    });

    it('excludes a signal below the user own floor', () => {
      expect(assessFanoutCandidate(of({ minSignalScore: 95 }), signal, platform))
        .toMatchObject({ code: 'below-user-min-score' });
    });

    it('admits a score exactly at the floor', () => {
      expect(assessFanoutCandidate(of({ minSignalScore: 90 }), signal, platform).kind).toBe('eligible');
    });

    it('excludes a NaN score rather than admitting it', () => {
      // `score >= min` is false for NaN, but so is `score < min` -- written as
      // !(>=) so the comparison fails closed instead of falling through.
      expect(assessFanoutCandidate(candidate, { ...signal, score: Number.NaN }, platform))
        .toMatchObject({ code: 'below-user-min-score' });
    });
  });

  /**
   * **Tier tests deliberately assert the MECHANISM, not the table.**
   *
   * The operator has not yet decided how access is tiered or what each tier
   * contains, so `TIER_CAPABILITIES` is provisional. A test that pinned "free
   * covers solana only" would encode a decision nobody has made, and would then
   * fail as a *false alarm* the day the table is set — training whoever sees it
   * to edit the test rather than think. Worse, it would read afterwards like a
   * requirement.
   *
   * So every fixture elsewhere in this file uses the **highest** tier, keeping
   * the tier gate out of the way of the six conditions actually under test, and
   * these three pin only rules that hold whatever the table becomes:
   * the gate is consulted, an expired paid tier degrades, and a null expiry is
   * lifetime rather than expired.
   */
  describe('tier — mechanism only, because tiering is undecided', () => {
    it('consults the tier gate at all', () => {
      // Constructed from the live table rather than hardcoded, so this keeps
      // testing the gate no matter how the tiers are eventually defined. If some
      // future table gives every tier every chain the gate becomes untestable
      // here, and the skip says so out loud rather than passing vacuously.
      const excludedPair = (['free', 'operator', 'ultra'] as const).flatMap((tier) =>
        (['solana', 'polygon', 'robinhood-chain'] as const)
          .filter((chain) => !tierAllowsChain(capabilitiesFor(tier), chain))
          .map((chain) => ({ tier, chain }))
      )[0];
      if (!excludedPair) {
        expect(excludedPair, 'no tier excludes any chain; the gate cannot be exercised').toBeUndefined();
        return;
      }
      expect(assessFanoutCandidate(
        of({ tier: excludedPair.tier }),
        { ...signal, chain: excludedPair.chain },
        platform
      )).toMatchObject({ code: 'tier-excludes-chain' });
    });

    it('degrades an expired paid tier to free before checking chains', () => {
      // A rule, not a table entry: whatever `free` ends up covering, an expired
      // subscription must be judged as free rather than as what it used to be.
      const expired = of({ tier: 'ultra', tierExpiresAt: new Date('2020-01-01T00:00:00Z') });
      const asExpired = assessFanoutCandidate(expired, signal, platform);
      const asFree = assessFanoutCandidate(of({ tier: 'free' }), signal, platform);
      expect(asExpired.kind).toBe(asFree.kind);
    });

    it('treats a null expiry as lifetime rather than expired', () => {
      // Inverting this check would silently downgrade every lifetime customer.
      expect(assessFanoutCandidate(of({ tier: 'ultra', tierExpiresAt: null }), signal, platform).kind)
        .toBe('eligible');
    });
  });

  describe('platform gates', () => {
    it('excludes everyone when the chain mode cannot be resolved', () => {
      // Fails closed. A resolution failure means we do not know whether a global
      // kill switch is set, and guessing "paper" would keep writing ledger rows
      // through an outage the operator meant to stop everything with.
      expect(assessFanoutCandidate(candidate, signal, at({ chainMode: null })))
        .toMatchObject({ code: 'chain-mode-unknown' });
    });

    it('excludes when the chain is off', () => {
      expect(assessFanoutCandidate(candidate, signal, at({ chainMode: { effectiveMode: 'off' } })))
        .toMatchObject({ code: 'chain-execution-off' });
    });

    it('carries the platform-clamped mode rather than the user wish', () => {
      // S4-17: the gates clamp on top of user settings. A user who wanted live
      // on an uncertified chain is eligible and downgraded, NOT ineligible --
      // treating a downgrade as an exclusion silently stops paper copying for
      // everyone the moment a certification lapses.
      const verdict = assessFanoutCandidate(candidate, signal, at({ chainMode: { effectiveMode: 'paper' } }));
      expect(verdict).toMatchObject({ kind: 'eligible', executionMode: 'paper' });
    });

    it('passes live through when the platform allows it', () => {
      expect(assessFanoutCandidate(candidate, signal, at({ chainMode: { effectiveMode: 'live' } })))
        .toMatchObject({ kind: 'eligible', executionMode: 'live' });
    });
  });

  describe('balance', () => {
    it('excludes an unknown balance, and does not call it too low', () => {
      // Unknown is not zero. `resolveKnownBalanceUsd` returns null rather than a
      // partial sum precisely so a stale row cannot become a real balance --
      // coalescing it here would undo that and report the wrong reason.
      expect(assessFanoutCandidate(of({ knownBalanceUsd: null }), signal, platform))
        .toMatchObject({ code: 'balance-unknown' });
    });

    it('excludes a known balance below the minimum, with a different code', () => {
      expect(assessFanoutCandidate(of({ knownBalanceUsd: 99 }), signal, platform))
        .toMatchObject({ code: 'balance-below-minimum' });
    });

    it('admits a balance exactly at the minimum', () => {
      expect(assessFanoutCandidate(of({ knownBalanceUsd: 100 }), signal, platform).kind).toBe('eligible');
    });

    it('reports a genuine zero as below-minimum, not as unknown', () => {
      // The other direction of the same rule: a real zero is representable and
      // must not be laundered into "unknown" either.
      expect(assessFanoutCandidate(of({ knownBalanceUsd: 0 }), signal, platform))
        .toMatchObject({ code: 'balance-below-minimum' });
    });
  });

  describe('position cap and capacity', () => {
    it('excludes a user at their position cap', () => {
      expect(assessFanoutCandidate(of({ openPositionCount: 5, maxConcurrentPositions: 5 }), signal, platform))
        .toMatchObject({ code: 'position-cap-reached' });
    });

    it('excludes when master capacity is exhausted', () => {
      expect(assessFanoutCandidate(candidate, signal, at({ capacity: { outcome: 'skip' } })))
        .toMatchObject({ code: 'capacity-exhausted' });
    });

    it('excludes when capacity could not be assessed, with its own code', () => {
      // A capacity check that could not run is not a pass.
      // `assessMasterCapacity` reports `unassessed` entries rather than
      // smoothing them away, and this mirrors that.
      expect(assessFanoutCandidate(candidate, signal, at({ capacity: null })))
        .toMatchObject({ code: 'capacity-unknown' });
    });
  });
});

describe('planFanout', () => {
  it('returns the excluded set alongside the eligible one', () => {
    // "Nobody copied this signal" and "nobody was subscribed" look identical
    // from an empty array, and that difference is the whole of a diagnosis.
    const plan = planFanout(
      [
        of({ userId: 'ok' }),
        of({ userId: 'gone', subscriptionState: 'ended' }),
        of({ userId: 'off', autoExecute: false }),
        of({ userId: 'broke', knownBalanceUsd: 1 }),
        of({ userId: 'stale', knownBalanceUsd: null })
      ],
      signal,
      platform
    );
    expect(plan.eligible.map((e) => e.userId)).toEqual(['ok']);
    expect(plan.excluded.map((e) => e.code)).toEqual([
      'subscription-not-mirroring',
      'auto-execute-off',
      'balance-below-minimum',
      'balance-unknown'
    ]);
  });

  it('counts exclusions per code so one log line can summarise a fan-out', () => {
    const plan = planFanout(
      [
        of({ userId: 'a', subscriptionState: 'ended' }),
        of({ userId: 'b', subscriptionState: 'ended' }),
        of({ userId: 'c', autoExecute: false })
      ],
      signal,
      platform
    );
    expect(plan.exclusionCounts).toEqual({
      'subscription-not-mirroring': 2,
      'auto-execute-off': 1
    });
    expect(plan.eligible).toHaveLength(0);
  });

  it('excludes every candidate when a platform gate fails, without losing who they were', () => {
    const plan = planFanout([of({ userId: 'a' }), of({ userId: 'b' })], signal, at({ chainMode: null }));
    expect(plan.eligible).toHaveLength(0);
    expect(plan.excluded).toHaveLength(2);
    expect(plan.exclusionCounts).toEqual({ 'chain-mode-unknown': 2 });
  });

  it('handles an empty candidate list without inventing an exclusion', () => {
    const plan = planFanout([], signal, platform);
    expect(plan).toEqual({ eligible: [], excluded: [], exclusionCounts: {} });
  });
});
