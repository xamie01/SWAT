export type PositionLot = {
  readonly id: string;
  readonly masterWalletAddress: string;
  readonly remainingQuantity: number;
  readonly remainingCostBasisUsd: number | null;
  readonly acquiredAt: Date;
};

export type LotReduction = {
  readonly lotId: string;
  readonly quantity: number;
  readonly costBasisUsd: number | null;
};

export type LotAllocationResult = {
  readonly reductions: readonly LotReduction[];
  readonly unmatchedQuantity: number;
};

/**
 * Allocate one source master's sell across that master's open lots in FIFO order.
 * The caller must pass only lots belonging to the same tenant/token position; this
 * function still checks the master key so a query bug cannot silently borrow inventory.
 */
export function allocateLotsForMasterSell(input: {
  readonly masterWalletAddress: string;
  readonly quantity: number;
  readonly lots: readonly PositionLot[];
}): LotAllocationResult {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new Error('sell quantity must be a positive finite number');
  }

  const ordered = [...input.lots].sort((left, right) => {
    const byTime = left.acquiredAt.getTime() - right.acquiredAt.getTime();
    return byTime || left.id.localeCompare(right.id);
  });
  let remaining = input.quantity;
  const reductions: LotReduction[] = [];

  for (const lot of ordered) {
    if (lot.masterWalletAddress !== input.masterWalletAddress) {
      throw new Error(`lot ${lot.id} belongs to a different master`);
    }
    if (!Number.isFinite(lot.remainingQuantity) || lot.remainingQuantity < 0) {
      throw new Error(`lot ${lot.id} has an invalid remaining quantity`);
    }
    if (remaining <= 1e-12) break;
    const quantity = Math.min(remaining, lot.remainingQuantity);
    if (quantity <= 1e-12) continue;
    const ratio = lot.remainingQuantity > 0 ? quantity / lot.remainingQuantity : 0;
    reductions.push({
      lotId: lot.id,
      quantity,
      costBasisUsd: lot.remainingCostBasisUsd === null
        ? null
        : lot.remainingCostBasisUsd * ratio
    });
    remaining -= quantity;
  }

  return {
    reductions,
    unmatchedQuantity: Math.max(0, remaining)
  };
}

export function assertLotAllocationComplete(result: LotAllocationResult): void {
  if (result.unmatchedQuantity > 1e-12) {
    throw new Error(
      `sell exceeds the master's open lot inventory by ${result.unmatchedQuantity}`
    );
  }
}
