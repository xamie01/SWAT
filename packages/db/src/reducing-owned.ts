import {
  requireFinancial, financialText, financialHash, type FinancialRecord, type FinancialReceipt, type WithdrawalSqlClient
} from './withdrawal-contract.js';
import { reducingRemainder, type ReducingIntent, type ReducingAccountingResult } from './reducing-contract.js';

/** Canonical SQL082 same-client settler seam extracted unchanged from polymarket-perps.ts. No pool graph. */
export async function applyPerpsReducingReceiptWithClient(client: WithdrawalSqlClient, record: FinancialRecord<ReducingIntent>,
  receipt: FinancialReceipt, deltaRaw: string, deltaFeeRaw: string): Promise<ReducingAccountingResult> {
  const intent = record.intent;
  requireFinancial(intent.venue === 'polymarket-perps' && intent.chain === 'polygon', 'perps-reducing-venue-mismatch');
  requireFinancial(receipt.intentId === record.id && receipt.intentHash === record.intentHash, 'perps-receipt-scope-mismatch');
  requireFinancial(receipt.feeAssetId === intent.feeAssetId && receipt.feeAssetScale === intent.feeAssetScale
    && receipt.feeFundingAccountId === intent.feeFundingAccountId, 'perps-receipt-fee-denomination-mismatch');
  const proof = await client.query<{ delta_raw: string; delta_fee_raw: string }>(`SELECT
    (receipt.cumulative_raw-attempt.completed_raw)::text AS delta_raw,
    (receipt.fee_raw-attempt.completed_fee_raw)::text AS delta_fee_raw
    FROM public.withdrawal_reducing_receipts receipt JOIN public.withdrawal_reducing_attempts attempt
      ON attempt.id=receipt.attempt_id AND attempt.intent_id=receipt.intent_id AND attempt.user_id=receipt.user_id
    WHERE receipt.receipt_id=$1 AND receipt.intent_id=$2 AND receipt.user_id=$3 AND receipt.receipt_hash=$4
      AND NOT attempt.terminal /* reducing:perps-delta */`,
  [receipt.receiptId, record.id, record.userId, financialHash(receipt)]);
  requireFinancial(proof.rows[0]?.delta_raw === deltaRaw && proof.rows[0]?.delta_fee_raw === deltaFeeRaw,
    'perps-reducing-receipt-delta-mismatch');
  const economics = await client.query<{ economics_reference: string }>(`SELECT economics_reference
    FROM public.reducing_perps_economics_admissions WHERE receipt_id=$1 AND intent_id=$2 AND user_id=$3
      AND delta_raw=$4::numeric AND delta_fee_raw=$5::numeric /* reducing:perps-economics */`,
  [receipt.receiptId, record.id, record.userId, deltaRaw, deltaFeeRaw]);
  requireFinancial(economics.rows[0], 'perps-every-fill-economics-unavailable');
  const result = await client.query<{
    accounting_reference: string; position_id: string; position_side: 'LONG' | 'SHORT'; before_raw: string; after_raw: string
  }>(`SELECT * FROM public.swat_apply_perps_reducing_receipt($1,$2) /* reducing:perps-account */`, [record.id, receipt.receiptId]);
  const applied = result.rows[0];
  requireFinancial(applied && applied.position_id === intent.positionId && applied.position_side === intent.positionSide,
    'perps-reducing-position-scope-mismatch');
  requireFinancial(applied.after_raw === reducingRemainder(applied.position_side, intent.side, applied.before_raw, deltaRaw),
    'perps-reducing-accounting-conflict');
  return { accountingReference: financialText(applied.accounting_reference), positionId: applied.position_id,
    positionSide: applied.position_side, beforeRaw: applied.before_raw, afterRaw: applied.after_raw,
    economicsReference: financialText(economics.rows[0].economics_reference) };
}
