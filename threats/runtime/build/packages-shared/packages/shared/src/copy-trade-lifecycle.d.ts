import type { Chain, ExecutionMode } from './types.js';
export type SourceTradeSide = 'buy' | 'sell' | 'transfer_in' | 'transfer_out';
export type SourceConfirmationState = 'observed' | 'confirmed' | 'finalized' | 'reversed';
export type CopyExecutionState = 'requested' | 'simulated' | 'submitted' | 'partially_filled' | 'confirmed' | 'failed' | 'cancelled' | 'reconciliation_required';
export type CopyExecutionMode = Exclude<ExecutionMode, 'off' | 'live+shadow'> | 'shadow';
export interface PositionEvent {
    id: string;
    side: SourceTradeSide;
    quantity: number;
    amountUsd?: number | null;
    priceUsd?: number | null;
    eventAt: Date;
}
export interface PositionSnapshot {
    confirmedQuantity: number;
    costBasisUsd: number;
    totalAcquiredQuantity: number;
    totalReducedQuantity: number;
    unmatchedReductionQuantity: number;
}
export interface CopyPolicyInput {
    chain: Chain;
    selectedWallet: boolean;
    selectedCluster: boolean;
    eventAt: Date;
    now: Date;
    maxEventAgeMs: number;
    maxClockSkewMs?: number;
    sourceActivityUsd: number;
    minimumSourceActivityUsd: number;
    liquidityUsd: number;
    minimumLiquidityUsd: number;
    currentExposureUsd: number;
    requestedExposureUsd: number;
    maximumExposureUsd: number;
    chainReady: boolean;
    supportedAsset: boolean;
    safetyAllowed: boolean;
    safetyReasons?: string[];
}
export interface CopyPolicyDecision {
    allowed: boolean;
    reasons: string[];
}
/**
 * Rebuild a position deterministically from confirmed, immutable events.
 * Reductions are capped to the quantity proven by this ledger; any excess is
 * retained as an unmatched reduction instead of creating a negative holding.
 */
export declare function reducePositionEvents(opening: Pick<PositionSnapshot, 'confirmedQuantity' | 'costBasisUsd'>, events: readonly PositionEvent[]): PositionSnapshot;
export declare function isAppliedSourceConfirmation(state: SourceConfirmationState): boolean;
export declare function canTransitionSourceConfirmation(current: SourceConfirmationState, next: SourceConfirmationState): boolean;
export declare function canTransitionCopyExecution(current: CopyExecutionState, next: CopyExecutionState): boolean;
/** Fail-closed policy evaluation shared by all chain adapters. */
export declare function evaluateCopyPolicy(input: CopyPolicyInput): CopyPolicyDecision;
export declare function calculateProportionalSell(input: {
    sourceReductionQuantity: number;
    sourcePositionBeforeQuantity: number;
    swatConfirmedAvailableQuantity: number;
}): {
    proportion: number;
    quantity: number;
};
//# sourceMappingURL=copy-trade-lifecycle.d.ts.map