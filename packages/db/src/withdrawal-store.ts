import {
  type FinancialAttempt, type FinancialRecord, type FinancialReceipt, type FinancialStatus,
  type WithdrawalIntent, type WithdrawalSqlClient, financialHash, requireFinancial, exactRaw,
  type FinancialBudget, financialBudgetKey
} from './withdrawal-contract.js';

function protectedProjection<I extends StoredFinancialIntent>(row: IntentRow<I>): FinancialRecord<I> {
  requireFinancial(row.user_id === row.intent.userId && row.kind === row.intent.kind
    && row.intent_hash === financialHash(row.intent), 'durable-financial-intent-binding-mismatch');
  const result = project(row);
  return { ...result, intent: Object.freeze(result.intent) };
}

export interface StoredFinancialIntent {
  readonly kind: 'withdrawal' | 'reducing'; readonly userId: string; readonly requestKey: string;
  readonly expiresAt: string;
}
interface IntentRow<I> {
  id: string; user_id: string; kind: string; intent: I; intent_hash: string; status: FinancialStatus;
  completed_raw: string; terminal: boolean; created_at: Date | string; cancellation_reason?: string | null;
}
function project<I>(row: IntentRow<I>): FinancialRecord<I> {
  return { id: row.id, userId: row.user_id, intent: row.intent, intentHash: row.intent_hash,
    status: row.status, completedRaw: row.completed_raw, terminal: row.terminal,
    createdAt: new Date(row.created_at).toISOString(), cancellationReason: row.cancellation_reason ?? null };
}
interface AttemptRow {
  id: string; intent_id: string; user_id: string; client_order_id: string; intent_hash: string;
  state: FinancialAttempt['state']; completed_raw: string; completed_fee_raw: string; terminal: boolean;
}
function attempt(row: AttemptRow): FinancialAttempt {
  return { id: row.id, intentId: row.intent_id, userId: row.user_id, clientOrderId: row.client_order_id,
    intentHash: row.intent_hash, state: row.state, completedRaw: row.completed_raw,
    completedFeeRaw: row.completed_fee_raw, terminal: row.terminal };
}
/** Stateless SQL repository. All writes require the caller's one tenant transaction/client. */
export const withdrawalSqlStore = {
  async now(client: WithdrawalSqlClient): Promise<string> {
    const result = await client.query<{ observed_at: Date | string }>(
      'SELECT statement_timestamp() AS observed_at /* financial:clock */');
    requireFinancial(result.rows[0], 'database-clock-unavailable');
    return new Date(result.rows[0].observed_at).toISOString();
  },
  async lockRequest(client: WithdrawalSqlClient, userId: string, kind: string, requestKey: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) /* financial:request-lock */',
      [JSON.stringify([userId, kind, requestKey])]);
  },
  async byKey<I extends StoredFinancialIntent>(client: WithdrawalSqlClient, userId: string, kind: string, requestKey: string): Promise<FinancialRecord<I> | null> {
    const result = await client.query<IntentRow<I>>(`SELECT * FROM public.withdrawal_reducing_intents
      WHERE user_id=$1 AND kind=$2 AND request_key=$3 FOR UPDATE /* financial:by-key */`, [userId, kind, requestKey]);
    return result.rows[0] ? protectedProjection(result.rows[0]) : null;
  },
  async byId<I extends StoredFinancialIntent>(client: WithdrawalSqlClient, userId: string, id: string): Promise<FinancialRecord<I> | null> {
    const result = await client.query<IntentRow<I>>(`SELECT * FROM public.withdrawal_reducing_intents
      WHERE user_id=$1 AND id=$2 FOR UPDATE /* financial:by-id */`, [userId, id]);
    return result.rows[0] ? protectedProjection(result.rows[0]) : null;
  },
  async create<I extends StoredFinancialIntent>(client: WithdrawalSqlClient, intent: I): Promise<FinancialRecord<I>> {
    const result = await client.query<IntentRow<I>>(`INSERT INTO public.withdrawal_reducing_intents
      (user_id,kind,request_key,intent,intent_hash,expires_at,status)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6,'awaiting-authorization') RETURNING * /* financial:create */`,
    [intent.userId, intent.kind, intent.requestKey, JSON.stringify(intent), financialHash(intent), intent.expiresAt]);
    requireFinancial(result.rows[0], 'intent-persistence-unavailable'); return protectedProjection(result.rows[0]);
  },
  /** This lock must precede the trusted canonical balance/position row locks on every path. */
  async lockBudget(client: WithdrawalSqlClient, userId: string, budgetKey: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) /* financial:budget-lock */',
      [JSON.stringify([userId, budgetKey])]);
  },
  async lockBudgets(client: WithdrawalSqlClient, userId: string, budgets: FinancialBudget[]): Promise<void> {
    for (const key of [...new Set(budgets.map(financialBudgetKey))].sort()) await this.lockBudget(client, userId, key);
  },
  async reserved(client: WithdrawalSqlClient, userId: string, budgetKey: string, excludingId: string): Promise<string> {
    const result = await client.query<{ reserved_raw: string }>(`SELECT COALESCE(SUM(reserved_raw),0)::text AS reserved_raw
      FROM public.withdrawal_reducing_reservations WHERE user_id=$1 AND budget_key=$2 AND intent_id<>$3
      /* financial:reserved */`, [userId, budgetKey, excludingId]);
    return exactRaw(result.rows[0]?.reserved_raw ?? '0');
  },
  async reserve(client: WithdrawalSqlClient, record: FinancialRecord<StoredFinancialIntent>, budget: FinancialBudget): Promise<void> {
    await client.query(`INSERT INTO public.withdrawal_reducing_reservations
      (intent_id,user_id,budget_key,purpose,chain,network,mode,account_id,asset_id,asset_scale,amount_raw,fee_raw,reserved_raw)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::numeric,$12::numeric,$11::numeric+$12::numeric) /* financial:reserve */`,
    [record.id, record.userId, financialBudgetKey(budget), budget.purpose, budget.chain, budget.network, budget.mode,
      budget.accountId, budget.assetId, budget.assetScale, exactRaw(budget.amountRaw), exactRaw(budget.feeRaw)]);
  },
  async queue(client: WithdrawalSqlClient, record: FinancialRecord<StoredFinancialIntent>): Promise<FinancialRecord<StoredFinancialIntent>> {
    await client.query(`INSERT INTO public.withdrawal_reducing_outbox(intent_id,user_id,intent_hash)
      VALUES($1,$2,$3) /* financial:outbox */`, [record.id, record.userId, record.intentHash]);
    const result = await client.query<IntentRow<StoredFinancialIntent>>(`UPDATE public.withdrawal_reducing_intents
      SET status='queued' WHERE id=$1 AND user_id=$2 AND status='awaiting-authorization'
      RETURNING * /* financial:queue */`, [record.id, record.userId]);
    requireFinancial(result.rows[0], 'intent-queue-conflict'); return protectedProjection(result.rows[0]);
  },
  async getAttempt(client: WithdrawalSqlClient, record: FinancialRecord<StoredFinancialIntent>): Promise<FinancialAttempt | null> {
    const result = await client.query<AttemptRow>(`SELECT * FROM public.withdrawal_reducing_attempts
      WHERE intent_id=$1 AND user_id=$2 FOR UPDATE /* financial:attempt */`, [record.id, record.userId]);
    const row = result.rows[0];
    if (!row) return null;
    requireFinancial(row.intent_id === record.id && row.user_id === record.userId && row.intent_hash === record.intentHash,
      'durable-financial-attempt-binding-mismatch');
    return attempt(row);
  },
  async prepare(client: WithdrawalSqlClient, record: FinancialRecord<StoredFinancialIntent>): Promise<FinancialAttempt> {
    const key = 'w3-' + financialHash([record.userId, record.id, record.intentHash]).slice(0, 48);
    const result = await client.query<AttemptRow>(`INSERT INTO public.withdrawal_reducing_attempts
      (intent_id,user_id,intent_hash,client_order_id) VALUES($1,$2,$3,$4)
      RETURNING * /* financial:prepare */`, [record.id, record.userId, record.intentHash, key]);
    requireFinancial(result.rows[0], 'attempt-persistence-unavailable');
    await client.query(`UPDATE public.withdrawal_reducing_intents SET status='prepared'
      WHERE id=$1 AND user_id=$2 AND status='queued' /* financial:prepared */`, [record.id, record.userId]);
    return attempt(result.rows[0]);
  },
  /** Durable write-ahead fence; a crash here is unknown, NEVER permission for a second submit. */
  async dispatchFence(client: WithdrawalSqlClient, record: FinancialRecord<StoredFinancialIntent>, current: FinancialAttempt): Promise<boolean> {
    const result = await client.query<AttemptRow>(`UPDATE public.withdrawal_reducing_attempts SET state='uncertain'
      WHERE id=$1 AND intent_id=$2 AND user_id=$3 AND state='prepared' AND NOT terminal
      RETURNING * /* financial:dispatch-fence */`, [current.id, record.id, record.userId]);
    if (!result.rows[0]) return false;
    await client.query(`UPDATE public.withdrawal_reducing_intents SET status='uncertain'
      WHERE id=$1 AND user_id=$2 AND NOT terminal /* financial:uncertain */`, [record.id, record.userId]);
    return true;
  },
  async admittedReceipt(client: WithdrawalSqlClient, record: FinancialRecord<StoredFinancialIntent>, current: FinancialAttempt,
    receipt: FinancialReceipt): Promise<void> {
    // Runtime cannot insert admissions. A separately authenticated, restricted verifier writer must persist it first.
    const result = await client.query<{ receipt_id: string }>(`SELECT receipt_id FROM public.withdrawal_reducing_receipts
      WHERE user_id=$1 AND intent_id=$2 AND attempt_id=$3 AND receipt_id=$4 AND receipt_hash=$5
      AND admitted_at<=statement_timestamp() /* financial:admitted-receipt */`,
    [record.userId, record.id, current.id, receipt.receiptId, financialHash(receipt)]);
    requireFinancial(result.rows[0], 'independent-receipt-admission-unavailable');
  },
  async appliedReceipt(client: WithdrawalSqlClient, record: FinancialRecord<StoredFinancialIntent>, receiptId: string): Promise<boolean> {
    const result = await client.query<{ receipt_id: string }>(`SELECT receipt_id FROM public.withdrawal_reducing_applications
      WHERE user_id=$1 AND intent_id=$2 AND receipt_id=$3 /* financial:applied-receipt */`, [record.userId, record.id, receiptId]);
    return !!result.rows[0];
  },
  async progress(client: WithdrawalSqlClient, record: FinancialRecord<StoredFinancialIntent>, current: FinancialAttempt,
    receipt: FinancialReceipt, deltaRaw: string, accountingReference: string): Promise<void> {
    await client.query(`INSERT INTO public.withdrawal_reducing_applications
      (user_id,intent_id,attempt_id,receipt_id,delta_raw,accounting_reference)
      VALUES($1,$2,$3,$4,$5::numeric,$6) /* financial:apply-receipt */`,
    [record.userId, record.id, current.id, receipt.receiptId, deltaRaw, accountingReference]);
    // Database trigger derives both progress AND each denomination's outstanding amount/paid-fee budget.
  },
  async cancelExpired<I extends StoredFinancialIntent>(client: WithdrawalSqlClient, record: FinancialRecord<I>, budgets: FinancialBudget[]): Promise<FinancialRecord<I>> {
    await this.lockBudgets(client, record.userId, budgets);
    // Restricted SQL function locks exact intent/attempt absence and atomically disables dispatch + releases all budgets + audit.
    await client.query('SELECT public.swat_cancel_expired_financial_intent($1) /* financial:cancel-expired */', [record.id]);
    const updated = await this.byId<I>(client, record.userId, record.id);
    requireFinancial(updated, 'financial-cancellation-unavailable'); return updated;
  },
  async authorization(client: WithdrawalSqlClient, record: FinancialRecord<WithdrawalIntent>) {
    const result = await client.query<{
      id: string; intent_hash: string; digest: string; expires_at: Date | string; failures: number; delivery_state: 'pending' | 'sent' | 'failed'; consumed_at: Date | null
    }>(`SELECT * FROM public.withdrawal_authorizations WHERE user_id=$1 AND intent_id=$2 FOR UPDATE
      /* withdrawal:authorization */`, [record.userId, record.id]);
    const row = result.rows[0];
    if (row) requireFinancial(row.intent_hash === record.intentHash, 'durable-withdrawal-authorization-binding-mismatch');
    return row ?? null;
  }
};
export type WithdrawalSqlStore = typeof withdrawalSqlStore;
