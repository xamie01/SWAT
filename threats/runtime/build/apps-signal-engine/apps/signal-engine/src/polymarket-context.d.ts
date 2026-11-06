import type { PolymarketOutcomeContext } from '@swat/db';
export declare function requirePolymarketSignalContext(context: PolymarketOutcomeContext | null, tokenMint: string): {
    tokenName: string;
    tokenSymbol: string;
    triggerData: Record<string, unknown>;
};
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
export declare function isPlaceholderOrUnstableOutcome(event: {
    enableNegRisk?: boolean;
    negRiskAugmented?: boolean;
}, market: {
    outcome: string;
    groupItemTitle?: string;
}): PolymarketNegRiskAssessment;
//# sourceMappingURL=polymarket-context.d.ts.map