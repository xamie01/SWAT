/**
 * Rebalance economic check (Track F3) — pure, built and tested against mock
 * data before any wiring, exactly as the build plan demands.
 *
 * The question is never "is the position out of range?" — the classifier
 * answers that — but "does re-centering pay for itself?". The inputs are the
 * projection a fee model supplies (live service wires its own; the monitor
 * only consumes):
 *
 *   - `expectedExtraFeesUsd`: fee uplift projected over the horizon from
 *     holding a re-centered position instead of the drifted one.
 *   - `impermanentLossUsd`: IL incurred *by the rebalance itself* (re-centering
 *     realizes the drift), stated positive.
 *   - `gasCostUsd` + `rebalanceCostUsd`: execution cost — gas, plus swap
 *     slippage and position churn.
 *   - `inventoryChangeUsd`: signed projected inventory improvement from
 *     re-centering (usually negative: you buy back what drifted away).
 *
 * The verdict reuses the Track A net-LP-result function verbatim — the same
 * ledger the wallet PnL screen shows. Rebalance only when the rebalance's own
 * net result is strictly positive.
 */
export interface RebalanceEconomicsInput {
    readonly expectedExtraFeesUsd: number;
    readonly impermanentLossUsd: number;
    readonly gasCostUsd: number;
    readonly rebalanceCostUsd: number;
    readonly inventoryChangeUsd: number;
}
export interface RebalanceEconomics {
    readonly shouldRebalance: boolean;
    readonly netBenefitUsd: number;
    readonly reasons: readonly string[];
}
export declare function evaluateRebalanceEconomics(input: RebalanceEconomicsInput): RebalanceEconomics;
//# sourceMappingURL=economic-check.d.ts.map