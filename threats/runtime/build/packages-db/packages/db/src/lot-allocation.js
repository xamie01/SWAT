/**
 * Allocate one source master's sell across that master's open lots in FIFO order.
 * The caller must pass only lots belonging to the same tenant/token position; this
 * function still checks the master key so a query bug cannot silently borrow inventory.
 */
export function allocateLotsForMasterSell(input) {
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
        throw new Error('sell quantity must be a positive finite number');
    }
    const ordered = [...input.lots].sort((left, right) => {
        const byTime = left.acquiredAt.getTime() - right.acquiredAt.getTime();
        return byTime || left.id.localeCompare(right.id);
    });
    let remaining = input.quantity;
    const reductions = [];
    for (const lot of ordered) {
        if (lot.masterWalletAddress !== input.masterWalletAddress) {
            throw new Error(`lot ${lot.id} belongs to a different master`);
        }
        if (!Number.isFinite(lot.remainingQuantity) || lot.remainingQuantity < 0) {
            throw new Error(`lot ${lot.id} has an invalid remaining quantity`);
        }
        if (remaining <= 1e-12)
            break;
        const quantity = Math.min(remaining, lot.remainingQuantity);
        if (quantity <= 1e-12)
            continue;
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
export function assertLotAllocationComplete(result) {
    if (result.unmatchedQuantity > 1e-12) {
        throw new Error(`sell exceeds the master's open lot inventory by ${result.unmatchedQuantity}`);
    }
}
//# sourceMappingURL=lot-allocation.js.map