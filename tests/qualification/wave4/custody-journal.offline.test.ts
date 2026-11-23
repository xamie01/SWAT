import { describe, expect, it, vi } from 'vitest';
import { createCustodyJournalObserver, requireCustodyJournal, requireCustodyRollback, custodyJournalHash,
  type CustodyJournal } from './custody-journal.js';
import { buildCustodySecretBinding } from '@swat/db/dist/custody-contract.js';
import type { CustodyCheckedTransaction } from './custody-owned-composition.js';
const USER = '11111111-1111-4111-8111-111111111111', GRANT = '22222222-2222-4222-8222-222222222222',
  RUN = '33333333-3333-4333-8333-333333333333';
const observed = new Date('2026-11-23T00:00:00.000Z');
function journal(): CustodyJournal {
  const record = { id: GRANT, chain: 'robinhood-chain' as const, grantKind: 'session_key_4337' as const,
    accountAddress: `0x${'1'.repeat(40)}`, keyVersion: 1, scopePolicy: { ceiling: '900719925474099312345' },
    expiresAt: new Date(observed.getTime() + 60000) };
  const secretBinding = buildCustodySecretBinding({ ...record, deploymentId: 'inert-deployment', chainId: '4663', userId: USER, grantId: GRANT });
  const sealedSecret = ['v2','inert-wrapper','1',Buffer.from('inert').toString('base64'),Buffer.alloc(12).toString('base64'),
    Buffer.alloc(16).toString('base64'),Buffer.from('inert').toString('base64')].join('.');
  const bound = { ...record, secretBinding, sealedSecret };
  return { scope: { runId: RUN, userId: USER, grantId: GRANT, chain: record.chain, observerIdentity: 'inert-observer',
    deploymentId: 'inert-deployment', chainId: '4663' }, observedAt: observed.toISOString(),
    grant: { ...bound, userId: USER, status: 'active', lifecycleRevision: '1', revokedAt: null, revocationTombstone: null },
    admissions: [{ id: '44444444-4444-4444-8444-444444444444', userId: USER, record: bound,
      wrapperId: 'inert-wrapper', serviceIdentity: 'inert-wrap-service', authenticatedReceipt: 'inert-authenticated-receipt', acceptedAt: observed }],
    history: [] };
}
function fixture() {
  const expected = journal(), grant = expected.grant!, admission = expected.admissions[0]!;
  const state = { identity: 'inert-observer', isolation: 'repeatable read', readOnly: 'on', writes: false, outcome: 'committed',
    approved: true, expired: false, tenant: USER, bypass: 'off' };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const reply = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (sql.includes('session_user')) return reply([{ authenticated_role: state.identity, runtime_role: state.identity,
      tenant: state.tenant, bypass: state.bypass, observed_at: observed, isolation: state.isolation,
      read_only: state.readOnly, admission_write: state.writes, grant_write: state.writes }]);
    if (sql.includes('FROM user_execution_grants')) return reply([{ id: grant.id, user_id: grant.userId, chain: grant.chain,
      grant_kind: grant.grantKind, account_address: grant.accountAddress, has_sealed_secret: true, key_version: grant.keyVersion,
      scope_policy: grant.scopePolicy, expires_at: grant.expiresAt, revoked_at: null, status: grant.status, created_at: observed,
      sealed_secret: grant.sealedSecret, secret_binding: grant.secretBinding, lifecycle_revision: grant.lifecycleRevision, revocation_tombstone: null }]);
    if (sql.includes('SELECT key_version')) return reply([{ key_version: 1 }]);
    if (sql.includes('FROM custody_secret_admissions')) {
      expect(values).toEqual([GRANT, USER, 1]); return reply([{ id: admission.id, grant_id: GRANT, user_id: USER, chain: grant.chain,
        grant_kind: grant.grantKind, account_address: grant.accountAddress, key_version: 1, sealed_secret: grant.sealedSecret,
        secret_binding: grant.secretBinding, scope_policy: grant.scopePolicy, expires_at: grant.expiresAt,
        wrapper_id: admission.wrapperId, service_identity: admission.serviceIdentity, authenticated_receipt: admission.authenticatedReceipt,
        accepted_at: observed }]);
    }
    if (sql.includes('FROM audit_log')) { expect(sql).toContain('occurred_at AS created_at'); return reply([]); }
    throw new Error('unexpected inert observer SQL');
  });
  const transaction: CustodyCheckedTransaction = async (_scope, action) => ({ value: await action({ query } as any), outcome: state.outcome as any });
  const observe = createCustodyJournalObserver({ scope: expected.scope, transaction, check: () => {},
    admission: { authorize: async request => state.approved ? { approved: true, request, capabilities: ['execution-secret-read'],
      validUntil: new Date(observed.getTime() + (state.expired ? 0 : 1000)) } : null } });
  return { expected, state, query, observe };
}
describe('P5a independent durable custody observer/refusal/rollback contract; inert SQL', () => {
  it('reads one separate read-only repeatable snapshot and joins exact tenant/version admissions', async () => {
    const f = fixture(), result = await f.observe(); requireCustodyJournal(result, f.expected);
    expect(custodyJournalHash(result)).toMatch(/^[0-9a-f]{64}$/);
    expect(f.query.mock.calls.every(([sql]) => !/INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK/.test(sql.replace(/'INSERT,UPDATE,DELETE'/g,'')))).toBe(true);
  });
  it.each(['identity','tenant','bypass','isolation','read-only','writer','expired','missing-approval','uncertain'] as const)(
    'refuses %s observer boundary without claiming durable success', async reason => {
      const f = fixture();
      if (reason === 'identity') f.state.identity = 'swat_app'; if (reason === 'tenant') f.state.tenant = RUN;
      if (reason === 'bypass') f.state.bypass = 'on'; if (reason === 'isolation') f.state.isolation = 'read committed';
      if (reason === 'read-only') f.state.readOnly = 'off'; if (reason === 'writer') f.state.writes = true;
      if (reason === 'expired') f.state.expired = true; if (reason === 'missing-approval') f.state.approved = false;
      if (reason === 'uncertain') f.state.outcome = 'uncertain';
      await expect(f.observe()).rejects.toThrow('Custody journal');
      if (reason !== 'uncertain') expect(f.query.mock.calls.some(([sql]) => sql.includes('FROM user_execution_grants'))).toBe(false);
    });
  it.each(['tenant','account','version','receipt','revision','tombstone','policy','history','extra-admission'] as const)(
    'independent journal rejects %s substitution', reason => {
      const before = journal(), changed = structuredClone(before);
      if (reason === 'tenant') (changed.grant as any).userId = RUN;
      if (reason === 'account') (changed.grant as any).accountAddress = `0x${'2'.repeat(40)}`;
      if (reason === 'version') (changed.admissions[0]!.record as any).keyVersion = 2;
      if (reason === 'receipt') (changed.admissions[0] as any).authenticatedReceipt = 'substitution';
      if (reason === 'revision') (changed.grant as any).lifecycleRevision = '3';
      if (reason === 'tombstone') (changed.grant as any).revocationTombstone = observed;
      if (reason === 'policy') (changed.grant as any).scopePolicy = { ceiling: '1' };
      if (reason === 'history') (changed.history as any[]).push({ event: 'invented', actorType: 'user', actorId: USER,
        targetType: 'execution_grant', targetId: GRANT, metadata: {}, createdAt: observed.toISOString() });
      if (reason === 'extra-admission') (changed.admissions as any[]).push(structuredClone(changed.admissions[0]));
      expect(() => requireCustodyJournal(changed,before)).toThrow('Custody journal');
    });
  it('rollback preserves all durable rows and only an explicitly exact independently committed admission', () => {
    const before = journal(), unchanged = structuredClone(before); requireCustodyRollback(before,unchanged);
    const absent: CustodyJournal = { ...before, grant: null, admissions: [] };
    const retained: CustodyJournal = { ...absent, admissions: before.admissions };
    requireCustodyRollback(absent, retained, before.admissions[0]);
    expect(() => requireCustodyRollback(absent,retained)).toThrow('Custody journal');
    expect(() => requireCustodyRollback(before,{ ...before, grant: { ...before.grant!, lifecycleRevision: '2' } })).toThrow('Custody journal');
  });
  it('cannot hide a future accepted admission or duplicate immutable version by comparing a fixture to itself', () => {
    const future = journal(); (future.admissions[0] as any).acceptedAt = new Date(observed.getTime()+1);
    expect(() => requireCustodyJournal(future,future)).toThrow('Custody journal');
    const duplicate = journal(); (duplicate.admissions as any[]).push(structuredClone(duplicate.admissions[0]));
    expect(() => requireCustodyJournal(duplicate,duplicate)).toThrow('Custody journal');
  });
});
