import {
  financialHash, requireFinancial, exactRaw, type FinancialAttempt, type FinancialReceipt, type FinancialRecord,
  type WithdrawalIntent, type WithdrawalTransaction
} from '@swat/db/dist/withdrawal-contract.js';
import type { ReducingIntent } from '@swat/db/dist/reducing-contract.js';

export type OwnedFinancialIntent = WithdrawalIntent | ReducingIntent;
export interface OwnedFinancialJournal<I extends OwnedFinancialIntent> {
  readonly record: FinancialRecord<I>;
  readonly attempts: readonly FinancialAttempt[];
  readonly receipts: readonly { receipt: FinancialReceipt; hash: string }[];
  readonly applications: readonly { receiptId: string; attemptId: string; deltaRaw: string; accountingReference: string }[];
  readonly reservations: readonly { budgetKey: string; amountRaw: string; feeRaw: string; reservedRaw: string }[];
  readonly outbox: readonly { intentHash: string }[];
  readonly authorization: readonly { id: string; consumed: boolean; failures: number; delivery: string }[];
}

/** Independent primary durable read: no service status/callback projections and no OTP/digest/provider proof output. */
export function createOwnedFinancialObserver<I extends OwnedFinancialIntent>(transaction: WithdrawalTransaction) {
  return async (userId: string, intentId: string): Promise<OwnedFinancialJournal<I>> => transaction(userId, async client => {
    const rows = (await client.query<{
      id: string; user_id: string; intent: I; intent_hash: string; status: FinancialRecord<I>['status'];
      completed_raw: string; terminal: boolean; created_at: string | Date; cancellation_reason: string | null
    }>(`SELECT id,user_id,intent,intent_hash,status,completed_raw::text,terminal,created_at,cancellation_reason
      FROM public.withdrawal_reducing_intents WHERE user_id=$1 AND id=$2 /* financial-observer:intent */`, [userId,intentId])).rows;
    const r = rows[0];
    requireFinancial(rows.length === 1 && r && r.id === intentId && r.user_id === userId && r.intent.userId === userId
      && r.intent_hash === financialHash(r.intent), 'financial-observer-intent-binding');
    const record: FinancialRecord<I> = { id:r.id,userId:r.user_id,intent:r.intent,intentHash:r.intent_hash,status:r.status,
      completedRaw:r.completed_raw,terminal:r.terminal,createdAt:new Date(r.created_at).toISOString(),cancellationReason:r.cancellation_reason };
    const attempts = (await client.query<FinancialAttempt>(`SELECT id,intent_id AS "intentId",user_id AS "userId",
      intent_hash AS "intentHash",client_order_id AS "clientOrderId",state,completed_raw::text AS "completedRaw",
      completed_fee_raw::text AS "completedFeeRaw",terminal FROM public.withdrawal_reducing_attempts
      WHERE user_id=$1 AND intent_id=$2 /* financial-observer:attempts */`, [userId,intentId])).rows;
    const receipts = (await client.query<{ receipt: FinancialReceipt; hash: string }>(`SELECT receipt,receipt_hash AS hash
      FROM public.withdrawal_reducing_receipts WHERE user_id=$1 AND intent_id=$2 ORDER BY admitted_at,receipt_id
      /* financial-observer:receipts */`, [userId,intentId])).rows;
    const applications = (await client.query<OwnedFinancialJournal<I>['applications'][number]>(`SELECT receipt_id AS "receiptId",
      attempt_id AS "attemptId",delta_raw::text AS "deltaRaw",accounting_reference AS "accountingReference"
      FROM public.withdrawal_reducing_applications WHERE user_id=$1 AND intent_id=$2 ORDER BY applied_at,receipt_id
      /* financial-observer:applications */`, [userId,intentId])).rows;
    const reservations = (await client.query<OwnedFinancialJournal<I>['reservations'][number]>(`SELECT budget_key AS "budgetKey",
      amount_raw::text AS "amountRaw",fee_raw::text AS "feeRaw",reserved_raw::text AS "reservedRaw"
      FROM public.withdrawal_reducing_reservations WHERE user_id=$1 AND intent_id=$2 ORDER BY budget_key
      /* financial-observer:reservations */`, [userId,intentId])).rows;
    const outbox = (await client.query<{ intentHash: string }>(`SELECT intent_hash AS "intentHash"
      FROM public.withdrawal_reducing_outbox WHERE user_id=$1 AND intent_id=$2 /* financial-observer:outbox */`, [userId,intentId])).rows;
    const authorization = (await client.query<OwnedFinancialJournal<I>['authorization'][number]>(`SELECT id,
      consumed_at IS NOT NULL AS consumed,failures,delivery_state AS delivery FROM public.withdrawal_authorizations
      WHERE user_id=$1 AND intent_id=$2 /* financial-observer:authorization */`, [userId,intentId])).rows;
    return { record,attempts,receipts,applications,reservations,outbox,authorization };
  });
}

/** Independent arithmetic checks exact durable quantities, fees and application/admission bindings after checked COMMIT. */
export function assertOwnedFinancialConservation<I extends OwnedFinancialIntent>(journal: OwnedFinancialJournal<I>): void {
  const { record, attempts, receipts, applications, reservations, outbox } = journal;
  const maximum = BigInt(exactRaw(record.intent.kind === 'withdrawal' ? record.intent.amountRaw : record.intent.quantityRaw));
  requireFinancial(record.intentHash === financialHash(record.intent) && record.userId === record.intent.userId
    && outbox.length === 1 && outbox[0]?.intentHash === record.intentHash && attempts.length <= 1,
  'financial-observer-admission-binding');
  const attempt = attempts[0];
  if (attempt) requireFinancial(attempt.intentId === record.id && attempt.userId === record.userId
    && attempt.intentHash === record.intentHash && attempt.completedRaw === record.completedRaw
    && attempt.terminal === record.terminal, 'financial-observer-attempt-binding');
  requireFinancial(new Set(applications.map(a => a.receiptId)).size === applications.length,
    'financial-observer-duplicate-application');
  let completed = 0n;
  for (const application of applications) {
    const matching = receipts.filter(r => r.receipt.receiptId === application.receiptId);
    requireFinancial(matching.length === 1 && matching[0] && matching[0].hash === financialHash(matching[0].receipt),
      'financial-observer-independent-receipt-required');
    const receipt = matching[0].receipt;
    requireFinancial(attempt && receipt.intentId === record.id && receipt.intentHash === record.intentHash
      && receipt.attemptId === attempt.id && application.attemptId === attempt.id && receipt.clientOrderId === attempt.clientOrderId
      && receipt.feeAssetId === record.intent.feeAssetId && receipt.feeAssetScale === record.intent.feeAssetScale
      && receipt.feeFundingAccountId === record.intent.feeFundingAccountId && application.accountingReference.length > 0,
    'financial-observer-full-receipt-binding');
    completed += BigInt(exactRaw(application.deltaRaw));
  }
  requireFinancial(completed === BigInt(exactRaw(record.completedRaw)) && completed <= maximum,
    'financial-observer-quantity-not-conserved');
  const fee = attempt ? BigInt(exactRaw(attempt.completedFeeRaw)) : 0n;
  requireFinancial(fee <= BigInt(exactRaw(record.intent.maxFeeRaw)), 'financial-observer-fee-ceiling');
  if (attempt && applications.length) requireFinancial(receipts.some(({receipt,hash}) => hash === financialHash(receipt)
    && applications.some(a => a.receiptId === receipt.receiptId) && receipt.cumulativeRaw === record.completedRaw
    && receipt.feeRaw === attempt.completedFeeRaw && receipt.terminal === record.terminal), 'financial-observer-final-progress-binding');
  for (const row of reservations) {
    const principal = BigInt(exactRaw(row.amountRaw)), ceiling = BigInt(exactRaw(row.feeRaw));
    const spent = (principal > 0n ? completed : 0n) + (ceiling > 0n ? fee : 0n);
    requireFinancial(spent <= principal + ceiling && BigInt(exactRaw(row.reservedRaw)) === (record.terminal ? 0n : principal + ceiling - spent),
      'financial-observer-reservation-not-conserved');
  }
  requireFinancial(!record.terminal || applications.length > 0, 'financial-observer-terminal-without-receipt');
}
