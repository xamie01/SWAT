import type { UserScope } from '../../../packages/db/src/tenancy.js';
import type { LpTenantTransaction } from '../../../packages/db/src/lp-paper-store.js';
import { lpExactHash, lpSnapshot, type LpExactPosition, type LpPaperReceipt } from '../../../packages/db/src/lp-exact.js';
import type { LpCopyObserver } from './lp-copy-scenarios.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`LP copy SQL observer: ${reason}`);
}
interface PositionRow {
  position_id: string;
  user_id: string;
  acquisition_data: LpExactPosition;
  data: LpExactPosition;
  state: LpExactPosition['state'];
  auto_rebalance: boolean;
}
interface ReceiptRow {
  user_id: string;
  operation_id: string;
  position_id: string;
  receipt_key: string;
  provider_id: string;
  receipt_id: string;
  receipt_hash: string;
  data: LpPaperReceipt;
}

/** One-close copy scenario only; two sampled receipts are sufficient to refuse duplicates.
 * The supplied transaction must commit before returning and own all pending client work. */
export function lpCopySqlObserver(transaction: LpTenantTransaction): LpCopyObserver {
  check(typeof transaction === 'function', 'owned transaction required');
  return async (input: UserScope, positionId: string) => {
    const userId = input?.userId;
    check(typeof userId === 'string' && typeof positionId === 'string'
      && uuid.test(userId) && uuid.test(positionId), 'canonical tenant and position required');
    const scope = { userId } as UserScope;
    return transaction(scope, async client => {
      const identity = await client.query(`SELECT current_user::text AS role, session_user::text AS session,
        current_setting('row_security') AS row_security,
        public.current_app_user_id()::text AS tenant,
        COALESCE(current_setting('app.bypass_rls',true),'off') AS bypass`);
      const row = identity.rows[0];
      check(identity.rows.length === 1 && row.role === 'swat_app' && row.session === 'swat_app'
        && row.row_security === 'on' && row.tenant === userId && row.bypass === 'off', 'authenticated tenant transaction required');
      const owner = await client.query('SELECT id FROM public.users WHERE id=$1 FOR UPDATE', [userId]);
      check(owner.rows.length === 1 && owner.rows[0].id === userId, 'owned tenant unavailable');
      const result = await client.query<PositionRow>(`SELECT e.position_id,e.user_id,e.acquisition_data,e.data,p.state,p.auto_rebalance
        FROM public.lp_exact_positions e JOIN public.lp_positions p ON p.id=e.position_id AND p.user_id=e.user_id
        WHERE e.user_id=$1 AND e.position_id=$2`, [userId, positionId]);
      check(result.rows.length === 1, 'owned exact position unavailable');
      const p = result.rows[0]!;
      check(p.position_id === positionId && p.user_id === userId
        && p.acquisition_data?.id === positionId && p.acquisition_data.userId === userId && p.acquisition_data.mode === 'paper'
        && p.data?.id === positionId && p.data.userId === userId && p.data.mode === 'paper'
        && p.data.state === p.state && p.data.autoRebalance === p.auto_rebalance, 'exact and compatibility position disagree');
      const rows = await client.query<ReceiptRow>(`SELECT user_id,operation_id,position_id,receipt_key,provider_id,receipt_id,receipt_hash,data
        FROM public.lp_exact_receipts WHERE user_id=$1 AND position_id=$2 ORDER BY operation_id LIMIT 2`, [userId, positionId]);
      check(rows.rows.length <= 1, 'one-close scenario has additional receipts');
      const receipts = rows.rows.map(r => {
        check(r.user_id === userId && r.position_id === positionId && typeof r.operation_id === 'string' && uuid.test(r.operation_id)
          && r.data?.userId === userId && r.data.positionId === positionId && r.data.mode === 'paper'
          && r.data.finality === 'paper-settled' && r.data.receiptKey === r.receipt_key
          && r.data.providerId === r.provider_id && r.data.receiptId === r.receipt_id
          && r.receipt_hash === lpExactHash(r.data), 'stored receipt identity or hash mismatch');
        return { operationId: r.operation_id, hash: r.receipt_hash, data: lpSnapshot(r.data) };
      });
      check(new Set(receipts.map(r => r.operationId)).size === receipts.length, 'duplicate operation receipt');
      return lpSnapshot({ acquisition: p.acquisition_data, position: p.data, receipts });
    });
  };
}
