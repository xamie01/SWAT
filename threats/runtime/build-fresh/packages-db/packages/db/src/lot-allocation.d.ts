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
export declare function allocateLotsForMasterSell(input: {
    readonly masterWalletAddress: string;
    readonly quantity: number;
    readonly lots: readonly PositionLot[];
}): LotAllocationResult;
export declare function assertLotAllocationComplete(result: LotAllocationResult): void;
//# sourceMappingURL=lot-allocation.d.ts.map