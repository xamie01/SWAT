import type { PolymarketOutcomeContext } from '@swat/db';

export function requirePolymarketSignalContext(
  context: PolymarketOutcomeContext | null,
  tokenMint: string
): {
  tokenName: string;
  tokenSymbol: string;
  triggerData: Record<string, unknown>;
} {
  if (!context || !context.contextComplete) {
    throw new Error(`Missing complete Polymarket context for ${tokenMint}`);
  }
  if (
    !context.question.trim()
    || !context.outcome.trim()
    || Number.isNaN(context.endDate.getTime())
    || !context.marketStatus.trim()
    || !context.resolutionStatus.trim()
    || !Number.isFinite(Number(context.tickSize))
    || Number(context.tickSize) <= 0
  ) {
    throw new Error(`Incomplete Polymarket context for ${tokenMint}`);
  }

  return {
    tokenName: context.question,
    tokenSymbol: context.outcome.toUpperCase().slice(0, 20),
    triggerData: {
      pmConditionId: context.conditionId,
      pmQuestion: context.question,
      pmOutcome: context.outcome,
      pmEndDate: context.endDate.toISOString(),
      pmState: context.marketStatus,
      pmTickSize: context.tickSize,
      pmNegRisk: context.negRisk,
      pmAcceptingOrders: context.acceptingOrders,
      pmResolutionStatus: context.resolutionStatus
    }
  };
}

/**
 * Assessment result for augmented negative-risk placeholder and unstable outcome checking (S4-M30).
 */
export interface PolymarketNegRiskAssessment {
  readonly isPlaceholder: boolean;
  readonly code?: 'polymarket-augmented-placeholder-unstable' | 'polymarket-placeholder-unnamed';
  readonly reason?: string;
}

/**
 * Evaluates whether a Polymarket outcome is a dynamic placeholder or unstable "Other" slot (S4-M30).
 *
 * The venue documents a warning for augmented negative-risk markets (enableNegRisk && negRiskAugmented):
 * Trade only named outcomes; ignore placeholders until named, and avoid trading the "Other" outcome
 * directly because its legal/market definition dynamically contracts whenever a placeholder is clarified.
 */
export function isPlaceholderOrUnstableOutcome(
  event: { enableNegRisk?: boolean; negRiskAugmented?: boolean },
  market: { outcome: string; groupItemTitle?: string }
): PolymarketNegRiskAssessment {
  if (!event.enableNegRisk || !event.negRiskAugmented) {
    return { isPlaceholder: false }; // Standard neg-risk or binary market; outcomes are fixed
  }

  const label = (market.groupItemTitle || market.outcome || '').trim().toLowerCase();

  // 1. Explicit dynamic "Other"
  if (label === 'other') {
    return {
      isPlaceholder: true,
      code: 'polymarket-augmented-placeholder-unstable',
      reason: 'Augmented negative-risk "Other" outcome is dynamic and legally changes definition as candidates are clarified'
    };
  }

  // 2. Polymarket placeholder convention: "Person A", "Candidate X", "Placeholder", etc.
  if (/^(person|candidate|slot|outcome)\s+[a-z0-9]+$/i.test(label) || label.includes('placeholder')) {
    return {
      isPlaceholder: true,
      code: 'polymarket-placeholder-unnamed',
      reason: `Placeholder outcome "${market.outcome}" is an unclarified reserve slot on an augmented neg-risk market`
    };
  }

  return { isPlaceholder: false };
}
