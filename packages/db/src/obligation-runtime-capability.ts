import type { PoolClient } from 'pg';
import type { Chain, CopyExecutionMode } from '@swat/shared';
import { assertDatabaseRole } from './database-role.js';
import { setTenantScope, forUser } from './tenancy.js';
import { withTransaction } from './transaction.js';

export type ObligationTransaction = <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T>;
export interface WorkerRuntimeCapability {
  readonly capabilityId: string;
  readonly revision: string;
  readonly executionId: string;
  readonly userId: string | null;
  readonly chain: Chain;
  readonly tokenMint: string;
  readonly targetAccount: string;
  readonly executionMode: CopyExecutionMode;
  readonly obligationKind: 'fanout' | 'lot-exit';
  readonly obligationId: string;
  readonly backendIdentity: string;
  readonly expiresAt: Date;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function executionId(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const id = (data as Record<string, unknown>).copyExecutionId;
  return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
}
interface CapabilityRow {
  capability_id: string; revision: string; execution_id: string; user_id: string | null;
  chain: Chain; token_mint: string; target_account: string; execution_mode: CopyExecutionMode;
  obligation_kind: 'fanout' | 'lot-exit'; obligation_id: string;
  backend_identity: string; expires_at: Date; observed_at: Date;
}
/** Restricted SQL function resolves a persisted immutable obligation, not queue
 * tenant data. It verifies session/current role, backend registration, protected
 * writer capability expiry/revocation, and exact execution/descriptor/exit claim.
 * Function execution grants are absent until separately reviewed provision. */
export async function readWorkerRuntimeCapabilityWithClient(client: PoolClient, id: string, now: Date,
  maximumAgeMs: number): Promise<WorkerRuntimeCapability | null> {
  if (!UUID.test(id) || !(now instanceof Date) || !Number.isFinite(now.getTime())
    || !Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 1 || maximumAgeMs > 60_000) throw new Error('Runtime capability lookup input invalid');
  await assertDatabaseRole(client, 'runtime');
  await client.query("SET LOCAL app.bypass_rls = 'off'");
  await client.query("SELECT set_config('app.current_user_id', '', true), set_config('app.worker_execution_id', '', true)");
  const result = await client.query<CapabilityRow>(
    'SELECT * FROM public.swat_claim_runtime_capability($1::uuid)', [id]);
  if (!result.rows.length) return null;
  const row = result.rows[0]!;
  if (result.rows.length !== 1 || row.execution_id !== id || !UUID.test(row.capability_id)
    || !row.revision || !row.backend_identity || !row.obligation_id
    || (row.user_id !== null && !UUID.test(row.user_id))
    || !['solana','polygon','robinhood-chain'].includes(row.chain)
    || !['paper','live','shadow'].includes(row.execution_mode)
    || !['fanout','lot-exit'].includes(row.obligation_kind)
    || [row.token_mint, row.target_account].some(value => typeof value !== 'string'
      || !value.startsWith(`${row.chain}:`) || value.trim() !== value)
    || !(row.expires_at instanceof Date) || !(row.observed_at instanceof Date)
    || !Number.isFinite(row.expires_at.getTime()) || !Number.isFinite(row.observed_at.getTime())
    || row.expires_at <= now || row.observed_at > now || now.getTime() - row.observed_at.getTime() > maximumAgeMs) {
    throw new Error('Runtime capability persisted scope/expiry mismatch');
  }
  return { capabilityId: row.capability_id, revision: row.revision, executionId: row.execution_id,
    userId: row.user_id, chain: row.chain, tokenMint: row.token_mint, targetAccount: row.target_account,
    executionMode: row.execution_mode, obligationKind: row.obligation_kind, obligationId: row.obligation_id,
    backendIdentity: row.backend_identity, expiresAt: row.expires_at };
}
function terms(capability: WorkerRuntimeCapability): string { return JSON.stringify(capability); }

/** Every short transaction rechecks protected role/host/obligation capability.
 * Queue userId is NEVER passed to forUser. Operator execution remains explicitly
 * unsupported until complete separately reviewed domain RLS/metadata grants. */
export function createObligationScopedTransaction(input: {
  readonly transaction?: ObligationTransaction;
  readonly now: () => Date;
  readonly maximumAgeMs: number;
}): (queue: unknown) => ObligationTransaction | null {
  return queue => {
    const id = executionId(queue);
    if (!id) return null;
    let captured: WorkerRuntimeCapability | null = null;
    return operation => (input.transaction ?? withTransaction)(async client => {
      const capability = await readWorkerRuntimeCapabilityWithClient(client, id, input.now(), input.maximumAgeMs);
      if (!capability) throw new Error('Approved immutable obligation runtime capability unavailable');
      if (capability.userId === null) throw new Error('Operator obligation domain runtime capability unsupported');
      if (captured && terms(capability) !== terms(captured)) throw new Error('Runtime capability revoked or immutable scope changed');
      captured ??= capability;
      if (capability.userId !== null) await setTenantScope(client, forUser(capability.userId));
      // This GUC is a comparison term only: policies must independently join the
      // protected role registry and exact immutable obligation, never trust it.
      await client.query("SELECT set_config('app.worker_execution_id', $1, true)", [capability.executionId]);
      return operation(client);
    });
  };
}
