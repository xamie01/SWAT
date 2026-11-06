function assertCost(name, value) {
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a finite non-negative cost, got ${value}`);
    }
}
/**
 * `feesEarned + inventoryChange − impermanentLoss − gasCost − rebalanceCost`.
 *
 * Negative is a normal answer: LP is not free to hold, and a window of IL plus
 * gas can absolutely out-earn its fees. The rebalance gate (Track F) treats
 * `netLpResult ≤ 0` as "repositioning did not pay for itself", not as an error.
 */
export function netLpResult(input) {
    assertCost('feesEarned', input.feesEarned);
    assertCost('impermanentLoss', input.impermanentLoss);
    assertCost('gasCost', input.gasCost);
    assertCost('rebalanceCost', input.rebalanceCost);
    if (!Number.isFinite(input.inventoryChange)) {
        throw new Error(`inventoryChange must be finite, got ${input.inventoryChange}`);
    }
    return (input.feesEarned
        + input.inventoryChange
        - input.impermanentLoss
        - input.gasCost
        - input.rebalanceCost);
}
//# sourceMappingURL=net-lp-result.js.map