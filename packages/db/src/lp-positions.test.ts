import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ scopedQuery: vi.fn(), transaction: vi.fn(), clientQuery: vi.fn() }));
vi.mock('./tenancy.js', () => ({ scopedQuery: mocks.scopedQuery, isCrossTenant: (scope: any) => scope.userId === '*',
  withTenantTransaction: mocks.transaction }));
import { createLpPosition, getLpPosition, listLpPositions, listPositionsForMonitor, setLpPositionAutoRebalance, transitionLpPosition } from './lp-positions.js';
const scope = { userId: 'alice' } as any;
const row = { id: 'p', user_id: 'alice', chain: 'solana', protocol: 'meteora-dlmm', pool_address: 'solana:pool', strategy_type: 'spot',
  range_lower: 90, range_upper: 110, rung_allocations: [], deposit_amount: 1, deposit_asset: 'solana:mint', state: 'active',
  on_chain_position_address: null, auto_rebalance: false, opened_at: new Date(), closed_at: null, updated_at: new Date() };
beforeEach(() => { vi.clearAllMocks(); mocks.scopedQuery.mockResolvedValue([row]); mocks.transaction.mockImplementation(async (_scope, action) => action({ query: mocks.clientQuery }));
  mocks.clientQuery.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT') ? sql.includes('FROM users') ? [{ id: 'alice' }] : [row] : [{ ...row, state: 'near_edge' }] })); });
describe('LP position reads and nonfinancial preferences remain tenant scoped', () => {
  it('unvalued legacy acquisition cannot write a building position', async () => {
    await expect(createLpPosition(scope, {} as any)).rejects.toThrow('legacy unvalued'); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('position and list read scopes are principal derived', async () => {
    await getLpPosition(scope, 'p'); await listLpPositions(scope);
    expect(mocks.scopedQuery.mock.calls.every(call => call[0] === scope)).toBe(true);
    expect(mocks.scopedQuery.mock.calls[0]![2]).toEqual(['p', 'alice']);
  });
  it('close and rebalance transition refuse financial state mutation', async () => {
    await expect(transitionLpPosition(scope, 'p', { toState: 'closed', reason: 'close' })).rejects.toThrow('durable paper');
    await expect(transitionLpPosition(scope, 'p', { toState: 'rebalancing', reason: 'rebalance' })).rejects.toThrow('durable paper');
    expect(mocks.clientQuery.mock.calls.some(call => call[0].includes('UPDATE'))).toBe(false);
  });
  it('automatic preference takes same owner lock, returns actual affected owned row and never financial state', async () => {
    await setLpPositionAutoRebalance(scope, 'p', true);
    expect(mocks.clientQuery.mock.calls[0]![0]).toContain('FROM users');
    const update = mocks.clientQuery.mock.calls.find(call => call[0].includes('UPDATE'))!;
    expect(update[0]).not.toContain('SET state'); expect(update[1]).toEqual(['p', 'alice', true]);
  });
  it('platform sweep marker is not an accepted cross-tenant RLS bypass', async () => {
    await expect(listPositionsForMonitor(scope, 'solana')).rejects.toThrow('platform sweep');
  });
});
