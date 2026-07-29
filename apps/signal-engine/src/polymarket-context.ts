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
