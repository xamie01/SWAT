import type { PoolClient } from 'pg';
import { reconcileWorkerFillWithClient } from './worker-settlement.js';
import { getCopyExecutionByIdWithClient } from './copy-trade-lifecycle.js';
import { assertJitoPrepared, jitoJson, jitoPendingFromRow, readJitoPendingWithClient,
  type DurableJitoPending, type JitoExecutionIdentity } from './jito-pending.js';

export interface QuantifiedJitoReceipt {
  readonly execution: JitoExecutionIdentity; readonly signature: string; readonly slot: number;
  readonly inputMint: string; readonly outputMint: string; readonly inputAmountRaw: string; readonly outputAmountRaw: string;
  readonly recipient: string; readonly confirmationState: 'confirmed' | 'finalized'; readonly occurredAt: Date;
  readonly feeLamports: string; readonly feeUsd: string;
  /** Independently valued observed native quote leg, not Jupiter output estimate. */
  readonly quoteUsd: string;
  /** Exact canonical token units, independently scaled from observed raw units. */
  readonly baseQuantity: string;
}
const MONEY = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
export function jitoDecimalAtMost(value: string, cap: string): boolean {
  if (!MONEY.test(value) || !MONEY.test(cap)) return false;
  const places = Math.max(value.split('.')[1]?.length ?? 0, cap.split('.')[1]?.length ?? 0);
  const scaled = (v: string) => BigInt(v.split('.')[0]! + (v.split('.')[1] ?? '').padEnd(places, '0'));
  return scaled(value) <= scaled(cap);
}
export function jitoRawToDecimal(raw: string, decimals: number): string {
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Jito token scale unavailable');
  if (!decimals) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`.replace(/0+$/, '').replace(/\.$/, '');
}
export function assertQuantifiedJitoReceipt(receipt: QuantifiedJitoReceipt, pending: DurableJitoPending): void {
  assertJitoPrepared(pending);
  const e = pending.execution; const r = receipt?.execution;
  if (!r || r.executionId !== e.executionId || r.clientOrderId !== e.clientOrderId || r.userId !== e.userId
    || r.chain !== e.chain || r.targetAccount !== e.targetAccount
    || receipt.signature !== pending.signatures[0] || !Number.isSafeInteger(receipt.slot) || receipt.slot < 0
    || receipt.inputMint !== pending.intent.inputMint || receipt.outputMint !== pending.intent.outputMint
    || receipt.recipient !== pending.intent.recipient || receipt.inputAmountRaw !== pending.intent.inputAmountRaw
    || !/^[1-9][0-9]*$/.test(receipt.outputAmountRaw)
    || BigInt(receipt.outputAmountRaw) < BigInt(pending.intent.minimumOutputAmountRaw)
    || !['confirmed','finalized'].includes(receipt.confirmationState)
    || !(receipt.occurredAt instanceof Date) || !Number.isFinite(receipt.occurredAt.getTime())
    || !/^(?:0|[1-9][0-9]*)$/.test(receipt.feeLamports) || BigInt(receipt.feeLamports) < BigInt(pending.tipLamports)
    || BigInt(receipt.feeLamports) > BigInt(pending.intent.maxFeeLamports)
    || !jitoDecimalAtMost(receipt.feeUsd, pending.intent.maxFeeUsd)
    || !MONEY.test(receipt.feeUsd) || receipt.feeUsd === '0' || !MONEY.test(receipt.quoteUsd) || receipt.quoteUsd === '0'
    || !MONEY.test(receipt.baseQuantity) || receipt.baseQuantity === '0'
    || receipt.baseQuantity !== jitoRawToDecimal(pending.intent.inputMint === 'So11111111111111111111111111111111111111112'
      ? receipt.outputAmountRaw : receipt.inputAmountRaw, pending.intent.tokenDecimals)) throw new Error('Jito quantified receipt scope/bounds unavailable');
}

export function assertJitoReceiptObservation(stored: QuantifiedJitoReceipt, observed: QuantifiedJitoReceipt): void {
  const { confirmationState: prior, ...immutable } = stored;
  const { confirmationState: next, ...observedImmutable } = observed;
  if (jitoJson(immutable) !== jitoJson(observedImmutable)
    || !((prior === 'confirmed' && (next === 'confirmed' || next === 'finalized'))
      || (prior === 'finalized' && next === 'finalized'))) throw new Error('Jito receipt collision or confirmation regression');
}

/** Receipt ownership + ALL canonical financial writes share the caller transaction.
 * Receipt-owned reconciliation accepts original unknown fences without
 * promoting dispatch authority. Rollback is replayable. */
export async function settleJitoReceiptWithClient(client: PoolClient, pending: DurableJitoPending,
  receipt: QuantifiedJitoReceipt, settle: typeof reconcileWorkerFillWithClient = reconcileWorkerFillWithClient): Promise<boolean> {
  assertQuantifiedJitoReceipt(receipt, pending);
  // Match canonical position-first lock order before receipt/outbox row locks.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [JSON.stringify([pending.execution.targetAccount, 'solana',
      `solana:${pending.intent.inputMint === 'So11111111111111111111111111111111111111112' ? pending.intent.outputMint : pending.intent.inputMint}`,
      pending.execution.userId])]);
  const execution = await getCopyExecutionByIdWithClient(client, pending.execution.executionId);
  const row = await readJitoPendingWithClient(client, pending.clientOrderId, true);
  const stored = row && jitoPendingFromRow(row);
  if (!execution || !stored || jitoJson(stored) !== jitoJson(pending)
    || execution.clientOrderId !== pending.clientOrderId || execution.userId !== pending.execution.userId
    || execution.targetAccount !== pending.execution.targetAccount || execution.chain !== 'solana'
    || execution.executionMode !== 'live'
    || (execution.direction === 'sell' ? pending.intent.inputMint : pending.intent.outputMint) !== execution.tokenMint.slice(7)
    || (execution.direction === 'sell' ? pending.intent.outputMint : pending.intent.inputMint) !== 'So11111111111111111111111111111111111111112'
    || (execution.direction === 'sell' && receipt.baseQuantity !== execution.requestedBaseQuantity)) {
    throw new Error('Jito settlement durable identity mismatch');
  }
  const existing = await client.query<{ receipt: QuantifiedJitoReceipt; settled: boolean }>(
    `SELECT receipt, settled FROM jito_execution_receipts WHERE execution_id = $1 FOR UPDATE`, [execution.id]);
  let financialReceipt = receipt;
  if (existing.rows[0]) {
    financialReceipt = { ...existing.rows[0].receipt, occurredAt: new Date(existing.rows[0].receipt.occurredAt) };
    assertQuantifiedJitoReceipt(financialReceipt, pending);
    assertJitoReceiptObservation(financialReceipt, receipt);
    if (existing.rows[0].settled) return true;
  } else {
    await client.query(`INSERT INTO jito_execution_receipts (execution_id,user_id,signature,slot,receipt)
      VALUES ($1,$2,$3,$4::bigint,$5::jsonb)`, [execution.id, execution.userId, receipt.signature, String(receipt.slot), JSON.stringify(receipt)]);
  }
  // A monotonic provider observation never rewrites the original economic
  // evidence. Uncommitted retries and acknowledgement recover that exact receipt.
  const encoded = JSON.stringify(financialReceipt);
  if (row!.state === 'settled') throw new Error('Jito settlement marker without committed receipt');
  const risk = execution.direction === 'buy' ? { account: execution.userId ?? 'operator', chain: 'solana' as const,
    executionMode: 'live' as const, executionId: execution.id, policyEpoch: pending.attempt.riskEpoch! } : null;
  if (risk && !risk.policyEpoch) throw new Error('Jito durable buy risk epoch unavailable');
  const result = await settle(client, { execution, attempt: pending.attempt, risk,
    executor: 'jupiter-jito', slippageBps: pending.intent.slippageBps,
    evidence: { executionId: execution.id, evidenceType: 'chain_receipt', evidenceId: receipt.signature,
      confirmationState: financialReceipt.confirmationState, occurredAt: financialReceipt.occurredAt,
      baseQuantity: financialReceipt.baseQuantity, quoteLeg: { amount: financialReceipt.quoteUsd, currency: 'USD' },
      feeUsd: financialReceipt.feeUsd, completesExecution: true } }, async (ownedClient, ownedAttempt, evidence) => {
    if (ownedClient !== client || jitoJson(ownedAttempt) !== jitoJson(pending.attempt)
      || evidence.executionId !== execution.id || evidence.evidenceId !== receipt.signature) throw new Error('Jito receipt ownership callback mismatch');
    const owned = await ownedClient.query(`SELECT r.execution_id FROM jito_execution_receipts r
      JOIN jito_execution_pending p ON p.execution_id = r.execution_id
      WHERE r.execution_id = $1 AND r.user_id IS NOT DISTINCT FROM $2 AND r.signature = $3
        AND r.receipt = $4::jsonb AND p.attempt = $5::jsonb AND p.execution_identity = $6::jsonb
      FOR UPDATE OF r, p`, [execution.id, execution.userId, receipt.signature, encoded,
      JSON.stringify(pending.attempt), JSON.stringify(pending.execution)]);
    if (owned.rows.length !== 1) throw new Error('Jito durable receipt ownership missing');
  });
  if (result.accountingComplete !== true) throw new Error('Jito financial accounting remains incomplete');
  await client.query(`UPDATE jito_execution_receipts SET settled = true, settled_at = NOW() WHERE execution_id = $1`, [execution.id]);
  return true;
}
