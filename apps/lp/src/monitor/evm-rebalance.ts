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
  buildCloseSteps(position: { readonly onChainPositionAddress: string }): Promise<readonly RebalanceStep[]>;
  buildRemintSteps(plan: LadderPlan, recipient: string): Promise<readonly RebalanceStep[]>;
}

export function buildEvmRebalancePlan(port: EvmRebalancePort, input: {
  readonly position: Pick<LpPosition, 'onChainPositionAddress' | 'poolAddress'>;
  readonly plan: LadderPlan;
  readonly recipient: string;
  readonly signReady: boolean;
}): Promise<RebalancePlan> {
  if (!input.position.onChainPositionAddress) {
    throw new Error('cannot rebalance a position that has no on-chain address yet');
  }
  return (async () => {
    const closeSteps = await port.buildCloseSteps({ onChainPositionAddress: input.position.onChainPositionAddress! });
    const remintSteps = await port.buildRemintSteps(input.plan, input.recipient);

    let sequence = 0;
    const steps: RebalanceStep[] = [
      ...closeSteps,
      {
        sequence: sequence++,
        kind: 'swap' as const,
        description: 're-center inventory for the new range (executor computes leg ratio)',
        payload: { poolAddress: input.position.poolAddress }
      },
      ...remintSteps
    ].map((step, index) => ({ ...step, sequence: index }));

    return { steps, signReady: input.signReady };
  })();
}
