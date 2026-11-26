import {readFileSync} from 'node:fs';
/** Independent protocol rows transcribed from reviewed SQL, not imported expected
 * production inventory. Deliberately not PostgreSQL evidence. */
const root=new URL('../../packages/db/sql/',import.meta.url);
const source=(file:string)=>readFileSync(new URL(file,root),'utf8');
const schemas=[['users','039_users.sql'],['user_sessions','040_user_sessions.sql'],['user_auth_wallets','041_user_auth_wallets.sql'],['audit_log','043_audit_log.sql'],['auth_wallet_proofs','087_wave4_protected_authentication.sql']];
const types:Record<string,[string,number]>={uuid:['pg_catalog.uuid',-1],citext:['public.citext',-1],text:['pg_catalog.text',-1],bytea:['pg_catalog.bytea',-1],timestamptz:['pg_catalog.timestamptz',-1],inet:['pg_catalog.inet',-1],jsonb:['pg_catalog.jsonb',-1],bigint:['pg_catalog.int8',-1],bigserial:['pg_catalog.int8',-1]};
function constant(value:string,type=25){const b=Buffer.concat([Buffer.alloc(4),Buffer.from(value)]);return `{CONST :consttype ${type} :constisnull false :constbyval false :constvalue ${b.length} [ ${[...b].join(' ')} ]}`;}
const variable=(attnum:number)=>`{VAR :varno 1 :varlevelsup 0 :varattno ${attnum}}`;
const fn=(id:number)=>`{FUNCEXPR :funcid ${id} :funcretset false :args <>}`;
const checks:Record<string,[number,string[]]>={chk_users_role:[5,['user','admin']],chk_users_tier:[6,['free','operator','ultra']],chk_users_status:[8,['active','suspended','deleted']],chk_auth_wallet_kind:[3,['evm','solana']],chk_audit_actor:[3,['user','admin','service','anonymous']],auth_wallet_proofs_chain_kind_check:[3,['evm','solana']]};
const constraints:Record<string,unknown[][]>={users:[['users_pkey','p',[1]],['users_email_key','u',[2]],...Object.keys(checks).filter(k=>k.startsWith('chk_users')).map(k=>[k,'c',[checks[k]![0]]])],
 user_sessions:[['user_sessions_pkey','p',[1]],['user_sessions_token_hash_key','u',[3]],['user_sessions_user_id_fkey','f',[2],'public.users',[1],'c']],
 user_auth_wallets:[['user_auth_wallets_pkey','p',[1]],['user_auth_wallets_user_id_fkey','f',[2],'public.users',[1],'c'],['uq_auth_wallet','u',[3,4]],['chk_auth_wallet_kind','c',[3]]],
 audit_log:[['audit_log_pkey','p',[1]],['chk_audit_actor','c',[3]]],auth_wallet_proofs:[['auth_wallet_proofs_pkey','p',[1]],['auth_wallet_proofs_wallet_id_fkey','f',[1],'public.user_auth_wallets',[1],'c'],['auth_wallet_proofs_user_id_fkey','f',[2],'public.users',[1],'a'],['auth_wallet_proofs_audit_id_fkey','f',[6],'public.audit_log',[1],'a'],['auth_wallet_proofs_chain_kind_address_key','u',[3,4]],['auth_wallet_proofs_chain_kind_check','c',[3]]]};
const indexes:Record<string,unknown[][]>={users:[['users_pkey',[1],true,true,[0]],['users_email_key',[2],true,false,[0]],['idx_users_tier_expiry',[7],false,false,[0],7],['idx_users_email_verified',[11],false,false,[0],11]],
 user_sessions:[['user_sessions_pkey',[1],true,true,[0]],['user_sessions_token_hash_key',[3],true,false,[0]],['idx_user_sessions_user',[2],false,false,[0]],['idx_user_sessions_expiry',[5],false,false,[0]]],
 user_auth_wallets:[['user_auth_wallets_pkey',[1],true,true,[0]],['uq_auth_wallet',[3,4],true,false,[0,0]],['idx_user_auth_wallets_user',[2],false,false,[0]]],
 auth_wallet_proofs:[['auth_wallet_proofs_pkey',[1],true,true,[0]],['auth_wallet_proofs_chain_kind_address_key',[3,4],true,false,[0,0]]],
 audit_log:[['audit_log_pkey',[1],true,true,[0]],['idx_audit_log_occurred',[2],false,false,[3]],['idx_audit_log_actor',[4,2],false,false,[0,3]],['idx_audit_log_event',[5,2],false,false,[0,3]]]};
function columns(table:string){
 const filename=schemas.find(s=>s[0]===table)![1]!;
 const sql=source(filename).replace(/--[^\n]*/g,'');
 const match=new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?(?:public\\.)?${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql)!;
 const body=match[1]!;
 const parsed=[...body.matchAll(/(?:^|,|\n)\s*([a-z_]+)\s+(UUID|CITEXT|TEXT|BYTEA|TIMESTAMPTZ|INET|JSONB|BIGSERIAL|uuid|text|timestamptz|bigint|VARCHAR\(\d+\))\s*([^,\n]*)/g)].map(m=>({name:m[1]!,kind:m[2]!.toLowerCase(),options:m[3]!}));
 if(table==='users')parsed.push({name:'email_verified_at',kind:'timestamptz',options:''},{name:'email_verification_token',kind:'varchar(128)',options:''},{name:'email_verification_sent_at',kind:'timestamptz',options:''});
 return parsed.map((c,i)=>{
  const varchar=/varchar\((\d+)\)/.exec(c.kind),[type,atttypmod]=varchar?['pg_catalog.varchar',Number(varchar[1])+4]:types[c.kind]!;
  let default_tree:string|null=null;
  if(c.name==='id'&&table!=='audit_log')default_tree=fn(9001);
  else if(c.kind==='bigserial'){const b=Buffer.alloc(4);b.writeUInt32LE(9004);default_tree=`{FUNCEXPR :funcid 9003 :args ({CONST :consttype 2205 :constvalue 4 [ ${[...b].join(' ')} ]})}`;}
  else if(/DEFAULT NOW\(\)/i.test(c.options))default_tree=fn(9002);
  else if(/DEFAULT '\{\}'/.test(c.options))default_tree='{CONST :consttype 3802 :constisnull false :constbyval false :constvalue 8 [ 0 0 0 0 0 0 0 32 ]}';
  else {const literal=/DEFAULT '([^']*)'/.exec(c.options);if(literal)default_tree=constant(literal[1]!,varchar?1043:25);}
  return {attname:c.name,type,atttypmod,attnotnull:/NOT NULL|PRIMARY KEY/i.test(c.options)||c.kind==='bigserial',attnum:i+1,attisdropped:false,attidentity:'',attgenerated:'',attinhcount:0,native_collation:true,default_tree};
 });
}
// Separately transcribed canonical incoming rows; never import production pins.
// 050's new user_id FKs survive its unrelated PK/UNIQUE/application-FK rewrites.
const incoming: readonly (readonly [string,'c'|'r'])[] = [
 ['user_api_keys','c'],['user_wallet_subscriptions','c'],['user_token_watches','c'],['polymarket_redemptions','c'],
 ['user_execution_grants','r'],['user_balances','c'],['user_execution_settings','c'],['user_chain_execution_settings','c'],
 ['copy_positions','r'],['copy_position_applications','r'],['copy_executions','r'],['trades','r'],
 ['polymarket_position_exits','c'],['copy_position_master_lots','r'],['copy_position_close_all_claims','r'],
 ['crypto_payments','r'],['user_payment_intents','c'],
 ['polymarket_perps_accounts','c'],['polymarket_perps_positions','c'],['polymarket_perps_orders','c'],
 ['lp_guardrail_configs','c'],['lp_positions','r'],['lp_copy_subscriptions','r'],['lp_copy_executions','r'],
 ['source_fanout_deliveries','r'],['copy_execution_policy_snapshots','r'],['copy_execution_worker_attempts','r'],
 ['jito_execution_pending','r'],['jito_execution_receipts','r'],['lp_paper_operations','r'],
 ['worker_valuation_authorities','r'],['trusted_worker_valuations','r'],['copy_execution_valuation_corrections','r'],
 ['copy_execution_financial_receipts','r'],['custody_secret_admissions','r'],
 ['withdrawal_reducing_intents','r'],['reducing_perps_venue_mappings','r'],
 ['lp_exact_positions','r'],['lp_exact_operations','r'],['lp_exact_receipts','r'],
 ['lp_protected_quote_admissions','r'],['lp_protected_settlement_admissions','r'],
 ['pipeline_exact_follower_evidence','r'],['pipeline_paper_valuation_evidence','r'],['pipeline_worker_paper_receipts','r'],
 ['wave4_authorities089','r']
];
const fkRows=()=>[
 ...Object.entries(constraints).flatMap(([table,entries])=>entries.filter(e=>e[1]==='f').map(e=>({
  relation:`public.${table}`,conname:String(e[0]),columns:(e[2] as number[]).map(k=>columns(table)[k-1]!.attname),
  target:String(e[3]),target_columns:(e[4] as number[]).map(k=>columns(String(e[3]).replace('public.',''))[k-1]!.attname),confdeltype:String(e[5])
 }))),
 ...incoming.map(([table,confdeltype])=>({relation:`public.${table}`,conname:`${table}_user_id_fkey`,columns:['user_id'],target:'public.users',target_columns:['id'],confdeltype})),
 {relation:'wave4_load.fixtures',conname:'fixtures_user_id_fkey',columns:['user_id'],target:'public.users',target_columns:['id'],confdeltype:'r'},
 {relation:'wave4_load.requests',conname:'requests_principal_user_id_fkey',columns:['principal_user_id'],target:'public.users',target_columns:['id'],confdeltype:'r'},
 {relation:'wave4_load.requests',conname:'requests_session_id_fkey',columns:['session_id'],target:'public.user_sessions',target_columns:['id'],confdeltype:'r'}
].map((e,i)=>({...e,oid:9500+i,contype:'f',confupdtype:'a',confmatchtype:'s',condeferrable:false,condeferred:false,
 convalidated:true,conislocal:true,coninhcount:0,connoinherit:true,fk_columns_exact:true,fk_equalities:true,metadata_exact:true,constraint_dependencies_exact:true}));
export function authenticationCatalogRows(sql:string,values:unknown[]=[]):any[]|undefined {
 const table=String(values[0]??'').replace('public.','');
 if(sql.includes('AS uuid')&&sql.includes('AS text_equal'))return [{uuid:9001,now:9002,nextval:9003,sequence:9004,text_equal:9005}];
 if(sql.includes('p.prosrc=$2'))return [{oid:9200,exact:true}];
 if(sql.includes("t.typtype='b'"))return [{exact:true}];
 if(sql.includes('AS operator_count'))return [{operators:[[1,'<','citext_lt'],[2,'<=','citext_le'],[3,'=','citext_eq'],[4,'>=','citext_ge'],[5,'>','citext_gt']],operator_count:'5',support_count:'1',support_exact:true}];
 if(sql.includes('SELECT p.oid FROM pg_proc p JOIN pg_namespace'))return [];
 if(sql.includes('AS default_tree'))return columns(table);
 if(sql.includes('conbin::text AS check_tree'))return constraints[table]!.map(e=>{
  const check=checks[String(e[0])];return {conname:e[0],contype:e[1],conkey:e[2],target:e[3],confkey:e[4],confdeltype:e[5],confupdtype:'a',confmatchtype:'s',condeferrable:false,condeferred:false,convalidated:true,conislocal:true,coninhcount:0,connoinherit:false,fk_equalities:true,backing_index:true,
   check_tree:check?`{SCALARARRAYOPEXPR :opno 9005 :useOr true :args (${variable(check[0])} {ARRAYEXPR :array_typeid 1009 :multidims false :elements (${check[1].map(v=>constant(v)).join(' ')})})}`:null};
 });
 if(sql.includes('AS constraint_dependencies_exact'))return fkRows();
 if(sql.includes('AS unexpected_auth_fk_trigger'))return [];
 if(sql.includes('AS dependencies_exact')&&sql.includes('FROM pg_constraint c JOIN pg_trigger')){
  const e=fkRows().find(e=>e.relation===values[0]&&e.conname===values[1]&&e.oid===values[2])!;
  return [[e.relation,e.target,'RI_FKey_check_ins',5],[e.relation,e.target,'RI_FKey_check_upd',17],
   [e.target,e.relation,e.confdeltype==='c'?'RI_FKey_cascade_del':e.confdeltype==='r'?'RI_FKey_restrict_del':'RI_FKey_noaction_del',9],
   [e.target,e.relation,'RI_FKey_noaction_upd',17]].map(([relation,target,routine,tgtype])=>({relation,target,routine,tgtype,
    tgenabled:'O',tgisinternal:true,tgdeferrable:false,tginitdeferred:false,options_exact:true,builtin_exact:true,dependencies_exact:true}));
 }
 if(sql.includes('AS opclasses'))return indexes[table]!.map(e=>{
  const keys=e[1] as number[],cols=columns(table),ops:Record<string,string>={'uuid':'uuid_ops','citext':'citext_ops','bytea':'bytea_ops','timestamptz':'timestamptz_ops','varchar':'text_ops','text':'text_ops','int8':'int8_ops'};
  return {relname:e[0],owner:'swat_migrator',amname:'btree',keys,options:e[4],indisunique:e[2],indisprimary:e[3],indisvalid:true,indisready:true,indislive:true,indisexclusion:false,indimmediate:true,indnullsnotdistinct:false,storage_exact:true,indnkeyatts:keys.length,indnatts:keys.length,expressions:null,
   predicate:e[5]?`{NULLTEST :nulltesttype 1 :argisrow false :arg ${variable(Number(e[5]))}}`:null,
   opclasses:keys.map(k=>{const t=cols[k-1]!.type;return `${t.startsWith('public.')?'public':'pg_catalog'}.${ops[t.split('.')[1]!]}`;}),native_collations:keys.map(()=>true)};
 });
 if(sql.includes("'rule' AS hazard"))return [];
 if(sql.includes('s.seqstart::text'))return [{type_matches:true,seqstart:'1',seqincrement:'1',seqmin:'1',seqmax:'9223372036854775807',seqcache:'1',seqcycle:false,dependencies:['a:public.audit_log:id']}];
 if(sql.includes('AS identity_matches')){
  const bypass=String(values[0]).includes('is_rls_bypassed');
  const baseline=source(bypass?'070_runtime_role_boundary.sql':'064_row_level_security.sql');
  const body=bypass?/search_path = pg_catalog AS \$\$([\s\S]*?)\$\$;/.exec(baseline)![1]:/current_app_user_id\(\) RETURNS uuid STABLE AS \$\$([\s\S]*?)\$\$ LANGUAGE plpgsql;/.exec(baseline)![1];
  const grantees=['swat_app','swat_financial_receipt_writer','swat_financial_settler',...(!bypass?['swat_custody_observer','swat_custody_reader','swat_lp_admitter','swat_lp_initializer','swat_wave4_authority_writer','swat_wave4_financial_writer']:[]),'swat_migrator'];
  return [{oid:bypass?9101:9102,identity_matches:true,owner:'swat_migrator',lanname:bypass?'sql':'plpgsql',prosrc:body,probin:null,prosqlbody:null,proconfig:bypass?['search_path=pg_catalog']:null,prokind:'f',prosecdef:false,proisstrict:false,proleakproof:false,proretset:false,prosupport:0,provariadic:0,procost:100,prorows:0,provolatile:'s',proparallel:'u',pronargs:0,proargnames:null,proallargtypes:null,proargmodes:null,pronargdefaults:0,proargdefaults:null,type_matches:true,extra_dependency:false,acl:grantees.map(grantee=>({grantee,grantor:'swat_migrator',privilege:'EXECUTE',grantable:false}))}];
 }
 if(sql.includes('Auth unreviewed policy')||sql.includes('JOIN pg_policy p ON'))return [];
 return undefined;
}
