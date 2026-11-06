import type { LadderPlan } from '../builder/ladder-plan.js';
import type { LpPosition } from '@swat/db';
import type { RebalancePlan, RebalanceStep } from './meteora-rebalance.js';
/**
 * Uniswap v3/v4 rebalance executor (Track F5): close the drifted position
 * (decrease + collect), swap if the new range needs a different leg ratio,
 * remint around the new range — all behind a port, per the same pattern as the
 * Meteora side.
 */
export interface EvmRebalancePort {
    buildCloseSteps(position: {
        readonly onChainPositionAddress: string;
    }): Promise<readonly RebalanceStep[]>;
    buildRemintSteps(plan: LadderPlan, recipient: string): Promise<readonly RebalanceStep[]>;
}
export declare function buildEvmRebalancePlan(port: EvmRebalancePort, input: {
    readonly position: Pick<LpPosition, 'onChainPositionAddress' | 'poolAddress'>;
    readonly plan: LadderPlan;
    readonly recipient: string;
    readonly signReady: boolean;
}): Promise<RebalancePlan>;
//# sourceMappingURL=evm-rebalance.d.ts.map