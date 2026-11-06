const EXECUTION_TRANSITIONS = {
    requested: ['simulated', 'failed', 'cancelled', 'reconciliation_required'],
    simulated: ['submitted', 'confirmed', 'failed', 'cancelled', 'reconciliation_required'],
    submitted: ['partially_filled', 'confirmed', 'failed', 'cancelled', 'reconciliation_required'],
    partially_filled: ['partially_filled', 'confirmed', 'cancelled', 'reconciliation_required'],
    reconciliation_required: [
        'submitted',
        'partially_filled',
        'confirmed',
        'failed',
        'cancelled',
        'reconciliation_required'
    ],
    confirmed: ['reconciliation_required'],
    failed: [],
    cancelled: []
};
const CONFIRMATION_TRANSITIONS = {
    observed: ['confirmed', 'finalized', 'reversed'],
    confirmed: ['finalized', 'reversed'],
    finalized: ['reversed'],
    reversed: []
};
function assertFiniteNonNegative(name, value) {
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a finite non-negative number`);
    }
}
function eventCostUsd(event) {
    if (event.amountUsd !== undefined && event.amountUsd !== null) {
        assertFiniteNonNegative('amountUsd', event.amountUsd);
        return event.amountUsd;
    }
    if (event.priceUsd !== undefined && event.priceUsd !== null) {
        assertFiniteNonNegative('priceUsd', event.priceUsd);
        return event.quantity * event.priceUsd;
    }
    return 0;
}
/**
 * Rebuild a position deterministically from confirmed, immutable events.
 * Reductions are capped to the quantity proven by this ledger; any excess is
 * retained as an unmatched reduction instead of creating a negative holding.
 */
export function reducePositionEvents(opening, events) {
    assertFiniteNonNegative('opening.confirmedQuantity', opening.confirmedQuantity);
    assertFiniteNonNegative('opening.costBasisUsd', opening.costBasisUsd);
    let confirmedQuantity = opening.confirmedQuantity;
    let costBasisUsd = opening.costBasisUsd;
    let totalAcquiredQuantity = 0;
    let totalReducedQuantity = 0;
    let unmatchedReductionQuantity = 0;
    const orderedEvents = [...events].sort((left, right) => {
        const timeDifference = left.eventAt.getTime() - right.eventAt.getTime();
        return timeDifference === 0 ? left.id.localeCompare(right.id) : timeDifference;
    });
    for (const event of orderedEvents) {
        if (!Number.isFinite(event.quantity) || event.quantity <= 0) {
            throw new Error('event quantity must be a finite positive number');
        }
        if (Number.isNaN(event.eventAt.getTime())) {
            throw new Error('eventAt must be a valid date');
        }
        if (event.side === 'buy' || event.side === 'transfer_in') {
            confirmedQuantity += event.quantity;
            totalAcquiredQuantity += event.quantity;
            costBasisUsd += eventCostUsd(event);
            continue;
        }
        totalReducedQuantity += event.quantity;
        const appliedReduction = Math.min(confirmedQuantity, event.quantity);
        const averageCost = confirmedQuantity > 0 ? costBasisUsd / confirmedQuantity : 0;
        confirmedQuantity -= appliedReduction;
        costBasisUsd = Math.max(0, costBasisUsd - averageCost * appliedReduction);
        unmatchedReductionQuantity += event.quantity - appliedReduction;
    }
    return {
        confirmedQuantity,
        costBasisUsd,
        totalAcquiredQuantity,
        totalReducedQuantity,
        unmatchedReductionQuantity
    };
}
export function isAppliedSourceConfirmation(state) {
    return state === 'confirmed' || state === 'finalized';
}
export function canTransitionSourceConfirmation(current, next) {
    return current === next || CONFIRMATION_TRANSITIONS[current].includes(next);
}
export function canTransitionCopyExecution(current, next) {
    return current === next || EXECUTION_TRANSITIONS[current].includes(next);
}
/** Fail-closed policy evaluation shared by all chain adapters. */
export function evaluateCopyPolicy(input) {
    const reasons = [];
    const numericInputs = [
        ['maxEventAgeMs', input.maxEventAgeMs],
        ['maxClockSkewMs', input.maxClockSkewMs ?? 0],
        ['sourceActivityUsd', input.sourceActivityUsd],
        ['minimumSourceActivityUsd', input.minimumSourceActivityUsd],
        ['liquidityUsd', input.liquidityUsd],
        ['minimumLiquidityUsd', input.minimumLiquidityUsd],
        ['currentExposureUsd', input.currentExposureUsd],
        ['requestedExposureUsd', input.requestedExposureUsd],
        ['maximumExposureUsd', input.maximumExposureUsd]
    ];
    if (numericInputs.some(([, value]) => !Number.isFinite(value) || value < 0)) {
        reasons.push('invalid-policy-input');
    }
    const eventTime = input.eventAt.getTime();
    const nowTime = input.now.getTime();
    if (!Number.isFinite(eventTime) || !Number.isFinite(nowTime)) {
        reasons.push('invalid-event-time');
    }
    else {
        if (nowTime - eventTime > input.maxEventAgeMs)
            reasons.push('stale-source-event');
        if (eventTime - nowTime > (input.maxClockSkewMs ?? 0))
            reasons.push('future-source-event');
    }
    if (!input.selectedWallet && !input.selectedCluster)
        reasons.push('source-not-selected');
    if (input.sourceActivityUsd < input.minimumSourceActivityUsd)
        reasons.push('source-activity-below-minimum');
    if (input.liquidityUsd < input.minimumLiquidityUsd)
        reasons.push('liquidity-below-minimum');
    if (input.currentExposureUsd + input.requestedExposureUsd > input.maximumExposureUsd) {
        reasons.push('exposure-limit-exceeded');
    }
    if (!input.chainReady)
        reasons.push(`${input.chain}-not-ready`);
    if (!input.supportedAsset)
        reasons.push('unsupported-asset');
    if (!input.safetyAllowed) {
        reasons.push(...(input.safetyReasons?.length ? input.safetyReasons : ['chain-safety-rejected']));
    }
    return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] };
}
export function calculateProportionalSell(input) {
    assertFiniteNonNegative('sourceReductionQuantity', input.sourceReductionQuantity);
    assertFiniteNonNegative('sourcePositionBeforeQuantity', input.sourcePositionBeforeQuantity);
    assertFiniteNonNegative('swatConfirmedAvailableQuantity', input.swatConfirmedAvailableQuantity);
    if (input.sourceReductionQuantity === 0
        || input.sourcePositionBeforeQuantity === 0
        || input.swatConfirmedAvailableQuantity === 0) {
        return { proportion: 0, quantity: 0 };
    }
    const proportion = Math.min(1, input.sourceReductionQuantity / input.sourcePositionBeforeQuantity);
    return {
        proportion,
        quantity: Math.min(input.swatConfirmedAvailableQuantity, input.swatConfirmedAvailableQuantity * proportion)
    };
}
//# sourceMappingURL=copy-trade-lifecycle.js.map