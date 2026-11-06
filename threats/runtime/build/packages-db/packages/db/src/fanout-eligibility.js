import { capabilitiesFor, effectiveTier, tierAllowsChain } from '@swat/shared';
import { evaluateForwardOnlyMirror } from './forward-only.js';
import { mirrorEligibilityForState } from './subscriptions.js';
function excluded(userId, code) {
    return { kind: 'excluded', userId, code };
}
function forwardOnlyExclusionCode(code) {
    switch (code) {
        case 'source-event-precedes-active-since':
            return 'source-event-precedes-active-since';
        case 'source-event-timestamp-unreadable':
            return 'source-event-time-unknown';
        case 'active-since-unreadable':
        case 'no-subscription-window':
            return 'subscription-window-unknown';
        case 'subscription-entries-stopped':
        case 'subscription-not-mirroring':
            return 'subscription-window-unknown';
        case 'source-side-unrecognised':
            return 'source-event-time-unknown';
        default: {
            const exhaustive = code;
            throw new Error(`Unhandled forward-only skip code: ${String(exhaustive)}`);
        }
    }
}
/**
 * Decides one candidate. Order matters only for which code is reported first;
 * every check is independent, and the cheapest and most-specific come first so
 * an operator reading a log sees the user's own setting before a platform one.
 */
export function assessFanoutCandidate(candidate, signal, platform) {
    const mirrors = mirrorEligibilityForState(candidate.subscriptionState);
    if (mirrors === 'none')
        return excluded(candidate.userId, 'subscription-not-mirroring');
    // A winding-down subscription exits positions but opens none. Checked here
    // rather than folded into the state test so the two produce different codes:
    // one means "not subscribed", the other means "subscribed, buys only".
    if (mirrors === 'sells-only' && signal.direction === 'buy') {
        return excluded(candidate.userId, 'winding-down-buy-refused');
    }
    if (signal.direction === 'buy') {
        if (signal.eventAt === null)
            return excluded(candidate.userId, 'source-event-time-unknown');
        if (candidate.activeSince === null) {
            return excluded(candidate.userId, 'subscription-window-unknown');
        }
        const forwardOnly = evaluateForwardOnlyMirror({
            side: signal.direction,
            eventAt: signal.eventAt,
            subscription: {
                userId: candidate.userId,
                walletAddress: signal.masterWalletAddress,
                state: candidate.subscriptionState,
                activeSince: candidate.activeSince
            }
        });
        if (forwardOnly.kind === 'skip') {
            return excluded(candidate.userId, forwardOnlyExclusionCode(forwardOnly.code));
        }
    }
    if (candidate.killed)
        return excluded(candidate.userId, 'user-killed');
    if (!candidate.autoExecute)
        return excluded(candidate.userId, 'auto-execute-off');
    if (!(signal.score >= candidate.minSignalScore)) {
        // Written as `!(>=)` so a NaN score excludes rather than passes.
        return excluded(candidate.userId, 'below-user-min-score');
    }
    const tier = effectiveTier(candidate.tier, candidate.tierExpiresAt);
    if (!tierAllowsChain(capabilitiesFor(tier, candidate.tierExpiresAt), signal.chain)) {
        return excluded(candidate.userId, 'tier-excludes-chain');
    }
    if (!platform.chainMode)
        return excluded(candidate.userId, 'chain-mode-unknown');
    if (platform.chainMode.effectiveMode === 'off') {
        return excluded(candidate.userId, 'chain-execution-off');
    }
    if (candidate.knownBalanceUsd === null) {
        return excluded(candidate.userId, 'balance-unknown');
    }
    if (candidate.knownBalanceUsd < platform.minimumBalanceUsd) {
        return excluded(candidate.userId, 'balance-below-minimum');
    }
    if (candidate.openPositionCount >= candidate.maxConcurrentPositions) {
        return excluded(candidate.userId, 'position-cap-reached');
    }
    if (!platform.capacity)
        return excluded(candidate.userId, 'capacity-unknown');
    if (platform.capacity.outcome === 'skip') {
        return excluded(candidate.userId, 'capacity-exhausted');
    }
    return {
        kind: 'eligible',
        userId: candidate.userId,
        mirrors,
        executionMode: platform.chainMode.effectiveMode,
        downgraded: false
    };
}
/**
 * Enumerates a signal's fan-out.
 *
 * Returns the excluded set alongside the eligible one rather than filtering it
 * away: "nobody copied this signal" and "nobody was subscribed" look identical
 * from an empty array, and the difference is the whole of an operator's
 * diagnosis.
 */
export function planFanout(candidates, signal, platform) {
    const eligible = [];
    const rejected = [];
    const counts = {};
    for (const candidate of candidates) {
        const verdict = assessFanoutCandidate(candidate, signal, platform);
        if (verdict.kind === 'eligible')
            eligible.push(verdict);
        else {
            rejected.push(verdict);
            counts[verdict.code] = (counts[verdict.code] ?? 0) + 1;
        }
    }
    return { eligible, excluded: rejected, exclusionCounts: counts };
}
//# sourceMappingURL=fanout-eligibility.js.map