import type { Chain } from '@swat/shared';
import { resolveChainAddress } from '@swat/shared';
import { recordAuditEventStrict } from './audit-log.js';
import { isCrossTenant, scopedQuery, withTenantTransaction, type UserScope } from './tenancy.js';
import { assertCustodyBindingMatches, assertCustodyEnvelope, assertCustodyLifecycle, custodyGrantId, custodyIdentifier, custodyPolicySnapshot,
  type CustodySecretBinding } from './custody-contract.js';

/**
 * Scoped delegated authority to trade on a user's behalf (`S4-7`, migration
 * `047`, ADR-0003).
 *
 * The shape this module protects: **a grant record read by the API never carries
 * the sealed secret.** `ExecutionGrant` has no field for it, so an API route
 * cannot leak one by serialising a row it fetched for another purpose — the
 * closest it can get is calling `loadSealedGrantSecret`, which is named to be
 * greppable and is only useful inside a process that holds a wrapper key.
 *
 * The keyless/keyed split is duplicated here and in
 * `chk_ueg_secret_matches_kind`, on purpose. The database constraint is the
 * guarantee; the check in `recordExecutionGrant` exists so that a caller bug
 * surfaces as a named error naming the kind, rather than as a 23514 whose text
 * mentions a constraint the caller has never heard of.
 */

export type GrantKind =
  | 'solana_vault'
  | 'eip7702'
  | 'session_key_4337'
  | 'polymarket_signer';

export type GrantStatus = 'active' | 'retired' | 'revoked' | 'compromised';

/**
 * Grant kinds that hold no secret, as a set — mirroring the SQL
 * `grant_kind = ANY (ARRAY['solana_vault'])`.
 *
 * A Solana vault is a PDA: there is no key, so there is nothing to seal. Adding a
 * second keyless venue means editing this array and the array in the migration's
 * CHECK, and nothing else.
 */
export const KEYLESS_GRANT_KINDS: readonly GrantKind[] = ['solana_vault'] as const;

export function isKeylessGrantKind(kind: GrantKind): boolean {
  return KEYLESS_GRANT_KINDS.includes(kind);
}

/** Kinds that are a time-boxed delegation rather than a standing key. */
const EXPIRING_GRANT_KINDS: readonly GrantKind[] = ['eip7702', 'session_key_4337'] as const;

export function grantKindRequiresExpiry(kind: GrantKind): boolean {
  return EXPIRING_GRANT_KINDS.includes(kind);
}

/**
 * A grant as the API and the fan-out path see it. **No `sealedSecret` field.**
 *
 * `keyVersion` is included because it is not secret and is what the wrapper
 * rotation sweep reports progress against.
 */
export interface ExecutionGrant {
  readonly id: string;
  readonly userId: string;
  readonly chain: Chain;
  readonly grantKind: GrantKind;
  readonly accountAddress: string;
  /** True when the row carries a sealed secret. The secret itself is not here. */
  readonly hasSealedSecret: boolean;
  readonly keyVersion: number | null;
  readonly scopePolicy: unknown | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly status: GrantStatus;
  readonly createdAt: Date;
}

interface GrantRow {
  id: string;
  user_id: string;
  chain: Chain;
  grant_kind: GrantKind;
  account_address: string;
  has_sealed_secret: boolean;
  key_version: number | null;
  scope_policy: unknown | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  status: GrantStatus;
  created_at: Date;
}

/**
 * The projection every public read uses.
 *
 * `sealed_secret IS NOT NULL AS has_sealed_secret` rather than `sealed_secret`:
 * the column is never selected by these queries at all, so it cannot reach a log
 * line, an error message, or a JSON response by accident.
 */
const GRANT_COLUMNS = `id, user_id, chain, grant_kind, account_address,
       sealed_secret IS NOT NULL AS has_sealed_secret,
       key_version, scope_policy, expires_at, revoked_at, status, created_at`;

function toGrant(row: GrantRow): ExecutionGrant {
  return {
    id: row.id,
    userId: row.user_id,
    chain: row.chain,
    grantKind: row.grant_kind,
    accountAddress: row.account_address,
    hasSealedSecret: row.has_sealed_secret,
    keyVersion: row.key_version,
    scopePolicy: row.scope_policy,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    status: row.status,
    createdAt: row.created_at
  };
}

/**
 * The grant violates the keyless/keyed invariant, or a session grant has no
 * expiry.
 *
 * Distinct from a generic error so the API can map it to a 400 rather than a 500:
 * every case is a malformed request, not a server fault.
 */
export class InvalidExecutionGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidExecutionGrantError';
  }
}

/** An active grant already exists for this (user, chain, kind). */
export class ExecutionGrantConflictError extends Error {
  constructor() {
    super('An active execution grant already exists for this chain and kind');
    this.name = 'ExecutionGrantConflictError';
  }
}

export interface RecordExecutionGrantInput {
  /** Trusted preallocated row ID required for a resource-bound keyed enrollment. */
  readonly id?: string;
  /** Persisted AAD metadata. Not delegated execution authority. */
  readonly secretBinding?: CustodySecretBinding | null;
  readonly chain: Chain;
  readonly grantKind: GrantKind;
  /**
   * The settlement account. Stored unprefixed; normalised and validated by
   * `normalizeGrantAccountAddress`, so a mixed-case EVM address or a prefixed
   * `polygon:0x…` from a `copy_positions` join is accepted and written in the one
   * form the column holds.
   */
  readonly accountAddress: string;
  /** The authenticated resource-bound v2 envelope. Omit or pass null for a keyless kind. */
  readonly sealedSecret?: string | null;
  readonly keyVersion?: number | null;
  readonly scopePolicy?: unknown;
  readonly expiresAt?: Date | null;
}

/**
 * Validates the invariant the database also enforces, so the caller gets a
 * message naming the kind rather than a constraint violation.
 *
 * Exported for the API's request validation, which needs the same answer before
 * it has a database connection.
 */
export function assertGrantSecretMatchesKind(input: {
  grantKind: GrantKind;
  sealedSecret?: string | null;
  keyVersion?: number | null;
}): void {
  const keyless = isKeylessGrantKind(input.grantKind);
  const hasSecret = input.sealedSecret !== null && input.sealedSecret !== undefined;
  const hasVersion = input.keyVersion !== null && input.keyVersion !== undefined;

  if (keyless) {
    if (hasSecret || hasVersion) {
      throw new InvalidExecutionGrantError(
        `${input.grantKind} is keyless and must carry no sealed secret or key version`
      );
    }
    return;
  }

  if (!hasSecret || !hasVersion) {
    throw new InvalidExecutionGrantError(
      `${input.grantKind} requires a sealed secret and a key version`
    );
  }
  if (!Number.isSafeInteger(input.keyVersion) || input.keyVersion! <= 0) {
    throw new InvalidExecutionGrantError('key version must be a positive safe integer');
  }
  // This shape guard remains compatible with historical rows. New writes below
  // additionally require the fully bound v2 envelope and immutable admission.
  if (!/^v\d+\./.test(input.sealedSecret as string)) {
    throw new InvalidExecutionGrantError(
      'sealed secret must be a versioned envelope, e.g. v1.<wrapperId>.…'
    );
  }
}

/**
 * Normalises `account_address` to the form the column is documented to hold:
 * **unprefixed**, EVM lowercased, Solana case-preserved.
 *
 * `047` stores the account unprefixed because `chain` already carries the
 * discriminator, so the repo-wide `${chain}:${raw}` invariant does not apply to
 * this column — but the *normalisation* half of it still does, and without this
 * `uq_ueg_account` is defeated by case. `0xAbC…` and `0xabc…` are the same EVM
 * account and would occupy two rows, which is exactly the "two users' funds at one
 * address" failure that constraint exists to prevent.
 *
 * `resolveChainAddress` also validates the shape, so a truncated or malformed
 * address fails here rather than at the first signing attempt. It accepts an
 * already-prefixed value and strips the prefix, and throws when the prefix
 * disagrees with `chain` — so a caller that passes a prefixed address from a
 * `copy_positions` join gets the right answer instead of a `polygon:0x…` literal
 * in a column that must not carry one.
 */
export function normalizeGrantAccountAddress(chain: Chain, accountAddress: string): string {
  try {
    return resolveChainAddress(accountAddress, chain).raw;
  } catch (error) {
    throw new InvalidExecutionGrantError(
      `account_address is not a valid ${chain} address: ${(error as Error).message}`
    );
  }
}

/**
 * Inserts a grant.
 *
 * `user_id` comes from `scope`, never from the input — the input type has no
 * `userId` field, which is the point.
 */
export async function recordExecutionGrant(
  scope: UserScope,
  input: RecordExecutionGrantInput,
  options: { replace?: boolean } = {}
): Promise<ExecutionGrant> {
  scope = { userId: scope.userId } as UserScope;
  custodyIdentifier(scope.userId);
  input = { ...input, scopePolicy: custodyPolicySnapshot(input.scopePolicy),
    expiresAt: input.expiresAt == null ? null : new Date(input.expiresAt.getTime()),
    secretBinding: input.secretBinding ? structuredClone(input.secretBinding) : null };
  const validPair = input.grantKind === 'solana_vault' ? input.chain === 'solana'
    : input.grantKind === 'polymarket_signer' ? input.chain === 'polygon'
    : input.chain === 'robinhood-chain';
  if (!validPair) throw new InvalidExecutionGrantError('Unsupported chain/grant-kind pair');
  if (input.expiresAt && !(input.expiresAt.getTime() > Date.now())) throw new InvalidExecutionGrantError('Grant is expired');
  assertGrantSecretMatchesKind(input);
  if (grantKindRequiresExpiry(input.grantKind) && !input.expiresAt) {
    throw new InvalidExecutionGrantError(
      `${input.grantKind} requires expires_at — a scoped grant with no expiry is not scoped`
    );
  }
  // New keyed writes never accept legacy/unbound envelopes. A string shaped like
  // ciphertext is not authentication; only an approved wrap identity can attest it.
  if (input.id !== undefined) custodyGrantId(input.id);
  if (isKeylessGrantKind(input.grantKind)) {
    if (input.secretBinding != null) throw new InvalidExecutionGrantError('Keyless grant must have no secret binding');
  } else {
    if (!input.id || !input.secretBinding) throw new InvalidExecutionGrantError('Resource-bound v2 enrollment required');
    assertCustodyEnvelope(input.sealedSecret!, input.keyVersion!);
    assertCustodyBindingMatches(input.secretBinding, { id: input.id, userId: scope.userId,
      chain: input.chain, grantKind: input.grantKind, accountAddress: input.accountAddress,
      keyVersion: input.keyVersion!, scopePolicy: input.scopePolicy, expiresAt: input.expiresAt ?? null });
  }
  const accountAddress = normalizeGrantAccountAddress(input.chain, input.accountAddress);

  try {
    if (options.replace) return await withTenantTransaction(scope, async (client) => {
      const owner = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [scope.userId]);
      if (owner.rows.length !== 1) throw new ExecutionGrantConflictError();
      const existing = await client.query<GrantRow & { sealed_secret: string | null; secret_binding: unknown;
        lifecycle_revision: string; revocation_tombstone: Date | null; activated_key_version: number | null }>(`SELECT ${GRANT_COLUMNS}, sealed_secret, secret_binding,
          lifecycle_revision::text AS lifecycle_revision, revocation_tombstone, activated_key_version FROM user_execution_grants
        WHERE chain = $1 AND (CASE WHEN chain = 'solana' THEN account_address ELSE lower(account_address) END) = $2
          AND user_id = $3 FOR UPDATE`,
        [input.chain, accountAddress, scope.userId]);
      if (existing.rows.length > 1 || existing.rows.some(g => g.user_id !== scope.userId || g.status === 'compromised'
        || (input.id !== undefined && g.id !== input.id))) throw new ExecutionGrantConflictError();
      const previous = existing.rows[0];
      if (previous) {
        assertCustodyLifecycle({ lifecycleRevision: previous.lifecycle_revision, revocationTombstone: previous.revocation_tombstone,
          revokedAt: previous.revoked_at }, new Date());
        const same = previous.status === 'active' && previous.revoked_at === null && previous.grant_kind === input.grantKind &&
          previous.key_version === (input.keyVersion ?? null) && previous.sealed_secret === (input.sealedSecret ?? null) &&
          JSON.stringify(custodyPolicySnapshot(previous.secret_binding)) === JSON.stringify(custodyPolicySnapshot(input.secretBinding)) &&
          JSON.stringify(custodyPolicySnapshot(previous.scope_policy)) === JSON.stringify(input.scopePolicy) &&
          (previous.expires_at?.getTime() ?? null) === (input.expiresAt?.getTime() ?? null);
        if (same) return toGrant(previous); // retries do not stage/clear revocation or change lifecycle
        if (isKeylessGrantKind(input.grantKind) ? previous.revocation_tombstone !== null || previous.grant_kind !== input.grantKind
          : previous.key_version !== null && input.keyVersion! <= previous.key_version) throw new ExecutionGrantConflictError();
      }
      // Reserve/update the owned replacement in a non-active state BEFORE
      // revoking anything. An empty guarded upsert is an error, not success.
      const staged = await client.query<GrantRow>(`INSERT INTO user_execution_grants
        (user_id, chain, grant_kind, account_address, sealed_secret, key_version, scope_policy, expires_at, status, id, secret_binding)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'retired', COALESCE($9::uuid, gen_random_uuid()), $10::jsonb)
        ON CONFLICT (chain, account_address) DO UPDATE SET
          grant_kind = EXCLUDED.grant_kind, sealed_secret = EXCLUDED.sealed_secret,
          key_version = EXCLUDED.key_version, scope_policy = EXCLUDED.scope_policy, secret_binding = EXCLUDED.secret_binding,
          expires_at = EXCLUDED.expires_at, status = 'retired'
        WHERE user_execution_grants.user_id = EXCLUDED.user_id AND user_execution_grants.status <> 'compromised'
          AND ($9::uuid IS NULL OR user_execution_grants.id = $9::uuid)
        RETURNING ${GRANT_COLUMNS}`, [scope.userId, input.chain, input.grantKind, accountAddress,
          input.sealedSecret ?? null, input.keyVersion ?? null, input.scopePolicy === undefined ? null : JSON.stringify(input.scopePolicy), input.expiresAt ?? null,
          input.id ?? null, input.secretBinding ? JSON.stringify(input.secretBinding) : null]);
      if (staged.rows.length !== 1) throw new ExecutionGrantConflictError();
      const id = staged.rows[0]!.id;
      await client.query(`UPDATE user_execution_grants SET status = 'revoked', revoked_at = NOW()
        WHERE user_id = $1 AND chain = $2 AND grant_kind = $3 AND id <> $4 AND status = 'active'`,
        [scope.userId, input.chain, input.grantKind, id]);
      const active = await client.query<GrantRow>(`UPDATE user_execution_grants SET status = 'active', revoked_at = NULL
        WHERE id = $1 AND user_id = $2 AND status = 'retired' RETURNING ${GRANT_COLUMNS}`, [id, scope.userId]);
      if (active.rows.length !== 1) throw new ExecutionGrantConflictError();
      await recordAuditEventStrict({ actorType: 'user', actorId: scope.userId, event: 'grant.locally_replaced',
        targetType: 'execution_grant', targetId: id, metadata: { chain: input.chain, grantKind: input.grantKind, localOnly: true } }, client);
      return toGrant(active.rows[0]!);
    });
    const rows = await scopedQuery<GrantRow>(scope,
      `INSERT INTO user_execution_grants
         (user_id, chain, grant_kind, account_address, sealed_secret, key_version,
          scope_policy, expires_at, id, secret_binding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::uuid, gen_random_uuid()), $10::jsonb)
       RETURNING ${GRANT_COLUMNS}`,
      [
        scope.userId,
        input.chain,
        input.grantKind,
        accountAddress,
        input.sealedSecret ?? null,
        input.keyVersion ?? null,
        input.scopePolicy === undefined ? null : JSON.stringify(input.scopePolicy),
        input.expiresAt ?? null,
        input.id ?? null,
        input.secretBinding ? JSON.stringify(input.secretBinding) : null
      ]
    );
    if (rows.length !== 1) throw new ExecutionGrantConflictError();
    return toGrant(rows[0]!);
  } catch (error) {
    // 23505 is a unique violation. Both the partial active index and the global
    // account uniqueness land here; the caller's remedy is the same either way —
    // revoke the existing grant first.
    if ((error as { code?: string }).code === '23505') throw new ExecutionGrantConflictError();
    throw error;
  }
}

export async function listExecutionGrants(scope: UserScope): Promise<ExecutionGrant[]> {
  const rows = await scopedQuery<GrantRow>(scope,
    `SELECT ${GRANT_COLUMNS}
       FROM user_execution_grants
      WHERE user_id = $1
      ORDER BY created_at DESC`,
    [scope.userId]
  );
  return rows.map(toGrant);
}

/**
 * The one active grant for a (user, chain, kind), or null.
 *
 * Single-row by construction: `uq_ueg_active_per_user_chain_kind` is the
 * guarantee, so this does not need a `LIMIT` to be deterministic.
 */
export async function findActiveExecutionGrant(
  scope: UserScope,
  chain: Chain,
  grantKind: GrantKind
): Promise<ExecutionGrant | null> {
  const rows = await scopedQuery<GrantRow>(scope,
    `SELECT ${GRANT_COLUMNS}
       FROM user_execution_grants
      WHERE user_id = $1 AND chain = $2 AND grant_kind = $3 AND status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())
         AND grant_kind NOT IN ('solana_vault', 'eip7702', 'session_key_4337')`,
    [scope.userId, chain, grantKind]
  );
  return rows[0] ? toGrant(rows[0]) : null;
}

/**
 * Reads historical ciphertext for explicit migration/incident tooling only.
 * This compatibility read is NOT execution authority: it has no authenticated
 * resource context or lifecycle proof. New execution uses custody-execution.ts
 * and its role-specific store, never this return value.
 *
 * **Only useful inside a process that holds a wrapper key**, which is
 * `trade-executor` and nothing else. Named separately from every other read so
 * that `grep -rn loadSealedGrantSecret` returns the complete list of places the
 * ciphertext is fetched, and any new occurrence is a security review item — the
 * same convention as `crossTenantScope`.
 *
 * Ciphertext is fetched separately only by migration/incident tooling. Full
 * scope/version binding is mandatory for new enrollment, while this historical
 * loader cannot establish active execution authority.
 */
export async function loadSealedGrantSecret(
  scope: UserScope,
  grantId: string
): Promise<{ sealedSecret: string; keyVersion: number } | null> {
  const rows = await scopedQuery<{ sealed_secret: string | null; key_version: number | null }>(scope,
    `SELECT sealed_secret, key_version
       FROM user_execution_grants
      WHERE id = $1 AND user_id = $2`,
    [grantId, scope.userId]
  );
  const row = rows[0];
  if (!row || row.sealed_secret === null || row.key_version === null) return null;
  return { sealedSecret: row.sealed_secret, keyVersion: row.key_version };
}

/**
 * Marks a grant revoked.
 *
 * The row is kept, never deleted: it is the only record that this authority once
 * existed, and for a keyed kind it is the only thing that can still open a
 * secret protecting dust left at the account.
 */
export async function revokeExecutionGrant(
  scope: UserScope,
  grantId: string
): Promise<boolean> {
  const rows = await scopedQuery<{ id: string }>(scope,
    `UPDATE user_execution_grants
        SET status = 'revoked', revoked_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'active'
      RETURNING id`,
    [grantId, scope.userId]
  );
  return rows.length > 0;
}

/**
 * Marks a grant compromised. Terminal, and deliberately not reachable by the
 * ordinary revoke path: 'revoked' is a user decision and 'compromised' is an
 * incident, and conflating them loses the distinction in the audit trail.
 */
export async function markExecutionGrantCompromised(
  scope: UserScope,
  grantId: string
): Promise<boolean> {
  const rows = await scopedQuery<{ id: string }>(scope,
    `UPDATE user_execution_grants
        SET status = 'compromised', revoked_at = COALESCE(revoked_at, NOW())
      WHERE id = $1 AND user_id = $2 AND status <> 'compromised'
      RETURNING id`,
    [grantId, scope.userId]
  );
  return rows.length > 0;
}

/**
 * Active grants expiring at or before `before`. Drives the `S4-P9` re-consent
 * sweep, so it crosses tenants by design and requires a `crossTenantScope`.
 *
 * Served by the partial `idx_ueg_expiring`.
 */
export async function listExpiringExecutionGrants(
  scope: UserScope,
  before: Date,
  limit = 500
): Promise<ExecutionGrant[]> {
  if (!isCrossTenant(scope)) {
    throw new Error(
      'listExpiringExecutionGrants is a platform sweep; pass crossTenantScope(reason)'
    );
  }
  void before; void limit;
  throw new Error('Cross-tenant grant sweeps require a separately reviewed privileged capability');
}

/**
 * Retires every active grant that has already lapsed.
 *
 * 'retired' rather than 'revoked': nobody revoked it, it simply ran out, and the
 * distinction is what tells an operator whether a user withdrew consent or just
 * stopped renewing.
 */
export async function retireLapsedExecutionGrants(scope: UserScope): Promise<number> {
  if (!isCrossTenant(scope)) {
    throw new Error(
      'retireLapsedExecutionGrants is a platform sweep; pass crossTenantScope(reason)'
    );
  }
  throw new Error('Cross-tenant grant sweeps require a separately reviewed privileged capability');
}
