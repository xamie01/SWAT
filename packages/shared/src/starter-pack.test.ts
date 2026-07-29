import { describe, expect, it, vi } from 'vitest';
import {
  clampInteger,
  collectSignaturesToOldest,
  createStarterPackScoreTracker
} from './starter-pack.js';

describe('starter-pack signature pagination', () => {
  it('walks newest-to-oldest pages until the account origin', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce([{ signature: 'new' }, { signature: 'mid' }])
      .mockResolvedValueOnce([{ signature: 'old' }]);

    await expect(
      collectSignaturesToOldest(fetchPage, { maxTotal: 10, pageSize: 2 })
    ).resolves.toEqual({
      signatures: [
        { signature: 'new' },
        { signature: 'mid' },
        { signature: 'old' }
      ],
      reachedOldest: true,
      capped: false
    });
    expect(fetchPage).toHaveBeenNthCalledWith(2, {
      before: 'mid',
      limit: 2
    });
  });

  it('reports an unverified oldest boundary when the safety cap is reached', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce([
        { signature: 'new' },
        { signature: 'old' }
      ])
      .mockResolvedValueOnce([{ signature: 'older' }]);

    await expect(
      collectSignaturesToOldest(fetchPage, { maxTotal: 2, pageSize: 2 })
    ).resolves.toMatchObject({
      reachedOldest: false,
      capped: true
    });
    expect(fetchPage).toHaveBeenNthCalledWith(2, {
      before: 'old',
      limit: 1
    });
  });

  it('proves an origin that lands exactly on the configured cap', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce([
        { signature: 'new' },
        { signature: 'old' }
      ])
      .mockResolvedValueOnce([]);

    await expect(
      collectSignaturesToOldest(fetchPage, { maxTotal: 2, pageSize: 2 })
    ).resolves.toEqual({
      signatures: [
        { signature: 'new' },
        { signature: 'old' }
      ],
      reachedOldest: true,
      capped: false
    });
  });

  it('clamps RPC limits to valid integer bounds', () => {
    expect(clampInteger('5000', 10, 1, 1000)).toBe(1000);
    expect(clampInteger('-4', 10, 1, 1000)).toBe(1);
    expect(clampInteger('invalid', 10, 1, 1000)).toBe(10);
  });
});

describe('starter-pack score tracking', () => {
  it('includes losses and deduplicates repeated outcomes', () => {
    const tracker = createStarterPackScoreTracker();
    tracker.recordTradeOutcome('wallet', 'token-a', false);
    tracker.recordTradeOutcome('wallet', 'token-a', true);
    tracker.recordTradeOutcome('wallet', 'token-b', true);
    tracker.recordPattern('wallet', 'Scale-Out Sniper', 'token-b');

    expect(tracker.results()).toEqual([
      {
        address: 'wallet',
        patterns: ['Scale-Out Sniper'],
        successfulTrades: 1,
        totalTrades: 2,
        winRate: 50,
        score: 1
      }
    ]);
  });

  it('keeps non-trade parent evidence without fabricating a 100% win rate', () => {
    const tracker = createStarterPackScoreTracker();
    tracker.recordPattern('parent', 'Stealth Parent', 'token-a');

    expect(tracker.results()[0]).toMatchObject({
      winRate: null,
      successfulTrades: 0,
      totalTrades: 0
    });
  });
});
