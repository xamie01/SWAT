import {expect,it,vi} from 'vitest';
import {AUTH_IDENTITY_SQL,AUTH_RESET_SQL,AUTH_POOL_RESET_SQL,createCheckedAuthTransaction,createOwnedAuthStore,AuthCommitUncertainError,type AuthQueryClient} from './auth-owned.js';
const credentials=vi.hoisted(()=>({hash:vi.fn(async()=>'$argon2id$synthetic'),verify:vi.fn(async(_h:string,p:string)=>p==='synthetic-password'),dummy:vi.fn(async()=>false)}));
vi.mock('./credentials.js',async()=>{
 const crypto=await import('node:crypto');
 return {hashPassword:credentials.hash,verifyPassword:credentials.verify,verifyPasswordAgainstDummy:credentials.dummy,
  generateToken:()=> 'synthetic-session',hashToken:(t:string)=>crypto.createHash('sha256').update(t).digest()};
});
export const identity={role_name:'swat_auth_service',session_role:'swat_auth_service',role_setting:'none',row_security:'on',rolcanlogin:true,
 backend_pid:7,transaction_clean:true,role_defaults_safe:true,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolinherit:false,
 has_memberships:false,owns_objects:false,can_create:false};
function fixture(overrides:Record<string,unknown>={}) {
 const release=vi.fn(),query=vi.fn(async(sql:string,_values?:unknown[]):Promise<{rows:any[];command?:string}>=>{
  if(sql===AUTH_IDENTITY_SQL) return {rows:[{...identity,...overrides}]};
  if(sql.startsWith('BEGIN')) return {rows:[],command:'BEGIN'};
  if(sql==='COMMIT'||sql==='ROLLBACK') return {rows:[],command:sql};
  return {rows:[]};
 });
 const client={query} as unknown as AuthQueryClient;
 return {client,query,release,tx:createCheckedAuthTransaction(async()=>({client,release}))};
}
it.each(['role_name','session_role','role_setting','row_security','has_memberships','owns_objects','can_create','rolbypassrls','rolinherit','rolsuper','rolcanlogin'])('rejects hostile direct identity field %s before operation',async k=>{
 const bad=k==='rolcanlogin' ? false : typeof identity[k as keyof typeof identity]==='boolean' ? true : 'forged';
 const f=fixture({[k]:bad}),op=vi.fn();
 await expect(f.tx(op)).rejects.toThrow('identity'); expect(op).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledWith(true);
});
it('refuses a supplied lease already inside a transaction before issuing BEGIN',async()=>{
 const f=fixture({transaction_clean:false});await expect(f.tx(async()=>null)).rejects.toThrow('identity');
 expect(f.query.mock.calls.some(c=>c[0].startsWith('BEGIN'))).toBe(false);expect(f.release).toHaveBeenCalledWith(true);
});
it('owns one backend and resets tenant/bypass/worker before operation and checked COMMIT',async()=>{
 const f=fixture();
 await f.tx(async c=>{await c.query('SELECT public.swat_auth_touch($1::bytea)',[Buffer.alloc(32)]);});
 expect(f.query.mock.calls.map(c=>c[0])).toEqual([AUTH_IDENTITY_SQL,AUTH_POOL_RESET_SQL,'BEGIN ISOLATION LEVEL READ COMMITTED',AUTH_IDENTITY_SQL,AUTH_RESET_SQL,
  'SELECT public.swat_auth_touch($1::bytea)',AUTH_RESET_SQL,AUTH_IDENTITY_SQL,'COMMIT']);
 expect(f.release).toHaveBeenCalledWith(false);
});
it.each(['COMMIT','SELECT 1; COMMIT','SELECT pg_catalog.set_config($1,$2,true)','SELECT public.swat_auth_touch($1::bytea); -- escape','SELECT public.swat_auth_touch((SELECT token_hash FROM user_sessions))'])('rejects escaped transaction/control query %s even if caught',async sql=>{
 const f=fixture(); await expect(f.tx(async c=>{try{await c.query(sql);}catch{}})).rejects.toThrow('lifetime');
 expect(f.query.mock.calls.map(c=>c[0])).not.toContain('COMMIT');
});
it('rejects nested transaction even when callback swallows rejection',async()=>{
 const f=fixture(); await expect(f.tx(async()=>{try{await f.tx(async()=>null);}catch{}})).rejects.toThrow('lifetime');
});
it('settles leaked query before rollback and never permits overlap',async()=>{
 const f=fixture(); let settle!:()=>void;
 const original=f.query.getMockImplementation()!;
 f.query.mockImplementation(async(sql,values)=>sql.includes('swat_auth_touch') ? await new Promise(resolve=>{settle=()=>resolve({rows:[]});}) : original(sql,values));
 const tx=f.tx(async c=>{void c.query('SELECT public.swat_auth_touch($1::bytea)',[Buffer.alloc(32)]);});
 await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
 // Deferred query is under fixture control; no timers or network.
 while(!settle) await Promise.resolve();
 expect(f.query.mock.calls.some(c=>c[0]==='ROLLBACK')).toBe(false);
 settle(); await expect(tx).rejects.toThrow('lifetime'); expect(f.release).toHaveBeenCalledWith(true);
});
it('overlap poisons a transaction even when all query promises are joined and caught',async()=>{
 const f=fixture();let settle!:()=>void;const original=f.query.getMockImplementation()!;
 f.query.mockImplementation(async(sql,v)=>sql.includes('swat_auth_touch')?await new Promise(resolve=>{settle=()=>resolve({rows:[]});}):original(sql,v));
 const p=f.tx(async c=>{const first=c.query('SELECT public.swat_auth_touch($1::bytea)',[Buffer.alloc(32)]);
  try{await c.query('SELECT public.swat_auth_touch($1::bytea)',[Buffer.alloc(32)]);}catch{}
  settle();await first;});
 await expect(p).rejects.toThrow('lifetime');expect(f.release).toHaveBeenCalledWith(true);
});
it('never says rollback after uncertain COMMIT',async()=>{
 const f=fixture(),original=f.query.getMockImplementation()!;
 f.query.mockImplementation(async(sql,values)=>{if(sql==='COMMIT') throw new Error('lost'); return original(sql,values);});
 await expect(f.tx(async()=>null)).rejects.toBeInstanceOf(AuthCommitUncertainError);
 expect(f.query.mock.calls.some(c=>c[0]==='ROLLBACK')).toBe(false); expect(f.release).toHaveBeenCalledWith(true);
});
it.each(['cleanup','identity'] as const)('late escaped and nested callback during %s cannot commit or publish admission',async stage=>{
 for(const violation of ['escaped','nested'] as const){
  const f=fixture(),original=f.query.getMockImplementation()!;
  let releaseCleanup!:()=>void,entered!:()=>void,resumeCallback!:()=>void;
  const cleanupEntered=new Promise<void>(r=>{entered=r;}),callbackGate=new Promise<void>(r=>{resumeCallback=r;});
  let resets=0,identities=0;
  f.query.mockImplementation(async(sql,v)=>{
   if(sql===AUTH_RESET_SQL)resets++;if(sql===AUTH_IDENTITY_SQL)identities++;
   if(stage==='cleanup'&&sql===AUTH_RESET_SQL&&resets===2||stage==='identity'&&sql===AUTH_IDENTITY_SQL&&identities===3){
    entered();await new Promise<void>(r=>{releaseCleanup=r;});
   }
   return original(sql,v);
  });
  let escaped!:Promise<void>;
  const p=f.tx(async c=>{
   escaped=(async()=>{await callbackGate;try{if(violation==='escaped')await c.query('SELECT public.swat_auth_touch($1::bytea)',[Buffer.alloc(32)]);else await f.tx(async()=>null);}catch{}})();
   return {kind:'issued'};
  });
  await cleanupEntered;resumeCallback();await escaped;releaseCleanup();
  await expect(p).rejects.toThrow('lifetime');
  expect(f.query.mock.calls.map(c=>c[0])).not.toContain('COMMIT');
  expect(f.query.mock.calls.map(c=>c[0])).toContain('ROLLBACK');expect(f.release).toHaveBeenCalledWith(true);
 }
});
it('postattempt late poison is explicitly uncertain and withholds admission',async()=>{
 const f=fixture(),original=f.query.getMockImplementation()!;let escapedClient!:AuthQueryClient;
 f.query.mockImplementation(async(s,v)=>{if(s==='COMMIT'){try{await escapedClient.query('SELECT public.swat_auth_touch($1::bytea)',[Buffer.alloc(32)]);}catch{}}return original(s,v);});
 await expect(f.tx(async c=>{escapedClient=c;return {kind:'issued'};})).rejects.toBeInstanceOf(AuthCommitUncertainError);
 expect(f.query.mock.calls.map(c=>c[0])).not.toContain('ROLLBACK');expect(f.release).toHaveBeenCalledWith(true);
});

it('password lookup burns dummy verify and audits failures without status disclosure',async()=>{
 const f=fixture(),original=f.query.getMockImplementation()!;
 f.query.mockImplementation(async(sql,v)=>sql.includes('swat_auth_password') ? {rows:[{principal:null}]} : original(sql,v));
 expect(await createOwnedAuthStore(f.tx).login('missing@example.invalid','wrong')).toEqual({kind:'invalid'});
 expect(credentials.dummy).toHaveBeenCalledWith('wrong');
 expect(f.query.mock.calls.some(c=>c[0].includes('swat_auth_login_failure'))).toBe(true);
});
it('verified password required before suspended status is observable',async()=>{
 const f=fixture(),original=f.query.getMockImplementation()!;
 f.query.mockImplementation(async(sql,v)=>sql.includes('swat_auth_password') ? {rows:[{principal:{id:'11111111-1111-4111-8111-111111111111',email:'fixture@example.invalid',display_name:null,
  role:'user',tier:'free',tier_expires_at:null,status:'suspended',created_at:'2026-01-01T00:00:00.000Z',password_hash:'$argon2id$synthetic'}}]} : original(sql,v));
 const s=createOwnedAuthStore(f.tx);
 expect(await s.login('fixture@example.invalid','wrong')).toEqual({kind:'invalid'});
 expect(await s.login('fixture@example.invalid','synthetic-password')).toEqual({kind:'inactive'});
 expect(f.query.mock.calls.some(c=>c[0].includes('swat_auth_issue'))).toBe(false);
});
it('signup/session/audit routines compose in one owned transaction and hash raw token',async()=>{
 const f=fixture(),original=f.query.getMockImplementation()!;
 const principal={id:'11111111-1111-4111-8111-111111111111',email:'fixture@example.invalid',display_name:null,
  role:'user',tier:'free',tier_expires_at:null,status:'active',created_at:'2026-01-01T00:00:00.000Z'};
 f.query.mockImplementation(async(sql,v)=>sql.includes('swat_auth_signup') ? {rows:[{principal}]} : sql.includes('swat_auth_issue') ? {rows:[{expires_at:new Date('2026-02-01')}]} : original(sql,v));
 const a=await createOwnedAuthStore(f.tx).signup({email:principal.email,password:'synthetic-password'});
 expect(a.kind).toBe('issued'); const call=f.query.mock.calls.find(c=>c[0].includes('swat_auth_issue'))!;
 expect(Buffer.isBuffer(call[1]?.[1])).toBe(true); expect(call[1]?.[1]).not.toEqual('synthetic-session');
 expect(f.query.mock.calls.filter(c=>c[0]==='COMMIT')).toHaveLength(1);
});
