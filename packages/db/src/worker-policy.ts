import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { resolveSlippageBps, type Chain, type ExecutionMode } from '@swat/shared';
import type { CopyExecutionRecord } from './copy-trade-lifecycle.js';

export interface WorkerPolicyScope {
  readonly account: string;
  readonly chain: Chain;
  readonly tokenMint: string;
  readonly masterWalletAddress: string;
}
export interface WorkerPolicySnapshot {
  readonly scope: WorkerPolicyScope;
  readonly policyId: string;
  readonly revision: string;
  readonly mode: ExecutionMode;
  readonly mirrors: 'buys-and-sells' | 'sells-only' | 'none';
  readonly autoExecute: boolean;
  readonly killed: boolean;
  readonly maxSlippageBps: number;
}
export interface CurrentWorkerPolicy {
  readonly snapshot: WorkerPolicySnapshot;
  readonly minimumScore: number;
  readonly platformMode: ExecutionMode;
}
export interface WorkerPolicyIdentity {
  readonly userId: string | null;
  readonly chain: Chain;
  readonly tokenMint: string;
  readonly targetAccount: string;
  readonly masterWalletAddress: string;
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function mode(value: unknown): value is ExecutionMode {
  return ['off', 'paper', 'live', 'live+shadow'].includes(String(value));
}
function timestamp(value: unknown): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

/** Fresh durable controls only. Missing rows never mean opted-in defaults.
 * SHARE locks serialize policy changes with admission/pre-effect transactions.
 * Global source/config/capacity SQL capability is intentionally not granted by
 * this module; a restricted runtime must report unavailable, never bypass RLS. */
export async function readCurrentWorkerPolicyWithClient(
  client: PoolClient, identity: WorkerPolicyIdentity
): Promise<CurrentWorkerPolicy | null> {
  if ([identity.tokenMint, identity.targetAccount, identity.masterWalletAddress].some(value =>
    typeof value !== 'string' || !value.startsWith(`${identity.chain}:`) || value.trim() !== value)) {
    throw new Error('Worker policy immutable chain scope mismatch');
  }
  const configs = await client.query<{ key: string; value: unknown; updated_at: Date }>(
    `SELECT key, value, updated_at FROM config
     WHERE key IN ('trading', 'signals', 'execution_config') ORDER BY key FOR SHARE`
  );
  const tradingRow = configs.rows.find(row => row.key === 'trading');
  const signalRow = configs.rows.find(row => row.key === 'signals');
  const executionRow = configs.rows.find(row => row.key === 'execution_config');
  const trading = object(tradingRow?.value), signals = object(signalRow?.value), execution = object(executionRow?.value);
  if (!trading || !signals || !execution || typeof trading.enabled !== 'boolean'
    || !mode(execution[identity.chain]) || configs.rows.some(row => !timestamp(row.updated_at))) return null;
  const platformMode = execution['*'] === 'off' ? 'off' : execution[identity.chain] as ExecutionMode;
  let minimumScore = signals.auto_execute_min_score;
  let requestedMode = platformMode;
  let autoExecute = trading.enabled;
  let killed = platformMode === 'off';
  let mirrors: WorkerPolicySnapshot['mirrors'] = 'buys-and-sells';
  let maxSlippageBps = resolveSlippageBps(identity.chain, null);
  const revisionParts: unknown[] = configs.rows.map(row => [row.key, row.value, timestamp(row.updated_at)]);
  if (identity.userId !== null) {
    const users = await client.query<{ status: string }>(
      `SELECT status FROM users WHERE id = $1 FOR SHARE`, [identity.userId]
    );
    const settings = await client.query<{ auto_execute: boolean; killed: boolean; min_signal_score: number; updated_at: Date }>(
      `SELECT auto_execute, killed, min_signal_score, updated_at FROM user_execution_settings WHERE user_id = $1 FOR SHARE`, [identity.userId]
    );
    const chains = await client.query<{ mode: ExecutionMode; max_slippage_bps: number | null; updated_at: Date }>(
      `SELECT mode, max_slippage_bps, updated_at FROM user_chain_execution_settings WHERE user_id = $1 AND chain = $2 FOR SHARE`, [identity.userId, identity.chain]
    );
    const subscriptions = await client.query<{ state: string; active_since: Date; wound_down_at: Date | null; ended_at: Date | null; close_all_requested_at: Date | null }>(
      `SELECT state, active_since, wound_down_at, ended_at, close_all_requested_at
       FROM user_wallet_subscriptions WHERE user_id = $1 AND wallet_address = $2 FOR SHARE`, [identity.userId, identity.masterWalletAddress]
    );
    const account = users.rows[0], setting = settings.rows[0], chain = chains.rows[0], subscription = subscriptions.rows[0];
    if (!account || !setting || !chain || !subscription || !mode(chain.mode)
      || typeof setting.auto_execute !== 'boolean' || typeof setting.killed !== 'boolean'
      || !timestamp(setting.updated_at) || !timestamp(chain.updated_at) || !timestamp(subscription.active_since)
      || !['active', 'winding_down', 'ended'].includes(subscription.state)) return null;
    minimumScore = Math.max(Number(minimumScore), setting.min_signal_score);
    requestedMode = chain.mode;
    autoExecute = trading.enabled && setting.auto_execute;
    killed = killed || setting.killed || account.status !== 'active';
    mirrors = subscription.state === 'active' ? 'buys-and-sells' : subscription.state === 'winding_down' ? 'sells-only' : 'none';
    maxSlippageBps = resolveSlippageBps(identity.chain, chain.max_slippage_bps);
    revisionParts.push(account, setting, chain, subscription);
  }
  if (typeof minimumScore !== 'number' || !Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 100) return null;
  const scope: WorkerPolicyScope = { account: identity.userId ?? 'operator', chain: identity.chain,
    tokenMint: identity.tokenMint, masterWalletAddress: identity.masterWalletAddress };
  return { snapshot: { scope, policyId: digest([scope, identity.targetAccount]), revision: digest(revisionParts),
    mode: requestedMode, mirrors, autoExecute, killed, maxSlippageBps }, minimumScore, platformMode };
}

/** Called by the canonical claim writer on its own transaction, BEFORE enqueue.
 * Replays read the captured record; they never refresh the queued revision. */
export async function captureWorkerPolicyWithClient(client: PoolClient, execution: CopyExecutionRecord,
  masterWalletAddress: string): Promise<void> {
  const current = await readCurrentWorkerPolicyWithClient(client, { ...execution, masterWalletAddress });
  if (!current) throw new Error('Current execution policy unavailable; canonical claim refused');
  await client.query(`INSERT INTO copy_execution_policy_snapshots
    (execution_id, user_id, chain, target_account, token_mint, master_wallet_address, execution_mode, snapshot, minimum_score)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) ON CONFLICT (execution_id) DO NOTHING`,
  [execution.id, execution.userId, execution.chain, execution.targetAccount, execution.tokenMint,
    masterWalletAddress, execution.executionMode, JSON.stringify(current.snapshot), current.minimumScore]);
}

export async function readCapturedWorkerPolicyWithClient(client: PoolClient, execution: CopyExecutionRecord,
  masterWalletAddress: string): Promise<WorkerPolicySnapshot | null> {
  const result = await client.query<{ snapshot: WorkerPolicySnapshot }>(`SELECT snapshot FROM copy_execution_policy_snapshots
    WHERE execution_id = $1 AND user_id IS NOT DISTINCT FROM $2 AND chain = $3 AND target_account = $4
      AND token_mint = $5 AND master_wallet_address = $6 AND execution_mode = $7 FOR SHARE`,
  [execution.id, execution.userId, execution.chain, execution.targetAccount, execution.tokenMint, masterWalletAddress, execution.executionMode]);
  return result.rows[0]?.snapshot ?? null;
}
