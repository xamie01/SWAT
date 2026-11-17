import type { PoolClient } from 'pg';
import type { WorkerAttempt } from './worker-execution.js';
import { getCopyExecutionByIdWithClient } from './copy-trade-lifecycle.js';

export interface JitoExecutionIdentity {
  readonly executionId: string; readonly clientOrderId: string; readonly userId: string | null;
  readonly chain: 'solana'; readonly targetAccount: string;
}
export interface JitoIndependentIntent {
  readonly inputMint: string; readonly outputMint: string; readonly inputAmountRaw: string;
  readonly minimumOutputAmountRaw: string; readonly slippageBps: number; readonly recipient: string;
  readonly tokenDecimals: number; readonly maxFeeLamports: string; readonly maxFeeUsd: string;
}
export interface DurableJitoPending {
  readonly clientOrderId: string; readonly bundleId: string | null;
  readonly execution: JitoExecutionIdentity; readonly intent: JitoIndependentIntent; readonly attempt: WorkerAttempt;
  readonly signedTransactions: readonly string[]; readonly signatures: readonly string[];
  readonly lastValidBlockHeight: number; readonly expiresAt: Date; readonly tipLamports: number;
}
export interface JitoPendingRow {
  client_order_id: string; state: 'claimed' | 'prepared' | 'submitted' | 'settled';
  execution_identity: JitoExecutionIdentity; intent: JitoIndependentIntent; attempt: WorkerAttempt;
  signed_transactions: string[] | null; signatures: string[] | null; bundle_id: string | null;
  last_valid_block_height: string | null; expires_at: Date | null; tip_lamports: string | null;
}
export function jitoJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
const RAW = /^[1-9][0-9]*$/;
const TEXT = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && v.trim() === v;
export function assertJitoIntent(intent: JitoIndependentIntent): void {
  if (!intent || !TEXT(intent.inputMint) || !TEXT(intent.outputMint) || intent.inputMint === intent.outputMint
    || !TEXT(intent.recipient) || !RAW.test(intent.inputAmountRaw) || !RAW.test(intent.minimumOutputAmountRaw)
    || !RAW.test(intent.maxFeeLamports) || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(intent.maxFeeUsd)
    || intent.maxFeeUsd === '0'
    || !Number.isInteger(intent.tokenDecimals) || intent.tokenDecimals < 0 || intent.tokenDecimals > 18
    || !Number.isInteger(intent.slippageBps) || intent.slippageBps < 0 || intent.slippageBps >= 10000) {
    throw new Error('Jito independent intent unavailable');
  }
}
export function assertJitoPrepared(pending: DurableJitoPending): void {
  assertJitoIntent(pending.intent);
  if (!pending.execution || !pending.attempt || pending.clientOrderId !== pending.execution.clientOrderId
    || pending.execution.executionId !== pending.attempt.executionId || pending.execution.userId !== pending.attempt.userId
    || pending.execution.chain !== 'solana' || pending.execution.targetAccount !== `solana:${pending.intent.recipient}`
    || !Number.isSafeInteger(pending.lastValidBlockHeight) || pending.lastValidBlockHeight <= 0
    || !(pending.expiresAt instanceof Date) || !Number.isFinite(pending.expiresAt.getTime())
    || !Number.isSafeInteger(pending.tipLamports) || pending.tipLamports <= 0
    || BigInt(pending.tipLamports) > BigInt(pending.intent.maxFeeLamports)
    || !Array.isArray(pending.signedTransactions) || !Array.isArray(pending.signatures)
    || pending.signedTransactions.length !== 2 || pending.signatures.length !== 2
    || new Set(pending.signatures).size !== 2
    || pending.signatures.some(s => !TEXT(s) || s === 'pending_unknown')
    || pending.signedTransactions.some(tx => typeof tx !== 'string' || tx.length > 4096
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(tx)
      || !tx || Buffer.from(tx, 'base64').toString('base64') !== tx)) {
    throw new Error('Jito exact prepared identity unavailable');
  }
}
export function jitoPendingFromRow(row: JitoPendingRow): DurableJitoPending | null {
  if (row.state === 'claimed' || !row.signed_transactions || !row.signatures || row.last_valid_block_height === null
    || !row.expires_at || row.tip_lamports === null) return null;
  const pending: DurableJitoPending = { clientOrderId: row.client_order_id, bundleId: row.bundle_id,
    execution: row.execution_identity, intent: row.intent, attempt: row.attempt,
    signedTransactions: row.signed_transactions, signatures: row.signatures,
    lastValidBlockHeight: Number(row.last_valid_block_height), expiresAt: row.expires_at, tipLamports: Number(row.tip_lamports) };
  assertJitoPrepared(pending);
  return pending;
}
export async function readJitoPendingWithClient(client: PoolClient, id: string, lock = false): Promise<JitoPendingRow | null> {
  const result = await client.query<JitoPendingRow>(`SELECT * FROM jito_execution_pending WHERE client_order_id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return result.rows[0] ?? null;
}
export async function claimJitoPendingWithClient(client: PoolClient, execution: JitoExecutionIdentity,
  intent: JitoIndependentIntent, attempt: WorkerAttempt): Promise<boolean> {
  assertJitoIntent(intent);
  const discovered = await client.query<{ target_account: string; token_mint: string; user_id: string | null }>(
    `SELECT target_account, token_mint, user_id FROM copy_executions WHERE id = $1`, [execution.executionId]);
  const scope = discovered.rows[0];
  if (!scope || scope.target_account !== execution.targetAccount || scope.user_id !== execution.userId) throw new Error('Jito canonical scope unavailable');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [JSON.stringify([scope.target_account, 'solana', scope.token_mint, scope.user_id])]);
  const canonical = await getCopyExecutionByIdWithClient(client, execution.executionId);
  if (!canonical || canonical.chain !== 'solana' || canonical.executionMode !== 'live'
    || canonical.id !== attempt.executionId || canonical.userId !== attempt.userId
    || canonical.userId !== execution.userId || canonical.clientOrderId !== execution.clientOrderId
    || canonical.targetAccount !== execution.targetAccount || execution.targetAccount !== `solana:${intent.recipient}`
    || ['confirmed','failed','cancelled'].includes(canonical.state)
    || (canonical.direction === 'sell' ? intent.inputMint : intent.outputMint) !== canonical.tokenMint.slice(7)
    || (canonical.direction === 'sell' ? intent.outputMint : intent.inputMint) !== 'So11111111111111111111111111111111111111112') {
    throw new Error('Jito canonical claim identity mismatch');
  }
  if (canonical.direction === 'sell') {
    const raw = intent.inputAmountRaw.padStart(intent.tokenDecimals + 1, '0');
    const exact = intent.tokenDecimals
      ? `${raw.slice(0, -intent.tokenDecimals)}.${raw.slice(-intent.tokenDecimals)}`.replace(/0+$/, '').replace(/\.$/, '')
      : raw;
    if (exact !== canonical.requestedBaseQuantity) throw new Error('Jito canonical sell quantity mismatch');
  }
  const fence = await client.query(`SELECT execution_id FROM copy_execution_worker_attempts WHERE execution_id = $1
    AND user_id IS NOT DISTINCT FROM $2 AND fence = $3::bigint AND policy_revision = $4
    AND risk_epoch IS NOT DISTINCT FROM $5::bigint AND state = 'dispatched' FOR UPDATE`,
  [attempt.executionId, attempt.userId, attempt.fence, attempt.policyRevision, attempt.riskEpoch]);
  if (fence.rows.length !== 1) throw new Error('Jito durable worker fence unavailable');
  const inserted = await client.query(`INSERT INTO jito_execution_pending
    (execution_id,user_id,client_order_id,execution_identity,intent,attempt)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) ON CONFLICT DO NOTHING RETURNING execution_id`,
  [execution.executionId, execution.userId, execution.clientOrderId, JSON.stringify(execution), JSON.stringify(intent), JSON.stringify(attempt)]);
  return inserted.rows.length === 1;
}
export async function prepareJitoPendingWithClient(client: PoolClient, pending: DurableJitoPending): Promise<void> {
  assertJitoPrepared(pending);
  if (pending.bundleId !== null) throw new Error('Jito prewrite must precede bundle response');
  const result = await client.query(`UPDATE jito_execution_pending SET state = 'prepared',
    signed_transactions = $4::jsonb, signatures = $5::jsonb, last_valid_block_height = $6::bigint,
    expires_at = $7, tip_lamports = $8::bigint, prepared_at = NOW()
    WHERE client_order_id = $1 AND execution_identity = $2::jsonb AND intent = $3::jsonb
      AND attempt = $9::jsonb AND state = 'claimed' RETURNING execution_id`,
  [pending.clientOrderId, JSON.stringify(pending.execution), JSON.stringify(pending.intent), JSON.stringify(pending.signedTransactions),
    JSON.stringify(pending.signatures), String(pending.lastValidBlockHeight), pending.expiresAt, String(pending.tipLamports), JSON.stringify(pending.attempt)]);
  if (result.rows.length !== 1) throw new Error('Jito durable preparation ownership mismatch');
}
export async function saveJitoBundleWithClient(client: PoolClient, pending: DurableJitoPending): Promise<void> {
  assertJitoPrepared(pending);
  if (!TEXT(pending.bundleId) || pending.bundleId === 'pending_unknown') throw new Error('Jito bundle response invalid');
  const row = await readJitoPendingWithClient(client, pending.clientOrderId, true);
  const prepared = row && jitoPendingFromRow(row);
  if (!prepared || (row!.state !== 'prepared' && row!.state !== 'submitted')
    || jitoJson({ ...prepared, bundleId: null }) !== jitoJson({ ...pending, bundleId: null })
    || (prepared.bundleId !== null && prepared.bundleId !== pending.bundleId)) throw new Error('Jito exact bytes or response identity changed');
  await client.query(`UPDATE jito_execution_pending SET bundle_id = $2, state = 'submitted'
    WHERE client_order_id = $1`, [pending.clientOrderId, pending.bundleId]);
}
