import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), rows: [] as any[], conflict: false, fail: false, empty: false }));
vi.mock('./client.js', () => ({ query: db.query, pool: { connect: db.connect } }));
vi.mock('@swat/shared', () => ({ resolveChainAddress: (address: string) => ({ raw: address.toLowerCase() }) }));
import { recordExecutionGrant, listExecutionGrants } from './execution-grants.js';
const scope = { userId: '11111111-1111-4111-8111-111111111111' } as any;
const input = { chain: 'polygon' as const, grantKind: 'polymarket_signer' as const, accountAddress: '0x' + '2'.repeat(40), sealedSecret: 'v1.synthetic', keyVersion: 1 };
beforeEach(() => {
  vi.clearAllMocks(); db.conflict = false; db.fail = false; db.empty = false;
  db.rows = [{ id: 'previous', user_id: scope.userId, chain: 'polygon', grant_kind: 'polymarket_signer', account_address: '0x' + '1'.repeat(40), status: 'active' }];
  const execute = async (sql: string, p: any[] = []) => {
    if (sql.includes('FROM users')) return [{ id: scope.userId }];
    if (sql.includes('SELECT') && sql.includes('FROM user_execution_grants')) {
      if (sql.includes('FOR UPDATE')) return db.conflict ? [{ id: 'other', user_id: 'other-owner', status: 'revoked' }] : db.rows.filter(r => r.account_address === input.accountAddress);
      return db.rows;
    }
    if (sql.includes('INSERT INTO user_execution_grants')) {
      if (db.fail) throw new Error('insert failed'); if (db.empty) return [];
      const row = { id: 'new', user_id: p[0], chain: p[1], grant_kind: p[2], account_address: p[3], status: sql.includes("'retired'") ? 'retired' : 'active' };
      db.rows = [...db.rows.filter(r => r.id !== 'new'), row]; return [row];
    }
    if (sql.includes('UPDATE user_execution_grants') && sql.includes("SET status = 'revoked'")) db.rows.filter(r => r.id !== p[3]).forEach(r => r.status = 'revoked');
    if (sql.includes('UPDATE user_execution_grants') && sql.includes("SET status = 'active'")) { const row = db.rows.find(r => r.id === p[0]); row.status = 'active'; return [row]; }
    return [];
  };
  db.query.mockImplementation(execute);
  db.connect.mockImplementation(async () => {
    let snapshot: any[];
    return { on() {}, off() {}, release() {}, query: async (sql: string, p?: any[]) => {
      if (sql === 'COMMIT') return { rows: [], command: 'COMMIT' };
      if (sql === 'BEGIN') snapshot = structuredClone(db.rows);
      if (sql === 'ROLLBACK') db.rows = snapshot;
      return { rows: await execute(sql, p) };
    } };
  });
});
it.each(['other-owner', 'empty-insert', 'insert-error'])('keeps the previous grant after a %s replacement rejection', async (kind) => {
  db.conflict = kind === 'other-owner'; db.empty = kind === 'empty-insert'; db.fail = kind === 'insert-error';
  await expect(recordExecutionGrant(scope, input, { replace: true })).rejects.toThrow();
  expect((await listExecutionGrants(scope)).filter(g => g.status === 'active').map(g => g.id)).toEqual(['previous']);
});
it('atomically replaces the owned venue grant and permits an idempotent retry', async () => {
  await recordExecutionGrant(scope, input, { replace: true });
  await recordExecutionGrant(scope, input, { replace: true });
  expect((await listExecutionGrants(scope)).filter(g => g.status === 'active').map(g => g.id)).toEqual(['new']);
});
it('rejects the chain-kind mismatch before changing grants', async () => {
  await expect(recordExecutionGrant(scope, { ...input, chain: 'solana' }, { replace: true })).rejects.toThrow();
  expect((await listExecutionGrants(scope)).map(g => g.id)).toEqual(['previous']);
});
