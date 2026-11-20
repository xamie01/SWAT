import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {overlapAuthentication} from './auth-schedules.js';
import {createCheckedAuthTransaction,createOwnedAuthStore} from '../../../packages/db/src/auth-owned.js';
import {createAuthenticationHttp} from './auth-http.js';
import {qualifyProtectedAuthentication,authenticationSourceBoundary} from './authentication.js';
import {AUTH_IDENTITY_SQL,AUTH_POOL_RESET_SQL,AUTH_RESET_SQL,type AuthQueryClient,type AuthClientLease} from '../../../packages/db/src/auth-owned.js';
import {AUTH_FUNCTION_SIGNATURES,AUTH_MIGRATION_SHA256,AUTH_INSTALLATION_STAGES,provisionCommittedAuthentication} from '../../../deploy/postgres/auth-provisioning.js';
const crypto=vi.hoisted(()=>({hash:vi.fn(async(p:string)=>'$argon2id$'+p),verify:vi.fn(async(h:string,p:string)=>h==='$argon2id$'+p),dummy:vi.fn(async()=>false),next:0}));
vi.mock('../../../packages/db/src/credentials.js',async()=>{
 const c=await import('node:crypto');return {hashPassword:crypto.hash,verifyPassword:crypto.verify,verifyPasswordAgainstDummy:crypto.dummy,
 generateToken:()=>`synthetic-session-${++crypto.next}`,hashToken:(s:string)=>c.createHash('sha256').update(s).digest()};
});
const sql=()=>readFileSync(new URL('../../../packages/db/sql/087_wave4_protected_authentication.sql',import.meta.url),'utf8');
it('binds exact inert migration, all fixed signatures, and separate committed handoff stages',()=>{
 expect(createHash('sha256').update(sql()).digest('hex')).toBe(AUTH_MIGRATION_SHA256);
 expect(AUTH_FUNCTION_SIGNATURES).toHaveLength(17);
 expect(sql()).not.toMatch(/ALTER FUNCTION[\s\S]*OWNER TO|CREATE ROLE|\bLOGIN\s+VALID/);
 expect(sql()).toContain("current_user<>'swat_auth_owner'");
 expect(sql()).toContain("interval '30 days'"); expect(sql()).toContain("interval '7 days'"); expect(sql()).toContain("interval '5 minutes'");
 expect(sql()).not.toContain('GRANT EXECUTE');
 expect(AUTH_INSTALLATION_STAGES[0]).toContain('commit inert');
 expect(AUTH_INSTALLATION_STAGES[1]).toContain('checked atomic handoff COMMIT');
});
it('refuses missing/external forged provisioning capabilities before any SQL',async()=>{
 const acquire=vi.fn(); await expect(provisionCommittedAuthentication({acquire,dbaRole:'fixture_dba',installedSql:sql()+'-- drift'})).rejects.toThrow('Exact');
 expect(acquire).not.toHaveBeenCalled();
 const query=vi.fn(async()=>({rows:[{current_role:'fixture_dba',session_role:'swat_migrator',role_setting:'none',row_security:'on',backend:7,superuser:true}]}));
 const release=vi.fn();await expect(provisionCommittedAuthentication({acquire:async()=>({client:{query} as unknown as AuthQueryClient,release}),dbaRole:'fixture_dba',installedSql:sql()})).rejects.toThrow('direct external DBA');
 expect(query).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledWith(true);
});
it('refuses qualification with absent owned capabilities',async()=>{
 await expect(qualifyProtectedAuthentication({} as any)).rejects.toThrow('capabilities');
 expect(authenticationSourceBoundary.runtimeAccepted).toBe(false);
});
/** Synthetic SQL protocol fixture, not a RLS/PG proof. Exercises the real store and
 * full executable scenario, including independent runtime refusals and observer queries. */
function fixture() {
 const users=new Map<string,any>(),sessions=new Map<string,any>(),wallets=new Map<string,any>();let next=0;
 const identity={role_name:'swat_auth_service',session_role:'swat_auth_service',role_setting:'none',row_security:'on',rolcanlogin:true,
  backend_pid:7,transaction_clean:true,role_defaults_safe:true,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolinherit:false,
  has_memberships:false,owns_objects:false,can_create:false};
 const digest=(v:unknown)=>Buffer.isBuffer(v)?v.toString('hex'):String(v);
 const active=(v:unknown)=>{const s=sessions.get(digest(v));return s&&!s.revoked&&!s.idle&&!s.absolute?s:null;};
 const calls:string[]=[];
 const locks=new Map<string,{owner:number;release:Promise<void>;unlock:()=>void}>(),waiting=new Map<number,number>();let backend=10;
 function lease(kind:'auth'|'runtime'|'observer'):AuthClientLease {
  const pid=++backend;let tenant='',forged=false;
  const held=new Set<string>(),pendingDeletes=new Set<string>();
  async function lock(key:string){
   while(locks.has(key)&&locks.get(key)!.owner!==pid){const prior=locks.get(key)!;waiting.set(pid,prior.owner);await prior.release;waiting.delete(pid);}
   if(!locks.has(key)){let unlock!:()=>void;const release=new Promise<void>(r=>{unlock=r;});locks.set(key,{owner:pid,release,unlock});held.add(key);}
  }
  function unlock(){for(const key of held){const current=locks.get(key);if(current?.owner===pid){locks.delete(key);current.unlock();}}held.clear();}
  const query=async(s:string,v:unknown[]=[])=>{
   calls.push(`${kind}:${s}`);
   if(s.includes('current_database() AS database'))return {rows:[{database:'wave4',address:'172.18.0.2',port:5432,system_identifier:'1234'}]};
   if(s.startsWith('BEGIN'))return {rows:[],command:'BEGIN'};
   if(s==='COMMIT'||s==='ROLLBACK'){forged=false;if(s==='COMMIT')for(const key of pendingDeletes)wallets.delete(key);pendingDeletes.clear();unlock();return {rows:[],command:s};}
   if(kind==='auth') {
    if(s===AUTH_IDENTITY_SQL)return {rows:[{...identity,backend_pid:pid}]};
    if(s===AUTH_RESET_SQL||s===AUTH_POOL_RESET_SQL){forged=false;return {rows:[]};}
    if(s.includes('set_config')){forged=true;return {rows:[]};}
    if(forged&&s.includes('swat_auth_'))throw Object.assign(new Error('forged claims'),{code:'42501'});
    // Lock only the reviewed SQL root/unique keys, not every auth lease. Reads are
    // reselected after waking, so this fixture exercises genuine protocol overlap.
    if(s.includes('swat_auth_password')){const u=[...users.values()].find(u=>u.email===v[0]);if(u)await lock(`user:${u.id}`);}
    if(s.includes('swat_auth_wallet_owner')){const w=wallets.get(`${v[0]}:${v[1]}`);if(w)await lock(`user:${w.user_id}`);}
    if(/swat_auth_(touch|change_password|link_wallet|unlink_wallet|revoke)/.test(s)){const session=sessions.get(digest(v[0]));if(session)await lock(`user:${session.uid}`);}
    if(s.includes('swat_auth_link_wallet'))await lock(`wallet:${v[1]}:${v[2]}`);
    if(s.includes('swat_auth_issue'))await lock(`user:${v[0]}`);
    if(s.includes('swat_auth_signup')) {
     const u={id:`11111111-1111-4111-8111-${String(++next).padStart(12,'0')}`,email:v[0],password_hash:v[1],display_name:null,
      role:'user',tier:'free',tier_expires_at:null,status:'active',created_at:'2026-01-01T00:00:00.000Z'};
     users.set(u.id,u);return {rows:[{principal:u}]};
    }
    if(s.includes('swat_auth_password'))return {rows:[{principal:[...users.values()].find(u=>u.email===v[0])??null}]};
    if(s.includes('swat_auth_issue')){sessions.set(digest(v[1]),{id:`session-${sessions.size}`,uid:v[0],revoked:false});return {rows:[{expires_at:new Date('2030-01-01')}]};}
    if(s.includes('swat_auth_touch'))return {rows:[{touched:!!active(v[0])}]};
    if(s.includes('swat_auth_resolve')){const a=active(v[0]);return {rows:[{principal:a?{...users.get(a.uid),session_id:a.id}:null}]};}
    if(s.includes('swat_auth_change_password')){const a=active(v[0]);if(!a)return {rows:[{changed:false}]};users.get(a.uid).password_hash=v[1];for(const x of sessions.values())if(x.uid===a.uid)x.revoked=true;return {rows:[{changed:true}]};}
    if(s.includes('swat_auth_revoke_all')){const a=active(v[0]);let count=0;if(a)for(const x of sessions.values())if(x.uid===a.uid&&!x.revoked){x.revoked=true;count++;}return {rows:[{count:a?count:null}]};}
    if(s.includes('swat_auth_revoke')){const a=sessions.get(digest(v[0]));if(a)a.revoked=true;return {rows:[]};}
    if(s.includes('swat_auth_link_wallet')){const a=active(v[0]);if(!a)throw Object.assign(new Error('session'),{code:'28000'});const key=`${v[1]}:${v[2]}`,w=wallets.get(key);if(w&&w.user_id!==a.uid)return {rows:[]};const r=w??{id:`wallet-${++next}`,user_id:a.uid,chain_kind:v[1],address:v[2],verified_at:new Date('2026-01-01')};wallets.set(key,r);return {rows:[r]};}
    if(s.includes('swat_auth_unlink_wallet')){const key=`${v[1]}:${v[2]}`,removed=wallets.has(key);if(removed)pendingDeletes.add(key);return {rows:[{removed}]};}
    if(s.includes('swat_auth_wallet_owner')){const w=wallets.get(`${v[0]}:${v[1]}`);return {rows:[{principal:w?users.get(w.user_id):null}]};}
    if(s.includes('swat_auth_wallets')){const a=active(v[0]);return {rows:a?[...wallets.values()].filter(w=>w.user_id===a.uid):[]};}
    if(s.includes('swat_auth_wallet_failure'))return {rows:[]};
    if(s.includes('swat_auth_login_failure'))return {rows:[]};
    if(s.includes("AS tenant"))return {rows:[{tenant:'',bypass:'off',worker:''}]};
   }
   if(kind==='runtime') {
    if(s.includes('AS current_role'))return {rows:[{current_role:'swat_app',session_role:'swat_app',role_setting:'none',row_security:'on',rolsuper:false,rolbypassrls:false,membership:false,backend:pid,transaction_clean:true}]};
    if(s===AUTH_RESET_SQL)return {rows:[]};
    if(s.includes('set_config')){tenant=String(v[0]);return {rows:[]};}
    if(s.startsWith('SELECT id,email FROM'))return {rows:[...users.values()].filter(u=>u.id===tenant).map(u=>({id:u.id,email:u.email}))};
    if(s.startsWith('SELECT id FROM public.user_auth_wallets'))return {rows:[]};
    throw Object.assign(new Error('permission denied'),{code:'42501'});
   }
   if(kind==='observer') {
    if(s.includes('pg_blocking_pids'))return {rows:[{blocked:waiting.get(Number(v[1]))===Number(v[0]),lock_wait:waiting.has(Number(v[1]))}]};
    if(s.includes('AS role,')&&s.includes('r.rolsuper'))return {rows:[{role:'fixture_dba',session:'fixture_dba',role_setting:'none',row_security:'on',rolsuper:true}]};
    if(s.includes('AS current_role'))return {rows:[{current_role:'fixture_dba',session_role:'fixture_dba',role_setting:'none',row_security:'on',rolsuper:true}]};
    if(s.includes('FROM public.auth_wallet_proofs p JOIN public.audit_log')) {const w=[...wallets.values()].find(w=>w.id===v[0]);return {rows:w?[{user_id:w.user_id,wallet_id:w.id,audit_matches:true}]:[]};}
    if(s.includes('AS absolute_bound'))return {rows:[{absolute_bound:true,touch_throttled:true}]};
    if(s.startsWith('UPDATE public.user_sessions')){const x=sessions.get(digest(v[1]));if(x){if(s.includes('last_seen_at'))x.idle=true;else x.absolute=true;}return {rows:[]};}
   }
   throw new Error(`Unhandled synthetic query: ${s}`);
  };
  return {client:{query} as AuthQueryClient,release:vi.fn(()=>unlock())};
 }
 const nonces=new Map<string,string>();
 const nonceStore={set:async(k:string,v:string)=>{nonces.set(k,v);},getdel:async(k:string)=>{const v=nonces.get(k)??null;nonces.delete(k);return v;}};
 return {calls,waiting,ports:{target:{database:'wave4',address:'172.18.0.2',port:5432,systemIdentifier:'1234'},acquireAuth:async()=>lease('auth'),acquireRuntime:async()=>lease('runtime'),acquireObserver:async()=>lease('observer'),observerRole:'fixture_dba',nonceStore,
  overlapObservation:'offline-protocol-interleaving' as const,
  signature:{chainKind:'solana' as const,address:'pending',signSyntheticChallenge:async(_message:string)=>'pending'},
 fixture:{emailA:'a@example.invalid',emailB:'b@example.invalid',password:'synthetic-password',newPassword:'synthetic-new-password',walletAddress:'pending'}}};
}
async function signedFixture(){
 const f=fixture();
 const {createRequire}=await import('node:module');const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));
 const nacl=require('tweetnacl'),bs58=require('bs58').default??require('bs58');
 // Test-only ephemeral synthetic key; never read from files/environment, never live.
 const pair=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(73));
 f.ports.signature.address=bs58.encode(pair.publicKey);f.ports.fixture.walletAddress=f.ports.signature.address;
 f.ports.signature.signSyntheticChallenge=async message=>bs58.encode(nacl.sign.detached(new TextEncoder().encode(message),pair.secretKey));
 return f;
}
it('executes positive and hostile authentication qualification through the real owned store',async()=>{
 const f=await signedFixture();
 const result=await qualifyProtectedAuthentication(f.ports);
 expect(result.facts).toEqual({crossTenantRefused:true,forgedClaimsRefused:true,passwordRaceRevoked:true,walletProvenanceAtomic:true,revocationFresh:true,idleAndAbsoluteExpiry:true,poolResetObserved:true});
 expect(f.calls.some(s=>s==='runtime:TRUNCATE public.user_sessions')).toBe(true);
 expect(f.calls.some(s=>s.includes('swat_auth_change_password'))).toBe(true);
 expect(result.boundary.runtimeAccepted).toBe(false);
 expect(result.observation).toBe('offline-protocol-interleaving');expect(result.schedules).toHaveLength(5);
 expect(f.calls.filter(s=>s.includes('pg_blocking_pids'))).toHaveLength(5);expect(f.waiting.size).toBe(0);
 const runtime=f.calls.filter(s=>s.startsWith('runtime:')).map(s=>s.slice('runtime:'.length));
 expect(runtime[0]).toContain('AS transaction_clean');expect(runtime[1]).toContain('current_database() AS database');
 expect(runtime[2]).toContain('AS current_role');expect(runtime[3]).toBe('BEGIN');
 for(let i=0;i<runtime.length;i++)if(runtime[i]==='COMMIT'||runtime[i]==='ROLLBACK')expect(runtime[i-1]).toContain('AS current_role');
});
it('independent clients without a blocked edge are not certified as an overlap schedule',async()=>{
 const f=fixture();
 await expect(overlapAuthentication({acquireAuth:f.ports.acquireAuth,acquireObserver:f.ports.acquireObserver,observerRole:'fixture_dba',observation:'offline-protocol-interleaving'},
  {name:'no-shared-lock',leaderRoutine:'swat_auth_password',contenderRoutine:'swat_auth_password',leader:s=>s.login('absent-a@example.invalid','wrong'),contender:s=>s.login('absent-b@example.invalid','wrong')})).rejects.toThrow('edge absent');
 expect(f.waiting.size).toBe(0);
});
it.each(['open-transaction','role-mismatch','session-mismatch','role-setting','rls','membership','missing-backend','target-mismatch','backend-before-begin','identity-before-begin'])('runtime acquisition rejects %s without borrowing or settling any transaction',async hostile=>{
 const f=await signedFixture(),acquire=f.ports.acquireRuntime,release=vi.fn();const calls:string[]=[];
 f.ports.acquireRuntime=async()=>{
  const lease=await acquire();let observations=0;
  const client:AuthQueryClient={query:async<T extends import('../../../packages/db/src/auth-owned.js').AuthQueryRow=import('../../../packages/db/src/auth-owned.js').AuthQueryRow>(s:string,v?:unknown[])=>{
   calls.push(s);const result=await lease.client.query<T>(s,v);
   if(s.includes('AS current_role')){
    observations++;const r=result.rows[0] as any;
    if(hostile==='open-transaction')r.transaction_clean=false;
    if(hostile==='role-mismatch')r.current_role='fixture_dba';if(hostile==='session-mismatch')r.session_role='fixture_dba';
    if(hostile==='role-setting')r.role_setting='swat_app';if(hostile==='rls')r.row_security='off';if(hostile==='membership')r.membership=true;
    if(hostile==='missing-backend')r.backend=null;
    if(hostile==='backend-before-begin'&&observations>1)r.backend++;
    if(hostile==='identity-before-begin'&&observations>1)r.current_role='fixture_dba';
   }
   if(hostile==='target-mismatch'&&s.includes('current_database() AS database'))(result.rows[0] as any).address='172.20.0.2';
   return result;
  }};
  return {client,release:(broken:boolean)=>{release(broken);lease.release(broken);}};
 };
 await expect(qualifyProtectedAuthentication(f.ports)).rejects.toThrow(/distinct clean direct runtime|target differs|runtime backend|hostile query must reach ACL refusal/);
 expect(calls.some(s=>/^(BEGIN|COMMIT|ROLLBACK)/.test(s))).toBe(false);
 expect(calls.some(s=>/public\.(users|user_sessions|auth_wallet_proofs|swat_auth_resolve)/.test(s))).toBe(false);
 if(!['target-mismatch','backend-before-begin','identity-before-begin'].includes(hostile))expect(calls.some(s=>s.includes('current_database() AS database'))).toBe(false);
 expect(release).toHaveBeenCalledWith(true);
});
it.each(['backend-at-begin','identity-at-begin','backend-before-commit','identity-before-commit','backend-before-rollback','identity-before-rollback'])('runtime rejects %s and discards without settling the drifted backend',async hostile=>{
 const f=await signedFixture(),acquire=f.ports.acquireRuntime,release=vi.fn();const calls:string[]=[];let acquisitions=0;
 f.ports.acquireRuntime=async()=>{
  const lease=await acquire();acquisitions++;
  // Four negative ACL transactions precede the successful tenant-read transaction.
  if(hostile.endsWith('before-commit')&&acquisitions<=4)return lease;
  let observations=0;
  const client:AuthQueryClient={query:async<T extends import('../../../packages/db/src/auth-owned.js').AuthQueryRow=import('../../../packages/db/src/auth-owned.js').AuthQueryRow>(s:string,v?:unknown[])=>{
   calls.push(s);const result=await lease.client.query<T>(s,v);
   if(s.includes('AS current_role')){
    observations++;const r=result.rows[0] as any;
    const threshold=hostile.endsWith('at-begin')?3:4;
    if(observations>=threshold){if(hostile.startsWith('backend-'))r.backend++;else r.current_role='fixture_dba';}
   }
   return result;
  }};
  return {client,release:(broken:boolean)=>{release(broken);lease.release(broken);}};
 };
 await expect(qualifyProtectedAuthentication(f.ports)).rejects.toThrow(hostile.endsWith('before-commit')
  ? /runtime backend|distinct clean direct runtime/ : /hostile query must reach ACL refusal/);
 expect(calls).toContain('BEGIN');expect(calls).not.toContain('COMMIT');expect(calls).not.toContain('ROLLBACK');
 expect(release).toHaveBeenCalledWith(true);
});

it('runtime ACL-aborted transaction is discarded when settlement identity cannot be rechecked',async()=>{
 const f=await signedFixture(),acquire=f.ports.acquireRuntime,release=vi.fn();const calls:string[]=[];
 f.ports.acquireRuntime=async()=>{
  const lease=await acquire();let aborted=false;
  const client:AuthQueryClient={query:async<T extends import('../../../packages/db/src/auth-owned.js').AuthQueryRow=import('../../../packages/db/src/auth-owned.js').AuthQueryRow>(s:string,v?:unknown[])=>{
   calls.push(s);
   if(aborted)throw Object.assign(new Error('aborted transaction'),{code:'25P02'});
   try{return await lease.client.query<T>(s,v);}
   catch(e){if((e as {code?:string}).code==='42501')aborted=true;throw e;}
  }};
  return {client,release:(broken:boolean)=>{release(broken);lease.release(broken);}};
 };
 await qualifyProtectedAuthentication(f.ports);
 expect(calls.filter(s=>s==='ROLLBACK')).toHaveLength(0);
 expect(release.mock.calls.filter(([broken])=>broken===true)).toHaveLength(4);
});

it.each(['transport','wrong-command'])('runtime COMMIT %s uncertainty discards without ROLLBACK',async hostile=>{
 const f=await signedFixture(),acquire=f.ports.acquireRuntime,release=vi.fn();const calls:string[]=[];let acquisitions=0;
 f.ports.acquireRuntime=async()=>{
  const lease=await acquire();if(++acquisitions<=4)return lease;
  const client:AuthQueryClient={query:async<T extends import('../../../packages/db/src/auth-owned.js').AuthQueryRow=import('../../../packages/db/src/auth-owned.js').AuthQueryRow>(s:string,v?:unknown[])=>{
   calls.push(s);
   if(s==='COMMIT'){
    const result=await lease.client.query<T>(s,v);
    if(hostile==='transport')throw new Error('runtime COMMIT transport uncertain');
    return {...result,command:'ROLLBACK'};
   }
   return lease.client.query<T>(s,v);
  }};
  return {client,release:(broken:boolean)=>{release(broken);lease.release(broken);}};
 };
 await expect(qualifyProtectedAuthentication(f.ports)).rejects.toThrow(/COMMIT.*uncertain/);
 expect(calls).toContain('COMMIT');expect(calls).not.toContain('ROLLBACK');expect(release).toHaveBeenCalledWith(true);
});

it('qualification refuses target substitution before protected authentication admission',async()=>{
 const f=await signedFixture();f.ports.target.systemIdentifier='9999';
 await expect(qualifyProtectedAuthentication(f.ports)).rejects.toThrow('target differs');
 expect(f.calls.some(s=>s.includes('swat_auth_signup'))).toBe(false);
});
it('integrated GETDEL/signature/origin/session path withholds cookies when owned COMMIT is uncertain',async()=>{
 const f=await signedFixture();const base=createOwnedAuthStore(createCheckedAuthTransaction(f.ports.acquireAuth));
 const admission=await base.signup({email:f.ports.fixture.emailA,password:f.ports.fixture.password});
 expect(admission.kind).toBe('issued');if(admission.kind!=='issued')throw new Error('fixture');
 await base.linkWallet(admission.session.token,{chainKind:'solana',address:f.ports.fixture.walletAddress});
 const uncertain=createOwnedAuthStore(createCheckedAuthTransaction(async()=>{
  const lease=await f.ports.acquireAuth();
  const client:AuthQueryClient={query:async<T extends import('../../../packages/db/src/auth-owned.js').AuthQueryRow=import('../../../packages/db/src/auth-owned.js').AuthQueryRow>(s:string,v?:unknown[])=>{
   if(s==='COMMIT'){await lease.client.query(s,v);throw new Error('lost postattempt');}return lease.client.query<T>(s,v);
  }};return {client,release:lease.release};
 }));
 const http=await createAuthenticationHttp(uncertain,f.ports.nonceStore,f.ports.signature);
 try{const payload=await http.challenge();const response=await http.verify(payload);
  expect(response.statusCode).toBe(500);expect(response.cookies.some(c=>c.name==='swat_session')).toBe(false);
  expect((await http.verify(payload)).statusCode).toBe(410);
 }finally{await http.close();}
});
