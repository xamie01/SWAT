import { Deadline } from './containment.js';
import { privateConfig } from './config.js';
import { OwnedClients, inspectEnvironment, bindPostgres, bindRedis } from './infrastructure.js';
import { lpService, runtimeTransaction } from './domains.js';
import { normalizeServerAddress, transaction, requireCheck } from './core.js';
import type { WorkerInput } from './faults.js';
import type { UserScope } from '../../../packages/db/src/tenancy.js';

async function point(name: string, deadline: Deadline): Promise<never> {
  deadline.check();
  process.send?.({ kind: 'point', point: name });
  return new Promise((_, reject) => {
    deadline.enroll(() => reject(new Error('Owned fault wait cancelled')));
  });
}
process.once('message', async (input: WorkerInput) => {
  const deadline = new Deadline(30_000);
  const clients = new OwnedClients(deadline);
  const close = async () => {
    deadline.abort();
    const shutdown = new Deadline(5000);
    try { await clients.close(shutdown); }
    finally { shutdown.dispose(); deadline.dispose(); }
  };
  try {
    const config = await privateConfig(input.configPath);
    requireCheck(input.runId === config.candidate.runId, 'Child run identity mismatch');
    const addresses = await inspectEnvironment(config.candidate, 'candidate', deadline);
    const migrator = await clients.postgres(config.candidate.postgres.url, `wave4-child-identity-${config.candidate.runId}`);
    await bindPostgres(migrator, config.candidate, addresses.postgres, deadline);
    const redis = await clients.redis(config.candidate.redis.url, `wave4-child-${config.candidate.runId}`);
    await bindRedis(redis, addresses.redis);
    const client = await clients.postgres(config.runtimeUrl, `wave4-child-runtime-${config.candidate.runId}`);
    await runtimeTransaction(client, null, async c => {
      const row = (await c.query('SELECT inet_server_addr()::text AS address,inet_server_port() AS port,current_database() AS database')).rows[0];
      requireCheck(normalizeServerAddress(row.address) === addresses.postgres && row.port === 5432
        && row.database === new URL(config.candidate.postgres.url).pathname.slice(1), 'Child runtime backend differs from inspected candidate');
    });
    const original = client.query.bind(client);
    let writes = false;
    client.query = async (sql: string, values?: unknown[]) => {
      if (/^INSERT INTO lp_exact_receipts/.test(sql)) writes = true;
      if (sql === 'COMMIT' && writes && input.point === 'before-settlement-commit') await point(input.point, deadline);
      const response = await original(sql, values);
      if (sql === 'COMMIT' && writes && input.point === 'after-settlement-commit-before-ack') await point(input.point, deadline);
      if (sql === 'COMMIT') writes = false;
      return response;
    };
    const scope = { userId: input.userId } as UserScope;
    const service = lpService(client, config.candidate.runId);
    const admission = await runtimeTransaction(client, input.userId, c => c.query(`SELECT o.id FROM lp_exact_operations o
      JOIN lp_exact_positions p ON p.position_id=o.position_id AND p.user_id=o.user_id
      WHERE o.id=$1 AND o.user_id=$2 AND p.acquisition_key=$3`,
      [input.operationId, input.userId, `fault-${input.point === 'none' ? '' : input.point}-${config.candidate.runId}`]));
    // Restart keys are looked up independently below; caller supplied UUIDs alone are not a run binding.
    if (input.point !== 'none') requireCheck(admission.rows.length === 1, 'Run-bound fault operation required');
    const binding = await runtimeTransaction(client, input.userId, c => c.query(`SELECT e.acquisition_key FROM lp_exact_positions e
      JOIN lp_exact_operations o ON o.position_id=e.position_id AND o.user_id=e.user_id WHERE o.id=$1`, [input.operationId]));
    requireCheck(binding.rows.length === 1 && [
      `fault-before-settlement-commit-${config.candidate.runId}`,
      `fault-after-settlement-commit-before-ack-${config.candidate.runId}`].includes(binding.rows[0].acquisition_key), 'Fault operation not owned by this run');
    const outcome = await service.process(scope, { operationId: input.operationId, chain: 'solana' });
    requireCheck(outcome.operation.status === 'completed', 'Paper worker did not settle');
    const persisted = await transaction(client, input.userId, c => c.query(`SELECT o.status,
      (SELECT count(*)::text FROM lp_exact_receipts WHERE operation_id=o.id) AS receipts
      FROM lp_exact_operations o WHERE o.id=$1`, [input.operationId]));
    requireCheck(persisted.rows[0]?.status === 'completed' && persisted.rows[0]?.receipts === '1', 'Durable completion journal required before ack');
    await close();
    process.send?.({ kind: 'ack', operationId: input.operationId, runId: config.candidate.runId }, () => process.disconnect());
  } catch {
    await close().catch(() => {});
    process.send?.({ kind: 'failed' }, () => process.disconnect());
    process.exitCode = 1;
  }
});
