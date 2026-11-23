import type { PoolClient } from 'pg';
export type { PoolClient };

export type AuditActorType = 'user' | 'admin' | 'service' | 'anonymous';
export interface AuditEventInput {
  readonly actorType: AuditActorType;
  readonly actorId?: string | null;
  readonly event: string;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly metadata?: Record<string, unknown>;
}
export interface AuditSqlClient {
  query(sql: string, values: unknown[]): Promise<unknown>;
}
/** Canonical strict append, shared by ambient compatibility and owned custody.
 * Caller controls acquisition/tenant/transaction/COMMIT; no fallback pool. */
export async function recordAuditEventStrictWithClient(input: AuditEventInput, client: AuditSqlClient): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (actor_type, actor_id, event, target_type, target_id, ip, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.actorType,
      input.actorId ?? null,
      input.event,
      input.targetType ?? null,
      input.targetId ?? null,
      input.ip ?? null,
      input.userAgent?.slice(0, 256) ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}
