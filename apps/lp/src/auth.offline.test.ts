import {expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {registerLpAuth,loadExternalLpAuthResolver,createLpAuthResolver} from './auth.js';
import {AUTH_IDENTITY_SQL,type AuthQueryClient} from '@swat/db/dist/auth-owned.js';
vi.mock('@swat/db',()=>({forUser:(userId:string)=>({userId}),resolveSession:()=>{throw new Error('Forbidden ambient barrel resolver');}}));
it('refuses missing resolver before installing hooks and missing startup module before acquisition',async()=>{
 const app=Fastify();await expect(registerLpAuth(app,{} as any)).rejects.toThrow('Explicit');
 expect(app.hasRequestDecorator('principal')).toBe(false);
 await expect(loadExternalLpAuthResolver(undefined)).rejects.toThrow('COMPOSITION_MODULE');await app.close();
});
it('actual LP cookie consumer calls explicitly injected authoritative resolver on every request',async()=>{
 const app=Fastify();await (app.register as any)(cookie);
 const resolveSession=vi.fn(async()=>({sessionId:'synthetic',user:{id:'11111111-1111-4111-8111-111111111111',email:'lp@example.invalid',displayName:null,role:'user' as const,tier:'free' as const,tierExpiresAt:null,status:'active' as const,createdAt:new Date()}}));
 await registerLpAuth(app,{resolveSession});app.get('/v1/protected',async req=>({principal:req.principal?.kind}));
 for(let i=0;i<2;i++)expect((await app.inject({url:'/v1/protected',headers:{cookie:'swat_session=synthetic'}})).statusCode).toBe(200);
 expect(resolveSession).toHaveBeenCalledTimes(2);await app.close();
});
it('checked LP resolver rejects an app lease before any authentication SQL',async()=>{
 const query=vi.fn(async()=>({rows:[{role_name:'swat_app'}]})),release=vi.fn();
 const resolver=createLpAuthResolver(async()=>({client:{query} as unknown as AuthQueryClient,release}));
 await expect(resolver('synthetic')).rejects.toThrow('identity');
 expect(query).toHaveBeenCalledWith(AUTH_IDENTITY_SQL);expect(query).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledWith(true);
});
