import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ scopedQuery: vi.fn() }));
vi.mock('./tenancy.js', () => ({ scopedQuery: mocks.scopedQuery }));
import { createLpCopySubscription, getLpCopySubscription, listLpCopySubscriptions, listLpCopyExecutions,
  listActiveFollowersForMaster, createLpCopyExecution, updateLpCopyExecutionStatus } from './lp-copy-trading.js';
const scope = { userId: 'alice' } as any;
const row = { id: 'sub', user_id: 'alice', master_wallet_address: 'solana:master', chain: 'solana', venue: 'meteora-dlmm',
  allocated_budget_usd: '10', max_capital_per_position_usd: '6', status: 'active', created_at: new Date(), updated_at: new Date() };
beforeEach(() => { vi.clearAllMocks(); mocks.scopedQuery.mockResolvedValue([row]); });
describe('LP copy tenant configuration versus exact acquisition authority', () => {
  it('subscription/list/history reads supply principal scope to SQL boundary', async () => {
    await createLpCopySubscription(scope, { masterWalletAddress: 'solana:master', chain: 'solana', venue: 'meteora-dlmm', allocatedBudgetUsd: 10, maxCapitalPerPositionUsd: 6 });
    await getLpCopySubscription(scope, 'sub'); await listLpCopySubscriptions(scope); await listLpCopyExecutions(scope);
    expect(mocks.scopedQuery.mock.calls.every(call => call[0] === scope)).toBe(true);
  });
  it.each([NaN, Infinity, 0, -1])('invalid numeric legacy budget %s cannot configure subscription', async allocatedBudgetUsd => {
    await expect(createLpCopySubscription(scope, { masterWalletAddress: 'solana:master', chain: 'solana', venue: 'meteora-dlmm', allocatedBudgetUsd, maxCapitalPerPositionUsd: 6 })).rejects.toThrow('positive');
    expect(mocks.scopedQuery).not.toHaveBeenCalled();
  });
  it('unscoped legacy financial execution/status and cross-tenant follower enumeration refuse', async () => {
    await expect(createLpCopyExecution({ subscriptionId: 'sub', userId: 'alice', masterPositionId: 'master', chain: 'solana', action: 'mint', status: 'executed' })).rejects.toThrow('atomic exact');
    await expect(updateLpCopyExecutionStatus('id', 'executed')).rejects.toThrow('durable exact');
    await expect(listActiveFollowersForMaster('solana:master', 'solana', 'meteora-dlmm')).rejects.toThrow('separately reviewed');
    expect(mocks.scopedQuery).not.toHaveBeenCalled();
  });
});
