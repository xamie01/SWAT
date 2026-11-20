import { createHash } from 'node:crypto';
import type { AuthClientLease, AuthQueryClient } from '../../packages/db/src/auth-owned.js';
import { AUTH_MIGRATION_SHA256, provisionCommittedAuthentication, validateAuthenticationInstallation, type AuthCatalogPhase } from './auth-provisioning.js';

export interface AuthInstallationTarget {
 readonly database: string; readonly address: string; readonly port: number; readonly systemIdentifier: string;
}
/** Nonambient capabilities, not serializable config flags. Target must come from the
 * separately inspected disposable cluster; no app credentials are supplied to the DBA. */
export interface AuthenticationInstallation {
 readonly target: AuthInstallationTarget;
 readonly dbaRole: string;
 readonly acquireDba: () => Promise<AuthClientLease>;
}
export interface AuthenticationActivation {
 /** Separately authorized external DBA lifecycle operation, including credential provisioning,
  * scheduled NOLOGIN and session drain. This module never emits LOGIN/password SQL. */
 readonly activateExternally: () => Promise<void>;
 readonly expiresAt: Date;
}
const file='087_wave4_protected_authentication.sql';
export function authenticationInstallationSource(source:{files:readonly {file:string;sql:string;checksum:string}[]},installation?:AuthenticationInstallation):string|null {
 const migration=source.files.find(m=>m.file===file);
 if(!migration)return null;
 assertAuthenticationInstallation(installation);
 if(migration.checksum!==AUTH_MIGRATION_SHA256||createHash('sha256').update(migration.sql).digest('hex')!==AUTH_MIGRATION_SHA256)throw new Error('Exact selected inert 087 authentication source required');
 return migration.sql;
}
export function assertAuthenticationInstallation(input:AuthenticationInstallation|undefined):asserts input is AuthenticationInstallation {
 const t=input?.target;
 if(typeof input?.acquireDba!=='function'||!/^[a-z][a-z0-9_]{0,62}$/.test(input.dbaRole)||input.dbaRole.startsWith('swat_')
  ||!t||!t.database||!/^\d+\.\d+\.\d+\.\d+$/.test(t.address)||t.port!==5432||!/^\d+$/.test(t.systemIdentifier))throw new Error('Explicit distinct direct authentication DBA installation capability and inspected target required');
}
export async function assertAuthenticationTarget(client:AuthQueryClient,expected:AuthInstallationTarget,observeSystem=true):Promise<void> {
 const rows=(await client.query(`SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port${observeSystem?', system_identifier::text AS system_identifier FROM pg_catalog.pg_control_system()':''}`)).rows;
 const a=rows[0];
 if(rows.length!==1||!a||a.database!==expected.database||a.address!==expected.address||a.port!==expected.port||observeSystem&&a.system_identifier!==expected.systemIdentifier)throw new Error('Authentication direct owned lease target differs from inspected cluster');
}
function acquisition(input:AuthenticationInstallation):()=>Promise<AuthClientLease> {
 assertAuthenticationInstallation(input);
 return async()=>{
  const lease=await input.acquireDba();
  if(!lease?.client||typeof lease.release!=='function')throw new Error('Authentication separately owned direct DBA lease required');
  try {
   // Observe direct DBA identity and clean lease BEFORE any target query; a hostile
   // supplied transaction is never borrowed or committed by this stage.
   const rows=(await lease.client.query(`SELECT current_user AS role,session_user AS session,current_setting('role') AS role_setting,
    current_setting('row_security') AS row_security,r.rolsuper,
    (SELECT xact_start=query_start FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS clean
    FROM pg_roles r WHERE rolname=current_user`)).rows;
   const r=rows[0];if(rows.length!==1||r?.role!==input.dbaRole||r.session!==input.dbaRole||r.role_setting!=='none'||r.row_security!=='on'||r.rolsuper!==true||r.clean!==true)throw new Error('Authentication staging distinct clean direct DBA lease required');
   await assertAuthenticationTarget(lease.client,input.target);
   return lease;
  }catch(e){lease.release(true);throw e;}
 };
}
/** Must be called only AFTER checked migration COMMIT and seven-transfer broker retirement.
 * Committed broker absence is independently observed, never inferred from journal labels. */
export async function installCommittedAuthentication(input:AuthenticationInstallation,installedSql:string):Promise<void> {
 assertAuthenticationInstallation(input);
 const acquire=acquisition(input);
 const lease=await acquire();let broken=false;
 try{
  const rows=(await lease.client.query(`SELECT n.oid FROM pg_namespace n WHERE n.nspname='swat_migration_handoff'`)).rows;
  if(rows.length)throw new Error('Authentication handoff requires committed retirement of existing installation broker');
 }catch(e){broken=true;throw e;}finally{lease.release(broken);}
 await provisionCommittedAuthentication({acquire,dbaRole:input.dbaRole,installedSql});
 // New acquisition and read-only transaction, not the handoff transaction snapshot.
 await validateInstalledAuthentication(input,installedSql,'disabled');
}
export async function validateInstalledAuthentication(input:AuthenticationInstallation,installedSql:string,phase:AuthCatalogPhase='disabled'):Promise<void> {
 assertAuthenticationInstallation(input);
 await validateAuthenticationInstallation({acquire:acquisition(input),dbaRole:input.dbaRole,installedSql,phase});
}
export async function activateInstalledAuthentication(input:AuthenticationInstallation,installedSql:string,activation:AuthenticationActivation):Promise<void> {
 assertAuthenticationInstallation(input);
 if(typeof activation?.activateExternally!=='function'||!(activation.expiresAt instanceof Date)||!Number.isFinite(activation.expiresAt.getTime())
  ||activation.expiresAt.getTime()<=Date.now()||activation.expiresAt.getTime()>Date.now()+86_400_000)throw new Error('Separately authorized bounded external authentication activation required');
 await validateInstalledAuthentication(input,installedSql,'disabled');
 await activation.activateExternally();
 if(Date.now()>=activation.expiresAt.getTime())throw new Error('Authentication external activation expired');
 await validateInstalledAuthentication(input,installedSql,'active');
}
