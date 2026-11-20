import type { FastifyInstance, FastifyReply } from 'fastify';
import '@fastify/cookie';
import { z } from 'zod';
import { EmailAlreadyRegisteredError, WalletAlreadyLinkedError, AuthSessionRequiredError,
  type OwnedAuthStore, type AuthAdmission } from '@swat/db/dist/auth-owned.js';
import type { UserRecord, IssuedSession } from '@swat/db/dist/users.js';
import { buildSignInMessage, generateNonce, normaliseAddress, NONCE_TTL_SECONDS, verifySignInSignature } from './wallet-signature.js';
import { CSRF_COOKIE, SESSION_COOKIE, issueCsrfToken, requireUser } from './plugin.js';

const email = z.string().trim().min(3).max(254).email();
const password = z.string().min(12).max(200);
const signup = z.object({ email, password, displayName: z.string().trim().min(1).max(64).optional() });
const login = z.object({ email, password: z.string().min(1).max(200) });
const wallet = z.object({ chainKind: z.enum(['evm','solana']), address: z.string().trim().min(32).max(100) });
const verify = wallet.extend({ message: z.string().min(1).max(2000), signature: z.string().min(1).max(500) });
export interface AuthNonceStore {
  set(key: string,value: string,mode: 'EX',seconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}
export interface AuthRouteOptions {
  readonly store: OwnedAuthStore;
  readonly redis: AuthNonceStore;
  readonly isProduction: boolean;
  readonly domain: string;
  readonly uri: string;
  readonly allowedOrigins?: readonly string[];
}
function publicUser(u: UserRecord) {
  return { id:u.id,email:u.email,displayName:u.displayName,role:u.role,tier:u.tier,tierExpiresAt:u.tierExpiresAt };
}
export async function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): Promise<void> {
  const { store,redis } = options;
  if (!store || typeof store.signup!=='function' || typeof store.resolveSession!=='function') throw new Error('Protected owned auth store required');
  const originSet = new Set(options.allowedOrigins?.length ? options.allowedOrigins : [options.uri]);
  for (const origin of originSet) {
    const u=new URL(origin);
    if (u.origin!==origin || options.isProduction && u.protocol!=='https:') throw new Error('Exact auth origin required');
  }
  if (new URL(options.uri).host!==options.domain || !originSet.has(options.uri)) throw new Error('Auth domain/URI configuration mismatch');
  function establish(reply: FastifyReply, session: IssuedSession) {
    // Store promises resolve only AFTER checked successful COMMIT. No cookie on rejection.
    const secure=options.isProduction || process.env.COOKIE_SECURE==='true';
    reply.setCookie(SESSION_COOKIE,session.token,{httpOnly:true,secure,sameSite:'lax',path:'/',expires:session.expiresAt});
    reply.setCookie(CSRF_COOKIE,issueCsrfToken(),{httpOnly:false,secure,sameSite:'lax',path:'/',expires:session.expiresAt});
  }
  function admission(reply: FastifyReply,a: AuthAdmission,status=200,walletLogin=false) {
    if (a.kind==='invalid') return reply.code(401).send({error:walletLogin ? 'Wallet not linked to any account' : 'Invalid credentials'});
    if (a.kind==='inactive') return reply.code(403).send({error:'Account suspended'});
    establish(reply,a.session);
    return reply.code(status).send({user:publicUser(a.user)});
  }
  app.post('/v1/auth/signup',async(request,reply)=>{
    const p=signup.safeParse(request.body);
    if(!p.success) return reply.code(400).send({error:'Bad Request',message:'Invalid signup payload'});
    try { return admission(reply,await store.signup(p.data,{ip:request.ip,userAgent:request.headers['user-agent']}),201); }
    catch(e) { if(e instanceof EmailAlreadyRegisteredError) return reply.code(409).send({error:'Email already registered'}); throw e; }
  });
  app.post('/v1/auth/login',async(request,reply)=>{
    const p=login.safeParse(request.body);
    if(!p.success) return reply.code(400).send({error:'Bad Request',message:'Invalid login payload'});
    return admission(reply,await store.login(p.data.email,p.data.password,{ip:request.ip,userAgent:request.headers['user-agent']}));
  });
  app.post('/v1/auth/logout',async(request,reply)=>{
    const token=request.cookies[SESSION_COOKIE];
    if(token) await store.revokeSession(token,{ip:request.ip});
    reply.clearCookie(SESSION_COOKIE,{path:'/'}); reply.clearCookie(CSRF_COOKIE,{path:'/'});
    return reply.send({ok:true});
  });
  app.post('/v1/auth/logout-all',async(request,reply)=>{
    if(!requireUser(request,reply)) return;
    const token=request.cookies[SESSION_COOKIE];
    if(!token) return reply.code(401).send({error:'Unauthorized'});
    try { await store.revokeAllSessions(token); }
    catch(e) { if(e instanceof AuthSessionRequiredError) return reply.code(401).send({error:'Unauthorized'}); throw e; }
    reply.clearCookie(SESSION_COOKIE,{path:'/'}); reply.clearCookie(CSRF_COOKIE,{path:'/'});
    return reply.send({ok:true});
  });
  app.post('/v1/auth/password',async(request,reply)=>{
    if(!requireUser(request,reply)) return;
    const p=z.object({password}).safeParse(request.body),token=request.cookies[SESSION_COOKIE];
    if(!p.success) return reply.code(400).send({error:'Bad Request'});
    if(!token) return reply.code(401).send({error:'Unauthorized'});
    try { await store.changePassword(token,p.data.password); }
    catch(e) { if(e instanceof AuthSessionRequiredError) return reply.code(401).send({error:'Unauthorized'}); throw e; }
    reply.clearCookie(SESSION_COOKIE,{path:'/'}); reply.clearCookie(CSRF_COOKIE,{path:'/'});
    return reply.send({ok:true});
  });
  app.get('/v1/auth/me',async(request,reply)=>{
    if(!requireUser(request,reply)) return;
    const token=request.cookies[SESSION_COOKIE];
    const p=token ? await store.profile(token) : null;
    if(!p) return reply.code(401).send({error:'Unauthorized'});
    return reply.send({user:publicUser(p.user),wallets:p.wallets.map(w=>({chainKind:w.chainKind,address:w.address,verifiedAt:w.verifiedAt}))});
  });
  app.delete('/v1/auth/wallet',async(request,reply)=>{
    if(!requireUser(request,reply)) return;
    const p=wallet.safeParse(request.body),token=request.cookies[SESSION_COOKIE];
    if(!p.success) return reply.code(400).send({error:'Bad Request'});
    if(!token) return reply.code(401).send({error:'Unauthorized'});
    try { return reply.send({removed:await store.unlinkWallet(token,{...p.data,address:normaliseAddress(p.data.chainKind,p.data.address)})}); }
    catch(e) { if((e as {code?:string}).code==='28000') return reply.code(401).send({error:'Unauthorized'}); throw e; }
  });
  app.post('/v1/auth/wallet/nonce',async(request,reply)=>{
    const p=wallet.safeParse(request.body);
    if(!p.success) return reply.code(400).send({error:'Bad Request',message:'Invalid nonce payload'});
    const origin=typeof request.headers.origin==='string' ? request.headers.origin : options.uri;
    if(!originSet.has(origin)) return reply.code(403).send({error:'Forbidden origin'});
    const uri=origin,domain=new URL(uri).host,address=normaliseAddress(p.data.chainKind,p.data.address),nonce=generateNonce();
    const message=buildSignInMessage({domain,uri,address,nonce,issuedAt:new Date().toISOString(),chainKind:p.data.chainKind});
    // Bind full issued message and session/link intent. A challenge minted under one
    // session cannot later be spent linking to another account or logging in anonymously.
    await redis.set(`swat:siwe:${nonce}`,JSON.stringify({chainKind:p.data.chainKind,address,domain,uri,message,
      sessionId:request.principal?.kind==='user' ? request.principal.sessionId : null}),'EX',NONCE_TTL_SECONDS);
    return reply.send({nonce,message,expiresAt:new Date(Date.now()+NONCE_TTL_SECONDS*1000).toISOString()});
  });
  app.post('/v1/auth/wallet/verify',async(request,reply)=>{
    const p=verify.safeParse(request.body);
    if(!p.success) return reply.code(400).send({error:'Bad Request',message:'Invalid verify payload'});
    const address=normaliseAddress(p.data.chainKind,p.data.address);
    const nonce=p.data.message.split('\n').find(l=>l.startsWith('Nonce: '))?.slice(7).trim();
    if(!nonce || !/^[a-f0-9]{32}$/.test(nonce)) return reply.code(400).send({error:'Bad Request',message:'Missing nonce'});
    const raw=await redis.getdel(`swat:siwe:${nonce}`);
    if(!raw) return reply.code(410).send({error:'Nonce expired or already used'});
    let b: {chainKind:string;address:string;domain:string;uri:string;message:string;sessionId:string|null};
    try { b=JSON.parse(raw); } catch { return reply.code(401).send({error:'Invalid signature'}); }
    const currentSession=request.principal?.kind==='user' ? request.principal.sessionId : null;
    if(!b || b.chainKind!==p.data.chainKind || b.address!==address || b.message!==p.data.message
      || !originSet.has(b.uri) || new URL(b.uri).host!==b.domain || b.sessionId!==currentSession
      || request.headers.origin!==undefined && request.headers.origin!==b.uri)
      return reply.code(401).send({error:'Invalid signature'});
    const result=await verifySignInSignature({...p.data,address,expectedNonce:nonce,expectedDomain:b.domain,expectedUri:b.uri});
    if(!result.ok) {
      await store.walletFailure({chainKind:p.data.chainKind,address},{ip:request.ip});
      return reply.code(401).send({error:'Invalid signature'});
    }
    if(request.principal?.kind==='user') {
      const token=request.cookies[SESSION_COOKIE];
      if(!token) return reply.code(401).send({error:'Unauthorized'});
      try {
        const w=await store.linkWallet(token,{chainKind:p.data.chainKind,address},{ip:request.ip});
        return reply.send({wallet:{chainKind:w.chainKind,address:w.address,verifiedAt:w.verifiedAt}});
      } catch(e) {
        if(e instanceof WalletAlreadyLinkedError) return reply.code(409).send({error:'Wallet already linked to another account'});
        if((e as {code?:string}).code==='28000') return reply.code(401).send({error:'Unauthorized'});
        throw e;
      }
    }
    return admission(reply,await store.walletLogin({chainKind:p.data.chainKind,address},{ip:request.ip,userAgent:request.headers['user-agent']}),200,true);
  });
}
