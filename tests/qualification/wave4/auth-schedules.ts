import { createCheckedAuthTransaction,createOwnedAuthStore,type AuthClientLease,type AuthQueryClient,type OwnedAuthStore,AUTH_IDENTITY_SQL } from '../../../packages/db/src/auth-owned.js';

export type AuthOverlapObservation = 'postgres-blocking-edge'|'offline-protocol-interleaving';
export interface AuthOverlapPorts {
 acquireAuth:()=>Promise<AuthClientLease>;
 acquireObserver:()=>Promise<AuthClientLease>;
 observerRole:string;
 /** Offline contracts must never publish PostgreSQL proof. Runtime caller selects PG mode. */
 observation:AuthOverlapObservation;
}
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
/** Separate checked transactions/backends. Leader is parked AFTER the fixed lock-taking
 * routine returns, before COMMIT. Contender reaches its fixed routine on another acquired
 * lease while leader still owns its locks. Observe the actual PG blocking relation before
 * opening the leader fence. No arbitrary PID cancellation or SQL/control escape. */
export async function overlapAuthentication<A,B>(ports:AuthOverlapPorts,input:{
 name:string;leaderRoutine:string;contenderRoutine:string;
 leader:(store:OwnedAuthStore)=>Promise<A>;contender:(store:OwnedAuthStore)=>Promise<B>;
}):Promise<{leader:PromiseSettledResult<A>;contender:PromiseSettledResult<B>;observation:AuthOverlapObservation;backends:[number,number]}> {
 if(!ports||typeof ports.acquireAuth!=='function'||typeof ports.acquireObserver!=='function'
  ||!['postgres-blocking-edge','offline-protocol-interleaving'].includes(ports.observation)
  ||!['leaderRoutine','contenderRoutine'].every(k=>/^swat_auth_[a-z_]+$/.test(input[k as 'leaderRoutine'])))throw new Error('Authentication deterministic overlap capabilities required');
 const locked=barrier(),entered=barrier(),resume=barrier();let first=0,second=0;
 const end=Date.now()+4000;
 async function bounded<T>(work:Promise<T>):Promise<T>{
  const remaining=end-Date.now();if(remaining<=0)throw new Error('Authentication overlap operational deadline');
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Authentication overlap operational deadline')),remaining);})]);}
  finally{if(timer)clearTimeout(timer);}
 }
 const leases=new Set<AuthQueryClient>();
 function store(side:'leader'|'contender') {
  const routine=side==='leader'?input.leaderRoutine:input.contenderRoutine;
  return createOwnedAuthStore(createCheckedAuthTransaction(async()=>{
   const lease=await ports.acquireAuth();
   if(leases.has(lease.client)){lease.release(true);throw new Error('Authentication overlap requires separately acquired clients');}
   leases.add(lease.client);let stopped=false;
   const client:AuthQueryClient={query:async<T extends import('../../../packages/db/src/auth-owned.js').AuthQueryRow=import('../../../packages/db/src/auth-owned.js').AuthQueryRow>(sql:string,values?:unknown[])=>{
    if(sql===AUTH_IDENTITY_SQL){const r=await lease.client.query<T>(sql,values);const pid=r.rows[0]?.backend_pid;
     if(side==='leader')first=pid;else second=pid;return r;}
    if(!stopped&&sql.includes(`public.${routine}(`)) {
     stopped=true;
     if(side==='contender'){entered.resolve();return lease.client.query<T>(sql,values);}
     const r=await lease.client.query<T>(sql,values);locked.resolve();await resume.promise;return r;
    }
    return lease.client.query<T>(sql,values);
   }};
   return {client,release:broken=>{leases.delete(lease.client);lease.release(broken);}};
  }));
 }
 const leader=input.leader(store('leader'));void leader.catch(()=>locked.resolve());
 let contender:Promise<B>|undefined;
 try{
  await bounded(locked.promise);
  contender=input.contender(store('contender'));void contender.catch(()=>entered.resolve());
  await bounded(entered.promise);
  if(!Number.isInteger(first)||!Number.isInteger(second)||first<=0||second<=0||first===second)throw new Error('Authentication overlap distinct backend evidence required');
  const observer=await ports.acquireObserver();let broken=false;
  try{
   const rows=(await observer.client.query(`SELECT current_user AS role,session_user AS session,current_setting('role') AS role_setting,
    current_setting('row_security') AS row_security,r.rolsuper FROM pg_roles r WHERE rolname=current_user`)).rows;
   const r=rows[0];if(rows.length!==1||r?.role!==ports.observerRole||r.session!==ports.observerRole||r.role_setting!=='none'||r.row_security!=='on'||r.rolsuper!==true||ports.observerRole.startsWith('swat_'))throw new Error('Authentication blocking observer direct external DBA required');
   let observed=false;
   do{
    const wait=(await observer.client.query(`SELECT $1::int=ANY(pg_catalog.pg_blocking_pids($2::int)) AS blocked,
     EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$2 AND wait_event_type='Lock') AS lock_wait`,[first,second])).rows[0];
    if(wait?.blocked===true&&wait.lock_wait===true){observed=true;break;}
    if(ports.observation==='offline-protocol-interleaving')break;
    await new Promise(r=>setTimeout(r,10));
   }while(Date.now()<end);
   if(!observed)throw new Error(`Authentication ${input.name}: required blocking/interleaving edge absent`);
  }catch(e){broken=true;throw e;}finally{observer.release(broken);}
 }finally{
  resume.resolve();
  // Join all owned work on both success and failure before allowing cleanup/caller return.
  await Promise.allSettled(contender?[leader,contender]:[leader]);
 }
 const outcomes=await Promise.allSettled([leader,contender!]);
 return {leader:outcomes[0] as PromiseSettledResult<A>,contender:outcomes[1] as PromiseSettledResult<B>,observation:ports.observation,backends:[first,second]};
}
