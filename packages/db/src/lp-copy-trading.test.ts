import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createLpCopySubscription,
  getLpCopySubscription,
  listLpCopySubscriptions,
  listActiveFollowersForMaster,
  updateLpCopySubscriptionStatus,
  createLpCopyExecution,
  updateLpCopyExecutionStatus,
  listLpCopyExecutions
} from './lp-copy-trading.js';
import * as client from './client.js';
import type { UserScope } from './tenancy.js';

vi.mock('./client.js', () => ({
  query: vi.fn()
}));

const mockScope: UserScope = {
  kind: 'user',
  userId: '11111111-1111-4111-8111-111111111111'
};

describe('LP Copy Trading DB Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createLpCopySubscription', () => {
    it('creates a subscription with valid budget', async () => {
      const mockRow = {
        id: 'sub-1',
        user_id: mockScope.userId,
        master_wallet_address: 'base:0xmaster',
        chain: 'base',
        venue: 'uniswap-v3',
        allocated_budget_usd: '1000',
        max_capital_per_position_usd: '200',
        status: 'active',
        created_at: new Date(),
        updated_at: new Date()
      };
      vi.mocked(client.query).mockResolvedValueOnce([mockRow] as any);

      const sub = await createLpCopySubscription(mockScope, {
        masterWalletAddress: 'base:0xmaster',
        chain: 'base',
        venue: 'uniswap-v3',
        allocatedBudgetUsd: 1000,
        maxCapitalPerPositionUsd: 200
      });

      expect(sub.id).toBe('sub-1');
      expect(sub.allocatedBudgetUsd).toBe(1000);
      expect(sub.maxCapitalPerPositionUsd).toBe(200);
      expect(sub.status).toBe('active');
    });

    it('rejects non-positive budget or max capital', async () => {
      await expect(
        createLpCopySubscription(mockScope, {
          masterWalletAddress: 'base:0xmaster',
          chain: 'base',
          venue: 'uniswap-v3',
          allocatedBudgetUsd: 0,
          maxCapitalPerPositionUsd: 100
        })
      ).rejects.toThrow(/strictly positive/);
    });
  });

  describe('listActiveFollowersForMaster', () => {
    it('queries active followers for a given master wallet, chain, and venue', async () => {
      const mockRows = [
        {
          id: 'sub-1',
          user_id: 'user-a',
          master_wallet_address: 'solana:master1',
          chain: 'solana',
          venue: 'meteora-dlmm',
          allocated_budget_usd: '500',
          max_capital_per_position_usd: '100',
          status: 'active',
          created_at: new Date('2026-10-01T00:00:00Z'),
          updated_at: new Date('2026-10-01T00:00:00Z')
        }
      ];
      vi.mocked(client.query).mockResolvedValueOnce(mockRows as any);

      const followers = await listActiveFollowersForMaster(
        'solana:master1',
        'solana',
        'meteora-dlmm'
      );

      expect(followers).toHaveLength(1);
      expect(followers[0]!.userId).toBe('user-a');
      expect(followers[0]!.allocatedBudgetUsd).toBe(500);
    });
  });

  describe('createLpCopyExecution & updateLpCopyExecutionStatus', () => {
    it('journals a copy execution record and updates its status', async () => {
      const execRow = {
        id: 'exec-1',
        subscription_id: 'sub-1',
        user_id: mockScope.userId,
        master_position_id: 'pos-master-99',
        follower_position_id: null,
        chain: 'base',
        action: 'mint',
        master_deposit_usd: '5000',
        follower_deposit_usd: '500',
        scale_ratio: '0.1',
        status: 'pending',
        error_message: null,
        created_at: new Date(),
        updated_at: new Date()
      };
      vi.mocked(client.query).mockResolvedValueOnce([execRow] as any);

      const exec = await createLpCopyExecution({
        subscriptionId: 'sub-1',
        userId: mockScope.userId,
        masterPositionId: 'pos-master-99',
        chain: 'base',
        action: 'mint',
        masterDepositUsd: 5000,
        followerDepositUsd: 500,
        scaleRatio: 0.1
      });

      expect(exec.id).toBe('exec-1');
      expect(exec.scaleRatio).toBe(0.1);
      expect(exec.status).toBe('pending');

      vi.mocked(client.query).mockResolvedValueOnce({ rowCount: 1 } as any);
      const updated = await updateLpCopyExecutionStatus('exec-1', 'executed');
      expect(updated).toBe(true);
    });
  });
});
