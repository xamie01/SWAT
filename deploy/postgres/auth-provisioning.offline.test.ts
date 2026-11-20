import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {AUTH_FUNCTION_SIGNATURES,provisionCommittedAuthentication,validateAuthenticationInstallation} from './auth-provisioning.js';
import type {AuthQueryClient} from '../../packages/db/src/auth-owned.js';
import {authenticationCatalogRows} from './auth-catalog-fixture.js';
import {installCommittedAuthentication,activateInstalledAuthentication,authenticationInstallationSource} from './auth-installation.js';
import {AUTH_MIGRATION_SHA256} from './auth-provisioning.js';
const sql=readFileSync(new URL('../../packages/db/sql/087_wave4_protected_authentication.sql',import.meta.url),'utf8');
export function fixture() {
 let phase='inert',created=false,active=false;const calls:string[]=[],release=vi.fn();
 const pins=[...sql.matchAll(/CREATE FUNCTION public\.(swat_auth_\w+)\(([^)]*)\) RETURNS (.*?) LANGUAGE (\w+) SECURITY (DEFINER|INVOKER) SET search_path=pg_catalog AS \$\$([\s\S]*?)\$\$;/g)];
 const tableGrants:Record<string,Record<string,string[]>>={users:{SELECT:[''],INSERT:['email','password_hash','display_name','role','tier','status'],UPDATE:['password_hash','updated_at']},
  user_sessions:{SELECT:[''],INSERT:['user_id','token_hash','issued_at','last_seen_at','expires_at','ip','user_agent'],UPDATE:['revoked_at','last_seen_at']},
  user_auth_wallets:{SELECT:[''],DELETE:[''],INSERT:['user_id','chain_kind','address','verified_at'],UPDATE:['verified_at']},auth_wallet_proofs:{SELECT:[''],INSERT:[''],UPDATE:['']},audit_log:{INSERT:[''],SELECT:['id']}};
 const appGrants:Record<string,Record<string,string[]>>={users:{SELECT:['id','email','display_name','role','tier','tier_expires_at','status','created_at','updated_at'],UPDATE:['display_name','tier','tier_expires_at','updated_at']},user_auth_wallets:{SELECT:['']},auth_wallet_proofs:{SELECT:['']}};
 const query=vi.fn(async(s:string,v:unknown[]=[]):Promise<{rows:any[];command?:string}>=>{
  calls.push(s);
  const dependencyRows=authenticationCatalogRows(s,v);if(dependencyRows)return {rows:dependencyRows};
  if(s.includes('current_database() AS database'))return {rows:[{database:'wave4',address:'172.18.0.2',port:5432,system_identifier:'1234'}]};
  if(s.includes('r.rolsuper,')&&s.includes('AS clean'))return {rows:[{role:'fixture_dba',session:'fixture_dba',role_setting:'none',row_security:'on',rolsuper:true,clean:true}]};
  if(s.includes('AS current_role')) return {rows:[{current_role:'fixture_dba',session_role:'fixture_dba',role_setting:'none',row_security:'on',backend:7,transaction_clean:true,superuser:true}]};
  if(s.startsWith('BEGIN'))return {rows:[],command:'BEGIN'};
  if(s==='COMMIT'||s==='ROLLBACK')return {rows:[],command:s};
  if(s.includes('CREATE ROLE swat_auth_owner'))created=true;
  if(s.includes('CREATE POLICY auth087_owner ON public.auth_wallet_proofs'))phase='disabled';
  if(s.includes('FROM pg_db_role_setting s'))return {rows:phase==='inert'?[]:['swat_auth_service','swat_auth_owner'].map(rolname=>({rolname,setdatabase:0,setconfig:['row_security=on','search_path=pg_catalog']}))};
  if(s.includes('SELECT r.rolname,r.rolcanlogin'))return {rows:[...['swat_auth_service',...(created?['swat_auth_owner']:[])].map(rolname=>({rolname,rolcanlogin:rolname==='swat_auth_service'&&active,unsafe:false,membership:false,owns:false,extra_ownership:false,can_create:false,functions:rolname==='swat_auth_owner'&&phase!=='inert'?[...AUTH_FUNCTION_SIGNATURES].sort():[]}))]};
  if(s.includes('AS signature')&&s.includes("LIKE 'swat_auth_%'"))return {rows:AUTH_FUNCTION_SIGNATURES.map(signature=>({signature}))};
  if(s.includes('p.prosrc')){
   const p=pins.find(m=>`public.${m[1]}(${m[2]?m[2].split(',').map(a=>a.trim().split(/\s+/)[1]).join(','):''})`===v[0])!;
   const internal=['swat_auth_guard','swat_auth_user_json','swat_auth_session_user'].includes(p[1]!);
   const owner=phase==='inert'?'swat_migrator':'swat_auth_owner';
   const grantees=[owner,...(phase!=='inert'&&!internal?['swat_auth_service']:[])].sort();
   const args=p[2]?p[2].split(',').map(a=>a.trim().split(/\s+/)[0]):null;
   const types:Record<string,string>={text:'25',uuid:'2950',bytea:'17',inet:'869','public.users':'9400'};
   const expected_oids=p[2]?p[2].split(',').map(a=>types[a.trim().split(/\s+/)[1]!]!):[];
   return {rows:[{owner,prosrc:p[6],probin:null,prosqlbody:null,prokind:'f',prosecdef:p[5]==='DEFINER',proisstrict:false,proleakproof:false,
    proretset:p[3]!.startsWith('SETOF '),prosupport:0,provariadic:0,procost:100,prorows:p[3]!.startsWith('SETOF ')?1000:0,
    provolatile:'v',proparallel:'u',proconfig:['search_path=pg_catalog'],proargnames:args,proallargtypes:null,proargmodes:null,
    pronargdefaults:0,proargdefaults:null,return_matches:true,pronargs:args?.length??0,argument_oids:expected_oids.join(' '),expected_oids,lanname:p[4],
    acl:grantees.map(grantee=>({grantor:owner,grantee,privilege:'EXECUTE',grantable:false}))}]};
  }
  if(s.includes('COALESCE(col.attname')) {
   const rows:any[]=[];
   const add=(grantee:string,tables:Record<string,Record<string,string[]>>)=>{
    for(const [relname,grants] of Object.entries(tables))for(const [privilege_type,columns] of Object.entries(grants))for(const column_name of columns)
     rows.push({nspname:'public',relname,column_name,grantee,grantor:'swat_migrator',privilege_type,is_grantable:false});
   };
   add('swat_app',appGrants);if(phase!=='inert'){add('swat_auth_owner',tableGrants);rows.push({nspname:'public',relname:'audit_log_id_seq',column_name:'',grantee:'swat_auth_owner',grantor:'swat_migrator',privilege_type:'USAGE',is_grantable:false});}
   return {rows};
  }
  if(s.includes('AS unexpected_trigger'))return {rows:['users','user_sessions','user_auth_wallets','auth_wallet_proofs','audit_log'].map(relname=>{
   const proof=relname==='auth_wallet_proofs',wallet=relname==='user_auth_wallets';
   const tenant=proof?'(user_id=public.current_app_user_id())':wallet?'(public.is_rls_bypassed()OR((user_id=public.current_app_user_id())AND(EXISTS(SELECT1FROMpublic.auth_wallet_proofspWHERE((p.wallet_id=user_auth_wallets.id)AND(p.user_id=user_auth_wallets.user_id)AND(p.chain_kind=(user_auth_wallets.chain_kind)::text)AND(p.address=(user_auth_wallets.address)::text)AND(p.verified_at=user_auth_wallets.verified_at))))))':`(public.is_rls_bypassed()OR(${relname==='users'?'id':'user_id'}=public.current_app_user_id()))`;
   return {relname,owner:'swat_migrator',relkind:'r',relrowsecurity:relname!=='audit_log',relforcerowsecurity:relname!=='audit_log',unexpected_trigger:false,
    policies:relname==='audit_log'?null:[{name:proof?'auth087_proof_tenant':'tenant_isolation_policy',cmd:proof?'r':'*',permissive:true,roles:proof?['swat_app']:['swat_app','swat_migrator'],using:tenant,check:proof?null:wallet?'public.is_rls_bypassed()':tenant},
    ...(phase!=='inert'?[{name:'auth087_owner',cmd:'*',permissive:true,roles:['swat_auth_owner'],using:"(CURRENT_USER='swat_auth_owner'::name)",check:"(CURRENT_USER='swat_auth_owner'::name)"}]:[])].sort((a,b)=>a.name.localeCompare(b.name))};
  })};
  if(s.includes('AS sequence_name'))return {rows:[{owner:'swat_migrator',relkind:'S',sequence_name:'public.audit_log_id_seq'}]};
  return {rows:[]};
 });
 const client={query} as unknown as AuthQueryClient;
 return {calls,query,release,input:{acquire:async()=>({client,release}),dbaRole:'fixture_dba',installedSql:sql},client,activate:()=>{active=true;}};
}
it('actual provisioner performs full atomic exact owner handoff then separately validates committed catalog',async()=>{
 const f=fixture();await provisionCommittedAuthentication(f.input);
 expect(f.calls.filter(s=>s.startsWith('ALTER FUNCTION'))).toHaveLength(17);
 expect(f.calls.filter(s=>s.startsWith('GRANT EXECUTE ON FUNCTION public.swat_auth_'))).toHaveLength(14);
 expect(f.calls).toContain('GRANT EXECUTE ON FUNCTION public.citext_cmp(public.citext,public.citext),public.citext_eq(public.citext,public.citext) TO swat_auth_owner');
 expect(f.calls.indexOf('REVOKE CREATE ON SCHEMA public FROM swat_auth_owner')).toBeLessThan(f.calls.indexOf('COMMIT'));
 expect(f.calls).not.toContain('SET ROLE swat_auth_owner');expect(f.release).toHaveBeenCalledWith(false);
 await validateAuthenticationInstallation({...f.input,phase:'disabled'});
 expect(f.calls).toContain('BEGIN READ ONLY');
});
it.each(['body','owner','acl','options'])('refuses exact installed function %s drift before privilege transfer',async kind=>{
 const f=fixture(),original=f.query.getMockImplementation()!;
 f.query.mockImplementation(async(s,v)=>{const result=await original(s,v);if(s.includes('p.prosrc')){
  const r=result.rows[0] as any;
  if(kind==='body')r.prosrc+='-- substituted';if(kind==='owner')r.owner='fixture_dba';if(kind==='acl')r.acl.push({grantor:'swat_migrator',grantee:'PUBLIC',privilege:'EXECUTE',grantable:false});if(kind==='options')r.proleakproof=true;
 }return result;});
 await expect(provisionCommittedAuthentication(f.input)).rejects.toThrow('exact signature/body/options/owner/ACL');
 expect(f.calls.some(s=>s.startsWith('ALTER FUNCTION'))).toBe(false);expect(f.calls).toContain('ROLLBACK');expect(f.release).toHaveBeenCalledWith(true);
});
it.each(['helper-body','helper-owner','helper-options','missing-wallet-unique','missing-email-unique','missing-token-unique','changed-column-type','changed-default','changed-index','changed-fk-operator','unexpected-rule','sequence-options','citext-body','citext-type','citext-operator','public-column-only','helper-acl','helper-dependency'])('rejects supported hostile closure %s before ownership transfer',async hostile=>{
 const f=fixture(),original=f.query.getMockImplementation()!;
 f.query.mockImplementation(async(s,v)=>{
  const result=await original(s,v);
  if(s.includes('AS identity_matches')){
   if(hostile==='helper-body'&&String(v?.[0]).includes('is_rls_bypassed'))result.rows[0].prosrc=' SELECT true; ';
   if(hostile==='helper-owner')result.rows[0].owner='fixture_dba';
   if(hostile==='helper-options')result.rows[0].prosecdef=true;
   if(hostile==='helper-acl')result.rows[0].acl.push({grantee:'PUBLIC',grantor:'swat_migrator',privilege:'EXECUTE',grantable:false});
   if(hostile==='helper-dependency')result.rows[0].extra_dependency=true;
  }
  if(s.includes('conbin::text AS check_tree')){
   const missing=hostile==='missing-wallet-unique'?'uq_auth_wallet':hostile==='missing-email-unique'?'users_email_key':hostile==='missing-token-unique'?'user_sessions_token_hash_key':null;
   if(missing)result.rows=result.rows.filter(r=>r.conname!==missing);
  }
  if(hostile==='changed-column-type'&&s.includes('AS default_tree')&&v?.[0]==='public.users')result.rows[1].type='pg_catalog.text';
  if(hostile==='changed-index'&&s.includes('AS opclasses'))result.rows[0].indisunique=false;
  if(hostile==='changed-fk-operator'&&s.includes('conbin::text AS check_tree'))result.rows[0].fk_equalities=false;
  if(hostile==='sequence-options'&&s.includes('s.seqstart::text'))result.rows[0].seqcycle=true;
  if(hostile==='citext-body'&&s.includes('p.prosrc=$2'))result.rows[0].exact=false;
  if(hostile==='citext-type'&&s.includes("t.typtype='b'"))result.rows[0].exact=false;
  if(hostile==='citext-operator'&&s.includes('AS operator_count'))result.rows[0].operators[2][2]='forged_equal';
  if(hostile==='changed-default'&&s.includes('AS default_tree')&&v?.[0]==='public.users')result.rows[0].default_tree='{FUNCEXPR :funcid 666 :funcretset false :args <>}';
  if(hostile==='unexpected-rule'&&s.includes("'rule' AS hazard"))result.rows=[{hazard:'rule'}];
  if(hostile==='public-column-only'&&s.includes('a.grantee=0')&&s.includes('at.attacl'))result.rows=[{oid:666}];
  return result;
 });
 await expect(provisionCommittedAuthentication(f.input)).rejects.toThrow(/Auth /);
 expect(f.calls.some(s=>s.startsWith('ALTER FUNCTION'))).toBe(false);expect(f.release).toHaveBeenCalledWith(true);
});

it.each(['missing','disabled','replica-only','substituted-routine','substituted-builtin','association','event','deferrable','deferred','options','dependency','extra'])('rejects hostile FK enforcement %s before handoff and in every committed phase',async hostile=>{
 const poison=(f:ReturnType<typeof fixture>)=>{
  const original=f.query.getMockImplementation()!;
  f.query.mockImplementation(async(s,v)=>{
   const result=await original(s,v);
   if(s.includes('AS dependencies_exact')&&v?.[1]==='auth_wallet_proofs_wallet_id_fkey'){
    const r=result.rows.find(r=>r.routine==='RI_FKey_cascade_del')!;
    if(hostile==='missing')result.rows=result.rows.filter(row=>row!==r);
    if(hostile==='disabled')r.tgenabled='D';if(hostile==='replica-only')r.tgenabled='R';
    if(hostile==='substituted-routine')r.routine='RI_FKey_noaction_del';
    if(hostile==='substituted-builtin')r.builtin_exact=false;
    if(hostile==='association')r.target='public.users';if(hostile==='event')r.tgtype=17;
    if(hostile==='deferrable')r.tgdeferrable=true;if(hostile==='deferred')r.tginitdeferred=true;
    if(hostile==='options')r.options_exact=false;if(hostile==='dependency')r.dependencies_exact=false;
    if(hostile==='extra')result.rows.push({...r});
   }
   return result;
  });
 };
 const inert=fixture();poison(inert);
 await expect(provisionCommittedAuthentication(inert.input)).rejects.toThrow('FK enforcement trigger drift');
 expect(inert.calls.some(s=>s.startsWith('ALTER FUNCTION'))).toBe(false);
 expect(inert.calls).not.toContain('COMMIT');expect(inert.release).toHaveBeenCalledWith(true);
 for(const phase of ['inert','disabled','active'] as const){
  const f=fixture();if(phase!=='inert')await provisionCommittedAuthentication(f.input);if(phase==='active')f.activate();
  f.calls.length=0;poison(f);
  await expect(validateAuthenticationInstallation({...f.input,phase})).rejects.toThrow('FK enforcement trigger drift');
  expect(f.calls).not.toContain('COMMIT');expect(f.release).toHaveBeenCalledWith(true);
 }
});

// Independent canonical source anchors for ALL 42 external-child incoming FKs.
// Do not read production inventory to manufacture either the source or protocol baseline.
const incomingSources: readonly (readonly [string,readonly string[]])[] = [
 ['042_user_api_keys.sql',['user_api_keys']],['044_user_wallet_subscriptions.sql',['user_wallet_subscriptions']],
 ['045_user_token_watches.sql',['user_token_watches']],['046_polymarket_redemptions.sql',['polymarket_redemptions']],
 ['047_user_execution_grants.sql',['user_execution_grants']],['048_user_balances.sql',['user_balances']],
 ['049_user_execution_settings.sql',['user_execution_settings','user_chain_execution_settings']],
 ['050_copy_tenancy.sql',['copy_positions','copy_position_applications','copy_executions','trades']],
 ['055_polymarket_position_exits.sql',['polymarket_position_exits']],['058_copy_position_lots.sql',['copy_position_master_lots']],
 ['060_close_all_claims.sql',['copy_position_close_all_claims']],['063_crypto_billing.sql',['crypto_payments','user_payment_intents']],
 ['065_polymarket_perps.sql',['polymarket_perps_accounts','polymarket_perps_positions','polymarket_perps_orders']],
 ['066_lp_dashboard.sql',['lp_guardrail_configs','lp_positions']],['069_lp_copy_trading.sql',['lp_copy_subscriptions','lp_copy_executions']],
 ['071_durable_source_fanout.sql',['source_fanout_deliveries']],
 ['074_canonical_worker_foundation.sql',['copy_execution_policy_snapshots','copy_execution_worker_attempts']],
 ['075_durable_jito_receipts.sql',['jito_execution_pending','jito_execution_receipts']],['076_lp_valued_paper_lifecycle.sql',['lp_paper_operations']],
 ['080_immutable_valuation_corrections.sql',['worker_valuation_authorities','trusted_worker_valuations','copy_execution_valuation_corrections','copy_execution_financial_receipts']],
 ['081_custody_grants_delegation.sql',['custody_secret_admissions']],
 ['082_withdrawal_reducing_intent.sql',['withdrawal_reducing_intents','reducing_perps_venue_mappings']],
 ['083_lp_exact_paper_operations.sql',['lp_exact_positions','lp_exact_operations','lp_exact_receipts']],
 ['085_lp_protected_paper_admission.sql',['lp_protected_quote_admissions','lp_protected_settlement_admissions']]
];
it('preserves the independently transcribed complete canonical incoming FK baseline and four paths',async()=>{
 const f=fixture(),incomingSeen=new Set<string>(),sourceActions:Record<string,string>={};
 const external=incomingSources.flatMap(([,tables])=>[...tables]);
 expect(external).toHaveLength(42);expect(new Set(external).size).toBe(42);
 for(const [file,tables] of incomingSources){
  const migration=readFileSync(new URL(`../../packages/db/sql/${file}`,import.meta.url),'utf8').replace(/--[^\n]*/g,'');
  for(const table of tables){
   const statement=new RegExp(`(?:CREATE TABLE (?:IF NOT EXISTS )?(?:public\\.)?${table} \\(|ALTER TABLE ${table}\\s+ADD COLUMN IF NOT EXISTS user_id)[\\s\\S]*?;`).exec(migration)?.[0];
   expect(statement,`${file} ${table}`).toMatch(/(?:user_id\s+UUID(?:\s+NOT NULL|\s+PRIMARY KEY)?\s+REFERENCES|FOREIGN KEY\(user_id\) REFERENCES)\s+(?:public\.)?users\(id\)\s+ON DELETE (?:CASCADE|RESTRICT)/i);
   const action=/(?:user_id\s+UUID(?:\s+NOT NULL|\s+PRIMARY KEY)?\s+REFERENCES|FOREIGN KEY\(user_id\) REFERENCES)\s+(?:public\.)?users\(id\)\s+ON DELETE (CASCADE|RESTRICT)/i.exec(statement!)![1]!;
   sourceActions[table]=action.toUpperCase()==='CASCADE'?'c':'r';
  }
 }
 const original=f.query.getMockImplementation()!;
 f.query.mockImplementation(async(s,v)=>{
  const result=await original(s,v);
  if(s.includes('AS constraint_dependencies_exact')){
   expect(result.rows).toHaveLength(47); // 42 external + 040/041 and three 087 proof FKs
   expect(result.rows.filter(r=>r.target==='public.users')).toHaveLength(45);
   expect(result.rows.filter(r=>r.target==='public.audit_log').map(r=>r.conname)).toEqual(['auth_wallet_proofs_audit_id_fkey']);
   expect(result.rows.filter(r=>r.target==='public.user_auth_wallets').map(r=>r.conname)).toEqual(['auth_wallet_proofs_wallet_id_fkey']);
   expect(result.rows.some(r=>r.target==='public.user_sessions'||r.target==='public.auth_wallet_proofs')).toBe(false);
   expect(result.rows.filter(r=>external.includes(r.relation.replace('public.',''))).map(r=>r.relation.replace('public.','')).sort()).toEqual([...external].sort());
   for(const r of result.rows.filter(r=>external.includes(r.relation.replace('public.','')))){
    const table=r.relation.replace('public.','');expect(r.conname).toBe(`${table}_user_id_fkey`);
    expect(r.columns).toEqual(['user_id']);expect(r.target_columns).toEqual(['id']);expect(r.confdeltype).toBe(sourceActions[table]);
   }
  }
  if(s.includes('AS dependencies_exact')&&external.includes(String(v?.[0]).replace('public.',''))){
   incomingSeen.add(String(v?.[1]));expect(result.rows).toHaveLength(4);
   expect(result.rows.map(r=>r.routine).slice(0,2)).toEqual(['RI_FKey_check_ins','RI_FKey_check_upd']);
   expect(['RI_FKey_cascade_del','RI_FKey_restrict_del']).toContain(result.rows[2].routine);
   expect(result.rows[3].routine).toBe('RI_FKey_noaction_upd');
  }
  return result;
 });
 await provisionCommittedAuthentication(f.input);
 for(const phase of ['inert','disabled','active'] as const){
  const committed=phase==='inert'?fixture():f;if(phase==='active')committed.activate();
  await validateAuthenticationInstallation({...committed.input,phase});
 }
 expect([...incomingSeen].sort()).toEqual(external.map(t=>`${t}_user_id_fkey`).sort());
 expect(f.release).toHaveBeenCalledWith(false);
});

async function refuseTouchingClosure(poison:(f:ReturnType<typeof fixture>)=>void,error:RegExp):Promise<void>{
 const before=fixture();poison(before);
 await expect(provisionCommittedAuthentication(before.input)).rejects.toThrow(error);
 expect(before.calls.some(s=>s.startsWith('ALTER FUNCTION')||s.startsWith('GRANT ')||s.startsWith('ALTER ROLE'))).toBe(false);
 expect(before.calls).not.toContain('COMMIT');expect(before.calls).toContain('ROLLBACK');expect(before.release).toHaveBeenCalledWith(true);
 for(const phase of ['inert','disabled','active'] as const){
  const f=fixture();if(phase!=='inert')await provisionCommittedAuthentication(f.input);if(phase==='active')f.activate();
  f.calls.length=0;f.release.mockClear();poison(f);
  await expect(validateAuthenticationInstallation({...f.input,phase})).rejects.toThrow(error);
  expect(f.calls).not.toContain('COMMIT');expect(f.calls).toContain('ROLLBACK');expect(f.release).toHaveBeenCalledWith(true);
 }
}

it.each(['wallet-restrict','users-cascade','audit-noaction','session-restrict','proof-restrict','same-size-substitution','duplicate-expected'])('refuses unreviewed external incoming FK %s without PUBLIC/auth grants in all phases and pre-handoff',async hostile=>{
 await refuseTouchingClosure(f=>{
  const original=f.query.getMockImplementation()!;
  f.query.mockImplementation(async(s,v)=>{
   const result=await original(s,v);
   // Existing ACL/policy rows remain unchanged. Only the external FK/trigger
   // catalog is hostile: the wallet-restrict case models a row blocking unlink.
   if(s.includes('AS constraint_dependencies_exact')){
    const prototype=result.rows.find(r=>r.conname==='user_api_keys_user_id_fkey')!;
    const target=hostile==='users-cascade'?'public.users':hostile==='audit-noaction'?'public.audit_log':hostile==='session-restrict'?'public.user_sessions':hostile==='proof-restrict'?'public.auth_wallet_proofs':'public.user_auth_wallets';
    const extra={...prototype,oid:9999,relation:'private.unlink_blocker',conname:'unlink_blocker_wallet_id_fkey',columns:['wallet_id'],target,
     target_columns:[target==='public.auth_wallet_proofs'?'wallet_id':'id'],confdeltype:hostile==='users-cascade'?'c':hostile==='audit-noaction'?'a':'r'};
    if(hostile==='wallet-restrict'){
     expect(extra.relation).toBe('private.unlink_blocker');expect(extra.target).toBe('public.user_auth_wallets');expect(extra.confdeltype).toBe('r');
     expect(sql).toContain('DELETE FROM public.user_auth_wallets WHERE user_id=uid AND chain_kind=chain AND address=addr;');
    }
    if(hostile==='same-size-substitution')result.rows=result.rows.filter(r=>r!==prototype);
    result.rows.push(hostile==='duplicate-expected'?{...prototype,oid:9999}:extra);
   }
   return result;
  });
 },/touching FK (?:inventory|constraint) drift/);
});

it.each(['missing','renamed','child','target','columns','target-columns','delete','update','match','deferrable','deferred','unvalidated','nonlocal','inherited','inheritable','column-type','operator','metadata','dependency','oid'])('refuses altered expected external incoming FK metadata %s in all phases and pre-handoff',async hostile=>{
 await refuseTouchingClosure(f=>{
  const original=f.query.getMockImplementation()!;
  f.query.mockImplementation(async(s,v)=>{
   const result=await original(s,v);
   if(s.includes('AS constraint_dependencies_exact')){
    const r=result.rows.find(r=>r.conname==='copy_positions_user_id_fkey')!;
    if(hostile==='missing')result.rows=result.rows.filter(row=>row!==r);
    if(hostile==='renamed')r.conname='copy_positions_user_id_fkey_substitute';if(hostile==='child')r.relation='private.copy_positions';
    if(hostile==='target')r.target='public.user_auth_wallets';if(hostile==='columns')r.columns=['id'];if(hostile==='target-columns')r.target_columns=['email'];
    if(hostile==='delete')r.confdeltype='c';if(hostile==='update')r.confupdtype='c';if(hostile==='match')r.confmatchtype='f';
    if(hostile==='deferrable')r.condeferrable=true;if(hostile==='deferred')r.condeferred=true;if(hostile==='unvalidated')r.convalidated=false;
    if(hostile==='nonlocal')r.conislocal=false;if(hostile==='inherited')r.coninhcount=1;if(hostile==='inheritable')r.connoinherit=false;
    if(hostile==='column-type')r.fk_columns_exact=false;if(hostile==='operator')r.fk_equalities=false;
    if(hostile==='metadata')r.metadata_exact=false;if(hostile==='dependency')r.constraint_dependencies_exact=false;if(hostile==='oid')r.oid=0;
   }
   return result;
  });
 },/touching FK (?:inventory|constraint) drift/);
});

const externalTriggerPaths=[
 ['user_api_keys','RI_FKey_check_ins'],['user_api_keys','RI_FKey_check_upd'],['user_api_keys','RI_FKey_cascade_del'],['user_api_keys','RI_FKey_noaction_upd'],
 ['copy_positions','RI_FKey_check_ins'],['copy_positions','RI_FKey_check_upd'],['copy_positions','RI_FKey_restrict_del'],['copy_positions','RI_FKey_noaction_upd'],
 ['lp_protected_settlement_admissions','RI_FKey_restrict_del']
] as const;
it.each(externalTriggerPaths.flatMap(([table,path])=>['missing','disabled','replica-only','always','substituted-routine','substituted-builtin','relation','association','event','internal','deferrable','deferred','options','dependency','extra'].map(hostile=>({table,path,hostile}))))('refuses external incoming enforcement $table $path $hostile in every phase and pre-handoff',async({table,path,hostile})=>{
 await refuseTouchingClosure(f=>{
  const original=f.query.getMockImplementation()!;
  f.query.mockImplementation(async(s,v)=>{
   const result=await original(s,v);
   if(s.includes('AS dependencies_exact')&&v?.[1]===`${table}_user_id_fkey`){
    const r=result.rows.find(r=>r.routine===path)!;
    if(hostile==='missing')result.rows=result.rows.filter(row=>row!==r);
    if(hostile==='disabled')r.tgenabled='D';if(hostile==='replica-only')r.tgenabled='R';if(hostile==='always')r.tgenabled='A';
    if(hostile==='substituted-routine')r.routine=path==='RI_FKey_restrict_del'?'RI_FKey_noaction_del':'RI_FKey_restrict_del';
    if(hostile==='substituted-builtin')r.builtin_exact=false;if(hostile==='relation')r.relation='private.unlink_blocker';
    if(hostile==='association')r.target='public.user_auth_wallets';if(hostile==='event')r.tgtype=31;if(hostile==='internal')r.tgisinternal=false;
    if(hostile==='deferrable')r.tgdeferrable=true;if(hostile==='deferred')r.tginitdeferred=true;
    if(hostile==='options')r.options_exact=false;if(hostile==='dependency')r.dependencies_exact=false;if(hostile==='extra')result.rows.push({...r});
   }
   return result;
  });
 },/FK enforcement trigger drift/);
});

it.each(['protected-orphan','external-child-spoof','unreviewed-constraint','noninternal'])('refuses additional touching trigger %s even with all expected constraints and paths intact',async hostile=>{
 await refuseTouchingClosure(f=>{
  const original=f.query.getMockImplementation()!;
  f.query.mockImplementation(async(s,v)=>{
   const result=await original(s,v);
   if(s.includes('AS unexpected_auth_fk_trigger')){
    expect(s).toContain('t.tgconstrrelid=ANY($1::regclass[])');expect(s).toContain('t.tgconstraint=ANY($2::oid[])');
    expect(v?.[1]).toHaveLength(47);
    result.rows=[{unexpected_auth_fk_trigger:9999,relation:hostile==='external-child-spoof'?'private.unlink_blocker':'public.user_auth_wallets',
     target:'public.user_auth_wallets',tgisinternal:hostile!=='noninternal',tgconstraint:hostile==='unreviewed-constraint'?9999:0}];
   }
   return result;
  });
 },/unexpected touching FK trigger path/);
});

it('executable committed installation provisions once, then fresh readonly disabled validation; no implicit activation',async()=>{
 const f=fixture();const acquisitions:string[]=[];
 const input={target:{database:'wave4',address:'172.18.0.2',port:5432,systemIdentifier:'1234'},dbaRole:'fixture_dba',acquireDba:async()=>{acquisitions.push('acquire');return {client:f.client,release:f.release};}};
 await installCommittedAuthentication(input,sql);
 expect(acquisitions).toHaveLength(3);expect(f.calls.filter(s=>s==='COMMIT')).toHaveLength(2);
 expect(f.calls.indexOf('BEGIN READ ONLY')).toBeGreaterThan(f.calls.indexOf('COMMIT'));
 expect(f.calls.some(s=>/\bLOGIN\b|PASSWORD NULL/.test(s))).toBe(false);
 const external=vi.fn();await expect(activateInstalledAuthentication(input,sql,{activateExternally:external,expiresAt:new Date(0)})).rejects.toThrow('bounded');expect(external).not.toHaveBeenCalled();
});
it.each(['broker','target','borrowed-transaction'])('staging refuses %s before provision side effects',async hostile=>{
 const f=fixture(),original=f.query.getMockImplementation()!;
 f.query.mockImplementation(async(s,v)=>{const r=await original(s,v);
  if(hostile==='broker'&&s.includes("n.nspname='swat_migration_handoff'"))r.rows=[{oid:999}];
  if(hostile==='target'&&s.includes('current_database() AS database'))r.rows[0].system_identifier='other';
  if(hostile==='borrowed-transaction'&&s.includes('AS clean'))r.rows[0].clean=false;
  return r;
 });
 await expect(installCommittedAuthentication({target:{database:'wave4',address:'172.18.0.2',port:5432,systemIdentifier:'1234'},dbaRole:'fixture_dba',acquireDba:async()=>({client:f.client,release:f.release})},sql)).rejects.toThrow();
 expect(f.calls.some(s=>s.startsWith('ALTER FUNCTION'))).toBe(false);expect(f.release).toHaveBeenCalledWith(true);
});
it('selected 087 refuses absent explicit installation capability before acquisition',()=>{
 expect(()=>authenticationInstallationSource({files:[{file:'087_wave4_protected_authentication.sql',sql,checksum:AUTH_MIGRATION_SHA256}]})).toThrow('capability');
});

it('explicit external activation runs between fresh disabled and active readonly validations on new leases',async()=>{
 const f=fixture();await provisionCommittedAuthentication(f.input);const sequence:string[]=[];
 const input={target:{database:'wave4',address:'172.18.0.2',port:5432,systemIdentifier:'1234'},dbaRole:'fixture_dba',acquireDba:async()=>{sequence.push('acquire');return {client:f.client,release:f.release};}};
 const external=vi.fn(async()=>{sequence.push('external');f.activate();});
 await activateInstalledAuthentication(input,sql,{activateExternally:external,expiresAt:new Date(Date.now()+60_000)});
 expect(sequence).toEqual(['acquire','external','acquire']);expect(external).toHaveBeenCalledTimes(1);
 expect(f.calls.filter(s=>s==='BEGIN READ ONLY')).toHaveLength(2);
 expect(f.calls.some(s=>/^ALTER ROLE\b[^;]*\b(?:LOGIN|PASSWORD)\b/i.test(s))).toBe(false);
});
it('active phase labels and inert source hashes cannot substitute for callable activation',async()=>{
 const f=fixture();await provisionCommittedAuthentication(f.input);
 const input={target:{database:'wave4',address:'172.18.0.2',port:5432,systemIdentifier:'1234'},dbaRole:'fixture_dba',acquireDba:f.input.acquire};
 await expect(activateInstalledAuthentication(input,sql,{phase:'active',hash:AUTH_MIGRATION_SHA256,expiresAt:new Date(Date.now()+60_000)} as any)).rejects.toThrow('activation');
 const external=vi.fn();await expect(activateInstalledAuthentication(input,sql,{activateExternally:external,expiresAt:new Date(Date.now()+60_000)})).rejects.toThrow('flags');
 expect(external).toHaveBeenCalledTimes(1);expect(f.release).toHaveBeenCalledWith(true);
});
it('COMMIT transport uncertainty never emits ROLLBACK or claims activation',async()=>{
 const f=fixture(),original=f.query.getMockImplementation()!;
 f.query.mockImplementation(async(s,v)=>{if(s==='COMMIT')throw new Error('lost');return original(s,v);});
 await expect(provisionCommittedAuthentication(f.input)).rejects.toThrow('COMMIT uncertain');
 expect(f.calls).not.toContain('ROLLBACK');expect(f.release).toHaveBeenCalledWith(true);
});
