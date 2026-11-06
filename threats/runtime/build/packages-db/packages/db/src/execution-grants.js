import { resolveChainAddress } from '@swat/shared';
import { query } from './client.js';
import { isCrossTenant } from './tenancy.js';
/**
 * Grant kinds that hold no secret, as a set — mirroring the SQL
 * `grant_kind = ANY (ARRAY['solana_vault'])`.
 *
 * A Solana vault is a PDA: there is no key, so there is nothing to seal. Adding a
 * second keyless venue means editing this array and the array in the migration's
 * CHECK, and nothing else.
 */
export const KEYLESS_GRANT_KINDS = ['solana_vault'];
export function isKeylessGrantKind(kind) {
    return KEYLESS_GRANT_KINDS.includes(kind);
}
/** Kinds that are a time-boxed delegation rather than a standing key. */
const EXPIRING_GRANT_KINDS = ['eip7702', 'session_key_4337'];
export function grantKindRequiresExpiry(kind) {
    return EXPIRING_GRANT_KINDS.includes(kind);
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
function toGrant(row) {
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
    constructor(message) {
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
/**
 * Validates the invariant the database also enforces, so the caller gets a
 * message naming the kind rather than a constraint violation.
 *
 * Exported for the API's request validation, which needs the same answer before
 * it has a database connection.
 */
export function assertGrantSecretMatchesKind(input) {
    const keyless = isKeylessGrantKind(input.grantKind);
    const hasSecret = input.sealedSecret !== null && input.sealedSecret !== undefined;
    const hasVersion = input.keyVersion !== null && input.keyVersion !== undefined;
    if (keyless) {
        if (hasSecret || hasVersion) {
            throw new InvalidExecutionGrantError(`${input.grantKind} is keyless and must carry no sealed secret or key version`);
        }
        return;
    }
    if (!hasSecret || !hasVersion) {
        throw new InvalidExecutionGrantError(`${input.grantKind} requires a sealed secret and a key version`);
    }
    // Mirrors the `sealed_secret LIKE 'v%'` tripwire: reject anything that is not a
    // versioned envelope before it reaches the database, so the failure names the
    // format rather than the constraint.
    if (!/^v\d+\./.test(input.sealedSecret)) {
        throw new InvalidExecutionGrantError('sealed secret must be a versioned envelope, e.g. v1.<wrapperId>.…');
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
export function normalizeGrantAccountAddress(chain, accountAddress) {
    try {
        return resolveChainAddress(accountAddress, chain).raw;
    }
    catch (error) {
        throw new InvalidExecutionGrantError(`account_address is not a valid ${chain} address: ${error.message}`);
    }
}
/**
 * Inserts a grant.
 *
 * `user_id` comes from `scope`, never from the input — the input type has no
 * `userId` field, which is the point.
 */
export async function recordExecutionGrant(scope, input) {
    assertGrantSecretMatchesKind(input);
    if (grantKindRequiresExpiry(input.grantKind) && !input.expiresAt) {
        throw new InvalidExecutionGrantError(`${input.grantKind} requires expires_at — a scoped grant with no expiry is not scoped`);
    }
    const accountAddress = normalizeGrantAccountAddress(input.chain, input.accountAddress);
    try {
        const rows = await query(`INSERT INTO user_execution_grants
         (user_id, chain, grant_kind, account_address, sealed_secret, key_version,
          scope_policy, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${GRANT_COLUMNS}`, [
            scope.userId,
            input.chain,
            input.grantKind,
            accountAddress,
            input.sealedSecret ?? null,
            input.keyVersion ?? null,
            input.scopePolicy === undefined ? null : JSON.stringify(input.scopePolicy),
            input.expiresAt ?? null
        ]);
        return toGrant(rows[0]);
    }
    catch (error) {
        // 23505 is a unique violation. Both the partial active index and the global
        // account uniqueness land here; the caller's remedy is the same either way —
        // revoke the existing grant first.
        if (error.code === '23505')
            throw new ExecutionGrantConflictError();
        throw error;
    }
}
export async function listExecutionGrants(scope) {
    const rows = await query(`SELECT ${GRANT_COLUMNS}
       FROM user_execution_grants
      WHERE user_id = $1
      ORDER BY created_at DESC`, [scope.userId]);
    return rows.map(toGrant);
}
/**
 * The one active grant for a (user, chain, kind), or null.
 *
 * Single-row by construction: `uq_ueg_active_per_user_chain_kind` is the
 * guarantee, so this does not need a `LIMIT` to be deterministic.
 */
export async function findActiveExecutionGrant(scope, chain, grantKind) {
    const rows = await query(`SELECT ${GRANT_COLUMNS}
       FROM user_execution_grants
      WHERE user_id = $1 AND chain = $2 AND grant_kind = $3 AND status = 'active'`, [scope.userId, chain, grantKind]);
    return rows[0] ? toGrant(rows[0]) : null;
}
/**
 * Reads the sealed envelope for one grant.
 *
 * **Only useful inside a process that holds a wrapper key**, which is
 * `trade-executor` and nothing else. Named separately from every other read so
 * that `grep -rn loadSealedGrantSecret` returns the complete list of places the
 * ciphertext is fetched, and any new occurrence is a security review item — the
 * same convention as `crossTenantScope`.
 *
 * Still scoped by `user_id`. The envelope's AAD binds the ciphertext to
 * `(userId, chainKind, keyVersion)`, so opening it under the wrong user fails on
 * the auth tag — but a query that could fetch another tenant's ciphertext at all
 * should not exist, whether or not the next step would fail.
 */
export async function loadSealedGrantSecret(scope, grantId) {
    const rows = await query(`SELECT sealed_secret, key_version
       FROM user_execution_grants
      WHERE id = $1 AND user_id = $2`, [grantId, scope.userId]);
    const row = rows[0];
    if (!row || row.sealed_secret === null || row.key_version === null)
        return null;
    return { sealedSecret: row.sealed_secret, keyVersion: row.key_version };
}
/**
 * Marks a grant revoked.
 *
 * The row is kept, never deleted: it is the only record that this authority once
 * existed, and for a keyed kind it is the only thing that can still open a
 * secret protecting dust left at the account.
 */
export async function revokeExecutionGrant(scope, grantId) {
    const rows = await query(`UPDATE user_execution_grants
        SET status = 'revoked', revoked_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'active'
      RETURNING id`, [grantId, scope.userId]);
    return rows.length > 0;
}
/**
 * Marks a grant compromised. Terminal, and deliberately not reachable by the
 * ordinary revoke path: 'revoked' is a user decision and 'compromised' is an
 * incident, and conflating them loses the distinction in the audit trail.
 */
export async function markExecutionGrantCompromised(scope, grantId) {
    const rows = await query(`UPDATE user_execution_grants
        SET status = 'compromised', revoked_at = COALESCE(revoked_at, NOW())
      WHERE id = $1 AND user_id = $2 AND status <> 'compromised'
      RETURNING id`, [grantId, scope.userId]);
    return rows.length > 0;
}
/**
 * Active grants expiring at or before `before`. Drives the `S4-P9` re-consent
 * sweep, so it crosses tenants by design and requires a `crossTenantScope`.
 *
 * Served by the partial `idx_ueg_expiring`.
 */
export async function listExpiringExecutionGrants(scope, before, limit = 500) {
    if (!isCrossTenant(scope)) {
        throw new Error('listExpiringExecutionGrants is a platform sweep; pass crossTenantScope(reason)');
    }
    const rows = await query(`SELECT ${GRANT_COLUMNS}
       FROM user_execution_grants
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= $1
      ORDER BY expires_at
      LIMIT $2`, [before, limit]);
    return rows.map(toGrant);
}
/**
 * Retires every active grant that has already lapsed.
 *
 * 'retired' rather than 'revoked': nobody revoked it, it simply ran out, and the
 * distinction is what tells an operator whether a user withdrew consent or just
 * stopped renewing.
 */
export async function retireLapsedExecutionGrants(scope) {
    if (!isCrossTenant(scope)) {
        throw new Error('retireLapsedExecutionGrants is a platform sweep; pass crossTenantScope(reason)');
    }
    const rows = await query(`UPDATE user_execution_grants
        SET status = 'retired'
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()
      RETURNING id`);
    return rows.length;
}
//# sourceMappingURL=execution-grants.js.map