import { classifyRangeState } from './classifier.js';
import { evaluateRebalanceEconomics } from './economic-check.js';
export async function runMonitorPass(ports, chain) {
    const positions = await ports.listPositions(chain);
    const summary = {
        positionsChecked: 0,
        unreadablePrices: 0,
        transitions: [],
        rebalancesQueued: 0,
        rebalancesDeclined: []
    };
    for (const position of positions) {
        summary.positionsChecked += 1;
        const currentPrice = await ports.pricePoller.currentPrice(position.poolAddress);
        if (currentPrice === null) {
            summary.unreadablePrices += 1;
            continue;
        }
        const observed = classifyRangeState({
            currentPrice,
            rangeLower: position.rangeLower,
            rangeUpper: position.rangeUpper,
            edgeThreshold: ports.edgeThreshold
        });
        const currentState = position.state;
        // Only the transition is skipped when the observation matches the stored
        // state — the economic gate below still runs every pass for near_edge and
        // out_of_range positions, because fee projections move even when the label
        // does not.
        if (observed !== currentState) {
            try {
                await ports.transition(position.id, observed, `monitor: price ${currentPrice} vs range ${position.rangeLower}..${position.rangeUpper} -> ${observed}`);
                summary.transitions.push({ positionId: position.id, from: position.state, to: observed });
            }
            catch (error) {
                // An illegal transition (e.g. racing a close) must not abort the sweep;
                // the history row already holds the refusal context.
                console.error('[lp] monitor transition refused for', position.id, error instanceof Error ? error.message : error);
                continue;
            }
        }
        if (observed !== 'near_edge' && observed !== 'out_of_range')
            continue;
        // F6 change: no auto-fire by default. Without the owner's opt-in the
        // re-labeled state is the deliverable — the position manager shows it as
        // `rebalanceRecommended` and the user decides (manual trigger endpoint).
        if (!position.autoRebalance) {
            summary.rebalancesDeclined.push({
                positionId: position.id,
                reason: 'auto-rebalance-not-opted-in'
            });
            continue;
        }
        // Economic gate: only a strictly positive projection earns a rebalance.
        const economicsInput = await ports.economics.estimate({ position, currentPrice, state: observed });
        const economics = evaluateRebalanceEconomics(economicsInput);
        if (!economics.shouldRebalance) {
            summary.rebalancesDeclined.push({
                positionId: position.id,
                reason: economics.reasons.join(',') || 'not-positive'
            });
            continue;
        }
        await ports.queueRebalance({
            positionId: position.id,
            chain,
            poolAddress: position.poolAddress,
            netBenefitUsd: economics.netBenefitUsd
        });
        summary.rebalancesQueued += 1;
    }
    return summary;
}
//# sourceMappingURL=monitor-job.js.map