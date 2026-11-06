import type { LadderPlan } from '../builder/ladder-plan.js';
import type { LpPosition } from '@swat/db';
/**
 * Meteora rebalance executor (Track F4).
 *
 * The plan doc wraps `rebalanceDlmmPosition`; in SDK terms that is
 * remove-from-the-drifted-position then re-add around the new range, per rung.
 * Both legs live behind a port so the executor is testable with fixtures, and
 * the live port implementation maps steps onto
 * `DLMM.removeLiquidityByStrategy` / `addLiquidityByStrategy` calls.
 */
export interface RebalanceStep {
    readonly sequence: number;
    readonly kind: 'remove-liquidity' | 'collect-fees' | 'add-liquidity' | 'swap' | 'mint-position';
    readonly description: string;
    readonly payload: Record<string, unknown>;
}
export interface MeteoraRebalancePort {
    /** Removes the drifted position's liquidity (and collects its fees). */
    buildRemoveSteps(position: Pick<LpPosition, 'onChainPositionAddress' | 'poolAddress'>): Promise<readonly RebalanceStep[]>;
    /** Re-adds liquidity per the new ladder plan, one step per rung. */
    buildAddSteps(plan: LadderPlan, poolAddress: string, userAddress: string): Promise<readonly RebalanceStep[]>;
}
export interface RebalancePlan {
    readonly steps: readonly RebalanceStep[];
    /** True when the bundle is sign-ready (live mode); false = paper plan only. */
    readonly signReady: boolean;
}
export declare function buildMeteoraRebalancePlan(port: MeteoraRebalancePort, input: {
    readonly position: Pick<LpPosition, 'onChainPositionAddress' | 'poolAddress'>;
    readonly plan: LadderPlan;
    readonly userAddress: string;
    readonly signReady: boolean;
}): Promise<RebalancePlan>;
//# sourceMappingURL=meteora-rebalance.d.ts.map