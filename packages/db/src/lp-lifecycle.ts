import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { LpChain } from '@swat/shared';
import { withTenantTransaction, type UserScope } from './tenancy.js';
import { POSITION_COLUMNS, toPosition, type PositionRow, type LpPosition, type CreateLpPositionInput } from './lp-positions.js';

/** Legacy numeric observation types retained; these are never admission/receipt authority. */
export interface LpUsdValuation {
  readonly chain: LpChain; readonly asset: string; readonly quantity: number; readonly currency: 'USD';
  readonly unitPriceUsd: number; readonly valueUsd: number; readonly observedAt: string; readonly source: string;
}
export interface LpPaperPlan {
  readonly version: 1; readonly rangeLower: number; readonly rangeUpper: number;
  readonly rungs: CreateLpPositionInput['rungAllocations']; readonly steps: readonly unknown[]; readonly poolObservedAt: string;
}
export function lpFingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function assertLpValuation(_value: LpUsdValuation, _chain: LpChain, _asset: string, _quantity: number, _now = new Date()): void {
  throw new Error('LP numeric source label is not trusted valuation authority; exact injected domain required');
}
export interface CreateValuedLpInput extends CreateLpPositionInput {
  readonly acquisitionMode: 'paper'; readonly operationKey: string; readonly fingerprint: string;
  readonly valuation: LpUsdValuation; readonly plan: LpPaperPlan;
}
export async function createValuedLpPositionWithClient(_client: PoolClient, _scope: UserScope, _input: CreateValuedLpInput): Promise<LpPosition> {
  throw new Error('LP legacy float valued acquisition unavailable; exact injected rawscale domain required');
}
export async function createValuedLpPosition(_scope: UserScope, _input: CreateValuedLpInput): Promise<LpPosition> {
  throw new Error('LP legacy float valued acquisition unavailable; exact injected rawscale domain required');
}
function key(value: string): void { if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('LP operation key required'); }
export async function findLpAcquisition(scope: UserScope, operationKey: string, fingerprint: string): Promise<LpPosition | null> {
  key(operationKey);
  return withTenantTransaction(scope, async client => {
    const rows = await client.query<PositionRow>(`SELECT ${POSITION_COLUMNS} FROM lp_positions WHERE user_id=$1 AND acquisition_key=$2`, [scope.userId, operationKey]);
    const value = rows.rows[0] ? toPosition(rows.rows[0]) : null;
    if (value && value.acquisitionFingerprint !== fingerprint) throw new Error('LP acquisition replay conflict');
    return value;
  });
}
export interface LpPaperOperation {
  readonly id: string; readonly userId: string; readonly positionId: string;
  readonly status: 'pending' | 'completed' | 'cancelled'; readonly kind: 'rebalance' | 'close';
}
interface OperationRow { id: string; user_id: string; position_id: string; kind: LpPaperOperation['kind']; status: LpPaperOperation['status'] }
function operation(row: OperationRow): LpPaperOperation { return { id: row.id, userId: row.user_id, positionId: row.position_id, kind: row.kind, status: row.status }; }
export async function findLpPaperOperation(scope: UserScope, operationKey: string, positionId: string, kind: 'rebalance' | 'close'): Promise<LpPaperOperation | null> {
  key(operationKey);
  return withTenantTransaction(scope, async client => {
    const rows = await client.query<OperationRow>('SELECT * FROM lp_paper_operations WHERE user_id=$1 AND operation_key=$2', [scope.userId, operationKey]);
    const row = rows.rows[0]; if (!row) return null;
    if (row.position_id !== positionId || row.kind !== kind) throw new Error('LP operation replay conflict');
    return operation(row);
  });
}
export async function getLpOperationPosition(scope: UserScope, id: string): Promise<LpPosition | null> {
  return withTenantTransaction(scope, async client => {
    const rows = await client.query<PositionRow>(`SELECT ${POSITION_COLUMNS.split(', ').map(column => `p.${column}`).join(', ')}
      FROM lp_positions p JOIN lp_paper_operations o ON o.position_id=p.id AND o.user_id=p.user_id WHERE o.user_id=$1 AND o.id=$2`, [scope.userId, id]);
    return rows.rows[0] ? toPosition(rows.rows[0]) : null;
  });
}
export async function requestLpPaperOperation(_scope: UserScope, _input: { positionId: string; operationKey: string; kind: 'rebalance' | 'close'; plan?: LpPaperPlan }): Promise<LpPaperOperation> {
  throw new Error('LP legacy receiptless operation admission unavailable');
}
export async function completeLpPaperOperationWithClient(_client: PoolClient, _userId: string, _operationId: string): Promise<LpPaperOperation> {
  throw new Error('LP receipt required; legacy operation cannot complete financial state');
}
export async function completeLpPaperOperation(_userId: string, _id: string): Promise<LpPaperOperation> {
  throw new Error('LP receipt required; legacy operation cannot complete financial state');
}
export async function listPendingLpPaperOperations(_scope: UserScope, _limit = 100): Promise<LpPaperOperation[]> {
  throw new Error('LP legacy operation recovery unavailable; bounded tenant exact receipt recovery required');
}
