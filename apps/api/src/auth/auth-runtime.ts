import type { FastifyInstance } from 'fastify';
import { createCheckedAuthTransaction, createOwnedAuthStore, type AuthClientLease, type OwnedAuthStore } from '@swat/db/dist/auth-owned.js';
import { registerAuth, registerAdminOnlyGlobals, type AuthPluginOptions } from './plugin.js';
import { registerAuthRoutes, type AuthRouteOptions } from './routes.js';

/** Import-safe composition. Caller owns a SEPARATE direct swat_auth_service pool/lease
 * and all shutdown/drain lifetimes. No DB URL, replica, shared app pool or Redis inferred.
 * A supplied pool is not trusted by its name: each BEGIN/COMMIT backend is checked. */
export interface DirectAuthPool {
  connect(): Promise<AuthClientLease['client'] & { release(error?: boolean): void }>;
}
export function createAuthStoreFromDirectPool(pool: DirectAuthPool): OwnedAuthStore {
  if (!pool || typeof pool.connect!=='function') throw new Error('Separate externally supplied direct auth pool required');
  return createOwnedAuthStore(createCheckedAuthTransaction(async()=>{
    const client=await pool.connect();
    return {client,release:broken=>client.release(broken)};
  }));
}
export function createAuthRuntime(acquire: () => Promise<AuthClientLease>): OwnedAuthStore {
  return createOwnedAuthStore(createCheckedAuthTransaction(acquire));
}
export async function registerProtectedAuthentication(app: FastifyInstance,input: {
  store: OwnedAuthStore; plugin: Omit<AuthPluginOptions,'resolveSession'>; routes: Omit<AuthRouteOptions,'store'>
}): Promise<void> {
  await registerAuth(app,{...input.plugin,resolveSession:input.store.resolveSession});
  await registerAdminOnlyGlobals(app);
  await app.register(async scope=>registerAuthRoutes(scope,{...input.routes,store:input.store}));
}
/** Executable startup integration: SWAT_API_AUTH_COMPOSITION_MODULE must name an
 * externally installed local module exporting acquireDirectAuthLease. The factory
 * receives no app credentials/pool. Missing capability refuses startup, never fallback. */
export async function loadExternalAuthRuntime(modulePath: string | undefined): Promise<OwnedAuthStore> {
  if (!modulePath || !modulePath.startsWith('/') || !/\.(?:mjs|js)$/.test(modulePath))
    throw new Error('SWAT_API_AUTH_COMPOSITION_MODULE absolute local module required');
  const { pathToFileURL }=await import('node:url');
  const module=await import(pathToFileURL(modulePath).href) as {acquireDirectAuthLease?:()=>Promise<AuthClientLease>};
  if(typeof module.acquireDirectAuthLease!=='function') throw new Error('External direct auth lease export required');
  return createAuthRuntime(module.acquireDirectAuthLease);
}
