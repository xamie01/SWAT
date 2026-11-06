import { resolveLpGuardrailConfig, sumOpenLpDeposits, sumOpenLpPoolExposure } from '@swat/db';
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
export declare function createDeployGuard(deps?: DeployGuardDeps): DeployGuardPort;
//# sourceMappingURL=deploy-guard.d.ts.map