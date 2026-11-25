import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CopyExecutionRecord, RecordCopyExecutionEvidenceInput } from './copy-trade-lifecycle-owned.js';
import { readWorkerExecutionContextWithClient, type WorkerAttempt } from './worker-execution.js';
import { readCapturedWorkerPolicyWithClient, readCurrentWorkerPolicyWithClient } from './worker-policy.js';
import { assertCanonicalFanoutDescriptor } from './fanout-worker-descriptor.js';
import { reconcileWorkerFillWithClient, reconcileWorkerValuationWithClient,
  type WorkerFillSettlement, type WorkerValuationSettlement } from './worker-settlement.js';
import { readWorkerFinancialTotalsWithClient, workerMoney } from './worker-valuation-corrections.js';
import { exactDecimal, compareExactDecimal } from './runtime-exact-decimal.js';
import { pipelineRequire, pipelineText, pipelineUuid, pipelineTime, type PipelineClientLease } from './wave4-pipeline-source-owned.js';
import { pipelinePayload, pipelineFields, pipelineIso, pipelineDigest, pipelineScope, pipelineSame,
  requirePipelineApprovedPayload, requirePipelineWorkerRoutine, pipelineWriterTransaction, pipelineElapsedClock } from './wave4-pipeline-capability-owned.js';

/** Independent worker PAPER receipt, NOT SQL082 withdrawal/reducing receipt.
 * A new append-only receipt relation/writer guard must independently compare the
 * canonical execution, worker fence and protected pre-fill valuation/model and
 * every computed raw/scale/base/quote/price/fee term. Shaped callback evidence or
 * swat_app insertion cannot authorize recovery. The fixed runtime reader must
 * rejoin SQL079 canonical capability and exact receipt terms under FORCE RLS.
 * These routines are invoker/migrator-owned: no extra broker ownership transfer.
 * receiptId is SHA256 of canonical sorted JSON excluding receiptId itself. */
export interface PipelineWorkerPaperReceipt {
  readonly receiptId: string; readonly executionId: string; readonly userId: string;
  readonly chain: CopyExecutionRecord['chain']; readonly tokenMint: string; readonly targetAccount: string;
  readonly executionMode: 'paper'; readonly workerFence: string; readonly policyRevision: string;
  readonly riskEpoch: string | null; readonly paperValuationEvidenceId: string; readonly paperValuationDigest: string;
  readonly executor: 'paper-exact-simulated'; readonly evidence: {
    readonly executionId: string; readonly evidenceType: 'paper_simulation'; readonly evidenceId: string;
    readonly baseQuantity: string; readonly quoteLeg: { readonly amount: string; readonly currency: 'USD' } | null;
    readonly priceUsd: string | null; readonly feeUsd: string | null; readonly confirmationState: 'confirmed';
    readonly completesExecution: true; readonly occurredAt: string;
  };
}
export function pipelineWorkerReceiptDigest(value: Omit<PipelineWorkerPaperReceipt,'receiptId'>): string {
  return createHash('sha256').update(JSON.stringify(pipelinePayload(value))).digest('hex');
}
export function pipelineReceiptEvidence(candidate: RecordCopyExecutionEvidenceInput): PipelineWorkerPaperReceipt['evidence'] {
  pipelineRequire(candidate && candidate.evidenceType === 'paper_simulation' && candidate.confirmationState === 'confirmed'
    && candidate.completesExecution === true && (candidate.quoteLeg == null || candidate.quoteLeg.currency === 'USD')
    && typeof candidate.baseQuantity === 'string' && (candidate.priceUsd == null || typeof candidate.priceUsd === 'string')
    && (candidate.feeUsd == null || typeof candidate.feeUsd === 'string')
    && (candidate.quoteLeg == null || typeof candidate.quoteLeg.amount === 'string')
    && pipelineTime(candidate.occurredAt),'exact immutable USD-or-unvalued paper evidence required');
  return pipelinePayload({ executionId: candidate.executionId,evidenceType: 'paper_simulation',evidenceId: candidate.evidenceId,
    baseQuantity: candidate.baseQuantity,quoteLeg: candidate.quoteLeg ? { amount: candidate.quoteLeg.amount as string,currency: 'USD' } : null,
    priceUsd: candidate.priceUsd ?? null,feeUsd: candidate.feeUsd ?? null,confirmationState: 'confirmed',completesExecution: true,
    occurredAt: candidate.occurredAt.toISOString() });
}
export function preparePipelineWorkerPaperReceipt(candidate: PipelineWorkerPaperReceipt) {
  const value = pipelinePayload(candidate);
  pipelineFields(value,['receiptId','executionId','userId','chain','tokenMint','targetAccount','executionMode','workerFence',
    'policyRevision','riskEpoch','paperValuationEvidenceId','paperValuationDigest','executor','evidence']);
  pipelineUuid(value.executionId); pipelineUuid(value.userId); pipelineScope(value);
  pipelineDigest(value.receiptId); pipelineDigest(value.paperValuationDigest);
  pipelineFields(value.evidence,['executionId','evidenceType','evidenceId','baseQuantity','quoteLeg','priceUsd',
    'feeUsd','confirmationState','completesExecution','occurredAt']);
  if (value.evidence.quoteLeg !== null) pipelineFields(value.evidence.quoteLeg,['amount','currency']);
  pipelineIso(value.evidence.occurredAt);
  pipelineRequire(value.executionMode === 'paper' && pipelineText(value.workerFence,19) && /^[1-9]\d{0,18}$/.test(value.workerFence)
    && BigInt(value.workerFence) <= 9223372036854775807n && pipelineText(value.policyRevision,64)
    && (value.riskEpoch === null || pipelineText(value.riskEpoch,19) && /^[1-9]\d{0,18}$/.test(value.riskEpoch) && BigInt(value.riskEpoch) <= 9223372036854775807n)
    && pipelineText(value.paperValuationEvidenceId) && value.executor === 'paper-exact-simulated'
    && value.evidence.executionId === value.executionId && value.evidence.evidenceType === 'paper_simulation'
    && pipelineText(value.evidence.evidenceId,512) && (value.evidence.quoteLeg === null || value.evidence.quoteLeg.currency === 'USD')
    && value.evidence.confirmationState === 'confirmed' && value.evidence.completesExecution === true,
  'independent paper receipt immutable identity/fence mismatch');
  exactDecimal(value.evidence.baseQuantity,true);
  if (value.evidence.priceUsd !== null) { exactDecimal(value.evidence.priceUsd,true); workerMoney(value.evidence.priceUsd); }
  if (value.evidence.quoteLeg !== null) workerMoney(value.evidence.quoteLeg.amount);
  if (value.evidence.feeUsd !== null) workerMoney(value.evidence.feeUsd);
  const { receiptId: _id,...body } = value;
  pipelineRequire(pipelineWorkerReceiptDigest(body) === value.receiptId,'independent paper receipt digest mismatch');
  return value;
}
export async function recordPipelineWorkerPaperReceiptWithClient(client: PoolClient, candidate: PipelineWorkerPaperReceipt) {
  const value = preparePipelineWorkerPaperReceipt(candidate);
  await requirePipelineApprovedPayload(client,'paper-receipt',value.executionId,value);
  await requirePipelineWorkerRoutine(client,'receiptWrite');
  const result = await client.query('SELECT public.swat_pipeline_record_worker_paper_receipt($1::uuid,$2::bigint,$3::jsonb) AS result',
    [value.executionId,value.workerFence,JSON.stringify(value)]);
  pipelineRequire(result.rows.length === 1 && pipelineSame(result.rows[0].result,value),'independent protected paper receipt insert/replay refused');
  return value;
}
export function createProtectedPipelinePaperReceiptWriter(input: { acquire: () => Promise<PipelineClientLease>; signal?: AbortSignal }) {
  pipelineRequire(typeof input.acquire === 'function','independent receipt physical lease required');
  const { acquire,signal } = input;
  return { record(candidate: PipelineWorkerPaperReceipt) {
    const value = preparePipelineWorkerPaperReceipt(candidate);
    return pipelineWriterTransaction(acquire,'paper-receipt',value.executionId,signal)(client => recordPipelineWorkerPaperReceiptWithClient(client,value));
  } };
}
export interface PipelineWorkerRecoverySelector {
  readonly executionId: string; readonly workerFence: string; readonly evidenceId: string;
}
export function preparePipelineWorkerRecoverySelector(candidate: PipelineWorkerRecoverySelector) {
  const value = pipelinePayload(candidate);
  pipelineFields(value,['executionId','workerFence','evidenceId']);
  pipelineUuid(value.executionId);
  pipelineRequire(pipelineText(value.workerFence,19) && /^[1-9]\d{0,18}$/.test(value.workerFence) && BigInt(value.workerFence) <= 9223372036854775807n
    && pipelineText(value.evidenceId,512),'recovery immutable execution/fence/evidence selectors required');
  return value;
}
export async function readPipelineWorkerPaperReceiptByIdentityWithClient(client: PoolClient, attempt: WorkerAttempt,
  evidenceId: string): Promise<PipelineWorkerPaperReceipt> {
  const selector = preparePipelineWorkerRecoverySelector({ executionId: attempt.executionId,workerFence: attempt.fence,evidenceId });
  await requirePipelineWorkerRoutine(client,'receiptRead');
  const result = await client.query('SELECT public.swat_pipeline_worker_paper_receipt($1::uuid,$2::bigint,$3::text) AS result',
    [selector.executionId,selector.workerFence,selector.evidenceId]);
  pipelineRequire(result.rows.length === 1 && result.rows[0].result,'independent persisted worker paper receipt unavailable');
  const value = preparePipelineWorkerPaperReceipt(result.rows[0].result);
  pipelineRequire(value.executionId === attempt.executionId && value.userId === attempt.userId && value.workerFence === attempt.fence
    && value.policyRevision === attempt.policyRevision && value.riskEpoch === attempt.riskEpoch
    && value.evidence.evidenceId === selector.evidenceId,'independent receipt exact original/fence/provenance mismatch');
  return value;
}
export async function readPipelineWorkerPaperReceiptWithClient(client: PoolClient, attempt: WorkerAttempt,
  evidence: RecordCopyExecutionEvidenceInput): Promise<PipelineWorkerPaperReceipt> {
  const expected = pipelineReceiptEvidence(evidence);
  pipelineRequire(attempt.executionId === evidence.executionId,'receipt lookup execution/fence mismatch');
  const value = await readPipelineWorkerPaperReceiptByIdentityWithClient(client,attempt,evidence.evidenceId);
  pipelineRequire(pipelineSame(value.evidence,expected),'independent receipt exact original/fence/provenance mismatch');
  return value;
}
export async function assertPipelineWorkerPaperReceiptWithClient(client: PoolClient, attempt: WorkerAttempt,
  evidence: RecordCopyExecutionEvidenceInput): Promise<void> {
  await readPipelineWorkerPaperReceiptWithClient(client,attempt,evidence);
}
interface PipelineOriginalPaperEvidence {
  execution_id: string; base_quantity: string; quote_quantity: string | null;
  quote_native_quantity: string | null; quote_currency: string | null; quote_native_usd_price: string | null;
  price_usd: string | null; fee_usd: string | null; confirmation_state: string; completes_execution: boolean; occurred_at: Date;
}
/** Compare the immutable ORIGINAL, never effective corrections or simulated
 * expected economics. Canonical valuateQuoteLeg stores USD as amount/amount/1;
 * absent quote stores four NULLs. Historical ambiguous shapes fail closed.
 * NUMERIC text may retain trailing zeroes: compare base via exact BigInt-aligned
 * decimals, without narrowing the raw base domain to the money scale. */
export function assertPipelineOriginalPaperEvidence(original: PipelineOriginalPaperEvidence, receipt: PipelineWorkerPaperReceipt): void {
  const nullableMoney = (value: string | null) => value === null ? null : workerMoney(value);
  const quote = receipt.evidence.quoteLeg === null ? null : workerMoney(receipt.evidence.quoteLeg.amount);
  pipelineRequire(original.execution_id === receipt.executionId && ['confirmed','finalized'].includes(original.confirmation_state)
    && original.completes_execution === true && pipelineTime(original.occurred_at)
    && compareExactDecimal(exactDecimal(original.base_quantity,true),exactDecimal(receipt.evidence.baseQuantity,true)) === 0
    && nullableMoney(original.quote_quantity) === quote && nullableMoney(original.quote_native_quantity) === quote
    && nullableMoney(original.quote_native_usd_price) === (quote === null ? null : '1')
    && original.quote_currency === (quote === null ? null : 'USD')
    && nullableMoney(original.price_usd) === nullableMoney(receipt.evidence.priceUsd)
    && nullableMoney(original.fee_usd) === nullableMoney(receipt.evidence.feeUsd)
    && original.occurred_at.toISOString() === receipt.evidence.occurredAt,
  'recovery independent immutable original quote/price/fee mismatch');
}
/** Identity-only restart path. Legacy full settlements remain comparison inputs,
 * not authority. Execution, attempt, captured/current policy, risk, delivery and
 * original evidence are independently reconstructed on the canonical scoped
 * client. No prepare/reclaim/resend, economic SQL clone or new runtime purpose. */
export async function readPipelineWorkerRecoveryWithClient(client: PoolClient,
  supplied: WorkerFillSettlement | PipelineWorkerRecoverySelector, now: Date, originalEvidenceId?: string): Promise<WorkerFillSettlement> {
  const elapsed = pipelineElapsedClock(now);
  const legacy = 'execution' in supplied ? supplied : null;
  const selector = preparePipelineWorkerRecoverySelector(legacy ? { executionId: legacy.execution.id,
    workerFence: legacy.attempt.fence,evidenceId: legacy.evidence.evidenceId } : supplied as PipelineWorkerRecoverySelector);
  if (originalEvidenceId !== undefined) pipelineUuid(originalEvidenceId);
  const context = await readWorkerExecutionContextWithClient(client,selector.executionId);
  pipelineRequire(context && context.execution.executionMode === 'paper' && context.execution.userId !== null,
    'recovery persisted worker execution unavailable');
  const execution = context.execution;
  const identity = (e: CopyExecutionRecord) => [e.id,e.userId,e.signalId,e.sourceTradeId,e.exitLotId ?? null,
    e.exitTrigger ?? null,e.chain,e.tokenMint,e.targetAccount,e.executionMode,e.direction,
    e.clientOrderId,e.requestedBaseQuantity,e.requestedQuoteQuantity,e.sourcePositionBeforeQuantity ?? null,e.sourceSellFraction ?? null];
  if (legacy) pipelineRequire(pipelineSame(identity(execution),identity(legacy.execution)),
    'recovery immutable execution comparison mismatch');
  const attempts = await client.query(`SELECT execution_id,user_id,fence::text,policy_revision,risk_epoch::text,state
    FROM public.copy_execution_worker_attempts WHERE execution_id=$1 FOR UPDATE`,[execution.id]);
  const row = attempts.rows[0];
  pipelineRequire(attempts.rows.length === 1 && row.execution_id === execution.id && row.user_id === execution.userId
    && row.fence === selector.workerFence && ['dispatched','unknown','settled'].includes(row.state),
  'recovery persisted attempt unavailable; never resend');
  const attempt: WorkerAttempt = { executionId: row.execution_id,userId: row.user_id,fence: row.fence,
    policyRevision: row.policy_revision,riskEpoch: row.risk_epoch };
  if (legacy) pipelineRequire(pipelineSame(attempt,{ executionId: legacy.attempt.executionId,userId: legacy.attempt.userId,
    fence: legacy.attempt.fence,policyRevision: legacy.attempt.policyRevision,riskEpoch: legacy.attempt.riskEpoch }),
  'recovery independently read attempt/fence mismatch');
  const captured = await readCapturedWorkerPolicyWithClient(client,execution,context.masterWalletAddress);
  const current = await readCurrentWorkerPolicyWithClient(client,{ ...execution,masterWalletAddress: context.masterWalletAddress });
  const expectedScope = { account: execution.userId,chain: execution.chain,tokenMint: execution.tokenMint,
    masterWalletAddress: context.masterWalletAddress };
  pipelineRequire(captured && current && captured.policyId === current.snapshot.policyId
    && pipelineSame(captured.scope,expectedScope) && pipelineSame(current.snapshot.scope,expectedScope)
    && pipelineDigestPolicy(attempt.policyRevision) && captured.revision === attempt.policyRevision,
  'recovery persisted captured attempt policy unavailable; changed sell admission needs historical policy seam');
  // Current stops/epoch changes forbid NEW effects, not receipt-owned accounting.
  // The canonical buy admission pins attempt revision to captured revision. A sell
  // admitted under another revision has no persisted historical slippage here:
  // refuse instead of trusting the caller or today's policy/default.
  let slippageBps = captured.maxSlippageBps;
  const boundedSlippage = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 5000;
  pipelineRequire(boundedSlippage(slippageBps),'recovery captured slippage unavailable');
  if (execution.direction === 'sell') {
    const bounds = context.ownedExit ? [context.ownedExit.maxSlippageBps]
      : context.sourceSellLots?.lots.map(lot => lot.maxSlippageBps);
    pipelineRequire(bounds && bounds.length > 0 && bounds.every(boundedSlippage),'recovery persisted acquisition slippage unavailable');
    slippageBps = Math.min(slippageBps,...bounds);
  }
  const receipt = await readPipelineWorkerPaperReceiptByIdentityWithClient(client,attempt,selector.evidenceId);
  pipelineRequire(receipt.chain === execution.chain && receipt.tokenMint === execution.tokenMint
    && receipt.targetAccount === execution.targetAccount,'recovery independent receipt asset/executor mismatch');
  if (legacy) pipelineRequire(legacy.executor === receipt.executor
    && pipelineSame(pipelineReceiptEvidence(legacy.evidence),receipt.evidence),'recovery independent original evidence mismatch');
  const originals = await client.query(`SELECT id,execution_id,evidence_type,evidence_id,base_quantity::text,
    quote_quantity::text,quote_native_quantity::text,quote_currency,quote_native_usd_price::text,
    price_usd::text,fee_usd::text,confirmation_state,completes_execution,occurred_at
    FROM public.copy_execution_evidence WHERE execution_id=$1 AND evidence_type=$2 AND evidence_id=$3 FOR SHARE`,
  [execution.id,receipt.evidence.evidenceType,receipt.evidence.evidenceId]);
  pipelineRequire(originals.rows.length <= 1 && (originalEvidenceId === undefined || originals.rows.length === 1
    && originals.rows[0].id === originalEvidenceId),'recovery immutable original selection mismatch');
  if (originals.rows.length === 1) assertPipelineOriginalPaperEvidence(originals.rows[0],receipt);
  else pipelineRequire(receipt.evidence.quoteLeg !== null && receipt.evidence.priceUsd !== null && receipt.evidence.feeUsd !== null,
    'unknown original economics require independently persisted original; never invent zero');
  let risk: WorkerFillSettlement['risk'] = null;
  if (execution.direction === 'buy') {
    const control = await client.query(`SELECT epoch::text FROM public.risk_policy_control
      WHERE account=$1 AND chain=$2 AND execution_mode='paper' FOR UPDATE`,[execution.userId,execution.chain]);
    const reservations = await client.query(`SELECT account,chain,execution_mode,execution_id,policy_epoch::text,state
      FROM public.risk_spend_reservations WHERE execution_id=$1 FOR UPDATE`,[execution.id]);
    const r = reservations.rows[0];
    pipelineRequire(control.rows.length === 1 && reservations.rows.length === 1 && r.execution_id === execution.id
      && r.account === execution.userId && r.chain === execution.chain && r.execution_mode === 'paper'
      && r.policy_epoch === attempt.riskEpoch && ['submitted','unknown','partial','confirmed'].includes(r.state),
    'recovery retained exact risk liability unavailable');
    risk = { account: r.account,chain: r.chain,executionMode: r.execution_mode,executionId: r.execution_id,policyEpoch: r.policy_epoch };
  } else pipelineRequire(attempt.riskEpoch === null,'sell recovery cannot invent risk epoch');
  if (legacy) pipelineRequire(pipelineSame(risk,legacy.risk),'recovery independent risk scope mismatch');
  let delivery: WorkerFillSettlement['delivery'];
  let claimedUntil: Date | null = null;
  if (execution.sourceTradeId !== null && !execution.exitLotId) {
    const deliveries = await client.query(`SELECT signal_id,user_id,execution_mode,target_account,execution_id,fence::text,
      lease_owner,lease_until,state,job_id,descriptor FROM public.source_fanout_deliveries WHERE execution_id=$1 FOR UPDATE`,[execution.id]);
    const d = deliveries.rows[0];
    pipelineRequire(deliveries.rows.length === 1 && d.execution_id === execution.id && d.signal_id === execution.signalId
      && d.user_id === execution.userId && d.execution_mode === 'paper' && d.target_account === execution.targetAccount
      && /^[1-9]\d{0,18}$/.test(d.fence) && BigInt(d.fence) <= 9223372036854775807n
      && ['claimed','reconciliation_required','completed'].includes(d.state)
      && (d.state !== 'claimed' || pipelineText(d.lease_owner,128) && pipelineTime(d.lease_until))
      && assertCanonicalFanoutDescriptor(d.descriptor,{ signalId: d.signal_id,userId: d.user_id,
        executionMode: d.execution_mode,targetAccount: d.target_account,sourceTradeId: execution.sourceTradeId,
        chain: execution.chain,jobId: d.job_id }) === execution.id,'recovery persisted delivery/descriptor unavailable');
    const data = d.descriptor.data;
    pipelineRequire(data.tokenMint === execution.tokenMint && data.direction === execution.direction
      && data.masterWalletAddress === context.masterWalletAddress && data.exitLotId === null
      && data.requestedBaseQuantity === execution.requestedBaseQuantity && data.requestedQuoteQuantity === execution.requestedQuoteQuantity,
    'recovery persisted delivery exact request mismatch');
    if (legacy) pipelineRequire(legacy.delivery && pipelineSame([legacy.delivery.claim.signalId,legacy.delivery.claim.userId,
      legacy.delivery.claim.executionMode,legacy.delivery.claim.targetAccount,legacy.delivery.claim.fence],
    [d.signal_id,d.user_id,d.execution_mode,d.target_account,d.fence]),'recovery independent delivery fence mismatch');
    // Delivery fence is independent of worker fence: never equate their counters.
    claimedUntil = d.state === 'claimed' ? d.lease_until : null;
    delivery = { claim: { signalId: d.signal_id,userId: d.user_id,executionMode: d.execution_mode,
      targetAccount: d.target_account,fence: d.fence,owner: d.lease_owner ?? 'receipt-owned-recovery' },now: elapsed() };
  } else if (legacy) pipelineRequire(!legacy.delivery,'lot-exit recovery cannot substitute fanout delivery');
  const clock = await client.query('SELECT statement_timestamp() AS database_now');
  const databaseNow = clock.rows[0]?.database_now,localNow = elapsed();
  pipelineRequire(clock.rows.length === 1 && pipelineTime(databaseNow)
    && [localNow,databaseNow].every(t => Date.parse(receipt.evidence.occurredAt) <= t.getTime()
      && (!claimedUntil || claimedUntil.getTime() > t.getTime())),
  'recovery original future/claimed delivery expired after lock waits; never reclaim or resend');
  if (delivery) delivery = { ...delivery,now: new Date(Math.max(localNow.getTime(),databaseNow.getTime())) };
  return { execution,attempt,risk,delivery,executor: receipt.executor,slippageBps,
    evidence: { ...receipt.evidence,quoteLeg: receipt.evidence.quoteLeg ? { ...receipt.evidence.quoteLeg } : null,
      occurredAt: new Date(receipt.evidence.occurredAt) } };
}
function pipelineDigestPolicy(value: unknown): boolean { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
export async function reconcilePipelineWorkerPaperFillWithClient(client: PoolClient,
  input: WorkerFillSettlement | PipelineWorkerRecoverySelector, now: Date = new Date()) {
  if ('execution' in input) pipelineRequire(input.execution.executionMode === 'paper' && input.executor === 'paper-exact-simulated',
    'worker paper reconciliation cannot authorize live/SQL082 effects');
  const persisted = await readPipelineWorkerRecoveryWithClient(client,input,now);
  return reconcileWorkerFillWithClient(client,persisted,assertPipelineWorkerPaperReceiptWithClient);
}
export interface PipelineWorkerValuationRecoverySelector extends PipelineWorkerRecoverySelector {
  readonly correction: Pick<WorkerValuationSettlement['correction'],'originalEvidenceId' | 'correctionId' | 'valuationId' | 'previousCorrectionId'>;
}
export async function reconcilePipelineWorkerPaperValuationWithClient(client: PoolClient,
  input: WorkerValuationSettlement | PipelineWorkerValuationRecoverySelector, now: Date = new Date()) {
  if ('execution' in input) pipelineRequire(input.execution.executionMode === 'paper' && input.executor === 'paper-exact-simulated',
    'worker valuation recovery cannot authorize live/SQL082 effects');
  const elapsed = pipelineElapsedClock(now);
  const correction = pipelinePayload({ originalEvidenceId: input.correction.originalEvidenceId,correctionId: input.correction.correctionId,
    valuationId: input.correction.valuationId,previousCorrectionId: input.correction.previousCorrectionId });
  pipelineUuid(correction.originalEvidenceId);
  pipelineRequire([correction.correctionId,correction.valuationId].every(v => pipelineText(v))
    && (correction.previousCorrectionId === null || pipelineText(correction.previousCorrectionId)),
  'recovery immutable correction selectors required');
  const selector = 'execution' in input ? input : preparePipelineWorkerRecoverySelector({ executionId: input.executionId,
    workerFence: input.workerFence,evidenceId: input.evidenceId });
  const persisted = await readPipelineWorkerRecoveryWithClient(client,selector,elapsed(),correction.originalEvidenceId);
  // Existing canonical correction checks persisted valuation/authority/original/
  // predecessor; selector labels never authorize a new price, fee or base fill.
  return reconcileWorkerValuationWithClient(client,{ ...persisted,correction: { ...correction,now: elapsed() } },
    assertPipelineWorkerPaperReceiptWithClient);
}
/** Independent persisted financial observation uses SQL080 worker receipts and
 * effective totals, never queue completion or SQL082 reducing_receipts. Historical
 * receipt acceptance requires current original application/correction/risk facts.
 * This read proves neither services started nor runtime/live/production readiness. */
export async function readPipelineWorkerFinancialReceiptWithClient(client: PoolClient, executionId: string) {
  pipelineUuid(executionId);
  const total = await readWorkerFinancialTotalsWithClient(client,executionId);
  const result = await client.query(`SELECT receipt.receipt_id,receipt.execution_id,receipt.user_id,receipt.trade_id,
    receipt.worker_fence::text,receipt.snapshot,receipt.accounting_complete,receipt.recorded_at
    FROM public.copy_execution_financial_receipts receipt
    JOIN public.copy_executions e ON e.id=receipt.execution_id AND e.user_id IS NOT DISTINCT FROM receipt.user_id
    JOIN public.trades t ON t.id=receipt.trade_id AND t.copy_execution_id=e.id AND t.user_id IS NOT DISTINCT FROM e.user_id
      AND t.execution_mode=e.execution_mode AND t.chain=e.chain AND t.token_mint=e.token_mint AND t.direction=e.direction
    JOIN public.copy_execution_worker_attempts w ON w.execution_id=e.id AND w.user_id IS NOT DISTINCT FROM e.user_id
      AND w.fence=receipt.worker_fence
    WHERE e.id=$1 AND e.execution_mode='paper' AND e.state='confirmed' AND t.status='filled' AND receipt.accounting_complete
      AND NOT EXISTS(SELECT 1 FROM public.copy_execution_evidence f WHERE f.execution_id=e.id
        AND f.confirmation_state IN('confirmed','finalized') AND NOT EXISTS(
          SELECT 1 FROM public.copy_position_applications a WHERE a.evidence_id=f.id AND a.execution_id=e.id
            AND a.active AND a.user_id IS NOT DISTINCT FROM e.user_id AND a.target_account=e.target_account
            AND a.chain=e.chain AND a.token_mint=e.token_mint))
      AND (e.direction<>'buy' OR EXISTS(SELECT 1 FROM public.risk_spend_reservations r WHERE r.execution_id=e.id
        AND r.account=e.user_id::text AND r.chain=e.chain AND r.execution_mode=e.execution_mode AND r.state='confirmed'
        AND r.policy_epoch=w.risk_epoch AND r.confirmed_usd=$2::numeric AND r.liability_usd=$2::numeric))
    ORDER BY receipt.recorded_at DESC,receipt.receipt_id DESC LIMIT 1 FOR SHARE OF receipt,e,t,w`,[executionId,total.debit]);
  const r = result.rows[0];
  pipelineRequire(result.rows.length === 1 && total.evidenceCount !== '0' && total.unknown === '0' && total.completes
    && pipelineSame(r.snapshot.totals,total) && r.snapshot.executionId === executionId && r.snapshot.userId === r.user_id
    && r.snapshot.tradeId === r.trade_id && r.snapshot.fence === r.worker_fence && r.snapshot.accountingComplete === true,
  'current complete persisted worker financial receipt unavailable');
  pipelineDigest(r.receipt_id);
  // JSONB does not retain JS insertion order. SQL080's canonical writer stores
  // the row returned by readWorkerFinancialTotalsWithClient, including its final
  // invalidCorrections field. Reconstruct that exact order, not sorted JSON.
  const orderedTotals = { base: total.base,quote: total.quote,debit: total.debit,fee: total.fee,
    unknown: total.unknown,quoteUnknown: total.quoteUnknown,completes: total.completes,evidenceCount: total.evidenceCount,
    invalidCorrections: (total as typeof total & { invalidCorrections: string }).invalidCorrections };
  pipelineRequire(orderedTotals.invalidCorrections === '0','financial receipt correction coverage unavailable');
  const canonicalSnapshot = { executionId,userId: r.user_id,tradeId: r.trade_id,fence: r.worker_fence,
    totals: orderedTotals,accountingComplete: true };
  pipelineRequire(createHash('sha256').update(JSON.stringify(canonicalSnapshot)).digest('hex') === r.receipt_id,
    'financial receipt snapshot digest mismatch');
  return { receiptId: r.receipt_id as string,executionId,userId: r.user_id as string,tradeId: r.trade_id as string,
    fence: r.worker_fence as string,totals: total,accountingComplete: true as const };
}
