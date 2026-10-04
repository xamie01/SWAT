import type { UserScope } from '@swat/db';
import { resolveLpGuardrailConfig, sumOpenLpDeposits, sumOpenLpPoolExposure } from '@swat/db';
import type { LpChain } from '@swat/shared';
import { evaluatePoolExposureCap, type PoolExposureDecision } from './exposure-cap.js';
import type { DeployGuardPort } from '../builder/build-position.js';

/**
 * The deploy guard (Track G1 wired into Track E6).
 *
 * Implements the builder's `DeployGuardPort` with the real config and exposure
 * sources: the per-pool percent comes from the user's guardrail config (plan
 * default 50%), and the deployed base and pool exposure come from the
 * positions table, open positions only.
 *
 * This is the same order lifecycle, not a parallel one: the guard runs inside
 * `buildPosition`'s flow, before any position row exists, and its decision is
 * recorded in the deploy result the caller sees.
 */

export interface DeployGuardDeps {
  readonly resolveConfig?: typeof resolveLpGuardrailConfig;
  readonly deployed?: typeof sumOpenLpDeposits;
  readonly poolExposure?: typeof sumOpenLpPoolExposure;
}

export function createDeployGuard(deps: DeployGuardDeps = {}): DeployGuardPort {
  const resolveConfig = deps.resolveConfig ?? resolveLpGuardrailConfig;
  const deployed = deps.deployed ?? sumOpenLpDeposits;
  const poolExposure = deps.poolExposure ?? sumOpenLpPoolExposure;

  return {
    async assertDeployAllowed(input: {
      readonly scope: UserScope;
      readonly chain: LpChain;
      readonly poolAddress: string;
      readonly depositAmount: number;
    }): Promise<PoolExposureDecision> {
      const [config, deployedUsd, poolExposureUsd] = await Promise.all([
        resolveConfig(input.scope),
        deployed(input.scope),
        poolExposure(input.scope, input.chain, input.poolAddress)
      ]);

      const decision = evaluatePoolExposureCap({
        deployedUsd,
        poolExposureUsd,
        requestedUsd: input.depositAmount,
        maxPoolAllocationPct: config.maxPoolAllocationPct
      });

      if (!decision.allowed) {
        console.warn(
          `[lp] deploy guard blocked user ${input.scope.userId} on ${input.poolAddress}:`,
          decision.reasons.join('; ')
        );
      }
      return decision;
    }
  };
}
