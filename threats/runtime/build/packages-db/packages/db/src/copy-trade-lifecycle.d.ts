import type { PoolClient } from 'pg';
import { type Chain, type CopyExecutionMode, type CopyExecutionState, type SourceConfirmationState, type SourceTradeSide } from '@swat/shared';
import { type ConfirmedQuoteTotal, type QuoteLegInput, type QuoteLegValuation } from './quote-valuation.js';
export type DecimalInput = string | number;
export type SourceEventType = 'transaction' | 'order' | 'venue_trade';
export type ExecutionEvidenceType = 'chain_receipt' | 'venue_fill' | 'balance_reconciliation' | 'paper_simulation';
export interface SourceTradeEventInput {
    chain: Chain;
    sourceEventType: SourceEventType;
    sourceEventId: string;
    sourceEventIndex?: string;
    transactionHash?: string | null;
    walletAddress: string;
    tokenMint: string;
    side: SourceTradeSide;
    quantity: DecimalInput;
    amountUsd?: DecimalInput | null;
    priceUsd?: DecimalInput | null;
    feeUsd?: DecimalInput | null;
    eventAt: Date;
    observedAt?: Date;
    confirmationState: SourceConfirmationState;
    confirmationEvidenceId: string;
}
export interface CanonicalSourceTrade {
    id: string;
    chain: Chain;
    sourceEventType: SourceEventType;
    sourceEventId: string;
    sourceEventIndex: string;
    transactionHash: string | null;
    walletAddress: string;
    tokenMint: string;
    side: SourceTradeSide;
    quantity: string;
    amountUsd: string | null;
    priceUsd: string | null;
    feeUsd?: string | null;
    eventAt: Date;
    observedAt: Date;
    confirmationState: SourceConfirmationState;
}
export interface PositionRecord {
    walletAddress: string;
    chain: Chain;
    tokenMint: string;
    confirmedQuantity: string;
    costBasisUsd: string;
    totalAcquiredQuantity: string;
    totalReducedQuantity: string;
    unmatchedReductionQuantity: string;
    lastEventAt: Date | null;
}
export interface CopyExecutionRecord {
    id: string;
    signalId: string | null;
    sourceTradeId: string | null;
    exitLotId?: string | null;
    exitTrigger?: 'close-all' | 'stop-loss' | 'manual' | 'redemption' | null;
    chain: Chain;
    targetAccount: string;
    /**
     * Owning tenant, or `null` for the pre-multi-tenant operator account.
     *
     * This is the dimension that separates two users in paper mode, where they
     * share one synthetic `targetAccount` per chain (S4-10, migration 050).
     */
    userId: string | null;
    tokenMint: string;
    direction: 'buy' | 'sell';
    executionMode: CopyExecutionMode;
    clientOrderId: string;
    state: CopyExecutionState;
    requestedBaseQuantity: string | null;
    requestedQuoteQuantity: string | null;
    confirmedBaseQuantity: string;
    /**
     * USD sum over confirmed fills whose USD value is known.
     *
     * `null` means *unknown*: at least one confirmed fill exists and none of them
     * carries a USD value. `'0'` means a genuine zero. Read alongside
     * {@link quoteUnassessedFillCount} before treating this as a settled total —
     * see migration 054 and `quote-valuation.ts` (S4-M35).
     */
    confirmedQuoteQuantity: string | null;
    /** Confirmed fills omitted from `confirmedQuoteQuantity` because their USD value is unknown. */
    quoteUnassessedFillCount: number;
    reservedBaseQuantity: string;
    submissionAttempts: number;
    maxSubmissionAttempts: number;
    simulationId: string | null;
    submissionType: 'transaction' | 'order' | null;
    submissionId: string | null;
    nextReconciliationAt: Date | null;
    reconciliationClaimId: string | null;
    reconciliationAttempts: number;
    maxReconciliationAttempts: number;
    sourcePositionBeforeQuantity: string | null;
    sourceSellFraction: string | null;
}
export interface SourceTradeSignalCandidate {
    sourceTradeId: string;
    chain: Chain;
    walletAddress: string;
    tokenMint: string;
    side: 'buy' | 'sell';
    quantity: string;
    amountUsd: string | null;
    priceUsd: string | null;
    feeUsd?: string | null;
    eventAt: Date;
    walletScore: number;
    walletTier: string | null;
    clusterId: string | null;
    clusterConfidence: number;
}
export interface CopyPositionRecord {
    /** Surrogate key added by migration 050; the natural key is no longer unique. */
    id: string;
    targetAccount: string;
    chain: Chain;
    tokenMint: string;
    /** Owning tenant, or `null` for the pre-multi-tenant operator account. */
    userId: string | null;
    confirmedQuantity: string;
    reservedSellQuantity: string;
    costBasisUsd: string;
    /**
     * Applied buy fills that contributed nothing to `costBasisUsd` because neither a
     * USD quote value nor a USD price was recorded for them.
     *
     * Non-zero means `costBasisUsd` is a lower bound, not the whole basis. Present so
     * a caller cannot read the number without also seeing what it omits (S4-M35).
     */
    costBasisUnvaluedFillCount: number;
    totalAcquiredQuantity: string;
    totalReducedQuantity: string;
    unmatchedReductionQuantity: string;
    lastEvidenceAt: Date | null;
}
/**
 * Normalise an acting tenant id to either a canonical UUID or `null`.
 *
 * `null` is a real, load-bearing value here, not a missing one: migration 050
 * gives every legacy operator row `user_id NULL`, and the tenancy-aware unique
 * indexes are declared `NULLS NOT DISTINCT` so those rows still collide with
 * each other. That means a caller that has no user in scope MUST reach `null`
 * and not some placeholder string — a placeholder would be a distinct tenant
 * and would silently fork the operator's position ledger.
 *
 * `users.id` is a UUID (039_users.sql:22), so anything that is not
 * UUID-shaped is a bug in the caller rather than a tenant we have never seen.
 * Rejecting it here keeps a stray account label (`'operator'`, an email, a
 * chain-prefixed address) from being written into the tenancy column, where it
 * would fail the foreign key at a confusing distance from its origin.
 */
export declare function normalizeTenantId(value: string | null | undefined): string | null;
export declare function recordSourceTradeEvent(input: SourceTradeEventInput): Promise<{
    event: CanonicalSourceTrade;
    position: PositionRecord;
    inserted: boolean;
}>;
export declare function advanceSourceTradeConfirmation(input: {
    sourceTradeId: string;
    confirmationState: SourceConfirmationState;
    evidenceId: string;
    observedAt?: Date;
}): Promise<{
    event: CanonicalSourceTrade;
    position: PositionRecord;
}>;
/**
 * The canonical source trade by id — the master's own event.
 *
 * Exists for the mirroring price bound (`S4-M16`): a copied order has to be
 * bounded against the price the *master* actually got, and `copy_executions.price_usd`
 * is **our** fill, not theirs. `source_trades.price_usd` is the master's, and this
 * is the only read that surfaces it to the executor.
 *
 * A plain read rather than one of the `FOR SHARE` lookups above, because the
 * caller is sizing a bound before submitting and is not mutating the row — taking
 * a row lock on the money path to read one price would serialise mirrors behind
 * each other for nothing. `price_usd` is nullable, and a null is returned as null
 * rather than defaulted: the mirror planner fails closed on an absent master
 * price, which is the whole point of not inventing one.
 */
export declare function getCanonicalSourceTradeById(sourceTradeId: string): Promise<CanonicalSourceTrade | null>;
export declare function getSourceTradeByIdentity(input: {
    chain: Chain;
    sourceEventType: SourceEventType;
    sourceEventId: string;
    sourceEventIndex?: string;
}): Promise<CanonicalSourceTrade | null>;
export declare function listSourceTradeSignalCandidates(input: {
    sourceTradeId?: string;
    maxEventAgeMs: number;
    limit?: number;
    now?: Date;
}): Promise<SourceTradeSignalCandidate[]>;
export declare function markSourceTradeSignalDispatched(signalId: string, dispatchedAt?: Date): Promise<boolean>;
export declare function insertSourceTradeSignal(input: {
    sourceTradeId: string;
    clusterId?: string | null;
    confidence: number;
    signalScore: number;
    triggerData: Record<string, unknown>;
    safetyFlags?: string[];
    safetyWarnings?: string[];
    tokenName?: string | null;
    tokenSymbol?: string | null;
    maxEventAgeMs: number;
    maxPositionEvidenceAgeMs: number;
    now?: Date;
}): Promise<{
    inserted: boolean;
    id: string;
    sourceTradeId: string;
    chain: Chain;
    tokenMint: string;
    direction: 'buy' | 'sell';
    sourcePositionBeforeQuantity: string | null;
    sourceSellFraction: string | null;
}>;
export declare function buildCopyExecutionClientOrderId(input: {
    sourceTradeId: string;
    chain: Chain;
    targetAccount: string;
    executionMode: CopyExecutionMode;
    /** Acting tenant; `null` for the pre-multi-tenant operator account. */
    userId?: string | null;
}): string;
export interface CopyExecutionRequestInput {
    sourceTradeId: string;
    targetAccount: string;
    /**
     * Acting tenant. Omit or pass `null` for the pre-multi-tenant operator
     * account — `null` is a real value here (see `normalizeTenantId`), not a
     * missing one, and is what every legacy row carries.
     */
    userId?: string | null;
    executionMode: CopyExecutionMode;
    requestedBaseQuantity?: DecimalInput | null;
    requestedQuoteQuantity?: DecimalInput | null;
    maxSubmissionAttempts?: number;
    maxReconciliationAttempts?: number;
}
export declare function requestCopyExecution(input: CopyExecutionRequestInput): Promise<{
    execution: CopyExecutionRecord;
    created: boolean;
}>;
export interface LotExitExecutionInput {
    lotId: string;
    userId: string | null;
    requestId: string;
    trigger: 'close-all' | 'stop-loss' | 'manual' | 'redemption';
    requestedBaseQuantity?: DecimalInput;
}
export declare function claimLotExitExecution(input: LotExitExecutionInput): Promise<{
    execution: CopyExecutionRecord;
    created: boolean;
}>;
export declare function claimLotExitExecutionWithClient(client: PoolClient, input: LotExitExecutionInput): Promise<{
    execution: CopyExecutionRecord;
    created: boolean;
}>;
export declare function claimSourceSignalForCopyExecution(input: {
    signalId: string;
    targetAccount: string;
    /**
     * Acting tenant. Omit or pass `null` for the pre-multi-tenant operator
     * account. In paper mode `targetAccount` is one synthetic address shared by
     * every user on the chain, so this is the ONLY thing separating two users'
     * positions and executions (S4-10, migration 050).
     */
    userId?: string | null;
    executionMode: CopyExecutionMode;
    requestedBaseQuantity?: DecimalInput | null;
    requestedQuoteQuantity?: DecimalInput | null;
    maxPositionEvidenceAgeMs: number;
    maxSubmissionAttempts?: number;
    maxReconciliationAttempts?: number;
    now?: Date;
}): Promise<{
    execution: CopyExecutionRecord | null;
    created: boolean;
    claimed: boolean;
    reason?: string;
}>;
export declare function transitionCopyExecution(input: {
    executionId: string;
    nextState: 'simulated' | 'submitted' | 'failed' | 'cancelled' | 'reconciliation_required';
    reason?: string | null;
    simulationId?: string | null;
    submissionType?: 'transaction' | 'order' | null;
    submissionId?: string | null;
    nextReconciliationAt?: Date | null;
}): Promise<CopyExecutionRecord>;
export interface RecordCopyExecutionEvidenceInput {
    executionId: string;
    evidenceType: ExecutionEvidenceType;
    evidenceId: string;
    baseQuantity: DecimalInput;
    /**
     * What was paid, in the unit the venue actually settled in.
     *
     * Structured rather than a bare `quoteQuantity` number on purpose (S4-M35): the
     * old field took whatever the executor path had — USD from Polymarket and paper,
     * SOL from Solana live, ETH from robinhood live — and nothing recorded which.
     * There is deliberately no way to hand this function an amount without its
     * currency. The USD conversion happens here, once, through `valuateQuoteLeg`.
     *
     * Omit or pass `null` when the venue reported no quote amount at all.
     */
    quoteLeg?: QuoteLegInput | null;
    priceUsd?: DecimalInput | null;
    confirmationState: SourceConfirmationState;
    completesExecution: boolean;
    occurredAt: Date;
    observedAt?: Date;
}
export interface RecordCopyExecutionEvidenceResult {
    execution: CopyExecutionRecord;
    position: CopyPositionRecord;
    /** How this single fill's quote leg was valued, including why it was not. */
    fillValuation: QuoteLegValuation;
    /** Whether the execution's confirmed USD total now accounts for every fill. */
    confirmedQuoteTotal: ConfirmedQuoteTotal;
}
export declare function recordCopyExecutionEvidence(input: RecordCopyExecutionEvidenceInput): Promise<RecordCopyExecutionEvidenceResult>;
export declare function recordCopyExecutionEvidenceWithClient(client: PoolClient, input: RecordCopyExecutionEvidenceInput): Promise<RecordCopyExecutionEvidenceResult>;
export declare function getCopyExecutionById(id: string): Promise<CopyExecutionRecord | null>;
export declare function getCopyExecutionByClientOrderId(input: {
    chain: Chain;
    targetAccount: string;
    clientOrderId: string;
}): Promise<CopyExecutionRecord | null>;
export declare function getCopyExecutionByClientOrderIdentity(input: {
    chain: Chain;
    clientOrderId: string;
}): Promise<CopyExecutionRecord | null>;
export declare function getCopyExecutionBySubmissionIdentity(input: {
    chain: Chain;
    submissionType: 'transaction' | 'order';
    submissionId: string;
}): Promise<CopyExecutionRecord | null>;
export declare function claimCopyExecutionsForReconciliation(input?: {
    chain?: Chain;
    limit?: number;
    staleClaimBefore?: Date;
}): Promise<CopyExecutionRecord[]>;
export declare function releaseCopyExecutionReconciliationClaim(input: {
    executionId: string;
    claimId: string;
    retryAt?: Date | null;
}): Promise<boolean>;
//# sourceMappingURL=copy-trade-lifecycle.d.ts.map