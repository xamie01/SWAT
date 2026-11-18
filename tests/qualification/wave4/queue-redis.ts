import { Deadline } from './containment.js';

export class OwnedQueueRedis {
  private readonly clients = new Set<any>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly stops = new Map<any,Promise<void>>();
  private readonly releases: (()=>void)[] = [];
  private closing = false;
  constructor(private readonly deadline: Deadline, private readonly create: (url:string,options:Record<string,unknown>)=>any) {}
  private track<T>(work:Promise<T>) {
    this.pending.add(work);
    void work.then(()=>this.pending.delete(work),()=>this.pending.delete(work));
    return work;
  }
  private stop(client:any) {
    const existing = this.stops.get(client);
    if (existing) return existing;
    const ended = client.status === 'wait' || client.status === 'end' ? Promise.resolve()
      : new Promise<void>(resolve => client.once('end',resolve));
    let disconnected:Promise<void>;
    try { client.disconnect(false); disconnected = Promise.resolve(); }
    catch { disconnected = Promise.reject(new Error('Owned queue disconnect failed')); }
    const stopped = Promise.allSettled([ended,disconnected]).then(results=>{
      if (results.some(r=>r.status==='rejected')) throw new Error('Owned queue connection shutdown failed');
    });
    this.stops.set(client,stopped);
    void stopped.catch(()=>{});
    return stopped;
  }
  private adopt(client:any):any {
    this.clients.add(client);
    client.on('error',()=>{});
    this.releases.push(this.deadline.enroll(()=>{ void this.stop(client); }));
    for (const method of ['sendCommand','connect']) {
      const original = client[method].bind(client);
      client[method] = (...args:unknown[]) => this.track((async ()=>{
        this.deadline.check();
        if (this.closing || this.stops.has(client)) throw new Error('Owned queue connection closing');
        const response = await original(...args);
        this.deadline.check();
        return response;
      })());
    }
    const duplicate = client.duplicate.bind(client);
    client.duplicate = (...args:unknown[]) => {
      this.deadline.check();
      if (this.closing || this.stops.has(client)) throw new Error('Owned queue connection closing');
      const child = duplicate(...args);
      try { return this.adopt(child); }
      catch (error) { void this.stop(child); throw error; }
    };
    return client;
  }
  open(url:string,name:string) {
    const timeout = this.deadline.remaining(5000);
    if (this.closing) throw new Error('Owned queue connection closing');
    const client = this.create(url,{lazyConnect:true,connectionName:name,connectTimeout:timeout,
      enableOfflineQueue:false,maxRetriesPerRequest:null,retryStrategy:()=>null});
    try { return this.adopt(client); }
    catch (error) { void this.stop(client); throw error; }
  }
  async close(shutdown:Deadline) {
    shutdown.check(); this.closing = true;
    const release = shutdown.enroll(()=>{ for (const client of this.clients) void this.stop(client); });
    try {
      const stopped = await Promise.allSettled([...this.clients].map(client=>this.stop(client)));
      await Promise.allSettled([...this.pending]);
      shutdown.check();
      if (stopped.some(r=>r.status==='rejected')) throw new Error('Owned queue connection close failed');
    } finally { release(); for (const release of this.releases) release(); }
  }
}
