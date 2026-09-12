import { describe, expect, it } from 'vitest';
import {
  assessPusdWithdrawalPath,
  isOnlyUnpausedRevert,
  pusdWithdrawalsHealthy,
  ONLY_UNPAUSED_SELECTOR,
  PUSD_DECIMALS,
  PUSD_LARGE_WITHDRAWAL_USD,
  PUSD_SWAP_MAX_OUTPUT_DIFFERENCE_BPS,
  type PusdMonitorInput
} from './pusd-liquidity.js';

/** Everything checked and passing: 195,560 native USDC, as measured on-chain. */
const healthy: PusdMonitorInput = {
  depth: { nativeUsdcAvailable: 195_560 },
  aggregateFloatUsd: 20_000,
  collateralPaused: false,
  simulatedUnwrap: 'ok',
  swapOutputDifferenceBps: 2
};

const of = (over: Partial<PusdMonitorInput> = {}): PusdMonitorInput => ({ ...healthy, ...over });

describe('assessPusdWithdrawalPath (S4-M42)', () => {
  it('reports healthy only when nothing failed AND nothing was unchecked', () => {
    const verdict = assessPusdWithdrawalPath(healthy);
    expect(verdict.outcome).toBe('healthy');
    expect(verdict.unassessed).toEqual([]);
    expect(verdict.failures).toEqual([]);
    expect(pusdWithdrawalsHealthy(verdict)).toBe(true);
  });

  describe('the native side is the exhaustible one', () => {
    it('alarms when native-USDC depth falls below the floor', () => {
      // A withdrawal runs USDC.e -> native USDC, draining the native leg.
      const verdict = assessPusdWithdrawalPath(of({ depth: { nativeUsdcAvailable: 10_000 } }));
      expect(verdict.outcome).toBe('impaired');
      expect(verdict.failures).toContain('pusd-pool-depth-below-floor');
    });

    it('defaults the floor to the venue own large-withdrawal guidance', () => {
      // Polymarket advises splitting withdrawals over $50,000, so below that a
      // single ordinary large withdrawal cannot clear.
      expect(PUSD_LARGE_WITHDRAWAL_USD).toBe(50_000);
      expect(assessPusdWithdrawalPath(of({ depth: { nativeUsdcAvailable: 49_999 } })).outcome)
        .toBe('impaired');
      expect(assessPusdWithdrawalPath(of({ depth: { nativeUsdcAvailable: 50_000 } })).outcome)
        .toBe('healthy');
    });

    it('accepts an explicit floor override', () => {
      expect(assessPusdWithdrawalPath(of({
        depth: { nativeUsdcAvailable: 30_000 },
        depthFloorUsd: 25_000
      })).outcome).toBe('healthy');
    });
  });

  describe('the float-relative alarm — the one that matters at our scale', () => {
    it('alarms when depth is above the floor but below our aggregate float', () => {
      // ~195k of measured depth against a ~488M pUSD supply means the POOL, not
      // the supply, bounds our float. This fires at the point where our users
      // collectively cannot exit even though any single withdrawal would clear.
      const verdict = assessPusdWithdrawalPath(of({
        depth: { nativeUsdcAvailable: 195_560 },
        aggregateFloatUsd: 300_000
      }));
      expect(verdict.outcome).toBe('impaired');
      expect(verdict.failures).toContain('pusd-pool-depth-below-float');
      // Deliberately NOT a floor breach: the two alarms are independent.
      expect(verdict.failures).not.toContain('pusd-pool-depth-below-floor');
    });

    it('does not alarm when depth covers the float exactly', () => {
      expect(assessPusdWithdrawalPath(of({
        depth: { nativeUsdcAvailable: 100_000 },
        aggregateFloatUsd: 100_000
      })).outcome).toBe('healthy');
    });

    it('reports both alarms when depth is below the floor AND the float', () => {
      const verdict = assessPusdWithdrawalPath(of({
        depth: { nativeUsdcAvailable: 1_000 },
        aggregateFloatUsd: 500_000
      }));
      expect(verdict.failures).toEqual([
        'pusd-pool-depth-below-floor',
        'pusd-pool-depth-below-float'
      ]);
    });
  });

  describe('pause — the most dangerous shape', () => {
    it('alarms on a paused offramp, and outranks thin depth', () => {
      // A pause blocks EVERY withdrawal regardless of liquidity, while thin depth
      // only blocks large ones — so it leads the reason code.
      const verdict = assessPusdWithdrawalPath(of({
        collateralPaused: true,
        depth: { nativeUsdcAvailable: 1 }
      }));
      expect(verdict.reasonCode).toBe('pusd-collateral-paused');
      expect(verdict.failures).toContain('pusd-pool-depth-below-floor');
    });

    it('treats an unreadable pause state as unassessed, never as unpaused', () => {
      // The balance looks fine either way, which is what makes guessing here
      // dangerous: collateral can be unwithdrawable while the token reports full.
      const verdict = assessPusdWithdrawalPath(of({ collateralPaused: null }));
      expect(verdict.outcome).toBe('healthy-partial');
      expect(verdict.unassessed).toContain('pause-state-unknown');
      expect(pusdWithdrawalsHealthy(verdict)).toBe(false);
    });
  });

  describe('redeemability', () => {
    it('alarms when a simulated unwrap reverts', () => {
      expect(assessPusdWithdrawalPath(of({ simulatedUnwrap: 'reverted' })).failures)
        .toContain('pusd-unwrap-reverts');
    });

    it('treats an unattempted simulation as unassessed, not as success', () => {
      const verdict = assessPusdWithdrawalPath(of({ simulatedUnwrap: null }));
      expect(verdict.outcome).toBe('healthy-partial');
      expect(verdict.unassessed).toContain('redeemability-untested');
    });
  });

  describe('the 10bp swap bound — adopted from the venue, not invented', () => {
    it('uses the documented figure', () => {
      expect(PUSD_SWAP_MAX_OUTPUT_DIFFERENCE_BPS).toBe(10);
    });

    it('alarms above the bound and passes at it', () => {
      expect(assessPusdWithdrawalPath(of({ swapOutputDifferenceBps: 11 })).failures)
        .toContain('pusd-swap-output-outside-bound');
      expect(assessPusdWithdrawalPath(of({ swapOutputDifferenceBps: 10 })).outcome)
        .toBe('healthy');
    });

    it('treats a missing quote as unassessed', () => {
      expect(assessPusdWithdrawalPath(of({ swapOutputDifferenceBps: null })).unassessed)
        .toContain('swap-output-unknown');
    });
  });

  describe('unknown is never a pass (S4-M41 discipline)', () => {
    it('reports unknown depth as its own code rather than passing', () => {
      const verdict = assessPusdWithdrawalPath(of({ depth: { nativeUsdcAvailable: null } }));
      expect(verdict.outcome).toBe('healthy-partial');
      expect(verdict.unassessed).toContain('pool-depth-unknown');
      expect(verdict.failures).toEqual([]);
    });

    it('does not claim a floor breach when depth is merely unknown', () => {
      // Unknown and zero demand opposite responses: one is "go look at the feed",
      // the other is "stop withdrawing".
      expect(assessPusdWithdrawalPath(of({ depth: { nativeUsdcAvailable: null } })).failures)
        .not.toContain('pusd-pool-depth-below-floor');
    });

    it('reports a genuine zero depth as a floor breach, not as unknown', () => {
      // The other direction of the same rule.
      const verdict = assessPusdWithdrawalPath(of({ depth: { nativeUsdcAvailable: 0 } }));
      expect(verdict.failures).toContain('pusd-pool-depth-below-floor');
      expect(verdict.unassessed).not.toContain('pool-depth-unknown');
    });

    it('treats NaN and Infinity as unknown rather than as numbers', () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(assessPusdWithdrawalPath(of({ depth: { nativeUsdcAvailable: bad } })).unassessed)
          .toContain('pool-depth-unknown');
      }
    });

    it('disables the float alarm with its own code when the float is unknown', () => {
      const verdict = assessPusdWithdrawalPath(of({ aggregateFloatUsd: null }));
      expect(verdict.unassessed).toContain('float-unknown');
      expect(verdict.failures).toEqual([]);
    });

    it('keeps a failure visible even when something else was unassessable', () => {
      // An impaired verdict must not be softened to partial just because a
      // different check could not run.
      const verdict = assessPusdWithdrawalPath(of({
        collateralPaused: null,
        simulatedUnwrap: 'reverted'
      }));
      expect(verdict.outcome).toBe('impaired');
      expect(verdict.unassessed).toContain('pause-state-unknown');
    });
  });

  it('pusdWithdrawalsHealthy is the only predicate, so partial cannot be waved through', () => {
    // A caller testing `outcome !== 'impaired'` would admit healthy-partial.
    const partial = assessPusdWithdrawalPath(of({ collateralPaused: null }));
    expect(partial.outcome).not.toBe('impaired');
    expect(pusdWithdrawalsHealthy(partial)).toBe(false);
  });
});

describe('isOnlyUnpausedRevert', () => {
  it('recognises the documented pause selector', () => {
    // Verified two independent ways: viem toFunctionSelector and a raw keccak256
    // of the signature both yield 0x49b8b3ac.
    expect(ONLY_UNPAUSED_SELECTOR).toBe('0x49b8b3ac');
    expect(isOnlyUnpausedRevert('0x49b8b3ac')).toBe(true);
    expect(isOnlyUnpausedRevert('0x49B8B3AC')).toBe(true);
  });

  it('does not mistake another revert for a pause', () => {
    // A generic revert must stay generic: reporting it as a pause would send an
    // operator to check an admin setting that is fine.
    expect(isOnlyUnpausedRevert('0xdeadbeef')).toBe(false);
    expect(isOnlyUnpausedRevert('0x')).toBe(false);
    expect(isOnlyUnpausedRevert(null)).toBe(false);
    expect(isOnlyUnpausedRevert(undefined)).toBe(false);
  });
});

describe('constants', () => {
  it('pins 6 decimals, because 18 is the trap', () => {
    // S4-M41: using the ether helpers on a 6-decimal token understates it by
    // 10^12, which presents as "no funds" rather than as a scaling bug.
    expect(PUSD_DECIMALS).toBe(6);
  });
});
