import { netLpResult } from '../domain/net-lp-result.js';
export function evaluateRebalanceEconomics(input) {
    const netBenefitUsd = netLpResult({
        feesEarned: input.expectedExtraFeesUsd,
        impermanentLoss: input.impermanentLossUsd,
        gasCost: input.gasCostUsd,
        rebalanceCost: input.rebalanceCostUsd,
        inventoryChange: input.inventoryChangeUsd
    });
    const reasons = [];
    if (input.expectedExtraFeesUsd <= 0)
        reasons.push('no-fee-uplift-projected');
    if (netBenefitUsd <= 0)
        reasons.push('net-benefit-not-positive');
    return {
        shouldRebalance: reasons.length === 0,
        netBenefitUsd,
        reasons
    };
}
//# sourceMappingURL=economic-check.js.map