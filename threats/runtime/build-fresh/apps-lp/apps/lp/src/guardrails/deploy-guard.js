import { resolveLpGuardrailConfig, sumOpenLpDeposits, sumOpenLpPoolExposure } from '@swat/db';
import { evaluatePoolExposureCap } from './exposure-cap.js';
export function createDeployGuard(deps = {}) {
    const resolveConfig = deps.resolveConfig ?? resolveLpGuardrailConfig;
    const deployed = deps.deployed ?? sumOpenLpDeposits;
    const poolExposure = deps.poolExposure ?? sumOpenLpPoolExposure;
    return {
        async assertDeployAllowed(input) {
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
                console.warn(`[lp] deploy guard blocked user ${input.scope.userId} on ${input.poolAddress}:`, decision.reasons.join('; '));
            }
            return decision;
        }
    };
}
//# sourceMappingURL=deploy-guard.js.map