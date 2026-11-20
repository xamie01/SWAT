import { createCheckedAuthTransaction,createOwnedAuthStore,assertAuthIdentity,AUTH_RESET_SQL,
  type AuthClientLease,type AuthQueryClient,type AuthAdmission } from '../../../packages/db/src/auth-owned.js';
import { hashToken } from '../../../packages/db/src/credentials.js';
import {createAuthenticationHttp,type SyntheticAuthSignature} from './auth-http.js';
import {overlapAuthentication,type AuthOverlapObservation} from './auth-schedules.js';
import type {AuthNonceStore} from '../../../apps/api/src/auth/routes.js';
import {assertAuthenticationTarget,type AuthInstallationTarget} from '../../../deploy/postgres/auth-installation.js';

export const authenticationSourceBoundary=Object.freeze({sourceImplemented:true,runtimeAccepted:false,liveAccepted:false,productionReady:false});
export const authenticationSourceBlockers=Object.freeze([
 '087 reviewed selection must commit inert before exact external auth owner handoff',
 'separate approved direct auth-service/app/DBA leases and actual catalog/RLS/ACL observations required',
 'auth route signature/nonce and PostgreSQL race/reset qualification not executed by source delivery'
]);
export interface AuthenticationQualificationPorts {
 target:AuthInstallationTarget;
 /** Independently externally owned direct pools. No URLs, credential files, replicas or cache. */
 acquireAuth:()=>Promise<AuthClientLease>;
 acquireRuntime:()=>Promise<AuthClientLease>;
 /** Direct disposable DBA observer, not an audit-label callback. */
 acquireObserver:()=>Promise<AuthClientLease>;
 observerRole:string;
 nonceStore:AuthNonceStore;
 signature:SyntheticAuthSignature;
 overlapObservation:AuthOverlapObservation;
 fixture:{emailA:string;emailB:string;password:string;newPassword:string;walletAddress:string};
}
function check(v:unknown,why:string):asserts v {if(!v) throw new Error(`Authentication qualification: ${why}`);}
async function issued(p:Promise<AuthAdmission>) {
 const a=await p; check(a.kind==='issued','protected admission not issued'); return a;
}
async function assertRuntimeIdentity(client:AuthQueryClient,clean=false):Promise<number> {
 const rows=(await client.query(`SELECT current_user AS current_role,session_user AS session_role,
   current_setting('role') AS role_setting,current_setting('row_security') AS row_security,r.rolsuper,r.rolbypassrls,
   EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS membership,
   pg_backend_pid() AS backend,
   (SELECT xact_start=query_start FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS transaction_clean
   FROM pg_roles r WHERE rolname=current_user`)).rows;
 const r=rows[0];
 check(rows.length===1&&r?.current_role==='swat_app'&&r.session_role==='swat_app'&&r.role_setting==='none'&&r.row_security==='on'
  &&r.rolsuper===false&&r.rolbypassrls===false&&r.membership===false&&(!clean||r.transaction_clean===true)
  &&Number.isInteger(r.backend)&&r.backend>0,'distinct clean direct runtime identity/backend');
 return r.backend as number;
}
async function runtime<T>(ports:AuthenticationQualificationPorts,op:(c:AuthQueryClient)=>Promise<T>):Promise<T> {
 const l=await ports.acquireRuntime();check(l?.client&&typeof l.release==='function','owned runtime lease required');
 let open=false,commit=false,broken=false,backend:number|undefined;
 try {
  backend=await assertRuntimeIdentity(l.client,true);
  await assertAuthenticationTarget(l.client,ports.target,false);
  check(await assertRuntimeIdentity(l.client,true)===backend,'runtime backend changed before BEGIN');
  const b=await l.client.query('BEGIN');check(b.command==='BEGIN','runtime BEGIN');open=true;
  check(await assertRuntimeIdentity(l.client)===backend,'runtime backend changed at BEGIN');
  await l.client.query(AUTH_RESET_SQL);const result=await op(l.client);
  await l.client.query(AUTH_RESET_SQL);
  check(await assertRuntimeIdentity(l.client)===backend,'runtime backend changed before COMMIT');
  commit=true;
  check((await l.client.query('COMMIT')).command==='COMMIT','runtime COMMIT uncertain');open=false;commit=false;return result;
 }catch(e){
  broken=true;
  if(open&&!commit){
   // An ACL failure can abort the transaction and prevent identity observation.
   // Discard that lease without claiming rollback, retaining only the ACL refusal.
   let observed:number;
   try{observed=await assertRuntimeIdentity(l.client);}
   catch(identityError){if((identityError as {code?:string}).code==='25P02')throw e;throw identityError;}
   check(observed===backend,'runtime backend changed before ROLLBACK');
   try{if((await l.client.query('ROLLBACK')).command==='ROLLBACK')open=false;}
   catch{/* discard without claiming rollback */}
  }
  throw e;
 }
 finally{l.release(open||broken);}
}
async function denied(ports:AuthenticationQualificationPorts,sql:string,values:unknown[]):Promise<void> {
 let rejected=false;
 try { await runtime(ports,async c=>{await c.query(sql,values);}); }
 catch(e){check((e as {code?:string}).code==='42501','hostile query must reach ACL refusal, not arbitrary error');rejected=true;}
 check(rejected,'hostile runtime auth write/function did not refuse');
}
/** Actual production owned store, exact direct identities, SQL assertions and independently
 * acquired concurrent transactions. No fake fixture hashes/callbacks confer authority.
 * Observer fixture changes are limited to synthetic generated user/session IDs. Caller
 * must own disposable resource cleanup; no DELETE-all, arbitrary SQL executor or live calls. */
export async function qualifyProtectedAuthentication(supplied:AuthenticationQualificationPorts) {
 check(supplied&&['acquireAuth','acquireRuntime','acquireObserver'].every(k=>typeof supplied[k as keyof AuthenticationQualificationPorts]==='function'),'all externally owned capabilities required');
 check(supplied.target?.database&&/^\d+\.\d+\.\d+\.\d+$/.test(supplied.target.address)&&supplied.target.port===5432&&/^\d+$/.test(supplied.target.systemIdentifier),'inspected authentication qualification target required');
 function bound(acquire:()=>Promise<AuthClientLease>,system:boolean){return async()=>{
  const lease=await acquire();check(lease?.client&&typeof lease.release==='function','owned target-bound lease required');
  try{await assertAuthenticationTarget(lease.client,supplied.target,system);return lease;}catch(e){lease.release(true);throw e;}
 };}
 const ports:AuthenticationQualificationPorts={...supplied,acquireAuth:bound(supplied.acquireAuth,false),
  // runtime owns identity/cleanliness and target observation in that order on its lease.
  acquireRuntime:supplied.acquireRuntime,acquireObserver:bound(supplied.acquireObserver,true)};
 // Independent system identifier observation precedes any fixture admission. Auth/app
 // stay least-privileged and cannot call pg_control_system themselves.
 const initialObserver=await ports.acquireObserver();initialObserver.release(false);
 const f=ports.fixture;
 check(f&&f.emailA.endsWith('@example.invalid')&&f.emailB.endsWith('@example.invalid')&&f.emailA!==f.emailB
  &&f.password.length>=12&&f.newPassword.length>=12&&ports.signature?.address===f.walletAddress
  &&['evm','solana'].includes(ports.signature.chainKind)&&typeof ports.signature.signSyntheticChallenge==='function'
  &&typeof ports.nonceStore?.set==='function'&&typeof ports.nonceStore.getdel==='function'
  &&['postgres-blocking-edge','offline-protocol-interleaving'].includes(ports.overlapObservation),'synthetic isolated fixture and route/schedule capabilities only');
 const store=createOwnedAuthStore(createCheckedAuthTransaction(ports.acquireAuth));
 const http=await createAuthenticationHttp(store,ports.nonceStore,ports.signature);
 const walletInput={chainKind:ports.signature.chainKind,address:f.walletAddress};
 const overlap={acquireAuth:ports.acquireAuth,acquireObserver:ports.acquireObserver,observerRole:ports.observerRole,observation:ports.overlapObservation};
 const schedules:unknown[]=[];
 try {
 const hostile=await ports.acquireAuth();let hostileBroken=false,hostileOpen=false,hostileDenied=false;
 try{
  await assertAuthIdentity(hostile.client,true);
  check((await hostile.client.query('BEGIN')).command==='BEGIN','hostile auth BEGIN');hostileOpen=true;
  await hostile.client.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.bypass_rls','on',true)",['11111111-1111-4111-8111-111111111111']);
  try{await hostile.client.query('SELECT public.swat_auth_resolve($1::bytea)',[hashToken('forged-cookie')]);}
  catch(e){check((e as {code?:string}).code==='42501','auth forged claims exact guard refusal');hostileDenied=true;}
  check(hostileDenied,'auth forged tenant/bypass claims admitted');
 }catch(e){hostileBroken=true;throw e;}
 finally{if(hostileOpen){try{check((await hostile.client.query('ROLLBACK')).command==='ROLLBACK','hostile rollback');}catch{hostileBroken=true;}}hostile.release(hostileBroken);}
 const a=await issued(store.signup({email:f.emailA,password:f.password}));
 const b=await issued(store.signup({email:f.emailB,password:f.password}));
 check(a.user.id!==b.user.id&&a.user.role==='user'&&b.user.role==='user','server-issued nonadmin distinct users');
 check((await store.login(f.emailA,'wrong-synthetic')).kind==='invalid','wrong-password secrecy');
 check((await store.login('missing-auth-qualification@example.invalid','wrong-synthetic')).kind==='invalid','unknown-password secrecy');
 const login=await issued(store.login(f.emailA,f.password));
 check((await store.resolveSession(login.session.token))?.user.id===a.user.id,'fresh login resolution');
 check(await store.resolveSession('forged-synthetic-cookie')===null,'forged session refused');
 const linkedRoute=await http.wallet(login.session.token);check(linkedRoute.statusCode===200,'verified integrated wallet link route');
 const linked=(await store.profile(login.session.token))?.wallets[0];check(linked,'verified route persisted wallet');
 const relinkRoute=await http.wallet(login.session.token);check(relinkRoute.statusCode===200,'verified idempotent link route');
 check((await store.profile(login.session.token))?.wallets[0]?.id===linked.id,'atomic idempotent linked wallet');
 check((await http.wallet(b.session.token)).statusCode===409,'cross-owner verified link refused');
 const walletRoute=await http.wallet();check(walletRoute.statusCode===200&&walletRoute.json().user.id===a.user.id,'verified wallet login route');
 const walletToken=walletRoute.cookies.find(c=>c.name==='swat_session')?.value;check(walletToken,'wallet route committed cookie');
 const replay=await http.challenge();check((await http.verify(replay)).statusCode===200,'one-use initial signature');
 check((await http.verify(replay)).statusCode===410,'GETDEL replay refused');
 const origin=await http.challenge();check((await http.verify(origin,undefined,'http://hostile.example.invalid')).statusCode===401,'hostile origin refused');
 check((await http.verify(origin)).statusCode===410,'origin failure consumed challenge');
 const intent=await http.challenge(login.session.token);check((await http.verify(intent,b.session.token)).statusCode===401,'session-intent substitution refused');
 const anonymousIntent=await http.challenge(login.session.token);check((await http.verify(anonymousIntent)).statusCode===401,'link intent cannot become login');
 const bad=await http.challenge();check((await http.verify({...bad,signature:'synthetic-invalid-signature'})).statusCode===401,'actual signature verifier refusal');
 const ownerRace=await overlapAuthentication(overlap,{name:'competing-owner',leaderRoutine:'swat_auth_link_wallet',contenderRoutine:'swat_auth_link_wallet',
  leader:s=>s.linkWallet(login.session.token,walletInput),contender:s=>s.linkWallet(b.session.token,walletInput)});
 check(ownerRace.leader.status==='fulfilled'&&ownerRace.contender.status==='rejected'&&ownerRace.contender.reason?.name==='WalletAlreadyLinkedError','overlapping owner conflict');schedules.push(ownerRace);
 const idempotence=await overlapAuthentication(overlap,{name:'idempotent-link',leaderRoutine:'swat_auth_link_wallet',contenderRoutine:'swat_auth_link_wallet',
  leader:s=>s.linkWallet(login.session.token,walletInput),contender:s=>s.linkWallet(login.session.token,walletInput)});
 check(idempotence.leader.status==='fulfilled'&&idempotence.contender.status==='fulfilled'&&idempotence.leader.value.id===idempotence.contender.value.id,'overlapping idempotence');schedules.push(idempotence);
 const unlinkLogin=await overlapAuthentication(overlap,{name:'unlink-before-wallet-login',leaderRoutine:'swat_auth_unlink_wallet',contenderRoutine:'swat_auth_wallet_owner',
  leader:s=>s.unlinkWallet(login.session.token,walletInput),contender:s=>s.walletLogin(walletInput)});
 check(unlinkLogin.leader.status==='fulfilled'&&unlinkLogin.leader.value===true&&unlinkLogin.contender.status==='fulfilled'&&unlinkLogin.contender.value.kind==='invalid','unlink/login fresh postlock provenance');schedules.push(unlinkLogin);
 check((await http.wallet(login.session.token)).statusCode===200,'verified relink after overlap');
 const relinked=(await store.profile(login.session.token))?.wallets.find(w=>w.chainKind===walletInput.chainKind&&w.address===walletInput.address);
 check(relinked,'relinked wallet fresh durable identity');
 await denied(ports,'SELECT public.swat_auth_resolve($1::bytea)',[hashToken(login.session.token)]);
 await denied(ports,'UPDATE public.users SET password_hash=$2 WHERE id=$1',[a.user.id,'$argon2id$forged']);
 await denied(ports,'TRUNCATE public.user_sessions',[]);
 await denied(ports,'INSERT INTO public.auth_wallet_proofs(wallet_id,user_id,chain_kind,address,verified_at,audit_id) VALUES($1,$2,$3,$4,clock_timestamp(),1)',[linked.id,a.user.id,'evm',f.walletAddress]);
 await runtime(ports,async c=>{
  await c.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.bypass_rls','on',true)",[a.user.id]);
  const rows=(await c.query('SELECT id,email FROM public.users ORDER BY id')).rows;
  check(rows.length===1&&rows[0]?.id===a.user.id,'forged bypass cannot grant cross-tenant/global read');
  check((await c.query('SELECT id FROM public.user_auth_wallets WHERE user_id=$1',[b.user.id])).rows.length===0,'cross-tenant wallet refused');
 });
 // Root-lock serialization: either overlapping login happens before password change
 // and is revoked, or it reads the changed hash and fails. No surviving old-password session.
 const race=await overlapAuthentication(overlap,{name:'login-before-password-change',leaderRoutine:'swat_auth_password',contenderRoutine:'swat_auth_change_password',
  leader:s=>s.login(f.emailA,f.password),contender:s=>s.changePassword(login.session.token,f.newPassword)});
 check(race.leader.status==='fulfilled'&&race.contender.status==='fulfilled','password overlap outcomes');
 if(race.leader.value.kind==='issued')check(await store.resolveSession(race.leader.value.session.token)===null,'password-change race left old-password session');schedules.push(race);
 for(const token of [a.session.token,login.session.token,walletToken]) check(await store.resolveSession(token)===null,'atomic all-session revocation');
 check((await store.login(f.emailA,f.password)).kind==='invalid','old password invalid after change');
 const fresh=await issued(store.login(f.emailA,f.newPassword));
 // Concurrent session lookup/revoke must never restore a committed revocation.
 const revokeRace=await overlapAuthentication(overlap,{name:'revoke-before-resolution',leaderRoutine:'swat_auth_revoke',contenderRoutine:'swat_auth_touch',
  leader:s=>s.revokeSession(fresh.session.token),contender:s=>s.resolveSession(fresh.session.token)});
 check(revokeRace.leader.status==='fulfilled'&&revokeRace.contender.status==='fulfilled'&&revokeRace.contender.value===null,'postlock revocation race');schedules.push(revokeRace);
 check(await store.resolveSession(fresh.session.token)===null,'fresh revocation/race');
 const idle=await issued(store.login(f.emailA,f.newPassword));
 check((await store.resolveSession(idle.session.token))?.user.id===a.user.id,'idle fixture first touch');
 async function assertObserver(client:AuthQueryClient) {
  const r=(await client.query(`SELECT current_user AS current_role,session_user AS session_role,
   current_setting('role') AS role_setting,current_setting('row_security') AS row_security,r.rolsuper FROM pg_roles r WHERE rolname=current_user`)).rows[0];
  check(/^[a-z][a-z0-9_]{0,62}$/.test(ports.observerRole)&&!ports.observerRole.startsWith('swat_')
   &&r?.current_role===ports.observerRole&&r.session_role===ports.observerRole&&r.role_setting==='none'
   &&r.row_security==='on'&&r.rolsuper===true,'direct external disposable observer');
 }
 const observer=await ports.acquireObserver();let observerBroken=false;
 try {
  await assertObserver(observer.client);
  const proof=(await observer.client.query(`SELECT p.user_id,p.wallet_id,
    a.actor_id=p.user_id AND a.event='auth.wallet_linked' AND a.target_id=p.address
      AND a.occurred_at=p.verified_at AS audit_matches
    FROM public.auth_wallet_proofs p JOIN public.audit_log a ON a.id=p.audit_id WHERE p.wallet_id=$1`,[relinked.id])).rows;
  check(proof.length===1&&proof[0]?.user_id===a.user.id&&proof[0].wallet_id===relinked.id&&proof[0].audit_matches===true,'persisted protected wallet provenance/audit');
  const lifetime=(await observer.client.query(`SELECT expires_at-issued_at<=interval '30 days' AS absolute_bound,
    last_seen_at-issued_at<interval '1 second' AS touch_throttled FROM public.user_sessions WHERE user_id=$1 AND token_hash=$2`,
    [a.user.id,hashToken(idle.session.token)])).rows[0];
  check(lifetime?.absolute_bound===true&&lifetime.touch_throttled===true,'database absolute session bound and touch throttle');
  // Explicit single autocommit fixture adjustment on exact generated token+user, no ambient ID.
  await observer.client.query('UPDATE public.user_sessions SET last_seen_at=clock_timestamp()-interval \'8 days\' WHERE user_id=$1 AND token_hash=$2',[a.user.id,hashToken(idle.session.token)]);
 }catch(e){observerBroken=true;throw e;}finally{observer.release(observerBroken);}
 check(await store.resolveSession(idle.session.token)===null,'7-day idle expiry');
 const absolute=await issued(store.login(f.emailA,f.newPassword));
 const l=await ports.acquireObserver();let failed=false;
 try{await assertObserver(l.client);await l.client.query('UPDATE public.user_sessions SET issued_at=clock_timestamp()-interval \'31 days\' WHERE user_id=$1 AND token_hash=$2',[a.user.id,hashToken(absolute.session.token)]);}
 catch(e){failed=true;throw e;}finally{l.release(failed);}
 check(await store.resolveSession(absolute.session.token)===null,'30-day absolute expiry');
 const active=await issued(store.login(f.emailA,f.newPassword));
 await store.unlinkWallet(active.session.token,walletInput);
 check((await http.wallet()).statusCode===401,'unlink removes linked provenance authority through verified route');
 await store.revokeAllSessions(active.session.token);await store.revokeAllSessions(b.session.token);
 // Pool reuse: hostile pre-session claims rejected, checked wrapper always resets LOCAL
 // tenant/bypass/worker before routines and after completion. Separate raw same-client check.
 const lease=await ports.acquireAuth();let broken=false;
 try{
  await assertAuthIdentity(lease.client);
  const r=(await lease.client.query(`SELECT COALESCE(current_setting('app.current_user_id',true),'') AS tenant,
   COALESCE(current_setting('app.bypass_rls',true),'off') AS bypass,
   COALESCE(current_setting('app.worker_execution_id',true),'') AS worker`)).rows[0];
  check(r?.tenant===''&&r.bypass==='off'&&r.worker==='','pool GUC reset across successful/failed transactions');
 }catch(e){broken=true;throw e;}finally{lease.release(broken);}
 return {scenario:'protected-authentication-signup-password-session-wallet-races',boundary:authenticationSourceBoundary,
  users:[a.user.id,b.user.id],facts:{crossTenantRefused:true,forgedClaimsRefused:true,passwordRaceRevoked:true,
   walletProvenanceAtomic:true,revocationFresh:true,idleAndAbsoluteExpiry:true,poolResetObserved:true},schedules,observation:ports.overlapObservation,blocked:authenticationSourceBlockers};
 }finally{await http.close();}
}
