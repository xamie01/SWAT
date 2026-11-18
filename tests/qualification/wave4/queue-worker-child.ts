import { Deadline } from './containment.js';
import { privateConfig } from './config.js';
import { OwnedClients, inspectEnvironment, bindPostgres, bindRedisIdentity } from './infrastructure.js';
import { lpService, runtimeTransaction } from './domains.js';
import { requireCheck } from './core.js';
import { OwnedQueueRuntime } from './queue-runtime.js';
import { queueIdentity, requireQueueJob, requirePendingJournal, requireCompletedJournal } from './queue-contract.js';
import { queueJournal } from './queue-journal.js';
import type { QueueWorkerInput } from './faults.js';
import type { UserScope } from '../../../packages/db/src/tenancy.js';

function cancelled(deadline:Deadline):Promise<never> {
  return new Promise((_,reject)=>{
    if (deadline.signal.aborted) { reject(new Error('Owned queue child cancelled')); return; }
    deadline.signal.addEventListener('abort',()=>reject(new Error('Owned queue child cancelled')),{once:true});
  });
}
process.once('message',async (input:QueueWorkerInput)=>{
  const deadline = new Deadline(30_000), clients = new OwnedClients(deadline);
  let queues:OwnedQueueRuntime | undefined;
  try {
    const identity = queueIdentity(input);
    requireCheck(input.point === 'after-settlement-commit-before-ack' && /^[a-f0-9]{40}$/.test(input.redisRunId), 'Owned queue fault boundary invalid');
    const config = await privateConfig(input.configPath);
    requireCheck(identity.runId === config.candidate.runId,'Queue child run mismatch');
    const addresses = await inspectEnvironment(config.candidate,'candidate',deadline);
    const migrator = await clients.postgres(config.candidate.postgres.url,`wave4-queue-child-identity-${identity.runId}`);
    await bindPostgres(migrator,config.candidate,addresses.postgres,deadline);
    const redis = await clients.redis(config.candidate.redis.url,`wave4-queue-child-binding-${identity.runId}`);
    await bindRedisIdentity(redis,addresses.redis,input.redisRunId);
    const client = await clients.postgres(config.runtimeUrl,`wave4-queue-child-runtime-${identity.runId}`);
    await runtimeTransaction(client,null,async c=>{
      const row = (await c.query('SELECT inet_server_addr()::text AS address,inet_server_port() AS port,current_database() AS database')).rows[0];
      requireCheck(row?.address === addresses.postgres && row.port === 5432
        && row.database === new URL(config.candidate.postgres.url).pathname.slice(1),'Queue child backend differs from inspected candidate');
    });
    const before = await queueJournal(client,input);
    requirePendingJournal(before,input);
    const original = client.query.bind(client);
    let receiptWrite = false, committedReceipt = false;
    client.query = async (sql:string,values?:unknown[])=>{
      if (/^INSERT INTO lp_exact_receipts/.test(sql)) receiptWrite = true;
      const response = await original(sql,values);
      if (sql === 'COMMIT') {
        requireCheck(response.command === 'COMMIT','Queue settlement COMMIT was not acknowledged');
        if (receiptWrite) committedReceipt = true;
        receiptWrite = false;
      } else if (sql === 'ROLLBACK') receiptWrite = false;
      return response;
    };
    const service = lpService(client,identity.runId);
    queues = new OwnedQueueRuntime(deadline,config.candidate.redis.url,input,addresses.redis,input.redisRunId);
    await queues.worker(async job=>{
      requireQueueJob(job,input);
      const outcome = await service.process({userId:identity.userId} as UserScope,identity.data);
      requireCheck(outcome.operation.status === 'completed' && committedReceipt,'Queue processor did not commit receipt-backed settlement');
      requireCompletedJournal(await queueJournal(client,input),input);
      deadline.check();
      requireCheck(typeof process.send === 'function','Owned queue child IPC unavailable');
      process.send!({kind:'point',point:input.point,runId:identity.runId,operationId:identity.operationId},error=>{ if (error) deadline.abort(); });
      return cancelled(deadline);
    });
    await cancelled(deadline);
  } catch {
    process.exitCode = 1;
  } finally {
    deadline.abort();
    const shutdown = new Deadline(5000);
    try { await Promise.allSettled([clients.close(shutdown),queues?.close(shutdown)]); }
    finally { shutdown.dispose(); deadline.dispose(); }
    if (process.connected) process.send?.({kind:'failed'},()=>process.disconnect());
  }
});
