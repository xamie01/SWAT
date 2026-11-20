import { AsyncLocalStorage } from 'node:async_hooks';
import type { QueryResultRow } from 'pg';
import type { UserRecord, ResolvedSession, IssuedSession } from './users.js';
import type { AuthWalletChainKind, AuthWalletRecord } from './auth-wallets.js';
import { generateToken, hashPassword, hashToken, verifyPassword, verifyPasswordAgainstDummy } from './credentials.js';

/** Pool-free, primary-only capabilities. The implementation must pin BEGIN through checked
 * COMMIT to one backend, reject nested transactions, and discard every rejected lease.
 * An attempted uncertain COMMIT must not be described as rolled back.
 * Use createCheckedAuthTransaction for a supplied pool/client lease; labels are not authority. */
export type AuthQueryRow = QueryResultRow;
export interface AuthQueryClient {
  query<T extends AuthQueryRow = AuthQueryRow>(sql: string, values?: unknown[]): Promise<{ rows: T[]; command?: string }>;
}
export type OwnedAuthTransaction = <T>(operation: (client: AuthQueryClient) => Promise<T>) => Promise<T>;
export interface AuthClientLease { readonly client: AuthQueryClient; release(broken: boolean): void }

export const AUTH_IDENTITY_SQL = `SELECT current_user AS role_name, session_user AS session_role,
  current_setting('role') AS role_setting, current_setting('row_security') AS row_security,
  r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolinherit,
  EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid OR roleid = r.oid) AS has_memberships,
  (EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = r.oid)
   OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner = r.oid)
   OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = r.oid)
   OR EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datdba = r.oid)) AS owns_objects,
  (EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE has_schema_privilege(r.oid, oid, 'CREATE'))
   OR has_database_privilege(r.oid, current_database(), 'CREATE')) AS can_create,
  pg_backend_pid() AS backend_pid,
  (SELECT xact_start=query_start FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid()) AS transaction_clean,
  (SELECT bool_and(setdatabase=0 AND (setconfig <@ ARRAY['row_security=on','search_path=pg_catalog','search_path=pg_catalog, public']::text[]))
    FROM pg_catalog.pg_db_role_setting WHERE setrole=r.oid) AS role_defaults_safe
  FROM pg_catalog.pg_roles r WHERE rolname = current_user`;
export const AUTH_RESET_SQL = `SELECT set_config('app.current_user_id', '', true),
  set_config('app.bypass_rls', 'off', true), set_config('app.worker_execution_id', '', true),
  set_config('statement_timeout', '15000', true), set_config('lock_timeout', '5000', true),
  set_config('idle_in_transaction_session_timeout', '30000', true)`;

export const AUTH_POOL_RESET_SQL = `SELECT set_config('app.current_user_id', '', false),
  set_config('app.bypass_rls', 'off', false), set_config('app.worker_execution_id', '', false)`;

export async function assertAuthIdentity(client: AuthQueryClient, requireCleanLease = false): Promise<number> {
  const { rows } = await client.query(AUTH_IDENTITY_SQL);
  const r = rows[0];
  if (rows.length !== 1 || !r || r.role_name !== 'swat_auth_service' || r.session_role !== 'swat_auth_service'
      || r.role_setting !== 'none' || r.row_security !== 'on' || r.rolcanlogin !== true
      || r.role_defaults_safe !== true
      || requireCleanLease && r.transaction_clean !== true
      || !Number.isInteger(r.backend_pid) || r.backend_pid <= 0
      || ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolinherit',
        'has_memberships', 'owns_objects', 'can_create'].some(k => r[k] !== false)) {
    throw new Error('Unsafe auth database identity; distinct direct swat_auth_service capability required');
  }
  return r.backend_pid as number;
}

/** No pool is created, connected, or inferred from ambient app credentials.
 * A pending or overlapping operation poisons the lease. It is settled before cleanup;
 * after an attempted COMMIT the result is explicitly uncertain, never called rollback. */
export class AuthCommitUncertainError extends Error {
  constructor() { super('Authentication COMMIT outcome uncertain; discard lease'); this.name = 'AuthCommitUncertainError'; }
}
export function createCheckedAuthTransaction(acquire: () => Promise<AuthClientLease>): OwnedAuthTransaction {
  if (typeof acquire !== 'function') throw new Error('Owned auth client acquisition required');
  const activeClients = new WeakSet<object>();
  const context = new AsyncLocalStorage<{ poisoned: boolean }>();
  return async operation => {
    const parent = context.getStore();
    if (parent) { parent.poisoned = true; throw new Error('Nested auth transaction refused'); }
    const lifetime = { poisoned: false };
    const lease = await acquire();
    if (!lease?.client || typeof lease.release !== 'function') throw new Error('Owned auth lease required');
    if (activeClients.has(lease.client)) throw new Error('Nested/reused auth lease refused');
    activeClients.add(lease.client);
    let broken = false, open = false, live = false, committing = false;
    let pending: Promise<unknown> | null = null;
    let poisoned = false;
    const client: AuthQueryClient = { query: async <T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) => {
      if (!live) { poisoned = true; throw new Error('Owned auth transaction capability expired'); }
      // Operation SQL is a single fixed SELECT. Reject comments, stacked statements,
      // quoted/dollar SQL, transaction/role control and ambient GUC mutation.
      if (pending || typeof sql !== 'string' || !(sql === AUTH_IDENTITY_SQL || sql === AUTH_RESET_SQL
          || /^SELECT (?:\* FROM public\.swat_auth_[a-z_]+\((?:\$[1-9][0-9]*::[a-z]+,?)*\)|public\.swat_auth_[a-z_]+\((?:\$[1-9][0-9]*::[a-z]+,?)*\)(?: AS (?:principal|count|changed|removed|expires_at))?)$/.test(sql))
          || /;|--|\/\*|\$[a-z_]*\$|\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET|DO|CALL)\b/i.test(sql)
          || /\bset_config\b/i.test(sql) && sql !== AUTH_RESET_SQL) {
        poisoned = true; throw new Error('Overlapping or uncontrolled auth query refused');
      }
      const query = lease.client.query<T>(sql, values);
      pending = query;
      try { return await query; }
      catch (error) { poisoned = true; throw error; }
      finally { if (pending === query) pending = null; }
    } };
    try {
      // Clear stale session-scoped pool state before BEGIN. LOCAL reset alone restores
      // a contaminated prior session value at COMMIT/ROLLBACK.
      const initialBackend = await assertAuthIdentity(lease.client, true);
      await lease.client.query(AUTH_POOL_RESET_SQL);
      const begin = await lease.client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      if (begin.command !== 'BEGIN') throw new Error('Auth BEGIN refused');
      open = true;
      const backend = await assertAuthIdentity(lease.client);
      if (backend !== initialBackend) throw new Error('Auth direct backend changed at BEGIN');
      await lease.client.query(AUTH_RESET_SQL);
      live = true;
      const result = await context.run(lifetime, () => operation(client));
      live = false;
      const assertSettled = () => {
        if (pending || poisoned || lifetime.poisoned) throw new Error('Auth query lifetime escaped operation');
      };
      assertSettled();
      await lease.client.query(AUTH_RESET_SQL);
      assertSettled();
      if (await assertAuthIdentity(lease.client) !== backend) throw new Error('Auth backend changed before COMMIT');
      assertSettled();
      // No await between this fence and the COMMIT attempt. A violation after the
      // attempt cannot establish rollback and must withhold admission as uncertain.
      committing = true;
      const commit = await lease.client.query('COMMIT');
      if (commit.command !== 'COMMIT' || pending || poisoned || lifetime.poisoned) throw new AuthCommitUncertainError();
      open = false;
      committing = false;
      return result;
    } catch (error) {
      live = false;
      broken = true;
      if (pending) { try { await pending; } catch { /* settle owned work before cleanup */ } }
      if (committing) throw new AuthCommitUncertainError();
      if (open) {
        try { const rollback = await lease.client.query('ROLLBACK'); if (rollback.command === 'ROLLBACK') open = false; }
        catch { /* no rollback claim on uncertainty */ }
      }
      throw error;
    } finally {
      activeClients.delete(lease.client);
      lease.release(broken || open || poisoned || lifetime.poisoned);
    }
  };
}

export class EmailAlreadyRegisteredError extends Error {
  constructor() { super('Email already registered'); this.name = 'EmailAlreadyRegisteredError'; }
}
export class WalletAlreadyLinkedError extends Error {
  constructor() { super('Wallet already linked to another account'); this.name = 'WalletAlreadyLinkedError'; }
}
export class AuthSessionRequiredError extends Error {
  constructor() { super('Fresh active session required'); this.name = 'AuthSessionRequiredError'; }
}
export type AuthAdmission =
  | { readonly kind: 'issued'; readonly user: UserRecord; readonly session: IssuedSession }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'inactive' };
export interface AuthRequestContext { readonly ip?: string | null; readonly userAgent?: string | null }
export interface OwnedAuthStore {
  signup(input: { email: string; password: string; displayName?: string | null }, context?: AuthRequestContext): Promise<AuthAdmission>;
  login(email: string, password: string, context?: AuthRequestContext): Promise<AuthAdmission>;
  resolveSession(token: string): Promise<ResolvedSession | null>;
  revokeSession(token: string, context?: AuthRequestContext): Promise<void>;
  revokeAllSessions(token: string): Promise<number>;
  changePassword(token: string, newPassword: string): Promise<void>;
  profile(token: string): Promise<{ user: UserRecord; wallets: AuthWalletRecord[] } | null>;
  linkWallet(token: string, input: { chainKind: AuthWalletChainKind; address: string }, context?: AuthRequestContext): Promise<AuthWalletRecord>;
  unlinkWallet(token: string, input: { chainKind: AuthWalletChainKind; address: string }): Promise<boolean>;
  /** Only the trusted server signature/nonce verifier may invoke wallet admission. */
  walletLogin(input: { chainKind: AuthWalletChainKind; address: string }, context?: AuthRequestContext): Promise<AuthAdmission>;
  walletFailure(input: { chainKind: AuthWalletChainKind; address: string }, context?: AuthRequestContext): Promise<void>;
}

interface UserRow extends QueryResultRow {
  id: string; email: string; display_name: string | null; role: UserRecord['role']; tier: UserRecord['tier'];
  tier_expires_at: Date | null; status: UserRecord['status']; created_at: Date;
}
function user(r: UserRow): UserRecord {
  // jsonb timestamptz values are ISO strings; materialize only validated dates.
  if (r && typeof r.created_at === 'string') r.created_at = new Date(r.created_at);
  if (r && typeof r.tier_expires_at === 'string') r.tier_expires_at = new Date(r.tier_expires_at);
  if (!r || typeof r.id !== 'string' || typeof r.email !== 'string'
      || typeof r.display_name !== 'string' && r.display_name !== null
      || !['user', 'admin'].includes(r.role) || !['free', 'operator', 'ultra'].includes(r.tier)
      || !['active', 'suspended', 'deleted'].includes(r.status)
      || !(r.created_at instanceof Date) || !Number.isFinite(r.created_at.getTime())
      || r.tier_expires_at !== null && (!(r.tier_expires_at instanceof Date) || !Number.isFinite(r.tier_expires_at.getTime()))) {
    throw new Error('Malformed protected auth user');
  }
  return { id: r.id, email: r.email, displayName: r.display_name, role: r.role, tier: r.tier,
    tierExpiresAt: r.tier_expires_at, status: r.status, createdAt: r.created_at };
}
function wallet(r: QueryResultRow): AuthWalletRecord {
  if (r && typeof r.verified_at === 'string') r.verified_at = new Date(r.verified_at);
  if (!r || typeof r.id !== 'string' || typeof r.user_id !== 'string' || !['evm', 'solana'].includes(r.chain_kind)
      || typeof r.address !== 'string' || !(r.verified_at instanceof Date) || !Number.isFinite(r.verified_at.getTime())) {
    throw new Error('Malformed protected auth wallet');
  }
  return { id: r.id, userId: r.user_id, chainKind: r.chain_kind, address: r.address, verifiedAt: r.verified_at };
}
function context(c: AuthRequestContext = {}): unknown[] { return [c.ip ?? null, c.userAgent?.slice(0, 256) ?? null]; }
function passwordInput(password: string): void {
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) throw new Error('Invalid password length');
}

/** Import-safe composition of actual password/session/signup/wallet logic. Injected SQL
 * facts are offline contracts, not PostgreSQL RLS proof. No audit label/hash approves a
 * login. Only this distinct trusted DB capability can call the fixed admission routines. */
export function createOwnedAuthStore(transaction: OwnedAuthTransaction): OwnedAuthStore {
  if (typeof transaction !== 'function') throw new Error('Owned auth transaction required; app fallback prohibited');
  const tx: OwnedAuthTransaction = operation => transaction(async client => {
    const backend = await assertAuthIdentity(client);
    await client.query(AUTH_RESET_SQL);
    try { return await operation(client); }
    finally {
      await client.query(AUTH_RESET_SQL);
      if (await assertAuthIdentity(client) !== backend) throw new Error('Owned auth backend changed');
    }
  });
  async function principal(client: AuthQueryClient, sql: string, values: unknown[]): Promise<UserRow | null> {
    const { rows } = await client.query<{ principal: UserRow | null }>(sql, values);
    if (rows.length !== 1) throw new Error('Malformed protected principal result');
    return rows[0]!.principal;
  }
  async function issue(client: AuthQueryClient, u: UserRecord, c?: AuthRequestContext): Promise<AuthAdmission> {
    if (u.status !== 'active') return { kind: 'inactive' };
    const token = generateToken();
    const { rows } = await client.query<{ expires_at: Date }>(
      'SELECT public.swat_auth_issue($1::uuid,$2::bytea,$3::inet,$4::text) AS expires_at', [u.id, hashToken(token), ...context(c)]);
      if (rows.length !== 1 || !(rows[0]!.expires_at instanceof Date)
        || !Number.isFinite(rows[0]!.expires_at.getTime())) throw new Error('Protected session admission refused');
    return { kind: 'issued', user: u, session: { token, expiresAt: rows[0]!.expires_at } };
  }
  async function resolved(client: AuthQueryClient, token: string): Promise<ResolvedSession | null> {
    const digest = hashToken(token);
    await client.query('SELECT public.swat_auth_touch($1::bytea)', [digest]);
    const r = await principal(client, 'SELECT public.swat_auth_resolve($1::bytea) AS principal', [digest]);
    if (r && typeof r.session_id !== 'string') throw new Error('Malformed protected session');
    return r ? { sessionId: r.session_id as string, user: user(r) } : null;
  }
  return Object.freeze({
    signup: async (input, c) => {
      passwordInput(input.password);
      const encoded = await hashPassword(input.password);
      try {
        return await tx(async client => {
          const r = await principal(client, 'SELECT public.swat_auth_signup($1::text,$2::text,$3::text) AS principal',
            [input.email, encoded, input.displayName ?? null]);
          if (!r) throw new Error('Protected signup refused');
          return issue(client, user(r), c);
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new EmailAlreadyRegisteredError();
        throw error;
      }
    },
    login: (email, password, c) => tx(async client => {
      const r = await principal(client, 'SELECT public.swat_auth_password($1::text) AS principal', [email]);
      const valid = r && typeof r.password_hash === 'string'
        ? await verifyPassword(r.password_hash, password) : await verifyPasswordAgainstDummy(password);
      if (!valid || !r) {
        await client.query('SELECT public.swat_auth_login_failure($1::text,$2::inet,$3::text)', [email, ...context(c)]);
        return { kind: 'invalid' };
      }
      return issue(client, user(r), c);
    }),
    resolveSession: token => tx(client => resolved(client, token)),
    revokeSession: (token, c) => tx(async client => {
      await client.query('SELECT public.swat_auth_revoke($1::bytea,$2::inet)', [hashToken(token), c?.ip ?? null]);
    }),
    revokeAllSessions: token => tx(async client => {
      const { rows } = await client.query<{ count: number }>('SELECT public.swat_auth_revoke_all($1::bytea) AS count', [hashToken(token)]);
      if (!rows[0] || !Number.isInteger(rows[0].count) || rows[0].count < 0) throw new AuthSessionRequiredError();
      return rows[0].count;
    }),
    changePassword: async (token, password) => {
      passwordInput(password);
      const encoded = await hashPassword(password);
      await tx(async client => {
        const { rows } = await client.query<{ changed: boolean }>('SELECT public.swat_auth_change_password($1::bytea,$2::text) AS changed', [hashToken(token), encoded]);
        if (rows[0]?.changed !== true) throw new AuthSessionRequiredError();
      });
    },
    profile: token => tx(async client => {
      const session = await resolved(client, token);
      if (!session) return null;
      const { rows } = await client.query('SELECT * FROM public.swat_auth_wallets($1::bytea)', [hashToken(token)]);
      // Fresh resolution following wallet read does not retain a stale principal.
      if (!await resolved(client, token)) return null;
      return { user: session.user, wallets: rows.map(wallet) };
    }),
    linkWallet: (token, input, c) => tx(async client => {
      const { rows } = await client.query('SELECT * FROM public.swat_auth_link_wallet($1::bytea,$2::text,$3::text,$4::inet)',
        [hashToken(token), input.chainKind, input.address, c?.ip ?? null]);
      if (!rows[0]) throw new WalletAlreadyLinkedError();
      return wallet(rows[0]);
    }),
    unlinkWallet: (token, input) => tx(async client => {
      const { rows } = await client.query<{ removed: boolean }>('SELECT public.swat_auth_unlink_wallet($1::bytea,$2::text,$3::text) AS removed',
        [hashToken(token), input.chainKind, input.address]);
      return rows[0]?.removed === true;
    }),
    walletLogin: (input, c) => tx(async client => {
      const r = await principal(client, 'SELECT public.swat_auth_wallet_owner($1::text,$2::text) AS principal', [input.chainKind, input.address]);
      return r ? issue(client, user(r), c) : { kind: 'invalid' };
    }),
    walletFailure: (input, c) => tx(async client => {
      await client.query('SELECT public.swat_auth_wallet_failure($1::text,$2::text,$3::inet)', [input.chainKind, input.address, c?.ip ?? null]);
    })
  } satisfies OwnedAuthStore);
}
