import { pipelineCheck, pipelineCanonical, exactPipelineDecimal, pipelineExactText,
  type ExecutedPipelineScope, type ExecutedPipelineStage, type ExecutedPipelineSnapshot,
  type PipelineSqlRow, type ExecutedSource, type ExecutedExecution, type ExecutedOriginalEvidence,
  type ExecutedEffectiveEvidence } from './pipeline-economics.js';

export interface PipelineObserverQueryResult {
  readonly command: string; readonly rows: readonly Record<string, unknown>[];
}
export interface PipelineObserverClient {
  query(sql: string, values?: readonly unknown[]): Promise<PipelineObserverQueryResult>;
}
export interface PipelineObserverLease { readonly client: PipelineObserverClient; release(broken: boolean): void }
export interface PipelineSqlObserverInput {
  /** Physical reader backend, NOT writer transaction callback or snapshot certifier. */
  readonly acquire: () => Promise<PipelineObserverLease>;
  readonly role?: string; readonly maximumRows?: number;
}
export const PIPELINE_OBSERVER_TABLES = Object.freeze([
  'source_trades','source_provider_authorities','source_verification_bindings','source_verified_evidence',
  'source_verification_heads','source_verification_history','source_position_economic_history',
  'source_position_applications','source_verified_position_scopes','wallet_positions','signals',
  'source_fanout_batches','source_fanout_deliveries','copy_executions','copy_execution_policy_snapshots',
  'copy_execution_worker_attempts','worker_runtime_capabilities','copy_execution_evidence',
  'worker_effective_execution_evidence','worker_valuation_authorities','trusted_worker_valuations',
  'copy_execution_valuation_corrections','copy_execution_financial_receipts','trades',
  'copy_position_applications','copy_positions','copy_position_master_lots','copy_position_master_lot_reductions',
  'source_sell_lot_allocations','risk_policy_control','risk_spend_reservations','master_capacity_ledger',
  'pipeline_paper_valuation_evidence','pipeline_worker_paper_receipts'
]);
/** SQL088 does not author protected observer enrollment or scoped reader RLS.
 * No role name or caller DTO is an independent run/backend/scope authority. */
export const PIPELINE_SQL_OBSERVER_SOURCE_BLOCKERS = Object.freeze([
  'Independent persisted exact run/backend/namespace/asset observer enrollment and scoped read policies are absent from SQL088',
  'No approved observer privilege for SQL080 worker_correction_authorized is supplied; function results never mint correction authority'
]);
export const PIPELINE_OBSERVER_IDENTITY_SQL = `SELECT current_user::text AS role,session_user::text AS session,
  current_setting('role') AS role_setting,current_setting('row_security') AS row_security,
  current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,
  COALESCE(current_setting('app.bypass_rls',true),'off') AS bypass,
  COALESCE(current_setting('app.current_user_id',true),'') AS tenant,
  COALESCE(current_setting('app.worker_execution_id',true),'') AS worker,
  r.rolcanlogin,r.rolsuper,r.rolbypassrls,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
  EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS memberships,
  EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner=r.oid) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=r.oid) AS owns_objects,
  has_database_privilege(r.oid,current_database(),'CREATE') OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace
    WHERE has_schema_privilege(r.oid,oid,'CREATE')) AS can_create,
  EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','v','m','f')
      AND (has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
        OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE'))) AS can_write,
  EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname<>'worker_correction_authorized'
      AND has_function_privilege(r.oid,p.oid,'EXECUTE')) AS other_public_function,
  pg_backend_pid() AS backend_pid,statement_timestamp() AS observed_at,
  current_setting('search_path') AS search_path
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`;
function normalize(value: unknown): unknown {
  if(value instanceof Date) { pipelineCheck(Number.isFinite(value.getTime()),'invalid SQL timestamp'); return value.toISOString(); }
  if(Array.isArray(value)) return value.map(normalize);
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v)]));
  return value;
}
function scopeCopy(input: ExecutedPipelineScope): ExecutedPipelineScope {
  pipelineCanonical(input);
  pipelineCheck(input.chain==='solana' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.runId)
    && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.userId)
    && input.network===`solana:wave4-${input.runId}` && input.namespace===`wave4/${input.runId}/pipeline`
    && [input.tokenMint,input.targetAccount,input.masterWalletAddress].every(x=>/^solana:[^\s:]+$/.test(x)),
  'observer bounded run/asset/account namespace required');
  return Object.freeze({...input});
}
/** Exported for hostile inert SQL-response tests only. It grants no reader,
 * transaction, runtime capability, sourceComplete or acceptance status. */
export function requirePipelineObserverIdentity(rows: readonly Record<string, unknown>[], role: string, transactional: boolean): number {
  const r=rows[0];
  pipelineCheck(rows.length===1 && r && r.role===role && r.session===role && r.role_setting==='none'
    && r.row_security==='on' && r.bypass==='off' && r.tenant==='' && r.worker==='' && r.rolcanlogin===true
    && ['rolsuper','rolbypassrls','rolinherit','rolcreaterole','rolcreatedb','rolreplication','memberships','owns_objects','can_create','can_write','other_public_function']
      .every(k=>r[k]===false) && (!transactional || r.read_only==='on' && r.isolation==='repeatable read')
    && ['pg_catalog, public','pg_catalog,public'].includes(r.search_path as string)
    && Number.isInteger(r.backend_pid) && (r.backend_pid as number)>0,'independent direct read-only observer identity unavailable');
  return r.backend_pid as number;
}
export function requirePipelineObserverEnrollment(): never {
  throw new Error(`Independent SQL observer SOURCE refusal: ${PIPELINE_SQL_OBSERVER_SOURCE_BLOCKERS.join('; ')}`);
}
const leases=new WeakSet<object>();
/** Owns every physical BEGIN/query/COMMIT/release. SELECT-only repeatable-read
 * scans are not delegated to arbitrary observation callbacks. Broad asset OR
 * discovered immutable IDs preserve unexpected tenants and dangling links;
 * LEFT joins retain malformed rows instead of inner-join-hiding them. */
export function createPipelineSqlObserver(input: PipelineSqlObserverInput) {
  pipelineCheck(input && typeof input.acquire==='function','independent physical observer lease required');
  const acquire=input.acquire, role=input.role??'swat_pipeline_observer',maximumRows=input.maximumRows??1000;
  pipelineCheck(/^swat_[a-z_]{1,64}$/.test(role) && !['swat_app','swat_migrator','swat_fanout','swat_runtime_lookup'].includes(role)
    && Number.isSafeInteger(maximumRows) && maximumRows>0 && maximumRows<=10000,'independent observer role/bound required');
  return Object.freeze({
    async observe(candidate: ExecutedPipelineScope, stage: ExecutedPipelineStage): Promise<ExecutedPipelineSnapshot> {
      const scope=scopeCopy(candidate);
      pipelineCheck(['buy','sell','reversal','correction','replay'].includes(stage),'observer stage required');
      // The namespace is a comparison target, not read authority. No approved
      // persisted observer enrollment API exists in SQL071080/088, so refuse
      // before acquiring a client. The SQL graph below is reserved source until
      // the separate observer owner authors an audited enrollment composition.
      requirePipelineObserverEnrollment();
      const lease=await acquire();
      pipelineCheck(lease?.client && typeof lease.client.query==='function' && typeof lease.release==='function','physical observer lease unavailable');
      pipelineCheck(!leases.has(lease.client),'observer writer/reentrant backend reuse'); leases.add(lease.client);
      let open=false,committing=false,broken=false;
      try {
        const pid=requirePipelineObserverIdentity((await lease.client.query(PIPELINE_OBSERVER_IDENTITY_SQL)).rows,role,false);
        const begin=await lease.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        pipelineCheck(begin.command==='BEGIN','observer BEGIN refused'); open=true;
        await lease.client.query("SELECT set_config('statement_timeout','15000',true),set_config('lock_timeout','5000',true),set_config('idle_in_transaction_session_timeout','30000',true)");
        pipelineCheck(requirePipelineObserverIdentity((await lease.client.query(PIPELINE_OBSERVER_IDENTITY_SQL)).rows,role,true)===pid,'observer backend drift');
        const catalog=await lease.client.query(`SELECT requested.name,c.oid::text,c.relrowsecurity,c.relforcerowsecurity,
          has_table_privilege(current_user,c.oid,'SELECT') AS readable,
          c.relkind FROM unnest($1::text[]) requested(name)
          LEFT JOIN pg_catalog.pg_class c ON c.oid=to_regclass('public.'||requested.name)`,[PIPELINE_OBSERVER_TABLES]);
        pipelineCheck(catalog.rows.length===PIPELINE_OBSERVER_TABLES.length
          && new Set(catalog.rows.map(r=>r.name)).size===PIPELINE_OBSERVER_TABLES.length
          && catalog.rows.every(r=>PIPELINE_OBSERVER_TABLES.includes(r.name as typeof PIPELINE_OBSERVER_TABLES[number])
            && r.readable===true && typeof r.oid==='string'),
        'observer committed canonical schema/full-scope read privilege or RLS backing absent');
        const q=async(sql:string,values:readonly unknown[],decimals:readonly string[]=[]):Promise<PipelineSqlRow[]>=>{
          pipelineCheck(/^SELECT\b/.test(sql) && !/\bSUM\s*\(/i.test(sql),'observer must fold economics independently');
          const result=await lease.client.query(`${sql} LIMIT $${values.length+1}`,[...values,maximumRows+1]);
          pipelineCheck(result.command==='SELECT' && result.rows.length<=maximumRows,'observer scan truncation/overflow refused');
          return result.rows.map(row=>{
            const output=normalize(row) as Record<string,unknown>;
            for(const key of decimals) if(output[key]!==null && output[key]!==undefined) {
              pipelineCheck(typeof output[key]==='string',`SQL exact ${key} must be text`);
              output[key]=pipelineExactText(exactPipelineDecimal(output[key] as string));
            }
            pipelineCanonical(output);return output;
          });
        };
        const sources=await q(`SELECT s.id,s.chain,s.wallet_address AS "walletAddress",s.token_mint AS "tokenMint",s.direction,
          s.token_amount::text AS quantity,s.amount_usd::text AS "amountUsd",s.price_usd::text AS "priceUsd",s.fee_usd::text AS "feeUsd",
          s.event_at AS "eventAt",s.confirmation_state AS "confirmationState",b.binding,b.binding_digest AS "bindingDigest",
          h.evidence_id AS "headEvidenceId",h.revision::text AS "headRevision",h.confirmation_state AS "headState",a.active AS "applicationActive"
          FROM public.source_trades s LEFT JOIN public.source_verification_bindings b ON b.source_trade_id=s.id
          LEFT JOIN public.source_verification_heads h ON h.source_trade_id=s.id
          LEFT JOIN public.source_position_applications a ON a.source_trade_id=s.id
          WHERE s.source_event_id LIKE $1 OR s.token_mint=$2 OR b.network=$3 ORDER BY s.event_at,s.id`,
        [`${scope.namespace}/%`,scope.tokenMint,scope.network],['quantity','amountUsd','priceUsd','feeUsd']) as unknown as ExecutedSource[];
        const sourceIds=sources.map(s=>s.id);
        const executions=await q(`SELECT e.id,e.signal_id AS "signalId",e.source_trade_id AS "sourceTradeId",e.user_id AS "userId",e.chain,
          e.target_account AS "targetAccount",e.token_mint AS "tokenMint",e.execution_mode AS "executionMode",e.direction,e.state,
          e.client_order_id AS "clientOrderId",e.requested_base_quantity::text AS "requestedBase",e.requested_quote_quantity::text AS "requestedQuote",
          e.confirmed_base_quantity::text AS "confirmedBase",e.confirmed_quote_quantity::text AS "confirmedQuote",
          e.quote_unassessed_fill_count::text AS "quoteUnknown",e.source_position_before_quantity::text AS "sourcePositionBefore",
          e.source_sell_fraction::text AS "sourceSellFraction" FROM public.copy_executions e
          WHERE e.token_mint=$1 OR e.source_trade_id=ANY($2::uuid[]) ORDER BY e.id`,[scope.tokenMint,sourceIds],
        ['requestedBase','requestedQuote','confirmedBase','confirmedQuote','sourcePositionBefore','sourceSellFraction']) as unknown as ExecutedExecution[];
        const ids=executions.map(e=>e.id);
        const signals=await q(`SELECT id,source_trade_id,chain,token_mint,direction,source_position_before_quantity::text,source_sell_fraction::text
          FROM public.signals WHERE token_mint=$1 OR source_trade_id=ANY($2::uuid[]) OR id=ANY($3::uuid[]) ORDER BY id`,
        [scope.tokenMint,sourceIds,executions.map(e=>e.signalId).filter(Boolean)],['source_position_before_quantity','source_sell_fraction']);
        const signalIds=signals.map(s=>s.id);
        const sourceBindings=await q(`SELECT source_trade_id,binding,binding_digest,network,raw_quantity,quantity_scale
          FROM public.source_verification_bindings WHERE source_trade_id=ANY($1::uuid[]) OR network=$2 ORDER BY source_trade_id`,[sourceIds,scope.network]);
        const sourceEvidence=await q(`SELECT evidence_id,source_trade_id,binding_digest,evidence_digest,provider_id,authority_id,
          provider_identity_digest,provider_valid_until,verifier_version,finality,revision::text,reverses_evidence_id,evidence
          FROM public.source_verified_evidence WHERE source_trade_id=ANY($1::uuid[]) ORDER BY source_trade_id,revision`,[sourceIds]);
        const providers=await q(`SELECT authority_id,provider_id,chain,network,verifier_version,identity_digest,valid_until,enabled
          FROM public.source_provider_authorities WHERE network=$1 OR authority_id=ANY($2::text[]) ORDER BY authority_id`,
        [scope.network,sourceEvidence.map(r=>r.authority_id)]);
        const sourceHeads=await q(`SELECT source_trade_id,evidence_id,revision::text,confirmation_state FROM public.source_verification_heads
          WHERE source_trade_id=ANY($1::uuid[]) ORDER BY source_trade_id`,[sourceIds]);
        const sourceHistory=await q(`SELECT id::text,source_trade_id,evidence_id,from_state,to_state,applied,recorded_at
          FROM public.source_verification_history WHERE source_trade_id=ANY($1::uuid[]) ORDER BY id`,[sourceIds]);
        const sourceEconomicHistory=await q(`SELECT id::text,source_trade_id,evidence_id,snapshot,recorded_at
          FROM public.source_position_economic_history WHERE source_trade_id=ANY($1::uuid[]) ORDER BY id`,[sourceIds]);
        const sourceApplications=await q(`SELECT source_trade_id,wallet_address,chain,token_mint,active FROM public.source_position_applications
          WHERE source_trade_id=ANY($1::uuid[]) OR token_mint=$2 ORDER BY source_trade_id`,[sourceIds,scope.tokenMint]);
        const sourceScopes=await q(`SELECT wallet_address,chain,token_mint,network,quantity_scale,unvalued_acquisition_count::text
          FROM public.source_verified_position_scopes WHERE token_mint=$1 OR network=$2 ORDER BY wallet_address,chain,token_mint`,[scope.tokenMint,scope.network]);
        const sourcePositions=await q(`SELECT wallet_address,chain,token_mint,balance::text,cost_basis_usd::text,opening_balance::text,
          opening_cost_basis_usd::text,total_acquired_quantity::text,total_reduced_quantity::text,unmatched_reduction_quantity::text
          FROM public.wallet_positions WHERE token_mint=$1 ORDER BY wallet_address,chain,token_mint`,[scope.tokenMint],
        ['balance','cost_basis_usd','opening_balance','opening_cost_basis_usd','total_acquired_quantity','total_reduced_quantity','unmatched_reduction_quantity']);
        const batches=await q(`SELECT signal_id,source_trade_id,state,fence::text,recipient_snapshot,exclusion_snapshot
          FROM public.source_fanout_batches WHERE signal_id=ANY($1::uuid[]) OR source_trade_id=ANY($2::uuid[]) ORDER BY signal_id`,[signalIds,sourceIds]);
        const deliveries=await q(`SELECT signal_id,user_id,execution_mode,target_account,job_id,descriptor,state,fence::text,execution_id
          FROM public.source_fanout_deliveries WHERE execution_id=ANY($1::uuid[]) OR signal_id=ANY($2::uuid[])
          OR descriptor->'data'->>'tokenMint'=$3 ORDER BY signal_id,job_id`,[ids,signalIds,scope.tokenMint]);
        const policies=await q(`SELECT execution_id,user_id,chain,target_account,token_mint,master_wallet_address,execution_mode,snapshot,minimum_score::text
          FROM public.copy_execution_policy_snapshots WHERE execution_id=ANY($1::uuid[]) OR token_mint=$2 ORDER BY execution_id`,[ids,scope.tokenMint],['minimum_score']);
        const attempts=await q(`SELECT execution_id,user_id,policy_revision,risk_epoch::text,fence::text,state FROM public.copy_execution_worker_attempts
          WHERE execution_id=ANY($1::uuid[]) ORDER BY execution_id`,[ids]);
        const capabilities=await q(`SELECT capability_id,revision,execution_id,runtime_role::text,database_oid::text,server_address,server_port,
          backend_identity,valid_from,expires_at,revoked_at FROM public.worker_runtime_capabilities WHERE execution_id=ANY($1::uuid[]) ORDER BY execution_id`,[ids]);
        const originals=await q(`SELECT f.id,f.execution_id AS "executionId",e.user_id AS "userId",e.source_trade_id AS "sourceTradeId",
          f.evidence_type AS "evidenceType",f.evidence_id AS "evidenceId",f.base_quantity::text AS base,f.quote_quantity::text AS quote,
          f.quote_native_quantity::text AS "nativeQuote",f.quote_currency AS "quoteCurrency",f.quote_native_usd_price::text AS "nativePrice",
          f.price_usd::text AS price,f.fee_usd::text AS fee,f.occurred_at AS "occurredAt",f.completes_execution AS completes,
          f.confirmation_state AS "confirmationState" FROM public.copy_execution_evidence f LEFT JOIN public.copy_executions e ON e.id=f.execution_id
          WHERE f.execution_id=ANY($1::uuid[]) ORDER BY f.occurred_at,f.id`,[ids],['base','quote','nativeQuote','nativePrice','price','fee']) as unknown as ExecutedOriginalEvidence[];
        const effective=await q(`SELECT id,execution_id AS "executionId",base_quantity::text AS base,effective_quote_usd::text AS quote,
          effective_fee_usd::text AS fee,valuation_correction_id AS "correctionId",confirmation_state AS "confirmationState"
          FROM public.worker_effective_execution_evidence WHERE execution_id=ANY($1::uuid[]) ORDER BY occurred_at,id`,[ids],['base','quote','fee']) as unknown as ExecutedEffectiveEvidence[];
        const valuationAuthorities=await q(`SELECT authority_id,user_id,chain,network,provider_id,identity_digest,verifier_version,enabled,valid_until,
          max_quote_usd::text,max_fee_usd::text FROM public.worker_valuation_authorities WHERE network=$1 OR user_id=$2 ORDER BY authority_id`,
        [scope.network,scope.userId],['max_quote_usd','max_fee_usd']);
        const trustedValuations=await q(`SELECT valuation_id,authority_id,original_evidence_id,execution_id,user_id,source_evidence_id,lineage_source_trade_id,
          lineage_acquisition_evidence_id,lineage_master_wallet_address,original_digest,provider_id,provider_identity_digest,verifier_version,
          revision::text,quote_usd::text,fee_usd::text,valid_until FROM public.trusted_worker_valuations
          WHERE execution_id=ANY($1::uuid[]) OR lineage_source_trade_id=ANY($2::uuid[]) ORDER BY original_evidence_id,revision`,[ids,sourceIds],['quote_usd','fee_usd']);
        const corrections=await q(`SELECT correction_id,valuation_id,original_evidence_id,execution_id,user_id,original_digest,original_snapshot,
          revision::text,previous_correction_id,effective_quote_usd::text,effective_fee_usd::text,lineage_source_trade_id,
          lineage_acquisition_evidence_id,lineage_master_wallet_address,quote_origin_valuation_id,fee_origin_valuation_id,
          public.worker_correction_authorized(correction_id) AS authorized FROM public.copy_execution_valuation_corrections
          WHERE execution_id=ANY($1::uuid[]) OR lineage_source_trade_id=ANY($2::uuid[]) ORDER BY original_evidence_id,revision`,[ids,sourceIds],['effective_quote_usd','effective_fee_usd']);
        const financialReceipts=await q(`SELECT receipt_id,execution_id,user_id,trade_id,worker_fence::text,accounting_complete,snapshot
          FROM public.copy_execution_financial_receipts WHERE execution_id=ANY($1::uuid[]) ORDER BY receipt_id`,[ids]);
        const trades=await q(`SELECT id,copy_execution_id,signal_id,source_trade_id,user_id,token_mint,chain,direction,execution_mode,
          token_amount::text,amount_usd::text,fee_usd::text,status FROM public.trades
          WHERE token_mint=$1 OR copy_execution_id=ANY($2::uuid[]) OR source_trade_id=ANY($3::uuid[]) ORDER BY id`,[scope.tokenMint,ids,sourceIds],['token_amount','amount_usd','fee_usd']);
        const applications=await q(`SELECT evidence_id,execution_id,position_id,user_id,target_account,chain,token_mint,active FROM public.copy_position_applications
          WHERE execution_id=ANY($1::uuid[]) OR token_mint=$2 ORDER BY evidence_id`,[ids,scope.tokenMint]);
        const positions=await q(`SELECT id,user_id,target_account,chain,token_mint,confirmed_quantity::text,cost_basis_usd::text,
          opening_quantity::text,opening_cost_basis_usd::text,cost_basis_unvalued_fill_count::text,reserved_sell_quantity::text
          FROM public.copy_positions WHERE token_mint=$1 ORDER BY id`,[scope.tokenMint],
        ['confirmed_quantity','cost_basis_usd','opening_quantity','opening_cost_basis_usd','reserved_sell_quantity']);
        const lots=await q(`SELECT id,position_id,user_id,master_wallet_address,chain,token_mint,signal_id,source_trade_id,acquisition_execution_id,
          acquisition_evidence_id,acquired_quantity::text,reduced_quantity::text,remaining_quantity::text,acquired_cost_basis_usd::text,
          remaining_cost_basis_usd::text FROM public.copy_position_master_lots
          WHERE token_mint=$1 OR acquisition_execution_id=ANY($2::uuid[]) OR position_id=ANY($3::uuid[]) ORDER BY id`,
        [scope.tokenMint,ids,positions.map(r=>r.id)],['acquired_quantity','reduced_quantity','remaining_quantity','acquired_cost_basis_usd','remaining_cost_basis_usd']);
        const reductions=await q(`SELECT r.id,r.lot_id,r.sell_execution_id,r.sell_evidence_id,r.quantity::text,r.proceeds_usd::text,
          l.user_id,l.chain,l.token_mint,l.master_wallet_address FROM public.copy_position_master_lot_reductions r
          LEFT JOIN public.copy_position_master_lots l ON l.id=r.lot_id
          WHERE r.sell_execution_id=ANY($1::uuid[]) OR r.lot_id=ANY($2::uuid[]) ORDER BY r.id`,[ids,lots.map(r=>r.id)],['quantity','proceeds_usd']);
        const allocations=await q(`SELECT execution_id,lot_id,ordinal,user_id,chain,target_account,token_mint,master_wallet_address,execution_mode,
          requested_quantity::text,acquisition_execution_id,acquisition_evidence_id,acquisition_source_trade_id
          FROM public.source_sell_lot_allocations WHERE execution_id=ANY($1::uuid[]) OR token_mint=$2 OR lot_id=ANY($3::uuid[])
          ORDER BY execution_id,ordinal`,[ids,scope.tokenMint,lots.map(r=>r.id)],['requested_quantity']);
        const riskPolicies=await q(`SELECT account,chain,execution_mode,epoch::text,enabled,cap_usd::text,accounting_ready FROM public.risk_policy_control
          WHERE account=$1 ORDER BY account,chain,execution_mode`,[scope.userId],['cap_usd']);
        const risk=await q(`SELECT account,chain,execution_mode,execution_id,policy_epoch::text,requested_usd::text,confirmed_usd::text,liability_usd::text,state,
          valuation_correction_id FROM public.risk_spend_reservations WHERE execution_id=ANY($1::uuid[]) OR account=$2
          ORDER BY account,chain,execution_mode,execution_id`,[ids,scope.userId],['requested_usd','confirmed_usd','liability_usd']);
        const capacity=await q(`SELECT source_trade_id,execution_mode,master_wallet_address,chain,token_mint,notional_usd::text,notional_basis,
          unassessed_fill_count::text FROM public.master_capacity_ledger WHERE token_mint=$1 OR source_trade_id=ANY($2::uuid[])
          ORDER BY source_trade_id,execution_mode`,[scope.tokenMint,sourceIds],['notional_usd']);
        // SQL088 names are a source dependency. Catalog failure above refuses,
        // rather than substituting shaped fixture rows or a protected callback.
        const paperValuationRows=await q(`SELECT execution_id,evidence FROM public.pipeline_paper_valuations
          WHERE execution_id=ANY($1::uuid[]) OR evidence->>'tokenMint'=$2 ORDER BY execution_id`,[ids,scope.tokenMint]);
        const paperReceiptRows=await q(`SELECT execution_id,worker_fence::text,receipt FROM public.pipeline_worker_paper_receipts
          WHERE execution_id=ANY($1::uuid[]) OR receipt->>'tokenMint'=$2 ORDER BY execution_id,worker_fence`,[ids,scope.tokenMint]);
        const paperValuations=paperValuationRows.map(r=>{
          const v=r.evidence as PipelineSqlRow;pipelineCheck(v && v.executionId===r.execution_id,'paper valuation columns differ from immutable evidence');return v;
        });
        const paperReceipts=paperReceiptRows.map(r=>{
          const v=r.receipt as PipelineSqlRow;pipelineCheck(v && v.executionId===r.execution_id && v.workerFence===r.worker_fence,
          'paper receipt columns differ from immutable receipt');return v;
        });
        const snapshot:ExecutedPipelineSnapshot={stage,sources,executions,originals,effective,providers,sourceBindings,sourceEvidence,sourceHeads,
          sourceHistory,sourceEconomicHistory,sourceApplications,sourceScopes,sourcePositions,signals,batches,deliveries,policies,attempts,capabilities,
          paperValuations,paperReceipts,valuationAuthorities,trustedValuations,corrections,financialReceipts,trades,applications,positions,lots,reductions,
          allocations,riskPolicies,risk,capacity};
        pipelineCheck(requirePipelineObserverIdentity((await lease.client.query(PIPELINE_OBSERVER_IDENTITY_SQL)).rows,role,true)===pid,
          'observer authority/backend drift');
        committing=true;const commit=await lease.client.query('COMMIT');
        pipelineCheck(commit.command==='COMMIT','observer COMMIT uncertain; no committed snapshot published');
        open=false;committing=false;return snapshot;
      } catch(error) {
        broken=true;
        if(open&&!committing) { try { await lease.client.query('ROLLBACK'); } catch { /* reader destroyed, no snapshot exposed */ } }
        throw error;
      } finally { leases.delete(lease.client);lease.release(broken||open); }
    }
  });
}
