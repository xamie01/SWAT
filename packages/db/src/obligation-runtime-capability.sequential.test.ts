import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createObligationScopedTransaction } from './obligation-runtime-capability.js';
const id = '22222222-2222-2222-2222-222222222222', user = '11111111-1111-1111-1111-111111111111';
const now = new Date('2026-11-17T00:00:00Z');
const safeRole = { role_name: 'swat_app', session_role: 'swat_app', row_security: 'on', rolsuper: false,
  rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolinherit: false,
  has_memberships: false, owns_objects: false, can_create: false };
const row = { capability_id: '33333333-3333-3333-3333-333333333333', revision: 'reviewed', execution_id: id,
  user_id: user, chain: 'solana', token_mint: 'solana:token', target_account: 'solana:target', execution_mode: 'paper',
  obligation_kind: 'fanout', obligation_id: 'persisted-job', backend_identity: 'db|host|5432|swat_app',
  observed_at: now, expires_at: new Date(now.getTime() + 10_000) };
function setup(replies = [row], role = safeRole) {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('pg_catalog.pg_roles') ? [role]
    : sql.includes('swat_claim_runtime_capability') ? replies : [] }));
  const client = { query } as unknown as PoolClient;
  const events: string[] = [];
  const transaction = vi.fn(async <T>(operation: (client: PoolClient) => Promise<T>) => {
    events.push('begin'); const result = await operation(client); events.push('commit'); return result;
  });
  const factory = createObligationScopedTransaction({ transaction, now: () => now, maximumAgeMs: 1000 });
  return { query, client, factory, events };
}
describe('immutable obligation scoped runtime capability', () => {
  it('uses only queue execution lookup and derives scope from protected persisted tenant', async () => {
    const s = setup(); const operation = vi.fn(async () => 'owned');
    expect(await s.factory({ copyExecutionId: id, userId: 'foreign', targetAccount: '*', approved: true })!(operation)).toBe('owned');
    expect(s.query).toHaveBeenCalledWith('SELECT * FROM public.swat_claim_runtime_capability($1::uuid)', [id]);
    expect(s.query).toHaveBeenCalledWith("SELECT set_config('app.current_user_id', $1, true)", [user]);
    expect(s.query).not.toHaveBeenCalledWith(expect.anything(), ['foreign']);
    expect(s.events).toEqual(['begin','commit']);
  });
  it.each([{ copyExecutionId: 'not-a-uuid', userId: user }, { userId: user }, null])('refuses absent immutable lookup id %s', data => {
    const s = setup(); expect(s.factory(data)).toBeNull(); expect(s.query).not.toHaveBeenCalled();
  });
  it('cannot derive authority from a valid role label or queue tenant if registry absent', async () => {
    const s = setup([]); const operation = vi.fn();
    await expect(s.factory({ copyExecutionId: id, userId: user })!(operation)).rejects.toThrow(/capability unavailable/);
    expect(operation).not.toHaveBeenCalled();
  });
  it.each([
    { ...row, execution_id: '44444444-4444-4444-4444-444444444444' },
    { ...row, user_id: '*' }, { ...row, token_mint: 'polygon:foreign' },
    { ...row, expires_at: now }, { ...row, observed_at: new Date(now.getTime()-1001) },
    { ...row, observed_at: new Date(now.getTime()+1) }, { ...row, backend_identity: '' }
  ])('refuses wrong obligation/malformed tenant/stale host-bound returned capability', async bad => {
    const s = setup([bad]); const operation = vi.fn();
    await expect(s.factory({ copyExecutionId: id })!(operation)).rejects.toThrow(/scope\/expiry mismatch/);
    expect(operation).not.toHaveBeenCalled();
  });
  it('operator remains unsupported before domain grants, never wildcard tenant or bypass', async () => {
    const s = setup([{ ...row, user_id: null }]); const effect = vi.fn();
    await expect(s.factory({ copyExecutionId: id })!(effect)).rejects.toThrow('Operator obligation domain runtime capability unsupported');
    expect(effect).not.toHaveBeenCalled();
    expect(s.query).not.toHaveBeenCalledWith("SELECT set_config('app.current_user_id', $1, true)", expect.anything());
    expect(s.query.mock.calls.some(call => String(call[0]).includes("bypass_rls = 'on'"))).toBe(false);
  });
  it.each(['rolsuper','rolbypassrls','has_memberships','owns_objects'])('rejects unsafe backend role %s', async flag => {
    const s = setup([row], { ...safeRole, [flag]: true });
    await expect(s.factory({ copyExecutionId: id })!(async () => undefined)).rejects.toThrow(/Unsafe runtime/);
    expect(s.query.mock.calls.some(call => String(call[0]).includes('swat_claim_runtime_capability'))).toBe(false);
  });
  it('rechecks revocation each short transaction and refuses changed immutable scope', async () => {
    const replies = [row]; const s = setup(replies); const tx = s.factory({ copyExecutionId: id })!;
    await tx(async () => undefined); replies.splice(0,1,{ ...row, user_id: '44444444-4444-4444-4444-444444444444' });
    const effect = vi.fn(); await expect(tx(effect)).rejects.toThrow(/revoked or immutable scope changed/);
    expect(effect).not.toHaveBeenCalled();
    replies.splice(0); await expect(tx(effect)).rejects.toThrow(/capability unavailable/);
  });
});
