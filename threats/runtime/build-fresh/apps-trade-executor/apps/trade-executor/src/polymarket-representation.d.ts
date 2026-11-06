export interface PolymarketOutcomePosition {
    /** Normalised `0x`-prefixed 64-hex condition id of the market holding this outcome. */
    readonly conditionId: string;
    /** The ERC-1155 outcome token id, as an unpadded decimal string. */
    readonly tokenId: string;
    /** Index of this outcome within its market — 0 or 1, since a market has two. */
    readonly outcomeIndex: number;
    /** The outcome label, preserved verbatim ('Yes', 'No', or a named outcome). */
    readonly outcome: string;
    /** Neg-risk membership. Context for reasoning; never an input to the key. */
    readonly negRisk: boolean;
}
export interface PolymarketNegRiskGroup {
    /**
     * Condition ids of the sibling markets in the neg-risk event, excluding the
     * position's own. Absent when we have not read the event, which makes the
     * complement undeterminable rather than empty.
     */
    readonly siblingConditionIds?: readonly string[];
    /**
     * Whether the event uses augmented neg risk. When true the outcome set can grow
     * after trading begins, so any complement we compute is a snapshot with an
     * expiry we cannot see.
     */
    readonly augmented?: boolean;
}
export type PolymarketComplementMechanism = 
/** `mergePositions` on the market's collateral adapter, partition [1, 2]. */
'merge-positions'
/** `convert` on the Neg Risk Adapter. */
 | 'neg-risk-convert';
export interface PolymarketComplementLeg {
    readonly conditionId: string;
    /** The outcome index that would have to be held in that condition. */
    readonly outcomeIndex: number;
}
export interface PolymarketComplementKnown {
    readonly kind: 'known';
    readonly mechanism: PolymarketComplementMechanism;
    /**
     * The positions the complement consists of. Length > 1, or spanning more than
     * one condition, is by itself proof that the complement is not this position.
     */
    readonly legs: readonly PolymarketComplementLeg[];
    /**
     * Always false. The complement becomes the same economic exposure only after an
     * on-chain call this executor does not make, so it is never a substitution we
     * are entitled to perform silently.
     */
    readonly interchangeableWithoutAction: false;
    /** False under augmented neg risk, where the outcome set can still change. */
    readonly outcomeSetStable: boolean;
}
export interface PolymarketComplementUndeterminable {
    readonly kind: 'undeterminable';
    readonly reason: string;
}
export type PolymarketComplement = PolymarketComplementKnown | PolymarketComplementUndeterminable;
/** Validate and normalise an outcome position, rejecting anything ambiguous. */
export declare function parsePolymarketOutcomePosition(input: {
    readonly conditionId: unknown;
    readonly tokenId: unknown;
    readonly outcomeIndex: unknown;
    readonly outcome: unknown;
    readonly negRisk?: unknown;
}): PolymarketOutcomePosition;
/**
 * The canonical position key: the chain-prefixed **outcome token** mint.
 *
 * Derived from the token id and nothing else. In particular it is not derived
 * from the condition id — a condition holds two outcomes, so a condition-keyed
 * position would merge them — and not from `negRisk`, which is context rather
 * than identity.
 */
export declare function polymarketPositionKey(position: PolymarketOutcomePosition): string;
/** Two positions are the same only when they are the same outcome token. */
export declare function isSamePolymarketPosition(left: PolymarketOutcomePosition, right: PolymarketOutcomePosition): boolean;
/**
 * Refuse a set of positions that a condition-level view would have collapsed.
 *
 * This is the guard the item asks for. Given the positions a caller is about to
 * net, aggregate, or write as one row, it throws when two of them share a
 * condition but name different outcomes — the shape that means someone has
 * reached the condition level and lost the outcome. Duplicates of the *same*
 * outcome token are fine; that is one position seen twice.
 *
 * Intended call sites are exposure aggregation and the `S4-M19` redemption
 * fan-out from `redeemPositions({conditionId})` back to positions.
 */
export declare function assertPolymarketPositionsDistinct(positions: readonly PolymarketOutcomePosition[]): void;
/**
 * Describe what this position's complement actually consists of.
 *
 * Returns a *description*, never a substitution. The point of the return value is
 * that a caller inspecting it cannot come away thinking the complement is one
 * interchangeable position: `interchangeableWithoutAction` is typed `false`, the
 * legs are enumerated, and `outcomeSetStable` reports when the set can still
 * change underneath us.
 */
export declare function describePolymarketComplement(position: PolymarketOutcomePosition, group?: PolymarketNegRiskGroup): PolymarketComplement;
//# sourceMappingURL=polymarket-representation.d.ts.map