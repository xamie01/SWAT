import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Deadline } from './containment.js';
import { queueIdentity, requireQueueJob, requireCompletedJournal, requireRedelivery, type QueueJournal } from './queue-contract.js';
import { requireEmptyQueueNamespace, queueStream } from './queue-journal.js';
import { bindRedis, bindRedisIdentity } from './infrastructure.js';
import { OwnedQueueRedis } from './queue-redis.js';
import { OwnedQueueRuntime, type QueueFactories } from './queue-runtime.js';
import { ownedQueueWorker } from './faults.js';
import { lpExactHash } from '../../../packages/db/src/lp-exact.js';

const mocks = vi.hoisted(()=>({fork:vi.fn()}));
vi.mock('node:child_process',()=>({fork:mocks.fork,execFile:vi.fn()}));
const input = {runId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',operationId:'33333333-3333-4333-8333-333333333333'};
const positionId = '44444444-4444-4444-8444-444444444444', redisRunId = 'a'.repeat(40);
const identity = queueIdentity(input);
const job = ()=>({id:identity.jobId,name:'lp-paper-operation',data:{...identity.data},attemptsStarted:2,stalledCounter:1});
const stream = ()=>['active','stalled','active','completed'].map(event=>({event,jobId:identity.jobId}));
function journal():QueueJournal {
  const amount={raw:'900719925474099312345',scale:18},zero={raw:'0',scale:18},basis=(BigInt(amount.raw)*1234567n/10n**18n).toString();
  const fingerprint=lpExactHash({positionId,action:'close',revision:'0',amountBefore:amount,chain:'solana',poolAddress:'solana:wave4-pool',depositAsset:'solana:wave4-mint'});
  const quote={providerId:`wave4-${input.runId}`,userId:input.userId,action:'close',mode:'paper',intentHash:fingerprint,
    pool:{networkId:`solana:wave4-${input.runId}`},quoteId:'close-quote',observedAt:'2026-11-18T12:00:00.000Z',
    deposit:amount,amountAfter:zero,unitPriceUsd:{raw:'1234567',scale:6},valueMicroUsd:basis,proceedsMicroUsd:basis};
  const acquisition={id:positionId,userId:input.userId,acquisitionKey:identity.acquisitionKey,mode:'paper',chain:'solana',protocol:'meteora-dlmm',
    poolAddress:'solana:wave4-pool',depositAsset:'solana:wave4-mint',deposit:amount,currentAmount:amount,revision:'0',state:'active',
    cumulativeFeesMicroUsd:'0',cumulativeCostsMicroUsd:'0',realizedMicroUsd:null,depositMicroUsd:basis,
    acquisitionFingerprint:lpExactHash({chain:'solana',poolAddress:'solana:wave4-pool',depositAsset:'solana:wave4-mint',deposit:amount,
      strategy:{distribution:'spot',rangeLower:90,rangeUpper:110,rungCount:1},autoRebalance:true,origin:null}),autoRebalance:true,copyOrigin:null,
    acquisitionQuote:{version:1,action:'acquire',mode:'paper',userId:input.userId,providerId:`wave4-${input.runId}`,quoteId:'acquire-quote',
      intentHash:lpExactHash({chain:'solana',poolAddress:'solana:wave4-pool',depositAsset:'solana:wave4-mint',deposit:amount,
        strategy:{distribution:'spot',rangeLower:90,rangeUpper:110,rungCount:1},autoRebalance:true,origin:null}),
      pool:{chain:'solana',networkId:`solana:wave4-${input.runId}`,protocol:'meteora-dlmm',poolAddress:'solana:wave4-pool',depositAsset:'solana:wave4-mint',depositScale:18},
      deposit:amount,amountAfter:amount,proceedsMicroUsd:'0',valueMicroUsd:basis,unitPriceUsd:{raw:'1234567',scale:6}}};
  const operationKey=`bullmq-close-${input.runId}`,receiptKey=`lp-receipt-${lpExactHash([input.userId,operationKey,fingerprint])}`;
  const receipt={version:1,providerId:`wave4-${input.runId}`,receiptId:`receipt-${input.operationId}`,mode:'paper',action:'close',positionRevision:'0',
    networkId:`solana:wave4-${input.runId}`,chain:'solana',protocol:'meteora-dlmm',poolAddress:acquisition.poolAddress,depositAsset:acquisition.depositAsset,
    userId:input.userId,positionId,receiptKey,finality:'paper-settled',quoteId:quote.quoteId,quoteHash:lpExactHash(quote),
    amountBefore:amount,amountAfter:zero,proceedsMicroUsd:basis,collectedFeesMicroUsd:'100000',executionCostsMicroUsd:'50000',settledAt:quote.observedAt};
  return {...input,positionId,acquisitionKey:identity.acquisitionKey,status:'completed',raw:'0',revision:'1',receipts:'1',fees:'100000',costs:'50000',realized:'50000',
    operation:{id:input.operationId,userId:input.userId,positionId,status:'completed',action:'close',receiptKey,operationKey,fingerprint,positionRevision:'0',amountBefore:amount,quote,receipt},
    position:{...acquisition,currentAmount:zero,lastReceiptKey:receiptKey,revision:'1',state:'closed',cumulativeFeesMicroUsd:'100000',cumulativeCostsMicroUsd:'50000',realizedMicroUsd:'50000'},acquisition,receipt,
    receiptRow:{operation_id:input.operationId,position_id:positionId,user_id:input.userId,receipt_key:receiptKey,provider_id:receipt.providerId,
      receipt_id:receipt.receiptId,receipt_hash:lpExactHash(receipt),data:receipt},legacyState:'closed',legacy:{id:positionId,user_id:input.userId,state:'closed'},
    history:[{from_state:null,to_state:'building'},{from_state:'building',to_state:'active'},{from_state:'active',to_state:'closed'}].map(h=>({...h,position_id:positionId}))};
}
function redisClient():any {
  const client:any = new EventEmitter(); client.status = 'wait';
  client.connect = vi.fn(async ()=>{client.status='ready';});
  client.sendCommand = vi.fn(async ()=>'OK');
  client.info = vi.fn(async ()=>`redis_version:7.4.0\r\nrun_id:${redisRunId}\r\n`);
  client.call = vi.fn(async ()=>'id=1 laddr=172.18.0.3:6379 db=0 flags=N');
  client.dbsize = vi.fn(async ()=>42);
  client.disconnect = vi.fn((reconnect:boolean)=>{expect(reconnect).toBe(false);client.status='end';client.emit('end');});
  client.duplicate = vi.fn(()=>redisClient());
  return client;
}
const deadlines:Deadline[] = [];
function deadline(ms=5000) {const d=new Deadline(ms);deadlines.push(d);return d;}
afterEach(()=>{for (const d of deadlines.splice(0)) d.dispose();vi.clearAllMocks();});

describe('BullMQ qualification contracts: mocked handles only, no queues or sockets',()=>{
  it('derives queue scope internally and matches the production LP identity',()=>{
    expect(identity.prefix).toBe(`swat:integration:${input.runId}:wave4-lp-stall`);
    expect(identity.queue).toBe('swat-lp-exec-solana'); expect(identity.jobId).toBe(`lp-op-${input.operationId}`);
  });
  it.each(['runId','userId','operationId'])('refuses invalid %s before any queue resource exists',field=>{
    expect(()=>queueIdentity({...input,[field]:'*'})).toThrow();
  });
  it.each(['id','name','userId','operationId','chain','extra'])('rejects job substitution %s',field=>{
    const value:any=job(); if (field==='id'||field==='name') value[field]='other'; else value.data[field]='other';
    expect(()=>requireQueueJob(value,input)).toThrow();
  });
  it('requires exact durable economics independently of BullMQ',()=>{
    expect(()=>requireCompletedJournal(journal(),input)).not.toThrow();
    requireRedelivery(job(),'completed',stream(),input);
  });
  it.each(['status','raw','revision','receipts','fees','costs','realized','acquisitionKey','legacyState'])('rejects incorrect durable %s even with queue completion',field=>{
    expect(()=>requireCompletedJournal({...journal(),[field]:'wrong'},input)).toThrow();
  });
  it.each(['userId','providerId','action','intentHash','pool'])('rejects missing or substituted acquisition quote provenance %s',field=>{
    for (const missing of [false,true]) {
      const value=journal();if (missing) delete value.acquisition.acquisitionQuote[field];else value.acquisition.acquisitionQuote[field]='wrong';
      expect(()=>requireCompletedJournal(value,input)).toThrow();
    }
  });
  it('rejects a receipt bound to another position',()=>{
    const value=journal();value.receipt.positionId=input.operationId;
    expect(()=>requireCompletedJournal(value,input)).toThrow();
  });
  it.each(['active','waiting','failed'])('does not treat %s as BullMQ completion',state=>{
    expect(()=>requireRedelivery(job(),state,stream(),input)).toThrow();
  });
  it.each([{attemptsStarted:1},{attemptsStarted:3},{stalledCounter:0},{stalledCounter:2}])('requires one persisted redelivery %j',change=>{
    expect(()=>requireRedelivery({...job(),...change},'completed',stream(),input)).toThrow();
  });
  it('rejects a manufactured lifecycle with matching counts in the wrong order',()=>{
    const values=stream();[values[0],values[1]]=[values[1]!,values[0]!];
    expect(()=>requireRedelivery(job(),'completed',values,input)).toThrow();
  });
  it('scans every cursor before admitting the fresh namespace without deleting anything',async ()=>{
    const redis={scan:vi.fn().mockResolvedValueOnce(['7',[]]).mockResolvedValueOnce(['0',[]])};
    await requireEmptyQueueNamespace(redis,input,deadline());
    expect(redis.scan.mock.calls).toEqual([['0','MATCH',`${identity.prefix}:*`,'COUNT',100],['7','MATCH',`${identity.prefix}:*`,'COUNT',100]]);
  });
  it('refuses unexpected namespace content',async ()=>{
    await expect(requireEmptyQueueNamespace({scan:vi.fn(async ()=>['0',['unexpected']])},input,deadline())).rejects.toThrow();
  });
  it('reads structured Redis stream evidence and rejects duplicate fields',()=>{
    expect(queueStream([['1-0',['event','active','jobId',identity.jobId]]])).toEqual([{event:'active',jobId:identity.jobId}]);
    expect(()=>queueStream([['1-0',['event','active','event','completed']]])).toThrow();
  });
  it('allows populated identity rebinding but preserves pristine admission refusal',async ()=>{
    const client=redisClient();expect(await bindRedisIdentity(client,'172.18.0.3',redisRunId)).toBe(redisRunId);
    expect(client.dbsize).not.toHaveBeenCalled();await expect(bindRedis(client,'172.18.0.3')).rejects.toThrow();
  });
  it.each(['address','run','database'])('rejects populated Redis %s substitution',async field=>{
    const client=redisClient();
    if (field==='database') client.call.mockResolvedValue('laddr=172.18.0.3:6379 db=1');
    await expect(bindRedisIdentity(client,field==='address'?'172.18.0.4':'172.18.0.3',field==='run'?'b'.repeat(40):redisRunId)).rejects.toThrow();
  });
  it('recursively owns duplicate Redis connections and waits for pending command settlement',async ()=>{
    const d=deadline(),s=deadline(),root=redisClient(),child=redisClient();root.duplicate.mockReturnValue(child);
    let rejectCommand!:(error:Error)=>void;child.sendCommand=vi.fn(()=>new Promise((_,reject)=>{rejectCommand=reject;}));
    const pool=new OwnedQueueRedis(d,()=>root);pool.open('synthetic','owned');await root.connect();
    root.duplicate();await child.connect();const pending=child.sendCommand('blocking').catch(()=>{});
    child.disconnect=vi.fn(()=>{child.status='end';child.emit('end');});
    d.abort();let closed=false;const closing=pool.close(s).then(()=>{closed=true;});
    await Promise.resolve();await Promise.resolve();expect(closed).toBe(false);
    rejectCommand(new Error('closed'));await pending;await closing;
    expect(root.disconnect).toHaveBeenCalledOnce();expect(child.disconnect).toHaveBeenCalledOnce();
    await expect(child.sendCommand('late')).rejects.toThrow();expect(()=>root.duplicate()).toThrow();
  });
  it('refuses expired connection creation',()=>{
    const d=deadline();d.abort();const create=vi.fn();const pool=new OwnedQueueRedis(d,create);
    expect(()=>pool.open('synthetic','owned')).toThrow();expect(create).not.toHaveBeenCalled();
  });
  it('contains Worker and QueueEvents duplicate connections, loops and processor work',async ()=>{
    const d=deadline(),s=deadline(),connections:any[]=[],handles:any[]=[];
    const make=(connection:any)=>{
      const h:any=new EventEmitter();handles.push(h);h.connection=connection;
      let resolveRun!:()=>void;h.run=vi.fn(()=>new Promise<void>(resolve=>{resolveRun=resolve;}));
      h.waitUntilReady=vi.fn(async ()=>h.connection);
      h.close=vi.fn(async ()=>{resolveRun?.();});return h;
    };
    const f:QueueFactories={redis:()=>{const c=redisClient();connections.push(c);return c;},
      queue:vi.fn((_,opts)=>make(opts.connection)),events:vi.fn((_,opts)=>make((opts.connection as any).duplicate())),
      worker:vi.fn((_,processor,opts)=>{const h=make((opts.connection as any).duplicate());h.processor=processor;
        h.stalledChecker=vi.fn();h.moveStalledJobsToWait=vi.fn(async ()=>{});h.checkConnectionError=(fn:()=>Promise<unknown>)=>fn();return h;})};
    const runtime=new OwnedQueueRuntime(d,'synthetic',input,'172.18.0.3',redisRunId,f);
    await runtime.queue();await runtime.events();const worker=await runtime.worker(async ()=>new Promise<void>(resolve=>{worker.resolveProcessor=resolve;}));
    const work=worker.processor(job());
    let releaseCheck!:()=>void;worker.moveStalledJobsToWait.mockImplementation(()=>new Promise<void>(resolve=>{releaseCheck=resolve;}));
    const checker=worker.stalledChecker();d.abort();let closed=false;const close=runtime.close(s).then(()=>{closed=true;});
    await Promise.resolve();await Promise.resolve();expect(closed).toBe(false);
    worker.resolveProcessor();await work;await Promise.resolve();expect(closed).toBe(false);
    releaseCheck();await checker;await close;
    expect(worker.close).toHaveBeenCalledWith(true);expect(worker.close).toHaveBeenCalledOnce();
    for (const h of handles) expect(h.close).toHaveBeenCalledOnce();
    for (const c of connections) expect(c.disconnect).toHaveBeenCalledOnce();
    const options=(f.worker as any).mock.calls[0][2];expect(options).toMatchObject({autorun:false,concurrency:1,lockDuration:5000,stalledInterval:1000,maxStalledCount:1});
  });
  it('polls persisted completion without the unsafe detached convenience waiter',async ()=>{
    const runtime=new OwnedQueueRuntime(deadline(),'synthetic',input,'172.18.0.3',redisRunId);
    const value={getState:vi.fn().mockResolvedValueOnce('active').mockResolvedValueOnce('completed'),waitUntilFinished:vi.fn()};
    await runtime.completed(value,{});expect(value.getState).toHaveBeenCalledTimes(2);expect(value.waitUntilFinished).not.toHaveBeenCalled();
    await runtime.close(deadline());
  });
  it('cancellation settles the completion interval without waiting for its original deadline',async ()=>{
    const d=deadline(),runtime=new OwnedQueueRuntime(d,'synthetic',input,'172.18.0.3',redisRunId);
    const work=runtime.completed({getState:vi.fn(async ()=>'active')},{});const observed=work.catch(error=>error);
    await new Promise(resolve=>setTimeout(resolve,1));d.abort();await runtime.close(deadline());expect(await observed).toBeInstanceOf(Error);
  });
  it('completion polling errors are observed and do not escape an async Promise executor',async ()=>{
    const runtime=new OwnedQueueRuntime(deadline(),'synthetic',input,'172.18.0.3',redisRunId);
    await expect(runtime.completed({getState:vi.fn(async ()=>{throw new Error('disconnected');})},{})).rejects.toThrow('disconnected');
    await expect(runtime.close(deadline())).rejects.toThrow();
  });
  it('requires observed Redis identity before creating a connection',async ()=>{
    const client=redisClient();await expect(bindRedisIdentity(client,'172.18.0.3',undefined as any)).rejects.toThrow();
    expect(client.info).not.toHaveBeenCalled();
    expect(()=>new OwnedQueueRuntime(deadline(),'synthetic',input,'172.18.0.3',undefined as any)).toThrow();
  });
  it.each(['amountAfter','quoteHash','collectedFeesMicroUsd','executionCostsMicroUsd','proceedsMicroUsd'])('rejects receipt body corruption %s',field=>{
    const value=journal();value.receipt[field]='wrong';expect(()=>requireCompletedJournal(value,input)).toThrow();
  });
  it('rejects an incorrect stored receipt hash and missing history',()=>{
    const value=journal();value.receiptRow.receipt_hash='b'.repeat(64);expect(()=>requireCompletedJournal(value,input)).toThrow();
    const other=journal();other.history=[];expect(()=>requireCompletedJournal(other,input)).toThrow();
  });
  it('requires matching run and operation IPC and waits for owned child close',async ()=>{
    const child:any=new EventEmitter();child.pid=123;child.exitCode=null;child.signalCode=null;
    child.send=vi.fn();child.kill=vi.fn();mocks.fork.mockReturnValue(child);
    const d=deadline();const outcome=ownedQueueWorker({...input,configPath:'/private/config.json',redisRunId,point:'after-settlement-commit-before-ack'},d);
    let settled=false;void outcome.then(()=>{settled=true;});
    child.emit('message',{kind:'point',point:'after-settlement-commit-before-ack',...input});
    await Promise.resolve();expect(settled).toBe(false);expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close',null,'SIGKILL');expect((await outcome).ack).toBe(false);
    expect(mocks.fork.mock.calls[0]![0]).toMatch(/queue-worker-child.ts$/);
  });
  it('rejects queue child boundary substitution without claiming stall evidence',async ()=>{
    const child:any=new EventEmitter();child.pid=123;child.exitCode=null;child.signalCode=null;child.send=vi.fn();child.kill=vi.fn();mocks.fork.mockReturnValue(child);
    const work=ownedQueueWorker({...input,configPath:'/private/config.json',redisRunId,point:'after-settlement-commit-before-ack'},deadline());
    child.emit('message',{kind:'point',point:'after-settlement-commit-before-ack',...input,operationId:positionId});
    child.emit('close',null,'SIGKILL');await expect(work).rejects.toThrow('substitution');
  });
});
