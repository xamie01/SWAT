import type { PoolClient } from 'pg';
import { captureLoadFixture, loadCheck, loadEqual, loadJson, loadScope, loadText, loadTime, loadUuid,
  type LoadProtectedCapturePort } from './wave4-load-contract.js';

/** Local source only. No pool, lease factory, boot import, enrollment, HTTP writer,
 * role callback, installation or transaction ownership is supplied by this leaf.
 * Every successful call is PROVISIONAL: the external owner must await COMMIT,
 * including SQL090's deferred delivery FK and original-xid constraint trigger. */
export const WAVE4_LOAD_CAPTURE_STATUS = Object.freeze({ frozen: true, sourceImplemented: true,
  sourceComplete: false, reviewed: false, installed: false, qualified: false,
  runtimeAccepted: false, liveCapabilityAccepted: false, productionReady: false } as const);
export const WAVE4_LOAD_CAPTURE_BLOCKERS = Object.freeze([
  'SQL090 is frozen, unreviewed, unselected and unapplied; exact independent body, ACL, policy and touching-FK closure is not established.',
  'Authenticated public wallet/token routes do not call SQL090 http_admit(bytea,jsonb) and http_finish(uuid,integer,text) on a separately approved HTTP writer; no response DTO or principal callback substitutes for persisted SQL040 session authentication.',
  'SQL090 http_admit locks public.users and public.user_sessions FOR UPDATE: SELECT alone is insufficient and safe owner-specific lock-only UPDATE/immutable-guard closure is not established. No broad UPDATE or credential SELECT is granted to runtime callers.',
  'SQL090 check_canonical_commit() is SECURITY INVOKER and calls validate_canonical(uuid,uuid,boolean) at deferred COMMIT under swat_fanout; its exact EXECUTE edge must be independently reviewed, not silently omitted or widened to PUBLIC.',
  'SQL088 current provider/backend/follower enrollment and revocation-lock/expiry closure remain unfinished; SQL090 comparisons cannot repair the frozen backing or authorize a provider callback.',
  'SQL090 canonical replay requires the original persisted SQL071 delivery; original creation requires execution, policy and delivery xmin to match admission_xid. Preexisting uncorrelated executions cannot be relabeled as original admission.',
  'SQL090 validates provider/sizing/valuation using separate reads without complete lock and post-wait freshness closure; same-client checks here are not a concurrency proof or repair of frozen SQL.',
  'Owner-specific exact tenant/asset RLS, invoker-view underlying ACLs and orphan/additional-economics visibility are not installed or independently proved; observer remains disabled without broad SELECT or pg_read_all_stats.',
  'Public import-safe token consumer, wallet ambient-root containment, canonical worker activation, SQL089 settlement integration, exact migration/catalog integration and independent observer lifecycle remain reserved source seams.'
] as const);

type Invocation = Parameters<LoadProtectedCapturePort['assertInvocationWithClient']>[1];
type CanonicalBind = Parameters<LoadProtectedCapturePort['bindCanonicalWithClient']>[1];
type Stage = Invocation['stage'];
const roles: Readonly<Record<Stage, string>> = Object.freeze({ source: 'swat_source_provider_writer',
  fanout: 'swat_fanout', worker: 'swat_app' });
interface DirectIdentity {
  current_role: string; session_role: string; role_setting: string; row_security: string; bypass: string;
  user_scope: string; execution_scope: string; read_only: string; isolation: string;
  backend_pid: number; backend_start: string; transaction_id: string; explicit_transaction: boolean;
  database_oid: string; database_name: string; server_address: string; server_port: number;
  backend_identity: string; safe_role: boolean;
}

/** Only the backend's OWN pg_stat_activity row is read (no foreign-role stats
 * visibility, pid label or pg_read_all_stats). xact_start < query_start rejects
 * an implicit/autocommit SELECT; the xid is compared across every awaited call.
 * An unavailable self-observation seam is a refusal, never a callback fallback. */
const directIdentitySql = `SELECT current_user AS current_role,session_user AS session_role,
  current_setting('role') AS role_setting,current_setting('row_security') AS row_security,
  COALESCE(current_setting('app.bypass_rls',true),'off') AS bypass,
  COALESCE(current_setting('app.current_user_id',true),'') AS user_scope,
  COALESCE(current_setting('app.worker_execution_id',true),'') AS execution_scope,
  current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,
  pg_backend_pid() AS backend_pid,a.backend_start::text AS backend_start,
  pg_current_xact_id()::text AS transaction_id,
  (a.xact_start IS NOT NULL AND a.xact_start<a.query_start) AS explicit_transaction,
  db.oid::text AS database_oid,current_database() AS database_name,
  COALESCE(inet_server_addr()::text,'unix') AS server_address,COALESCE(inet_server_port(),0) AS server_port,
  concat(current_database(),'|',COALESCE(inet_server_addr()::text,'unix'),'|',COALESCE(inet_server_port(),0),'|',session_user) AS backend_identity,
  (r.rolcanlogin AND NOT(r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)
   AND NOT has_database_privilege(r.oid,current_database(),'CREATE')
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE has_schema_privilege(r.oid,n.oid,'CREATE'))
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE d.datdba=r.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=r.oid)) AS safe_role
  FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database db ON db.datname=current_database()
  JOIN pg_catalog.pg_stat_activity a ON a.pid=pg_backend_pid() AND a.datid=db.oid
  WHERE r.rolname=current_user`;

function mandatory(client: PoolClient): void {
  loadCheck(client && typeof client.query === 'function', '090 mandatory already-owned client required');
}
function keys(value: unknown, expected: readonly string[], reason: string): void {
  loadCheck(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, reason);
  loadEqual(Object.keys(value).sort(), [...expected].sort(), reason);
}
function snapshot<T>(input: T): T {
  let nodes = 0;
  function inert(value: unknown, depth: number): void {
    loadCheck(++nodes <= 10000 && depth <= 32, '090 bounded inert payload required');
    if (!value || typeof value !== 'object') return;
    loadCheck(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype,
      '090 prototype authority refused');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    loadCheck(Object.getOwnPropertySymbols(value).length === 0, '090 symbol authority refused');
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      loadCheck(descriptor.enumerable === true && !descriptor.get && !descriptor.set,
        '090 accessor/hidden authority refused');
      inert(descriptor.value, depth + 1);
    }
  }
  inert(input, 0);
  const bytes = loadJson(input);
  loadCheck(bytes.length <= 262144, '090 capture payload overflow');
  return JSON.parse(bytes) as T;
}
function captureInvocation(input: Invocation): Invocation {
  // Reject accessors/hidden authority before serialization; snapshot BEFORE await.
  const q = snapshot(input);
  keys(q, ['scope','fixture','attempt','principal','stage'], '090 exact invocation keys required');
  loadCheck(q.stage === 'source' || q.stage === 'fanout' || q.stage === 'worker', '090 stage refused');
  keys(q.scope, ['runId','namespace','network','backendIdentity'], '090 exact scope keys required');
  keys(q.fixture, ['scope','fixtureId','userId','kind','walletAddress','tokenMint','targetAccount','binding','base','quoteBudget','quote','fee','requestDigest'],
    '090 exact fixture keys required');
  keys(q.fixture.scope, ['runId','namespace','network','backendIdentity'], '090 exact fixture scope required');
  keys(q.fixture.binding, ['chain','network','sourceEventType','sourceEventId','sourceEventIndex','transactionHash','walletAddress',
    'tokenMint','side','rawQuantity','quantityScale','eventAt','amountUsd','priceUsd','feeUsd'], '090 exact source binding required');
  for (const amount of [q.fixture.base,q.fixture.quoteBudget,q.fixture.quote,q.fixture.fee])
    keys(amount, ['raw','scale'], '090 exact raw amount required');
  const scope = loadScope(q.scope), fixture = captureLoadFixture(q.fixture), attempt = q.attempt;
  loadEqual(fixture.scope, scope, '090 fixture/scope mismatch');
  keys(attempt, ['attemptId','fixtureId','runId','namespace','userId','requestDigest','route','status','startedAt','finishedAt'],
    '090 exact HTTP attempt keys required');
  keys(q.principal, ['kind','userId'], '090 exact user principal required');
  loadUuid(attempt.attemptId); loadTime(attempt.startedAt); loadTime(attempt.finishedAt);
  loadCheck(Date.parse(attempt.startedAt) <= Date.parse(attempt.finishedAt), '090 HTTP chronology refused');
  loadCheck(attempt.fixtureId === fixture.fixtureId && attempt.runId === scope.runId && attempt.namespace === scope.namespace
    && attempt.userId === fixture.userId && attempt.requestDigest === fixture.requestDigest
    && attempt.route === (fixture.kind === 'wallet' ? '/v1/me/wallets' : '/v1/me/tokens/backfill')
    && (attempt.status === 200 || attempt.status === 201), '090 HTTP request binding mismatch');
  loadCheck(q.principal.kind === 'user' && q.principal.userId === fixture.userId, '090 principal mismatch');
  return { scope, fixture, attempt, principal: q.principal, stage: q.stage };
}
function captureBind(input: CanonicalBind): CanonicalBind {
  const q = snapshot(input);
  keys(q, ['scope','fixtureId','attemptId','userId','sourceTradeId','signalId','executionId','jobId'], '090 exact canonical bind keys required');
  keys(q.scope, ['runId','namespace','network','backendIdentity'], '090 exact canonical scope keys required');
  const scope = loadScope(q.scope);
  for (const id of [q.fixtureId,q.attemptId,q.userId,q.sourceTradeId,q.signalId,q.executionId]) loadUuid(id);
  loadText(q.jobId, 256);
  loadCheck(q.jobId === `source-trade-${q.signalId}-u-${q.userId}`, '090 canonical job identity mismatch');
  return { ...q, scope };
}
function sameTransaction(before: DirectIdentity, after: DirectIdentity): void {
  for (const key of ['backend_pid','backend_start','transaction_id','database_oid','database_name','server_address',
    'server_port','backend_identity','current_role','session_role','user_scope','execution_scope','isolation'] as const)
    loadCheck(before[key] === after[key], '090 same primary backend/transaction required');
}
async function direct(client: PoolClient, q: Invocation): Promise<DirectIdentity> {
  mandatory(client);
  const { rows } = await client.query<DirectIdentity>(directIdentitySql);
  loadCheck(rows.length === 1 && rows[0], '090 direct backend self-observation unavailable');
  const r = rows[0];
  loadCheck(r.current_role === roles[q.stage] && r.session_role === roles[q.stage]
    && r.role_setting === 'none' && r.row_security === 'on' && r.bypass === 'off' && r.safe_role === true
    && r.read_only === 'off' && r.explicit_transaction === true && r.isolation === 'read committed'
    && Number.isSafeInteger(r.backend_pid) && r.backend_pid > 0
    && typeof r.backend_start === 'string' && r.backend_start.length > 0
    && typeof r.transaction_id === 'string' && /^[1-9][0-9]*$/.test(r.transaction_id)
    && typeof r.database_oid === 'string' && /^[1-9][0-9]*$/.test(r.database_oid)
    && typeof r.database_name === 'string' && r.database_name.length > 0
    && typeof r.server_address === 'string' && r.server_address.length > 0
    && Number.isSafeInteger(r.server_port) && r.server_port >= 0 && r.server_port <= 65535
    && r.backend_identity === `${r.database_name}|${r.server_address}|${r.server_port}|${r.session_role}`,
  '090 direct restricted explicit READ COMMITTED writer required');
  if (q.stage === 'worker') {
    loadUuid(r.execution_scope);
    loadCheck(r.user_scope === q.fixture.userId && r.backend_identity === q.scope.backendIdentity,
      '090 worker tenant/backend scope mismatch');
  } else loadCheck(r.user_scope === '' && r.execution_scope === '', '090 nonworker tenant/worker GUC refused');
  return r;
}
function approval(reply: Record<string, unknown>, q: Invocation, identity: DirectIdentity): void {
  loadEqual(reply.scope, q.scope, '090 persisted reply scope mismatch');
  loadCheck(reply.fixtureId === q.fixture.fixtureId && reply.attemptId === q.attempt.attemptId
    && reply.userId === q.fixture.userId && reply.stage === q.stage, '090 persisted invocation reply mismatch');
  const a = reply.approval as Record<string, unknown>;
  loadCheck(a && typeof a === 'object', '090 persisted approval absent');
  loadUuid(a.approval_id);
  loadCheck(a.run_id === q.scope.runId && a.fixture_id === q.fixture.fixtureId && a.stage === q.stage
    && a.runtime_role === identity.session_role && String(a.database_oid) === identity.database_oid
    && a.server_address === identity.server_address && a.server_port === identity.server_port
    && a.backend_identity === identity.backend_identity && a.revoked_at === null,
  '090 exact persisted stage/backend approval mismatch');
  loadText(a.revision, 128);
  // PostgreSQL, not local wall clock or these comparison objects, authorizes
  // current run, HTTP/session, backend, provider, sizing and worker capability.
}
async function assertCaptured(client: PoolClient, q: Invocation, identity: DirectIdentity): Promise<void> {
  const { rows } = await client.query<{ invocation: Record<string, unknown> }>(
    'SELECT wave4_load.assert_invocation($1::jsonb) AS invocation', [loadJson(q)]);
  loadCheck(rows.length === 1 && rows[0]?.invocation, '090 persisted invocation unavailable');
  approval(rows[0].invocation, q, identity);
  sameTransaction(identity, await direct(client, q));
}

/** Implements the existing mandatory-client LoadProtectedCapturePort exactly.
 * The WeakMap holds inert correlation snapshots ONLY; it is not an authority or
 * role registry. bind reauthorizes with SQL090 on the SAME client and xid. No
 * direct INSERT, pre-delivery lookup, SET CONSTRAINTS, BEGIN, COMMIT or retry is
 * performed: canonicalPrepare intentionally binds BEFORE delivery insertion. */
export function createWave4LoadProtectedCapture(): LoadProtectedCapturePort {
  const correlations = new WeakMap<PoolClient, { q: Invocation; identity: DirectIdentity }>();
  return Object.freeze({
    async assertInvocationWithClient(client: PoolClient, input: Invocation): Promise<void> {
      mandatory(client); correlations.delete(client);
      const q = captureInvocation(input), identity = await direct(client, q);
      await assertCaptured(client, q, identity);
      correlations.set(client, { q, identity });
    },
    async bindCanonicalWithClient(client: PoolClient, input: CanonicalBind): Promise<void> {
      mandatory(client);
      const q = captureBind(input), saved = correlations.get(client);
      loadCheck(saved && saved.q.stage === 'fanout', '090 same-client fanout invocation required');
      loadEqual(q.scope, saved.q.scope, '090 canonical scope changed');
      loadCheck(q.fixtureId === saved.q.fixture.fixtureId && q.attemptId === saved.q.attempt.attemptId
        && q.userId === saved.q.fixture.userId, '090 canonical persisted request correlation changed');
      // Delete before database work; any awaited authorization/bind failure
      // leaves no cache that could let a later transaction proceed.
      correlations.delete(client);
      sameTransaction(saved.identity, await direct(client, saved.q));
      await assertCaptured(client, saved.q, saved.identity);
      const { rows } = await client.query<{ outcome: Record<string, unknown> }>(
        'SELECT wave4_load.bind_canonical($1::jsonb) AS outcome', [loadJson(q)]);
      loadCheck(rows.length === 1 && rows[0]?.outcome, '090 persisted canonical outcome unavailable');
      const o = rows[0].outcome;
      loadCheck(o.attempt_id === q.attemptId && o.run_id === q.scope.runId && o.fixture_id === q.fixtureId
        && o.user_id === q.userId && (o.outcome === 'admitted' || o.outcome === 'replay') && o.reason === null
        && o.source_trade_id === q.sourceTradeId && o.signal_id === q.signalId && o.execution_id === q.executionId
        && o.job_id === q.jobId && typeof o.admitted_at === 'string' && Number.isFinite(Date.parse(o.admitted_at)),
      '090 immutable original/replay outcome mismatch');
      sameTransaction(saved.identity, await direct(client, saved.q));
      // Same-client repeated bind (including original replay) remains idempotent
      // only through SQL090's immutable canonical/outcome checks, never this cache.
      correlations.set(client, saved);
    }
  });
}
