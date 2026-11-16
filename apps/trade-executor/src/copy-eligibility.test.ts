import { describe, expect, it, vi } from 'vitest';

// The module imports CopyEligibilityFacts from @swat/db as a type only, but the
// @swat/db barrel builds the pg pool at import time. Nothing here connects —
// both DB calls are injected.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://copy-eligibility-unit-test/unused';
});

import type { CopyEligibilityFacts } from '@swat/db';
import type { ExecutionPolicyInput } from './policy.js';
import {
  COPY_ELIGIBILITY_ACCOUNT,
  enforceCopyEligibility,
  type CopyEligibilityDependencies,
  type CopyEligibilityThresholds
} from './copy-eligibility.js';

const NOW = new Date('2026-08-01T12:00:00.000Z');

const THRESHOLDS: CopyEligibilityThresholds = {
  maxEventAgeMs: 10 * 60_000,
  maxClockSkewMs: 30_000,
  minimumSourceActivityUsd: 500,
  minimumSourceTradeCount: 3,
  activityLookbackMs: 30 * 24 * 60 * 60_000
};

function facts(overrides: Partial<CopyEligibilityFacts> = {}): CopyEligibilityFacts {
  return {
    signalId: 'signal-1',
    signalStatus: 'eligible',
    chain: 'solana',
    walletAddress: 'solana:WALLET',
    walletKnown: true,
    walletStatus: 'active',
    walletTradeCount: 40,
    clusterSelected: true,
    sourceActivityUsd: 5_000,
    eventAt: new Date('2026-08-01T11:59:00.000Z'),
    ...overrides
  };
}

function deps(
  overrides: Partial<CopyEligibilityDependencies> = {}
): CopyEligibilityDependencies {
  return {
    loadFacts: vi.fn(async () => facts()),
    recordRejection: vi.fn(async () => undefined),
    thresholds: THRESHOLDS,
    now: () => NOW,
    ...overrides
  };
}

const signal = { account: COPY_ELIGIBILITY_ACCOUNT, signalId: 'signal-1', chain: 'solana' as const };

describe('enforceCopyEligibility', () => {
  it('allows a selected, active source wallet', async () => {
    const recordRejection = vi.fn(async () => undefined);
    const decision = await enforceCopyEligibility(signal, deps({ recordRejection }));

    expect(decision.allowed).toBe(true);
    expect(recordRejection).not.toHaveBeenCalled();
  });

  it('does not strand a scoped owned exit when its source is paused and has lost entry activity', async () => {
    const scope = {
      account: 'operator', chain: 'solana' as const, tokenMint: 'solana:TOKEN',
      masterWalletAddress: 'solana:WALLET'
    };
    const snapshot = {
      scope, policyId: 'subscription-1', revision: 'revision-1', mode: 'paper' as const,
      mirrors: 'sells-only' as const, autoExecute: true, killed: false, maxSlippageBps: 50
    };
    const input = {
      ...signal,
      policy: {
        scope, direction: 'sell' as const, score: 10, minimumScore: 80,
        platformMode: 'live' as const, queued: snapshot, current: snapshot,
        ownedExit: {
          scope, lotId: 'lot-1', availableQuantity: '4', requestedQuantity: '2',
          acquisitionMode: 'paper' as const, maxSlippageBps: 50
        }
      }
    };
    const decision = await enforceCopyEligibility(input, deps({
      loadFacts: async () => ({
        ...facts({ walletStatus: 'paused', clusterSelected: false, walletTradeCount: 0, sourceActivityUsd: 0 }),
        tokenMint: scope.tokenMint, direction: 'sell' as const
      })
    }));
    expect(decision.allowed).toBe(true);
  });

  it.each(['stopped', 'stale', 'wrong-token', 'wrong-side', 'wrong-master', 'unowned'] as const)(
    'retains source/policy fencing for a reducing exit when %s', async condition => {
      const scope = {
        account: 'operator', chain: 'solana' as const, tokenMint: 'solana:TOKEN', masterWalletAddress: 'solana:WALLET'
      };
      const snapshot = {
        scope, policyId: 'subscription-1', revision: 'revision-1', mode: 'paper' as const,
        mirrors: 'sells-only' as const, autoExecute: true, killed: false, maxSlippageBps: 50
      };
      const policy: ExecutionPolicyInput = {
        scope, direction: 'sell', score: 10, minimumScore: 80, platformMode: 'live',
        queued: snapshot, current: { ...snapshot, killed: condition === 'stopped' },
        ownedExit: condition === 'unowned' ? null : {
          scope, lotId: 'lot-1', availableQuantity: '4', requestedQuantity: '2',
          acquisitionMode: 'paper', maxSlippageBps: 50
        }
      };
      const decision = await enforceCopyEligibility({ ...signal, policy }, deps({
        loadFacts: async () => ({
          ...facts({
            walletStatus: 'paused', clusterSelected: false, sourceActivityUsd: 0, walletTradeCount: 0,
            eventAt: condition === 'stale' ? new Date('2026-08-01T11:30:00Z') : facts().eventAt,
            walletAddress: condition === 'wrong-master' ? 'solana:OTHER' : scope.masterWalletAddress
          }),
          tokenMint: condition === 'wrong-token' ? 'solana:OTHER' : scope.tokenMint,
          direction: condition === 'wrong-side' ? 'buy' as const : 'sell' as const
        })
      }));
      expect(decision.allowed).toBe(false);
    }
  );

  it('measures activity over the configured lookback window', async () => {
    const loadFacts = vi.fn(async () => facts());
    await enforceCopyEligibility(signal, deps({ loadFacts }));

    expect(loadFacts).toHaveBeenCalledWith({
      signalId: 'signal-1',
      activityLookbackMs: THRESHOLDS.activityLookbackMs,
      now: NOW
    });
  });

  // The case the whole gate exists for: the scorer paused this wallet after the
  // signal was queued, so the emit-time selection check no longer holds.
  it('rejects a wallet the scorer has since paused', async () => {
    const recordRejection = vi.fn(async () => undefined);
    const decision = await enforceCopyEligibility(signal, deps({
      loadFacts: async () => facts({ walletStatus: 'paused', clusterSelected: false }),
      recordRejection
    }));

    expect(decision).toEqual({ allowed: false, reasons: ['source-not-selected'] });
    expect(recordRejection).toHaveBeenCalledWith({
      account: 'operator',
      signalId: 'signal-1',
      chain: 'solana',
      walletAddress: 'solana:WALLET',
      reasons: ['source-not-selected'],
      rejectedAt: NOW
    });
  });

  // Cluster selection is an independent route in: a paused wallet that still
  // belongs to an active cluster is still followed.
  it('accepts a paused wallet that is still in an active cluster', async () => {
    const decision = await enforceCopyEligibility(signal, deps({
      loadFacts: async () => facts({ walletStatus: 'paused', clusterSelected: true })
    }));

    expect(decision.allowed).toBe(true);
  });

  it('rejects a wallet with no track record even when its USD activity clears', async () => {
    const decision = await enforceCopyEligibility(signal, deps({
      loadFacts: async () => facts({ walletTradeCount: 1, sourceActivityUsd: 900_000 })
    }));

    expect(decision).toEqual({
      allowed: false,
      reasons: ['source-trade-count-below-minimum']
    });
  });

  it('rejects a wallet below the configured USD activity floor', async () => {
    const decision = await enforceCopyEligibility(signal, deps({
      loadFacts: async () => facts({ sourceActivityUsd: 100 })
    }));

    expect(decision).toEqual({
      allowed: false,
      reasons: ['source-activity-below-minimum']
    });
  });

  it('rejects a source event older than the freshness window', async () => {
    const decision = await enforceCopyEligibility(signal, deps({
      loadFacts: async () => facts({ eventAt: new Date('2026-08-01T11:30:00.000Z') })
    }));

    expect(decision).toEqual({ allowed: false, reasons: ['stale-source-event'] });
  });

  it('reports every failing gate rather than the first', async () => {
    const decision = await enforceCopyEligibility(signal, deps({
      loadFacts: async () => facts({
        walletStatus: 'paused',
        clusterSelected: false,
        walletTradeCount: 0,
        sourceActivityUsd: 0
      })
    }));

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reasons).toEqual(expect.arrayContaining([
      'source-not-selected',
      'source-activity-below-minimum',
      'source-trade-count-below-minimum'
    ]));
  });

  it('rejects a source address with no wallet row at all', async () => {
    const decision = await enforceCopyEligibility(signal, deps({
      loadFacts: async () => facts({
        walletKnown: false,
        walletStatus: '',
        walletTradeCount: 0,
        clusterSelected: false
      })
    }));

    expect(decision.allowed === false && decision.reasons).toEqual(expect.arrayContaining([
      'source-not-selected',
      'source-wallet-untracked'
    ]));
  });

  // A signal with no readable source is precisely the one we cannot vouch for.
  it('rejects when the signal has no source facts', async () => {
    const recordRejection = vi.fn(async () => undefined);
    const decision = await enforceCopyEligibility(signal, deps({
      loadFacts: async () => null,
      recordRejection
    }));

    expect(decision).toEqual({ allowed: false, reasons: ['source-facts-unavailable'] });
    expect(recordRejection).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: null, reasons: ['source-facts-unavailable'] })
    );
  });

  it('rejects rather than throwing when the facts query fails', async () => {
    const decision = await enforceCopyEligibility(signal, deps({
      loadFacts: async () => {
        throw new Error('db down');
      }
    }));

    expect(decision).toEqual({ allowed: false, reasons: ['source-facts-unreadable'] });
  });

  it('rejects when the job chain and the source event chain disagree', async () => {
    const decision = await enforceCopyEligibility(
      { ...signal, chain: 'polygon' },
      deps({ loadFacts: async () => facts({ chain: 'solana' }) })
    );

    expect(decision).toEqual({ allowed: false, reasons: ['source-chain-mismatch'] });
  });

  // Losing the audit row must not resurrect a trade the policy already refused.
  it('still refuses the trade when recording the rejection fails', async () => {
    const decision = await enforceCopyEligibility(signal, deps({
      loadFacts: async () => facts({ walletStatus: 'paused', clusterSelected: false }),
      recordRejection: async () => {
        throw new Error('db down');
      }
    }));

    expect(decision).toEqual({ allowed: false, reasons: ['source-not-selected'] });
  });

  it('leaves the USD floor inert when it is not configured', async () => {
    const decision = await enforceCopyEligibility(signal, deps({
      thresholds: { ...THRESHOLDS, minimumSourceActivityUsd: 0 },
      loadFacts: async () => facts({ sourceActivityUsd: 0 })
    }));

    expect(decision.allowed).toBe(true);
  });
});
