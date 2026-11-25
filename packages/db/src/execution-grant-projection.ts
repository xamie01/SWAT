import type { ExecutionGrant } from './execution-grants.js';

// SQL047 chk_ueg_secret_matches_kind pairs key_version and ciphertext presence.
// Public metadata must not require SELECT on the ciphertext column.
export const EXECUTION_GRANT_PUBLIC_COLUMNS = `id, user_id, chain, grant_kind, account_address,
  key_version IS NOT NULL AS has_sealed_secret, key_version, scope_policy,
  expires_at, revoked_at, status, created_at`;

export interface ExecutionGrantProjectionRow {
  readonly id: string;
  readonly user_id: string;
  readonly chain: ExecutionGrant['chain'];
  readonly grant_kind: ExecutionGrant['grantKind'];
  readonly account_address: string;
  readonly has_sealed_secret: boolean;
  readonly key_version: number | null;
  readonly scope_policy: unknown;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly status: ExecutionGrant['status'];
  readonly created_at: Date;
}

export function projectExecutionGrant(row: ExecutionGrantProjectionRow): ExecutionGrant {
  return { id: row.id, userId: row.user_id, chain: row.chain, grantKind: row.grant_kind,
    accountAddress: row.account_address, hasSealedSecret: row.key_version !== null && Boolean(row.has_sealed_secret),
    keyVersion: row.key_version, scopePolicy: row.scope_policy, expiresAt: row.expires_at,
    revokedAt: row.revoked_at, status: row.status, createdAt: row.created_at };
}
