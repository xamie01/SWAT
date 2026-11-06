import type { Chain } from '@swat/shared';
import { type UserScope } from './tenancy.js';
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
export type GrantKind = 'solana_vault' | 'eip7702' | 'session_key_4337' | 'polymarket_signer';
export type GrantStatus = 'active' | 'retired' | 'revoked' | 'compromised';
/**
 * Grant kinds that hold no secret, as a set — mirroring the SQL
 * `grant_kind = ANY (ARRAY['solana_vault'])`.
 *
 * A Solana vault is a PDA: there is no key, so there is nothing to seal. Adding a
 * second keyless venue means editing this array and the array in the migration's
 * CHECK, and nothing else.
 */
export declare const KEYLESS_GRANT_KINDS: readonly GrantKind[];
export declare function isKeylessGrantKind(kind: GrantKind): boolean;
export declare function grantKindRequiresExpiry(kind: GrantKind): boolean;
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
/**
 * The grant violates the keyless/keyed invariant, or a session grant has no
 * expiry.
 *
 * Distinct from a generic error so the API can map it to a 400 rather than a 500:
 * every case is a malformed request, not a server fault.
 */
export declare class InvalidExecutionGrantError extends Error {
    constructor(message: string);
}
/** An active grant already exists for this (user, chain, kind). */
export declare class ExecutionGrantConflictError extends Error {
    constructor();
}
export interface RecordExecutionGrantInput {
    readonly chain: Chain;
    readonly grantKind: GrantKind;
    /**
     * The settlement account. Stored unprefixed; normalised and validated by
     * `normalizeGrantAccountAddress`, so a mixed-case EVM address or a prefixed
     * `polygon:0x…` from a `copy_positions` join is accepted and written in the one
     * form the column holds.
     */
    readonly accountAddress: string;
    /** The `v1.<wrapperId>.…` envelope. Omit or pass null for a keyless kind. */
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
export declare function assertGrantSecretMatchesKind(input: {
    grantKind: GrantKind;
    sealedSecret?: string | null;
    keyVersion?: number | null;
}): void;
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
export declare function normalizeGrantAccountAddress(chain: Chain, accountAddress: string): string;
/**
 * Inserts a grant.
 *
 * `user_id` comes from `scope`, never from the input — the input type has no
 * `userId` field, which is the point.
 */
export declare function recordExecutionGrant(scope: UserScope, input: RecordExecutionGrantInput): Promise<ExecutionGrant>;
export declare function listExecutionGrants(scope: UserScope): Promise<ExecutionGrant[]>;
/**
 * The one active grant for a (user, chain, kind), or null.
 *
 * Single-row by construction: `uq_ueg_active_per_user_chain_kind` is the
 * guarantee, so this does not need a `LIMIT` to be deterministic.
 */
export declare function findActiveExecutionGrant(scope: UserScope, chain: Chain, grantKind: GrantKind): Promise<ExecutionGrant | null>;
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
export declare function loadSealedGrantSecret(scope: UserScope, grantId: string): Promise<{
    sealedSecret: string;
    keyVersion: number;
} | null>;
/**
 * Marks a grant revoked.
 *
 * The row is kept, never deleted: it is the only record that this authority once
 * existed, and for a keyed kind it is the only thing that can still open a
 * secret protecting dust left at the account.
 */
export declare function revokeExecutionGrant(scope: UserScope, grantId: string): Promise<boolean>;
/**
 * Marks a grant compromised. Terminal, and deliberately not reachable by the
 * ordinary revoke path: 'revoked' is a user decision and 'compromised' is an
 * incident, and conflating them loses the distinction in the audit trail.
 */
export declare function markExecutionGrantCompromised(scope: UserScope, grantId: string): Promise<boolean>;
/**
 * Active grants expiring at or before `before`. Drives the `S4-P9` re-consent
 * sweep, so it crosses tenants by design and requires a `crossTenantScope`.
 *
 * Served by the partial `idx_ueg_expiring`.
 */
export declare function listExpiringExecutionGrants(scope: UserScope, before: Date, limit?: number): Promise<ExecutionGrant[]>;
/**
 * Retires every active grant that has already lapsed.
 *
 * 'retired' rather than 'revoked': nobody revoked it, it simply ran out, and the
 * distinction is what tells an operator whether a user withdrew consent or just
 * stopped renewing.
 */
export declare function retireLapsedExecutionGrants(scope: UserScope): Promise<number>;
//# sourceMappingURL=execution-grants.d.ts.map