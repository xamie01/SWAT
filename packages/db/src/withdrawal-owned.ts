import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
export type { PoolClient } from 'pg';
import {
  financialHash, financialUser, requireFinancial, exactRaw, financialTime, validateNoFutureAcceptance,
  type FinancialAttempt, type FinancialReceipt,
  type FinancialRecord, type WithdrawalIntent, type WithdrawalSqlClient, type WithdrawalTransaction
} from './withdrawal-contract.js';
import type { ReducingIntent } from './reducing-contract.js';

/** Supplied primary lease only. No pool, credentials, SET ROLE, service startup or ambient fallback. */
export interface FinancialOwnedClient extends WithdrawalSqlClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; command?: string }>;
}
export interface FinancialClientLease {
  readonly client: FinancialOwnedClient;
  release(broken: boolean): void;
}
export interface FinancialSafetyDeadline { check(): void }
export const FINANCIAL_IDENTITY_SQL = `SELECT current_user AS role_name, session_user AS session_role,
  current_setting('role') AS role_setting, current_setting('row_security') AS row_security,
  r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
  pg_backend_pid() AS backend_pid,
  (SELECT xact_start=query_start FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid()) AS transaction_clean,
  EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS has_memberships,
  (EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner=r.oid)) AS owns_objects,
  has_table_privilege(current_user,'public.withdrawal_reducing_receipts','INSERT') AS receipt_insert,
  has_table_privilege(current_user,'public.withdrawal_reducing_intents','INSERT') AS intent_insert
  FROM pg_catalog.pg_roles r WHERE rolname=current_user /* financial-owned:identity */`;
const contexts = new AsyncLocalStorage<{ poisoned: boolean }>();
const leased = new WeakSet<object>();
export class FinancialCommitUncertainError extends Error {
  constructor() { super('Financial COMMIT outcome uncertain; discard lease and independently reconcile'); this.name = 'FinancialCommitUncertainError'; }
}

/** Actual catalog identity, never capability labels, is checked before any domain operation and before COMMIT. */
export async function assertFinancialIdentity(client: FinancialOwnedClient, role: 'swat_app' | 'swat_financial_receipt_writer',
  requireCleanLease = false): Promise<number> {
  const { rows } = await client.query<Record<string, unknown>>(FINANCIAL_IDENTITY_SQL);
  const r = rows[0];
  requireFinancial(rows.length === 1 && r && r.role_name === role && r.session_role === role && r.role_setting === 'none'
    && r.row_security === 'on' && r.rolcanlogin === true && Number.isInteger(r.backend_pid) && Number(r.backend_pid) > 0
    && ['rolsuper','rolbypassrls','rolinherit','rolcreaterole','rolcreatedb','rolreplication','has_memberships','owns_objects']
      .every(key => r[key] === false)
    && (!requireCleanLease || r.transaction_clean === true)
    && r.receipt_insert === (role === 'swat_financial_receipt_writer') && r.intent_insert === (role === 'swat_app'),
  'financial-distinct-approved-database-identity-unavailable');
  return Number(r.backend_pid);
}

/** Lexical statement check ignores literals/identifiers/comments; parameter data never enters SQL text. */
export function financialOperationSqlAllowed(sql: string): boolean {
  if(typeof sql!=='string' || sql.length===0 || sql.length>32_768) return false;
  let plain='';
  for(let i=0;i<sql.length;) {
    if(sql.startsWith('/*',i)) {
      let depth=1;i+=2;
      while(i<sql.length && depth) {
        if(sql.startsWith('/*',i)){depth++;i+=2;}
        else if(sql.startsWith('*/',i)){depth--;i+=2;}
        else i++;
      }
      if(depth) return false;
      plain+=' ';continue;
    }
    if(sql.startsWith('--',i)){while(i<sql.length && sql[i]!=='\n')i++;plain+=' ';continue;}
    const quote=sql[i];
    if(quote==="'" || quote==='"') {
      i++;let closed=false,identifier='';
      while(i<sql.length){
        if(sql[i]===quote){if(sql[i+1]===quote){identifier+=quote;i+=2;continue;}i++;closed=true;break;}
        // Backslash-escaped strings/identifiers and dollar strings are not needed by canonical parameterized leaves.
        if(sql[i]==='\\') return false;
        identifier+=sql[i++];
      }
      if(!closed) return false;
      plain+=quote==='"' ? ` ${identifier} ` : ' ';continue;
    }
    if(sql[i]==='$' && !/[0-9]/.test(sql[i+1]??'')) return false;
    plain+=sql[i++];
  }
  return /^\s*(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(plain) && !/;/.test(plain)
    && !/\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|RESET|DO|CALL|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|set_config)\b/i.test(plain);
}

export function createCheckedFinancialTransaction(input: {
  readonly acquire: () => Promise<FinancialClientLease>;
  readonly role: 'swat_app' | 'swat_financial_receipt_writer';
  readonly deadline: FinancialSafetyDeadline;
}): WithdrawalTransaction {
  requireFinancial(typeof input?.acquire === 'function' && typeof input.deadline?.check === 'function'
    && ['swat_app','swat_financial_receipt_writer'].includes(input.role), 'financial-owned-lease-unavailable');
  return async <T>(userId: string, operation: (client: WithdrawalSqlClient) => Promise<T>): Promise<T> => {
    financialUser(userId); input.deadline.check();
    const parent = contexts.getStore();
    if (parent) { parent.poisoned = true; throw new Error('Nested financial transaction refused'); }
    const lease = await input.acquire();
    requireFinancial(lease?.client && typeof lease.release === 'function' && !leased.has(lease.client), 'financial-reused-lease-refused');
    leased.add(lease.client);
    let open = false, live = false, committing = false, broken = false;
    let pending: Promise<unknown> | null = null;
    const lifetime = { poisoned: false };
    const client: WithdrawalSqlClient = {
      async query<Row>(sql: string, values?: unknown[]) {
        // Only one operation at a time; callbacks cannot control the transaction/tenant or mutate ambient GUCs.
        if (!live || pending || !financialOperationSqlAllowed(sql)) {
          lifetime.poisoned = true; throw new Error('Uncontrolled financial query refused');
        }
        input.deadline.check();
        const query = lease.client.query<Row>(sql, values); pending = query;
        try { const result = await query; input.deadline.check(); return result; }
        catch (error) { lifetime.poisoned = true; throw error; }
        finally { pending = null; }
      }
    };
    try {
      return await contexts.run(lifetime, async () => {
        const backend = await assertFinancialIdentity(lease.client, input.role, true);
        const begin = await lease.client.query('BEGIN');
        requireFinancial(begin.command === 'BEGIN', 'financial-begin-unacknowledged'); open = true;
        requireFinancial(await assertFinancialIdentity(lease.client,input.role) === backend, 'financial-primary-client-changed');
        await lease.client.query(`SELECT set_config('app.current_user_id',$1,true), set_config('app.bypass_rls','off',true),
          set_config('app.worker_execution_id','',true), set_config('statement_timeout','15000',true),
          set_config('lock_timeout','5000',true), set_config('idle_in_transaction_session_timeout','30000',true)`, [userId]);
        input.deadline.check(); live = true;
        let value: T;
        try { value = await operation(client); }
        finally { live = false; }
        requireFinancial(!pending && !lifetime.poisoned, 'financial-unawaited-or-poisoned-query');
        requireFinancial(await assertFinancialIdentity(lease.client, input.role) === backend, 'financial-primary-client-changed');
        input.deadline.check(); committing = true;
        const commit = await lease.client.query('COMMIT');
        if (commit.command !== 'COMMIT') throw new FinancialCommitUncertainError();
        open = false; input.deadline.check(); committing = false;
        return value;
      });
    } catch (error) {
      broken = true; live = false;
      // Settle in-flight IO before cleanup. An attempted COMMIT is never described as rolled back.
      if (pending) await Promise.allSettled([pending]);
      if (committing) throw new FinancialCommitUncertainError();
      if (open) { try { await lease.client.query('ROLLBACK'); } catch { /* discard */ } }
      throw error;
    } finally { leased.delete(lease.client); lease.release(broken); }
  };
}

/** Independent verifier/admission identity is not provided to the app service. */
export interface FinancialReceiptAdmissionPort<I extends { kind: 'withdrawal' | 'reducing'; userId: string; requestKey: string; expiresAt: string }> {
  verify(record: FinancialRecord<I>, attempt: FinancialAttempt, observation: unknown): Promise<FinancialReceipt | null>;
  admit(record: FinancialRecord<I>, attempt: FinancialAttempt, receipt: FinancialReceipt): Promise<void>;
}
export function createFinancialReceiptAdmission<I extends WithdrawalIntent | ReducingIntent>(input: {
  readonly transaction: WithdrawalTransaction;
  readonly verify: FinancialReceiptAdmissionPort<I>['verify'];
}): FinancialReceiptAdmissionPort<I> {
  const verified = new WeakMap<object, string>();
  return {
    async verify(record, attempt, observation) {
        const receipt = await input.verify(record, attempt, observation);
      if (receipt) {
        requireFinancial(receipt.intentId === record.id && receipt.intentHash === record.intentHash
          && receipt.attemptId === attempt.id && receipt.clientOrderId === attempt.clientOrderId
          && receipt.feeAssetId === record.intent.feeAssetId && receipt.feeAssetScale === record.intent.feeAssetScale
          && receipt.feeFundingAccountId === record.intent.feeFundingAccountId, 'financial-receipt-scope-mismatch');
        const maximum = record.intent.kind === 'withdrawal' ? record.intent.amountRaw : record.intent.quantityRaw;
        requireFinancial(BigInt(exactRaw(receipt.cumulativeRaw)) <= BigInt(maximum)
          && BigInt(exactRaw(receipt.feeRaw)) <= BigInt(record.intent.maxFeeRaw), 'financial-receipt-overfill-or-fee-ceiling');
        financialTime(receipt.observedAt);
        if (receipt.terminal && receipt.cumulativeRaw === '0') validateNoFutureAcceptance(record,attempt,receipt);
        verified.set(receipt, financialHash([record.userId, record.id, record.intentHash, attempt.id, receipt]));
      }
      return receipt;
    },
    async admit(record, attempt, receipt) {
      requireFinancial(verified.get(receipt) === financialHash([record.userId, record.id, record.intentHash, attempt.id, receipt]),
        'financial-authenticated-receipt-verifier-required');
      requireFinancial(receipt.intentId === record.id && receipt.intentHash === record.intentHash
        && receipt.attemptId === attempt.id && receipt.clientOrderId === attempt.clientOrderId,
      'financial-receipt-scope-mismatch');
      await input.transaction(record.userId, async client => {
        await assertFinancialIdentity(client, 'swat_financial_receipt_writer');
        const storedRows = (await client.query<{ intent_hash: string }>(`SELECT intent_hash FROM public.withdrawal_reducing_intents
          WHERE user_id=$1 AND id=$2 /* financial-owned:receipt-intent */`, [record.userId, record.id])).rows;
        requireFinancial(storedRows.length === 1 && storedRows[0]?.intent_hash === record.intentHash,
          'financial-receipt-durable-intent-mismatch');
        const attemptRows = (await client.query<{ id: string; client_order_id: string; intent_hash: string }>(`SELECT id,client_order_id,intent_hash
          FROM public.withdrawal_reducing_attempts WHERE user_id=$1 AND intent_id=$2
          /* financial-owned:receipt-attempt */`, [record.userId, record.id])).rows;
        const current = attemptRows[0];
        requireFinancial(attemptRows.length === 1 && current && current.id === attempt.id && current.intent_hash === record.intentHash
          && current.client_order_id === receipt.clientOrderId, 'financial-receipt-durable-attempt-mismatch');
        const existing = await client.query<{ receipt_hash: string }>(`SELECT receipt_hash FROM public.withdrawal_reducing_receipts
          WHERE user_id=$1 AND intent_id=$2 AND receipt_id=$3 /* financial-owned:receipt-replay */`, [record.userId, record.id, receipt.receiptId]);
        if (existing.rows[0]) {
          requireFinancial(existing.rows[0].receipt_hash === financialHash(receipt), 'financial-receipt-replay-conflict'); return;
        }
        await client.query(`INSERT INTO public.withdrawal_reducing_receipts
          (receipt_id,user_id,intent_id,attempt_id,provider_identity,proof,receipt,receipt_hash,cumulative_raw,fee_raw,
           fee_asset_id,fee_asset_scale,fee_funding_account_id,terminal,outcome,observed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::numeric,$10::numeric,$11,$12,$13,$14,$15,$16)
          /* financial-owned:receipt-admit */`, [receipt.receiptId,record.userId,record.id,attempt.id,receipt.providerIdentity,
          receipt.proof,JSON.stringify(receipt),financialHash(receipt),receipt.cumulativeRaw,receipt.feeRaw,receipt.feeAssetId,
          receipt.feeAssetScale,receipt.feeFundingAccountId,receipt.terminal,receipt.outcome,receipt.observedAt]);
      });
    }
  };
}

/** A narrow same-client join to the existing independent accounting admission, not a callback success claim. */
export async function readFinancialAccountingAdmission(client: WithdrawalSqlClient, record: FinancialRecord<{
  kind: 'withdrawal' | 'reducing'; userId: string; requestKey: string; expiresAt: string
}>, receipt: FinancialReceipt, deltaRaw: string, deltaFeeRaw: string): Promise<string> {
  const rows = (await client.query<{ accounting_reference: string }>(`SELECT accounting_reference
    FROM public.withdrawal_reducing_accounting_admissions WHERE user_id=$1 AND intent_id=$2 AND receipt_id=$3
      AND delta_raw=$4::numeric AND delta_fee_raw=$5::numeric /* financial-owned:accounting-admission */`,
  [record.userId,record.id,receipt.receiptId,deltaRaw,deltaFeeRaw])).rows;
  requireFinancial(rows.length === 1 && rows[0]?.accounting_reference, 'financial-canonical-accounting-admission-unavailable');
  return rows[0].accounting_reference;
}
