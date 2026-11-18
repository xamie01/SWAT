import {
  lpAcquisitionHash, lpAssertPlan, lpEconomics, lpExactHash, lpKey, lpMicro, lpRaw, lpSameAmount, lpSnapshot, lpTime,
  type LpExactOperation, type LpExactPosition, type LpPaperQuote, type LpPaperReceipt
} from './lp-exact.js';
import { lpOperationIntent, lpValidateQuote, lpValidateReceipt, type LpQuoteInput,
  type LpAcquisitionCommit, type LpOperationCommit } from './lp-paper-service.js';

/** Full context is resolved by the trusted writer, never filled from a runtime candidate. */
export type LpQuoteAdmissionContext =
  | { readonly kind: 'acquisition'; readonly commit: LpAcquisitionCommit }
  | { readonly kind: 'operation'; readonly commit: LpOperationCommit };
export interface LpSettlementAdmissionContext {
  readonly operation: LpExactOperation;
  readonly position: LpExactPosition;
  readonly operationCreatedAt: string;
}

export interface LpProtectedQuoteAdmission {
  readonly id: string;
  readonly userId: string;
  readonly input: LpQuoteInput;
  readonly quote: LpPaperQuote;
  /** Required by SQL projection; optional only for legacy comparison-only callers. */
  readonly quoteHash?: string;
  readonly contextKey?: string;
  /** Mandatory in the protected SQL adapter; optional only for the older comparison-only callers. */
  readonly context?: LpQuoteAdmissionContext;
  readonly admittedAt: string;
}
export interface LpProtectedSettlementAdmission {
  readonly id: string;
  readonly quoteAdmissionId: string;
  readonly operationId: string;
  readonly userId: string;
  readonly positionId: string;
  readonly positionRevision: string;
  readonly receipt: LpPaperReceipt;
  readonly context?: LpSettlementAdmissionContext;
  readonly admittedAt: string;
}
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`LP protected admission: ${reason}`);
}
function identity(value: unknown): void {
  check(typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value), 'canonical record identity required');
}
function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(lpSnapshot(a)) === JSON.stringify(lpSnapshot(b));
}
function observation(now: Date): number {
  const time = now.getTime();
  check(Number.isFinite(time), 'valid observation time required');
  return time;
}

/** Comparisons only: calling this cannot admit evidence. Records must come from a separately protected writer/store. */
export function requireLpQuoteAdmission(
  admission: LpProtectedQuoteAdmission | null,
  input: LpQuoteInput,
  candidate: LpPaperQuote,
  now: Date,
  historical = false
): LpProtectedQuoteAdmission {
  check(admission, 'independently stored quote unavailable');
  identity(admission.id); identity(admission.userId); identity(input.userId);
  check(admission.userId === input.userId && equal(admission.input, input)
    && equal(admission.quote, candidate), 'complete quote or context mismatch');
  check((input.action === 'acquire' && input.positionId === null && input.positionRevision === null)
    || ((input.action === 'rebalance' || input.action === 'close')
      && typeof input.positionId === 'string' && typeof input.positionRevision === 'string'), 'position context required');
  if (input.positionId !== null) { identity(input.positionId); lpMicro(input.positionRevision!); }
  const time = observation(now), admitted = lpTime(admission.admittedAt);
  check(admitted >= lpTime(candidate.observedAt) && admitted >= lpTime(candidate.pool.observedAt)
    && admitted < lpTime(candidate.expiresAt) && admitted <= time, 'quote was not admitted while fresh');
  const provider = {
    providerId: admission.quote.providerId,
    networks: { [input.chain]: admission.quote.pool.networkId },
    quote: async () => null,
    receipt: async () => null
  };
  lpValidateQuote(candidate, input, provider, new Date(admitted));
  if (!historical) check(time < lpTime(candidate.expiresAt), 'quote expired before operation admission');
  if (input.action === 'rebalance') check(lpEconomics(candidate.economics).shouldRebalance, 'rebalance economics not positive');
  return lpSnapshot(admission);
}

/** The complete independently admitted receipt includes actual fees/costs, not merely the quote projection. */
export function requireLpSettlementAdmission(
  admission: LpProtectedSettlementAdmission | null,
  quoteAdmission: LpProtectedQuoteAdmission | null,
  operation: LpExactOperation,
  position: LpExactPosition,
  candidate: LpPaperReceipt,
  now: Date
): LpProtectedSettlementAdmission {
  check(admission, 'independently stored settlement unavailable');
  identity(admission.id); identity(admission.operationId); identity(admission.userId); identity(admission.positionId);
  check(admission.operationId === operation.id && admission.userId === operation.userId
    && admission.userId === position.userId && admission.positionId === operation.positionId
    && admission.positionId === position.id && admission.positionRevision === operation.positionRevision
    && admission.positionRevision === position.revision && position.state !== 'closed'
    && position.mode === 'paper' && operation.status === 'pending'
    && lpSameAmount(position.currentAmount, operation.amountBefore)
    && operation.fingerprint === lpOperationIntent(position, operation.action), 'operation or position binding mismatch');
  const input: LpQuoteInput = {
    userId: operation.userId, chain: position.chain, poolAddress: position.poolAddress,
    depositAsset: position.depositAsset, deposit: operation.amountBefore, action: operation.action,
    intentHash: operation.fingerprint, positionId: position.id, positionRevision: operation.positionRevision
  };
  const quote = requireLpQuoteAdmission(quoteAdmission, input, operation.quote, now, true);
  check(admission.quoteAdmissionId === quote.id && equal(admission.receipt, candidate), 'complete settlement or quote admission mismatch');
  const admitted = lpTime(admission.admittedAt), time = observation(now);
  check(lpTime(candidate.settledAt) >= lpTime(quote.admittedAt)
    && admitted >= lpTime(quote.admittedAt) && admitted >= lpTime(candidate.settledAt)
    && admitted <= time, 'settlement admission time mismatch');
  lpValidateReceipt(candidate, operation, position, {
    providerId: quote.quote.providerId, networks: { [position.chain]: quote.quote.pool.networkId },
    quote: async () => null, receipt: async () => null
  }, now);
  lpRaw(candidate.amountAfter); lpMicro(candidate.collectedFeesMicroUsd); lpMicro(candidate.executionCostsMicroUsd);
  return lpSnapshot(admission);
}

/** Mirrors SQL lp085_project_position: only legacy state/consent overlay immutable financial JSON.
 * Closed exact inventory cannot be reopened by a divergent legacy row. */
export function lpProjectProtectedPosition(data: LpExactPosition, state: LpExactPosition['state'], autoRebalance: boolean): LpExactPosition {
  check(['building','active','near_edge','out_of_range','rebalancing','closed'].includes(state)
    && typeof autoRebalance === 'boolean', 'canonical legacy position projection required');
  check(data.state !== 'closed' || state === 'closed', 'closed exact position cannot reopen');
  return { ...lpSnapshot(data), state, autoRebalance };
}
export function lpAdmissionContextKey(context: LpQuoteAdmissionContext): string {
  const key = context.kind === 'acquisition' ? context.commit.request.operationKey : context.commit.operationKey;
  lpKey(key);
  return `${context.kind}:${key}`;
}

export function lpAdmissionQuoteInput(userId: string, context: LpQuoteAdmissionContext): LpQuoteInput {
  identity(userId);
  check(context && (context.kind === 'acquisition' || context.kind === 'operation'), 'full trusted context required');
  lpKey(context.kind === 'acquisition' ? context.commit.request.operationKey : context.commit.operationKey);
  if (context.kind === 'acquisition') {
    const c = context.commit, r = c.request;
    check(r.autoRebalance === undefined || typeof r.autoRebalance === 'boolean', 'acquisition consent context mismatch');
    check(c.origin === null || (typeof c.origin === 'object' && c.origin !== null), 'explicit acquisition origin context required');
    check(c.fingerprint === lpAcquisitionHash(r, c.origin), 'acquisition intent mismatch');
    lpAssertPlan(c.plan, r.deposit, c.quote.pool.protocol, c.quote.pool.evidenceId);
    check(equal(c.plan.strategy, r.strategy), 'acquisition strategy mismatch');
    return { userId, chain: r.chain, poolAddress: r.poolAddress, depositAsset: r.depositAsset,
      deposit: r.deposit, action: 'acquire', intentHash: c.fingerprint, positionId: null, positionRevision: null };
  }
  const c = context.commit, p = c.position;
  identity(p.id);
  check(p.userId === userId && p.mode === 'paper' && ['active', 'near_edge', 'out_of_range'].includes(p.state)
    && (c.action === 'close' || c.action === 'rebalance') && c.fingerprint === lpOperationIntent(p, c.action)
    && p.protocol === c.quote.pool.protocol && typeof c.receiptKey === 'string' && c.receiptKey.length > 0,
    'current operation context mismatch');
  lpMicro(p.revision); lpRaw(p.currentAmount, true);
  if (c.action === 'close') check(c.plan === null, 'close replacement plan refused');
  else { check(c.plan, 'rebalance replacement plan required'); lpAssertPlan(c.plan, p.currentAmount, p.protocol, c.quote.pool.evidenceId); }
  return { userId, chain: p.chain, poolAddress: p.poolAddress, depositAsset: p.depositAsset, deposit: p.currentAmount,
    action: c.action, intentHash: c.fingerprint, positionId: p.id, positionRevision: p.revision };
}
export function requireLpQuoteContext(admission: LpProtectedQuoteAdmission, context: LpQuoteAdmissionContext): void {
  check(admission.context && equal(admission.context, context), 'complete protected quote context unavailable or mismatched');
  check(admission.contextKey === lpAdmissionContextKey(context), 'protected context key mismatch');
  check(admission.quoteHash === lpExactHash(admission.quote), 'stored protected quote hash mismatch');
  check(equal(lpAdmissionQuoteInput(admission.userId, context), admission.input)
    && equal(context.commit.quote, admission.quote), 'protected context quote mismatch');
}
export function requireLpSettlementContext(admission: LpProtectedSettlementAdmission, quote: LpProtectedQuoteAdmission,
  context: LpSettlementAdmissionContext): void {
  check(admission.context && equal(admission.context, context), 'complete protected settlement context unavailable or mismatched');
  const created = lpTime(context.operationCreatedAt);
  check(created >= lpTime(quote.admittedAt) && created < lpTime(quote.quote.expiresAt)
    && lpTime(admission.receipt.settledAt) >= created && lpTime(admission.admittedAt) >= created,
    'canonical operation settlement chronology mismatch');
}
