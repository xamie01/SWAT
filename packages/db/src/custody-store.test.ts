import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createCustodyEnrollmentStore, createCustodyExecutionStore } from './custody-store.js';
import { buildCustodySecretBinding, CustodyContractError } from './custody-contract.js';
import type { UserScope } from './tenancy.js';
const scope = { userId: '11111111-1111-4111-8111-111111111111' } as UserScope;
const grantId = '22222222-2222-4222-8222-222222222222';
function record() {
  const base = { id: grantId, chain: 'robinhood-chain' as const, grantKind: 'session_key_4337' as const,
    accountAddress: '0x' + '1'.repeat(40), keyVersion: 7, scopePolicy: { max: '20' }, expiresAt: new Date('2030-01-01') };
  return { ...base, secretBinding: buildCustodySecretBinding({ ...base, grantId, userId: scope.userId, deploymentId: 'fixture-deployment', chainId: '4663' }),
    sealedSecret: ['v2','fixture-wrapper','7',Buffer.from('x').toString('base64'),Buffer.alloc(12).toString('base64'),
      Buffer.alloc(16).toString('base64'),Buffer.from('x').toString('base64')].join('.') };
}
describe('custody SQL adapter (injected same-client only, no PG execution)', () => {
  it('inserts bound row on provided tenant client and returns explicit public projection', async () => {
    const input = record();
    const query = vi.fn(async (..._args: any[]) => ({ rows: [{ id: input.id, user_id: scope.userId, chain: input.chain,
      grant_kind: input.grantKind, account_address: input.accountAddress, has_sealed_secret: true, key_version: 7,
      scope_policy: input.scopePolicy, expires_at: input.expiresAt, revoked_at: null, status: 'active', created_at: new Date(),
      sealed_secret: input.sealedSecret, secret_binding: input.secretBinding }] }));
    const transaction = vi.fn(async (tenant: UserScope, operation: any) => { expect(tenant).toEqual(scope); return operation({ query }); });
    const store = createCustodyEnrollmentStore(transaction as any);
    expect('load' in store).toBe(false);
    const result = await store.record(scope, input);
    expect('sealedSecret' in result).toBe(false); expect('secretBinding' in result).toBe(false);
    const [sql, values] = query.mock.calls[0] as any;
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING'); expect(sql).toContain('key_version IS NOT NULL AS has_sealed_secret');
    expect(sql.split('RETURNING')[1]).not.toMatch(/\bsealed_secret\b/);
    expect(values[0]).toBe(grantId); expect(values[1]).toBe(scope.userId); expect(JSON.parse(values[7])).toEqual(input.secretBinding);
  });
  it('does not silently replace a bound row on retry or conflict', async () => {
    const query = vi.fn(async (..._args: any[]) => ({ rows: [] }));
    const store = createCustodyEnrollmentStore((async (_scope: UserScope, operation: any) => operation({ query })) as any);
    await expect(store.record(scope, record())).rejects.toThrow('custody-conflict');
  });
  it('execution loader queries both tenant and row ID and carries persisted binding', async () => {
    const query = vi.fn(async (..._args: any[]) => ({ rows: [] }));
    const store = createCustodyExecutionStore((async (_scope: UserScope, operation: any) => operation({ query })) as any);
    expect(await store.load(scope, grantId)).toBeNull();
    const [sql, values] = query.mock.calls[0] as any;
    expect(sql).toContain('id = $1::uuid AND user_id = $2::uuid'); expect(values).toEqual([grantId, scope.userId]);
  });
  it('maps canonical revision and persistent Date tombstone only in executor snapshot', async () => {
    const input = record(), tombstone = new Date('2026-11-16');
    const query = vi.fn(async (..._args: any[]) => ({ rows: [{ id: input.id, user_id: scope.userId, chain: input.chain,
      grant_kind: input.grantKind, account_address: input.accountAddress, has_sealed_secret: true, key_version: 7,
      scope_policy: input.scopePolicy, expires_at: input.expiresAt, revoked_at: null, status: 'active', created_at: new Date(),
      sealed_secret: input.sealedSecret, secret_binding: input.secretBinding, lifecycle_revision: '12', revocation_tombstone: tombstone }] }));
    const store = createCustodyExecutionStore((async (_scope: UserScope, operation: any) => operation({ query })) as any);
    const snapshot = await store.load(scope, grantId);
    expect(snapshot).toMatchObject({ lifecycleRevision: '12', revocationTombstone: tombstone });
    expect(snapshot!.revocationTombstone).toBeInstanceOf(Date);
    expect(query.mock.calls[0]![0]).toContain('lifecycle_revision::text AS lifecycle_revision, revocation_tombstone');
  });
  it('rejects a changed row ID before invoking transaction', async () => {
    const transaction = vi.fn(), store = createCustodyEnrollmentStore(transaction);
    await expect(store.record(scope, { ...record(), id: '33333333-3333-4333-8333-333333333333' })).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it('enforces null keyVersion and hasSealedSecret=false for keyless solana_vault and rejects non-null keyVersion', async () => {
    const solanaVault = 'So11111111111111111111111111111111111111112';
    const query = vi.fn(async (..._args: any[]) => ({ rows: [{ id: grantId, user_id: scope.userId, chain: 'solana',
      grant_kind: 'solana_vault', account_address: solanaVault, has_sealed_secret: false, key_version: null,
      scope_policy: null, expires_at: null, revoked_at: null, status: 'active', created_at: new Date('2026-11-23T00:00:00.000Z') }] }));
    const transaction = vi.fn(async (tenant: UserScope, operation: any) => { expect(tenant).toEqual(scope); return operation({ query }); });
    const store = createCustodyEnrollmentStore(transaction as any);
    const result = await store.record(scope, { id: grantId, chain: 'solana', grantKind: 'solana_vault',
      accountAddress: solanaVault, sealedSecret: null, keyVersion: null, secretBinding: null, scopePolicy: null, expiresAt: null });
    expect(result).toMatchObject({ id: grantId, chain: 'solana', grantKind: 'solana_vault', hasSealedSecret: false, keyVersion: null });
    expect('sealedSecret' in result).toBe(false);
    expect('secretBinding' in result).toBe(false);
    const badTx = vi.fn();
    await expect(createCustodyEnrollmentStore(badTx).record(scope, { id: grantId, chain: 'solana', grantKind: 'solana_vault',
      accountAddress: solanaVault, sealedSecret: null, keyVersion: 1, secretBinding: null, scopePolicy: null, expiresAt: null }))
      .rejects.toThrowError(new CustodyContractError('custody-invalid'));
    expect(badTx).not.toHaveBeenCalled();
  });
});
describe('081 proposal source restrictions, not migrated database acceptance', () => {
  const sql = readFileSync(new URL('../../../threats/project-completion-20261117/081-custody-schema.proposal.sql', import.meta.url), 'utf8');
  it('requires a separate immutable admission writer and never provisions one', () => {
    expect(sql).toContain("current_user <> 'swat_custody_writer' OR session_user <> 'swat_custody_writer'");
    expect(sql).toContain('custody admissions are immutable');
    expect(sql).toContain('GRANT SELECT, INSERT ON public.custody_secret_admissions TO swat_custody_writer');
    expect(sql).not.toMatch(/^CREATE ROLE/m); expect(sql).not.toMatch(/^INSERT INTO/m);
  });
  it('forces exact tenant RLS and refuses app admission/self-certification', () => {
    expect(sql).toContain('ALTER TABLE public.custody_secret_admissions FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE public.user_execution_grants FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("NULLIF(current_setting('app.current_user_id',true),'')::uuid");
    expect(sql).toContain('AS RESTRICTIVE'); expect(sql).not.toContain("current_setting('app.bypass_rls'");
    expect(sql).toContain('REVOKE ALL ON public.custody_secret_admissions FROM PUBLIC, swat_app, swat_custody_writer');
  });
  it('generates monotonic lifecycle/tombstone before legacy retirement return and requires fresh post-revoke admission', () => {
    expect(sql).toContain('NEW.lifecycle_revision := OLD.lifecycle_revision + 1');
    expect(sql).toContain('NEW.revocation_tombstone := OLD.revocation_tombstone');
    expect(sql).toContain('NEW.revoked_at := OLD.revoked_at');
    expect(sql).toContain('NEW.activated_key_version := OLD.activated_key_version');
    expect(sql.indexOf('NEW.lifecycle_revision := OLD.lifecycle_revision + 1')).toBeLessThan(sql.indexOf("IF NOT changed_binding AND NEW.status <> 'active' THEN RETURN NEW"));
    expect(sql).toContain('NEW.key_version <= COALESCE(OLD.activated_key_version, OLD.key_version, 0)');
    expect(sql).toContain('a.accepted_at <= NEW.revocation_tombstone');
    expect(sql).toContain('fresh post-revocation custody admission required');
    expect(sql).toContain('NEW.lifecycle_revision := 1');
    expect(sql).toContain('NEW.activated_key_version := NEW.key_version');
  });
  it('refuses writer ownership, effective CREATE and either-direction memberships', () => {
    for (const text of ['member = writer OR roleid = writer','datdba = writer','nspowner = writer','relowner = writer','proowner = writer',
      "has_database_privilege(writer, current_database(), 'CREATE')", "has_schema_privilege(writer, oid, 'CREATE')",
      "nspname = 'public' AND nspowner = migrator", 'relowner = migrator', "to_regclass('public.custody_secret_admissions') IS NOT NULL",
      'unexpected preexisting custody catalog or non-migrator owner', 'unexpected resulting custody catalog or owner']) expect(sql).toContain(text);
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS public\.custody_secret_admissions/);
    expect(sql).not.toMatch(/ALTER (?:TABLE|FUNCTION).*OWNER TO swat_custody_writer/);
  });
  it('leaves transaction ownership to the migration suffix and journal runner', () => {
    const withoutComments = sql.replace(/--[^\n]*/g, '');
    expect(withoutComments).not.toMatch(/^\s*(?:BEGIN\s*;|START TRANSACTION\b|COMMIT\b|ROLLBACK\b|END\s*;)/im);
  });
  it('pins row ID, tenant, scope, expiry and envelope against immutable authenticated admission', () => {
    for (const text of ['a.chain IS DISTINCT FROM NEW.chain','a.account_address IS DISTINCT FROM NEW.account_address',
      'a.sealed_secret IS DISTINCT FROM NEW.sealed_secret','a.secret_binding IS DISTINCT FROM NEW.secret_binding',
      'a.scope_policy IS DISTINCT FROM NEW.scope_policy','a.expires_at IS DISTINCT FROM NEW.expires_at',
      'grant_id = NEW.id AND user_id = NEW.user_id AND key_version = NEW.key_version','NEW.id IS DISTINCT FROM OLD.id']) expect(sql).toContain(text);
    expect(sql).toContain('keyless grants must remain keyless'); expect(sql).toContain('NEW.accepted_at := statement_timestamp()');
  });
});
