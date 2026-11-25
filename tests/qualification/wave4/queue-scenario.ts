import { assertion, hash, normalizeServerAddress, requireCheck, result, type QualificationConfig, type SqlClient } from './core.js';
import { Deadline } from './containment.js';
import { lpRequest, lpService, runtimeTransaction, syntheticDeposit } from './domains.js';
import { OwnedClients, inspectEnvironment, bindRedisIdentity } from './infrastructure.js';
import { OwnedQueueRuntime } from './queue-runtime.js';
import { lpJobName, queueIdentity, requireQueueJob, requirePendingJournal, requireCompletedJournal, requireRedelivery } from './queue-contract.js';
import { queueJournal, queueStream, requireEmptyQueueNamespace } from './queue-journal.js';
import { ownedQueueWorker } from './faults.js';
import type { UserScope } from '../../../packages/db/src/tenancy.js';

export async function qualifyQueueStall(client:SqlClient,config:QualificationConfig,userId:string,
  configPath:string,redisRunId:string,deadline:Deadline) {
  const clients = new OwnedClients(deadline);
  let queues:OwnedQueueRuntime | undefined;
  try {
    const runId = config.candidate.runId, scope = {userId} as UserScope;
    const addresses = await inspectEnvironment(config.candidate,'candidate',deadline);
    await runtimeTransaction(client,null,async c=>{
      const row = (await c.query('SELECT inet_server_addr()::text AS address,inet_server_port() AS port,current_database() AS database')).rows[0];
      requireCheck(normalizeServerAddress(row?.address) === addresses.postgres && row.port === 5432
        && row.database === new URL(config.candidate.postgres.url).pathname.slice(1),'Queue scenario runtime backend mismatch');
    });
    const redis = await clients.redis(config.candidate.redis.url,`wave4-queue-observer-${runId}`);
    await bindRedisIdentity(redis,addresses.redis,redisRunId);
    const service = lpService(client,runId,async ()=>{ throw new Error('Synthetic queue hint loss'); });
    const position = await service.acquire(scope,{...lpRequest(runId),operationKey:`bullmq-acquire-${runId}`});
    const admission = await service.requestOperation(scope,{positionId:position.id,operationKey:`bullmq-close-${runId}`,action:'close'});
    const input = {runId,userId,operationId:admission.operation.id}, identity = queueIdentity(input);
    const pending = await queueJournal(client,input);
    requirePendingJournal(pending,input);
    requireCheck(admission.queued === false && pending.status === 'pending' && pending.raw === syntheticDeposit.raw
      && pending.revision === '0' && pending.receipts === '0','Lost queue hint did not leave committed original inventory');
    await requireEmptyQueueNamespace(redis,input,deadline);
    queues = new OwnedQueueRuntime(deadline,config.candidate.redis.url,input,addresses.redis,redisRunId);
    const queue = await queues.queue(), events = await queues.events();
    const recovery = await lpService(client,runId,async data=>{
      requireCheck(hash(data) === hash(identity.data),'Recovery selected unrelated tenant operation');
      await queues!.track(queue.add(lpJobName,data,{jobId:identity.jobId,attempts:1,removeOnComplete:false,removeOnFail:false}));
    }).recover(scope);
    requireCheck(recovery.queued === 1 && recovery.deferred === 0,'Recovery did not admit exactly one durable pending operation');
    requireQueueJob(await queues.track(queue.getJob(identity.jobId)),input);
    const crash = await ownedQueueWorker({...input,configPath,redisRunId,point:'after-settlement-commit-before-ack'},deadline);
    requireCheck(crash.signal === 'SIGKILL' && !crash.ack,'Owned queue processor was not killed before resolution');
    const committed = await queueJournal(client,input);
    requireCompletedJournal(committed,input);
    const active: any = await queues.track(queue.getJob(identity.jobId));
    requireQueueJob(active,input);
    requireCheck(await queues.track(active.getState()) === 'active' && active.attemptsStarted === 1
      && active.stalledCounter === 0,'Killed processor already acknowledged or lost its retained active job');
    const replayService = lpService(client,runId);
    await queues.worker(async job=>{
      requireQueueJob(job,input);
      const outcome = await replayService.process(scope,identity.data);
      requireCheck(outcome.operation.status === 'completed','Redelivered processor has pending receipt');
      requireCompletedJournal(await queueJournal(client,input),input);
      return {operationId:identity.operationId,status:'completed'};
    });
    await queues.completed(active,events);
    const retained: any = await queues.track(queue.getJob(identity.jobId));
    requireQueueJob(retained,input);
    const state = await queues.track<string>(retained.getState());
    const streamRows = await redis.xrange(`${identity.prefix}:${identity.queue}:events`,'-','+','COUNT',1000);
    requireCheck(streamRows.length < 1000,'Owned queue stream evidence was truncated');
    const stream = queueStream(streamRows);
    requireRedelivery(retained,state,stream,input);
    const after = await queueJournal(client,input);
    requireCompletedJournal(after,input);
    requireCheck(hash(after) === hash(committed),'Redelivery changed immutable receipts, history or settled economics');
    return result('I6',[assertion('lost queue hint recovered from durable pending operation',true),
      assertion('owned BullMQ worker killed after checked SQL commit before processor resolution',true),
      assertion('same retained job normally stalled and redelivered exactly once',true),
      assertion('BullMQ completion and unchanged receipt-backed SQL economics reconciled',true)],[],{
      jobId:identity.jobId,queue:identity.queue,prefix:identity.prefix,attemptsStarted:retained.attemptsStarted,
      stalledCounter:retained.stalledCounter,stream,durableBeforeHash:hash(committed),durableAfterHash:hash(after),
      retention:'Qualification retains completed/failed job evidence; production removes these jobs',
      lockDurationMs:5000,stalledIntervalMs:1000,manualQueueRepair:false});
  } finally {
    const shutdown = new Deadline(5000);
    try {
      const closed = await Promise.allSettled([clients.close(shutdown),queues?.close(shutdown)]);
      shutdown.check();
      requireCheck(closed.every(r=>r.status==='fulfilled'),'Owned queue scenario cleanup failed');
    } finally { shutdown.dispose(); }
  }
}
