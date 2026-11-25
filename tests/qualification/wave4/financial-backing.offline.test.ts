import { describe, expect, it, vi } from 'vitest';
import {
  WAVE4_FINANCIAL_PROVISIONING_STATUS, WAVE4_FINANCIAL_ROLES, WAVE4_FINANCIAL_DISABLED_ROLE_SOURCE,
  WAVE4_FINANCIAL_ROUTINES, WAVE4_FINANCIAL_EXTERNAL_ROUTINE_GRANTS, WAVE4_FINANCIAL_RELATIONS,
  WAVE4_FINANCIAL_FOREIGN_KEYS, WAVE4_FINANCIAL_NON_FK_BINDINGS, WAVE4_FINANCIAL_TRIGGERS,
  WAVE4_FINANCIAL_POLICIES, WAVE4_FINANCIAL_AUDIT_VIEW, WAVE4_FINANCIAL_CANONICAL_ACL_DELTAS,
  WAVE4_FINANCIAL_BASELINE_BOUNDARY, WAVE4_FINANCIAL_PREREQUISITES, WAVE4_FINANCIAL_SOURCE_BLOCKERS,
  WAVE4_FINANCIAL_CATALOG_REQUIREMENTS, validateWave4DisabledFinancialRoles,
  validateWave4FinancialDeclaredInventory, validateWave4FinancialCatalogDeclaration, requireWave4FinancialSourceComplete,
  type Wave4DisabledRoleFacts,
} from '../../../deploy/postgres/wave4-financial-provisioning.js';
import {
  WAVE4_FINANCIAL_BACKING_STATUS, WAVE4_FINANCIAL_BACKING_GAPS,
  assertWave4BackingClientWithClient, admitWave4AuthorityWithClient,
  createWave4CustodyCapabilityAdmissionWithClient, admitWave4CustodyRequestWithClient,
  revokeWave4AuthorityWithClient, revokeWave4RecordWithClient,
  admitWave4LpRecordWithClient, initializeWave4LpWithClient, createWave4LpProtectedSource,
  readWave4CustodyAuditWithClient, admitWave4SpotAccountingWithClient, createWave4SpotSettler,
  refuseWave4WithdrawalAccountingWithClient,
  type Wave4BackingClient, type Wave4AuthorityRecord, type Wave4AuthorityAuthentication,
  type Wave4CustodyRequest, type Wave4LpAdmission, type Wave4SpotAdmission,
} from '../../../packages/db/src/wave4-financial-backing-owned.js';
import { financialHash, type FinancialRecord, type FinancialAttempt, type FinancialReceipt, type WithdrawalIntent }
  from '../../../packages/db/src/withdrawal-contract.js';
import type { ReducingIntent } from '../../../packages/db/src/reducing-contract.js';
import { lpExactHash } from '../../../packages/db/src/lp-exact.js';
import type { LpOwnedBinding, LpOwnedInitialization, LpOwnedProtectedRecord }
  from '../../../packages/db/src/lp-paper-owned.js';

/** AUTHORED, UNRUN inert source tests. No filesystem discovery, SQL parser, source
 * hashes, database, pool, transaction owner, service, key, credentials, provider,
 * installer or funds. Digests below are PAYLOAD-only calculations inside test bodies,
 * not source pins or verified authority. Fake query replies prove no RLS, catalog,
 * isolation, lock ordering, COMMIT, fault, replay or live acceptance.
 */
const USER='11111111-1111-4111-8111-111111111111';
const IDENTITY='22222222-2222-4222-8222-222222222222';
const GRANT='33333333-3333-4333-8333-333333333333';
const RECORD='44444444-4444-4444-8444-444444444444';
const SUBSCRIPTION='55555555-5555-4555-8555-555555555555';
const INTENT='66666666-6666-4666-8666-666666666666';
const ATTEMPT='77777777-7777-4777-8777-777777777777';
const EXECUTION='88888888-8888-4888-8888-888888888888';
const POSITION='99999999-9999-4999-8999-999999999999';
const LOT='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OBSERVED='2026-11-24T00:00:00.000Z', EXPIRES='2026-11-24T00:01:00.000Z';
const binding: LpOwnedBinding={ userId:USER,accountId:'solana:inert-account',chain:'solana',networkId:'solana:inert-network' };
function harness(role='swat_app') {
  const calls: {sql:string;values:unknown[]}[]=[];
  const state: {role:string;allowed:unknown;directRows:number;lookupRows:number;admission:unknown;record:unknown;initialization:unknown;failInsert:boolean}={
    role,allowed:true,directRows:1,lookupRows:1,admission:null,record:null,initialization:null,failInsert:false,
  };
  const query=vi.fn(async (sql:string,values:unknown[]=[]) => {
    calls.push({sql,values:structuredClone(values)});
    if(sql==='SELECT current_user::text AS role') return {rows:[{role:state.role}]};
    if(sql.includes('wave4_direct089(')) return {rows:Array.from({length:state.directRows},()=>({allowed:state.allowed}))};
    if(sql.includes(' AS admission')) return {rows:Array.from({length:state.lookupRows},()=>({admission:state.admission}))};
    if(sql.includes(' AS record')) return {rows:Array.from({length:state.lookupRows},()=>({record:state.record}))};
    if(sql.includes(' AS initialization')) return {rows:Array.from({length:state.lookupRows},()=>({initialization:state.initialization}))};
    if(state.failInsert && sql.startsWith('INSERT')) throw new Error('inert insert refused');
    return {rows:[]};
  });
  return {client:{query} as unknown as Wave4BackingClient,query,calls,state};
}
function disabled(): Wave4DisabledRoleFacts[] {
  return Object.values(WAVE4_FINANCIAL_ROLES).map(r=>({role:r.role,canLogin:false,passwordIsNull:true,
    superuser:false,bypassRls:false,inherit:false,createRole:false,createDb:false,replication:false,
    membershipsIn:0,membershipsOut:0,sessions:0,ownsRelations:false,ownsFunctions:false,ownsSchemas:false,
    ownsDatabases:false,otherSharedOwnership:false,schemaCreate:false,databaseCreate:false,
    settings:['row_security=on','search_path=pg_catalog'],databaseSpecificSettings:[],extraEffectivePrivileges:[]}));
}
function declared() {
  return {routines:WAVE4_FINANCIAL_ROUTINES.map(r=>r.signature),
    relations:[...WAVE4_FINANCIAL_RELATIONS.map(r=>r.relation),WAVE4_FINANCIAL_AUDIT_VIEW.relation],
    triggers:WAVE4_FINANCIAL_TRIGGERS.map(t=>`${t.relation}:${t.name}`),
    foreignKeys:WAVE4_FINANCIAL_FOREIGN_KEYS.map(f=>`${f.from}(${f.columns.join(',')})->${f.to}(${f.targetColumns.join(',')})`)};
}
function hostileArray<T>(values: readonly T[], mode: 'hole'|'getter'|'prototype'|'subclass'|'extra'|'symbol'|'iterator'|'hidden', hook: () => unknown): T[] {
  const array=[...values];
  if(mode==='hole') delete array[0];
  if(mode==='getter') Object.defineProperty(array,'0',{enumerable:true,get:hook});
  if(mode==='prototype') Object.setPrototypeOf(array,{...Array.prototype,0:values[0]});
  if(mode==='subclass') { class HostileArray extends Array<T> {} return HostileArray.from(values); }
  if(mode==='extra') Object.defineProperty(array,'toJSON',{value:hook});
  if(mode==='symbol') Object.defineProperty(array,Symbol('extra'),{value:true});
  if(mode==='iterator') Object.defineProperty(array,Symbol.iterator,{value:hook});
  if(mode==='hidden') Object.defineProperty(array,'0',{value:values[0],enumerable:false});
  return array;
}
const arrayHostility=['hole','getter','prototype','subclass','extra','symbol','iterator','hidden'] as const;
function authority(): Wave4AuthorityRecord {
  return {userId:USER,identityId:IDENTITY,revision:'1',domain:'lp',serviceIdentity:'inert-external-verifier',providerId:'inert-provider',
    identityKind:'external',databaseRole:null,databaseOid:null,backendPid:null,backendStart:null,
    accountId:binding.accountId,chain:binding.chain,networkId:binding.networkId,deploymentId:'inert-deployment',grantId:null,
    capabilities:['initialization'],authenticatedAt:OBSERVED,expiresAt:EXPIRES};
}
function proof(a:Wave4AuthorityRecord): Wave4AuthorityAuthentication {
  return {issuer:'inert-not-authenticated',receiptId:'inert-not-a-real-receipt',payloadHash:financialHash(a),verifiedAt:a.authenticatedAt};
}
function custody(): Wave4CustodyRequest {
  return {capability:'grant-enrollment',identity:'inert-external-service',userId:USER,grantId:GRANT,
    deploymentId:'inert-deployment',chain:'polygon',chainId:'137',payloadDigest:'a'.repeat(64)};
}
function lpAdmission(): Wave4LpAdmission<LpOwnedInitialization> {
  return {id:RECORD,binding,identityId:IDENTITY,authorityRevision:'1',revision:'1',purpose:'initialization',selector:'inert-initialization',
    actions:['acquire','copy','rebalance','close','recover'],observedAt:OBSERVED,expiresAt:EXPIRES,
    payload:{subscription:{id:SUBSCRIPTION,userId:USER,masterWalletAddress:'solana:inert-master',chain:'solana',venue:'meteora-dlmm',
      budgetMicroUsd:'9007199254740993000001',capMicroUsd:'1000000',status:'active',createdAt:OBSERVED,revision:'b'.repeat(64)},poolCapBps:2500}};
}
function protectedRecord(): LpOwnedProtectedRecord<unknown> {
  const payload={secretAdmissionId:RECORD,accountId:binding.accountId,actions:['acquire','copy','rebalance','close','recover']};
  return {id:RECORD,identityId:IDENTITY,providerId:'inert-provider',binding,purpose:'secret',selector:'inert-secret-reference',
    payload,payloadHash:lpExactHash(payload),admittedAt:OBSERVED,expiresAt:EXPIRES,revokedAt:null};
}
function spot() {
  const intent:ReducingIntent={version:1,kind:'reducing',userId:USER,requestKey:'inert-reduction',chain:'solana',network:'solana:inert-network',
    venue:'spot',positionId:POSITION,accountId:'solana:inert-account',assetId:'solana:inert-asset',assetScale:6,mode:'paper',
    positionSide:'LONG',side:'SELL',quantityRaw:'9007199254740993000001',maxFeeRaw:'100',feeAssetId:'inert-fee',feeAssetScale:6,
    feeFundingAccountId:'solana:inert-fee-account',limitPriceExact:'2',expectedRevision:'1',expiresAt:EXPIRES};
  const record:FinancialRecord<ReducingIntent>={id:INTENT,userId:USER,intent,intentHash:financialHash(intent),status:'prepared',completedRaw:'0',terminal:false,createdAt:OBSERVED};
  const attempt:FinancialAttempt={id:ATTEMPT,intentId:INTENT,userId:USER,clientOrderId:'inert-order',intentHash:record.intentHash,
    state:'prepared',completedRaw:'0',completedFeeRaw:'0',terminal:false};
  const receipt:FinancialReceipt={receiptId:'inert-receipt',providerIdentity:'inert-provider',proof:'inert-not-provider-authentication',intentId:INTENT,
    intentHash:record.intentHash,attemptId:ATTEMPT,clientOrderId:attempt.clientOrderId,cumulativeRaw:'9007199254740993000001',feeRaw:'1',
    feeAssetId:intent.feeAssetId,feeAssetScale:intent.feeAssetScale,feeFundingAccountId:intent.feeFundingAccountId,
    terminal:true,outcome:'fill',observedAt:OBSERVED};
  const input:Wave4SpotAdmission={identityId:IDENTITY,authorityRevision:'1',lotId:LOT,executionId:EXECUTION,
    evidence:{executionId:EXECUTION,evidenceType:'paper_simulation',evidenceId:'inert-copy-evidence',baseQuantity:'9007199254740993.000001',
      quoteLeg:{amount:'18014398509481986.000002',currency:'USD'},priceUsd:'2',feeUsd:'0.000001',confirmationState:'finalized',
      completesExecution:true,occurredAt:OBSERVED,observedAt:OBSERVED},
    economics:{feeAssetId:intent.feeAssetId,feeAssetScale:intent.feeAssetScale,feeFundingAccountId:intent.feeFundingAccountId,feeRaw:'1',
      feeUnitUsd:'1',feeUsd:'0.000001',quoteAssetId:'inert-usd',quoteAssetScale:6,quoteAccountId:intent.accountId,
      quoteRaw:'18014398509481986000002',quoteCurrency:'USD'}};
  return {record,attempt,receipt,input,delta:receipt.cumulativeRaw,fee:receipt.feeRaw};
}
function rebaseSpot(q:ReturnType<typeof spot>, raw:string, base:string, scale=6, price='2', quote='2.5', quoteRaw='2500000', quoteScale=6) {
  q.delta=raw;
  q.record={...q.record,intent:{...q.record.intent,quantityRaw:raw,assetScale:scale}};
  q.record={...q.record,intentHash:financialHash(q.record.intent)};
  q.attempt={...q.attempt,intentHash:q.record.intentHash};
  q.receipt={...q.receipt,intentHash:q.record.intentHash,cumulativeRaw:raw};
  q.input={...q.input,evidence:{...q.input.evidence,baseQuantity:base,priceUsd:price,quoteLeg:{amount:quote,currency:'USD'}},
    economics:{...q.input.economics,quoteAssetScale:quoteScale,quoteRaw}};
  return q;
}
/** Only canned SQL transport replies. The real canonical writer performs every
 * evidence/application/lot/state/rebuild call; no settlement function is mocked,
 * no fake ledger arithmetic, SQL execution or transaction ownership is supplied. */
function spotTransport(q:ReturnType<typeof spot>, beforeRaw='2500000.00000000000000000000', afterRaw='1250000.00000000000000000000', afterQuantity='1.25') {
  const calls:{sql:string;values:unknown[]}[]=[];
  const state={beforeRaw,afterRaw,afterRows:1,payloadMatches:true,failSettlement:false};
  const evidence=q.input.evidence, reference=`spot:${EXECUTION}:inert-receipt`;
  const execution={id:EXECUTION,signal_id:null,source_trade_id:null,exit_lot_id:LOT,exit_trigger:'manual',
    chain:q.record.intent.chain,target_account:q.record.intent.accountId,user_id:USER,token_mint:q.record.intent.assetId,
    direction:'sell',execution_mode:'paper',client_order_id:q.attempt.clientOrderId,state:'submitted',
    requested_base_quantity:evidence.baseQuantity,requested_quote_quantity:null,confirmed_base_quantity:'0',confirmed_quote_quantity:null,
    quote_unassessed_fill_count:0,reserved_base_quantity:evidence.baseQuantity,submission_attempts:1,max_submission_attempts:3,
    simulation_id:null,submission_type:null,submission_id:null,next_reconciliation_at:null,reconciliation_claim_id:null,
    reconciliation_attempts:0,max_reconciliation_attempts:3,source_position_before_quantity:null,source_sell_fraction:null};
  const evidenceRow={id:RECORD,execution_id:EXECUTION,evidence_type:evidence.evidenceType,evidence_id:evidence.evidenceId,
    base_quantity:evidence.baseQuantity,quote_quantity:evidence.quoteLeg.amount,quote_native_quantity:evidence.quoteLeg.amount,
    quote_currency:'USD',quote_native_usd_price:'1',price_usd:evidence.priceUsd,fee_usd:evidence.feeUsd,
    confirmation_state:'finalized',completes_execution:true,occurred_at:new Date(evidence.occurredAt)};
  const position={id:POSITION,target_account:execution.target_account,chain:execution.chain,token_mint:execution.token_mint,user_id:USER,
    confirmed_quantity:afterQuantity,reserved_sell_quantity:'0',cost_basis_usd:null,total_acquired_quantity:'2.5',
    total_reduced_quantity:evidence.baseQuantity,unmatched_reduction_quantity:'0',cost_basis_unvalued_fill_count:1,last_evidence_at:new Date(OBSERVED)};
  const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
    calls.push({sql,values:structuredClone(values)});
    if(sql.includes('wave4_direct089(')) return {rows:[{allowed:true}]};
    if(sql.includes(' AS before_raw')) return {rows:[{execution_id:EXECUTION,lot_id:LOT,position_id:POSITION,
      accounting_reference:reference,evidence_input:evidence,evidence_hash:financialHash(evidence),
      economics_hash:financialHash(q.input.economics),before_raw:state.beforeRaw}]};
    if(sql.includes(' AS after_raw')) return {rows:Array.from({length:state.afterRows},()=>({after_raw:state.afterRaw,evidence_id:RECORD}))};
    if(sql.includes('INSERT INTO public.wave4_spot_settlements089')) {
      if(state.failSettlement) throw new Error('inert settlement refused');
      return {rows:[]};
    }
    if(sql.includes('FROM copy_executions') && sql.includes('FOR UPDATE')) return {rows:[execution]};
    if(sql.includes(' AS payload_matches') && sql.includes('FROM copy_execution_evidence'))
      return {rows:[{...evidenceRow,payload_matches:state.payloadMatches}]};
    if(sql.includes('SELECT id') && sql.includes('FROM copy_positions')) return {rows:[{id:POSITION}]};
    if(sql.includes('SELECT id FROM copy_position_master_lot_reductions')) return {rows:[]};
    if(sql.includes('INSERT INTO copy_position_master_lot_reductions')) return {rows:[{id:SUBSCRIPTION}]};
    if(sql.includes(' AS confirmed_base_quantity') && sql.includes('SUM(base_quantity)')) return {rows:[{
      confirmed_base_quantity:evidence.baseQuantity,valued_quote_usd_sum:evidence.quoteLeg.amount,valued_fill_count:'1',
      unvalued_fill_count:'0',completes_execution:true}]};
    if(sql.includes('WITH RECURSIVE ordered_events')) return {rows:[position]};
    if(sql.includes('UPDATE copy_executions') && sql.includes('SET state')) return {rows:[{...execution,state:values[1]}]};
    if(sql.includes('UPDATE copy_executions') && sql.includes('SET confirmed_base_quantity')) return {rows:[{
      ...execution,state:'confirmed',confirmed_base_quantity:evidence.baseQuantity,confirmed_quote_quantity:evidence.quoteLeg.amount,
      reserved_base_quantity:'0'}]};
    if(/^\s*INSERT INTO (copy_execution_evidence|copy_positions|copy_position_applications|copy_execution_state_history)\b/.test(sql)
      || sql.includes('UPDATE copy_position_master_lots lot')) return {rows:[]};
    throw new Error(`Unexpected inert canonical query: ${sql}`);
  });
  return {client:{query} as unknown as Wave4BackingClient,query,calls,state,reference};
}

describe('SQL089 source-only provisioning inventory (authored, not verified)',()=>{
  it('does not assert pins, approval, selection, observed catalog or accepted capabilities',()=>{
    expect(WAVE4_FINANCIAL_PROVISIONING_STATUS.sourceSha256).toBeNull();
    for(const flag of ['sourceComplete','reviewed','selected','applied','installed','testsRun','catalogObserved','runtimeAccepted','liveCapabilityAccepted','productionReady'] as const)
      expect(WAVE4_FINANCIAL_PROVISIONING_STATUS[flag]).toBe(false);
    expect(WAVE4_FINANCIAL_BACKING_STATUS.sourceImplemented).toBe(false);
    expect(WAVE4_FINANCIAL_BACKING_STATUS.runtimeAccepted).toBe(false);
    expect(WAVE4_FINANCIAL_CATALOG_REQUIREMENTS.gateImplemented).toBe(false);
    expect(WAVE4_FINANCIAL_PREREQUISITES.join(' ')).toContain('independently');
    expect(WAVE4_FINANCIAL_BACKING_GAPS.join(' ')).toContain('Canonical withdrawal');
    expect(()=>requireWave4FinancialSourceComplete()).toThrow('SOURCE-refused');
    expect(()=>requireWave4FinancialSourceComplete()).toThrow('custody-invoker-audit');
  });
  it('requires exactly five disabled, drained, nonowning roles with closed settings and no broad authority',()=>{
    expect(()=>validateWave4DisabledFinancialRoles(disabled())).not.toThrow();
    for(const flag of ['canLogin','superuser','bypassRls','inherit','createRole','createDb','replication','ownsRelations','ownsFunctions',
      'ownsSchemas','ownsDatabases','otherSharedOwnership','schemaCreate','databaseCreate'] as const) {
      const rows=disabled();rows[0]={...rows[0]!,[flag]:true};expect(()=>validateWave4DisabledFinancialRoles(rows)).toThrow();
    }
    for(const mutation of [{passwordIsNull:false},{membershipsIn:1},{membershipsOut:1},{sessions:1},
      {settings:['row_security=off','search_path=pg_catalog']},{settings:['row_security=on']},
      {databaseSpecificSettings:['app.bypass_rls=on']},{extraEffectivePrivileges:['pg_read_all_stats']},
      {extraEffectivePrivileges:['PUBLIC SELECT public.audit_log']},{superuser:null}]) {
      const rows=disabled();rows[0]={...rows[0]!,...mutation} as Wave4DisabledRoleFacts;
      expect(()=>validateWave4DisabledFinancialRoles(rows)).toThrow();
    }
    expect(()=>validateWave4DisabledFinancialRoles(disabled().slice(1))).toThrow();
    const rows=disabled();rows[1]=rows[0]!;expect(()=>validateWave4DisabledFinancialRoles(rows)).toThrow();
  });
  it('draft creates only fixed NOLOGIN roles, never installs, grants, switches role or transfers ownership',()=>{
    for(const r of Object.values(WAVE4_FINANCIAL_ROLES)) expect(WAVE4_FINANCIAL_DISABLED_ROLE_SOURCE).toContain(`CREATE ROLE ${r.role} NOLOGIN PASSWORD NULL`);
    expect(WAVE4_FINANCIAL_DISABLED_ROLE_SOURCE).toContain('distinct direct external DBA required');
    expect(WAVE4_FINANCIAL_DISABLED_ROLE_SOURCE).not.toMatch(/\bGRANT\b|\bSET ROLE\b|\bSECURITY DEFINER\b|\bOWNER TO\b|\bIF NOT EXISTS\b|pg_read_all_stats/);
    expect(WAVE4_FINANCIAL_DISABLED_ROLE_SOURCE).not.toMatch(/ALTER ROLE[^;]*\sLOGIN\b/);
    expect(WAVE4_FINANCIAL_ROLES.financialWriter.role).not.toBe('swat_financial_receipt_writer');
    expect(new Set(Object.values(WAVE4_FINANCIAL_ROLES).map(r=>r.role)).size).toBe(5);
  });
  it('transcribes all 14 fixed invoker routines; eight trigger-only functions have no runtime EXECUTE',()=>{
    expect(WAVE4_FINANCIAL_ROUTINES).toHaveLength(14);
    expect(WAVE4_FINANCIAL_ROUTINES.filter(r=>r.result==='trigger')).toHaveLength(8);
    for(const r of WAVE4_FINANCIAL_ROUTINES) {
      expect(r.owner).toBe('swat_migrator');expect(r.security).toBe('INVOKER');expect(r.searchPath).toEqual(['pg_catalog']);
      expect(r.bodyPin).toBeNull();expect(r.grantable).toBe(false);expect(r.defaults).toBe(0);
      expect(r.execute).not.toContain('PUBLIC');expect(r.execute).not.toContain('swat_financial_settler');
      if(r.result==='trigger') expect(r.execute).toEqual(['swat_migrator']);
    }
    expect(WAVE4_FINANCIAL_ROUTINES.find(r=>r.signature==='public.wave4_lp_initialize089(uuid,uuid)')?.execute)
      .toEqual(['swat_migrator','swat_lp_initializer']);
    expect(WAVE4_FINANCIAL_EXTERNAL_ROUTINE_GRANTS.map(r=>r.signature)).toEqual([
      'public.current_app_user_id()','public.lp085_fields(jsonb,text[])','public.lp085_micro(jsonb,boolean)','public.lp085_time(jsonb)']);
    expect(WAVE4_FINANCIAL_ROUTINES.every(r=>Object.isFrozen(r.execute))).toBe(true);
  });
  it('enumerates nine forced-RLS tables, one invoker audit view, 12 triggers and 40 additive policies',()=>{
    expect(WAVE4_FINANCIAL_RELATIONS).toHaveLength(9);expect(WAVE4_FINANCIAL_TRIGGERS).toHaveLength(12);expect(WAVE4_FINANCIAL_POLICIES).toHaveLength(40);
    expect(WAVE4_FINANCIAL_RELATIONS.every(r=>r.forceRls && r.enableRls && r.owner==='swat_migrator')).toBe(true);
    expect(WAVE4_FINANCIAL_RELATIONS.every(r=>r.update.length===0 && r.delete.length===0)).toBe(true);
    const atomic=WAVE4_FINANCIAL_TRIGGERS.filter(t=>t.constraint);
    expect(atomic).toHaveLength(1);expect(atomic[0]?.name).toBe('wave4_spot_atomic089');
    expect(atomic[0]?.deferrable).toBe(true);expect(atomic[0]?.initiallyDeferred).toBe(true);
    expect(atomic[0]?.events).toEqual(['INSERT']);
    expect(WAVE4_FINANCIAL_POLICIES.filter(p=>p.name==='wave4_tenant089')).toHaveLength(9);
    expect(WAVE4_FINANCIAL_AUDIT_VIEW.securityInvoker).toBe(true);expect(WAVE4_FINANCIAL_AUDIT_VIEW.securityBarrier).toBe(true);
    expect(WAVE4_FINANCIAL_AUDIT_VIEW.underlyingAuditSelectGranted).toBe(false);expect(WAVE4_FINANCIAL_AUDIT_VIEW.sourceUsable).toBe(false);
    expect(WAVE4_FINANCIAL_CANONICAL_ACL_DELTAS.filter(a=>a.roles.includes('swat_app')).every(a=>!a.columns.includes('sealed_secret'))).toBe(true);
  });
  it('records 18 actual ordered RESTRICT FKs and deliberately absent pre-initialization FKs',()=>{
    expect(WAVE4_FINANCIAL_FOREIGN_KEYS).toHaveLength(18);
    expect(WAVE4_FINANCIAL_FOREIGN_KEYS.every(f=>f.onDelete==='RESTRICT' && f.onUpdate==='NO ACTION' && !f.deferrable)).toBe(true);
    expect(WAVE4_FINANCIAL_FOREIGN_KEYS.find(f=>f.from==='public.wave4_lp_initializations089' && f.to==='public.lp_copy_subscriptions')?.columns)
      .toEqual(['subscription_id','user_id']);
    expect(WAVE4_FINANCIAL_FOREIGN_KEYS.find(f=>f.from==='public.wave4_spot_admissions089' && f.to==='public.withdrawal_reducing_attempts')?.targetColumns)
      .toEqual(['id','intent_id','user_id']);
    expect(WAVE4_FINANCIAL_FOREIGN_KEYS.some(f=>f.from==='public.wave4_custody_requests089' && f.columns.includes('grant_id'))).toBe(false);
    expect(WAVE4_FINANCIAL_FOREIGN_KEYS.some(f=>f.from==='public.wave4_lp_records089' && f.to==='public.lp_copy_subscriptions')).toBe(false);
    expect(WAVE4_FINANCIAL_NON_FK_BINDINGS).toHaveLength(3);
  });
  it.each(['routines','relations','triggers','foreignKeys'] as const)('rejects missing, duplicate and extra %s declarations',key=>{
    const valid=declared();expect(()=>validateWave4FinancialDeclaredInventory(valid)).not.toThrow();
    expect(()=>validateWave4FinancialDeclaredInventory({...valid,[key]:valid[key].slice(1)})).toThrow();
    expect(()=>validateWave4FinancialDeclaredInventory({...valid,[key]:[...valid[key],valid[key][0]]})).toThrow();
    expect(()=>validateWave4FinancialDeclaredInventory({...valid,[key]:[...valid[key],'public.hostile']})).toThrow();
  });
  it.each(['routines','relations','triggers','foreignKeys'] as const)('rejects holes, accessors, prototypes and noninert %s arrays without hooks',key=>{
    for(const mode of arrayHostility) {
      const input=declared(),hook=vi.fn(()=>input[key][0]);
      input[key]=hostileArray(input[key],mode,hook);
      expect(()=>validateWave4FinancialDeclaredInventory(input)).toThrow();
      expect(hook).not.toHaveBeenCalled();
    }
  });
  it.each(['settings','databaseSpecificSettings','extraEffectivePrivileges'] as const)('rejects noninert role %s and exact-length sparse required settings',key=>{
    for(const mode of arrayHostility) {
      const rows=disabled(),hook=vi.fn(()=> 'row_security=on');
      const values=key==='settings' ? rows[0]!.settings : ['unapproved'];
      rows[0]={...rows[0]!,[key]:hostileArray(values,mode,hook)};
      expect(()=>validateWave4DisabledFinancialRoles(rows)).toThrow();expect(hook).not.toHaveBeenCalled();
    }
    if(key!=='settings') {
      const rows=disabled(),hook=vi.fn(()=> []),empty:string[]=[];
      Object.defineProperty(empty,Symbol.iterator,{value:hook});
      rows[0]={...rows[0]!,[key]:empty};
      expect(()=>validateWave4DisabledFinancialRoles(rows)).toThrow();expect(hook).not.toHaveBeenCalled();
    }
  });
  it('rejects noninert role rows and declaration containers without reading accessors or inherited facts',()=>{
    for(const mode of arrayHostility) {
      const rows=disabled(),hook=vi.fn(()=>rows[0]);
      expect(()=>validateWave4DisabledFinancialRoles(hostileArray(rows,mode,hook))).toThrow();expect(hook).not.toHaveBeenCalled();
    }
    const rows=disabled(),roleGetter=vi.fn(()=>rows[0]!.role),role={...rows[0]!};
    Object.defineProperty(role,'role',{enumerable:true,get:roleGetter});rows[0]=role;
    expect(()=>validateWave4DisabledFinancialRoles(rows)).toThrow();expect(roleGetter).not.toHaveBeenCalled();
    const input=declared(),getter=vi.fn(()=>input.routines),container={...input};
    Object.defineProperty(container,'routines',{enumerable:true,get:getter});
    expect(()=>validateWave4FinancialDeclaredInventory(container)).toThrow();expect(getter).not.toHaveBeenCalled();
    expect(()=>validateWave4FinancialDeclaredInventory(Object.create(input))).toThrow();
    const withToJson={...input,toJSON:()=>input};
    expect(()=>validateWave4FinancialDeclaredInventory(withToJson)).toThrow();
    const inherited=disabled();inherited[0]=Object.create(inherited[0]);
    expect(()=>validateWave4DisabledFinancialRoles(inherited)).toThrow();
  });
  it('refuses swapped composite FK order and fake scalar JSONB signatures, not any-FK acceptance',()=>{
    const input=declared();input.foreignKeys[8]='public.wave4_lp_initializations089(user_id,subscription_id)->public.lp_copy_subscriptions(id,user_id)';
    expect(()=>validateWave4FinancialDeclaredInventory(input)).toThrow();
    const scalar=declared();scalar.routines[0]='public.wave4_direct089(jsonb)';
    expect(()=>validateWave4FinancialDeclaredInventory(scalar)).toThrow();
  });
  it('rejects definer, transferred owner, PUBLIC EXECUTE, grant-option and routine defaults drift',()=>{
    const routine=WAVE4_FINANCIAL_ROUTINES[0]!;
    expect(()=>validateWave4FinancialCatalogDeclaration('routine',structuredClone(routine))).not.toThrow();
    for(const mutation of [{security:'DEFINER'},{owner:'swat_runtime_lookup'},{owner:'swat_financial_settler'},
      {execute:[...routine.execute,'PUBLIC']},{grantable:true},{searchPath:['public','pg_catalog']},
      {defaults:1},{argumentNames:['tenant','expected_role']},{result:'jsonb'},{strict:null},{bodyPin:'a'.repeat(64)}])
      expect(()=>validateWave4FinancialCatalogDeclaration('routine',{...routine,...mutation})).toThrow();
    const getter=vi.fn(()=> 'INVOKER'),hostile={...routine};
    Object.defineProperty(hostile,'security',{enumerable:true,get:getter});
    expect(()=>validateWave4FinancialCatalogDeclaration('routine',hostile)).toThrow();expect(getter).not.toHaveBeenCalled();
    expect(()=>validateWave4FinancialCatalogDeclaration('routine',{...routine,toJSON:()=>routine})).toThrow();
  });
  it('rejects weakened FK actions, deferred closure drift, permissive custody scope and broad canonical SELECT',()=>{
    const fk=WAVE4_FINANCIAL_FOREIGN_KEYS[8]!,atomic=WAVE4_FINANCIAL_TRIGGERS.find(t=>t.constraint)!;
    for(const mutation of [{onDelete:'CASCADE'},{validated:false},{deferrable:true},{targetColumns:['user_id','id']},
      {columns:['subscription_id']},{match:'FULL'}]) expect(()=>validateWave4FinancialCatalogDeclaration('foreignKey',{...fk,...mutation})).toThrow();
    for(const mutation of [{deferrable:false},{initiallyDeferred:false},{timing:'BEFORE'},{enabled:'D'},
      {arguments:['caller-label']},{function:'public.w3_apply_financial_receipt()'}])
      expect(()=>validateWave4FinancialCatalogDeclaration('trigger',{...atomic,...mutation})).toThrow();
    const scope=WAVE4_FINANCIAL_POLICIES.find(p=>p.relation==='public.user_execution_grants' && p.name==='wave4_execution_scope089')!;
    for(const mutation of [{permissive:true},{using:'true'},{check:'true'},{roles:['PUBLIC']}])
      expect(()=>validateWave4FinancialCatalogDeclaration('policy',{...scope,...mutation})).toThrow();
    const metadata=WAVE4_FINANCIAL_CANONICAL_ACL_DELTAS.find(a=>a.roles.includes('swat_app'))!;
    expect(()=>validateWave4FinancialCatalogDeclaration('canonicalAcl',{...metadata,columns:[]})).toThrow();
    expect(()=>validateWave4FinancialCatalogDeclaration('canonicalAcl',{...metadata,columns:[...metadata.columns,'sealed_secret']})).toThrow();
    expect(()=>validateWave4FinancialCatalogDeclaration('canonicalAcl',{relations:['public.audit_log'],roles:['swat_custody_observer'],privilege:'SELECT',columns:[]})).toThrow();
  });
  it('preserves 001–087/refused084 boundary and exactly seven079082 transfers, never selects companions',()=>{
    expect(WAVE4_FINANCIAL_BASELINE_BOUNDARY.selectedProposals).toEqual([]);
    expect(WAVE4_FINANCIAL_BASELINE_BOUNDARY.brokerExtended).toBe(false);
    expect(WAVE4_FINANCIAL_BASELINE_BOUNDARY.brokerTransfersUnchanged).toHaveLength(7);
    expect(WAVE4_FINANCIAL_BASELINE_BOUNDARY.brokerTransfersUnchanged.filter(s=>s.includes('wave4_'))).toEqual([]);
    expect(WAVE4_FINANCIAL_BASELINE_BOUNDARY.historicalConstraintBaseline).toBe(47);
    expect(WAVE4_FINANCIAL_BASELINE_BOUNDARY.historicalEnforcementPathBaseline).toBe(188);
    expect(WAVE4_FINANCIAL_SOURCE_BLOCKERS.filter(b=>b.layer==='SOURCE').map(b=>b.id)).toEqual([
      'database-identity','custody-database-scope','custody-invoker-audit','sql081-secret-read','custody-journal-composition',
      'withdrawal-account-journal','spot-fee-only','nested-lp-validation','chronology-lock-closure','catalog-pin-closure']);
  });
});

describe('financial backing mandatory-client hostile inert adapters (unrun)',()=>{
  it.each(['swat_migrator','swat_financial_settler','PUBLIC','swat_app; SET ROLE swat_migrator'])('rejects arbitrary/direct %s before querying',async role=>{
    const h=harness();await expect(assertWave4BackingClientWithClient(h.client,USER,role)).rejects.toThrow('fixed-direct-role');
    expect(h.query).not.toHaveBeenCalled();
  });
  it.each([false,null,'true',1])('refuses non-exact direct approval %s before writes',async allowed=>{
    const h=harness('swat_wave4_authority_writer');h.state.allowed=allowed;
    const a=authority();await expect(admitWave4AuthorityWithClient(h.client,a,proof(a))).rejects.toThrow('approved-direct');
    expect(h.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);
  });
  it('rejects zero/duplicate direct result cardinality, never uses a pool fallback',async()=>{
    for(const count of [0,2]) {
      const h=harness();h.state.directRows=count;
      await expect(assertWave4BackingClientWithClient(h.client,USER,'swat_app')).rejects.toThrow();
    }
    await expect(assertWave4BackingClientWithClient(null as unknown as Wave4BackingClient,USER,'swat_app')).rejects.toThrow('primary-client');
  });
  it('refuses cross-role database identities and external rows with any backend field before any query',async()=>{
    for(const mutation of [{identityKind:'database',databaseRole:'swat_app',databaseOid:'42',backendPid:99,backendStart:'2026-11-24T00:00:00.000001Z'},
      {databaseRole:'swat_app'},{databaseOid:'42'},{backendPid:99},{backendStart:OBSERVED}]) {
      const h=harness('swat_wave4_authority_writer'),a={...authority(),...mutation} as Wave4AuthorityRecord;
      await expect(admitWave4AuthorityWithClient(h.client,a,proof(a))).rejects.toThrow('cross-role-backend-strategy-unavailable');
      expect(h.query).not.toHaveBeenCalled();
    }
  });
  it('inert verified-proof labels do not create external verification or COMMIT ownership',async()=>{
    const h=harness('swat_wave4_authority_writer'),a=authority();
    await admitWave4AuthorityWithClient(h.client,a,proof(a));
    expect(h.calls[0]?.values).toEqual(['swat_wave4_authority_writer',USER]);
    const insert=h.calls[1]!;expect(insert.sql).toContain('public.wave4_authorities089');
    expect(insert.values.slice(6,11)).toEqual(['external',null,null,null,null]);
    expect(JSON.parse(insert.values[17] as string)).toEqual(a);
    expect(h.calls.some(c=>/^(BEGIN|COMMIT|ROLLBACK|GRANT|ALTER|SET ROLE)/.test(c.sql))).toBe(false);
    const rejected=harness('swat_wave4_authority_writer');
    await expect(admitWave4AuthorityWithClient(rejected.client,a,{...proof(a),payloadHash:'f'.repeat(64)})).rejects.toThrow('authentication-mismatch');
    expect(rejected.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);
  });
  it('captures payload before async wait; never invokes getters/toJSON/cycles/sparse array hooks',async()=>{
    const h=harness('swat_wave4_authority_writer'),a=authority(),p=proof(a);
    const pending=admitWave4AuthorityWithClient(h.client,a,p);(a as {providerId:string}).providerId='mutated-after-call';await pending;
    expect(JSON.parse(h.calls[1]!.values[17] as string).providerId).toBe('inert-provider');
    const getter=vi.fn(()=> 'hostile');
    const hostile={...authority()};Object.defineProperty(hostile,'providerId',{enumerable:true,get:getter});
    await expect(admitWave4AuthorityWithClient(h.client,hostile,p)).rejects.toThrow('data-properties');expect(getter).not.toHaveBeenCalled();
    const toJSON=vi.fn(()=>({})),cycle:any=authority();cycle.next=cycle;
    await expect(admitWave4AuthorityWithClient(h.client,{...authority(),toJSON} as Wave4AuthorityRecord,p)).rejects.toThrow();expect(toJSON).not.toHaveBeenCalled();
    await expect(admitWave4AuthorityWithClient(h.client,cycle,p)).rejects.toThrow('acyclic');
    const sparse=authority();(sparse as any).capabilities=new Array(2);
    await expect(admitWave4AuthorityWithClient(h.client,sparse,p)).rejects.toThrow('dense-array');
  });
  it('custody lookup acquires adapter direct tenant lock before fixed lookup; missing rows remain unavailable',async()=>{
    const h=harness(),request=custody(),port=createWave4CustodyCapabilityAdmissionWithClient(h.client);
    expect(await port.authorize(request)).toBeNull();
    expect(h.calls.map(c=>c.sql)).toEqual(['SELECT current_user::text AS role',
      'SELECT public.wave4_direct089($1,$2::uuid) AS allowed','SELECT public.wave4_custody_lookup089($1::uuid,$2::jsonb) AS admission']);
    expect(h.calls[1]?.values).toEqual(['swat_app',USER]);
    h.state.admission={request,approved:true,validUntil:EXPIRES,capabilities:['grant-enrollment','grant-lifecycle']};
    expect((await port.authorize(request))?.validUntil.toISOString()).toBe(EXPIRES);
    h.state.role='swat_migrator';await expect(port.authorize(request)).rejects.toThrow('fixed-reader');
  });
  it.each(['tenant','grant','payload','deployment','capability','approval','time','duplicate'])('refuses hostile custody %s reply',async mode=>{
    const h=harness(),request=custody();h.state.admission={request:{...request},approved:true,validUntil:EXPIRES,capabilities:['grant-enrollment']};
    const row=h.state.admission as any;
    if(mode==='tenant')row.request.userId=IDENTITY;
    if(mode==='grant')row.request.grantId=RECORD;
    if(mode==='payload')row.request.payloadDigest='b'.repeat(64);
    if(mode==='deployment')row.request.deploymentId='foreign-deployment';
    if(mode==='capability')row.capabilities=['execution-secret-read'];
    if(mode==='approval')row.approved='true';
    if(mode==='time')row.validUntil='2026-11-24T00:01:00Z';
    if(mode==='duplicate')h.state.lookupRows=2;
    await expect(createWave4CustodyCapabilityAdmissionWithClient(h.client).authorize(request)).rejects.toThrow();
  });
  it('authority writer appends only closed request/authority/custody/LP revocation tables',async()=>{
    const h=harness('swat_wave4_authority_writer');
    await admitWave4CustodyRequestWithClient(h.client,{id:RECORD,identityId:IDENTITY,authorityRevision:'1',request:custody(),expiresAt:EXPIRES});
    await revokeWave4AuthorityWithClient(h.client,{userId:USER,identityId:IDENTITY,revision:'1',reason:'inert-revocation'});
    await revokeWave4RecordWithClient(h.client,{domain:'custody',userId:USER,id:RECORD,reason:'inert-revocation'});
    await revokeWave4RecordWithClient(h.client,{domain:'lp',userId:USER,id:RECORD,reason:'inert-revocation'});
    const inserts=h.calls.filter(c=>c.sql.startsWith('INSERT'));
    expect(inserts).toHaveLength(4);expect(inserts.every(c=>c.sql.includes('089'))).toBe(true);
    const before=inserts.length;
    await expect(revokeWave4RecordWithClient(h.client,{domain:'audit_log' as any,userId:USER,id:RECORD,reason:'inert'})).rejects.toThrow('domain-refused');
    expect(h.calls.filter(c=>c.sql.startsWith('INSERT'))).toHaveLength(before);
  });
  it('separates LP initialization approval, noninitialization provenance and canonical initializer clients',async()=>{
    const approval=harness('swat_wave4_authority_writer'),q=lpAdmission();
    await admitWave4LpRecordWithClient(approval.client,q);
    expect(approval.calls[0]?.values).toEqual(['swat_wave4_authority_writer',USER]);
    expect(approval.calls[1]?.values.at(-1)).toBe(SUBSCRIPTION);
    expect(approval.calls.some(c=>c.sql.includes('INSERT INTO public.lp_copy_subscriptions'))).toBe(false);
    const provenance=harness('swat_wave4_financial_writer');
    await admitWave4LpRecordWithClient(provenance.client,{...q,purpose:'secret',payload:{secretAdmissionId:RECORD,accountId:binding.accountId,actions:q.actions}});
    expect(provenance.calls[0]?.values).toEqual(['swat_wave4_financial_writer',USER]);
    expect(provenance.calls[1]?.values.at(-1)).toBeNull();
    const initializer=harness('swat_lp_initializer');initializer.state.initialization=q.payload;
    expect(await initializeWave4LpWithClient(initializer.client,USER,RECORD)).toEqual(q.payload);
    expect(initializer.calls[0]?.values).toEqual(['swat_lp_initializer',USER]);
    expect(initializer.calls[1]?.sql).toBe('SELECT public.wave4_lp_initialize089($1::uuid,$2::uuid) AS initialization');
    expect(initializer.calls.some(c=>c.sql==='COMMIT')).toBe(false);
  });
  it('rejects malformed initialization and unknown LP purpose without query or fallback',async()=>{
    const h=harness(),q=lpAdmission();
    await expect(admitWave4LpRecordWithClient(h.client,{...q,payload:{}} as any)).rejects.toThrow('complete-initialization');
    await expect(admitWave4LpRecordWithClient(h.client,{...q,purpose:'operator-sql'} as any)).rejects.toThrow('fixed-lp-purpose');
    expect(h.query).not.toHaveBeenCalled();
    await expect(initializeWave4LpWithClient(h.client,USER,RECORD)).rejects.toThrow('initialization-unavailable');
  });
  it('reads exact eight-purpose canonical LP source record, never substitutes caller payload for absent record',async()=>{
    const h=harness(),source=createWave4LpProtectedSource();
    expect(await source.read(h.client as any,binding,'secret','inert-secret-reference')).toBeNull();
    h.state.record=protectedRecord();
    expect(await source.read(h.client as any,binding,'secret','inert-secret-reference')).toEqual(h.state.record);
    expect(h.calls[0]?.values).toEqual([USER,binding.accountId,binding.chain,binding.networkId,'secret','inert-secret-reference']);
  });
  it.each(['tenant','network','account','purpose','selector','hash','revoked','chronology','duplicate'])('refuses hostile LP %s record',async mode=>{
    const h=harness(),row=structuredClone(protectedRecord()) as any;h.state.record=row;
    if(mode==='tenant')row.binding.userId=IDENTITY;
    if(mode==='network')row.binding.networkId='solana:foreign';
    if(mode==='account')row.binding.accountId='solana:foreign';
    if(mode==='purpose')row.purpose='quote';
    if(mode==='selector')row.selector='foreign';
    if(mode==='hash')row.payload.accountId='solana:changed-without-digest';
    if(mode==='revoked')row.revokedAt=OBSERVED;
    if(mode==='chronology')row.expiresAt=row.admittedAt;
    if(mode==='duplicate')h.state.lookupRows=2;
    await expect(createWave4LpProtectedSource().read(h.client as any,binding,'secret','inert-secret-reference')).rejects.toThrow();
  });
  it('custody audit SOURCE-refuses even an approved client before any query, never raw audit SELECT',async()=>{
    const h=harness('swat_custody_observer');
    await expect(readWave4CustodyAuditWithClient(h.client,USER,GRANT)).rejects.toThrow('scoped-invoker-audit-acl-rls-strategy-unavailable');
    expect(h.query).not.toHaveBeenCalled();
    for(const count of [0,-1,1001,1.5]) await expect(readWave4CustodyAuditWithClient(h.client,USER,GRANT,count)).rejects.toThrow('bounded-audit');
    await expect(readWave4CustodyAuditWithClient(null as any,USER,GRANT,1000)).rejects.toThrow('strategy-unavailable');
  });
  it('binds spot admission to actual explicit execution/lot, exact receipt deltas and complete evidence/economics',async()=>{
    const h=harness('swat_financial_receipt_writer'),q=spot();
    expect(await admitWave4SpotAccountingWithClient(h.client,q.record,q.attempt,q.receipt,q.delta,q.fee,q.input))
      .toBe(`spot:${EXECUTION}:inert-receipt`);
    expect(h.calls[0]?.values).toEqual(['swat_financial_receipt_writer',USER]);
    expect(h.calls[1]?.sql).toContain('public.wave4_spot_admissions089');
    expect(h.calls[1]?.values.slice(6,9)).toEqual([EXECUTION,LOT,POSITION]);
    expect(h.calls[1]?.values.slice(18,20)).toEqual(['9007199254740993000001','1']);
    expect(JSON.parse(h.calls[1]!.values[25] as string)).toEqual(q.input.evidence);
    expect(JSON.parse(h.calls[1]!.values[28] as string)).toEqual(q.input.economics);
    expect(h.calls[2]?.sql).toContain('public.withdrawal_reducing_accounting_admissions');
    expect(h.calls[2]?.values.slice(3,5)).toEqual([q.delta,q.fee]);
  });
  it.each(['zero-base','fee-only','number-base','number-quote','execution','foreign-attempt','foreign-receipt','delta','fee',
    'fee-account','fee-scale','quote-account','quote-raw','future-occurred','missing-native-rate','unfinalized','perps'])('rejects hostile spot %s before SQL',async mode=>{
    const h=harness('swat_financial_receipt_writer'),q=spot();
    if(mode==='zero-base')(q.input as any).evidence={...q.input.evidence,baseQuantity:'0'};
    if(mode==='fee-only')q.delta='0';
    if(mode==='number-base')(q.input.evidence as any).baseQuantity=9007199254740993;
    if(mode==='number-quote')(q.input.evidence.quoteLeg as any).amount=2;
    if(mode==='execution')(q.input as any).executionId=RECORD;
    if(mode==='foreign-attempt')(q.attempt as any).userId=IDENTITY;
    if(mode==='foreign-receipt')(q.receipt as any).attemptId=RECORD;
    if(mode==='delta')q.delta='1';
    if(mode==='fee')q.fee='2';
    if(mode==='fee-account')(q.input.economics as any).feeFundingAccountId='foreign';
    if(mode==='fee-scale')(q.input.economics as any).feeAssetScale=9;
    if(mode==='quote-account')(q.input.economics as any).quoteAccountId='foreign';
    if(mode==='quote-raw')(q.input.economics as any).quoteRaw='1';
    if(mode==='future-occurred')(q.input.evidence as any).occurredAt=EXPIRES;
    if(mode==='missing-native-rate')(q.input as any).evidence={...q.input.evidence,quoteLeg:{...q.input.evidence.quoteLeg,currency:'SOL'}};
    if(mode==='unfinalized')(q.input.evidence as any).confirmationState='confirmed';
    if(mode==='perps')(q.record.intent as any).venue='polymarket-perps';
    await expect(admitWave4SpotAccountingWithClient(h.client,q.record,q.attempt,q.receipt,q.delta,q.fee,q.input)).rejects.toThrow();
    expect(h.query).not.toHaveBeenCalled();
  });
  it('admits higher-scale exact raw base only in unconstrained canonical base, not by widening money',async()=>{
    const q=rebaseSpot(spot(),'1','0.0000000000000000001',19,'10','0.000000000000000001','1',18);
    const h=harness('swat_financial_receipt_writer');
    await admitWave4SpotAccountingWithClient(h.client,q.record,q.attempt,q.receipt,q.delta,q.fee,q.input);
    expect(JSON.parse(h.calls[1]!.values[25] as string).baseQuantity).toBe('0.0000000000000000001');
    expect(JSON.parse(h.calls[1]!.values[25] as string).quoteLeg.amount).toBe('0.000000000000000001');
  });
  it('refuses exactly valued feeRaw=1 scale=19 at unit USD=1 before any admission write',async()=>{
    const q=spot(),h=harness('swat_financial_receipt_writer');
    q.record={...q.record,intent:{...q.record.intent,feeAssetScale:19}};
    q.record={...q.record,intentHash:financialHash(q.record.intent)};
    q.attempt={...q.attempt,intentHash:q.record.intentHash};
    q.receipt={...q.receipt,intentHash:q.record.intentHash,feeAssetScale:19};
    q.input={...q.input,evidence:{...q.input.evidence,feeUsd:'0.0000000000000000001'},
      economics:{...q.input.economics,feeAssetScale:19,feeUnitUsd:'1',feeUsd:'0.0000000000000000001'}};
    await expect(admitWave4SpotAccountingWithClient(h.client,q.record,q.attempt,q.receipt,q.delta,q.fee,q.input))
      .rejects.toThrow('exact non-negative money');
    expect(h.query).not.toHaveBeenCalled();
  });
  it.each(['priceUsd','feeUsd','quoteAmount','nativeUsdPrice','feeUnitUsd','economicsFeeUsd'] as const)
    ('refuses canonical money precision/range loss in %s before SQL',async field=>{
      for(const value of ['0.0000000000000000001','100000000000000000000','1.0000000000000000000']) {
        const q=spot(),h=harness('swat_financial_receipt_writer');
        if(field==='priceUsd' || field==='feeUsd') q.input={...q.input,evidence:{...q.input.evidence,[field]:value}};
        if(field==='quoteAmount') q.input={...q.input,evidence:{...q.input.evidence,quoteLeg:{...q.input.evidence.quoteLeg,amount:value}}};
        if(field==='nativeUsdPrice') q.input={...q.input,evidence:{...q.input.evidence,quoteLeg:{...q.input.evidence.quoteLeg,currency:'SOL',nativeUsdPrice:value}}};
        if(field==='feeUnitUsd') q.input={...q.input,economics:{...q.input.economics,feeUnitUsd:value}};
        if(field==='economicsFeeUsd') q.input={...q.input,economics:{...q.input.economics,feeUsd:value}};
        await expect(admitWave4SpotAccountingWithClient(h.client,q.record,q.attempt,q.receipt,q.delta,q.fee,q.input)).rejects.toThrow();
        expect(h.query).not.toHaveBeenCalled();
      }
    });
  it('bounds the exact derived native USD quote without rounding the conversion',async()=>{
    for(const quoteLeg of [{amount:'0.000000000000000001',currency:'SOL' as const,nativeUsdPrice:'0.1'},
      {amount:'99999999999999999999',currency:'SOL' as const,nativeUsdPrice:'2'}]) {
      const q=spot(),h=harness('swat_financial_receipt_writer');q.input={...q.input,evidence:{...q.input.evidence,quoteLeg}};
      await expect(admitWave4SpotAccountingWithClient(h.client,q.record,q.attempt,q.receipt,q.delta,q.fee,q.input))
        .rejects.toThrow('exact non-negative money');
      expect(h.query).not.toHaveBeenCalled();
    }
  });
  it('preserves large exact money and known decimal fee zero, never accepts null as a fully valued fee',async()=>{
    const money='99999999999999999999.000000000000000001';
    const q=rebaseSpot(spot(),'1000000','1',6,money,money,`${'9'.repeat(20)}${'0'.repeat(17)}1`,18);
    const large=harness('swat_financial_receipt_writer');
    await admitWave4SpotAccountingWithClient(large.client,q.record,q.attempt,q.receipt,q.delta,q.fee,q.input);
    expect(JSON.parse(large.calls[1]!.values[25] as string).priceUsd).toBe('99999999999999999999.000000000000000001');
    const zero=spot(),h=harness('swat_financial_receipt_writer');
    zero.fee='0';zero.receipt={...zero.receipt,feeRaw:'0'};
    zero.input={...zero.input,evidence:{...zero.input.evidence,feeUsd:'0.000000000000000000'},
      economics:{...zero.input.economics,feeRaw:'0',feeUsd:'0.000000000000000000',feeUnitUsd:'0'}};
    await admitWave4SpotAccountingWithClient(h.client,zero.record,zero.attempt,zero.receipt,zero.delta,zero.fee,zero.input);
    expect(JSON.parse(h.calls[1]!.values[25] as string).feeUsd).toBe('0.000000000000000000');
    for(const field of ['baseQuantity','priceUsd','feeUsd','quoteLeg'] as const) {
      const invalid=spot(),refused=harness('swat_financial_receipt_writer');
      invalid.input={...invalid.input,evidence:{...invalid.input.evidence,[field]:null} as any};
      await expect(admitWave4SpotAccountingWithClient(refused.client,invalid.record,invalid.attempt,invalid.receipt,invalid.delta,invalid.fee,invalid.input)).rejects.toThrow();
      expect(refused.query).not.toHaveBeenCalled();
    }
  });
  it.each(['baseQuantity','priceUsd','quoteAmount','nativeUsdPrice'] as const)('rejects decimal-zero positive %s before SQL',async field=>{
    const q=spot(),h=harness('swat_financial_receipt_writer'),value='0.000000000000000000';
    if(field==='baseQuantity' || field==='priceUsd') q.input={...q.input,evidence:{...q.input.evidence,[field]:value}};
    if(field==='quoteAmount') q.input={...q.input,evidence:{...q.input.evidence,quoteLeg:{...q.input.evidence.quoteLeg,amount:value}}};
    if(field==='nativeUsdPrice') q.input={...q.input,evidence:{...q.input.evidence,quoteLeg:{...q.input.evidence.quoteLeg,currency:'SOL',nativeUsdPrice:value}}};
    await expect(admitWave4SpotAccountingWithClient(h.client,q.record,q.attempt,q.receipt,q.delta,q.fee,q.input)).rejects.toThrow('spot-decimal');
    expect(h.query).not.toHaveBeenCalled();
  });
  it('withholds spot return on insert failure; caller still owns rollback and COMMIT',async()=>{
    const h=harness('swat_financial_receipt_writer'),q=spot();h.state.failInsert=true;
    await expect(admitWave4SpotAccountingWithClient(h.client,q.record,q.attempt,q.receipt,q.delta,q.fee,q.input)).rejects.toThrow('insert refused');
    expect(h.calls).toHaveLength(2);expect(h.calls.some(c=>/^(COMMIT|ROLLBACK)/.test(c.sql))).toBe(false);
  });
  it('canonical settler refuses fee-only, perps and absent persisted spot chain without inventing copy evidence',async()=>{
    const h=harness(),q=spot(),settle=createWave4SpotSettler();
    await expect(settle(h.client,q.record,q.receipt,'0','1')).rejects.toThrow('invalid-exact-raw');expect(h.query).not.toHaveBeenCalled();
    await expect(settle(h.client,{...q.record,intent:{...q.record.intent,venue:'polymarket-perps'}},q.receipt,q.delta,q.fee)).rejects.toThrow('canonical-spot-required');
    expect(h.query).not.toHaveBeenCalled();
    await expect(settle(h.client,q.record,q.receipt,q.delta,q.fee)).rejects.toThrow('persisted-canonical-spot-binding-unavailable');
    expect(h.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);
    expect(h.calls[1]?.sql).toContain('FOR UPDATE OF position');
    expect(h.calls[1]?.sql).toContain('attempt.completed_fee_raw');
  });
  it.each([
    ['2500000.00000000000000000000','1250000.00000000000000000000','2500000','1250000'],
    ['1250000.00000000000000000000','0.00000000000000000000','1250000','0'],
  ])('real canonical nonzero-base adapter normalizes integral NUMERIC text %s -> %s on the supplied transport',async(before,after,beforeDigits,afterDigits)=>{
    const q=rebaseSpot(spot(),'1250000','1.25'),h=spotTransport(q,before,after,afterDigits==='0'?'0':'1.25');
    const result=await createWave4SpotSettler()(h.client,q.record,q.receipt,q.delta,q.fee);
    expect(result).toEqual({accountingReference:h.reference,positionId:POSITION,positionSide:'LONG',beforeRaw:beforeDigits,afterRaw:afterDigits,
      economicsReference:`spot-economics:${financialHash(q.input.economics)}`});
    const evidence=h.calls.find(c=>c.sql.includes('INSERT INTO copy_execution_evidence'))!;
    expect(evidence.values).toEqual([EXECUTION,'paper_simulation','inert-copy-evidence','1.25','2.5','2.5','USD','1','2',
      'finalized',true,new Date(OBSERVED),new Date(OBSERVED),'0.000001']);
    const immutable=h.calls.find(c=>c.sql.includes(' AS payload_matches'))!;
    expect(immutable.sql).toContain('fee_usd IS NOT DISTINCT FROM $12::numeric');
    expect(immutable.values.at(-1)).toBe('0.000001');
    expect(h.calls.some(c=>c.sql.includes('INSERT INTO copy_position_applications'))).toBe(true);
    const lot=h.calls.find(c=>c.sql.includes('INSERT INTO copy_position_master_lot_reductions'))!;
    expect(lot.values).toEqual([LOT,EXECUTION,RECORD,'1.25','2.5',new Date(OBSERVED),POSITION,USER,'1.25']);
    expect(h.calls.some(c=>c.sql.includes('UPDATE copy_position_master_lots lot'))).toBe(true);
    expect(h.calls.filter(c=>c.sql.includes('WITH RECURSIVE ordered_events'))).toHaveLength(2);
    expect(h.calls.some(c=>c.sql.includes('INSERT INTO copy_execution_state_history'))).toBe(true);
    expect(h.calls.at(-1)?.values).toEqual([USER,q.receipt.receiptId,RECORD,h.reference,beforeDigits,afterDigits]);
    expect(h.calls.some(c=>/^\s*(BEGIN|COMMIT|ROLLBACK|GRANT|ALTER|SET ROLE)\b/.test(c.sql))).toBe(false);
  });
  it('canonical transport preserves large exact money and base above 18 decimals without rounding',async()=>{
    const q=spot(),h=spotTransport(q,'9007199254740993000002.00000000000000000000','1.00000000000000000000','0.000001');
    const result=await createWave4SpotSettler()(h.client,q.record,q.receipt,q.delta,q.fee);
    expect(result.beforeRaw).toBe('9007199254740993000002');expect(result.afterRaw).toBe('1');
    const evidence=h.calls.find(c=>c.sql.includes('INSERT INTO copy_execution_evidence'))!;
    expect(evidence.values[3]).toBe('9007199254740993.000001');expect(evidence.values[4]).toBe('18014398509481986.000002');
    const tiny=rebaseSpot(spot(),'1','0.0000000000000000001',19,'10','0.000000000000000001','1',18);
    const transport=spotTransport(tiny,'2.00000000000000000000','1.00000000000000000000','0.0000000000000000001');
    expect((await createWave4SpotSettler()(transport.client,tiny.record,tiny.receipt,tiny.delta,tiny.fee)).afterRaw).toBe('1');
    expect(transport.calls.find(c=>c.sql.includes('INSERT INTO copy_execution_evidence'))?.values[3]).toBe('0.0000000000000000001');
  });
  it.each(['2500000.00000000000000000001','-2500000','-0.0000','NaN','Infinity','-Infinity','2.5e6',' 2500000',
    '02500000','2500000.',`${'9'.repeat(79)}.0000`])('rejects nonintegral/negative/nonfinite/out-of-domain before_raw %s before canonical writes',async before=>{
    const q=rebaseSpot(spot(),'1250000','1.25'),h=spotTransport(q,before);
    await expect(createWave4SpotSettler()(h.client,q.record,q.receipt,q.delta,q.fee)).rejects.toThrow();
    expect(h.calls.some(c=>/^\s*(INSERT|UPDATE)\b/.test(c.sql))).toBe(false);
    expect(h.calls.some(c=>/^\s*(COMMIT|ROLLBACK)\b/.test(c.sql))).toBe(false);
  });
  it.each(['1250000.00000000000000000001','-1250000','-0.0000','NaN','Infinity','-Infinity','1.25e6',' 1250000',
    '01250000','1250000.',`${'9'.repeat(79)}.0000`,'1250001.00000000000000000000'])
    ('withholds settlement on hostile after_raw %s; canonical effects require caller rollback',async after=>{
      const q=rebaseSpot(spot(),'1250000','1.25'),h=spotTransport(q,undefined,after);
      await expect(createWave4SpotSettler()(h.client,q.record,q.receipt,q.delta,q.fee)).rejects.toThrow();
      expect(h.calls.some(c=>c.sql.includes('INSERT INTO copy_execution_evidence'))).toBe(true);
      expect(h.calls.some(c=>c.sql.includes('UPDATE copy_position_master_lots lot'))).toBe(true);
      expect(h.calls.some(c=>c.sql.includes('INSERT INTO public.wave4_spot_settlements089'))).toBe(false);
      expect(h.calls.some(c=>/^\s*(COMMIT|ROLLBACK)\b/.test(c.sql))).toBe(false);
    });
  it('rejects insufficient before raw and mismatched exact evidence base before canonical writes',async()=>{
    const q=rebaseSpot(spot(),'1250000','1.25'),h=spotTransport(q,'1249999.0000');
    await expect(createWave4SpotSettler()(h.client,q.record,q.receipt,q.delta,q.fee)).rejects.toThrow('before-insufficient-raw');
    expect(h.calls.some(c=>/^\s*(INSERT|UPDATE)\b/.test(c.sql))).toBe(false);
    q.input={...q.input,evidence:{...q.input.evidence,baseQuantity:'1.250001'}};
    const mismatch=spotTransport(q);
    await expect(createWave4SpotSettler()(mismatch.client,q.record,q.receipt,q.delta,q.fee)).rejects.toThrow('base-delta-mismatch');
    expect(mismatch.calls.some(c=>/^\s*(INSERT|UPDATE)\b/.test(c.sql))).toBe(false);
  });
  it.each(['fee-precision','price-precision','quote-precision','decimal-zero-base','decimal-zero-price','decimal-zero-quote','null-fee'] as const)
    ('rejects persisted %s evidence before any canonical mutation',async mode=>{
      const q=rebaseSpot(spot(),'1250000','1.25');
      if(mode==='fee-precision') q.input={...q.input,evidence:{...q.input.evidence,feeUsd:'0.0000000000000000001'}};
      if(mode==='price-precision') q.input={...q.input,evidence:{...q.input.evidence,priceUsd:'0.0000000000000000001'}};
      if(mode==='quote-precision') q.input={...q.input,evidence:{...q.input.evidence,quoteLeg:{amount:'0.0000000000000000001',currency:'USD'}}};
      if(mode==='decimal-zero-base') q.input={...q.input,evidence:{...q.input.evidence,baseQuantity:'0.000000000000000000'}};
      if(mode==='decimal-zero-price') q.input={...q.input,evidence:{...q.input.evidence,priceUsd:'0.000000000000000000'}};
      if(mode==='decimal-zero-quote') q.input={...q.input,evidence:{...q.input.evidence,quoteLeg:{amount:'0.000000000000000000',currency:'USD'}}};
      if(mode==='null-fee') q.input={...q.input,evidence:{...q.input.evidence,feeUsd:null} as any};
      const h=spotTransport(q);
      await expect(createWave4SpotSettler()(h.client,q.record,q.receipt,q.delta,q.fee)).rejects.toThrow();
      expect(h.calls.some(c=>/^\s*(INSERT|UPDATE)\b/.test(c.sql))).toBe(false);
    });
  it('canonical transport keeps known fee zero and unknown lot basis distinct',async()=>{
    const q=rebaseSpot(spot(),'1250000','1.25');q.fee='0';q.receipt={...q.receipt,feeRaw:'0'};
    q.input={...q.input,evidence:{...q.input.evidence,feeUsd:'0.000000000000000000'},
      economics:{...q.input.economics,feeRaw:'0',feeUsd:'0',feeUnitUsd:'1'}};
    const h=spotTransport(q);await createWave4SpotSettler()(h.client,q.record,q.receipt,q.delta,q.fee);
    expect(h.calls.find(c=>c.sql.includes('INSERT INTO copy_execution_evidence'))?.values.at(-1)).toBe('0.000000000000000000');
    expect(h.calls.find(c=>c.sql.includes('UPDATE copy_position_master_lots lot'))?.sql).toContain('WHEN lot.remaining_cost_basis_usd IS NULL THEN NULL');
  });
  it('withholds canonical return on immutable mismatch, missing after row or final settlement insert failure; never owns rollback',async()=>{
    for(const mode of ['immutable','missing-after','duplicate-after','settlement-insert']) {
      const q=rebaseSpot(spot(),'1250000','1.25'),h=spotTransport(q);
      if(mode==='immutable')h.state.payloadMatches=false;
      if(mode==='missing-after')h.state.afterRows=0;
      if(mode==='duplicate-after')h.state.afterRows=2;
      if(mode==='settlement-insert')h.state.failSettlement=true;
      await expect(createWave4SpotSettler()(h.client,q.record,q.receipt,q.delta,q.fee)).rejects.toThrow();
      expect(h.calls.some(c=>c.sql.includes('INSERT INTO copy_execution_evidence'))).toBe(true);
      if(mode!=='settlement-insert') expect(h.calls.some(c=>c.sql.includes('INSERT INTO public.wave4_spot_settlements089'))).toBe(false);
      expect(h.calls.some(c=>/^\s*(COMMIT|ROLLBACK)\b/.test(c.sql))).toBe(false);
    }
  });
  it('withdrawal canonical account journal SOURCE-refuses, never casts it into a copy lot exit',async()=>{
    const h=harness();
    await expect(refuseWave4WithdrawalAccountingWithClient(h.client,{} as FinancialRecord<WithdrawalIntent>))
      .rejects.toThrow('canonical-withdrawal-account-journal-unavailable');
    expect(h.query).not.toHaveBeenCalled();
  });
});
