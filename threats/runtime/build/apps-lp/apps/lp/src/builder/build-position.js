import { createLpPosition, transitionLpPosition } from '@swat/db';
import { buildLadderPlan } from './ladder-plan.js';
import { resolveStrategyTemplate } from './templates.js';
function resolveLadderParams(request, currentPrice) {
    if (request.template && request.custom) {
        throw new Error('pass either a template or custom ladder params, not both');
    }
    if (request.template) {
        return resolveStrategyTemplate(request.template, currentPrice);
    }
    if (request.custom) {
        return request.custom;
    }
    throw new Error('a strategy template or custom ladder params is required');
}
export async function buildPosition(deps, scope, request) {
    if (!Number.isFinite(request.depositAmount) || request.depositAmount <= 0) {
        throw new Error(`depositAmount must be positive, got ${request.depositAmount}`);
    }
    if (request.depositAsset.indexOf(':') < 0 || request.poolAddress.indexOf(':') < 0) {
        throw new Error('pool and deposit addresses must be chain-prefixed');
    }
    const mode = await deps.executionMode.resolveMode(request.chain);
    if (mode === 'off') {
        throw new Error(`LP execution on ${request.chain} is off`);
    }
    const guardDecision = await deps.deployGuard.assertDeployAllowed({
        scope,
        chain: request.chain,
        poolAddress: request.poolAddress,
        depositAmount: request.depositAmount
    });
    if (!guardDecision.allowed) {
        return {
            positionId: '',
            mode,
            rungs: [],
            steps: [],
            rejectionReasons: guardDecision.reasons
        };
    }
    const pool = await deps.poolView.getPool(request.chain, request.poolAddress);
    if (!pool) {
        throw new Error(`pool ${request.poolAddress} is not in the scan cache; run a scan first`);
    }
    const currentPrice = pool.currentPrice;
    if (currentPrice === null || currentPrice <= 0) {
        throw new Error(`pool ${request.poolAddress} has no current price to anchor the ladder`);
    }
    const params = resolveLadderParams(request, currentPrice);
    const plan = buildLadderPlan({
        protocol: pool.protocol,
        rangeLower: params.rangeLower,
        rangeUpper: params.rangeUpper,
        rungCount: params.rungCount,
        distribution: params.distribution,
        currentPrice,
        binStep: pool.binStep ?? undefined,
        tickSpacing: pool.tickSpacing ?? undefined,
        depositAmount: request.depositAmount
    });
    const createPosition = deps.createPosition ?? createLpPosition;
    const position = await createPosition(scope, {
        chain: request.chain,
        protocol: pool.protocol,
        poolAddress: request.poolAddress,
        strategyType: params.distribution,
        rangeLower: params.rangeLower,
        rangeUpper: params.rangeUpper,
        rungAllocations: plan.rungs,
        depositAmount: request.depositAmount,
        depositAsset: request.depositAsset,
        autoRebalance: request.autoRebalance === true
    });
    let steps;
    if (request.chain === 'solana') {
        if (!deps.meteoraBuilder) {
            throw new Error('meteora ladder builder is not configured');
        }
        steps = await deps.meteoraBuilder.buildLadder({
            plan,
            pairAddress: request.poolAddress,
            userAddress: deps.userAddress,
            currentPrice,
            distribution: params.distribution
        });
    }
    else {
        if (!deps.evmBuilder) {
            throw new Error('evm ladder builder is not configured');
        }
        steps = await deps.evmBuilder.buildLadder({
            plan,
            poolAddress: request.poolAddress,
            recipient: deps.userAddress,
            currentPrice,
            distribution: params.distribution
        });
    }
    // Paper mode: the recorded plan IS the build, so the position can leave
    // `building` and become monitorable (the monitor sweep only reads
    // active/near_edge/out_of_range rows — nothing else ever moved it out of
    // `building`, which stranded every paper deploy). Live mode leaves the
    // transition to the executor's broadcast confirmation
    // (attachOnChainPositionAddress), since `building` must not read as
    // deployed before the bundle actually lands.
    if (mode === 'paper') {
        const transition = deps.transitionPosition ?? transitionLpPosition;
        await transition(scope, position.id, {
            toState: 'active',
            reason: `ladder plan recorded in paper mode (${steps.length} rungs)`
        });
    }
    return { positionId: position.id, mode, rungs: plan.rungs, steps, rejectionReasons: [] };
}
//# sourceMappingURL=build-position.js.map