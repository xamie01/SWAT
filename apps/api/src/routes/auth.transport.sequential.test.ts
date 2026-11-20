import { expect,it,vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { createHash } from 'node:crypto';
vi.mock('@swat/db/dist/auth-owned.js',async()=>import('../../../../packages/db/src/auth-owned.js'));
import { registerPackage28Limiters,loadPackage28LimiterConfig } from '../package28-limiter.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { registerAuthRoutes } from '../auth/routes.js';
import { registerAuth,registerAdminOnlyGlobals } from '../auth/plugin.js';
import { createAuthRuntime } from '../auth/auth-runtime.js';
import { AUTH_IDENTITY_SQL, type AuthQueryClient, type OwnedAuthStore } from '../../../../packages/db/src/auth-owned.js';
const user={id:'11111111-1111-4111-8111-111111111111',email:'fixture@example.invalid',displayName:null,
 role:'user' as const,tier:'free' as const,tierExpiresAt:null,status:'active' as const,createdAt:new Date('2026-01-01')};
function store():OwnedAuthStore {
 return {signup:vi.fn(),login:vi.fn(async()=>({kind:'issued' as const,user,session:{token:'fixture-session',expiresAt:new Date('2030-01-01')}})),
 resolveSession:vi.fn(async()=>({sessionId:'fixture',user})),revokeSession:vi.fn(),revokeAllSessions:vi.fn(),changePassword:vi.fn(),
 profile:vi.fn(),linkWallet:vi.fn(),unlinkWallet:vi.fn(),walletLogin:vi.fn(),walletFailure:vi.fn()};
}
async function server(s=store()) {
 const app=Fastify({logger:false}); await app.register(cookie);
 await registerAuth(app,{resolveSession:s.resolveSession,isProduction:true,legacyKeyHash:createHash('sha256').update('fixture-only').digest(),consumeSseTicket:vi.fn(async()=>true)});
 await registerAdminOnlyGlobals(app);
 await registerAuthRoutes(app,{store:s,redis:{set:vi.fn(),getdel:vi.fn()},isProduction:true,domain:'example.invalid',uri:'https://example.invalid'});
 app.get('/v1/logs/stream',async()=>({connected:true}));
 app.get('/v1/me/fixture',async(request,reply)=>request.principal?.kind==='user' ? {id:request.principal.user.id} : reply.code(401).send({error:'Unauthorized'}));
 return app;
}
it('refuses query tickets, ordinary global users, unsupported bearer fallback and tenantless service',async()=>{
 const s=store(),app=await server(s);
 try {
  expect((await app.inject('/v1/logs/stream?ticket=fixture')).statusCode).toBe(401);
  expect((await app.inject({url:'/v1/logs/stream',headers:{cookie:'swat_session=fixture'}})).statusCode).toBe(403);
  expect((await app.inject({url:'/v1/logs/stream',headers:{authorization:'Bearer unsupported','x-api-key':'fixture-only'}})).statusCode).toBe(401);
  expect((await app.inject({url:'/v1/logs/stream',headers:{'x-api-key':'fixture-only'}})).statusCode).toBe(200);
  expect((await app.inject({url:'/v1/me/fixture',headers:{'x-api-key':'fixture-only'}})).statusCode).toBe(401);
  vi.mocked(s.resolveSession).mockResolvedValue({sessionId:'fixture',user:{...user,role:'admin'}});
  const admin=await app.inject({url:'/v1/logs/stream',headers:{cookie:'swat_session=fixture'}});
  expect(admin.statusCode).toBe(200); expect(admin.headers['cache-control']).toBe('no-store');
 } finally {await app.close();}
});
it('preserves CSRF on public wallet verify and stale cookies on login/signup',async()=>{
 const s=store(),app=await server(s);
 try {
  const csrf=await app.inject({method:'POST',url:'/v1/auth/wallet/verify',headers:{cookie:'swat_session=fixture'},payload:{}});
  expect(csrf.statusCode).toBe(403); expect(csrf.json().code).toBe('csrf_invalid');
  vi.mocked(s.resolveSession).mockResolvedValue(null);
  const login=await app.inject({method:'POST',url:'/v1/auth/login',headers:{cookie:'swat_session=stale'},payload:{email:user.email,password:'fixture-password'}});
  expect(login.statusCode).toBe(200); expect(login.headers['set-cookie']).toHaveLength(2);
  for(const c of login.headers['set-cookie'] as string[]) expect(c).toMatch(/; Secure(?:;|$)/);
  vi.mocked(s.signup).mockResolvedValue({kind:'issued',user,session:{token:'fixture-new',expiresAt:new Date('2030-01-01')}});
  expect((await app.inject({method:'POST',url:'/v1/auth/signup',headers:{cookie:'swat_session=stale'},payload:{email:user.email,password:'fixture-password'}})).statusCode).toBe(201);
 } finally {await app.close();}
});
it('real synthetic Solana signature, GETDEL replay and origin binding drive actual wallet API',async()=>{
 const s=store(),app=Fastify({logger:false}),nonces=new Map<string,string>();
 const redis={set:vi.fn(async(k:string,v:string)=>{nonces.set(k,v);}),getdel:vi.fn(async(k:string)=>{const v=nonces.get(k)??null;nonces.delete(k);return v;})};
 const key=nacl.sign.keyPair.fromSeed(Uint8Array.from({length:32},(_,i)=>i+1)),address=bs58.encode(key.publicKey);
 vi.mocked(s.walletLogin).mockResolvedValue({kind:'issued',user,session:{token:'wallet-session',expiresAt:new Date('2030-01-01')}});
 try{
  await app.register(cookie);await registerAuth(app,{resolveSession:s.resolveSession,isProduction:true,legacyKeyHash:createHash('sha256').update('fixture').digest(),consumeSseTicket:async()=>false});
  await registerAuthRoutes(app,{store:s,redis,isProduction:true,domain:'example.invalid',uri:'https://example.invalid'});
  const nonce=await app.inject({method:'POST',url:'/v1/auth/wallet/nonce',headers:{origin:'https://example.invalid'},payload:{chainKind:'solana',address}});
  const message=nonce.json().message as string,signature=bs58.encode(nacl.sign.detached(new TextEncoder().encode(message),key.secretKey));
  const payload={chainKind:'solana',address,message,signature};
  expect((await app.inject({method:'POST',url:'/v1/auth/wallet/verify',headers:{origin:'https://example.invalid'},payload})).statusCode).toBe(200);
  expect(s.walletLogin).toHaveBeenCalledWith({chainKind:'solana',address},expect.any(Object));
  expect((await app.inject({method:'POST',url:'/v1/auth/wallet/verify',payload})).statusCode).toBe(410);
  expect((await app.inject({method:'POST',url:'/v1/auth/wallet/nonce',headers:{origin:'https://hostile.invalid'},payload:{chainKind:'solana',address}})).statusCode).toBe(403);
 }finally{key.secretKey.fill(0);await app.close();}
});
it('limiter buckets refuse before resolver or owned login operation runs',async()=>{
 const app=Fastify({logger:false}),s=store();
 try{
  await app.register(cookie);await registerPackage28Limiters(app,loadPackage28LimiterConfig({RATE_LIMIT_MAX:'100',AUTH_RATE_LIMIT_MAX:'1',AUTH_ACCOUNT_RATE_LIMIT_MAX:'1'}));
  await registerAuth(app,{resolveSession:s.resolveSession,isProduction:true,legacyKeyHash:createHash('sha256').update('fixture').digest(),consumeSseTicket:async()=>false});
  await registerAuthRoutes(app,{store:s,redis:{set:vi.fn(),getdel:vi.fn()},isProduction:true,domain:'example.invalid',uri:'https://example.invalid'});
  const payload={email:user.email,password:'fixture-password'};
  expect((await app.inject({method:'POST',url:'/v1/auth/login',payload})).statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/v1/auth/login',headers:{cookie:'swat_session=fixture'},payload})).statusCode).toBe(429);
  expect(s.login).toHaveBeenCalledTimes(1);expect(s.resolveSession).not.toHaveBeenCalled();
 }finally{await app.close();}
});
it('never publishes cookies after an actual owned COMMIT uncertainty',async()=>{
 const release=vi.fn();
 const identity={role_name:'swat_auth_service',session_role:'swat_auth_service',role_setting:'none',row_security:'on',rolcanlogin:true,
  backend_pid:7,transaction_clean:true,role_defaults_safe:true,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolinherit:false,
  has_memberships:false,owns_objects:false,can_create:false};
 const client={query:vi.fn(async(sql:string)=>{
  if(sql===AUTH_IDENTITY_SQL) return {rows:[identity]};
  if(sql==='BEGIN ISOLATION LEVEL READ COMMITTED') return {rows:[],command:'BEGIN'};
  if(sql==='COMMIT') throw new Error('transport lost');
  if(sql.includes('swat_auth_signup')) return {rows:[{principal:{...user,display_name:null,tier_expires_at:null,created_at:user.createdAt}}]};
  if(sql.includes('swat_auth_issue')) return {rows:[{expires_at:new Date('2030-01-01')}]};
  return {rows:[]};
 })} as unknown as AuthQueryClient;
 const s=createAuthRuntime(async()=>({client,release})),app=await server(s);
 try {
  const r=await app.inject({method:'POST',url:'/v1/auth/signup',payload:{email:user.email,password:'fixture-password'}});
  expect(r.statusCode).toBe(500); expect(r.headers['set-cookie']).toBeUndefined(); expect(release).toHaveBeenCalledWith(true);
 } finally {await app.close();}
});
