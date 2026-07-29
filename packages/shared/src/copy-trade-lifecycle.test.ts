import { describe, expect, it } from 'vitest';
import {
  calculateProportionalSell,
  canTransitionCopyExecution,
  canTransitionSourceConfirmation,
  evaluateCopyPolicy,
  reducePositionEvents
} from './copy-trade-lifecycle.js';

describe('canonical copy-trade lifecycle', () => {
  it('rebuilds the same position from out-of-order events', () => {
    const events = [
      {
        id: 'sell-1',
        side: 'sell' as const,
        quantity: 4,
        eventAt: new Date('2026-07-26T12:02:00Z')
      },
      {
        id: 'buy-1',
        side: 'buy' as const,
        quantity: 10,
        amountUsd: 50,
        eventAt: new Date('2026-07-26T12:00:00Z')
      },
      {
        id: 'transfer-1',
        side: 'transfer_out' as const,
        quantity: 1,
        eventAt: new Date('2026-07-26T12:01:00Z')
      }
    ];

    expect(reducePositionEvents({ confirmedQuantity: 0, costBasisUsd: 0 }, events)).toEqual({
      confirmedQuantity: 5,
      costBasisUsd: 25,
      totalAcquiredQuantity: 10,
      totalReducedQuantity: 5,
      unmatchedReductionQuantity: 0
    });
    expect(reducePositionEvents(
      { confirmedQuantity: 0, costBasisUsd: 0 },
      [...events].reverse()
    )).toEqual({
      confirmedQuantity: 5,
      costBasisUsd: 25,
      totalAcquiredQuantity: 10,
      totalReducedQuantity: 5,
      unmatchedReductionQuantity: 0
    });
  });

  it('tracks unproven reductions without creating negative positions', () => {
    expect(reducePositionEvents(
      { confirmedQuantity: 2, costBasisUsd: 8 },
      [{
        id: 'sell-1',
        side: 'sell',
        quantity: 5,
        eventAt: new Date('2026-07-26T12:00:00Z')
      }]
    )).toEqual({
      confirmedQuantity: 0,
      costBasisUsd: 0,
      totalAcquiredQuantity: 0,
      totalReducedQuantity: 5,
      unmatchedReductionQuantity: 3
    });
  });

  it('orders equal-time events by immutable identity', () => {
    const snapshot = reducePositionEvents(
      { confirmedQuantity: 0, costBasisUsd: 0 },
      [
        { id: 'b-sell', side: 'sell', quantity: 1, eventAt: new Date('2026-07-26T12:00:00Z') },
        { id: 'a-buy', side: 'buy', quantity: 1, amountUsd: 4, eventAt: new Date('2026-07-26T12:00:00Z') }
      ]
    );
    expect(snapshot.confirmedQuantity).toBe(0);
    expect(snapshot.unmatchedReductionQuantity).toBe(0);
  });

  it('rejects invalid quantities instead of coercing them', () => {
    expect(() => reducePositionEvents(
      { confirmedQuantity: 0, costBasisUsd: 0 },
      [{ id: 'bad', side: 'buy', quantity: Number.NaN, eventAt: new Date() }]
    )).toThrow('event quantity');
  });

  it('allows only explicit lifecycle transitions', () => {
    expect(canTransitionCopyExecution('requested', 'submitted')).toBe(false);
    expect(canTransitionCopyExecution('requested', 'simulated')).toBe(true);
    expect(canTransitionCopyExecution('submitted', 'reconciliation_required')).toBe(true);
    expect(canTransitionCopyExecution('confirmed', 'submitted')).toBe(false);
    expect(canTransitionSourceConfirmation('observed', 'confirmed')).toBe(true);
    expect(canTransitionSourceConfirmation('reversed', 'confirmed')).toBe(false);
  });

  it('fails copy policy closed across selection, age, activity, liquidity, exposure, and safety', () => {
    const decision = evaluateCopyPolicy({
      chain: 'polygon',
      selectedWallet: false,
      selectedCluster: false,
      eventAt: new Date('2026-07-26T10:00:00Z'),
      now: new Date('2026-07-26T12:00:00Z'),
      maxEventAgeMs: 60_000,
      sourceActivityUsd: 5,
      minimumSourceActivityUsd: 10,
      liquidityUsd: 100,
      minimumLiquidityUsd: 1_000,
      currentExposureUsd: 90,
      requestedExposureUsd: 20,
      maximumExposureUsd: 100,
      chainReady: false,
      supportedAsset: false,
      safetyAllowed: false,
      safetyReasons: ['market-closed']
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      'source-not-selected',
      'stale-source-event',
      'source-activity-below-minimum',
      'liquidity-below-minimum',
      'exposure-limit-exceeded',
      'polygon-not-ready',
      'unsupported-asset',
      'market-closed'
    ]));
  });

  it('allows a selected source only when every gate passes', () => {
    expect(evaluateCopyPolicy({
      chain: 'solana',
      selectedWallet: true,
      selectedCluster: false,
      eventAt: new Date('2026-07-26T11:59:30Z'),
      now: new Date('2026-07-26T12:00:00Z'),
      maxEventAgeMs: 60_000,
      sourceActivityUsd: 10,
      minimumSourceActivityUsd: 10,
      liquidityUsd: 1_000,
      minimumLiquidityUsd: 1_000,
      currentExposureUsd: 80,
      requestedExposureUsd: 20,
      maximumExposureUsd: 100,
      chainReady: true,
      supportedAsset: true,
      safetyAllowed: true
    })).toEqual({ allowed: true, reasons: [] });
  });

  it('sizes proportional exits and never exceeds confirmed holdings', () => {
    expect(calculateProportionalSell({
      sourceReductionQuantity: 25,
      sourcePositionBeforeQuantity: 100,
      swatConfirmedAvailableQuantity: 8
    })).toEqual({ proportion: 0.25, quantity: 2 });
    expect(calculateProportionalSell({
      sourceReductionQuantity: 200,
      sourcePositionBeforeQuantity: 100,
      swatConfirmedAvailableQuantity: 8
    })).toEqual({ proportion: 1, quantity: 8 });
    expect(calculateProportionalSell({
      sourceReductionQuantity: 25,
      sourcePositionBeforeQuantity: 100,
      swatConfirmedAvailableQuantity: 0
    })).toEqual({ proportion: 0, quantity: 0 });
  });
});
