import type { PoolClient } from 'pg';
import { assertExactExitQuantity } from './lot-allocation.js';
import { recordCopyExecutionEvidenceWithClient, transitionCopyExecutionWithClient,
  type CopyExecutionRecord, type RecordCopyExecutionEvidenceInput } from './copy-trade-lifecycle-owned.js';
import { createHash } from 'node:crypto';
import { settleFanoutDelivery, type FanoutDeliveryClaim } from './package13-fanout-delivery.js';
import { appendWorkerValuationCorrectionWithClient, readWorkerFinancialTotalsWithClient, projectWorkerEconomicsWithClient,
  type WorkerValuationCorrectionInput } from './worker-valuation-corrections.js';
import { updateRiskSpendReservation, type RiskSpendScope } from './risk-spend-owned.js';
import { insertTradeWithClient } from './trades-owned.js';
import { assertWorkerAttemptWithClient, finishWorkerAttemptWithClient, type WorkerAttempt } from './worker-execution.js';
export type WorkerReceiptOwnership = (client: PoolClient, attempt: WorkerAttempt,
  evidence: RecordCopyExecutionEvidenceInput) => Promise<void>;

async function lockWorkerSettlementExecution(client: PoolClient, execution: CopyExecutionRecord): Promise<void> {
  // Shared with canonical claims/Jito receipts: position scope, execution, then
  // worker fence. Never take the fence first and wait on the execution row.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [JSON.stringify([execution.targetAccount, execution.chain, execution.tokenMint, execution.userId])]);
  const locked = await client.query(`SELECT id FROM copy_executions WHERE id = $1
    AND user_id IS NOT DISTINCT FROM $2 AND target_account = $3 AND chain = $4 AND token_mint = $5 FOR UPDATE`,
  [execution.id, execution.userId, execution.targetAccount, execution.chain, execution.tokenMint]);
  if (locked.rows.length !== 1) throw new Error('Worker settlement canonical lock scope mismatch');
}

/** Caller must lock/verify an independently validated durable receipt on THIS
 * client. Unknown worker fences stay unknown; no resubmission transition exists. */
export async function reconcileWorkerFillWithClient(client: PoolClient, input: WorkerFillSettlement,
  assertReceiptOwnership: WorkerReceiptOwnership) {
  await lockWorkerSettlementExecution(client, input.execution);
  await assertWorkerDeliveryWithClient(client, input.execution, input.delivery);
  await assertReceiptOwnership(client, input.attempt, input.evidence);
  const owned = await client.query(`SELECT execution_id FROM copy_execution_worker_attempts
    WHERE execution_id = $1 AND user_id IS NOT DISTINCT FROM $2 AND fence = $3::bigint AND policy_revision = $4
      AND risk_epoch IS NOT DISTINCT FROM $5::bigint AND state IN ('dispatched','unknown','settled') FOR UPDATE`,
  [input.attempt.executionId, input.attempt.userId, input.attempt.fence, input.attempt.policyRevision, input.attempt.riskEpoch]);
  if (owned.rows.length !== 1) throw new Error('Receipt reconciliation worker fence mismatch');
  return settleWorkerFillOperation(client, input, true);
}

export interface WorkerDeliverySettlement {
  readonly claim: FanoutDeliveryClaim;
  readonly now: Date;
}
export interface WorkerFillSettlement {
  readonly delivery?: WorkerDeliverySettlement;
  readonly execution: CopyExecutionRecord;
  readonly attempt: WorkerAttempt;
  readonly evidence: RecordCopyExecutionEvidenceInput;
  readonly executor: string;
  readonly risk: RiskSpendScope | null;
  readonly slippageBps: number;
}

/** Financial commit boundary. Caller owns transaction/tenant scope. A rollback
 * propagates to BullMQ; it must NOT be caught and acknowledged as a skipped fill.
 * Unknown fee/value retains liabilities even when base inventory is confirmed. */
export async function settleWorkerFillWithClient(client: PoolClient, input: WorkerFillSettlement) {
  await lockWorkerSettlementExecution(client, input.execution);
  await assertWorkerDeliveryWithClient(client, input.execution, input.delivery);
  return settleWorkerFillOperation(client, input, false);
}
async function settleWorkerFillOperation(client: PoolClient, input: WorkerFillSettlement, reconciliation: boolean): Promise<{
  tradeId: string; execution: CopyExecutionRecord; accountingComplete: boolean;
}> {
  const { execution, attempt, evidence } = input;
  if (execution.id !== attempt.executionId || execution.userId !== attempt.userId || evidence.executionId !== execution.id) {
    throw new Error('Worker settlement immutable execution/tenant mismatch');
  }
  assertExactExitQuantity(evidence.baseQuantity);
  if (!reconciliation) await assertWorkerAttemptWithClient(client, attempt);
  // Serialize the entire cohort BEFORE inserting evidence; a later READ COMMITTED
  // recount then sees the previous committer, not a stale UPDATE snapshot.
  if (execution.sourceTradeId) {
    const cohort = await client.query(`SELECT source_trade_id FROM master_capacity_ledger
      WHERE source_trade_id = $1 AND execution_mode = $2 FOR UPDATE`, [execution.sourceTradeId, execution.executionMode]);
    if (cohort.rows.length !== 1) throw new Error('Capacity accounting cohort missing');
  }
  const before = await client.query<{ confirmed_quote_quantity: string | null }>(
    `SELECT confirmed_quote_quantity::text FROM copy_executions WHERE id = $1 FOR UPDATE`, [execution.id]
  );
  if (before.rows.length !== 1) throw new Error('Canonical settlement execution missing');
  if (execution.executionMode !== 'live' && !reconciliation) {
    await transitionCopyExecutionWithClient(client, { executionId: execution.id, nextState: 'simulated',
      simulationId: `${input.executor}:${execution.clientOrderId}` });
  }
  const result = await recordCopyExecutionEvidenceWithClient(client, evidence);
  const total = await readWorkerFinancialTotalsWithClient(client, execution.id);
  await projectWorkerEconomicsWithClient(client, execution);
  if (execution.direction === 'buy') {
    if (!input.risk || input.risk.policyEpoch !== attempt.riskEpoch || input.risk.executionId !== execution.id) {
      throw new Error('Canonical buy settlement durable risk scope missing');
    }
    await updateRiskSpendReservation(client, { ...input.risk,
      state: total.unknown !== '0' ? 'unknown' : result.execution.state === 'confirmed' ? 'confirmed' : 'partial',
      confirmedUsd: total.debit });
  }
  const accountingComplete = total.evidenceCount !== '0' && total.unknown === '0' && total.completes && result.execution.state === 'confirmed';
  const settledExecution = accountingComplete ? result.execution
    : result.execution.state === 'confirmed'
      ? await transitionCopyExecutionWithClient(client, { executionId: execution.id, nextState: 'reconciliation_required',
        reason: 'Inventory confirmed but valuation/fee accounting incomplete', nextReconciliationAt: new Date() })
      : result.execution;
  const trade = await insertTradeWithClient(client, { signalId: execution.signalId, sourceTradeId: execution.sourceTradeId,
    exitLotId: execution.exitLotId ?? null,
    copyExecutionId: execution.id, userId: execution.userId, tokenMint: execution.tokenMint, chain: execution.chain,
    direction: execution.direction, executionMode: execution.executionMode, executor: input.executor,
    tokenAmount: total.base, amountUsd: total.quoteUnknown !== '0' ? null : total.quote,
    feeUsd: total.unknown === '0' ? total.fee : null,
    targetAmountUsd: execution.direction === 'buy' ? execution.requestedQuoteQuantity : null,
    priceUsd: null, slippageBps: input.slippageBps,
    status: accountingComplete ? 'filled' : 'partial', confirmedAt: evidence.occurredAt });
  if (!trade) throw new Error('Canonical trade settlement did not persist');
  await persistWorkerFinancialReceiptWithClient(client, input, trade.id, total, accountingComplete);
  if (!reconciliation) await finishWorkerAttemptWithClient(client, attempt, accountingComplete ? 'settled' : 'unknown');
  await settleWorkerDeliveryWithClient(client, execution, input.delivery, accountingComplete);
  return { tradeId: trade.id, execution: settledExecution, accountingComplete };
}

export async function retainWorkerUncertaintyWithClient(client: PoolClient, input: {
  execution: CopyExecutionRecord; attempt: WorkerAttempt; risk: RiskSpendScope | null; reason: string;
  delivery?: WorkerDeliverySettlement;
}): Promise<void> {
  if (input.execution.id !== input.attempt.executionId || input.execution.userId !== input.attempt.userId) {
    throw new Error('Worker uncertainty immutable execution/tenant mismatch');
  }
  await lockWorkerSettlementExecution(client, input.execution);
  await assertWorkerDeliveryWithClient(client, input.execution, input.delivery);
  const attemptRow = await client.query<{ state: string }>(`SELECT state FROM copy_execution_worker_attempts
    WHERE execution_id = $1 AND user_id IS NOT DISTINCT FROM $2 AND fence = $3::bigint AND policy_revision = $4
      AND risk_epoch IS NOT DISTINCT FROM $5::bigint AND state IN ('dispatched','unknown','settled') FOR UPDATE`,
  [input.attempt.executionId, input.attempt.userId, input.attempt.fence, input.attempt.policyRevision, input.attempt.riskEpoch]);
  if (attemptRow.rows.length !== 1) throw new Error('Worker uncertainty attempt identity/fence mismatch');
  // Reread durable accounting under the SAME execution→fence lock order as
  // receipt reconciliation: a late callback cannot undo a committed receipt.
  const canonical = await client.query<{ state: string; accounting_complete: boolean }>(`SELECT execution.state,
    (execution.state = 'confirmed'
      AND EXISTS (SELECT 1 FROM copy_execution_evidence evidence WHERE evidence.execution_id = execution.id
        AND evidence.confirmation_state IN ('confirmed','finalized') AND evidence.completes_execution)
      AND NOT EXISTS (SELECT 1 FROM worker_effective_execution_evidence evidence WHERE evidence.execution_id = execution.id
        AND evidence.confirmation_state IN ('confirmed','finalized') AND (evidence.effective_quote_usd IS NULL OR evidence.effective_fee_usd IS NULL))
      AND EXISTS (SELECT 1 FROM trades trade WHERE trade.copy_execution_id = execution.id AND trade.status = 'filled'
        AND trade.user_id IS NOT DISTINCT FROM execution.user_id AND trade.execution_mode = execution.execution_mode)
      AND (execution.direction <> 'buy' OR EXISTS (SELECT 1 FROM risk_spend_reservations risk
        WHERE risk.execution_id = execution.id AND risk.state = 'confirmed' AND risk.policy_epoch = $3::bigint))) AS accounting_complete
    FROM copy_executions execution WHERE execution.id = $1 AND execution.user_id IS NOT DISTINCT FROM $2 FOR UPDATE OF execution`,
  [input.execution.id, input.execution.userId, input.attempt.riskEpoch]);
  const current = canonical.rows[0];
  if (!current) throw new Error('Worker uncertainty canonical execution unavailable');
  if (current.accounting_complete || ['confirmed','failed','cancelled'].includes(current.state)
    || attemptRow.rows[0]!.state !== 'dispatched') {
    await settleWorkerDeliveryWithClient(client, input.execution, input.delivery, current.accounting_complete);
    return;
  }
  await transitionCopyExecutionWithClient(client, { executionId: input.execution.id, nextState: 'reconciliation_required',
    reason: input.reason, nextReconciliationAt: new Date() });
  if (input.risk) await updateRiskSpendReservation(client, { ...input.risk, state: 'unknown', confirmedUsd: null });
  await finishWorkerAttemptWithClient(client, input.attempt, 'unknown');
  await settleWorkerDeliveryWithClient(client, input.execution, input.delivery, false);
}

async function assertWorkerDeliveryWithClient(client: PoolClient, execution: CopyExecutionRecord,
  delivery: WorkerDeliverySettlement | undefined): Promise<void> {
  if (!delivery) return;
  const { claim } = delivery;
  if (claim.signalId !== execution.signalId || claim.userId !== execution.userId
    || claim.executionMode !== execution.executionMode || claim.targetAccount !== execution.targetAccount) {
    throw new Error('Worker delivery exact execution identity mismatch');
  }
  const result = await client.query<{ execution_id: string }>(`SELECT execution_id FROM source_fanout_deliveries
    WHERE signal_id = $1 AND user_id IS NOT DISTINCT FROM $2 AND execution_mode = $3 AND target_account = $4
      AND execution_id = $5 AND fence = $6::bigint
      AND ((state = 'claimed' AND lease_owner = $7 AND lease_until > $8)
        OR state IN ('reconciliation_required','completed')) FOR UPDATE`,
  [claim.signalId,claim.userId,claim.executionMode,claim.targetAccount,execution.id,claim.fence,claim.owner,delivery.now]);
  if (result.rows.length !== 1) throw new Error('Worker delivery persisted claim/fence unavailable');
}
async function settleWorkerDeliveryWithClient(client: PoolClient, execution: CopyExecutionRecord,
  delivery: WorkerDeliverySettlement | undefined, complete: boolean): Promise<void> {
  if (!delivery) return;
  // Completion is never inferred from queue state: a persisted economic receipt is mandatory.
  if (complete) {
    const receipt = await client.query(`SELECT receipt_id FROM copy_execution_financial_receipts
      WHERE execution_id = $1 AND user_id IS NOT DISTINCT FROM $2 AND accounting_complete
      ORDER BY recorded_at DESC LIMIT 1 FOR SHARE`, [execution.id,execution.userId]);
    if (receipt.rows.length !== 1) throw new Error('Worker delivery financial receipt missing');
  }
  const outcome = complete ? 'completed' : 'reconciliation_required';
  const settled = await settleFanoutDelivery(client, delivery.claim, { outcome, executionId: execution.id,
    reason: complete ? 'Canonical economic receipt committed with settlement' : 'Economic accounting incomplete; reconcile without new submission', now: delivery.now });
  if (settled) return;
  // Recovery cannot reclaim/resubmit uncertain work. Existing fence + exact identity
  // and SAME-client financial receipt authorize only its economic classification.
  const recovered = await client.query(`UPDATE source_fanout_deliveries SET state = $7, last_reason = $8, updated_at = $9
    WHERE signal_id = $1 AND user_id IS NOT DISTINCT FROM $2 AND execution_mode = $3 AND target_account = $4
      AND execution_id = $5 AND fence = $6::bigint AND state IN ('reconciliation_required','completed')
      AND (state <> 'completed' OR $7 = 'completed') RETURNING signal_id`,
  [delivery.claim.signalId,delivery.claim.userId,delivery.claim.executionMode,delivery.claim.targetAccount,execution.id,
    delivery.claim.fence,outcome,'Receipt-owned economic recovery',delivery.now]);
  if (recovered.rows.length !== 1) throw new Error('Worker delivery financial settlement fence lost');
}
async function persistWorkerFinancialReceiptWithClient(client: PoolClient, input: WorkerFillSettlement, tradeId: string,
  totals: import('./worker-valuation-corrections.js').WorkerFinancialTotals, complete: boolean): Promise<void> {
  const snapshot = { executionId: input.execution.id, userId: input.execution.userId, tradeId,
    fence: input.attempt.fence, totals, accountingComplete: complete };
  const receiptId = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const result = await client.query(`INSERT INTO copy_execution_financial_receipts
    (receipt_id,execution_id,user_id,trade_id,worker_fence,accounting_complete,snapshot)
    VALUES ($1,$2,$3,$4,$5::bigint,$6,$7::jsonb) ON CONFLICT (receipt_id) DO NOTHING RETURNING receipt_id`,
  [receiptId,input.execution.id,input.execution.userId,tradeId,input.attempt.fence,complete,JSON.stringify(snapshot)]);
  if (result.rows.length === 0) {
    const existing = await client.query(`SELECT receipt_id FROM copy_execution_financial_receipts
      WHERE receipt_id = $1 AND execution_id = $2 AND user_id IS NOT DISTINCT FROM $3 AND snapshot = $4::jsonb FOR SHARE`,
    [receiptId,input.execution.id,input.execution.userId,JSON.stringify(snapshot)]);
    if (existing.rows.length !== 1) throw new Error('Worker financial receipt idempotency conflict');
  }
}

export interface WorkerValuationSettlement extends WorkerFillSettlement {
  readonly correction: Omit<WorkerValuationCorrectionInput, 'execution'>;
}
/** Receipt-owned economic recovery: NEVER records/replays base evidence/application.
 * Protected persisted authorization plus original immutable receipt are both mandatory. */
export async function reconcileWorkerValuationWithClient(client: PoolClient, input: WorkerValuationSettlement,
  assertReceiptOwnership: WorkerReceiptOwnership): Promise<{ tradeId: string; execution: CopyExecutionRecord; accountingComplete: boolean; replayed: boolean }> {
  await lockWorkerSettlementExecution(client,input.execution);
  await assertWorkerDeliveryWithClient(client,input.execution,input.delivery);
  if (input.execution.id !== input.attempt.executionId || input.execution.userId !== input.attempt.userId
      || input.evidence.executionId !== input.execution.id) throw new Error('Worker correction execution/tenant mismatch');
  await assertReceiptOwnership(client,input.attempt,input.evidence);
  const originalReceipt = await client.query(`SELECT id FROM copy_execution_evidence WHERE id = $1 AND execution_id = $2
    AND evidence_type = $3 AND evidence_id = $4 AND base_quantity = $5::numeric
    AND fee_usd IS NOT DISTINCT FROM $6::numeric AND completes_execution = $7 AND occurred_at = $8 FOR SHARE`,
  [input.correction.originalEvidenceId,input.execution.id,input.evidence.evidenceType,input.evidence.evidenceId,
    input.evidence.baseQuantity,input.evidence.feeUsd ?? null,input.evidence.completesExecution,input.evidence.occurredAt]);
  if (originalReceipt.rows.length !== 1) throw new Error('Correction receipt ownership does not reference immutable original');
  const attempt = await client.query(`SELECT execution_id FROM copy_execution_worker_attempts
    WHERE execution_id = $1 AND user_id IS NOT DISTINCT FROM $2 AND fence = $3::bigint AND policy_revision = $4
      AND risk_epoch IS NOT DISTINCT FROM $5::bigint AND state IN ('dispatched','unknown','settled') FOR UPDATE`,
  [input.attempt.executionId,input.attempt.userId,input.attempt.fence,input.attempt.policyRevision,input.attempt.riskEpoch]);
  if (attempt.rows.length !== 1) throw new Error('Worker correction receipt fence mismatch');
  if (input.execution.sourceTradeId) {
    const cohort = await client.query(`SELECT source_trade_id FROM master_capacity_ledger
      WHERE source_trade_id = $1 AND execution_mode = $2 FOR UPDATE`, [input.execution.sourceTradeId,input.execution.executionMode]);
    if (cohort.rows.length !== 1) throw new Error('Capacity accounting cohort missing');
  }
  const correction = await appendWorkerValuationCorrectionWithClient(client,{...input.correction,execution:input.execution});
  const total = await readWorkerFinancialTotalsWithClient(client,input.execution.id);
  await projectWorkerEconomicsWithClient(client,input.execution);
  const complete = total.evidenceCount !== '0' && total.unknown === '0' && total.completes;
  // Economic completion is a persisted-authorized state-only SQL boundary,
  // not a new base fill or a caller-selected confirmed lifecycle transition.
  let execution = input.execution;
  if (complete) {
    const finalized = await client.query<{ finalized: boolean }>(`SELECT finalize_worker_correction($1) AS finalized`, [correction.correctionId]);
    if (finalized.rows[0]?.finalized !== true) throw new Error('Worker correction economic finalization unavailable');
    execution = {...input.execution,state:'confirmed',confirmedQuoteQuantity:total.quote,quoteUnassessedFillCount:0};
  } else {
    execution = await transitionCopyExecutionWithClient(client,{executionId:input.execution.id,
      nextState:'reconciliation_required',reason:'Immutable valuation correction accounting',nextReconciliationAt:input.correction.now});
  }
  if (input.execution.direction === 'buy') {
    if (!input.risk || input.risk.executionId !== input.execution.id || input.risk.policyEpoch !== input.attempt.riskEpoch) throw new Error('Worker correction risk scope missing');
    await updateRiskSpendReservation(client,{...input.risk,state:complete?'confirmed':'unknown',confirmedUsd:total.debit,
      valuationCorrectionId:correction.correctionId});
  }
  const trade = await insertTradeWithClient(client,{signalId:input.execution.signalId,sourceTradeId:input.execution.sourceTradeId,
    exitLotId:input.execution.exitLotId ?? null,copyExecutionId:input.execution.id,userId:input.execution.userId,
    tokenMint:input.execution.tokenMint,chain:input.execution.chain,direction:input.execution.direction,
    executionMode:input.execution.executionMode,executor:input.executor,tokenAmount:total.base,
    amountUsd:total.quoteUnknown==='0'?total.quote:null,feeUsd:total.unknown==='0'?total.fee:null,
    targetAmountUsd:input.execution.direction==='buy'?input.execution.requestedQuoteQuantity:null,
    status:complete?'filled':'partial',slippageBps:input.slippageBps,confirmedAt:input.evidence.occurredAt});
  if (!trade) throw new Error('Worker correction trade unavailable');
  await persistWorkerFinancialReceiptWithClient(client,input,trade.id,total,complete);
  await settleWorkerDeliveryWithClient(client,input.execution,input.delivery,complete);
  return {tradeId:trade.id,execution,accountingComplete:complete,replayed:correction.replayed};
}
