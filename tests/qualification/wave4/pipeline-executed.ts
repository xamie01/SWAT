import { AsyncLocalStorage } from 'node:async_hooks';
import { createProtectedPipelineSource, type PipelineClientLease, type PoolClient } from '../../../packages/db/src/wave4-pipeline-source-owned.js';
import { createProtectedPipelineFanout, type ProtectedPipelineFanoutPorts } from '../../../apps/signal-engine/src/wave4-pipeline-protected-composition.js';
import { createProtectedPipelineWorkerComposition, type ProtectedPipelineWorkerInput } from '../../../apps/trade-executor/src/wave4-pipeline-protected-composition.js';
import type { SourceTradeEventInput, CopyExecutionRecord } from '../../../packages/db/src/copy-trade-lifecycle-owned.js';
import type { SourceVerificationEvidence } from '../../../packages/db/src/source-verification.js';
import type { PipelineWorkerCapabilityRegistration } from '../../../packages/db/src/wave4-pipeline-capability-owned.js';
import type { PipelineRiskPolicyWrite } from '../../../packages/db/src/wave4-pipeline-risk-owned.js';
import type { PipelineValuationAuthority, PipelineTrustedWorkerValuation } from '../../../packages/db/src/wave4-pipeline-valuation-owned.js';
import type { WorkerValuationSettlement } from '../../../packages/db/src/worker-settlement.js';
import type { WorkerAttempt } from '../../../packages/db/src/worker-execution.js';
import { pipelineReceiptEvidence } from '../../../packages/db/src/wave4-pipeline-receipt-owned.js';
import type { FanoutJobPlan, FanoutTradeQueue, FanoutJobDescriptor } from '../../../apps/signal-engine/src/fanout-enqueue.js';
import type { SignalTradeEligibility } from '../../../apps/signal-engine/src/trade-eligibility.js';
import { createPipelineSqlObserver, type PipelineSqlObserverInput } from './pipeline-sql-observer.js';
import { pipelineCheck, pipelineCanonical, pipelineEqual, exactPipelineDecimal, pipelineExactText,
  reconcileExecutedPipelineJournal, createPipelineLifetime,
  type ExecutedPipelineScope, type ExecutedPipelineJournal, type ExecutedPipelineSnapshot,
  type ExecutedExecution, type ExecutedOriginalEvidence, type PipelineSqlRow } from './pipeline-economics.js';

export const EXECUTED_PIPELINE_SOURCE_STATUS = Object.freeze({ sourceComplete:false,runtimeAccepted:false,
  liveCapabilityAccepted:false,publicExercisePaperPipelineEnabled:false });
export interface ExecutedPipelineSignalTerms {
  readonly confidence:number;readonly signalScore:number;readonly triggerData:Record<string,unknown>;
  readonly maxEventAgeMs:number;readonly maxPositionEvidenceAgeMs:number;
}
export interface ExecutedPipelineStep {
  readonly event:SourceTradeEventInput;readonly evidence:SourceVerificationEvidence;
  readonly signal:ExecutedPipelineSignalTerms;readonly eligibility:SignalTradeEligibility;readonly poolTvlUsd:number|null;
  /** Pure candidate plan, not current admission or source authority. Actual
   * canonical protected policy/candidate/follower backing determines recipients. */
  readonly plan:(identity:{sourceTradeId:string;signalId:string})=>FanoutJobPlan;
}
export interface ExecutedPipelineInput {
  readonly scope:ExecutedPipelineScope;
  readonly source:Parameters<typeof createProtectedPipelineSource>[0];
  readonly fanout:ProtectedPipelineFanoutPorts;
  readonly worker:Omit<ProtectedPipelineWorkerInput,'transaction'>;
  /** Separate directly authenticated swat_app physical runtime lease. Driver
   * owns and checks actual BEGIN/COMMIT, so a callback cannot report success on
   * rollback/cancellation/uncertain COMMIT. Queue user selects no tenant scope. */
  readonly runtimeAcquire:()=>Promise<PipelineClientLease>;
  readonly observer:PipelineSqlObserverInput;
  readonly queueFor:(chain:FanoutJobPlan['chain'])=>FanoutTradeQueue;
  readonly buy:ExecutedPipelineStep;readonly sell:ExecutedPipelineStep;
  readonly reversal:SourceVerificationEvidence;
  readonly valuationAuthority:PipelineValuationAuthority;
  /** Candidate DTOs only. Shared writers independently compare exact bytes to
   * persisted protected approvals; these callbacks never certify or mint authority. */
  readonly capability:(execution:ExecutedExecution)=>PipelineWorkerCapabilityRegistration;
  readonly riskPolicy:(execution:ExecutedExecution)=>PipelineRiskPolicyWrite;
  readonly correction:(original:ExecutedOriginalEvidence,execution:ExecutedExecution)=>{
    readonly trusted:PipelineTrustedWorkerValuation;readonly correctionId:string;readonly previousCorrectionId:null;
  };
  readonly maximumLifetimeMs?:number;
  readonly signal?:AbortSignal;
}
const RUNTIME_IDENTITY_SQL=`SELECT current_user::text AS role,session_user::text AS session,current_setting('role') AS role_setting,
  current_setting('row_security') AS row_security,r.rolcanlogin,r.rolsuper,r.rolbypassrls,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
  EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS memberships,
  EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid) OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner=r.oid)
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid) OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=r.oid) AS owns_objects,
  has_database_privilege(r.oid,current_database(),'CREATE') OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE has_schema_privilege(r.oid,oid,'CREATE')) AS can_create,
  pg_backend_pid() AS backend_pid,current_setting('search_path') AS search_path
  FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`;
const runtimeContext=new AsyncLocalStorage<{poisoned:boolean}>();
const RESET_RUNTIME=`SELECT set_config('app.current_user_id','',true),set_config('app.worker_execution_id','',true),
  set_config('app.bypass_rls','off',true),set_config('statement_timeout','15000',true),set_config('lock_timeout','5000',true),
  set_config('idle_in_transaction_session_timeout','30000',true)`;
const RESET_RUNTIME_SESSION=`SELECT set_config('app.current_user_id','',false),set_config('app.worker_execution_id','',false),
  set_config('app.bypass_rls','off',false)`;
function cancellation(signal:AbortSignal|undefined) { pipelineCheck(!signal?.aborted,'cancelled; retain durable obligations and reconcile immutable identity'); }
export class ExecutedPipelineCommitUncertainError extends Error {
  constructor(options?:ErrorOptions) {
    super('Canonical pipeline runtime COMMIT uncertain; no acknowledgement/publication; retain obligation and reconcile persisted receipt',options);
    this.name='ExecutedPipelineCommitUncertainError';
  }
}
/** Lexical containment, NOT authorization. Existing SQL079 owned-obligation lookup
 * and canonical DB guards authorize work. Comments/string literals are scanned,
 * never executed as control commands. Only the canonical runtime GUC statements
 * may set tenant/worker scope; queue DTOs are not an authorization oracle. */
export function requireExecutedPipelineRuntimeSql(sql:string):void {
  pipelineCheck(typeof sql==='string'&&sql.length>0&&sql.length<=200_000,'bounded runtime SQL required');
  let code='',i=0;
  while(i<sql.length) {
    if(sql.startsWith('--',i)) { const end=sql.indexOf('\n',i+2);i=end<0?sql.length:end;code+=' ';continue; }
    if(sql.startsWith('/*',i)) {
      let depth=1;i+=2;
      while(i<sql.length&&depth>0) { if(sql.startsWith('/*',i)){depth++;i+=2;}else if(sql.startsWith('*/',i)){depth--;i+=2;}else i++; }
      pipelineCheck(depth===0,'unterminated runtime SQL comment');code+=' ';continue;
    }
    if(sql[i]==="'"||sql[i]==='"') {
      const quote=sql[i]!;i++;let closed=false,identifier='';
      while(i<sql.length) {
        if(sql[i]===quote){if(sql[i+1]===quote){identifier+=quote;i+=2;continue;}i++;closed=true;break;}
        identifier+=sql[i++];
      }
      pipelineCheck(closed,'unterminated runtime SQL literal');
      if(quote==='"') {
        pipelineCheck(/^[A-Za-z_][A-Za-z_0-9]*$/.test(identifier),'non-simple quoted runtime identifier refused');
        code+=` ${identifier} `;
      } else code+=' ? ';
      continue;
    }
    pipelineCheck(sql[i]!==';'&&!/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.test(sql.slice(i)),'multiple/dollar-quoted runtime SQL refused');
    code+=sql[i++];
  }
  const compact=code.trim().replace(/\s+/g,' ').toUpperCase();
  if(/^SET\b/.test(compact)||/\bSET_CONFIG\s*\(/.test(compact)) {
    const canonical=sql.trim().replace(/\s+/g,' ');
    pipelineCheck([
      "SET LOCAL app.bypass_rls = 'off'",
      "SELECT set_config('app.current_user_id', '', true), set_config('app.worker_execution_id', '', true)",
      "SELECT set_config('app.current_user_id', $1, true)",
      "SELECT set_config('app.worker_execution_id', $1, true)"
    ].includes(canonical),'noncanonical runtime scope control refused');return;
  }
  // DO is a control statement except in an INSERT's own ON CONFLICT clause.
  // Track parentheses so a CTE/subquery cannot donate its INSERT/CONFLICT to
  // an unrelated DO. This remains lexical containment, not a SQL authorizer.
  const tokens=compact.match(/[A-Z_][A-Z_0-9]*|[()]/g)??[];
  const contexts=[{insert:false,conflict:false}];
  for(let t=0;t<tokens.length;t++) {
    const token=tokens[t]!;
    if(token==='('){contexts.push({insert:false,conflict:false});continue;}
    if(token===')'){pipelineCheck(contexts.length>1,'unbalanced runtime SQL');contexts.pop();continue;}
    const context=contexts[contexts.length-1]!;
    if(token==='INSERT') {
      context.insert=true;context.conflict=false;
    } else if(['UPDATE','DELETE','RETURNING'].includes(token)) {
      context.insert=false;context.conflict=false;
    } else if(token==='CONFLICT'&&tokens[t-1]==='ON') {
      context.conflict=context.insert;
    } else if(token==='DO') {
      pipelineCheck(context.insert&&context.conflict&&(tokens[t+1]==='NOTHING'
        ||tokens[t+1]==='UPDATE'&&tokens[t+2]==='SET'),'procedural/noncanonical runtime DO refused');
      context.conflict=false;
    }
  }
  pipelineCheck(contexts.length===1,'unbalanced runtime SQL');
  pipelineCheck(/^(SELECT|WITH|INSERT|UPDATE|DELETE)\b/.test(compact)
    && !/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|RESET|CALL|COPY|SET_CONFIG)\b/.test(compact)
    && !/\bSET\s+(ROLE|SESSION|LOCAL|TRANSACTION|CONSTRAINTS|AUTHORIZATION)\b/.test(compact)
    && !/\bPG_(?:TRY_)?ADVISORY_(?:LOCK(?:_SHARED)?|UNLOCK(?:_SHARED|_ALL)?)\b/.test(compact),
  'uncontrolled runtime SQL refused');
}
/** Owns actual physical outcomes. There is no ambient pool or custom capability
 * broker. Deadline covers acquisition, callback, every query and COMMIT. Destroy
 * pending I/O on cancellation; never wait forever for a callback/query/rollback. */
export function createExecutedPipelineRuntimeTransaction(acquire:()=>Promise<PipelineClientLease>,signal?:AbortSignal,maximumMs=60_000) {
  pipelineCheck(typeof acquire==='function'&&Number.isSafeInteger(maximumMs)&&maximumMs>0&&maximumMs<=600_000,'bounded runtime physical lease required');
  return async function transaction<T>(operation:(client:PoolClient)=>Promise<T>):Promise<T> {
    const parent=runtimeContext.getStore();
    if(parent){parent.poisoned=true;throw new Error('Nested runtime transaction refused');}
    pipelineCheck(typeof operation==='function','runtime operation required');
    const lifetime=createPipelineLifetime(maximumMs,signal),state={poisoned:false};
    let lease:PipelineClientLease|undefined,open=false,committing=false,broken=false,live=false,pending:Promise<unknown>|null=null;
    try {
      lease=await lifetime.acquire(acquire);
      const query=(sql:string,values?:unknown[])=>lifetime.wait(()=>lease!.client.query(sql,values));
      const initial=await query(RUNTIME_IDENTITY_SQL),r=initial.rows[0];
      pipelineCheck(initial.command==='SELECT'&&initial.rows.length===1 && r.role==='swat_app' && r.session==='swat_app' && r.role_setting==='none'
        && r.row_security==='on' && r.rolcanlogin===true && ['rolsuper','rolbypassrls','rolinherit','rolcreaterole','rolcreatedb','rolreplication','memberships','owns_objects','can_create']
          .every(k=>r[k]===false) && Number.isInteger(r.backend_pid) && r.backend_pid>0
        && ['pg_catalog, public','pg_catalog,public'].includes(r.search_path),'direct nonprivileged runtime identity refused');
      await query(RESET_RUNTIME_SESSION);
      const begin=await query('BEGIN ISOLATION LEVEL READ COMMITTED');pipelineCheck(begin.command==='BEGIN','runtime BEGIN refused');open=true;
      await query(RESET_RUNTIME);lifetime.check();live=true;
      const client={query:async(sql:string,values?:unknown[])=>{
        try {
          pipelineCheck(live&&!pending&&!state.poisoned,'runtime expired/overlapping query refused');
          requireExecutedPipelineRuntimeSql(sql);lifetime.check();
          const p=query(sql,values);pending=p;
          try{return await p;}finally{if(pending===p)pending=null;}
        }catch(error){state.poisoned=true;throw error;}
      }} as PoolClient;
      const result=await lifetime.wait(()=>runtimeContext.run(state,()=>operation(client)));live=false;
      pipelineCheck(!pending&&!state.poisoned,'runtime query escaped callback');lifetime.check();
      // Reset legitimate LOCAL scope before rechecking. Compare only immutable
      // role/backend authority, never statement time or changing transaction GUCs.
      await query(RESET_RUNTIME);
      const final=await query(RUNTIME_IDENTITY_SQL);
      pipelineCheck(final.command==='SELECT'&&final.rows.length===1 && pipelineCanonical(final.rows[0])===pipelineCanonical(r),'runtime authority/backend changed');
      lifetime.check();committing=true;
      const commit=await query('COMMIT');
      pipelineCheck(commit.command==='COMMIT'&&!pending&&!state.poisoned,'runtime COMMIT did not commit');open=false;
      lifetime.check();committing=false;return result;
    }catch(error){
      live=false;broken=true;
      if(committing)throw new ExecutedPipelineCommitUncertainError({cause:error});
      if(open&&lease&&!pending&&!lifetime.signal.aborted){
        try{const rollback=await lifetime.wait(()=>lease!.client.query('ROLLBACK'));if(rollback.command==='ROLLBACK')open=false;}catch{/* destroy; no rollback claim */}
      }
      throw error;
    }finally{live=false;try{lease?.release(broken||open||state.poisoned||pending!==null);}finally{lifetime.dispose();}}
  };
}
function plainCapture<T>(value:T):T { return JSON.parse(pipelineCanonical(value)) as T; }
function stepCapture(value:ExecutedPipelineStep):ExecutedPipelineStep {
  const {plan}=value;pipelineCheck(typeof plan==='function','candidate plan required');
  const event={...value.event,eventAt:new Date(value.event.eventAt),observedAt:value.event.observedAt?new Date(value.event.observedAt):undefined,
    verificationBinding:value.event.verificationBinding?plainCapture(value.event.verificationBinding):undefined};
  return {...value,event,evidence:plainCapture(value.evidence),signal:plainCapture(value.signal),plan};
}
function oneRow<T>(rows:readonly T[],predicate:(row:T)=>boolean,reason:string):T {
  const matched=rows.filter(predicate);pipelineCheck(matched.length===1,reason);return matched[0]!;
}
type PipelineWorkerPaperReceiptEvidence=ReturnType<typeof pipelineReceiptEvidence>;
/** Reconstruction is comparison-only: canonical worker rereads attempt, captured/
 * current policy, risk control/reservation, delivery and original on its SAME
 * scoped client before delegating to the existing SQL080 settlement body. */
export function reconstructPipelineValuationSettlement(snapshot:ExecutedPipelineSnapshot,execution:ExecutedExecution,
  correction:{trusted:PipelineTrustedWorkerValuation;correctionId:string;previousCorrectionId:null},now:Date):WorkerValuationSettlement {
  const persisted=oneRow(snapshot.executions,r=>r.id===execution.id,'correction independent execution missing');
  pipelineEqual(execution,persisted,'correction candidate differs from independent execution');execution=persisted;
  const f=oneRow(snapshot.originals,r=>r.executionId===execution.id,'correction immutable original unavailable');
  const retained=oneRow(snapshot.attempts,r=>r.execution_id===execution.id,'correction canonical attempt');
  const delivery=oneRow(snapshot.deliveries,r=>r.execution_id===execution.id,'correction canonical delivery');
  const risk=oneRow(snapshot.risk,r=>r.execution_id===execution.id,'correction retained risk');
  const policy=oneRow(snapshot.policies,r=>r.execution_id===execution.id,'correction persisted captured policy');
  const trade=oneRow(snapshot.trades,r=>r.copy_execution_id===execution.id,'correction persisted settlement trade');
  const captured=policy.snapshot as PipelineSqlRow;
  pipelineCheck(policy.user_id===execution.userId&&policy.chain===execution.chain&&policy.target_account===execution.targetAccount
    && policy.token_mint===execution.tokenMint&&policy.execution_mode==='paper'&&captured&&typeof captured.policyId==='string'
    && /^[0-9a-f]{64}$/.test(captured.policyId)&&typeof captured.revision==='string'&&/^[0-9a-f]{64}$/.test(captured.revision)
    && retained.policy_revision===captured.revision,
  'recovery independently captured attempt policy missing');
  pipelineCheck(Number.isSafeInteger(captured.maxSlippageBps)&&(captured.maxSlippageBps as number)>=0
    &&(captured.maxSlippageBps as number)<=5000,'recovery historical captured slippage missing');
  const policyScope=captured.scope as PipelineSqlRow;
  pipelineCheck(policyScope&&policyScope.account===execution.userId&&policyScope.chain===execution.chain
    && policyScope.tokenMint===execution.tokenMint&&policyScope.masterWalletAddress===policy.master_wallet_address,
  'recovery captured policy scope differs');
  // Receipt-owned recovery uses the historical captured policy bound pinned to
  // the attempt, never today's policy or a trade-row slippage substitute.
  pipelineCheck(trade.user_id===execution.userId&&trade.chain===execution.chain&&trade.token_mint===execution.tokenMint
    && trade.execution_mode==='paper'&&trade.direction===execution.direction&&trade.signal_id===execution.signalId
    && trade.source_trade_id===execution.sourceTradeId&&trade.status==='filled'
    && Number.isSafeInteger(trade.slippage_bps)&&(trade.slippage_bps as number)>=0&&(trade.slippage_bps as number)<=5000,
  'recovery persisted settlement slippage/scope missing');
  pipelineCheck(execution.executionMode==='paper'&&execution.direction==='buy'&&execution.userId!==null
    && execution.state==='confirmed'&&execution.exitLotId===null&&execution.exitTrigger===null&&execution.signalId!==null&&execution.sourceTradeId!==null,
  'bounded source acquisition recovery required');
  pipelineCheck(retained.user_id===execution.userId&&retained.state==='settled'&&delivery.user_id===execution.userId
    && delivery.signal_id===execution.signalId&&delivery.execution_mode==='paper'&&delivery.target_account===execution.targetAccount
    && delivery.state==='completed'&&typeof delivery.fence==='string'&&/^[1-9]\d{0,18}$/.test(delivery.fence)
    && BigInt(delivery.fence)<=9223372036854775807n,'recovery persisted delivery identity/fence/state mismatch');
  pipelineCheck(typeof retained.fence==='string'&&/^[1-9]\d{0,18}$/.test(retained.fence)&&BigInt(retained.fence)<=9223372036854775807n
    && typeof retained.policy_revision==='string'&&retained.policy_revision.length>0&&typeof retained.risk_epoch==='string'
    && /^[1-9]\d{0,18}$/.test(retained.risk_epoch)&&BigInt(retained.risk_epoch)<=9223372036854775807n,'recovery attempt exact terms missing');
  const attempt:WorkerAttempt={executionId:execution.id,userId:execution.userId,fence:retained.fence,
    policyRevision:retained.policy_revision,riskEpoch:retained.risk_epoch};
  const count=(value:unknown):number=>{pipelineCheck(Number.isSafeInteger(value)&&(value as number)>=0,'canonical execution counter missing');return value as number;};
  pipelineCheck(typeof execution.quoteUnknown==='string'&&/^(0|[1-9]\d*)$/.test(execution.quoteUnknown)
    && BigInt(execution.quoteUnknown)<=BigInt(Number.MAX_SAFE_INTEGER),'canonical quote coverage counter missing');
  const date=(value:string|null):Date|null=>{
    if(value===null)return null;
    pipelineCheck(typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value,'canonical recovery timestamp required');
    return new Date(value);
  };
  pipelineCheck(now instanceof Date&&Number.isFinite(now.getTime()),'bounded recovery clock required');
  const e:CopyExecutionRecord={id:execution.id,signalId:execution.signalId,sourceTradeId:execution.sourceTradeId,
    exitLotId:execution.exitLotId,exitTrigger:execution.exitTrigger,userId:execution.userId,chain:execution.chain,
    tokenMint:execution.tokenMint,targetAccount:execution.targetAccount,executionMode:execution.executionMode,
    direction:execution.direction,clientOrderId:execution.clientOrderId,state:execution.state,
    requestedBaseQuantity:execution.requestedBase,requestedQuoteQuantity:execution.requestedQuote,
    confirmedBaseQuantity:execution.confirmedBase,confirmedQuoteQuantity:execution.confirmedQuote,
    quoteUnassessedFillCount:Number(execution.quoteUnknown),reservedBaseQuantity:execution.reservedBase,
    submissionAttempts:count(execution.submissionAttempts),maxSubmissionAttempts:count(execution.maxSubmissionAttempts),
    simulationId:execution.simulationId,submissionType:execution.submissionType,submissionId:execution.submissionId,
    nextReconciliationAt:date(execution.nextReconciliationAt),reconciliationClaimId:execution.reconciliationClaimId,
    reconciliationAttempts:count(execution.reconciliationAttempts),maxReconciliationAttempts:count(execution.maxReconciliationAttempts),
    sourcePositionBeforeQuantity:execution.sourcePositionBefore,sourceSellFraction:execution.sourceSellFraction};
  const nullableExact=(value:string|null)=>value===null?null:pipelineExactText(exactPipelineDecimal(value));
  // Canonical USD legs persist amount/USD/1 alongside quote USD. An absent
  // quote has all four fields NULL; do not invent native economics or zeroes.
  pipelineCheck(f.userId===e.userId&&f.sourceTradeId===e.sourceTradeId&&f.evidenceType==='paper_simulation'
    && f.confirmationState==='confirmed'&&f.completes===true
    && nullableExact(f.nativeQuote)===nullableExact(f.quote)&&nullableExact(f.nativePrice)===(f.quote===null?null:'1')
    && f.quoteCurrency===(f.quote===null?null:'USD'),
  'immutable original paper evidence scope required');
  // Missing quote/price/fee remains null. Never substitute protected expected
  // economics, current effective corrections or zero for immutable originals.
  const evidence:WorkerValuationSettlement['evidence']={executionId:e.id,evidenceType:'paper_simulation',evidenceId:f.evidenceId,
    baseQuantity:f.base,quoteLeg:f.quote===null?null:{amount:f.quote,currency:'USD'},priceUsd:f.price,feeUsd:f.fee,
    confirmationState:'confirmed',completesExecution:f.completes,occurredAt:date(f.occurredAt)!};
  const receipt=snapshot.paperReceipts.filter(r=>r.executionId===e.id&&r.workerFence===attempt.fence);
  pipelineCheck(receipt.length===1&&receipt[0]!.userId===e.userId&&receipt[0]!.policyRevision===attempt.policyRevision
    && receipt[0]!.riskEpoch===attempt.riskEpoch&&receipt[0]!.chain===e.chain&&receipt[0]!.tokenMint===e.tokenMint
    && receipt[0]!.targetAccount===e.targetAccount&&receipt[0]!.executionMode==='paper'&&receipt[0]!.executor==='paper-exact-simulated',
  'recovery independent original receipt missing');
  const valuation=oneRow(snapshot.paperValuations,r=>r.executionId===e.id,'recovery persisted paper valuation missing');
  pipelineCheck(receipt[0]!.paperValuationEvidenceId===valuation.evidenceId&&receipt[0]!.paperValuationDigest===valuation.evidenceDigest
    && valuation.userId===e.userId&&valuation.chain===e.chain&&valuation.tokenMint===e.tokenMint
    && valuation.targetAccount===e.targetAccount&&valuation.sourceTradeId===e.sourceTradeId
    && valuation.requestedBase===e.requestedBaseQuantity&&valuation.requestedQuote===e.requestedQuoteQuantity,
  'recovery receipt protected valuation mismatch');
  const normalized=(value:PipelineWorkerPaperReceiptEvidence)=>({...value,
    baseQuantity:pipelineExactText(exactPipelineDecimal(value.baseQuantity)),
    quoteLeg:value.quoteLeg===null?null:{amount:pipelineExactText(exactPipelineDecimal(value.quoteLeg.amount)),currency:value.quoteLeg.currency},
    priceUsd:value.priceUsd===null?null:pipelineExactText(exactPipelineDecimal(value.priceUsd)),
    feeUsd:value.feeUsd===null?null:pipelineExactText(exactPipelineDecimal(value.feeUsd))});
  pipelineEqual(normalized(receipt[0]!.evidence),normalized(pipelineReceiptEvidence(evidence)),'recovery immutable original receipt differs');
  const control=oneRow(snapshot.riskPolicies,r=>r.account===e.userId&&r.chain===e.chain&&r.execution_mode==='paper',
    'recovery persisted risk control missing');
  pipelineCheck(typeof control.epoch==='string'&&/^[1-9]\d{0,18}$/.test(control.epoch),'recovery risk control epoch missing');
  pipelineCheck(risk.account===e.userId&&risk.chain===e.chain&&risk.execution_mode==='paper'
    && risk.state==='confirmed'&&risk.policy_epoch===attempt.riskEpoch,'recovery risk scope differs');
  const descriptor=delivery.descriptor as {data?:PipelineSqlRow;options?:PipelineSqlRow};
  pipelineCheck(descriptor?.data?.copyExecutionId===e.id&&descriptor.data.userId===e.userId
    && descriptor.data.signalId===e.signalId&&descriptor.data.sourceTradeId===e.sourceTradeId
    && descriptor.data.tokenMint===e.tokenMint&&descriptor.data.chain===e.chain&&descriptor.data.executionMode==='paper'
    && descriptor.data.targetAccount===e.targetAccount&&descriptor.options?.jobId===delivery.job_id,
  'recovery persisted delivery descriptor differs');
  pipelineCheck(delivery.lease_owner===null||typeof delivery.lease_owner==='string'&&delivery.lease_owner.length>0,
    'recovery persisted delivery owner missing');
  pipelineCheck(correction.previousCorrectionId===null&&correction.trusted.executionId===e.id
    && correction.trusted.userId===e.userId&&correction.trusted.originalEvidenceId===f.id
    && correction.trusted.lineageSourceTradeId===e.sourceTradeId,'recovery correction candidate immutable lineage differs');
  // Preserve receipt decimal bytes after independent numeric/null comparison.
  // PostgreSQL NUMERIC scale is not the protected receipt's original JSON bytes.
  const retainedEvidence={...receipt[0]!.evidence,quoteLeg:receipt[0]!.evidence.quoteLeg===null?null:{...receipt[0]!.evidence.quoteLeg},
    occurredAt:new Date(receipt[0]!.evidence.occurredAt)};
  return {execution:e,attempt,evidence:retainedEvidence,executor:receipt[0]!.executor,slippageBps:captured.maxSlippageBps as number,
    risk:{account:e.userId!,chain:e.chain,executionMode:'paper',executionId:e.id,policyEpoch:attempt.riskEpoch!},
    delivery:{claim:{signalId:e.signalId!,userId:e.userId,executionMode:'paper',targetAccount:e.targetAccount,
      fence:delivery.fence,owner:delivery.lease_owner as string|null ?? 'receipt-owned-recovery'},now:new Date(now)},
    correction:{originalEvidenceId:f.id,correctionId:correction.correctionId,valuationId:correction.trusted.valuationId,
      previousCorrectionId:correction.previousCorrectionId,now:new Date(now)}};
}
/** Comparison-only negative replay proof. A reversed source cannot supply the
 * canonical worker context, even for an otherwise terminal execution. */
export function requireExecutedPipelineReversedReplay(result:{status:string;reason?:string},
  before:ExecutedPipelineSnapshot,after:ExecutedPipelineSnapshot):void {
  pipelineCheck(before.stage==='reversal'&&after.stage==='reversal','reversed replay observation required');
  pipelineCheck(result.status==='skipped'&&result.reason==='owned-execution-context-unavailable',
    'reversed source replay did not refuse canonical context');
  pipelineEqual(after,before,'reversed source refusal changed durable rows');
}
/** Callable actual production-driver source. Does not start a service, provision
 * a capability, apply SQL, enroll a provider, sign, or expose public CLI execution.
 * Missing protected source/follower/risk/valuation/receipt/runtime backing throws.
 * Every economics snapshot comes from the separately owned committed SQL reader. */
export function createExecutedPaperPipeline(input:ExecutedPipelineInput) {
  pipelineCheck(input && typeof input.queueFor==='function' && typeof input.capability==='function' && typeof input.riskPolicy==='function'
    && typeof input.correction==='function','actual protected candidate composition required');
  const scope=plainCapture(input.scope),buy=stepCapture(input.buy),sell=stepCapture(input.sell),reversal=plainCapture(input.reversal);
  const {capability,riskPolicy,correction,queueFor,signal}=input;
  const maximumMs=input.maximumLifetimeMs??60_000;
  pipelineCheck(Number.isSafeInteger(maximumMs)&&maximumMs>0&&maximumMs<=600_000,'bounded joined driver lifetime required');
  const sourceInput={...input.source},fanoutInput={...input.fanout,policy:{...input.fanout.policy}},workerInput={...input.worker};
  const observerInput={...input.observer},runtimeAcquire=input.runtimeAcquire;
  pipelineCheck(buy.event.side==='buy'&&sell.event.side==='sell'&&buy.event.confirmationState==='observed'
    && sell.event.confirmationState==='observed'&&reversal.finality==='reversed','observations plus protected evidence required');
  for(const step of [buy,sell]) pipelineCheck(step.event.chain===scope.chain && step.event.tokenMint===scope.tokenMint
    && step.event.walletAddress===scope.masterWalletAddress && step.evidence.binding.network===scope.network
    && step.event.sourceEventId.startsWith(`${scope.namespace}/`),'candidate source scope drift');
  const authority=plainCapture(input.valuationAuthority);
  let inFlight=false;
  return Object.freeze({status:EXECUTED_PIPELINE_SOURCE_STATUS,
    async run():Promise<{journal:ExecutedPipelineJournal;economics:ReturnType<typeof reconcileExecutedPipelineJournal>}> {
      pipelineCheck(!inFlight,'overlapping joined driver refused');inFlight=true;
      const lifetime=createPipelineLifetime(maximumMs,signal);
      try {
        lifetime.check();
        const observer=createPipelineSqlObserver({...observerInput,
          signal:observerInput.signal?AbortSignal.any([lifetime.signal,observerInput.signal]):lifetime.signal,
          maximumLifetimeMs:Math.min(observerInput.maximumLifetimeMs??maximumMs,maximumMs)});
        observer.preflight(scope);
        // Bound the actual protected compositions without substituting their
        // canonical business bodies. Outer cancellation destroys every leased
        // writer connection, including late acquisitions and uncertain COMMITs.
        const bounded=(acquire:()=>Promise<PipelineClientLease>)=>()=>lifetime.acquire(acquire);
        const source=createProtectedPipelineSource({...sourceInput,acquire:bounded(sourceInput.acquire)});
        const fanout=createProtectedPipelineFanout({...fanoutInput,acquire:bounded(fanoutInput.acquire)});
        const worker=createProtectedPipelineWorkerComposition({...workerInput,
          capabilityAcquire:bounded(workerInput.capabilityAcquire),riskAcquire:bounded(workerInput.riskAcquire),
          valuationAcquire:bounded(workerInput.valuationAcquire),receiptAcquire:bounded(workerInput.receiptAcquire),
          transaction:createExecutedPipelineRuntimeTransaction(runtimeAcquire,lifetime.signal,maximumMs)});
        return await lifetime.wait(async()=>{
        cancellation(lifetime.signal);await source.register();cancellation(lifetime.signal);await worker.valuations.register(authority);
        const snapshots:ExecutedPipelineSnapshot[]=[],jobs:FanoutJobDescriptor[]=[];
        async function execute(step:ExecutedPipelineStep,stage:'buy'|'sell') {
          cancellation(lifetime.signal);const observed=await source.intake(step.event);cancellation(lifetime.signal);
          await source.verify(observed.event.id,step.evidence);cancellation(lifetime.signal);
          const derived=await source.derive({sourceTradeId:observed.event.id,...step.signal,now:new Date(sourceInput.now())});
          cancellation(lifetime.signal);const plan=step.plan({sourceTradeId:observed.event.id,signalId:derived.id});
          pipelineCheck(plan.operator.data.sourceTradeId===observed.event.id&&plan.operator.data.signalId===derived.id
            && plan.operator.data.tokenMint===scope.tokenMint,'candidate plan altered committed source/signal');
          const delivery=fanout.delivery({sourceTradeId:observed.event.id,walletAddress:scope.masterWalletAddress,tokenMint:scope.tokenMint,
            side:stage,eventAt:new Date(observed.event.eventAt)},step.eligibility,step.poolTvlUsd);
          const descriptors=await delivery.prepare(plan);cancellation(lifetime.signal);
          pipelineCheck(descriptors.length===1&&descriptors[0]!.data.userId===scope.userId&&descriptors[0]!.data.executionMode==='paper',
            'one exact owned follower and durable operator exclusion required');
          const descriptor=plainCapture(descriptors[0]!);
          // Read committed claim from independent reader; no canonical business SQL clone.
          const preparation=await observer.observe(scope,stage);
          const execution=preparation.executions.find(e=>e.id===descriptor.data.copyExecutionId);pipelineCheck(execution,'committed canonical execution absent');
          if(stage==='buy')pipelineCheck(execution.requestedBase===null&&execution.requestedQuote!==null,'truthful quote-budget buy required');
          await worker.registry.register(plainCapture(capability(plainCapture(execution))));cancellation(lifetime.signal);
          if(stage==='buy'){await worker.risk.write(plainCapture(riskPolicy(plainCapture(execution))));cancellation(lifetime.signal);}
          // Production enqueue repeats immutable prepare and resolves only after
          // its own checked fanout COMMIT. Enqueue failure leaves durable obligation.
          await delivery.enqueue(chain=>({add:async(name,data,options)=>{
            cancellation(lifetime.signal);const queue=queueFor(chain);const accepted=await queue.add(name,plainCapture(data),plainCapture(options));
            cancellation(lifetime.signal);return accepted;
          }}),plan);cancellation(lifetime.signal);
          const result=await worker.run(descriptor.data);cancellation(lifetime.signal);
          pipelineCheck(result.status==='paper-filled'||result.status==='already-executed','worker did not commit complete paper accounting');
          // Worker receipt query is comparison-only. Journal never substitutes it
          // for independent canonical read-only committed SQL observation.
          await worker.financialReceipt(descriptor.data);cancellation(lifetime.signal);
          jobs.push(descriptor);snapshots.push(await observer.observe(scope,stage));
          return observed.event.id;
        }
        await execute(buy,'buy');const sellId=await execute(sell,'sell');
        // Legitimate terminal worker replays require accepted canonical source
        // context. Perform them before reversing the sell, and independently
        // verify they leave the settled rows unchanged.
        const settledSnapshot=snapshots[1]!;
        for(const job of jobs){const result=await worker.run(job.data);cancellation(lifetime.signal);
          pipelineCheck(result.status==='already-executed','replay was not canonical terminal');}
        pipelineEqual(await observer.observe(scope,'sell'),settledSnapshot,'terminal replay changed durable rows');
        await source.verify(sellId,reversal);cancellation(lifetime.signal);snapshots.push(await observer.observe(scope,'reversal'));
        const reversalSnapshot=snapshots[2]!;
        const refused=await worker.run(jobs[1]!.data);cancellation(lifetime.signal);
        requireExecutedPipelineReversedReplay(refused,reversalSnapshot,await observer.observe(scope,'reversal'));
        const buyExecution=reversalSnapshot.executions.find(e=>e.direction==='buy');
        pipelineCheck(buyExecution,'buy correction lineage absent');const original=reversalSnapshot.originals.find(f=>f.executionId===buyExecution.id);
        pipelineCheck(original,'immutable acquisition original absent');
        const correctionTerms=plainCapture(correction(plainCapture(original),plainCapture(buyExecution)));
        pipelineCheck(correctionTerms.trusted.executionId===buyExecution.id&&correctionTerms.trusted.originalEvidenceId===original.id
          && correctionTerms.trusted.lineageSourceTradeId===buyExecution.sourceTradeId,'correction candidate changed immutable original/source');
        await worker.valuations.record(correctionTerms.trusted);cancellation(lifetime.signal);
        const correctionCandidate=reconstructPipelineValuationSettlement(reversalSnapshot,buyExecution,correctionTerms,new Date(workerInput.now()));
        const corrected=await worker.reconcileValuation(jobs[0]!.data,correctionCandidate);cancellation(lifetime.signal);
        pipelineCheck(corrected.accountingComplete&&corrected.execution.state==='confirmed','correction did not commit complete effective accounting');
        snapshots.push(await observer.observe(scope,'correction'));
        // Same immutable acquisition correction identity: receipt-owned recovery
        // remains separate from the reversed sell's refused worker context.
        const replay=await worker.reconcileValuation(jobs[0]!.data,correctionCandidate);cancellation(lifetime.signal);
        pipelineCheck(replay.replayed&&replay.accountingComplete,'correction replay was not immutable receipt-owned');
        snapshots.push(await observer.observe(scope,'replay'));
        const journal:ExecutedPipelineJournal={kind:'canonical-executed-paper-pipeline',scope,snapshots,
          runtimeAccepted:false,sourceComplete:false,liveCapabilityAccepted:false};
        const economics=reconcileExecutedPipelineJournal(journal);cancellation(lifetime.signal);
        return {journal,economics};
        });
      }finally{lifetime.dispose();inFlight=false;}
    }
  });
}
