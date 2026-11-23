import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CopyExecutionRecord, RecordCopyExecutionEvidenceInput } from './copy-trade-lifecycle-owned.js';
import type { WorkerAttempt } from './worker-execution.js';
import { reconcileWorkerFillWithClient, reconcileWorkerValuationWithClient,
  type WorkerFillSettlement, type WorkerValuationSettlement } from './worker-settlement.js';
import { readWorkerFinancialTotalsWithClient, workerMoney } from './worker-valuation-corrections.js';
import { exactDecimal } from './runtime-exact-decimal.js';
import { pipelineRequire, pipelineText, pipelineUuid, pipelineTime, type PipelineClientLease } from './wave4-pipeline-source-owned.js';
import { pipelinePayload, pipelineFields, pipelineIso, pipelineDigest, pipelineScope, pipelineSame,
  requirePipelineApprovedPayload, requirePipelineWorkerRoutine, pipelineWriterTransaction } from './wave4-pipeline-capability-owned.js';

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
  pipelineRequire(value.executionMode === 'paper' && /^[1-9]\d{0,18}$/.test(value.workerFence)
    && BigInt(value.workerFence) <= 9223372036854775807n && pipelineText(value.policyRevision,64)
    && (value.riskEpoch === null || /^[1-9]\d{0,18}$/.test(value.riskEpoch) && BigInt(value.riskEpoch) <= 9223372036854775807n)
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
export function createProtectedPipelinePaperReceiptWriter(input: { acquire: () => Promise<PipelineClientLease> }) {
  pipelineRequire(typeof input.acquire === 'function','independent receipt physical lease required');
  const acquire = input.acquire;
  return { record(candidate: PipelineWorkerPaperReceipt) {
    const value = preparePipelineWorkerPaperReceipt(candidate);
    return pipelineWriterTransaction(acquire,'paper-receipt',value.executionId)(client => recordPipelineWorkerPaperReceiptWithClient(client,value));
  } };
}
export async function readPipelineWorkerPaperReceiptWithClient(client: PoolClient, attempt: WorkerAttempt,
  evidence: RecordCopyExecutionEvidenceInput): Promise<PipelineWorkerPaperReceipt> {
  pipelineUuid(attempt.executionId);
  const expected = pipelineReceiptEvidence(evidence);
  pipelineRequire(attempt.executionId === evidence.executionId && /^[1-9]\d{0,18}$/.test(attempt.fence),'receipt lookup execution/fence mismatch');
  await requirePipelineWorkerRoutine(client,'receiptRead');
  const result = await client.query('SELECT public.swat_pipeline_worker_paper_receipt($1::uuid,$2::bigint,$3::text) AS result',
    [attempt.executionId,attempt.fence,evidence.evidenceId]);
  pipelineRequire(result.rows.length === 1 && result.rows[0].result,'independent persisted worker paper receipt unavailable');
  const value = preparePipelineWorkerPaperReceipt(result.rows[0].result);
  pipelineRequire(value.executionId === attempt.executionId && value.userId === attempt.userId && value.workerFence === attempt.fence
    && value.policyRevision === attempt.policyRevision && value.riskEpoch === attempt.riskEpoch
    && pipelineSame(value.evidence,expected),'independent receipt exact original/fence/provenance mismatch');
  return value;
}
export async function assertPipelineWorkerPaperReceiptWithClient(client: PoolClient, attempt: WorkerAttempt,
  evidence: RecordCopyExecutionEvidenceInput): Promise<void> {
  await readPipelineWorkerPaperReceiptWithClient(client,attempt,evidence);
}
export async function reconcilePipelineWorkerPaperFillWithClient(client: PoolClient, input: WorkerFillSettlement) {
  pipelineRequire(input.execution.executionMode === 'paper' && input.executor === 'paper-exact-simulated',
    'worker paper reconciliation cannot authorize live/SQL082 effects');
  return reconcileWorkerFillWithClient(client,input,assertPipelineWorkerPaperReceiptWithClient);
}
export async function reconcilePipelineWorkerPaperValuationWithClient(client: PoolClient, input: WorkerValuationSettlement) {
  pipelineRequire(input.execution.executionMode === 'paper' && input.executor === 'paper-exact-simulated',
    'worker valuation recovery cannot authorize live/SQL082 effects');
  return reconcileWorkerValuationWithClient(client,input,assertPipelineWorkerPaperReceiptWithClient);
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
  const canonicalSnapshot = { executionId,userId: r.user_id,tradeId: r.trade_id,fence: r.worker_fence,
    totals: total,accountingComplete: true };
  pipelineRequire(createHash('sha256').update(JSON.stringify(canonicalSnapshot)).digest('hex') === r.receipt_id,
    'financial receipt snapshot digest mismatch');
  return { receiptId: r.receipt_id as string,executionId,userId: r.user_id as string,tradeId: r.trade_id as string,
    fence: r.worker_fence as string,totals: total,accountingComplete: true as const };
}
