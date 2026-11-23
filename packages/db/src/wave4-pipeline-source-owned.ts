import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import { prepareRecordSourceTradeEvent, prepareInsertSourceTradeSignal,
  prepareListSourceTradeSignalCandidates, verifySourceTradeWithClient,
  type SourceTradeEventInput } from './copy-trade-lifecycle-owned.js';
import { canonicalSourceBinding, canonicalSourceEvidence, sourceBindingDigest, sourceEvidenceDigest,
  type SourceVerificationEvidence, type TrustedSourceVerifier, type ValidatedSourceProvider } from './source-verification.js';

export type { PoolClient } from 'pg';
export type PipelineProtectedPurpose = 'source-register' | 'source-intake' | 'source-verify' | 'fanout'
  | 'worker-register' | 'risk-write' | 'valuation-register' | 'valuation-write' | 'paper-valuation' | 'paper-receipt';
export type PipelineProtectedRole = 'swat_source_provider_writer' | 'swat_fanout' | 'swat_capability_writer'
  | 'swat_risk_writer' | 'swat_valuation_writer' | 'swat_worker_receipt_writer';
const PURPOSE_ROLES: Readonly<Record<PipelineProtectedPurpose,PipelineProtectedRole>> = Object.freeze({
  'source-register': 'swat_source_provider_writer','source-intake': 'swat_source_provider_writer',
  'source-verify': 'swat_source_provider_writer',fanout: 'swat_fanout','worker-register': 'swat_capability_writer',
  'risk-write': 'swat_risk_writer','valuation-register': 'swat_valuation_writer','valuation-write': 'swat_valuation_writer',
  'paper-valuation': 'swat_valuation_writer','paper-receipt': 'swat_worker_receipt_writer'
});
function requirePurposeSelector(purpose: PipelineProtectedPurpose, selector: string): void {
  pipelineRequire(Object.hasOwn(PURPOSE_ROLES,purpose) && (purpose === 'fanout' ? selector === '' : pipelineText(selector)),
    'invalid protected selector');
  if (['worker-register','risk-write','paper-valuation','paper-receipt'].includes(purpose)) pipelineUuid(selector);
}
export type PipelineProtectedTransaction = <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T>;
export interface PipelineClientLease { readonly client: PoolClient; release(broken: boolean): void }

export const PIPELINE_IDENTITY_SQL = `SELECT current_user::text AS runtime_role, session_user::text AS session_role,
  current_setting('role') AS role_setting, current_setting('row_security') AS row_security,
  current_setting('search_path') AS search_path, r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolinherit,
  r.rolcreaterole, r.rolcreatedb, r.rolreplication,
  EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS memberships,
  (EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid)
   OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid)
   OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proowner=r.oid)
   OR EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datdba=r.oid)) AS owns_objects,
  (has_database_privilege(r.oid,current_database(),'CREATE') OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace WHERE has_schema_privilege(r.oid,oid,'CREATE'))) AS can_create,
  pg_backend_pid() AS backend_pid, (SELECT oid::text FROM pg_catalog.pg_database
    WHERE datname=current_database()) AS database_oid,
  COALESCE(inet_server_addr()::text,'unix') AS server_address, COALESCE(inet_server_port(),0) AS server_port,
  concat(current_database(),'|',COALESCE(inet_server_addr()::text,'unix'),'|',COALESCE(inet_server_port(),0),'|',session_user) AS backend_identity,
  statement_timestamp() AS observed_at,
  (SELECT xact_start=query_start FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid()) AS transaction_clean
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`;
const RESET_SESSION = `SELECT set_config('app.current_user_id','',false),
  set_config('app.worker_execution_id','',false),set_config('app.bypass_rls','off',false)`;
const RESET_LOCAL = `SELECT set_config('app.current_user_id','',true),
  set_config('app.worker_execution_id','',true),set_config('app.bypass_rls','off',true),
  set_config('statement_timeout','15000',true),set_config('lock_timeout','5000',true),
  set_config('idle_in_transaction_session_timeout','30000',true)`;

export function pipelineRequire(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Protected pipeline: ${reason}`);
}
export function pipelineText(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f]/.test(value);
}
export function pipelineTime(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
export function pipelineUuid(value: unknown): asserts value is string {
  pipelineRequire(typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value), 'canonical UUID required');
}

/** No dynamic SQL identifiers. These TWO fixed routines are schema/provisioning
 * requirements, not claims that a migration already defines them. The catalog
 * gate runs before invocation; missing protected backing remains a SOURCE gap.
 * Existing SQL079's isolated NOLOGIN lookup owner is reused, never a new broker. */
export const PIPELINE_BACKEND_ROUTINE_SQL = `SELECT p.prosecdef, p.proconfig, owner.rolname AS owner_role,
  owner.rolcanlogin, owner.rolsuper, owner.rolbypassrls, owner.rolinherit,
  owner.rolcreaterole, owner.rolcreatedb, owner.rolreplication,
  EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=owner.oid OR roleid=owner.oid) AS memberships,
  has_function_privilege(current_user,p.oid,'EXECUTE') AS executable,
  EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
    WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner
  WHERE p.oid=to_regprocedure('public.swat_pipeline_backend_capability(text,text)')`;
export const PIPELINE_FOLLOWER_ROUTINE_SQL = PIPELINE_BACKEND_ROUTINE_SQL.replace(
  "public.swat_pipeline_backend_capability(text,text)",
  "public.swat_pipeline_exact_follower_balance(uuid,text,text,text,text)");
export async function requirePipelineProtectedRoutine(client: PoolClient, purpose: 'backend' | 'follower'): Promise<void> {
  const result = await client.query(purpose === 'backend' ? PIPELINE_BACKEND_ROUTINE_SQL : PIPELINE_FOLLOWER_ROUTINE_SQL);
  const r = result.rows[0];
  pipelineRequire(result.rows.length === 1 && r?.prosecdef === true && r.owner_role === 'swat_runtime_lookup'
    && Array.isArray(r.proconfig) && r.proconfig.length === 1 && r.proconfig[0] === 'search_path=pg_catalog'
    && r.executable === true && r.public_execute === false
    && ['rolcanlogin','rolsuper','rolbypassrls','rolinherit','rolcreaterole','rolcreatedb','rolreplication','memberships']
      .every(k => r[k] === false), `${purpose} protected schema/approved lookup unavailable`);
}
export interface PipelineBackendApproval {
  readonly capabilityId: string; readonly revision: string; readonly backendIdentity: string;
  readonly databaseOid: string; readonly serverAddress: string; readonly serverPort: number;
  readonly runtimeRole: PipelineProtectedRole; readonly terms: unknown;
  readonly expiresAt: Date; readonly provider: ValidatedSourceProvider | null;
}
function captureApprovedTerms(value: unknown): unknown {
  pipelineRequire(value !== undefined,'protected approved terms missing');
  const captured = JSON.parse(JSON.stringify(value)) as unknown;
  function freeze(input: unknown): void {
    if (input && typeof input === 'object') {
      Object.values(input).forEach(freeze); Object.freeze(input);
    }
  }
  freeze(captured); return captured;
}
async function identity(client: PoolClient, role: PipelineProtectedRole, clean = false) {
  const result = await client.query(PIPELINE_IDENTITY_SQL), r = result.rows[0];
  pipelineRequire(result.rows.length === 1 && r.runtime_role === role && r.session_role === role
    && r.role_setting === 'none' && r.row_security === 'on'
    && ['pg_catalog, public','pg_catalog,public'].includes(r.search_path)
    && r.rolcanlogin === true && (!clean || r.transaction_clean === true)
    && ['rolsuper','rolbypassrls','rolinherit','rolcreaterole','rolcreatedb','rolreplication','memberships','owns_objects','can_create']
      .every(k => r[k] === false)
    && Number.isInteger(r.backend_pid) && r.backend_pid > 0 && pipelineTime(r.observed_at)
    && typeof r.database_oid === 'string' && /^[1-9]\d*$/.test(r.database_oid)
    && pipelineText(r.server_address) && Number.isInteger(r.server_port) && r.server_port >= 0
    && pipelineText(r.backend_identity,512), 'exact direct session identity/backend required');
  return r;
}
function providerTerms(input: ValidatedSourceProvider): ValidatedSourceProvider {
  pipelineRequire(input && pipelineText(input.providerId) && pipelineText(input.authorityId)
    && ['solana','polygon','robinhood-chain'].includes(input.chain) && pipelineText(input.network,128)
    && pipelineText(input.verifierVersion) && typeof input.identityDigest === 'string'
    && /^[0-9a-f]{64}$/.test(input.identityDigest) && typeof input.validUntil === 'string'
    && Number.isFinite(Date.parse(input.validUntil)) && new Date(input.validUntil).toISOString() === input.validUntil,
  'invalid approved provider terms');
  return Object.freeze({ providerId: input.providerId, authorityId: input.authorityId, chain: input.chain,
    network: input.network, verifierVersion: input.verifierVersion, identityDigest: input.identityDigest, validUntil: input.validUntil });
}
export async function readPipelineBackendApproval(client: PoolClient, purpose: PipelineProtectedPurpose,
  authorityId: string, expectedBackend?: number): Promise<PipelineBackendApproval> {
  requirePurposeSelector(purpose,authorityId);
  const r = await identity(client,PURPOSE_ROLES[purpose]);
  pipelineRequire(expectedBackend === undefined || r.backend_pid === expectedBackend, 'direct backend drift');
  await requirePipelineProtectedRoutine(client,'backend');
  const result = await client.query('SELECT * FROM public.swat_pipeline_backend_capability($1::text,$2::text)', [purpose,authorityId]);
  const a = result.rows[0];
  pipelineRequire(result.rows.length === 1 && a && a.purpose === purpose && a.authority_id === authorityId
    && a.runtime_role === r.runtime_role && String(a.database_oid) === r.database_oid
    && a.server_address === r.server_address && a.server_port === r.server_port
    && a.backend_identity === r.backend_identity && a.revoked_at === null
    && pipelineTime(a.valid_from) && pipelineTime(a.expires_at) && a.valid_from <= r.observed_at
    && a.expires_at > r.observed_at && pipelineText(a.revision,128), 'approved persisted backend capability unavailable');
  pipelineUuid(a.capability_id);
  const provider = purpose.startsWith('source-') ? providerTerms({ providerId: a.provider_id, authorityId: a.authority_id,
    chain: a.chain, network: a.network, verifierVersion: a.verifier_version, identityDigest: a.identity_digest,
    validUntil: pipelineTime(a.provider_valid_until) ? a.provider_valid_until.toISOString() : '' }) : null;
  pipelineRequire(!provider || Date.parse(provider.validUntil) > r.observed_at.getTime(), 'approved provider expired');
  const terms = captureApprovedTerms(a.approved_terms);
  if (!purpose.startsWith('source-') && purpose !== 'fanout') {
    pipelineRequire(terms !== null && typeof terms === 'object' && !Array.isArray(terms),
      'protected writer complete approved terms required');
  }
  return Object.freeze({ capabilityId: a.capability_id, revision: a.revision, backendIdentity: a.backend_identity,
    databaseOid: r.database_oid,serverAddress: r.server_address,serverPort: r.server_port,runtimeRole: PURPOSE_ROLES[purpose],terms,
    expiresAt: new Date(a.expires_at), provider });
}

export class PipelineCommitUncertainError extends Error {
  constructor(readonly purpose: PipelineProtectedPurpose, options?: ErrorOptions) {
    super('Protected pipeline COMMIT uncertain; retain durable source/fanout obligation and recover by immutable identity',options);
    this.name = 'PipelineCommitUncertainError';
  }
}
/** Physical lease supplied by approved host. No pools/env/SET ROLE/tenant flags.
 * Every transaction rereads persisted backend approval; before-COMMIT reread
 * detects revocation, expiry and backend drift. No result precedes checked COMMIT.
 * A rejected or escaped lease is destroyed. Never assert rollback after COMMIT. */
const checkedPipelineContext = new AsyncLocalStorage<{ poisoned: boolean }>();
const checkedPipelineClients = new WeakSet<object>();
export function createCheckedPipelineTransaction(input: {
  acquire: () => Promise<PipelineClientLease>; purpose: PipelineProtectedPurpose; authorityId: string;
}): PipelineProtectedTransaction {
  pipelineRequire(typeof input.acquire === 'function','owned lease required');
  requirePurposeSelector(input.purpose,input.authorityId);
  const { acquire,purpose,authorityId } = input;
  const context = checkedPipelineContext, clients = checkedPipelineClients;
  return async operation => {
    const parent = context.getStore();
    if (parent) { parent.poisoned = true; throw new Error('Nested protected pipeline transaction refused'); }
    pipelineRequire(typeof operation === 'function','operation required');
    const lease = await acquire();
    pipelineRequire(lease?.client && typeof lease.release === 'function','owned physical lease required');
    if (clients.has(lease.client)) throw new Error('Reused protected pipeline lease refused');
    clients.add(lease.client);
    const lifetime = { poisoned: false };
    let open = false, live = false, committing = false, broken = false, pending: Promise<unknown> | null = null;
    const client = { query: async (sql: string, values?: unknown[]) => {
      if (!live || pending || typeof sql !== 'string' || /;|\/\*|^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET|DO|CALL)\b/i.test(sql)
        || /\bset_config\s*\(/i.test(sql)) {
        lifetime.poisoned = true; throw new Error('Uncontrolled/overlapping or expired protected pipeline query refused');
      }
      const query = lease.client.query(sql,values); pending = query;
      try { return await query; } catch (error) { lifetime.poisoned = true; throw error; }
      finally { if (pending === query) pending = null; }
    } } as PoolClient;
    try {
      const initial = await identity(lease.client,PURPOSE_ROLES[purpose],true);
      await lease.client.query(RESET_SESSION);
      const begin = await lease.client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      pipelineRequire(begin.command === 'BEGIN','BEGIN refused'); open = true;
      await lease.client.query(RESET_LOCAL);
      const approval = await readPipelineBackendApproval(lease.client,purpose,authorityId,initial.backend_pid);
      live = true;
      const result = await context.run(lifetime,() => operation(client)); live = false;
      pipelineRequire(!pending && !lifetime.poisoned,'query lifetime escaped operation');
      const final = await readPipelineBackendApproval(lease.client,purpose,authorityId,initial.backend_pid);
      pipelineRequire(JSON.stringify(final) === JSON.stringify(approval),'backend/provider capability drift before COMMIT');
      await lease.client.query(RESET_LOCAL);
      pipelineRequire(!pending && !lifetime.poisoned,'query lifetime escaped operation');
      committing = true;
      const commit = await lease.client.query('COMMIT');
      if (commit.command !== 'COMMIT' || pending || lifetime.poisoned) throw new PipelineCommitUncertainError(purpose);
      open = false; committing = false; return result;
    } catch (error) {
      live = false; broken = true;
      if (pending) { try { await pending; } catch { /* settle before destroying physical lease */ } }
      if (committing) throw new PipelineCommitUncertainError(purpose,{ cause: error });
      if (open) { try { const rollback = await lease.client.query('ROLLBACK'); if (rollback.command === 'ROLLBACK') open = false; }
        catch { /* do not claim rollback */ } }
      throw error;
    } finally { clients.delete(lease.client); lease.release(broken || open || lifetime.poisoned); }
  };
}

/** Concrete canonical SQL077 authority writer. Candidate/adapter identity is
 * compared to independent protected approval, NOT used to self-approve a row.
 * Same authority cannot be reenabled/extended; collision and revocation refuse. */
export async function registerPipelineSourceProviderWithClient(client: PoolClient, candidate: ValidatedSourceProvider) {
  const provider = providerTerms(candidate);
  const approved = await readPipelineBackendApproval(client,'source-register',provider.authorityId);
  pipelineRequire(JSON.stringify(approved.provider) === JSON.stringify(provider),'provider differs from independently approved registration');
  await client.query(`INSERT INTO public.source_provider_authorities
    (authority_id,provider_id,chain,network,verifier_version,identity_digest,valid_until,enabled)
    VALUES ($1,$2,$3,$4,$5,$6,$7,true) ON CONFLICT (authority_id) DO NOTHING`,
  [provider.authorityId,provider.providerId,provider.chain,provider.network,provider.verifierVersion,provider.identityDigest,provider.validUntil]);
  await requireRegisteredProvider(client,provider); return provider;
}
async function requireRegisteredProvider(client: PoolClient, provider: ValidatedSourceProvider): Promise<void> {
  const result = await client.query(`SELECT authority_id,provider_id,chain,network,verifier_version,identity_digest,valid_until,enabled
    FROM public.source_provider_authorities WHERE authority_id=$1 FOR SHARE`,[provider.authorityId]);
  const r = result.rows[0];
  pipelineRequire(result.rows.length === 1 && r.enabled === true && r.authority_id === provider.authorityId
    && r.provider_id === provider.providerId && r.chain === provider.chain && r.network === provider.network
    && r.verifier_version === provider.verifierVersion && r.identity_digest === provider.identityDigest
    && pipelineTime(r.valid_until) && r.valid_until.toISOString() === provider.validUntil,
  'canonical source provider absent/revoked/identity collision');
}

export function createProtectedPipelineSource(input: {
  acquire: () => Promise<PipelineClientLease>; provider: ValidatedSourceProvider;
  verifier: TrustedSourceVerifier | null; now: () => Date; maximumEvidenceAgeMs: number;
}) {
  const provider = providerTerms(input.provider), { now,maximumEvidenceAgeMs } = input;
  pipelineRequire(typeof now === 'function' && Number.isSafeInteger(maximumEvidenceAgeMs)
    && maximumEvidenceAgeMs > 0 && maximumEvidenceAgeMs <= 60_000,'bounded source evidence clock required');
  // Snapshot callable references once. Their result remains untrusted until
  // compared to protected durable approval and canonical provider authority.
  const adapter = input.verifier && typeof input.verifier.validateProvider === 'function'
    && typeof input.verifier.verifyEvidence === 'function' ? {
      validateProvider: input.verifier.validateProvider.bind(input.verifier),
      verifyEvidence: input.verifier.verifyEvidence.bind(input.verifier)
    } : null;
  const transactions = {
    register: createCheckedPipelineTransaction({ acquire: input.acquire,purpose: 'source-register',authorityId: provider.authorityId }),
    intake: createCheckedPipelineTransaction({ acquire: input.acquire,purpose: 'source-intake',authorityId: provider.authorityId }),
    verify: createCheckedPipelineTransaction({ acquire: input.acquire,purpose: 'source-verify',authorityId: provider.authorityId })
  };
  async function approved(client: PoolClient, purpose: 'source-intake' | 'source-verify') {
    const approval = await readPipelineBackendApproval(client,purpose,provider.authorityId);
    pipelineRequire(JSON.stringify(approval.provider) === JSON.stringify(provider),'protected provider scope drift');
    await requireRegisteredProvider(client,provider);
  }
  async function boundScope(client: PoolClient, sourceTradeId: string) {
    const result = await client.query(`SELECT binding.binding, binding.binding_digest, evidence.authority_id
      FROM public.source_verification_bindings binding
      JOIN public.source_verification_heads head ON head.source_trade_id=binding.source_trade_id
      JOIN public.source_verified_evidence evidence ON evidence.evidence_id=head.evidence_id
      WHERE binding.source_trade_id=$1 FOR SHARE OF binding,head,evidence`,[sourceTradeId]);
    const r = result.rows[0];
    pipelineRequire(result.rows.length === 1 && r.authority_id === provider.authorityId
      && r.binding?.chain === provider.chain && r.binding?.network === provider.network
      && sourceBindingDigest(r.binding) === r.binding_digest,'source outside approved immutable provider scope');
  }
  function available() { pipelineRequire(adapter,'approved source verifier unavailable; providerless intake remains refused'); }
  return {
    register(candidate: ValidatedSourceProvider = provider) {
      const captured = providerTerms(candidate);
      pipelineRequire(JSON.stringify(captured) === JSON.stringify(provider),'foreign provider registration');
      available(); return transactions.register(client => registerPipelineSourceProviderWithClient(client,captured));
    },
    intake(candidate: SourceTradeEventInput) {
      // Canonical exact economics/raw-scale binding, nested binding/dates all
      // captured by the actual owned preparation BEFORE lease acquisition.
      pipelineRequire(candidate?.confirmationState === 'observed','public source finality label refused');
      const binding = canonicalSourceBinding(candidate.verificationBinding!);
      pipelineRequire(typeof candidate.quantity === 'string' && [candidate.amountUsd,candidate.priceUsd,candidate.feeUsd]
        .every(value => value === undefined || value === null || typeof value === 'string'), 'source economics require exact strings');
      pipelineRequire(binding.chain === provider.chain && binding.network === provider.network,'source/provider scope mismatch');
      const record = prepareRecordSourceTradeEvent({ ...candidate,verificationBinding: binding });
      available();
      return transactions.intake(async client => { await approved(client,'source-intake'); return record(client); });
    },
    verify(sourceTradeId: string, candidate: SourceVerificationEvidence) {
      pipelineUuid(sourceTradeId); const evidence = canonicalSourceEvidence(candidate), time = new Date(now().getTime());
      pipelineRequire(pipelineTime(time) && Date.parse(evidence.observedAt) <= time.getTime()
        && time.getTime() - Date.parse(evidence.observedAt) <= maximumEvidenceAgeMs,'source evidence freshness refused');
      pipelineRequire(evidence.binding.chain === provider.chain && evidence.binding.network === provider.network
        && evidence.provenance.providerId === provider.providerId && evidence.provenance.authorityId === provider.authorityId
        && evidence.provenance.verifierVersion === provider.verifierVersion,'source evidence/provider mismatch');
      available();
      return transactions.verify(async client => {
        await approved(client,'source-verify');
        const clock = await client.query('SELECT statement_timestamp() AS database_now');
        const databaseNow = clock.rows[0]?.database_now;
        pipelineRequire(clock.rows.length === 1 && pipelineTime(databaseNow)
          && Date.parse(evidence.observedAt) <= databaseNow.getTime()
          && databaseNow.getTime() - Date.parse(evidence.observedAt) <= maximumEvidenceAgeMs,
        'source evidence freshness refused at protected intake');
        const verifier: TrustedSourceVerifier = {
          validateProvider: async () => {
            const authenticated = await adapter!.validateProvider();
            pipelineRequire(authenticated && JSON.stringify(providerTerms(authenticated)) === JSON.stringify(provider),
              'source adapter authentication mismatch'); return provider;
          },
          verifyEvidence: async request => {
            pipelineRequire(sourceBindingDigest(request.expected) === sourceBindingDigest(evidence.binding)
              && request.evidenceDigest === sourceEvidenceDigest(evidence),'verifier immutable evidence drift');
            return adapter!.verifyEvidence(request);
          }
        };
        return verifySourceTradeWithClient(client,{ sourceTradeId,evidence,verifier,now: time });
      });
    },
    derive(candidate: Parameters<typeof prepareInsertSourceTradeSignal>[0]) {
      const sourceTradeId = candidate.sourceTradeId;
      pipelineUuid(sourceTradeId);
      const derive = prepareInsertSourceTradeSignal(candidate); available();
      return transactions.verify(async client => {
        await approved(client,'source-verify'); await boundScope(client,sourceTradeId); return derive(client);
      });
    },
    candidates(candidate: Parameters<typeof prepareListSourceTradeSignalCandidates>[0]) {
      const read = prepareListSourceTradeSignalCandidates(candidate); available();
      return transactions.verify(async client => {
        await approved(client,'source-verify');
        const rows = await read(client), scoped: typeof rows = [];
        for (const row of rows) {
          // Candidate discovery is not permission to derive another provider's
          // source; filter using immutable accepted provider-bound evidence.
          const result = await client.query(`SELECT true AS owned FROM public.source_verification_bindings binding
            JOIN public.source_verification_heads head ON head.source_trade_id=binding.source_trade_id
            JOIN public.source_verified_evidence evidence ON evidence.evidence_id=head.evidence_id
            WHERE binding.source_trade_id=$1 AND evidence.authority_id=$2 AND binding.network=$3`,
          [row.sourceTradeId,provider.authorityId,provider.network]);
          if (result.rows.length === 1 && result.rows[0].owned === true) scoped.push(row);
        }
        return scoped;
      });
    }
  };
}
