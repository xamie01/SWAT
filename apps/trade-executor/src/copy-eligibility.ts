import type { CopyEligibilityFacts, CopyEligibilityRejection } from '@swat/db';
import type { Chain } from '@swat/shared';
import { evaluateCopyPolicy } from '@swat/shared';
import { evaluateExecutionPolicy, type ExecutionPolicyInput } from './policy.js';

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

export interface CopyEligibilityThresholds {
  /** Reject a source event older than this — the price it implies is gone. */
  maxEventAgeMs: number;
  /** Tolerance for an indexer clock running ahead of ours. */
  maxClockSkewMs: number;
  /** Confirmed USD the source wallet must have traded in the lookback window. */
  minimumSourceActivityUsd: number;
  /** Lifetime recorded trades the source wallet must have. */
  minimumSourceTradeCount: number;
  /** How far back `minimumSourceActivityUsd` is measured. */
  activityLookbackMs: number;
}

export type CopyEligibilityDecision =
  | { allowed: true; facts: CopyEligibilityFacts }
  | { allowed: false; reasons: string[] };

export interface ExecutionCopyEligibilityFacts extends CopyEligibilityFacts {
  /** Immutable source identity, required whenever current execution policy is supplied. */
  tokenMint?: string;
  direction?: 'buy' | 'sell';
}

export interface CopyEligibilityDependencies {
  loadFacts: (input: {
    signalId: string;
    activityLookbackMs: number;
    now: Date;
  }) => Promise<ExecutionCopyEligibilityFacts | null>;
  recordRejection: (input: CopyEligibilityRejection) => Promise<unknown>;
  thresholds: CopyEligibilityThresholds;
  now?: () => Date;
}

export async function enforceCopyEligibility(
  input: {
    account: string; signalId: string; chain: Chain;
    /** Current policy/lot facts loaded by the worker; never a queue-supplied bypass. */
    policy?: ExecutionPolicyInput;
  },
  dependencies: CopyEligibilityDependencies
): Promise<CopyEligibilityDecision> {
  const { thresholds } = dependencies;
  const now = dependencies.now?.() ?? new Date();

  let facts: ExecutionCopyEligibilityFacts | null;
  try {
    facts = await dependencies.loadFacts({
      signalId: input.signalId,
      activityLookbackMs: thresholds.activityLookbackMs,
      now
    });
  } catch (error) {
    // A policy that cannot read its own inputs must not wave the trade through.
    console.error(
      `[trade-executor] copy-eligibility lookup failed for signal ${input.signalId}`,
      error
    );
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
  if (facts.signalId !== input.signalId) {
    return reject(input, dependencies, facts, ['source-signal-mismatch'], now);
  }

  let reducing = false;
  if (input.policy) {
    if (input.policy.scope.account !== input.account || input.policy.scope.chain !== facts.chain
      || input.policy.scope.masterWalletAddress !== facts.walletAddress
      || input.policy.scope.tokenMint !== facts.tokenMint || input.policy.direction !== facts.direction) {
      return reject(input, dependencies, facts, ['source-policy-scope-mismatch'], now);
    }
    const policy = evaluateExecutionPolicy(input.policy);
    if (!policy.allowed) return reject(input, dependencies, facts, [policy.reason], now);
    reducing = policy.reducing;
  }

  const decision = evaluateCopyPolicy({
    chain: facts.chain,
    selectedWallet: reducing || (facts.walletKnown && facts.walletStatus === 'active'),
    selectedCluster: facts.clusterSelected,
    eventAt: facts.eventAt,
    now,
    maxEventAgeMs: thresholds.maxEventAgeMs,
    maxClockSkewMs: thresholds.maxClockSkewMs,
    sourceActivityUsd: facts.sourceActivityUsd,
    minimumSourceActivityUsd: reducing ? 0 : thresholds.minimumSourceActivityUsd,
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
  if (!reducing && !facts.walletKnown) {
    reasons.push('source-wallet-untracked');
  }
  // `evaluateCopyPolicy` measures activity in USD only. A wallet can clear a USD
  // floor on a single outsized trade while having no track record at all, which
  // is the case a count floor catches.
  if (!reducing && facts.walletTradeCount < thresholds.minimumSourceTradeCount) {
    reasons.push('source-trade-count-below-minimum');
  }

  if (reasons.length > 0) {
    return reject(input, dependencies, facts, [...new Set(reasons)], now);
  }
  return { allowed: true, facts };
}

async function reject(
  input: { account: string; signalId: string; chain: Chain },
  dependencies: CopyEligibilityDependencies,
  facts: CopyEligibilityFacts | null,
  reasons: string[],
  rejectedAt: Date
): Promise<CopyEligibilityDecision> {
  try {
    await dependencies.recordRejection({
      account: input.account,
      signalId: input.signalId,
      chain: facts?.chain ?? input.chain,
      walletAddress: facts?.walletAddress ?? null,
      reasons,
      rejectedAt
    });
  } catch (error) {
    // Losing the audit row is bad, but executing a trade we already decided
    // against is worse. The decision stands either way.
    console.error(
      `[trade-executor] failed to record copy-eligibility rejection for signal ${input.signalId}`,
      error
    );
  }
  return { allowed: false, reasons };
}
