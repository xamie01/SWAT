import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createOwnedObligationScopedTransaction, readOwnedWorkerRuntimeCapability,
  type OwnedObligationTransaction } from '../../../packages/db/src/obligation-runtime-owned.js';

const execution = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-11-18T00:00:01.000Z');
const capability = () => ({ capability_id: '33333333-3333-4333-8333-333333333333', revision: '1', execution_id: execution,
  user_id: user, chain: 'solana', token_mint: 'solana:synthetic-mint', target_account: 'solana:synthetic-account',
  execution_mode: 'paper', obligation_kind: 'fanout', obligation_id: 'job-1', backend_identity: 'db|address|port|swat_app',
  expires_at: new Date('2026-11-18T00:01:00.000Z'), observed_at: new Date('2026-11-18T00:00:00.000Z') });
function harness() {
  let rows: any[] = [capability()];
  let role = { role_name: 'swat_app', session_role: 'swat_app', row_security: 'on', rolsuper: false,
    rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolinherit: false,
    has_memberships: false, owns_objects: false, can_create: false };
  const calls: { sql: string; values?: unknown[] }[] = [];
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes('pg_catalog.pg_roles')) return { rows: [role] };
    if (sql.includes('swat_claim_runtime_capability')) return { rows };
    return { rows: [] };
  }) } as any;
  let committed = true;
  const transaction: OwnedObligationTransaction = async action => {
    const result = await action(client);
    if (!committed) throw new Error('supplied COMMIT failed');
    return result;
  };
  return { client, calls, transaction, setRows: (value: any[]) => { rows = value; },
    setRole: (value: any) => { role = { ...role, ...value }; }, failCommit: () => { committed = false; } };
}
describe('pool-free owned obligation capability, injected SQL only', () => {
  it('has no pool, tenancy, barrel or transaction runtime imports', () => {
    const text = readFileSync(new URL('../../../packages/db/src/obligation-runtime-owned.ts', import.meta.url), 'utf8');
    expect(text).not.toMatch(/from ['"](?:@swat\/db|\.\/(?:client|transaction|tenancy)\.js)['"]/);
    expect(text).not.toMatch(/new Pool|withTransaction|process\.env/);
  });
  it('requires an owned transaction and clock at construction', () => {
    expect(() => createOwnedObligationScopedTransaction({} as any)).toThrow('mandatory');
    expect(() => createOwnedObligationScopedTransaction({ transaction: vi.fn(), now: () => now, maximumAgeMs: 0 })).toThrow();
  });
  it.each([null, {}, { copyExecutionId: 1 }, { copyExecutionId: 'hostile' }, []])('does not look up invalid queue identity %j', queue => {
    const h = harness(), factory = createOwnedObligationScopedTransaction({ transaction: h.transaction, now: () => now, maximumAgeMs: 1000 });
    expect(factory(queue)).toBeNull(); expect(h.client.query).not.toHaveBeenCalled();
  });
  it('rechecks protected lookup for every short transaction and ignores queue tenant', async () => {
    const h = harness(), tx = createOwnedObligationScopedTransaction({ transaction: h.transaction, now: () => now, maximumAgeMs: 1000 })({ copyExecutionId: execution, userId: 'foreign' })!;
    expect(await tx(async () => 'first')).toBe('first');
    expect(await tx(async () => 'second')).toBe('second');
    expect(h.calls.filter(c => c.sql.includes('swat_claim_runtime_capability'))).toHaveLength(2);
    expect(h.calls.filter(c => c.sql.includes("set_config('app.current_user_id', $1")).map(c => c.values)).toEqual([[user], [user]]);
    expect(JSON.stringify(h.calls)).not.toContain('foreign');
  });
  it.each(['role_name', 'session_role', 'row_security', 'rolsuper', 'rolbypassrls', 'has_memberships', 'owns_objects', 'can_create'])('refuses unsafe %s before protected lookup', async key => {
    const h = harness(); h.setRole({ [key]: ['role_name', 'session_role'].includes(key) ? 'other' : key === 'row_security' ? 'off' : true });
    await expect(readOwnedWorkerRuntimeCapability(h.client, execution, now, 1000)).rejects.toThrow('Unsafe');
    expect(h.calls.some(c => c.sql.includes('swat_claim_runtime_capability'))).toBe(false);
  });
  it.each(['revision', 'backend_identity', 'obligation_id', 'capability_id', 'execution_id', 'user_id', 'chain', 'token_mint', 'target_account', 'execution_mode', 'obligation_kind', 'expires_at', 'observed_at'])('refuses hostile persisted %s', async key => {
    const h = harness(), row: any = capability();
    row[key] = key.endsWith('_at') ? new Date('invalid') : key === 'revision' ? { toString: vi.fn() }
      : ['backend_identity', 'obligation_id'].includes(key) ? ' invalid whitespace ' : 'hostile';
    h.setRows([row]);
    await expect(readOwnedWorkerRuntimeCapability(h.client, execution, now, 1000)).rejects.toThrow('persisted');
    if (key === 'revision') expect(row.revision.toString).not.toHaveBeenCalled();
  });
  it.each(['expired', 'future', 'stale', 'duplicate', 'operator', 'missing'])('refuses %s without executing a callback', async mode => {
    const h = harness(), row = capability();
    if (mode === 'expired') row.expires_at = now;
    if (mode === 'future') row.observed_at = new Date(now.getTime() + 1);
    if (mode === 'stale') row.observed_at = new Date(now.getTime() - 1001);
    if (mode === 'operator') row.user_id = null as any;
    h.setRows(mode === 'duplicate' ? [row, row] : mode === 'missing' ? [] : [row]);
    const action = vi.fn(), tx = createOwnedObligationScopedTransaction({ transaction: h.transaction, now: () => now, maximumAgeMs: 1000 })({ copyExecutionId: execution })!;
    await expect(tx(action)).rejects.toThrow(); expect(action).not.toHaveBeenCalled();
  });
  it('pins immutable protected terms across a queue lifetime', async () => {
    const h = harness(), tx = createOwnedObligationScopedTransaction({ transaction: h.transaction, now: () => now, maximumAgeMs: 1000 })({ copyExecutionId: execution })!;
    await tx(async () => {});
    h.setRows([{ ...capability(), revision: '2' }]);
    const action = vi.fn(); await expect(tx(action)).rejects.toThrow('changed'); expect(action).not.toHaveBeenCalled();
  });
  it('captures queue identity and constructor callbacks before later caller mutation', async () => {
    const h = harness(), input = { transaction: h.transaction, now: () => now, maximumAgeMs: 1000 };
    const queue = { copyExecutionId: execution }, tx = createOwnedObligationScopedTransaction(input)(queue)!;
    queue.copyExecutionId = 'hostile'; input.now = () => new Date('invalid');
    await tx(async () => {});
    expect(h.calls.find(c => c.sql.includes('swat_claim_runtime_capability'))?.values).toEqual([execution]);
  });
  it('does not return success when the supplied transaction COMMIT fails', async () => {
    const h = harness(); h.failCommit();
    const tx = createOwnedObligationScopedTransaction({ transaction: h.transaction, now: () => now, maximumAgeMs: 1000 })({ copyExecutionId: execution })!;
    await expect(tx(async () => 'effect')).rejects.toThrow('COMMIT');
  });
});
