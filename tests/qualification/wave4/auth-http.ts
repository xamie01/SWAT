import { createRequire } from 'node:module';
import { registerAuth,registerAdminOnlyGlobals } from '../../../apps/api/src/auth/plugin.js';
import { registerAuthRoutes,type AuthNonceStore } from '../../../apps/api/src/auth/routes.js';
import type { OwnedAuthStore } from '../../../packages/db/src/auth-owned.js';

export interface SyntheticAuthSignature {
 readonly chainKind:'evm'|'solana'; readonly address:string;
 /** Explicit synthetic ephemeral fixture signer. Never loaded from credentials or environment. */
 signSyntheticChallenge(message:string):Promise<string>;
}
export async function createAuthenticationHttp(store:OwnedAuthStore,nonceStore:AuthNonceStore,signature:SyntheticAuthSignature) {
 if(typeof signature?.signSyntheticChallenge!=='function'||!['evm','solana'].includes(signature.chainKind)
  ||typeof nonceStore?.set!=='function'||typeof nonceStore.getdel!=='function')throw new Error('Explicit synthetic signature and atomic nonce capabilities required');
 const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));
 const Fastify=require('fastify'),cookie=require('@fastify/cookie');
 const app:import('fastify').FastifyInstance=Fastify({logger:false});
 const uri='http://auth.example.invalid';
 try{
  await app.register(cookie);
  await registerAuth(app,{resolveSession:store.resolveSession,legacyKeyHash:Buffer.alloc(32),isProduction:false,consumeSseTicket:async()=>false});
  await registerAdminOnlyGlobals(app);
  await registerAuthRoutes(app,{store,redis:nonceStore,isProduction:false,domain:'auth.example.invalid',uri,allowedOrigins:[uri]});
  await app.ready(); // inject only; never listen or open a loopback socket
 }catch(e){await app.close();throw e;}
 function headers(token?:string){return {origin:uri,...(token?{cookie:`swat_session=${token}; swat_csrf=synthetic-csrf`,'x-csrf-token':'synthetic-csrf'}:{})};}
 async function challenge(token?:string){
  const r=await app.inject({method:'POST',url:'/v1/auth/wallet/nonce',headers:headers(token),payload:{chainKind:signature.chainKind,address:signature.address}});
  if(r.statusCode!==200)throw new Error(`Authentication nonce route refused ${r.statusCode}`);
  const p=r.json() as {nonce:string;message:string};
  return {chainKind:signature.chainKind,address:signature.address,message:p.message,signature:await signature.signSyntheticChallenge(p.message)};
 }
 async function verify(payload:Awaited<ReturnType<typeof challenge>>,token?:string,origin=uri){
  return app.inject({method:'POST',url:'/v1/auth/wallet/verify',headers:{...headers(token),origin},payload});
 }
 async function wallet(token?:string){const payload=await challenge(token);return verify(payload,token);}
 return {app,headers,challenge,verify,wallet,close:()=>app.close()};
}
