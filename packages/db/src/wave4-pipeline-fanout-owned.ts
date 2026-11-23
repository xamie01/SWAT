import { createCheckedPipelineTransaction, readPipelineBackendApproval,
  type PipelineClientLease, type PipelineProtectedTransaction, type PoolClient } from './wave4-pipeline-source-owned.js';

export type { PoolClient } from './wave4-pipeline-source-owned.js';
/** Concrete direct swat_fanout backing. SQL071 direct service policies are only
 * necessary conditions: independently approved backend registry is checked on
 * EACH transaction, before work and before checked COMMIT. No role membership,
 * SET ROLE, tenant scope, app-pool fallback, or client-label grant. */
export function createProtectedFanoutTransaction(acquire: () => Promise<PipelineClientLease>): PipelineProtectedTransaction {
  return createCheckedPipelineTransaction({ acquire,purpose: 'fanout',authorityId: '' });
}
/** Narrow read fence for compositions that reuse their already-owned client. */
export async function requireProtectedFanoutClient(client: PoolClient): Promise<void> {
  await readPipelineBackendApproval(client,'fanout','');
}
