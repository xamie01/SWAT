import type { ExecutionGrant } from './execution-grants.js';
import { EXECUTION_GRANT_PUBLIC_COLUMNS as PUBLIC_COLUMNS, projectExecutionGrant as project } from './execution-grant-projection.js';
import type { UserScope } from './tenancy.js';
import type { CustodyEnrollmentRecord, CustodyEnrollmentStore } from './custody-enrollment.js';
import type { CustodyExecutionStore } from './custody-execution.js';
import { assertCustodyBindingMatches, assertCustodyEnvelope, custodyGrantId, custodyIdentifier,
  CustodyContractError, custodyPolicySnapshot, type CustodyGrantSnapshot, type CustodySecretBinding } from './custody-contract.js';

export interface CustodySqlClient {
  query<T>(sql: string, values: unknown[]): Promise<{ rows: T[] }>;
}
/** Integration must pin checked role + tenant RLS on this same client and require a real COMMIT. */
export type CustodyTenantTransaction = <T>(scope: UserScope, operation: (client: CustodySqlClient) => Promise<T>) => Promise<T>;
interface Row {
  id: string; user_id: string; chain: ExecutionGrant['chain']; grant_kind: ExecutionGrant['grantKind'];
  account_address: string; sealed_secret?: string | null; has_sealed_secret: boolean; key_version: number | null;
  secret_binding?: CustodySecretBinding | null; scope_policy: unknown; expires_at: Date | null;
  revoked_at: Date | null; status: ExecutionGrant['status']; created_at: Date;
  lifecycle_revision: string; revocation_tombstone: Date | null;
}
/** Internal builder; callers receive only a role-specific interface below. */
function custodyGrantStore(transaction: CustodyTenantTransaction): CustodyEnrollmentStore & CustodyExecutionStore {
  return {
    async record(scope: UserScope, input: CustodyEnrollmentRecord): Promise<ExecutionGrant> {
      scope = { userId: scope.userId } as UserScope;
      input = { ...input, scopePolicy: custodyPolicySnapshot(input.scopePolicy),
        secretBinding: input.secretBinding ? structuredClone(input.secretBinding) : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null };
      custodyIdentifier(scope.userId); custodyGrantId(input.id);
      const keyless = input.grantKind === 'solana_vault';
      if (keyless) {
        if (input.secretBinding !== null || input.sealedSecret !== null || input.keyVersion !== null) throw new CustodyContractError('custody-invalid');
      } else {
        if (!input.secretBinding || !input.sealedSecret || input.keyVersion === null) throw new CustodyContractError('custody-invalid');
        assertCustodyBindingMatches(input.secretBinding, { ...input, userId: scope.userId });
        assertCustodyEnvelope(input.sealedSecret, input.keyVersion);
      }
      return transaction(scope, async client => {
        const rows = await client.query<Row>(`INSERT INTO user_execution_grants
          (id, user_id, chain, grant_kind, account_address, sealed_secret, key_version, secret_binding, scope_policy, expires_at)
          VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
          ON CONFLICT (id) DO NOTHING RETURNING ${PUBLIC_COLUMNS}`,
          [input.id, scope.userId, input.chain, input.grantKind, input.accountAddress, input.sealedSecret,
            input.keyVersion, input.secretBinding ? JSON.stringify(input.secretBinding) : null, JSON.stringify(input.scopePolicy ?? null), input.expiresAt]);
        if (rows.rows.length !== 1) throw new CustodyContractError('custody-conflict');
        return project(rows.rows[0]!);
      });
    },
    async load(scope, grantId): Promise<CustodyGrantSnapshot | null> {
      custodyIdentifier(scope.userId); custodyGrantId(grantId);
      return transaction(scope, async client => {
        const result = await client.query<Row>(`SELECT ${PUBLIC_COLUMNS}, sealed_secret, secret_binding,
          lifecycle_revision::text AS lifecycle_revision, revocation_tombstone
          FROM user_execution_grants WHERE id = $1::uuid AND user_id = $2::uuid`, [grantId, scope.userId]);
        if (result.rows.length !== 1) return null;
        const row = result.rows[0]!;
        return { ...project(row), sealedSecret: row.sealed_secret ?? null, secretBinding: row.secret_binding ?? null,
          lifecycleRevision: row.lifecycle_revision, revocationTombstone: row.revocation_tombstone };
      });
    }
  };
}

/** API enrollment receives only this write capability, never the execution secret loader. */
export function createCustodyEnrollmentStore(transaction: CustodyTenantTransaction): CustodyEnrollmentStore {
  const { record } = custodyGrantStore(transaction);
  return { record };
}
/** Executor receives only its read capability; identity and RLS integration remain mandatory. */
export function createCustodyExecutionStore(transaction: CustodyTenantTransaction): CustodyExecutionStore {
  const { load } = custodyGrantStore(transaction);
  return { load };
}
