import { evaluateCopyPolicy } from '@swat/shared';
/**
 * The copy-eligibility policy for the canonical claim boundary.
 *
 * Everything else in `handleJob` asks "can this trade be executed safely?" —
 * balances, exposure caps, chain readiness, token safety. Nothing asked the
 * prior question: "do we still follow the wallet that produced this signal, and
 * has it done enough for us to have an opinion about it?" The signal-engine
 * checks selection when it *emits* a candidate, but the nightly scorer sweep
 * pauses underperforming wallets, and a signal that sat in the queue across
 * that sweep would still be copied from a source we have since dropped.
 *
 * This runs before the claim rather than after it on purpose. Claiming first
 * and rejecting after would burn the signal's one-shot canonical claim and
 * leave a `requested` execution row that has to be cancelled — extra lifecycle
 * state for a trade we were never going to place.
 */
/** Operator account this policy runs for (Standing Rule 2). */
export const COPY_ELIGIBILITY_ACCOUNT = 'operator';
export async function enforceCopyEligibility(input, dependencies) {
    const { thresholds } = dependencies;
    const now = dependencies.now?.() ?? new Date();
    let facts;
    try {
        facts = await dependencies.loadFacts({
            signalId: input.signalId,
            activityLookbackMs: thresholds.activityLookbackMs,
            now
        });
    }
    catch (error) {
        // A policy that cannot read its own inputs must not wave the trade through.
        console.error(`[trade-executor] copy-eligibility lookup failed for signal ${input.signalId}`, error);
        return reject(input, dependencies, null, ['source-facts-unreadable'], now);
    }
    if (!facts) {
        return reject(input, dependencies, null, ['source-facts-unavailable'], now);
    }
    // The queued job derived its chain from the token mint prefix; the facts come
    // from the immutable source event. If they disagree, one of them is about a
    // different trade and neither can be trusted to gate this claim.
    if (facts.chain !== input.chain) {
        return reject(input, dependencies, facts, ['source-chain-mismatch'], now);
    }
    const decision = evaluateCopyPolicy({
        chain: facts.chain,
        selectedWallet: facts.walletKnown && facts.walletStatus === 'active',
        selectedCluster: facts.clusterSelected,
        eventAt: facts.eventAt,
        now,
        maxEventAgeMs: thresholds.maxEventAgeMs,
        maxClockSkewMs: thresholds.maxClockSkewMs,
        sourceActivityUsd: facts.sourceActivityUsd,
        minimumSourceActivityUsd: thresholds.minimumSourceActivityUsd,
        // The remaining gates in `evaluateCopyPolicy` have owners elsewhere and are
        // passed satisfied so this boundary reports only what it actually decided:
        // liquidity and token safety by the signal-engine screen that has to pass
        // before a trade job is queued at all, exposure by the rolling 24h cap in
        // `handleJob` just above this call, and chain readiness by `resolveChainMode`
        // plus the `execMode === 'off'` return. Duplicating them here with a second
        // set of thresholds would give two answers to the same question.
        liquidityUsd: 0,
        minimumLiquidityUsd: 0,
        currentExposureUsd: 0,
        requestedExposureUsd: 0,
        maximumExposureUsd: 0,
        chainReady: true,
        supportedAsset: true,
        safetyAllowed: true
    });
    const reasons = [...decision.reasons];
    if (!facts.walletKnown) {
        reasons.push('source-wallet-untracked');
    }
    // `evaluateCopyPolicy` measures activity in USD only. A wallet can clear a USD
    // floor on a single outsized trade while having no track record at all, which
    // is the case a count floor catches.
    if (facts.walletTradeCount < thresholds.minimumSourceTradeCount) {
        reasons.push('source-trade-count-below-minimum');
    }
    if (reasons.length > 0) {
        return reject(input, dependencies, facts, [...new Set(reasons)], now);
    }
    return { allowed: true, facts };
}
async function reject(input, dependencies, facts, reasons, rejectedAt) {
    try {
        await dependencies.recordRejection({
            account: input.account,
            signalId: input.signalId,
            chain: facts?.chain ?? input.chain,
            walletAddress: facts?.walletAddress ?? null,
            reasons,
            rejectedAt
        });
    }
    catch (error) {
        // Losing the audit row is bad, but executing a trade we already decided
        // against is worse. The decision stands either way.
        console.error(`[trade-executor] failed to record copy-eligibility rejection for signal ${input.signalId}`, error);
    }
    return { allowed: false, reasons };
}
//# sourceMappingURL=copy-eligibility.js.map