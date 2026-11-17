import type { LpChain, LpProtocol } from '@swat/shared';
import { scopedQuery, type UserScope } from './tenancy.js';

export type LpCopySubscriptionStatus = 'active' | 'paused' | 'closed';
export type LpCopyAction = 'mint' | 'increase' | 'decrease' | 'burn' | 'collect';
export type LpCopyExecutionStatus = 'pending' | 'executing' | 'executed' | 'failed' | 'rejected';

export interface LpCopySubscription {
  readonly id: string;
  readonly userId: string;
  readonly masterWalletAddress: string;
  readonly chain: LpChain;
  readonly venue: LpProtocol;
  readonly allocatedBudgetUsd: number;
  readonly maxCapitalPerPositionUsd: number;
  readonly status: LpCopySubscriptionStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LpCopyExecution {
  readonly id: string;
  readonly subscriptionId: string;
  readonly userId: string;
  readonly masterPositionId: string;
  readonly followerPositionId: string | null;
  readonly chain: LpChain;
  readonly action: LpCopyAction;
  readonly masterDepositUsd: number;
  readonly followerDepositUsd: number;
  readonly scaleRatio: number;
  readonly status: LpCopyExecutionStatus;
  readonly errorMessage: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  master_wallet_address: string;
  chain: LpChain;
  venue: LpProtocol;
  allocated_budget_usd: string | number;
  max_capital_per_position_usd: string | number;
  status: LpCopySubscriptionStatus;
  created_at: Date;
  updated_at: Date;
}

interface ExecutionRow {
  id: string;
  subscription_id: string;
  user_id: string;
  master_position_id: string;
  follower_position_id: string | null;
  chain: LpChain;
  action: LpCopyAction;
  master_deposit_usd: string | number;
  follower_deposit_usd: string | number;
  scale_ratio: string | number;
  status: LpCopyExecutionStatus;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

function toSubscription(row: SubscriptionRow): LpCopySubscription {
  return {
    id: row.id,
    userId: row.user_id,
    masterWalletAddress: row.master_wallet_address,
    chain: row.chain,
    venue: row.venue,
    allocatedBudgetUsd: Number(row.allocated_budget_usd),
    maxCapitalPerPositionUsd: Number(row.max_capital_per_position_usd),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toExecution(row: ExecutionRow): LpCopyExecution {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    userId: row.user_id,
    masterPositionId: row.master_position_id,
    followerPositionId: row.follower_position_id,
    chain: row.chain,
    action: row.action,
    masterDepositUsd: Number(row.master_deposit_usd),
    followerDepositUsd: Number(row.follower_deposit_usd),
    scaleRatio: Number(row.scale_ratio),
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createLpCopySubscription(
  scope: UserScope,
  input: {
    masterWalletAddress: string;
    chain: LpChain;
    venue: LpProtocol;
    allocatedBudgetUsd: number;
    maxCapitalPerPositionUsd: number;
  }
): Promise<LpCopySubscription> {
  if (![input.allocatedBudgetUsd, input.maxCapitalPerPositionUsd].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Budget and max capital per position must be strictly positive');
  }

  const rows = await scopedQuery<SubscriptionRow>(scope,
    `INSERT INTO lp_copy_subscriptions (
       user_id, master_wallet_address, chain, venue, allocated_budget_usd, max_capital_per_position_usd, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     ON CONFLICT (user_id, master_wallet_address, chain, venue)
     DO UPDATE SET
       allocated_budget_usd = EXCLUDED.allocated_budget_usd,
       max_capital_per_position_usd = EXCLUDED.max_capital_per_position_usd,
       status = 'active',
       updated_at = NOW()
     RETURNING *`,
    [
      scope.userId,
      input.masterWalletAddress,
      input.chain,
      input.venue,
      input.allocatedBudgetUsd,
      input.maxCapitalPerPositionUsd
    ]
  );

  return toSubscription(rows[0]!);
}

export async function getLpCopySubscription(
  scope: UserScope,
  id: string
): Promise<LpCopySubscription | null> {
  const rows = await scopedQuery<SubscriptionRow>(scope,
    `SELECT * FROM lp_copy_subscriptions WHERE id = $1 AND user_id = $2`,
    [id, scope.userId]
  );
  return rows[0] ? toSubscription(rows[0]) : null;
}

export async function listLpCopySubscriptions(
  scope: UserScope,
  status?: LpCopySubscriptionStatus
): Promise<readonly LpCopySubscription[]> {
  const params: unknown[] = [scope.userId];
  let sql = `SELECT * FROM lp_copy_subscriptions WHERE user_id = $1`;
  if (status) {
    params.push(status);
    sql += ` AND status = $2`;
  }
  sql += ` ORDER BY created_at DESC`;

  const rows = await scopedQuery<SubscriptionRow>(scope,sql, params);
  return rows.map(toSubscription);
}

export async function listActiveFollowersForMaster(
  _masterWalletAddress: string,
  _chain: LpChain,
  _venue: LpProtocol
): Promise<readonly LpCopySubscription[]> {
  throw new Error('LP cross-tenant follower enumeration requires separately reviewed capability');
}

export async function updateLpCopySubscriptionStatus(
  scope: UserScope,
  id: string,
  status: LpCopySubscriptionStatus
): Promise<LpCopySubscription | null> {
  const rows = await scopedQuery<SubscriptionRow>(scope,
    `UPDATE lp_copy_subscriptions
     SET status = $1, updated_at = NOW()
     WHERE id = $2 AND user_id = $3
     RETURNING *`,
    [status, id, scope.userId]
  );
  return rows[0] ? toSubscription(rows[0]) : null;
}

export async function createLpCopyExecution(input: {
  subscriptionId: string;
  userId: string;
  masterPositionId: string;
  followerPositionId?: string | null;
  chain: LpChain;
  action: LpCopyAction;
  masterDepositUsd?: number;
  followerDepositUsd?: number;
  scaleRatio?: number;
  status?: LpCopyExecutionStatus;
  errorMessage?: string | null;
}): Promise<LpCopyExecution> {
  throw new Error('LP legacy copy execution mutation unavailable; atomic exact acquisition linkage required');
}

export async function updateLpCopyExecutionStatus(
  id: string,
  status: LpCopyExecutionStatus,
  errorMessage?: string | null
): Promise<boolean> {
  throw new Error('LP legacy copy status mutation unavailable; durable exact receipt/acquisition required');
}

export async function listLpCopyExecutions(
  scope: UserScope,
  subscriptionId?: string
): Promise<readonly LpCopyExecution[]> {
  const params: unknown[] = [scope.userId];
  let sql = `SELECT * FROM lp_copy_executions WHERE user_id = $1`;
  if (subscriptionId) {
    params.push(subscriptionId);
    sql += ` AND subscription_id = $2`;
  }
  sql += ` ORDER BY created_at DESC LIMIT 100`;

  const rows = await scopedQuery<ExecutionRow>(scope,sql, params);
  return rows.map(toExecution);
}
