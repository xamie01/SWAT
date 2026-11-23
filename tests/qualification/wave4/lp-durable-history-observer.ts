import type { LpTenantTransaction } from '@swat/db/dist/lp-paper-store.js';
import type { UserScope } from '@swat/db/dist/lp-paper-owned.js';
import { lpExactHash, lpSnapshot, lpTime, lpStoredMicro, type LpExactPosition,
  type LpExactOperation, type LpPaperReceipt } from '@swat/db/dist/lp-exact.js';

export interface LpDurableHistoryObservation {
  readonly acquisition: LpExactPosition;
  readonly position: LpExactPosition;
  readonly operations: readonly { data: LpExactOperation; createdAt: string; completedAt: string | null }[];
  readonly receipts: readonly { operationId: string; hash: string; data: LpPaperReceipt; acceptedAt: string }[];
  readonly history: readonly { id: string; fromState: LpExactPosition['state'] | null;
    toState: LpExactPosition['state']; reason: string; changedAt: string }[];
  readonly copies: readonly { id: string; subscriptionId: string; masterPositionId: string;
    chain: LpExactPosition['chain']; action: string; status: string; masterMicroUsd: string; followerMicroUsd: string }[];
  readonly observedAt: string;
}
export type LpDurableHistoryObserver = (scope: UserScope, positionId: string) => Promise<LpDurableHistoryObservation>;
function need(value: unknown, reason: string): asserts value { if (!value) throw new Error(`LP durable history observer: ${reason}`); }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function iso(value: Date | string): string { need(value !== null && value !== undefined, 'stored chronology required'); const s = new Date(value).toISOString(); lpTime(s); return s; }

/** Independent bounded SELECT journal; LIMIT bound+1 detects truncation instead of certifying
 * a sample. This namespace does not weaken the accepted ONE-CLOSE observer's <=1 receipt rule.
 * Supplied owner transaction must commit before returning and reject uncertain COMMIT. */
export function lpDurableHistorySqlObserver(transaction: LpTenantTransaction, maximumOperations = 32): LpDurableHistoryObserver {
  need(typeof transaction === 'function', 'owned transaction required');
  need(Number.isInteger(maximumOperations) && maximumOperations >= 1 && maximumOperations <= 100, 'bounded complete operation history required');
  return async (input, positionId) => {
    const userId = input?.userId; need(typeof userId === 'string' && uuid.test(userId) && uuid.test(positionId), 'canonical tenant/position required');
    const scope = { userId } as UserScope;
    return transaction(scope, async client => {
      const identity = await client.query(`SELECT current_user::text AS role,session_user::text AS session,
        current_setting('row_security') AS row_security,public.current_app_user_id()::text AS tenant,
        COALESCE(current_setting('app.bypass_rls',true),'off') AS bypass,clock_timestamp() AS now /* lp-history:identity */`);
      const i = identity.rows[0]; need(identity.rows.length === 1 && i.role === 'swat_app' && i.session === 'swat_app'
        && i.tenant === userId && i.row_security === 'on' && i.bypass === 'off', 'direct authenticated observer required');
      const owner = await client.query('SELECT id FROM public.users WHERE id=$1 FOR UPDATE', [userId]);
      need(owner.rows.length === 1 && owner.rows[0].id === userId, 'owned observer tenant unavailable');
      const pRows = await client.query<{ position_id: string; user_id: string; acquisition_data: LpExactPosition;
        data: LpExactPosition; state: LpExactPosition['state']; auto_rebalance: boolean }>(`SELECT e.position_id,e.user_id,e.acquisition_data,e.data,p.state,p.auto_rebalance
        FROM public.lp_exact_positions e JOIN public.lp_positions p ON p.id=e.position_id AND p.user_id=e.user_id
        WHERE e.user_id=$1 AND e.position_id=$2 /* lp-history:position */`, [userId, positionId]);
      need(pRows.rows.length === 1, 'owned exact history position unavailable'); const p = pRows.rows[0]!;
      need(p.user_id === userId && p.position_id === positionId && p.data.id === positionId && p.data.userId === userId
        && p.acquisition_data.id === positionId && p.acquisition_data.userId === userId && p.data.mode === 'paper'
        && p.acquisition_data.mode === 'paper' && p.data.state === p.state && p.data.autoRebalance === p.auto_rebalance,
      'exact/legacy history position mismatch');
      const opRows = await client.query<{ id: string; user_id: string; position_id: string; operation_key: string;
        receipt_key: string; status: LpExactOperation['status']; data: LpExactOperation; created_at: Date | string; completed_at: Date | string | null }>(`SELECT id,user_id,position_id,operation_key,receipt_key,status,data,created_at,completed_at
        FROM public.lp_exact_operations WHERE user_id=$1 AND position_id=$2 ORDER BY created_at,id LIMIT $3 /* lp-history:operations */`, [userId, positionId, maximumOperations + 1]);
      need(opRows.rows.length <= maximumOperations, 'operation history exceeds complete bound');
      const observedAt = iso(i.now);
      const operations = opRows.rows.map(r => {
        need(uuid.test(r.id) && r.id === r.data.id && r.user_id === userId && r.data.userId === userId
          && r.position_id === positionId && r.data.positionId === positionId && r.operation_key === r.data.operationKey
          && r.receipt_key === r.data.receiptKey && r.status === r.data.status
          && (r.status === 'completed') === (r.completed_at !== null) && (r.status === 'completed') === (r.data.receipt !== null), 'canonical operation column mismatch');
        const createdAt = iso(r.created_at), completedAt = r.completed_at === null ? null : iso(r.completed_at);
        need(lpTime(createdAt) <= lpTime(observedAt) && (!completedAt || lpTime(completedAt) >= lpTime(createdAt)
          && lpTime(completedAt) <= lpTime(observedAt)), 'operation chronology mismatch');
        return { data: lpSnapshot(r.data), createdAt, completedAt };
      });
      need(new Set(operations.map(o => o.data.id)).size === operations.length
        && new Set(operations.map(o => o.data.operationKey)).size === operations.length, 'duplicate durable operation');
      const rr = await client.query<{ user_id: string; operation_id: string; position_id: string; receipt_key: string;
        provider_id: string; receipt_id: string; receipt_hash: string; data: LpPaperReceipt; accepted_at: Date | string }>(`SELECT user_id,operation_id,position_id,receipt_key,provider_id,receipt_id,receipt_hash,data,accepted_at
        FROM public.lp_exact_receipts WHERE user_id=$1 AND position_id=$2 ORDER BY accepted_at,operation_id LIMIT $3 /* lp-history:receipts */`, [userId, positionId, maximumOperations + 1]);
      need(rr.rows.length <= maximumOperations, 'receipt history exceeds complete bound');
      const receipts = rr.rows.map(r => {
        const op = operations.find(o => o.data.id === r.operation_id);
        need(op && op.data.status === 'completed' && r.user_id === userId && r.position_id === positionId
          && r.data.userId === userId && r.data.positionId === positionId && r.data.receiptKey === r.receipt_key
          && r.data.providerId === r.provider_id && r.data.receiptId === r.receipt_id && r.data.mode === 'paper'
          && r.data.finality === 'paper-settled' && r.receipt_hash === lpExactHash(r.data)
          && lpExactHash(op.data.receipt) === lpExactHash(r.data), 'stored receipt/operation identity or complete hash mismatch');
        const acceptedAt = iso(r.accepted_at);
        need(lpTime(r.data.settledAt) >= lpTime(op.createdAt) && lpTime(acceptedAt) >= lpTime(r.data.settledAt)
          && lpTime(acceptedAt) <= lpTime(observedAt), 'receipt chronology mismatch');
        return { operationId: r.operation_id, hash: r.receipt_hash, data: lpSnapshot(r.data), acceptedAt };
      });
      need(new Set(receipts.map(r => r.operationId)).size === receipts.length
        && new Set(receipts.map(r => r.data.receiptKey)).size === receipts.length
        && receipts.length === operations.filter(o => o.data.status === 'completed').length, 'complete receipt journal mismatch');
      const hr = await client.query<{ id: string; position_id: string; from_state: LpExactPosition['state'] | null;
        to_state: LpExactPosition['state']; reason: string; changed_at: Date | string }>(`SELECT h.id::text,h.position_id,h.from_state,h.to_state,h.reason,h.changed_at
        FROM public.lp_position_state_history h JOIN public.lp_positions p ON p.id=h.position_id
        WHERE p.user_id=$1 AND h.position_id=$2 ORDER BY h.changed_at,h.id LIMIT $3 /* lp-history:states */`, [userId, positionId, maximumOperations * 4 + 9]);
      need(hr.rows.length <= maximumOperations * 4 + 8, 'state history exceeds complete bound');
      const history = hr.rows.map(r => {
        need(r.position_id === positionId && /^[1-9][0-9]*$/.test(r.id) && typeof r.reason === 'string' && r.reason.length > 0,
          'state history identity/reason required');
        const changedAt = iso(r.changed_at); need(lpTime(changedAt) <= lpTime(observedAt), 'history chronology mismatch');
        return { id: r.id, fromState: r.from_state, toState: r.to_state, reason: r.reason, changedAt };
      });
      need(new Set(history.map(h => h.id)).size === history.length, 'duplicate state journal identity');
      const cr = await client.query<{ id: string; user_id: string; follower_position_id: string; subscription_id: string;
        master_position_id: string; chain: LpExactPosition['chain']; action: string; status: string; master: string; follower: string }>(`SELECT id,user_id,follower_position_id,subscription_id,master_position_id,chain,action,status,
        master_deposit_usd::text AS master,follower_deposit_usd::text AS follower FROM public.lp_copy_executions
        WHERE user_id=$1 AND follower_position_id=$2 ORDER BY created_at,id LIMIT 2 /* lp-history:copies */`, [userId, positionId]);
      need(cr.rows.length <= 1 && cr.rows.length === (p.acquisition_data.copyOrigin ? 1 : 0), 'exact acquisition copy linkage cardinality mismatch');
      const copies = cr.rows.map(r => {
        const origin = p.acquisition_data.copyOrigin!;
        need(uuid.test(r.id) && r.user_id === userId && r.follower_position_id === positionId && r.subscription_id === origin.subscriptionId
          && r.master_position_id === origin.masterPositionId && r.chain === p.data.chain && r.action === 'mint' && r.status === 'executed', 'immutable copy execution linkage mismatch');
        const masterMicroUsd = lpStoredMicro(r.master), followerMicroUsd = lpStoredMicro(r.follower);
        need(masterMicroUsd === origin.masterDepositMicroUsd && followerMicroUsd === p.acquisition_data.depositMicroUsd, 'copy journal exact capital mismatch');
        return { id: r.id, subscriptionId: r.subscription_id, masterPositionId: r.master_position_id, chain: r.chain,
          action: r.action, status: r.status, masterMicroUsd, followerMicroUsd };
      });
      return lpSnapshot({ acquisition: p.acquisition_data, position: p.data, operations, receipts, history, copies, observedAt });
    });
  };
}
