import { createHash, timingSafeEqual } from 'node:crypto';

/** Keyless contracts: no pool, environment, signer, provider SDK or import-time work. */
export interface WithdrawalSqlClient {
  query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}
/** Must resolve only after COMMIT, reject/rollback on failure, and set non-bypass tenant RLS. */
export type WithdrawalTransaction = <T>(userId: string,
  operation: (client: WithdrawalSqlClient) => Promise<T>) => Promise<T>;
export type FinancialMode = 'paper' | 'live';
export type FinancialChain = 'solana' | 'polygon' | 'robinhood-chain';
export type FinancialStatus = 'awaiting-authorization' | 'queued' | 'prepared' | 'uncertain' | 'partial' | 'settled' | 'failed' | 'cancelled';
export class WithdrawalProtocolError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'WithdrawalProtocolError'; }
}
export function requireFinancial(condition: unknown, code: string): asserts condition {
  if (!condition) throw new WithdrawalProtocolError(code);
}
export function exactRaw(value: unknown, positive = false): string {
  requireFinancial(typeof value === 'string' && value.length <= 78 && /^(0|[1-9][0-9]*)$/.test(value), 'invalid-exact-raw');
  requireFinancial(!positive || value !== '0', 'invalid-exact-raw');
  return value;
}
export function financialText(value: unknown, code = 'invalid-financial-identity'): string {
  requireFinancial(typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\x00-\x1f]/.test(value) && value !== '*', code);
  return value;
}
export function financialUser(userId: string): string {
  financialText(userId); requireFinancial(userId !== '*', 'invalid-tenant'); return userId;
}
export function financialScale(scale: number): number {
  requireFinancial(Number.isSafeInteger(scale) && scale >= 0 && scale <= 36, 'invalid-asset-scale'); return scale;
}
export function financialTime(value: string): string {
  requireFinancial(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'invalid-expiry'); return value;
}
/** Canonical key ordering survives PostgreSQL jsonb normalization and process restart. */
export function financialHash(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical((input as Record<string, unknown>)[key])]));
    }
    return input;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function sameDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
export interface FinancialFee {
  readonly maxFeeRaw: string;
  readonly feeAssetId: string;
  readonly feeAssetScale: number;
  readonly feeFundingAccountId: string;
}
export function financialFee(fee: FinancialFee): FinancialFee {
  return { maxFeeRaw: exactRaw(fee.maxFeeRaw), feeAssetId: financialText(fee.feeAssetId),
    feeAssetScale: financialScale(fee.feeAssetScale), feeFundingAccountId: financialText(fee.feeFundingAccountId) };
}
export interface FinancialBudget {
  readonly purpose: 'funding' | 'exposure';
  readonly chain: string; readonly network: string; readonly mode: string;
  readonly accountId: string; readonly assetId: string; readonly assetScale: number;
  readonly amountRaw: string; readonly feeRaw: string;
}
export interface FinancialFundingEvidence {
  readonly userId: string; readonly chain: string; readonly network: string; readonly mode: string;
  readonly accountId: string; readonly assetId: string; readonly assetScale: number;
  readonly availableRaw: string; readonly observedAt: string; readonly validUntil: string; readonly proof: string;
}
export type FinancialFundingPort = (client: WithdrawalSqlClient, userId: string, budget: FinancialBudget) => Promise<FinancialFundingEvidence>;
export function financialBudgetKey(budget: FinancialBudget): string {
  return JSON.stringify([budget.purpose, budget.chain, budget.network, budget.accountId, budget.assetId, budget.assetScale, budget.mode]);
}
/** Deterministic multi-budget locks; combine ONLY truly identical funding denomination/account, never exposure with cash. */
export function combineFinancialBudgets(budgets: FinancialBudget[]): FinancialBudget[] {
  const combined = new Map<string, FinancialBudget>();
  for (const budget of budgets) {
    const key = financialBudgetKey(budget), previous = combined.get(key);
    combined.set(key, previous ? { ...previous,
      amountRaw: exactRaw((BigInt(previous.amountRaw) + BigInt(budget.amountRaw)).toString()),
      feeRaw: exactRaw((BigInt(previous.feeRaw) + BigInt(budget.feeRaw)).toString()) } : budget);
  }
  return [...combined.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([,budget]) => budget);
}
export function validateFinancialFunding(userId: string, budget: FinancialBudget, evidence: FinancialFundingEvidence, now: string, maxAgeMs: number) {
  requireFinancial(evidence.userId === userId && evidence.chain === budget.chain && evidence.network === budget.network
    && evidence.mode === budget.mode && evidence.accountId === budget.accountId && evidence.assetId === budget.assetId
    && evidence.assetScale === budget.assetScale, 'financial-fee-funding-scope-mismatch');
  const time = Date.parse(financialTime(now)), observed = Date.parse(financialTime(evidence.observedAt));
  requireFinancial(observed <= time && time - observed <= maxAgeMs && Date.parse(financialTime(evidence.validUntil)) > time, 'financial-fee-funding-stale');
  financialText(evidence.proof); exactRaw(evidence.availableRaw);
}
export interface WithdrawalIntent extends FinancialFee {
  readonly version: 1;
  readonly kind: 'withdrawal';
  readonly userId: string;
  readonly requestKey: string;
  readonly chain: FinancialChain;
  /** Actual network identity, not just a chain label (e.g. mainnet genesis hash). */
  readonly network: string;
  readonly assetId: string;
  readonly assetScale: number;
  readonly sourceWalletId: string;
  readonly destination: string;
  readonly amountRaw: string;
  /** Exact network-fee ceiling included in the user's one-use authorization. */
  readonly maxFeeRaw: string;
  readonly mode: FinancialMode;
  readonly expiresAt: string;
}
export type WithdrawalRequest = Omit<WithdrawalIntent, 'version' | 'kind' | 'userId' | 'expiresAt'>;
export function withdrawalIntent(userId: string, request: WithdrawalRequest, expiresAt: string): WithdrawalIntent {
  financialUser(userId);
  requireFinancial(['solana', 'polygon', 'robinhood-chain'].includes(request.chain), 'invalid-chain');
  requireFinancial(request.mode === 'paper' || request.mode === 'live', 'invalid-mode');
  const destination = financialText(request.destination);
  requireFinancial(request.chain === 'solana'
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(destination)
    : /^0x[a-f0-9]{40}$/.test(destination), 'invalid-canonical-destination');
  return Object.freeze({ version: 1, kind: 'withdrawal', userId,
    requestKey: financialText(request.requestKey), chain: request.chain, network: financialText(request.network),
    assetId: financialText(request.assetId), assetScale: financialScale(request.assetScale),
    sourceWalletId: financialText(request.sourceWalletId), destination, amountRaw: exactRaw(request.amountRaw, true),
    ...financialFee(request), mode: request.mode, expiresAt: financialTime(expiresAt) });
}
export interface FinancialRecord<Intent = WithdrawalIntent> {
  readonly id: string;
  readonly userId: string;
  readonly intent: Intent;
  readonly intentHash: string;
  readonly status: FinancialStatus;
  readonly completedRaw: string;
  readonly terminal: boolean;
  readonly createdAt: string;
  readonly cancellationReason?: string | null;
}
export interface FinancialAttempt {
  readonly id: string;
  readonly intentId: string;
  readonly userId: string;
  readonly clientOrderId: string;
  readonly intentHash: string;
  readonly state: 'prepared' | 'uncertain' | 'partial' | 'settled' | 'failed';
  readonly completedRaw: string;
  readonly completedFeeRaw: string;
  readonly terminal: boolean;
}
/** Authenticated verifier output; never accept this projection directly from a public route/job. */
export interface FinancialReceipt {
  readonly receiptId: string;
  readonly providerIdentity: string;
  readonly proof: string;
  readonly intentId: string;
  readonly intentHash: string;
  readonly attemptId: string;
  readonly clientOrderId: string;
  readonly cumulativeRaw: string;
  readonly feeRaw: string;
  readonly feeAssetId: string;
  readonly feeAssetScale: number;
  readonly feeFundingAccountId: string;
  /** Required for any terminal zero-fill rejection/absence; independent verifier authenticates a provider tombstone. */
  readonly noFutureAcceptance?: FinancialNoFutureAcceptance;
  readonly terminal: boolean;
  readonly outcome: 'fill' | 'rejected' | 'absent-final';
  readonly observedAt: string;
}
export interface FinancialNoFutureAcceptance {
  readonly intentId: string; readonly intentHash: string; readonly attemptId: string; readonly clientOrderId: string;
  readonly providerIdentity: string; readonly tombstoneId: string; readonly proof: string;
  readonly effectiveAt: string; readonly guarantee: 'permanent-no-future-acceptance';
}
export interface FinancialAuthorization {
  readonly intentId: string; readonly intentHash: string; readonly attemptId: string; readonly clientOrderId: string;
  readonly userId: string; readonly chain: string; readonly network: string; readonly mode: string;
  readonly providerIdentity: string; readonly deadline: string; readonly issuedAt: string;
  readonly atomicDeadline: true; readonly scopeProof: string;
  /** Opaque execution handle; never returned through a route. */
  readonly handle: unknown;
}
export function validateFinancialAuthorization<I extends {chain: string; network: string; mode: string; expiresAt: string}>(
  record: FinancialRecord<I>, attempt: FinancialAttempt, authorization: FinancialAuthorization, now: string) {
  requireFinancial(authorization.intentId === record.id && authorization.intentHash === record.intentHash
    && authorization.attemptId === attempt.id && authorization.clientOrderId === attempt.clientOrderId
    && authorization.userId === record.userId && authorization.chain === record.intent.chain
    && authorization.network === record.intent.network && authorization.mode === record.intent.mode
    && authorization.atomicDeadline === true, 'financial-authorization-scope-mismatch');
  financialText(authorization.providerIdentity); financialText(authorization.scopeProof);
  const deadline = Date.parse(financialTime(authorization.deadline)), time = Date.parse(financialTime(now));
  requireFinancial(Date.parse(financialTime(authorization.issuedAt)) <= time
    && deadline <= Date.parse(record.intent.expiresAt) && deadline > time, 'financial-authorization-expired');
}
export function validateNoFutureAcceptance<I>(record: FinancialRecord<I>, attempt: FinancialAttempt, receipt: FinancialReceipt) {
  const proof = receipt.noFutureAcceptance;
  requireFinancial(proof && proof.intentId === record.id && proof.intentHash === record.intentHash && proof.attemptId === attempt.id
    && proof.clientOrderId === attempt.clientOrderId && proof.providerIdentity === receipt.providerIdentity
    && proof.guarantee === 'permanent-no-future-acceptance', 'financial-no-future-acceptance-unavailable');
  financialText(proof.tombstoneId); financialText(proof.proof);
  requireFinancial(Date.parse(financialTime(proof.effectiveAt)) <= Date.parse(receipt.observedAt), 'financial-tombstone-not-effective');
}
export interface FinancialEffectPorts<Intent> {
  /** Provider-authenticated attempt-bound scope; provider atomically refuses expired deadline even after local async pauses. */
  authorize(record: FinancialRecord<Intent>, attempt: FinancialAttempt): Promise<FinancialAuthorization>;
  /** MUST enforce the exact deadline/scope at actual acceptance, not just in a local preflight. */
  submit(record: FinancialRecord<Intent>, attempt: FinancialAttempt, authorization: FinancialAuthorization): Promise<unknown>;
  reconcile(record: FinancialRecord<Intent>, attempt: FinancialAttempt): Promise<unknown>;
  /** Must authenticate provider evidence, scope, finality and full cumulative quantity. Null means unknown. */
  verify(record: FinancialRecord<Intent>, attempt: FinancialAttempt, observation: unknown): Promise<FinancialReceipt | null>;
}
export const WITHDRAWAL_UNAVAILABLE = Object.freeze({
  state: 'blocked-on-external-capability' as const, supported: false as const,
  sourceImplemented: true, injectedVerified: false, runtimeAccepted: false, liveAccepted: false,
  unavailableReasons: ['durable-schema-runtime-unaccepted', 'trusted-custody-balance-unavailable',
    'one-use-otp-service-unavailable', 'authorized-transfer-and-reconciliation-unavailable']
});
