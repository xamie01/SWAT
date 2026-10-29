import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('./client.js', () => ({ query: mocks.query }));

import {
  endCompletedCloseAllSubscriptions,
  listCloseAllLotJobs
} from './close-all.js';

describe('listCloseAllLotJobs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns deterministic exact-quantity sells for open requested lots', async () => {
    mocks.query.mockResolvedValueOnce([
      {
        user_id: 'user-a',
        wallet_address: 'solana:master-a',
        lot_id: 'lot-a',
        signal_id: 'signal-a',
        token_mint: 'solana:token-a',
        chain: 'solana',
        remaining_quantity: '1.25'
      }
    ]);

    await expect(listCloseAllLotJobs()).resolves.toEqual([
      {
        userId: 'user-a',
        walletAddress: 'solana:master-a',
        lotId: 'lot-a',
        signalId: 'signal-a',
        tokenMint: 'solana:token-a',
        chain: 'solana',
        sellTokenAmount: 1.25,
        jobId: 'close-all-user-a-lot-a'
      }
    ]);

    const [sql] = mocks.query.mock.calls[0] as [string];
    expect(sql).toContain("subscription.state = 'winding_down'");
    expect(sql).toContain('subscription.close_all_requested_at IS NOT NULL');
    expect(sql).toContain('lot.remaining_quantity > 0');
  });

  it('ends only requested wind-down subscriptions with no open lots', async () => {
    mocks.query.mockResolvedValueOnce([{ user_id: 'user-a' }, { user_id: 'user-b' }]);

    await expect(endCompletedCloseAllSubscriptions()).resolves.toBe(2);
    const [sql] = mocks.query.mock.calls[0] as [string];
    expect(sql).toContain("subscription.state = 'winding_down'");
    expect(sql).toContain('subscription.close_all_requested_at IS NOT NULL');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('lot.remaining_quantity > 0');
  });

  it('fails closed on an invalid quantity instead of enqueueing a malformed sell', async () => {
    mocks.query.mockResolvedValueOnce([
      {
        user_id: 'user-a',
        wallet_address: 'solana:master-a',
        lot_id: 'lot-a',
        signal_id: 'signal-a',
        token_mint: 'solana:token-a',
        chain: 'solana',
        remaining_quantity: 'NaN'
      }
    ]);

    await expect(listCloseAllLotJobs()).rejects.toThrow(/invalid remaining quantity/);
  });
});
