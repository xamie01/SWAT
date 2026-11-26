import type { AuthQueryClient } from '../../packages/db/src/auth-owned.js';

/** Independent typed inventory transcribed from reviewed 039/040/041/043/052/064/070/087.
 * No candidate-derived expected rows and no pg_get_expr spelling certificate. PostgreSQL
 * node trees are reduced to a deliberately tiny admitted expression language; everything
 * else, including executable defaults/checks/index expressions, refuses. PG16 proof pending. */
type Node = { tag: string; [key: string]: unknown };
function tree(text: string): Node {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}()[\]]|[^\s{}()[\]]+/g) ?? [];
  let i = 0;
  function value(): unknown {
    const t = tokens[i++];
    if (t === '{') {
      const n: Node = { tag: tokens[i++]! };
      while (tokens[i] !== '}') {
        const key = tokens[i++];
        if (!key?.startsWith(':') || i >= tokens.length) throw new Error('Auth catalog node format');
        n[key.slice(1)] = value();
      }
      i++; return n;
    }
    if (t === '(' || t === '[') {
      const end = t === '(' ? ')' : ']', a: unknown[] = [];
      while (tokens[i] !== end) { if (i >= tokens.length) throw new Error('Auth catalog node array'); a.push(value()); }
      i++; return a;
    }
    if (t === '<>') return null;
    if (t === 'true' || t === 'false') return t === 'true';
    if (t && /^-?\d+$/.test(t)) {
      // constvalue is represented as byte-count followed by a bracketed byte vector.
      if (tokens[i] === '[') return { bytes: value(), length: Number(t) };
      return Number(t);
    }
    if (t?.startsWith('"')) return JSON.parse(t);
    if (t === undefined) throw new Error('Auth catalog truncated node');
    return t;
  }
  const parsed = value();
  const n=Array.isArray(parsed)&&parsed.length===1?parsed[0]:parsed;
  if (i !== tokens.length || !n || typeof n !== 'object' || !('tag' in n)) throw new Error('Auth catalog expression rejected');
  return n as Node;
}
function bytes(n: Node): Buffer {
  const v = n.constvalue as { bytes?: number[]; length?: number };
  if (!v || !Array.isArray(v.bytes) || (v.bytes.length !== v.length && !(n.constbyval===true && v.bytes.length===8 && [1,2,4,8].includes(v.length!)))) throw new Error('Auth catalog constant storage');
  return Buffer.from(v.bytes.map(b => b & 255));
}
function literal(n: Node): string | string[] {
  if(n.tag==='ARRAYCOERCEEXPR'&&n.resulttype===1009&&n.elemexpr&&typeof n.elemexpr==='object') {
    const e=n.elemexpr as Node;
    if(e.tag!=='RELABELTYPE'||e.resulttype!==25||(e.arg as Node)?.tag!=='CASETESTEXPR')throw new Error('Auth catalog array coercion rejected');
    return literal(n.arg as Node);
  }
  if (n.tag === 'ARRAYEXPR' && [1009,1015].includes(Number(n.array_typeid)) && n.multidims === false && Array.isArray(n.elements)) {
    return (n.elements as Node[]).map(e => { const v=literal(e); if(typeof v!=='string')throw new Error('Auth catalog scalar literal required'); return v; });
  }
  if (n.tag !== 'CONST' || n.constisnull !== false || n.constbyval !== false) throw new Error('Auth catalog literal required');
  const b = bytes(n);
  if (Number(n.consttype) === 25 || Number(n.consttype) === 1043) return b.subarray(4).toString('utf8');
  if (Number(n.consttype) === 3802 && b.length===8 && b.readUInt32LE(4) === 0x20000000) return '{}'; // empty jsonb object header
  if (![1009,1015].includes(Number(n.consttype)) || b.length < 24 || b.readInt32LE(4) !== 1 || b.readInt32LE(8) !== 0
    || ![25,1043].includes(b.readUInt32LE(12)) || b.readInt32LE(20) !== 1) throw new Error('Auth catalog literal array required');
  const count = b.readInt32LE(16), result: string[] = []; let offset = 24;
  if (count < 1 || count > 8) throw new Error('Auth catalog literal array length');
  for (let i=0;i<count;i++) {
    if (offset+4>b.length) throw new Error('Auth catalog literal array bounds');
    const size = b.readUInt32LE(offset) >>> 2;
    if (size<4 || offset+size>b.length) throw new Error('Auth catalog literal array element');
    result.push(b.subarray(offset+4,offset+size).toString('utf8')); offset += (size+3)&~3;
  }
  return result;
}
function variable(n: Node): number {
  if (n.tag === 'RELABELTYPE') return variable(n.arg as Node);
  if (n.tag !== 'VAR' || n.varno !== 1 || n.varlevelsup !== 0 || Number(n.varattno)<=0) throw new Error('Auth catalog simple column required');
  return Number(n.varattno);
}
type Column = [name: string,type: string,typmod: number,notnull: boolean,defaultValue?: string];
type Constraint = [name: string,kind: string,keys: number[],target?: string,targetKeys?: number[],deleteAction?: string,checkValues?: string[]];
type Index = [name: string,keys: number[],unique: boolean,primary: boolean,options: number[],predicateColumn?: number];
const c=(name:string,type:string,notnull=false,defaultValue?:string,size=-1):Column=>[name,type,size,notnull,defaultValue];
const pk=(table:string):Constraint=>[`${table}_pkey`,'p',[1]];
const ix=(name:string,keys:number[],unique=false,primary=false,options=keys.map(()=>0),predicateColumn?:number):Index=>[name,keys,unique,primary,options,predicateColumn];
export const AUTH_RELATION_INVENTORY: Readonly<Record<string,{columns:Column[];constraints:Constraint[];indexes:Index[]}>> = {
 users:{columns:[c('id','pg_catalog.uuid',true,'uuid'),c('email','public.citext',true),c('password_hash','pg_catalog.text',true),c('display_name','pg_catalog.varchar',false,undefined,68),
  c('role','pg_catalog.varchar',true,'user',20),c('tier','pg_catalog.varchar',true,'free',20),c('tier_expires_at','pg_catalog.timestamptz'),c('status','pg_catalog.varchar',true,'active',20),
  c('created_at','pg_catalog.timestamptz',true,'now'),c('updated_at','pg_catalog.timestamptz',true,'now'),c('email_verified_at','pg_catalog.timestamptz'),c('email_verification_token','pg_catalog.varchar',false,undefined,132),c('email_verification_sent_at','pg_catalog.timestamptz')],
 constraints:[pk('users'),['users_email_key','u',[2]],['chk_users_role','c',[5],undefined,undefined,undefined,['user','admin']],['chk_users_tier','c',[6],undefined,undefined,undefined,['free','operator','ultra']],['chk_users_status','c',[8],undefined,undefined,undefined,['active','suspended','deleted']]],
 indexes:[ix('users_pkey',[1],true,true),ix('users_email_key',[2],true),ix('idx_users_tier_expiry',[7],false,false,[0],7),ix('idx_users_email_verified',[11],false,false,[0],11)]},
 user_sessions:{columns:[c('id','pg_catalog.uuid',true,'uuid'),c('user_id','pg_catalog.uuid',true),c('token_hash','pg_catalog.bytea',true),c('issued_at','pg_catalog.timestamptz',true,'now'),c('expires_at','pg_catalog.timestamptz',true),c('revoked_at','pg_catalog.timestamptz'),c('last_seen_at','pg_catalog.timestamptz',true,'now'),c('ip','pg_catalog.inet'),c('user_agent','pg_catalog.varchar',false,undefined,260)],
 constraints:[pk('user_sessions'),['user_sessions_token_hash_key','u',[3]],['user_sessions_user_id_fkey','f',[2],'public.users',[1],'c']],
 indexes:[ix('user_sessions_pkey',[1],true,true),ix('user_sessions_token_hash_key',[3],true),ix('idx_user_sessions_user',[2]),ix('idx_user_sessions_expiry',[5])]},
 user_auth_wallets:{columns:[c('id','pg_catalog.uuid',true,'uuid'),c('user_id','pg_catalog.uuid',true),c('chain_kind','pg_catalog.varchar',true,undefined,20),c('address','pg_catalog.varchar',true,undefined,104),c('verified_at','pg_catalog.timestamptz',true,'now'),c('created_at','pg_catalog.timestamptz',true,'now')],
 constraints:[pk('user_auth_wallets'),['user_auth_wallets_user_id_fkey','f',[2],'public.users',[1],'c'],['chk_auth_wallet_kind','c',[3],undefined,undefined,undefined,['evm','solana']],['uq_auth_wallet','u',[3,4]]],
 indexes:[ix('user_auth_wallets_pkey',[1],true,true),ix('uq_auth_wallet',[3,4],true),ix('idx_user_auth_wallets_user',[2])]},
 auth_wallet_proofs:{columns:[c('wallet_id','pg_catalog.uuid',true),c('user_id','pg_catalog.uuid',true),c('chain_kind','pg_catalog.text',true),c('address','pg_catalog.text',true),c('verified_at','pg_catalog.timestamptz',true),c('audit_id','pg_catalog.int8',true)],
 constraints:[pk('auth_wallet_proofs'),['auth_wallet_proofs_wallet_id_fkey','f',[1],'public.user_auth_wallets',[1],'c'],['auth_wallet_proofs_user_id_fkey','f',[2],'public.users',[1],'a'],['auth_wallet_proofs_audit_id_fkey','f',[6],'public.audit_log',[1],'a'],['auth_wallet_proofs_chain_kind_address_key','u',[3,4]],['auth_wallet_proofs_chain_kind_check','c',[3],undefined,undefined,undefined,['evm','solana']]],
 indexes:[ix('auth_wallet_proofs_pkey',[1],true,true),ix('auth_wallet_proofs_chain_kind_address_key',[3,4],true)]},
 audit_log:{columns:[c('id','pg_catalog.int8',true,'sequence'),c('occurred_at','pg_catalog.timestamptz',true,'now'),c('actor_type','pg_catalog.varchar',true,undefined,20),c('actor_id','pg_catalog.uuid'),c('event','pg_catalog.varchar',true,undefined,68),c('target_type','pg_catalog.varchar',false,undefined,36),c('target_id','pg_catalog.varchar',false,undefined,132),c('ip','pg_catalog.inet'),c('user_agent','pg_catalog.varchar',false,undefined,260),c('metadata','pg_catalog.jsonb',true,'{}')],
 constraints:[pk('audit_log'),['chk_audit_actor','c',[3],undefined,undefined,undefined,['user','admin','service','anonymous']]],
 indexes:[ix('audit_log_pkey',[1],true,true),ix('idx_audit_log_occurred',[2],false,false,[3]),ix('idx_audit_log_actor',[4,2],false,false,[0,3]),ix('idx_audit_log_event',[5,2],false,false,[0,3])]}
};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Incoming FKs whose child is OUTSIDE AUTH_RELATION_INVENTORY, independently
 * transcribed from canonical SQL001-087 excluding084. Every entry references
 * users(id); omitted MATCH/UPDATE/DEFERRABLE clauses mean SIMPLE/NO ACTION/NOT
 * DEFERRABLE. All names are the untruncated PostgreSQL <table>_user_id_fkey.
 * 050 adds four user_id columns; its shape-selected drops replace only the old
 * copy_positions PK/application FK and execution UNIQUE, not these incoming FKs.
 * 054/056 add unrelated checks/columns; 057/059/068 replace unrelated checks/PKs;
 * no migration removes, renames or moves any incoming FK below. Dynamic DDL in
 * 064/065/070/082/085/086/087 changes RLS/ACLs or non-auth child triggers,
 * not this inventory. No candidate catalog, fixture, pool or runtime SQL source
 * supplies expected dependencies. SQL043 deliberately has no actor_id FK;
 * SQL087's proof FKs are already pinned in AUTH_RELATION_INVENTORY. */
const incomingUserFks: readonly (readonly [table:string,deleteAction:'c'|'r'])[] = [
 ['user_api_keys','c'], // 042
 ['user_wallet_subscriptions','c'], // 044
 ['user_token_watches','c'], // 045
 ['polymarket_redemptions','c'], // 046
 ['user_execution_grants','r'], // 047
 ['user_balances','c'], // 048
 ['user_execution_settings','c'],['user_chain_execution_settings','c'], // 049
 ['copy_positions','r'],['copy_position_applications','r'],['copy_executions','r'],['trades','r'], // 050
 ['polymarket_position_exits','c'], // 055 (057 changes only exit_trigger CHECK)
 ['copy_position_master_lots','r'], // 058
 ['copy_position_close_all_claims','r'], // 060
 ['crypto_payments','r'],['user_payment_intents','c'], // 063
 ['polymarket_perps_accounts','c'],['polymarket_perps_positions','c'],['polymarket_perps_orders','c'], // 065
 ['lp_guardrail_configs','c'],['lp_positions','r'], // 066
 ['lp_copy_subscriptions','r'],['lp_copy_executions','r'], // 069
 ['source_fanout_deliveries','r'], // 071
 ['copy_execution_policy_snapshots','r'],['copy_execution_worker_attempts','r'], // 074
 ['jito_execution_pending','r'],['jito_execution_receipts','r'], // 075
 ['lp_paper_operations','r'], // 076
 ['worker_valuation_authorities','r'],['trusted_worker_valuations','r'],
 ['copy_execution_valuation_corrections','r'],['copy_execution_financial_receipts','r'], // 080
 ['custody_secret_admissions','r'], // 081
 ['withdrawal_reducing_intents','r'],['reducing_perps_venue_mappings','r'], // 082
 ['lp_exact_positions','r'],['lp_exact_operations','r'],['lp_exact_receipts','r'], // 083
 ['lp_protected_quote_admissions','r'],['lp_protected_settlement_admissions','r'], // 085
 ['pipeline_exact_follower_evidence','r'],['pipeline_paper_valuation_evidence','r'],['pipeline_worker_paper_receipts','r'], // 088
 ['wave4_authorities089','r'] // 089
];
type ForeignKeyPin = {relation:string;name:string;columns:string[];target:string;targetColumns:string[];deleteAction:string};
const loadAuthFks: readonly ForeignKeyPin[] = [
 {relation:'wave4_load.fixtures',name:'fixtures_user_id_fkey',columns:['user_id'],target:'public.users',targetColumns:['id'],deleteAction:'r'},
 {relation:'wave4_load.requests',name:'requests_principal_user_id_fkey',columns:['principal_user_id'],target:'public.users',targetColumns:['id'],deleteAction:'r'},
 {relation:'wave4_load.requests',name:'requests_session_id_fkey',columns:['session_id'],target:'public.user_sessions',targetColumns:['id'],deleteAction:'r'}
];
const authForeignKeys: readonly ForeignKeyPin[] = [
 ...Object.entries(AUTH_RELATION_INVENTORY).flatMap(([table,e])=>e.constraints.filter(c=>c[1]==='f').map(c=>({
  relation:`public.${table}`,name:c[0],columns:c[2].map(k=>e.columns[k-1]![0]),target:c[3]!,
  targetColumns:c[4]!.map(k=>AUTH_RELATION_INVENTORY[c[3]!.slice('public.'.length)]!.columns[k-1]![0]),deleteAction:c[5]!
 }))),
 ...incomingUserFks.map(([table,deleteAction])=>({relation:`public.${table}`,name:`${table}_user_id_fkey`,
  columns:['user_id'],target:'public.users',targetColumns:['id'],deleteAction})),
 ...loadAuthFks
];
/** One four-path validator for BOTH auth-child and reviewed external-child FKs.
 * Generated trigger names/OIDs are not portable; only validated constraint OIDs
 * may be used for the final unassociated/extra-trigger scan. */
async function validateAuthForeignKeyClosure(client:AuthQueryClient):Promise<void> {
 const protectedRelations=Object.keys(AUTH_RELATION_INVENTORY).map(t=>`public.${t}`);
 const constraints=(await client.query(`SELECT c.oid,c.conname,c.contype,c.conrelid::regclass::text AS relation,
  c.confrelid::regclass::text AS target,c.confdeltype,c.confupdtype,c.confmatchtype,
  c.condeferrable,c.condeferred,c.convalidated,c.conislocal,c.coninhcount,c.connoinherit,
  ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord)
   JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.ord) AS columns,
  ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ord)
   JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.ord) AS target_columns,
  cardinality(c.conkey)=1 AND cardinality(c.confkey)=1
   AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY[c.conrelid,c.confrelid],ARRAY[c.conkey[1],c.confkey[1]]) k(relid,attnum)
    LEFT JOIN pg_attribute a ON a.attrelid=k.relid AND a.attnum=k.attnum
    WHERE a.attnum IS NULL OR a.attisdropped OR a.atttypmod<>-1
     OR a.atttypid<>CASE WHEN c.confrelid='public.audit_log'::regclass THEN 'pg_catalog.int8'::regtype ELSE 'pg_catalog.uuid'::regtype END) AS fk_columns_exact,
  c.conpfeqop=ARRAY[CASE WHEN c.confrelid='public.audit_log'::regclass
   THEN 'pg_catalog.=(bigint,bigint)'::regoperator::oid ELSE 'pg_catalog.=(uuid,uuid)'::regoperator::oid END]
   AND c.conppeqop=c.conpfeqop AND c.conffeqop=c.conpfeqop AS fk_equalities,
  c.conindid=to_regclass(c.confrelid::regclass::text||'_pkey') AND c.conparentid=0 AND c.contypid=0
   AND c.connamespace=child.relnamespace AND c.confdelsetcols IS NULL AND c.conexclop IS NULL AND c.conbin IS NULL
   AND child.relkind='r' AND child.relpersistence='p' AND NOT child.relispartition
   AND child.relowner=(SELECT oid FROM pg_roles WHERE rolname='swat_migrator')
   AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=child.oid OR inhparent=child.oid) AS metadata_exact,
  EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_constraint'::regclass AND d.objid=c.oid AND d.objsubid=0
   AND d.refclassid='pg_class'::regclass AND d.refobjid=c.conrelid AND d.refobjsubid=c.conkey[1] AND d.deptype='a')
   AND EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_constraint'::regclass AND d.objid=c.oid AND d.objsubid=0
    AND d.refclassid='pg_class'::regclass AND d.refobjid=c.confrelid AND d.refobjsubid=c.confkey[1] AND d.deptype='n')
   AND EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_constraint'::regclass AND d.objid=c.oid AND d.objsubid=0
    AND d.refclassid='pg_class'::regclass AND d.refobjid=c.conindid AND d.refobjsubid=0 AND d.deptype='n')
   AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_constraint'::regclass AND d.objid=c.oid
   AND NOT(d.objsubid=0 AND (
    d.refclassid='pg_class'::regclass AND (d.refobjid=c.conrelid AND d.refobjsubid=ANY(c.conkey) AND d.deptype='a'
     OR d.refobjid=c.confrelid AND d.refobjsubid=ANY(c.confkey) AND d.deptype='n'
     OR d.refobjid=c.conindid AND d.refobjsubid=0 AND d.deptype='n')
    OR d.refclassid='pg_operator'::regclass AND d.refobjid=ANY(c.conpfeqop) AND d.refobjsubid=0 AND d.deptype='n'
   ))) AS constraint_dependencies_exact
  FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid
  WHERE c.contype='f' AND (c.conrelid=ANY($1::regclass[]) OR c.confrelid=ANY($1::regclass[]))`,[protectedRelations])).rows;
 if(constraints.length!==authForeignKeys.length)throw new Error('Auth exact touching FK inventory drift');
 const accepted:number[]=[];
 for(const e of authForeignKeys){
  const matches=constraints.filter(c=>c.relation===e.relation&&c.conname===e.name),a=matches[0];
  if(matches.length!==1||!a||!Number.isInteger(a.oid)||a.oid<=0||accepted.includes(a.oid)||a.contype!=='f'
   ||a.target!==e.target||!same(a.columns,e.columns)||!same(a.target_columns,e.targetColumns)
   ||a.confdeltype!==e.deleteAction||a.confupdtype!=='a'||a.confmatchtype!=='s'
   ||a.condeferrable!==false||a.condeferred!==false||a.convalidated!==true||a.conislocal!==true
   ||a.coninhcount!==0||a.connoinherit!==true||a.fk_columns_exact!==true||a.fk_equalities!==true
   ||a.metadata_exact!==true||a.constraint_dependencies_exact!==true)
   throw new Error(`Auth exact touching FK constraint drift: ${e.name}`);
  const triggers=(await client.query(`SELECT t.tgrelid::regclass::text AS relation,t.tgconstrrelid::regclass::text AS target,
   p.proname AS routine,t.tgtype,t.tgenabled,t.tgisinternal,t.tgdeferrable,t.tginitdeferred,
   t.tgparentid=0 AND t.tgconstrindid=c.conindid AND t.tgnargs=0 AND t.tgargs=''::bytea
    AND t.tgattr::text='' AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AS options_exact,
   p.oid=to_regprocedure('pg_catalog.'||quote_ident(p.proname)||'()')
    AND p.pronamespace='pg_catalog'::regnamespace AND l.lanname='internal' AND p.prosrc=p.proname
    AND p.proowner=(SELECT proowner FROM pg_proc WHERE oid='pg_catalog.uuid_eq(uuid,uuid)'::regprocedure)
    AND p.prokind='f' AND NOT p.prosecdef AND p.proisstrict AND NOT p.proleakproof AND NOT p.proretset
    AND p.prorettype='pg_catalog.trigger'::regtype AND p.pronargs=0 AND p.proargtypes::text=''
    AND p.provariadic=0 AND p.prosupport=0 AND p.procost=1 AND p.prorows=0 AND p.provolatile='v' AND p.proparallel='s'
    AND p.probin IS NULL AND p.prosqlbody IS NULL AND p.proconfig IS NULL
    AND p.proargnames IS NULL AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
    AND p.pronargdefaults=0 AND p.proargdefaults IS NULL AS builtin_exact,
   (SELECT count(*) FROM pg_depend d WHERE d.classid='pg_trigger'::regclass AND d.objid=t.oid AND d.objsubid=0
    AND d.refclassid='pg_constraint'::regclass AND d.refobjid=c.oid AND d.refobjsubid=0 AND d.deptype='i')=1
    AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_trigger'::regclass AND d.objid=t.oid
     AND NOT(d.objsubid=0 AND d.refobjsubid=0 AND (d.refclassid='pg_constraint'::regclass AND d.refobjid=c.oid AND d.deptype='i'
      OR d.refclassid='pg_proc'::regclass AND d.refobjid=t.tgfoid AND d.deptype='n'))) AS dependencies_exact
   FROM pg_constraint c JOIN pg_trigger t ON t.tgconstraint=c.oid
    LEFT JOIN pg_proc p ON p.oid=t.tgfoid LEFT JOIN pg_language l ON l.oid=p.prolang
   WHERE c.conrelid=to_regclass($1) AND c.conname=$2 AND c.oid=$3::oid`,[e.relation,e.name,a.oid])).rows;
  const paths:[string,string,string,number][]=[
   [e.relation,e.target,'RI_FKey_check_ins',5],[e.relation,e.target,'RI_FKey_check_upd',17],
   [e.target,e.relation,e.deleteAction==='c'?'RI_FKey_cascade_del':e.deleteAction==='r'?'RI_FKey_restrict_del':'RI_FKey_noaction_del',9],
   [e.target,e.relation,'RI_FKey_noaction_upd',17]];
  if(triggers.length!==paths.length||paths.some(([relation,target,routine,event])=>triggers.filter(t=>
   t.relation===relation&&t.target===target&&t.routine===routine&&t.tgtype===event&&t.tgenabled==='O'
    &&t.tgisinternal===true&&t.tgdeferrable===false&&t.tginitdeferred===false
    &&t.options_exact===true&&t.builtin_exact===true&&t.dependencies_exact===true).length!==1))
   throw new Error(`Auth exact FK enforcement trigger drift: ${e.name}`);
  accepted.push(a.oid);
 }
 // Covers orphan/spoofed incoming sides too, including triggers attached to a
 // noninventory child that claim a protected constrrelid without a reviewed FK.
 const extra=(await client.query(`SELECT t.oid AS unexpected_auth_fk_trigger FROM pg_trigger t
  WHERE (t.tgrelid=ANY($1::regclass[]) OR t.tgconstrrelid=ANY($1::regclass[]) OR t.tgconstraint=ANY($2::oid[]))
   AND NOT(t.tgisinternal AND t.tgconstraint=ANY($2::oid[]))`,[protectedRelations,accepted])).rows;
 if(extra.length)throw new Error('Auth unexpected touching FK trigger path');
}
/** Pin the complete noncatalog executable path of users.email and its btree unique
 * index, not just symbolic opclass/routine names. Backend builtins are the trusted
 * terminal; external C binaries still require independent PG16 image qualification. */
async function validateCitextClosure(client:AuthQueryClient,phase:'inert'|'disabled'|'active'):Promise<void> {
 const pins=[['citext_cmp','int4'],['citext_lt','bool'],['citext_le','bool'],['citext_eq','bool'],['citext_ge','bool'],['citext_gt','bool']];
 for(const [name,result] of pins){
  const rows=(await client.query(`SELECT p.oid, p.prosrc=$2 AND p.probin='$libdir/citext'
   AND p.proowner=(SELECT proowner FROM pg_proc WHERE oid='pg_catalog.uuid_eq(uuid,uuid)'::regprocedure)
   AND p.prokind='f' AND NOT p.prosecdef AND p.proisstrict AND NOT p.proleakproof AND NOT p.proretset
   AND p.prosupport=0 AND p.provariadic=0 AND p.procost=1 AND p.prorows=0 AND p.provolatile='i' AND p.proparallel='s'
   AND p.pronargs=2 AND p.proargtypes::text=(SELECT t.oid::text||' '||t.oid::text FROM pg_type t WHERE t.oid='public.citext'::regtype)
   AND p.proargnames IS NULL AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.pronargdefaults=0 AND p.proargdefaults IS NULL
   AND p.proconfig IS NULL AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='c') AND p.prorettype=to_regtype($3)
   AND EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid
    AND d.refclassid='pg_extension'::regclass AND d.deptype='e' AND e.extname='citext' AND e.extversion='1.6' AND e.extnamespace=p.pronamespace)
   AND (SELECT count(*) FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))))=1+CASE WHEN $4::boolean THEN 1 ELSE 0 END
   AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR a.grantor<>p.proowner
     OR a.grantee<>p.proowner AND NOT($4::boolean AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='swat_auth_owner'))) AS exact
   FROM pg_proc p WHERE p.oid=to_regprocedure($1)`,[`public.${name}(public.citext,public.citext)`,name,`pg_catalog.${result}`,phase!=='inert'&&['citext_cmp','citext_eq'].includes(name!)])).rows;
  if(rows.length!==1||rows[0]?.exact!==true)throw new Error(`Auth reviewed citext routine closure drift: ${name}`);
 }
 const type=(await client.query(`SELECT t.typtype='b' AND t.typlen=-1 AND NOT t.typbyval AND t.typalign='i' AND t.typstorage='x'
  AND t.typcollation='pg_catalog.default'::regcollation AND t.typbasetype=0 AND t.typtypmod=-1 AND NOT t.typnotnull
  AND t.typdefault IS NULL AND t.typdefaultbin IS NULL AND t.typmodin=0 AND t.typmodout=0
  AND t.typanalyze=0 AND t.typsubscript=0 AND t.typcategory='S' AND NOT t.typispreferred
  AND t.typowner=(SELECT proowner FROM pg_proc WHERE oid='pg_catalog.uuid_eq(uuid,uuid)'::regprocedure)
  AND EXISTS(SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid WHERE d.classid='pg_type'::regclass AND d.objid=t.oid
   AND d.refclassid='pg_extension'::regclass AND d.deptype='e' AND e.extname='citext' AND e.extversion='1.6' AND e.extnamespace=t.typnamespace)
  AND NOT EXISTS(SELECT 1 FROM (VALUES (t.typinput,'citextin','textin'),(t.typoutput,'citextout','textout'),
    (t.typreceive,'citextrecv','textrecv'),(t.typsend,'citextsend','textsend')) v(oid,name,builtin)
   LEFT JOIN pg_proc p ON p.oid=v.oid LEFT JOIN pg_proc b ON b.pronamespace='pg_catalog'::regnamespace AND b.proname=v.builtin
   WHERE p.oid IS NULL OR b.oid IS NULL OR p.pronamespace<>t.typnamespace OR p.proname<>v.name
    OR p.proowner<>b.proowner OR p.prolang<>b.prolang OR p.prosrc<>b.prosrc OR p.probin IS DISTINCT FROM b.probin
    OR p.prokind<>'f' OR p.prosecdef OR NOT p.proisstrict OR p.proleakproof OR p.proretset OR p.prosupport<>0 OR p.provariadic<>0
    OR p.procost<>b.procost OR p.prorows<>0 OR p.provolatile<>b.provolatile OR p.proparallel<>b.proparallel OR p.pronargs<>b.pronargs
    OR p.proconfig IS NOT NULL OR p.proargnames IS NOT NULL OR p.proallargtypes IS NOT NULL OR p.proargmodes IS NOT NULL
    OR p.pronargdefaults<>0 OR p.proargdefaults IS NOT NULL
    OR p.proargtypes<>CASE WHEN v.name IN('citextout','citextsend') THEN t.oid::text::oidvector ELSE b.proargtypes END
    OR p.prorettype<>CASE WHEN v.name IN('citextin','citextrecv') THEN t.oid ELSE b.prorettype END
    OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner OR a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)) AS exact
  FROM pg_type t WHERE t.oid=to_regtype('public.citext')`)).rows;
 if(type.length!==1||type[0]?.exact!==true)throw new Error('Auth reviewed citext type executable closure drift');
 const family=(await client.query(`SELECT
  (SELECT jsonb_agg(jsonb_build_array(a.amopstrategy,o.oprname,p.proname) ORDER BY a.amopstrategy)
   FROM pg_amop a JOIN pg_operator o ON o.oid=a.amopopr JOIN pg_proc p ON p.oid=o.oprcode
   WHERE a.amopfamily=f.oid AND a.amoplefttype=c.opcintype AND a.amoprighttype=c.opcintype
    AND a.amoppurpose='s' AND a.amopmethod=c.opcmethod AND a.amopsortfamily=0
    AND o.oprnamespace=c.opcnamespace AND o.oprleft=c.opcintype AND o.oprright=c.opcintype AND o.oprresult='bool'::regtype
    AND o.oprowner=(SELECT proowner FROM pg_proc WHERE oid='pg_catalog.uuid_eq(uuid,uuid)'::regprocedure)
    AND p.oid=to_regprocedure('public.'||p.proname||'(public.citext,public.citext)')) AS operators,
  (SELECT count(*) FROM pg_amop WHERE amopfamily=f.oid) AS operator_count,
  (SELECT count(*) FROM pg_amproc WHERE amprocfamily=f.oid) AS support_count,
  EXISTS(SELECT 1 FROM pg_amproc WHERE amprocfamily=f.oid AND amproclefttype=c.opcintype AND amprocrighttype=c.opcintype
   AND amprocnum=1 AND amproc='public.citext_cmp(public.citext,public.citext)'::regprocedure) AS support_exact
  FROM pg_opclass c JOIN pg_opfamily f ON f.oid=c.opcfamily JOIN pg_am am ON am.oid=c.opcmethod
  WHERE c.opcnamespace='public'::regnamespace AND c.opcname='citext_ops' AND am.amname='btree'
   AND c.opcintype='public.citext'::regtype AND c.opckeytype=0 AND c.opcdefault
   AND f.opfnamespace=c.opcnamespace AND f.opfname='citext_ops' AND f.opfmethod=c.opcmethod
   AND c.opcowner=f.opfowner AND c.opcowner=(SELECT proowner FROM pg_proc WHERE oid='pg_catalog.uuid_eq(uuid,uuid)'::regprocedure)`)).rows;
 if(family.length!==1||!same(family[0]?.operators,[[1,'<','citext_lt'],[2,'<=','citext_le'],[3,'=','citext_eq'],[4,'>=','citext_ge'],[5,'>','citext_gt']])
  ||Number(family[0]?.operator_count)!==5||Number(family[0]?.support_count)!==1||family[0]?.support_exact!==true)throw new Error('Auth reviewed citext index operator/support closure drift');
}
function defaultMatches(text:string|null,expected:string|undefined,ids:Record<string,number>,typmod=-1):boolean {
 if (!text) return expected===undefined;
 const n=tree(text);
 if (expected==='uuid'||expected==='now') return n.tag==='FUNCEXPR'&&n.funcid===ids[expected]&&same(n.args,null)&&n.funcretset===false;
 if (expected==='sequence') {
  const a=n.args as Node[];
  return n.tag==='FUNCEXPR'&&n.funcid===ids.nextval&&a?.length===1&&a[0]?.tag==='CONST'&&a[0].consttype===2205
    &&bytes(a[0]).readUInt32LE(0)===ids.sequence;
 }
 if (n.tag==='FUNCEXPR'&&Number.isInteger(ids.varchar_cast)&&ids.varchar_cast>0&&n.funcid===ids.varchar_cast&&n.funcretset===false&&typmod>0&&Array.isArray(n.args)&&n.args.length===3) {
  const a=n.args as Node[];
  return a[0]?.tag==='CONST'&&literal(a[0])===expected
   &&a[1]?.tag==='CONST'&&a[1].constisnull===false&&a[1].constbyval===true&&a[1].consttype===23&&bytes(a[1]).readInt32LE(0)===typmod
   &&a[2]?.tag==='CONST'&&a[2].constisnull===false&&a[2].constbyval===true&&a[2].consttype===16&&bytes(a[2])[0]===0;
 }
 return n.tag==='CONST'&&literal(n)===expected;
}
export async function validateAuthRelations(client:AuthQueryClient,phase:'inert'|'disabled'|'active'='inert'):Promise<void> {
 await validateCitextClosure(client,phase);
 await validateAuthForeignKeyClosure(client);
 const ids=(await client.query(`SELECT 'pg_catalog.gen_random_uuid()'::regprocedure::oid AS uuid,
  'pg_catalog.now()'::regprocedure::oid AS now,'pg_catalog.nextval(regclass)'::regprocedure::oid AS nextval,
  'public.audit_log_id_seq'::regclass::oid AS sequence,'pg_catalog.=(text,text)'::regoperator::oid AS text_equal,
  'pg_catalog.varchar(pg_catalog.varchar,pg_catalog.int4,pg_catalog.bool)'::regprocedure::oid AS varchar_cast`)).rows[0];
 if(!ids)throw new Error('Auth catalog builtin identities missing');
 for(const [table,expected] of Object.entries(AUTH_RELATION_INVENTORY)) {
  const name=`public.${table}`;
  const columns=(await client.query(`SELECT a.attname,n.nspname||'.'||t.typname AS type,a.atttypmod,a.attnotnull,a.attnum,
   a.attisdropped,a.attidentity,a.attgenerated,a.attinhcount,a.attcollation=t.typcollation AS native_collation,
   d.adbin::text AS default_tree FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace n ON n.oid=t.typnamespace
   LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=to_regclass($1) AND a.attnum>0 ORDER BY a.attnum`,[name])).rows;
  if(columns.length!==expected.columns.length||columns.some((a,i)=>{const e=expected.columns[i]!;return a.attname!==e[0]||a.type!==e[1]||a.atttypmod!==e[2]||a.attnotnull!==e[3]||a.attnum!==i+1
   ||a.attisdropped!==false||a.attidentity!==''||a.attgenerated!==''||a.attinhcount!==0||a.native_collation!==true||!defaultMatches(a.default_tree,e[4],ids as Record<string,number>,e[2]);})) throw new Error(`Auth exact columns/default drift: ${name}`);
  const constraints=(await client.query(`SELECT conname,contype,conkey,confrelid::regclass::text AS target,confkey,confdeltype,confupdtype,confmatchtype,
   condeferrable,condeferred,convalidated,conislocal,coninhcount,connoinherit,
   CASE WHEN contype='f' THEN conpfeqop=ARRAY[CASE WHEN confrelid='public.audit_log'::regclass
    THEN 'pg_catalog.=(bigint,bigint)'::regoperator::oid ELSE 'pg_catalog.=(uuid,uuid)'::regoperator::oid END]
    AND conppeqop=conpfeqop AND conffeqop=conpfeqop ELSE true END AS fk_equalities,
   CASE WHEN contype IN('p','u') THEN conindid=to_regclass('public.'||conname) ELSE true END AS backing_index,conbin::text AS check_tree FROM pg_constraint WHERE conrelid=to_regclass($1) ORDER BY conname`,[name])).rows;
  if(constraints.length!==expected.constraints.length)throw new Error(`Auth exact constraint inventory drift: ${name}`);
  for(const e of expected.constraints){const a=constraints.find(a=>a.conname===e[0]);
   if(!a||a.contype!==e[1]||!same(a.conkey,e[2])||a.condeferrable!==false||a.condeferred!==false||a.convalidated!==true||a.conislocal!==true||a.coninhcount!==0||e[1]==='c'&&a.connoinherit!==false||a.fk_equalities!==true||a.backing_index!==true
    ||e[1]==='f'&&(a.target!==e[3]||!same(a.confkey,e[4])||a.confdeltype!==e[5]||a.confupdtype!=='a'||a.confmatchtype!=='s'))throw new Error(`Auth exact constraint drift: ${e[0]}`);
   if(e[1]==='c'){const n=tree(a.check_tree),args=n.args as Node[];
    if(n.tag!=='SCALARARRAYOPEXPR'||n.opno!==ids.text_equal||n.useOr!==true||args?.length!==2||variable(args[0]!)!==e[2][0]||!same(literal(args[1]!),e[6]))throw new Error(`Auth exact check drift: ${e[0]}`);
   }else if(a.check_tree!==null)throw new Error('Auth unexpected constraint expression');
  }
  const indexes=(await client.query(`SELECT c.relname,r.rolname AS owner,am.amname,i.indkey::smallint[] AS keys,i.indoption::smallint[] AS options,
   i.indisunique,i.indisprimary,i.indisvalid,i.indisready,i.indislive,i.indisexclusion,i.indimmediate,i.indnullsnotdistinct,i.indnkeyatts,i.indnatts,
   c.relkind='i' AND c.relpersistence='p' AND c.reloptions IS NULL AND c.reltablespace=0 AS storage_exact,
   i.indexprs::text AS expressions,i.indpred::text AS predicate,
   ARRAY(SELECT n.nspname||'.'||o.opcname FROM unnest(i.indclass::oid[]) WITH ORDINALITY x(oid,ord) JOIN pg_opclass o ON o.oid=x.oid JOIN pg_namespace n ON n.oid=o.opcnamespace ORDER BY ord) AS opclasses,
   ARRAY(SELECT co=at.attcollation FROM unnest(i.indcollation::oid[],i.indkey::smallint[]) x(co,attnum) JOIN pg_attribute at ON at.attrelid=i.indrelid AND at.attnum=x.attnum) AS native_collations
   FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_roles r ON r.oid=c.relowner JOIN pg_am am ON am.oid=c.relam WHERE i.indrelid=to_regclass($1) ORDER BY c.relname`,[name])).rows;
  if(indexes.length!==expected.indexes.length)throw new Error(`Auth exact index inventory drift: ${name}`);
  const opclasses:Record<string,string>={'pg_catalog.uuid':'pg_catalog.uuid_ops','public.citext':'public.citext_ops','pg_catalog.bytea':'pg_catalog.bytea_ops','pg_catalog.timestamptz':'pg_catalog.timestamptz_ops','pg_catalog.varchar':'pg_catalog.text_ops','pg_catalog.text':'pg_catalog.text_ops','pg_catalog.int8':'pg_catalog.int8_ops'};
  for(const e of expected.indexes){const a=indexes.find(a=>a.relname===e[0]);
   if(!a||a.owner!=='swat_migrator'||a.amname!=='btree'||!same(a.keys,e[1])||!same(a.options,e[4])||a.indisunique!==e[2]||a.indisprimary!==e[3]
    ||a.indisvalid!==true||a.indisready!==true||a.indislive!==true||a.indisexclusion!==false||a.indimmediate!==true||a.indnullsnotdistinct!==false||a.storage_exact!==true||a.indnkeyatts!==e[1].length||a.indnatts!==e[1].length||a.expressions!==null
    ||!same(a.opclasses,e[1].map(k=>opclasses[expected.columns[k-1]![1]]))||!same(a.native_collations,e[1].map(()=>true)))throw new Error(`Auth exact index drift: ${e[0]}`);
   if(e[5]){const n=tree(a.predicate);if(n.tag!=='NULLTEST'||n.nulltesttype!==1||n.argisrow!==false||variable(n.arg as Node)!==e[5])throw new Error('Auth index predicate drift');}
   else if(a.predicate!==null)throw new Error('Auth unexpected index predicate');
  }
  const hazards=(await client.query(`SELECT 'rule' AS hazard FROM pg_rewrite WHERE ev_class=to_regclass($1)
   UNION ALL SELECT 'inheritance' FROM pg_inherits WHERE inhrelid=to_regclass($1) OR inhparent=to_regclass($1)
   UNION ALL SELECT 'storage' FROM pg_class WHERE oid=to_regclass($1) AND (relispartition OR reloptions IS NOT NULL OR reloftype<>0 OR relpersistence<>'p' OR relam<>(SELECT oid FROM pg_am WHERE amname='heap') OR reltablespace<>0)
   UNION ALL SELECT 'dependency' FROM pg_depend d JOIN pg_proc p ON d.refclassid='pg_proc'::regclass AND d.refobjid=p.oid JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (d.classid='pg_attrdef'::regclass AND d.objid IN(SELECT oid FROM pg_attrdef WHERE adrelid=to_regclass($1))
     OR d.classid='pg_constraint'::regclass AND d.objid IN(SELECT oid FROM pg_constraint WHERE conrelid=to_regclass($1)))
    AND n.nspname<>'pg_catalog'`,[name])).rows;
  if(hazards.length)throw new Error(`Auth unexpected rule/storage/executable dependency: ${name}`);
 }
 const sequence=(await client.query(`SELECT s.seqtypid='pg_catalog.int8'::regtype AS type_matches,s.seqstart::text,s.seqincrement::text,s.seqmin::text,s.seqmax::text,s.seqcache::text,s.seqcycle,
  ARRAY(SELECT d.deptype::text||':'||n.nspname||'.'||c.relname||':'||a.attname FROM pg_depend d JOIN pg_class c ON c.oid=d.refobjid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.refobjsubid WHERE d.classid='pg_class'::regclass AND d.objid=s.seqrelid AND d.refclassid='pg_class'::regclass ORDER BY 1) AS dependencies
  FROM pg_sequence s WHERE s.seqrelid='public.audit_log_id_seq'::regclass`)).rows[0];
 if(!sequence||sequence.type_matches!==true||sequence.seqstart!=='1'||sequence.seqincrement!=='1'||sequence.seqmin!=='1'||sequence.seqmax!=='9223372036854775807'||sequence.seqcache!=='1'||sequence.seqcycle!==false||!same(sequence.dependencies,['a:public.audit_log:id']))throw new Error('Auth exact sequence options/dependencies drift');
}

const helperPins = [
 {signature:'public.is_rls_bypassed()',body:"\n  SELECT current_user = 'swat_migrator' AND session_user = 'swat_migrator';\n",language:'sql',type:'pg_catalog.bool',config:['search_path=pg_catalog'],grantees:['swat_app','swat_financial_receipt_writer','swat_financial_settler','swat_migrator']},
 {signature:'public.current_app_user_id()',body:"\nBEGIN\n  RETURN NULLIF(current_setting('app.current_user_id', true), '')::uuid;\nEXCEPTION WHEN OTHERS THEN\n  RETURN NULL;\nEND;\n",language:'plpgsql',type:'pg_catalog.uuid',config:null,grantees:['swat_app','swat_custody_observer','swat_custody_reader','swat_financial_receipt_writer','swat_financial_settler','swat_lp_admitter','swat_lp_initializer','swat_migrator','swat_wave4_authority_writer','swat_wave4_financial_writer']}
] as const;
export async function validateAuthPolicyClosure(client:AuthQueryClient):Promise<void> {
 for(const e of helperPins){
  const rows=(await client.query(`SELECT p.oid,p.oid=to_regprocedure($1) AS identity_matches,r.rolname AS owner,l.lanname,p.prosrc,p.probin,p.prosqlbody,p.proconfig,p.prokind,p.prosecdef,p.proisstrict,p.proleakproof,p.proretset,p.prosupport,p.provariadic,p.procost,p.prorows,p.provolatile,p.proparallel,p.pronargs,p.proargnames,p.proallargtypes,p.proargmodes,p.pronargdefaults,p.proargdefaults,p.prorettype=to_regtype($2) AS type_matches,
   (SELECT jsonb_agg(jsonb_build_object('grantee',COALESCE(r0.rolname,'PUBLIC'),'grantor',r1.rolname,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY COALESCE(r0.rolname,'PUBLIC')) FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a LEFT JOIN pg_roles r0 ON r0.oid=a.grantee LEFT JOIN pg_roles r1 ON r1.oid=a.grantor) AS acl,
   EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND NOT(d.refclassid='pg_namespace'::regclass AND d.refobjid=p.pronamespace AND d.deptype='n'
    OR d.refclassid='pg_language'::regclass AND d.refobjid=p.prolang AND d.deptype='n')) AS extra_dependency
   FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure($1)`,[e.signature,e.type])).rows;
  const a=rows[0];
  if(rows.length!==1||!a||!Number.isInteger(a.oid)||a.identity_matches!==true||a.owner!=='swat_migrator'||a.lanname!==e.language||a.prosrc!==e.body||a.probin!==null||a.prosqlbody!==null||!same(a.proconfig,e.config)
   ||a.prokind!=='f'||a.prosecdef!==false||a.proisstrict!==false||a.proleakproof!==false||a.proretset!==false||(a.prosupport!=='-'&&Number(a.prosupport)!==0)||Number(a.provariadic)!==0||a.procost!==100||a.prorows!==0||a.provolatile!=='s'||a.proparallel!=='u'||a.pronargs!==0||a.proargnames!==null||a.proallargtypes!==null||a.proargmodes!==null||a.pronargdefaults!==0||a.proargdefaults!==null||a.type_matches!==true||a.extra_dependency!==false
   ||!Array.isArray(a.acl)||!same(a.acl.map((g:{grantee:string})=>g.grantee).sort(),[...e.grantees].sort())||a.acl.some((g:{grantor:string;privilege:string;grantable:boolean})=>g.grantor!=='swat_migrator'||g.privilege!=='EXECUTE'||g.grantable!==false))throw new Error(`Auth exact policy helper closure drift: ${e.signature}`);
 }
 const extra=(await client.query(`SELECT d.objid FROM pg_depend d JOIN pg_policy p ON d.classid='pg_policy'::regclass AND d.objid=p.oid JOIN pg_proc f ON d.refclassid='pg_proc'::regclass AND d.refobjid=f.oid JOIN pg_namespace n ON n.oid=f.pronamespace
  WHERE p.polrelid=ANY($1::regclass[]) AND n.nspname<>'pg_catalog' AND f.oid<>ALL($2::regprocedure[])`,[Object.keys(AUTH_RELATION_INVENTORY).map(t=>`public.${t}`),helperPins.map(p=>p.signature)])).rows;
 if(extra.length)throw new Error('Auth unreviewed policy executable dependency');
}
