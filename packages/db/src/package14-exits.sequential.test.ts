import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), price: vi.fn() }));
vi.mock('./client.js', () => ({ query: mocks.query }));
vi.mock('@swat/shared', () => ({ fetchTokenPriceUsd: mocks.price,
  isChain: (x: string) => ['solana', 'polygon', 'robinhood-chain'].includes(x) }));
import { listCloseAllLotJobs, endCompletedCloseAllSubscriptions } from './close-all.js';
import { markToMarketOpenPositions } from './pnl-queries.js';
import { claimStopLossTrigger } from './stop-loss.js';
import { allocateLotsForMasterSell, assertLotAllocationComplete } from './lot-allocation.js';

const exact = '10.000000000000000001';
const lot = { user_id: 'user-a', wallet_address: 'solana:master-a', master_wallet_address: 'solana:master-a',
  lot_id: 'lot-a', signal_id: 'signal-a', token_mint: 'solana:token-a', chain: 'solana',
  remaining_quantity: exact, remaining_cost_basis_usd: '100', target_account: 'solana:target-a', execution_mode: 'live' };
beforeEach(() => { vi.clearAllMocks(); mocks.query.mockResolvedValue([]); });

describe('package14 DB exit producers', () => {
  it('preserves exact quantity and acquisition/account identity from close-all query', async () => {
    mocks.query.mockResolvedValueOnce([lot]);
    const [job] = await listCloseAllLotJobs();
    expect(job).toMatchObject({ requestedBaseQuantity: exact, masterWalletAddress: 'solana:master-a',
      targetAccount: 'solana:target-a', acquisitionExecutionMode: 'live' });
    const sql = mocks.query.mock.calls[0][0];
    expect(sql).toContain('acquisition.execution_mode');
    expect(sql).toContain('position.target_account');
  });
  it('does not end a subscription with pending reserved exits even if no open lots remain', async () => {
    await endCompletedCloseAllSubscriptions();
    const sql = mocks.query.mock.calls[0][0];
    expect(sql).toContain('copy_executions');
    expect(sql).toContain('reserved_base_quantity');
    expect(sql).toContain('source_trades');
  });
  it('mark-to-market lot snapshot retains exact quantity, master, account and live mode', async () => {
    mocks.query.mockResolvedValueOnce([{ signal_id: 'signal-a', user_id: 'user-a', token_mint: 'solana:token-a',
      direction: 'buy', token_amount: '10', amount_usd: '100', price_usd: '10', fee_usd: '0' }])
      .mockResolvedValueOnce([lot]);
    mocks.price.mockResolvedValue(7.5);
    const { positions } = await markToMarketOpenPositions();
    expect(positions[0]).toMatchObject({ positionKey: 'lot-a', openQuantityExact: exact,
      masterWalletAddress: 'solana:master-a', targetAccount: 'solana:target-a', acquisitionExecutionMode: 'live' });
    expect(mocks.query.mock.calls[1][0]).toContain('lot.remaining_quantity::text');
    expect(mocks.query.mock.calls[1][0]).toContain('acquisition.execution_mode');
  });
  it('legacy signal_stop_losses is not a canonical lot reservation', async () => {
    await expect(claimStopLossTrigger({ account: 'user-a', signalId: 'signal-a', chain: 'solana',
      tokenMint: 'solana:token-a', thresholdPct: 20, drawdownPct: 25, openQuantity: 10,
      openCostBasisUsd: 100, priceUsd: 7.5, positionKey: 'lot-a' })).rejects.toThrow(/canonical lot exit/);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('allocator validates ALL masters even after requested quantity has been satisfied', () => {
    expect(() => allocateLotsForMasterSell({ masterWalletAddress: 'solana:master-a', quantity: 1, lots: [
      { id: 'a', masterWalletAddress: 'solana:master-a', remainingQuantity: 10, remainingCostBasisUsd: 100, acquiredAt: new Date(0) },
      { id: 'b', masterWalletAddress: 'solana:master-b', remainingQuantity: 90, remainingCostBasisUsd: 900, acquiredAt: new Date(1) }
    ] })).toThrow(/different master/);
  });
  it('does not silently discard a sub-epsilon exact sell in allocation', () => {
    const allocation = allocateLotsForMasterSell({ masterWalletAddress: 'solana:master-a', quantity: 1e-13,
      lots: [] });
    expect(() => assertLotAllocationComplete(allocation)).toThrow(/exceeds/);
  });
});
