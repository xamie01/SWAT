import type { PoolClient } from 'pg';
import type { Chain, CopyExecutionMode } from '@swat/shared';
import { assertDatabaseRole } from './database-role.js';

export type OwnedObligationTransaction = <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T>;
export interface OwnedWorkerRuntimeCapability {
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
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function check(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Owned runtime capability: ${reason}`);
}
function validText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value;
}
function validTime(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()); }

/** The database function independently joins protected registry and immutable obligation. */
export async function readOwnedWorkerRuntimeCapability(client: PoolClient, id: string, now: Date,
  maximumAgeMs: number): Promise<OwnedWorkerRuntimeCapability | null> {
  check(typeof id === 'string' && uuid.test(id) && validTime(now) && Number.isSafeInteger(maximumAgeMs)
    && maximumAgeMs >= 1 && maximumAgeMs <= 60_000, 'invalid lookup inputs');
  const time = now.getTime();
  await assertDatabaseRole(client, 'runtime');
  await client.query("SET LOCAL app.bypass_rls = 'off'");
  await client.query("SELECT set_config('app.current_user_id', '', true), set_config('app.worker_execution_id', '', true)");
  const { rows } = await client.query('SELECT * FROM public.swat_claim_runtime_capability($1::uuid)', [id]);
  if (rows.length === 0) return null;
  check(rows.length === 1, 'ambiguous protected lookup');
  const r = rows[0];
  check(r.execution_id === id && typeof r.capability_id === 'string' && uuid.test(r.capability_id)
    && validText(r.revision, 128) && validText(r.backend_identity, 512) && validText(r.obligation_id, 512)
    && (r.user_id === null || typeof r.user_id === 'string' && uuid.test(r.user_id))
    && ['solana', 'polygon', 'robinhood-chain'].includes(r.chain)
    && ['paper', 'live', 'shadow'].includes(r.execution_mode)
    && ['fanout', 'lot-exit'].includes(r.obligation_kind)
    && [r.token_mint, r.target_account].every(value => validText(value, 512) && value.startsWith(`${r.chain}:`)
      && value.length > r.chain.length + 1)
    && validTime(r.expires_at) && validTime(r.observed_at)
    && r.expires_at.getTime() > time && r.observed_at.getTime() <= time
    && time - r.observed_at.getTime() <= maximumAgeMs, 'persisted scope or expiry mismatch');
  return { capabilityId: r.capability_id, revision: r.revision, executionId: r.execution_id, userId: r.user_id,
    chain: r.chain, tokenMint: r.token_mint, targetAccount: r.target_account, executionMode: r.execution_mode,
    obligationKind: r.obligation_kind, obligationId: r.obligation_id, backendIdentity: r.backend_identity,
    expiresAt: new Date(r.expires_at) };
}

/** A queue identity selects a lookup; it never selects the authenticated tenant. */
export function createOwnedObligationScopedTransaction(input: {
  readonly transaction: OwnedObligationTransaction;
  readonly now: () => Date;
  readonly maximumAgeMs: number;
}): (queue: unknown) => OwnedObligationTransaction | null {
  check(input && typeof input.transaction === 'function' && typeof input.now === 'function'
    && Number.isSafeInteger(input.maximumAgeMs) && input.maximumAgeMs >= 1 && input.maximumAgeMs <= 60_000,
  'mandatory owned transaction, clock and bounded freshness required');
  const { transaction, now, maximumAgeMs } = input;
  return queue => {
    if (!queue || typeof queue !== 'object' || Array.isArray(queue)) return null;
    const value = (queue as Record<string, unknown>).copyExecutionId;
    if (typeof value !== 'string' || !uuid.test(value.toLowerCase())) return null;
    const id = value.toLowerCase();
    let terms: string | null = null;
    return operation => transaction(async client => {
      const capability = await readOwnedWorkerRuntimeCapability(client, id, now(), maximumAgeMs);
      check(capability, 'approved immutable obligation unavailable');
      check(capability.userId !== null, 'operator obligation domain unsupported');
      const current = JSON.stringify(capability);
      check(terms === null || current === terms, 'revoked or changed immutable scope');
      terms ??= current;
      await client.query("SELECT set_config('app.current_user_id',$1,true)", [capability.userId]);
      await client.query("SELECT set_config('app.worker_execution_id',$1,true)", [capability.executionId]);
      return operation(client);
    });
  };
}
