import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { requireCheck } from './core.js';
import { Deadline } from './containment.js';
import { OwnedQueueRedis } from './queue-redis.js';
import { queueIdentity, type QueueIdentity } from './queue-contract.js';
import { bindRedisIdentity } from './infrastructure.js';

const require = createRequire(new URL('../../../apps/lp/package.json',import.meta.url));
export interface QueueFactories {
  redis(url:string,options:Record<string,unknown>):any;
  queue(name:string,options:Record<string,unknown>):any;
  events(name:string,options:Record<string,unknown>):any;
  worker(name:string,processor:(job:any)=>Promise<unknown>,options:Record<string,unknown>):any;
}
const factories:QueueFactories = {
  redis:(url,options)=>{ const Redis = require('ioredis'); return new Redis(url,options); },
  queue:(name,options)=>{ const {Queue} = require('bullmq'); return new Queue(name,options); },
  events:(name,options)=>{ const {QueueEvents} = require('bullmq'); return new QueueEvents(name,options); },
  worker:(name,processor,options)=>{
    requireCheck(require('bullmq/package.json').version === '5.76.8','Reviewed BullMQ stalled-check adapter version required');
    const {Worker} = require('bullmq'); return new Worker(name,processor,options);
  }
};
export class OwnedQueueRuntime {
  private readonly redis:OwnedQueueRedis;
  private readonly handles = new Map<any,boolean>();
  private readonly stops = new Map<any,Promise<unknown>>();
  private readonly releases:(()=>void)[] = [];
  private readonly work = new Set<Promise<unknown>>();
  private closing = false;
  private readonly stopping = new AbortController();
  private failure:unknown;
  private readonly identity:ReturnType<typeof queueIdentity>;
  constructor(private readonly deadline:Deadline,private readonly url:string,input:QueueIdentity,
    private readonly address:string,private readonly redisRunId:string,private readonly create:QueueFactories = factories) {
    this.identity = queueIdentity(input);
    requireCheck(typeof redisRunId === 'string' && /^[a-f0-9]{40}$/.test(redisRunId),'Previously observed Redis run identity required');
    this.redis = new OwnedQueueRedis(deadline,create.redis);
    this.releases.push(deadline.enroll(()=>this.stopping.abort()));
  }
  track<T>(work:Promise<T>):Promise<T> {
    this.work.add(work);
    void work.then(()=>this.work.delete(work),error=>{
      this.work.delete(work);
      if (!this.closing && !this.deadline.signal.aborted) { this.failure = error; this.deadline.abort(); }
    });
    return work;
  }
  private stop(handle:any,worker:boolean) {
    const previous = this.stops.get(handle);
    if (previous) return previous;
    let stopped:Promise<unknown>;
    try { stopped = this.track(Promise.resolve(worker ? handle.close(true) : handle.close())); }
    catch { stopped = this.track(Promise.reject(new Error('Owned BullMQ close failed'))); }
    this.stops.set(handle,stopped); return stopped;
  }
  private own(handle:any,worker=false) {
    this.handles.set(handle,worker);
    handle.on('error',()=>{ if (!this.closing && !this.deadline.signal.aborted) { this.failure = new Error('Owned BullMQ failure'); this.deadline.abort(); } });
    try { this.releases.push(this.deadline.enroll(()=>{ this.closing = true; this.stop(handle,worker); })); }
    catch (error) { this.closing = true; this.stop(handle,worker); throw error; }
    return handle;
  }
  private async connection(name:string) {
    this.deadline.check();
    if (this.closing) throw new Error('Owned BullMQ runtime closing');
    const connection = this.redis.open(this.url,name);
    await this.track(connection.connect());
    await this.track(bindRedisIdentity(connection,this.address,this.redisRunId));
    this.deadline.check(); return connection;
  }
  async queue() {
    const connection = await this.connection('wave4-lp-queue');
    const queue = this.own(this.create.queue(this.identity.queue,{prefix:this.identity.prefix,connection}));
    await this.track(queue.waitUntilReady()); this.deadline.check(); return queue;
  }
  async events() {
    const connection = await this.connection('wave4-lp-events');
    const events = this.own(this.create.events(this.identity.queue,{prefix:this.identity.prefix,connection,
      autorun:false,lastEventId:'0-0',blockingTimeout:1000}));
    this.track(events.run()); await this.track(events.waitUntilReady()); this.deadline.check(); return events;
  }
  async worker(processor:(job:any)=>Promise<unknown>) {
    const connection = await this.connection('wave4-lp-worker');
    const worker = this.own(this.create.worker(this.identity.queue,(job:any)=>this.track(processor(job)),{
      prefix:this.identity.prefix,connection,autorun:false,concurrency:1,
      lockDuration:5000,stalledInterval:1000,maxStalledCount:1}),true);
    requireCheck(typeof worker.stalledChecker === 'function' && typeof worker.moveStalledJobsToWait === 'function',
      'Reviewed BullMQ stalled-check lifecycle unavailable');
    const move = worker.moveStalledJobsToWait.bind(worker);
    // BullMQ 5.76.8 detaches this loop; the owned adapter joins it and aborts its interval wait.
    worker.stalledChecker = () => this.track((async ()=>{
      while (!this.closing && !worker.closing && !worker.paused && !this.deadline.signal.aborted) {
        await worker.checkConnectionError(()=>move());
        if (this.closing || worker.closing || this.deadline.signal.aborted) break;
        await delay(1000,undefined,{signal:this.stopping.signal});
      }
    })());
    this.track(worker.run()); await this.track(worker.waitUntilReady()); this.deadline.check(); return worker;
  }
  async completed(job:any,_events:any) {
    const work = (async ()=>{
      while (true) {
        this.deadline.check();
        if (this.closing) throw new Error('Owned completion wait cancelled');
        const state = await job.getState();
        this.deadline.check();
        if (state === 'completed') return;
        if (state === 'failed' || state === 'unknown') throw new Error('Owned queue completion failed');
        await delay(20,undefined,{signal:this.stopping.signal});
      }
    })();
    return this.track(work);
  }
  async close(shutdown:Deadline) {
    shutdown.check(); this.closing = true; this.stopping.abort();
    const release = shutdown.enroll(()=>{ for (const [handle,worker] of this.handles) this.stop(handle,worker); });
    try {
      const closing = [...this.handles].map(([handle,worker])=>this.stop(handle,worker));
      const redisClose = this.redis.close(shutdown);
      const results = await Promise.allSettled([...closing,redisClose,...this.work]);
      shutdown.check();
      if (this.failure || results.slice(0,closing.length+1).some(r=>r.status==='rejected')) throw new Error('Owned BullMQ shutdown failed');
    } finally { release(); for (const release of this.releases) release(); }
  }
}
