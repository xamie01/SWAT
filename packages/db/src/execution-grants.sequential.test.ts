import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ query: vi.fn(), tenantQuery: vi.fn(), transaction: vi.fn(), rows: [] as any[],
  admissions: [] as any[], conflict: false, fail: false, empty: false }));
vi.mock('./client.js', () => ({ query: db.query }));
vi.mock('@swat/shared', () => ({ resolveChainAddress: (address: string) => ({ raw: address.toLowerCase() }) }));
vi.mock('./tenancy.js', () => ({ isCrossTenant: (scope: { userId: string }) => scope.userId === '*',
  scopedQuery: db.tenantQuery, withTenantTransaction: db.transaction }));
import { buildCustodySecretBinding } from './custody-contract.js';
import { recordExecutionGrant, listExecutionGrants, revokeExecutionGrant } from './execution-grants.js';
const scope = { userId: '11111111-1111-4111-8111-111111111111' } as any;
const id = '22222222-2222-4222-8222-222222222222';
const time = new Date('2026-11-17T00:00:00Z');
function keyed(version = 1) {
  return { id, chain: 'polygon' as const, grantKind: 'polymarket_signer' as const, accountAddress: '0x' + '2'.repeat(40),
    sealedSecret: ['v2','fixture-wrapper',String(version),Buffer.from('x').toString('base64'),Buffer.alloc(12).toString('base64'),
      Buffer.alloc(16).toString('base64'),Buffer.from(`inert-${version}`).toString('base64')].join('.'), keyVersion: version,
    secretBinding: buildCustodySecretBinding({ deploymentId: 'fixture-deployment', chainId: '137', userId: scope.userId,
      grantId: id, chain: 'polygon', grantKind: 'polymarket_signer', accountAddress: '0x' + '2'.repeat(40),
      keyVersion: version, scopePolicy: null, expiresAt: null }) };
}
const input = keyed();
function admission(record: ReturnType<typeof keyed>, acceptedAt = new Date(time.getTime() + 1)) {
  db.admissions.push({ id: record.id, keyVersion: record.keyVersion, secretBinding: record.secretBinding,
    sealedSecret: record.sealedSecret, acceptedAt });
}
// In-memory rollback/lifecycle model only, NOT PostgreSQL trigger/RLS/concurrency proof.
beforeEach(() => {
  vi.clearAllMocks(); db.conflict = false; db.fail = false; db.empty = false; db.admissions = [];
  db.rows = [{ id: 'previous', user_id: scope.userId, chain: 'polygon', grant_kind: 'polymarket_signer',
    account_address: '0x' + '1'.repeat(40), status: 'active', lifecycle_revision: '1', revocation_tombstone: null,
    revoked_at: null, expires_at: null, key_version: 1, activated_key_version: 1 }];
  admission(input);
  const execute = async (sql: string, p: any[] = []) => {
    if (sql.includes('FROM users')) return [{ id: scope.userId }];
    if (sql.includes('SELECT') && sql.includes('FROM user_execution_grants')) {
      if (sql.includes('FOR UPDATE')) return db.conflict ? [{ id: 'other', user_id: 'other-owner', status: 'revoked' }]
        : db.rows.filter(r => r.chain === p[0] && r.account_address === p[1]);
      return db.rows.filter(r => r.user_id === p[0]);
    }
    if (sql.includes('INSERT INTO user_execution_grants')) {
      if (db.fail) throw new Error('insert failed'); if (db.empty) return [];
      const old = db.rows.find(r => r.id === p[8]);
      const a = db.admissions.find(a => a.id === p[8] && a.keyVersion === p[5]);
      if (p[5] !== null && (!a || a.sealedSecret !== p[4] || JSON.stringify(a.secretBinding) !== p[9] ||
        (old?.revocation_tombstone && a.acceptedAt <= old.revocation_tombstone))) throw new Error('independent authenticated custody admission required');
      const row = { ...old, id: p[8], user_id: p[0], chain: p[1], grant_kind: p[2], account_address: p[3],
        sealed_secret: p[4], has_sealed_secret: p[4] !== null, key_version: p[5], scope_policy: JSON.parse(p[6] ?? 'null'),
        expires_at: p[7], secret_binding: JSON.parse(p[9] ?? 'null'), status: sql.includes("'retired'") ? 'retired' : 'active',
        revoked_at: old?.revoked_at ?? null, revocation_tombstone: old?.revocation_tombstone ?? null,
        lifecycle_revision: old ? (BigInt(old.lifecycle_revision) + 1n).toString() : '1',
        activated_key_version: old?.activated_key_version ?? (sql.includes("'retired'") ? null : p[5]) };
      db.rows = [...db.rows.filter(r => r.id !== p[8]), row]; return [structuredClone(row)];
    }
    if (sql.includes('UPDATE user_execution_grants') && sql.includes("SET status = 'revoked'")) {
      const rows = db.rows.filter(r => r.status === 'active' && (sql.includes('id <> $4') ? r.id !== p[3] && r.user_id === p[0] : r.id === p[0] && r.user_id === p[1]));
      rows.forEach(r => { r.status = 'revoked'; r.revoked_at = time; r.revocation_tombstone = time;
        r.lifecycle_revision = (BigInt(r.lifecycle_revision) + 1n).toString(); r.activated_key_version = r.key_version; });
      return rows.map(r => ({ id: r.id }));
    }
    if (sql.includes('UPDATE user_execution_grants') && sql.includes("SET status = 'active'")) {
      const row = db.rows.find(r => r.id === p[0] && r.user_id === p[1] && r.status === 'retired');
      if (!row) return [];
      if (row.revocation_tombstone && (row.key_version === null || row.key_version <= row.activated_key_version)) throw new Error('fresh admission version required');
      row.status = 'active'; row.revoked_at = null; row.activated_key_version = row.key_version;
      row.lifecycle_revision = (BigInt(row.lifecycle_revision) + 1n).toString(); return [structuredClone(row)];
    }
    return [];
  };
  db.query.mockImplementation(execute);
  db.transaction.mockImplementation(async (tenant, operation) => {
    expect(tenant).toEqual(scope); if (tenant.userId === '*') throw new Error('cross-tenant blocked');
    const snapshot = structuredClone(db.rows);
    try { return await operation({ query: async (sql: string, values?: any[]) => ({ rows: await execute(sql, values) }) }); }
    catch (error) { db.rows = snapshot; throw error; }
  });
  db.tenantQuery.mockImplementation(async (tenant, sql, values) => { expect(tenant).toEqual(scope); return execute(sql, values); });
});
it.each(['other-owner', 'empty-insert', 'insert-error'])('keeps the previous grant after a %s replacement rejection', async kind => {
  db.conflict = kind === 'other-owner'; db.empty = kind === 'empty-insert'; db.fail = kind === 'insert-error';
  await expect(recordExecutionGrant(scope, input, { replace: true })).rejects.toThrow();
  expect((await listExecutionGrants(scope)).filter(g => g.status === 'active').map(g => g.id)).toEqual(['previous']);
});
it('atomically replaces in authenticated tenant transaction and retries without lifecycle writes', async () => {
  await recordExecutionGrant(scope, input, { replace: true });
  const revision = db.rows.find(r => r.id === id).lifecycle_revision;
  await recordExecutionGrant(scope, input, { replace: true });
  expect(db.rows.find(r => r.id === id).lifecycle_revision).toBe(revision);
  expect((await listExecutionGrants(scope)).filter(g => g.status === 'active').map(g => g.id)).toEqual([id]);
  expect(db.transaction).toHaveBeenCalledTimes(2); expect(db.transaction.mock.calls.every(([tenant]) => tenant.userId === scope.userId)).toBe(true);
});
it('refuses same-account replacement that substitutes a bound row ID', async () => {
  await recordExecutionGrant(scope, input, { replace: true });
  const changedId = '33333333-3333-4333-8333-333333333333';
  await expect(recordExecutionGrant(scope, { ...input, id: changedId, secretBinding: { ...input.secretBinding, grantId: changedId } }, { replace: true })).rejects.toThrow();
  expect((await listExecutionGrants(scope)).filter(g => g.status === 'active').map(g => g.id)).toEqual([id]);
});
it('revocation cannot be cleared by same-version replace or a stale independent admission', async () => {
  await recordExecutionGrant(scope, input, { replace: true }); await revokeExecutionGrant(scope, id);
  await expect(recordExecutionGrant(scope, input, { replace: true })).rejects.toThrow();
  const rotated = keyed(2); admission(rotated, new Date(time.getTime() - 1));
  await expect(recordExecutionGrant(scope, rotated, { replace: true })).rejects.toThrow('independent authenticated custody admission required');
  expect(db.rows.find(r => r.id === id)).toMatchObject({ status: 'revoked', key_version: 1, revocation_tombstone: time });
});
it('fresh post-revocation version activates through retirement without erasing persistent tombstone', async () => {
  await recordExecutionGrant(scope, input, { replace: true });
  const initialRevision = BigInt(db.rows.find(r => r.id === id).lifecycle_revision);
  await revokeExecutionGrant(scope, id); const rotated = keyed(2); admission(rotated);
  await recordExecutionGrant(scope, rotated, { replace: true });
  const row = db.rows.find(r => r.id === id);
  expect(row).toMatchObject({ status: 'active', revoked_at: null, revocation_tombstone: time, key_version: 2, activated_key_version: 2 });
  expect(BigInt(row.lifecycle_revision)).toBeGreaterThan(initialRevision);
  await revokeExecutionGrant(scope, id); await expect(recordExecutionGrant(scope, rotated, { replace: true })).rejects.toThrow();
});
it('refuses keyless same-row resurrection after revocation/retired staging', async () => {
  const keylessId = '33333333-3333-4333-8333-333333333333';
  db.rows = [{ id: keylessId, user_id: scope.userId, chain: 'solana', grant_kind: 'solana_vault',
    account_address: 'So11111111111111111111111111111111111111112'.toLowerCase(), status: 'retired', revoked_at: time,
    revocation_tombstone: time, key_version: null, lifecycle_revision: '3' }];
  await expect(recordExecutionGrant(scope, { id: keylessId, chain: 'solana', grantKind: 'solana_vault',
    accountAddress: 'So11111111111111111111111111111111111111112' }, { replace: true })).rejects.toThrow();
  expect(db.rows[0].revocation_tombstone).toEqual(time);
});
it('rejects legacy keyed enrollment before changing storage', async () => {
  await expect(recordExecutionGrant(scope, { ...input, id: undefined, secretBinding: undefined, sealedSecret: 'v1.synthetic' }))
    .rejects.toThrow('Resource-bound v2 enrollment required'); expect(db.transaction).not.toHaveBeenCalled();
});
it('rejects chain-kind mismatch before changing grants', async () => {
  await expect(recordExecutionGrant(scope, { ...input, chain: 'solana' }, { replace: true })).rejects.toThrow();
  expect((await listExecutionGrants(scope)).map(g => g.id)).toEqual(['previous']);
});
