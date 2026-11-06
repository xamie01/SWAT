import { buildLadderPlan } from './ladder-plan.js';
import { resolveStrategyTemplate } from './templates.js';
function resolveParams(input) {
    if (input.template && input.custom) {
        throw new Error('pass either a template or custom ladder params, not both');
    }
    if (input.template) {
        return { params: resolveStrategyTemplate(input.template, input.currentPrice), source: 'template' };
    }
    if (input.custom) {
        // The user-edited validation step: same rules the confirm handler enforces,
        // applied here so the preview never shows a plan the deploy would refuse.
        const { rangeLower, rangeUpper, rungCount, distribution } = input.custom;
        if (!Number.isFinite(rangeLower) || rangeLower <= 0) {
            throw new Error('rangeLower must be a positive finite number');
        }
        if (!Number.isFinite(rangeUpper) || rangeUpper <= rangeLower) {
            throw new Error('rangeUpper must be greater than rangeLower');
        }
        if (!Number.isInteger(rungCount) || rungCount < 1 || rungCount > 64) {
            throw new Error('rungCount must be an integer in 1..64');
        }
        if (!['spot', 'curve', 'bidask'].includes(distribution)) {
            throw new Error('distribution must be spot, curve, or bidask');
        }
        return { params: input.custom, source: 'custom' };
    }
    throw new Error('a strategy template or custom ladder params is required');
}
/** Live liquidity share for one rung: existing pool liquidity in the rung's range. */
function liveLiquidityShare(rung, input) {
    if (input.protocol === 'meteora-dlmm' && input.bins) {
        const inRange = input.bins.filter((bin) => bin.price >= rung.priceLower && bin.price <= rung.priceUpper);
        const total = input.bins.reduce((sum, bin) => sum + bin.baseAmount * bin.price + bin.quoteAmount, 0);
        if (total <= 0)
            return null;
        const inRung = inRange.reduce((sum, bin) => sum + bin.baseAmount * bin.price + bin.quoteAmount, 0);
        return inRung / total;
    }
    if (input.protocol !== 'meteora-dlmm' && input.bands) {
        const total = input.bands.reduce((sum, band) => sum + band.liquidity, 0);
        if (total <= 0)
            return null;
        const inRung = input.bands
            .filter((band) => band.tickLower >= rung.tickLower && band.tickUpper <= rung.tickUpper)
            .reduce((sum, band) => sum + band.liquidity, 0);
        return inRung / total;
    }
    return null;
}
export function buildLivePreview(input) {
    if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) {
        throw new Error(`currentPrice must be positive, got ${input.currentPrice}`);
    }
    const { params, source } = resolveParams(input);
    if (input.protocol === 'meteora-dlmm' && !input.binStep) {
        throw new Error('live meteora preview needs the pool binStep from the live context');
    }
    if (input.protocol !== 'meteora-dlmm' && !input.tickSpacing) {
        throw new Error('live uniswap preview needs the pool tickSpacing from the live context');
    }
    // Deposit optional: weights are exact either way; allocations need a number.
    const planDeposit = input.depositAmount ?? 1;
    if (input.depositAmount !== undefined && (!Number.isFinite(input.depositAmount) || input.depositAmount <= 0)) {
        throw new Error(`depositAmount must be positive, got ${input.depositAmount}`);
    }
    const plan = buildLadderPlan({
        protocol: input.protocol,
        rangeLower: params.rangeLower,
        rangeUpper: params.rangeUpper,
        rungCount: params.rungCount,
        distribution: params.distribution,
        currentPrice: input.currentPrice,
        binStep: input.binStep ?? undefined,
        tickSpacing: input.tickSpacing ?? undefined,
        depositAmount: planDeposit
    });
    const warnings = [...(input.warnings ?? [])];
    const rungs = plan.rungs.map((rung) => ({
        ...rung,
        allocation: input.depositAmount ? rung.allocation : 0,
        liveLiquidityShare: liveLiquidityShare(rung, input)
    }));
    if (rungs.some((rung) => rung.liveLiquidityShare === null)) {
        warnings.push('live bin/tick liquidity unavailable for part of the range — liveLiquidityShare is partial');
    }
    return {
        chain: input.chain,
        poolAddress: input.poolAddress,
        params,
        rungs,
        depositAmount: input.depositAmount ?? null,
        source,
        contextWarning: warnings.length > 0 ? warnings.join('; ') : null
    };
}
//# sourceMappingURL=live-preview.js.map