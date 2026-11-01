import { describe, expect, it } from 'vitest';
import {
  allocateLotsForMasterSell,
  assertLotAllocationComplete,
  type PositionLot
} from './lot-allocation.js';

const lot = (overrides: Partial<PositionLot> = {}): PositionLot => ({
  id: 'lot-a',
  masterWalletAddress: 'solana:master-a',
  remainingQuantity: 10,
  remainingCostBasisUsd: 100,
  acquiredAt: new Date('2026-09-01T00:00:00Z'),
  ...overrides
});

describe('allocateLotsForMasterSell', () => {
  it('allocates FIFO and preserves proportional cost basis', () => {
    const result = allocateLotsForMasterSell({
      masterWalletAddress: 'solana:master-a',
      quantity: 12,
      lots: [
        lot({ id: 'lot-b', remainingQuantity: 10, remainingCostBasisUsd: 250, acquiredAt: new Date('2026-09-02T00:00:00Z') }),
        lot({ id: 'lot-a', remainingQuantity: 10, remainingCostBasisUsd: 100 })
      ]
    });

    expect(result).toEqual({
      reductions: [
        { lotId: 'lot-a', quantity: 10, costBasisUsd: 100 },
        { lotId: 'lot-b', quantity: 2, costBasisUsd: 50 }
      ],
      unmatchedQuantity: 0
    });
    expect(() => assertLotAllocationComplete(result)).not.toThrow();
  });

  it('reports an oversell without borrowing another master inventory', () => {
    const result = allocateLotsForMasterSell({
      masterWalletAddress: 'solana:master-a',
      quantity: 12,
      lots: [lot({ remainingQuantity: 10 })]
    });

    expect(result.unmatchedQuantity).toBe(2);
    expect(() => assertLotAllocationComplete(result)).toThrow(/exceeds/);
  });

  it('rejects a lot from a different master', () => {
    expect(() => allocateLotsForMasterSell({
      masterWalletAddress: 'solana:master-a',
      quantity: 1,
      lots: [lot({ masterWalletAddress: 'solana:master-b' })]
    })).toThrow(/different master/);
  });

  it('rejects non-positive sell quantities', () => {
    expect(() => allocateLotsForMasterSell({
      masterWalletAddress: 'solana:master-a',
      quantity: 0,
      lots: []
    })).toThrow(/positive/);
  });
});
