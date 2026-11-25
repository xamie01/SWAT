import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../../packages/db/src/copy-trade-lifecycle-owned.js';
import type { LoadProtectedCapturePort } from './load-fixture-consumers.js';
import { loadDigest, loadFixtureRequest, type LoadFixture } from './load-durable-contract.js';
import { createWave4LoadProtectedCapture, WAVE4_LOAD_CAPTURE_BLOCKERS, WAVE4_LOAD_CAPTURE_STATUS }
  from '../../../packages/db/src/wave4-load-capture-owned.js';
import { provisionWave4LoadCaptureWithClient, WAVE4_LOAD_CAPTURE_RELATIONS, WAVE4_LOAD_DEFERRED_COMMIT,
  WAVE4_LOAD_DISABLED_ROLES, WAVE4_LOAD_FOREIGN_KEYS, WAVE4_LOAD_FUNCTION_SIGNATURES,
  WAVE4_LOAD_OWNER_READ_INVENTORY, WAVE4_LOAD_OWNER_TRANSFERS, WAVE4_LOAD_PROVISIONING_BLOCKERS,
  WAVE4_LOAD_PROVISIONING_STATUS, WAVE4_LOAD_ROUTINES }
  from '../../../deploy/postgres/wave4-load-provisioning.js';

/** AUTHORED / UNRUN. Fake clients exercise refusal/comparison/control flow ONLY.
 * They do not prove PostgreSQL authorization, deferred FK/trigger execution,
 * isolation, lock timing, canonical economics or successful COMMIT. */
type Invocation = Parameters<LoadProtectedCapturePort['assertInvocationWithClient']>[1];
type Bind = Parameters<LoadProtectedCapturePort['bindCanonicalWithClient']>[1];
const RUN = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FIXTURE = '33333333-3333-4333-8333-333333333333';
const ATTEMPT = '44444444-4444-4444-8444-444444444444';
const SOURCE = '55555555-5555-4555-8555-555555555555';
const SIGNAL = '66666666-6666-4666-8666-666666666666';
const EXECUTION = '77777777-7777-4777-8777-777777777777';
const APPROVAL = '88888888-8888-4888-8888-888888888888';
const at = '2026-11-23T00:00:00.000Z';
const scope = { runId: RUN, namespace: `wave4-load-${RUN}`, network: `solana:wave4-${RUN}`,
  backendIdentity: 'offline|unix|0|swat_app' };
const walletAddress = 'solana:11111111111111111111111111111111';
const tokenMint = 'solana:11111111111111111111111111111112';
const stageRoles = { source: 'swat_source_provider_writer', fanout: 'swat_fanout', worker: 'swat_app' };
function invocation(stage: Invocation['stage'] = 'fanout', kind: LoadFixture['kind'] = 'wallet'): Invocation {
  const f: LoadFixture = { scope: { ...scope }, fixtureId: FIXTURE, userId: USER, kind, walletAddress, tokenMint,
    targetAccount: walletAddress, binding: { chain: 'solana', network: scope.network, sourceEventType: 'transaction',
      sourceEventId: `${scope.namespace}/${FIXTURE}`, sourceEventIndex: '0', transactionHash: `${scope.namespace}/${FIXTURE}`,
      walletAddress, tokenMint, side: 'buy', rawQuantity: '1000000000', quantityScale: 9, eventAt: at,
      amountUsd: '100', priceUsd: null, feeUsd: '0' }, base: { raw: '1500000000', scale: 9 },
    quoteBudget: { raw: '20000000000', scale: 9 }, quote: { raw: '20000000000', scale: 9 },
    fee: { raw: '10000000', scale: 9 }, requestDigest: '' };
  const fixture = { ...f, requestDigest: loadDigest(loadFixtureRequest(f)) };
  return { scope: { ...scope }, fixture, principal: { kind: 'user', userId: USER }, stage,
    attempt: { attemptId: ATTEMPT, fixtureId: FIXTURE, runId: RUN, namespace: scope.namespace,
      userId: USER, requestDigest: fixture.requestDigest,
      route: kind === 'wallet' ? '/v1/me/wallets' : '/v1/me/tokens/backfill', status: 201, startedAt: at, finishedAt: at } };
}
function bind(): Bind {
  return { scope: { ...scope }, fixtureId: FIXTURE, attemptId: ATTEMPT, userId: USER,
    sourceTradeId: SOURCE, signalId: SIGNAL, executionId: EXECUTION, jobId: `source-trade-${SIGNAL}-u-${USER}` };
}
function fake(stage: Invocation['stage'] = 'fanout') {
  const role = stageRoles[stage];
  const identity = { current_role: role, session_role: role, role_setting: 'none', row_security: 'on', bypass: 'off',
    user_scope: stage === 'worker' ? USER : '', execution_scope: stage === 'worker' ? EXECUTION : '',
    read_only: 'off', isolation: 'read committed', backend_pid: 123, backend_start: '2026-11-23 00:00:00+00',
    transaction_id: '1000', explicit_transaction: true, database_oid: '42', database_name: 'offline',
    server_address: 'unix', server_port: 0, backend_identity: `offline|unix|0|${role}`, safe_role: true };
  let approvalMutation: (a: Record<string, unknown>) => void = () => {};
  let invocationMutation: (a: Record<string, unknown>) => void = () => {};
  let outcomeMutation: (a: Record<string, unknown>) => void = () => {};
  let canonical: Bind | null = null;
  let deliveryPersisted = false;
  const outcomes = new Map<string, Record<string, unknown>>();
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('pg_catalog.pg_stat_activity')) return { rows: [{ ...identity }] };
    if (sql === 'SELECT wave4_load.assert_invocation($1::jsonb) AS invocation') {
      const q = JSON.parse(values![0] as string) as Invocation;
      const a: Record<string, unknown> = { approval_id: APPROVAL, run_id: RUN, fixture_id: FIXTURE, stage,
        runtime_role: role, database_oid: 42, server_address: 'unix', server_port: 0,
        backend_identity: `offline|unix|0|${role}`, revision: 'offline-v1', revoked_at: null };
      approvalMutation(a);
      const result: Record<string, unknown> = { scope: q.scope, fixtureId: q.fixture.fixtureId,
        attemptId: q.attempt.attemptId, userId: q.fixture.userId, stage: q.stage, approval: a };
      invocationMutation(result);
      return { rows: [{ invocation: result }] };
    }
    if (sql === 'SELECT wave4_load.bind_canonical($1::jsonb) AS outcome') {
      const q = JSON.parse(values![0] as string) as Bind;
      if (canonical && ['runId','fixtureId','userId','sourceTradeId','signalId','executionId','jobId'].some(
        key => canonical![key as keyof Bind] !== q[key as keyof Bind])) throw new Error('replay changed original canonical obligation');
      const kind = !canonical || canonical.attemptId === q.attemptId ? 'admitted' : 'replay';
      if (kind === 'replay' && !deliveryPersisted) throw new Error('replay original persisted delivery missing');
      canonical ??= structuredClone(q);
      const o: Record<string, unknown> = { attempt_id: q.attemptId, run_id: q.scope.runId, fixture_id: q.fixtureId,
        user_id: q.userId, source_trade_id: q.sourceTradeId, signal_id: q.signalId, execution_id: q.executionId,
        job_id: q.jobId, outcome: kind, reason: null, admitted_at: at };
      const persisted = outcomes.get(q.attemptId);
      if (persisted && JSON.stringify(persisted) !== JSON.stringify(o)) throw new Error('immutable attempt outcome changed');
      outcomes.set(q.attemptId, structuredClone(o));
      outcomeMutation(o);
      return { rows: [{ outcome: o }] };
    }
    throw new Error(`Unlisted offline SQL refused: ${sql}`);
  });
  return { client: { query } as unknown as PoolClient, query, identity,
    persistDelivery: () => { deliveryPersisted = true; },
    outcome: (attemptId: string) => outcomes.get(attemptId),
    approvalMutation: (fn: typeof approvalMutation) => { approvalMutation = fn; },
    invocationMutation: (fn: typeof invocationMutation) => { invocationMutation = fn; },
    outcomeMutation: (fn: typeof outcomeMutation) => { outcomeMutation = fn; } };
}

describe('FROZEN mandatory-client SQL090 capture source contracts (unrun)', () => {
  it.each(['source','fanout','worker'] as const)('delegates %s to the exact persisted routine on the supplied client', async stage => {
    const f = fake(stage), port: LoadProtectedCapturePort = createWave4LoadProtectedCapture(), q = invocation(stage);
    await expect(port.assertInvocationWithClient(f.client, q)).resolves.toBeUndefined();
    expect(f.query).toHaveBeenCalledTimes(3);
    expect(f.query.mock.calls[1]).toEqual(['SELECT wave4_load.assert_invocation($1::jsonb) AS invocation',
      [expect.any(String)]]);
    expect(JSON.parse(f.query.mock.calls[1]![1]![0] as string)).toEqual(q);
  });
  it.each(['wallet','token'] as const)('checks complete %s fixture/request/principal before SQL', async kind => {
    const f = fake(), port = createWave4LoadProtectedCapture();
    await port.assertInvocationWithClient(f.client, invocation('fanout', kind));
    expect(f.query.mock.calls[1]![0]).toContain('wave4_load.assert_invocation');
  });
  const hostile: [string, (q: any) => void][] = [
    ['principal tenant', q => q.principal.userId = FIXTURE], ['operator principal', q => q.principal.kind = 'operator'],
    ['principal callback', q => q.principal.approved = () => true], ['role label', q => q.role = 'swat_fanout'],
    ['http stage', q => q.stage = 'http'], ['observer stage', q => q.stage = 'observer'],
    ['wrong run', q => q.attempt.runId = FIXTURE], ['wrong namespace', q => q.attempt.namespace += '-foreign'],
    ['wrong scope network', q => q.scope.network = 'solana:mainnet'],
    ['backend label mismatch', q => q.scope.backendIdentity = 'trusted-callback'],
    ['fixture id', q => q.attempt.fixtureId = USER], ['attempt path', q => q.attempt.attemptId = '../outside'],
    ['attempt tenant', q => q.attempt.userId = FIXTURE], ['request digest', q => q.attempt.requestDigest = 'a'.repeat(64)],
    ['noncanonical UUID', q => q.attempt.attemptId = ATTEMPT.toUpperCase() + '\n'],
    ['failed response', q => q.attempt.status = 429], ['HTTP 204', q => q.attempt.status = 204],
    ['wrong route', q => q.attempt.route = '/v1/wallets'], ['invalid time', q => q.attempt.startedAt = 'now'],
    ['chronology', q => q.attempt.startedAt = '2026-11-23T00:00:01.000Z'],
    ['changed source binding', q => q.fixture.binding.network = 'solana:mainnet'],
    ['binding extra authority', q => q.fixture.binding.approved = true],
    ['extra fixture property', q => q.fixture.runtimeAccepted = true],
    ['extra scope property', q => q.scope.authorized = true],
    ['amount floating raw', q => q.fixture.base.raw = 1.5], ['amount scale', q => q.fixture.base.scale = 19],
    ['extra amount key', q => q.fixture.fee.accountingComplete = true],
    ['prototype', q => q.principal = Object.assign(Object.create({ approved: true }), q.principal)],
    ['symbol', q => q.principal[Symbol('approved')] = true],
    ['hidden property', q => Object.defineProperty(q.principal, 'approved', { value: true })],
    ['oversized JSON', q => q.principal.payload = 'x'.repeat(262145)]
  ];
  it.each(hostile)('refuses hostile %s before SQL', async (_name, change) => {
    const f = fake(), q = invocation(); change(q);
    await expect(createWave4LoadProtectedCapture().assertInvocationWithClient(f.client, q)).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
  it('never invokes an accessor as an authorization seam', async () => {
    const f = fake(), q = invocation(), getter = vi.fn(() => 'user');
    Object.defineProperty(q.principal, 'kind', { enumerable: true, get: getter });
    await expect(createWave4LoadProtectedCapture().assertInvocationWithClient(f.client, q)).rejects.toThrow(/accessor/);
    expect(getter).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
  });
  const identities: [string, string, unknown][] = [
    ['switched current role','current_role','swat_migrator'], ['foreign session','session_role','swat_app'],
    ['SET ROLE','role_setting','swat_fanout'], ['disabled RLS','row_security','off'], ['bypass GUC','bypass','on'],
    ['unsafe role flags/membership/ownership/CREATE','safe_role',false], ['implicit transaction','explicit_transaction',false],
    ['read only writer','read_only','on'], ['stale repeatable snapshot','isolation','repeatable read'],
    ['nonworker user GUC','user_scope',USER], ['nonworker execution GUC','execution_scope',EXECUTION],
    ['backend label','backend_identity','callback-approved'], ['missing own backend_start','backend_start',null],
    ['missing xid','transaction_id',null], ['invalid database oid','database_oid','42junk'], ['invalid port','server_port',-1]
  ];
  it.each(identities)('rejects direct identity drift: %s', async (_name, key, value) => {
    const f = fake(); Object.assign(f.identity, { [key]: value });
    await expect(createWave4LoadProtectedCapture().assertInvocationWithClient(f.client, invocation())).rejects.toThrow();
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it('refuses unavailable identity/routine/cardinality with no fallback/retry', async () => {
    for (const reply of [{ rows: [] }, { rows: [{}, {}] }]) {
      const f = fake(); f.query.mockResolvedValueOnce(reply as never);
      await expect(createWave4LoadProtectedCapture().assertInvocationWithClient(f.client, invocation())).rejects.toThrow();
      expect(f.query).toHaveBeenCalledTimes(1);
    }
    const f = fake(); f.query.mockRejectedValueOnce(new Error('permission denied'));
    await expect(createWave4LoadProtectedCapture().assertInvocationWithClient(f.client, invocation())).rejects.toThrow(/permission denied/);
    expect(f.query).toHaveBeenCalledTimes(1);
    await expect(createWave4LoadProtectedCapture().assertInvocationWithClient(null as unknown as PoolClient, invocation())).rejects.toThrow(/mandatory/);
  });
  const approvalDrift: [string, unknown][] = [['run_id',USER],['fixture_id',USER],['stage','worker'],
    ['runtime_role','swat_app'],['database_oid',43],['server_address','127.0.0.1'],['server_port',5432],
    ['backend_identity','label'],['revoked_at',at],['approval_id',null],['revision','']];
  it.each(approvalDrift)('rejects persisted approval drift %s', async (key, value) => {
    const f = fake(); f.approvalMutation(a => { a[key] = value; });
    await expect(createWave4LoadProtectedCapture().assertInvocationWithClient(f.client, invocation())).rejects.toThrow();
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it('rejects a bare approved callback reply or mismatched persisted principal/request reply', async () => {
    const f = fake(); f.invocationMutation(a => { a.attemptId = FIXTURE; });
    await expect(createWave4LoadProtectedCapture().assertInvocationWithClient(f.client, invocation())).rejects.toThrow(/reply mismatch/);
    const empty = fake(); empty.query.mockImplementationOnce(async () => ({ rows: [{ approved: true }] }) as never);
    await expect(createWave4LoadProtectedCapture().assertInvocationWithClient(empty.client, invocation())).rejects.toThrow();
  });
  it('snapshots input before the first awaited client operation', async () => {
    const f = fake(), q = invocation(), original = structuredClone(q);
    const pending = createWave4LoadProtectedCapture().assertInvocationWithClient(f.client, q);
    (q.principal as { userId: string }).userId = FIXTURE;
    (q.fixture.binding as { network: string }).network = 'solana:mainnet';
    await pending;
    expect(JSON.parse(f.query.mock.calls[1]![1]![0] as string)).toEqual(original);
  });
  it('binds BEFORE delivery insertion with only the exact SQL090 bind; does not report COMMIT/acceptance', async () => {
    const f = fake(), port = createWave4LoadProtectedCapture();
    await port.assertInvocationWithClient(f.client, invocation());
    await expect(port.bindCanonicalWithClient(f.client, bind())).resolves.toBeUndefined();
    const sql = f.query.mock.calls.map(c => c[0]);
    expect(sql.filter(s => s.includes('wave4_load.bind_canonical'))).toEqual(['SELECT wave4_load.bind_canonical($1::jsonb) AS outcome']);
    expect(sql.join('\n')).not.toMatch(/INSERT INTO|FROM public\.source_fanout_deliveries|SET CONSTRAINTS|BEGIN|COMMIT/);
    expect(sql.filter(s => s.includes('wave4_load.assert_invocation'))).toHaveLength(2);
  });
  it('refuses binding with no assertion, other client, source stage, changed correlation or changed xid', async () => {
    const port = createWave4LoadProtectedCapture(), f = fake();
    await expect(port.bindCanonicalWithClient(f.client, bind())).rejects.toThrow(/same-client/);
    await port.assertInvocationWithClient(f.client, invocation());
    await expect(port.bindCanonicalWithClient(fake().client, bind())).rejects.toThrow(/same-client/);
    await expect(port.bindCanonicalWithClient(f.client, { ...bind(), attemptId: USER })).rejects.toThrow(/correlation/);
    f.identity.transaction_id = '1001';
    await expect(port.bindCanonicalWithClient(f.client, bind())).rejects.toThrow(/transaction/);
    await expect(port.bindCanonicalWithClient(f.client, bind())).rejects.toThrow(/same-client/);
    const source = fake('source');
    await port.assertInvocationWithClient(source.client, invocation('source'));
    await expect(port.bindCanonicalWithClient(source.client, bind())).rejects.toThrow(/fanout invocation/);
  });
  it('rejects backend/transaction drift during an awaited protected query', async () => {
    const f = fake(); f.invocationMutation(() => { f.identity.transaction_id = '1001'; });
    await expect(createWave4LoadProtectedCapture().assertInvocationWithClient(f.client, invocation())).rejects.toThrow(/transaction/);
  });
  it('bind reauthorization error clears correlation and never calls bind or retries', async () => {
    const f = fake(), port = createWave4LoadProtectedCapture();
    await port.assertInvocationWithClient(f.client, invocation());
    f.approvalMutation(a => { a.revoked_at = at; });
    await expect(port.bindCanonicalWithClient(f.client, bind())).rejects.toThrow(/approval/);
    await expect(port.bindCanonicalWithClient(f.client, bind())).rejects.toThrow(/same-client/);
    expect(f.query.mock.calls.some(c => c[0].includes('wave4_load.bind_canonical'))).toBe(false);
  });
  it('keeps repeat binding of the original attempt admitted', async () => {
    const f = fake(), port = createWave4LoadProtectedCapture();
    await port.assertInvocationWithClient(f.client, invocation());
    await port.bindCanonicalWithClient(f.client, bind());
    await expect(port.bindCanonicalWithClient(f.client, bind())).resolves.toBeUndefined();
    expect(f.outcome(ATTEMPT)?.outcome).toBe('admitted');
    expect(f.query.mock.calls.filter(c => c[0].includes('wave4_load.bind_canonical'))).toHaveLength(2);
  });
  it('classifies a different HTTP attempt as replay of the original persisted delivery', async () => {
    const f = fake(), port = createWave4LoadProtectedCapture();
    await port.assertInvocationWithClient(f.client, invocation());
    await port.bindCanonicalWithClient(f.client, bind());
    f.persistDelivery();
    f.identity.transaction_id = '1001';
    const original = invocation();
    const q = { ...original, attempt: { ...original.attempt, attemptId: APPROVAL } };
    await port.assertInvocationWithClient(f.client, q);
    await port.bindCanonicalWithClient(f.client, { ...bind(), attemptId: APPROVAL });
    expect(f.outcome(ATTEMPT)?.outcome).toBe('admitted');
    expect(f.outcome(APPROVAL)).toMatchObject({ outcome: 'replay', execution_id: EXECUTION, job_id: bind().jobId });
  });
  it('refuses replay without the original persisted delivery or with substituted canonical identity', async () => {
    for (const drift of [false, true]) {
      const f = fake(), port = createWave4LoadProtectedCapture();
      await port.assertInvocationWithClient(f.client, invocation());
      await port.bindCanonicalWithClient(f.client, bind());
      if (drift) f.persistDelivery();
      f.identity.transaction_id = '1001';
      const original = invocation();
      const q = { ...original, attempt: { ...original.attempt, attemptId: APPROVAL } };
      await port.assertInvocationWithClient(f.client, q);
      await expect(port.bindCanonicalWithClient(f.client, { ...bind(), attemptId: APPROVAL,
        ...(drift ? { executionId: SOURCE } : {}) })).rejects.toThrow(drift ? /original canonical/ : /persisted delivery/);
    }
  });
  it('shares the package-local contract without production imports from qualification source', () => {
    const source = readFileSync(new URL('../../../packages/db/src/wave4-load-capture-owned.ts', import.meta.url), 'utf8');
    const contract = readFileSync(new URL('../../../packages/db/src/wave4-load-contract.ts', import.meta.url), 'utf8');
    const facade = readFileSync(new URL('./load-durable-contract.ts', import.meta.url), 'utf8');
    expect(source).toContain("from './wave4-load-contract.js'");
    expect(source + contract).not.toMatch(/from\s+['"][^'"]*(?:tests|apps)\//);
    expect(facade).toContain('packages/db/src/wave4-load-contract.js');
    expect(facade).not.toContain('export function');
  });
  const outcomeDrift: [string, unknown][] = [['outcome','refused'],['reason','fake approval'],['attempt_id',USER],
    ['run_id',USER],['fixture_id',USER],['user_id',FIXTURE],['source_trade_id',null],['signal_id',SOURCE],
    ['execution_id',SOURCE],['job_id','regenerated-job'],['admitted_at','now']];
  it.each(outcomeDrift)('rejects malformed original/replay outcome %s', async (key, value) => {
    const f = fake(), port = createWave4LoadProtectedCapture();
    await port.assertInvocationWithClient(f.client, invocation()); f.outcomeMutation(o => { o[key] = value; });
    await expect(port.bindCanonicalWithClient(f.client, bind())).rejects.toThrow(/outcome mismatch/);
    await expect(port.bindCanonicalWithClient(f.client, bind())).rejects.toThrow(/same-client/);
  });
  it('worker requires exact direct swat_app, user and execution scope on every call', async () => {
    const f = fake('worker'); f.identity.user_scope = FIXTURE;
    await expect(createWave4LoadProtectedCapture().assertInvocationWithClient(f.client, invocation('worker'))).rejects.toThrow(/worker/);
    const missing = fake('worker'); missing.identity.execution_scope = '';
    await expect(createWave4LoadProtectedCapture().assertInvocationWithClient(missing.client, invocation('worker'))).rejects.toThrow();
  });
});

describe('FROZEN least-privilege provisioning inventory (unrun)', () => {
  it('refuses every installation attempt without touching the supplied DBA client', async () => {
    const f = fake();
    await expect(provisionWave4LoadCaptureWithClient(f.client)).rejects.toThrow(/FROZEN provisioning refused/);
    expect(f.query).not.toHaveBeenCalled();
    expect(WAVE4_LOAD_PROVISIONING_STATUS.installable).toBe(false);
    expect(WAVE4_LOAD_DISABLED_ROLES).toEqual(['swat_load_capture_owner','swat_load_http_writer','swat_load_observer']);
    expect(WAVE4_LOAD_CAPTURE_STATUS.sourceComplete).toBe(false);
    expect(WAVE4_LOAD_CAPTURE_STATUS.runtimeAccepted).toBe(false);
  });
  it('records all fifteen exact real signatures and exactly eleven distinct-owner transfers', () => {
    expect(WAVE4_LOAD_FUNCTION_SIGNATURES).toHaveLength(15);
    expect(new Set(WAVE4_LOAD_FUNCTION_SIGNATURES).size).toBe(15);
    expect(WAVE4_LOAD_OWNER_TRANSFERS).toHaveLength(11);
    expect(WAVE4_LOAD_FUNCTION_SIGNATURES).toContain('wave4_load.http_admit(bytea,jsonb)');
    expect(WAVE4_LOAD_FUNCTION_SIGNATURES).toContain('wave4_load.http_finish(uuid,integer,text)');
    expect(WAVE4_LOAD_ROUTINES.find(r => r.signature === 'wave4_load.validate_canonical(uuid,uuid,boolean)')?.callers).toEqual(['swat_fanout']);
    expect(WAVE4_LOAD_ROUTINES.filter(r => r.signature.includes('visible_')).every(r => r.callers.length === 0)).toBe(true);
    expect(WAVE4_LOAD_OWNER_TRANSFERS.some(s => s.includes('guard_') || s.includes('check_canonical_commit'))).toBe(false);
  });
  it('pins eight actual capture relations, all eighteen FK shapes and the deferred signal/job delivery key', () => {
    expect(WAVE4_LOAD_CAPTURE_RELATIONS.map(r => r.name)).toEqual(['wave4_load.runs','wave4_load.fixtures','wave4_load.approvals',
      'wave4_load.requests','wave4_load.responses','wave4_load.stage_claims','wave4_load.canonical','wave4_load.outcomes']);
    expect(WAVE4_LOAD_CAPTURE_RELATIONS.every(r => r.forceRls && r.owner === 'swat_migrator'
      && r.runtimeTablePrivileges.length === 0 && r.runtimeColumnPrivileges.length === 0 && !r.ownerDelete)).toBe(true);
    expect(WAVE4_LOAD_FOREIGN_KEYS).toHaveLength(18);
    const delivery = WAVE4_LOAD_FOREIGN_KEYS.filter(k => k.to === 'public.source_fanout_deliveries');
    expect(delivery).toEqual([expect.objectContaining({ columns: ['signal_id','job_id'], referenced: ['signal_id','job_id'],
      deferrable: true, initiallyDeferred: true, onDelete: 'RESTRICT' })]);
    expect(WAVE4_LOAD_DEFERRED_COMMIT.invoker).toBe('wave4_load.check_canonical_commit()');
    expect(WAVE4_LOAD_DEFERRED_COMMIT.sameXidRows).toEqual(['execution','delivery','policy']);
    expect(WAVE4_LOAD_DEFERRED_COMMIT.immediateValidation).toBe(false);
  });
  it('never grants runtime/observer secret reads or public-economics DML and records invoker-view dependencies', () => {
    expect(WAVE4_LOAD_OWNER_READ_INVENTORY.every(r => r.role === 'swat_load_capture_owner'
      && r.privilege === 'SELECT' && !r.grantOption && !r.installed)).toBe(true);
    const names = WAVE4_LOAD_OWNER_READ_INVENTORY.map(r => r.relation);
    expect(names).toContain('public.user_sessions'); expect(names).toContain('public.source_position_applications');
    expect(names).toContain('public.worker_effective_execution_evidence'); expect(names).toContain('public.copy_execution_evidence');
    expect(names).toContain('public.copy_execution_valuation_corrections');
    expect(WAVE4_LOAD_CAPTURE_BLOCKERS.join(' ')).toMatch(/lock-only|FOR UPDATE/);
    expect(WAVE4_LOAD_PROVISIONING_BLOCKERS.join(' ')).toMatch(/incoming-FK/);
    expect(WAVE4_LOAD_PROVISIONING_BLOCKERS.join(' ')).toMatch(/unfinished|outcome-less/);
  });
  it('aligns textual frozen SQL090 declaration/deferred ordering and remains import-inert', () => {
    const sql = readFileSync(new URL('../../../packages/db/sql/090_wave4_protected_load_capture.sql', import.meta.url), 'utf8');
    const owned = readFileSync(new URL('../../../packages/db/src/wave4-load-capture-owned.ts', import.meta.url), 'utf8');
    const provisioning = readFileSync(new URL('../../../deploy/postgres/wave4-load-provisioning.ts', import.meta.url), 'utf8');
    expect(sql).toContain('CREATE FUNCTION wave4_load.assert_invocation(payload jsonb) RETURNS jsonb');
    expect(sql).toContain('CREATE FUNCTION wave4_load.bind_canonical(payload jsonb) RETURNS jsonb');
    expect(sql).toContain('FOREIGN KEY(signal_id,job_id) REFERENCES public.source_fanout_deliveries(signal_id,job_id)');
    expect(sql).toContain('ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('PERFORM wave4_load.validate_canonical(NEW.run_id,NEW.fixture_id,true)');
    expect(sql).toContain('source_trade_id=source.id');
    expect(sql).toContain('original correlation must commit with obligation');
    const ownedCode = owned.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(ownedCode).not.toMatch(/new Pool|createPool|process\.env|fetch\(|from ['"](?:@swat\/db|\.\/index\.js)['"]/);
    expect(ownedCode).not.toMatch(/INSERT INTO|SET CONSTRAINTS|client\.query\(['"](?:BEGIN|COMMIT|SET ROLE)/);
    expect(owned).toContain('pg_catalog.pg_stat_activity');
    expect(owned).not.toContain('pg_control_system()');
    expect(provisioning).not.toMatch(/client\.query\(|CREATE ROLE |GRANT SELECT |GRANT UPDATE |SET ROLE /);
  });
});
