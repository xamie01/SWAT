import type { PoolClient } from 'pg';
import { createProtectedPipelineSource, type PipelineClientLease } from '../../../packages/db/src/wave4-pipeline-source-owned.js';
import { createProtectedPipelineFanout, type ProtectedPipelineFanoutPorts } from '../../../apps/signal-engine/src/wave4-pipeline-protected-composition.js';
import { createProtectedPipelineWorkerComposition, type ProtectedPipelineWorkerInput } from '../../../apps/trade-executor/src/wave4-pipeline-protected-composition.js';
import type { SourceTradeEventInput, CopyExecutionRecord } from '../../../packages/db/src/copy-trade-lifecycle-owned.js';
import type { SourceVerificationEvidence } from '../../../packages/db/src/source-verification.js';
import type { PipelineWorkerCapabilityRegistration } from '../../../packages/db/src/wave4-pipeline-capability-owned.js';
import type { PipelineRiskPolicyWrite } from '../../../packages/db/src/wave4-pipeline-risk-owned.js';
import type { PipelineValuationAuthority, PipelineTrustedWorkerValuation } from '../../../packages/db/src/wave4-pipeline-valuation-owned.js';
import type { WorkerValuationSettlement } from '../../../packages/db/src/worker-settlement.js';
import type { FanoutJobPlan, FanoutTradeQueue, FanoutJobDescriptor } from '../../../apps/signal-engine/src/fanout-enqueue.js';
import type { SignalTradeEligibility } from '../../../apps/signal-engine/src/trade-eligibility.js';
import { createPipelineSqlObserver, type PipelineSqlObserverInput } from './pipeline-sql-observer.js';
import { pipelineCheck, pipelineCanonical, pipelineEqual, reconcileExecutedPipelineJournal,
  type ExecutedPipelineScope, type ExecutedPipelineJournal, type ExecutedPipelineSnapshot,
  type ExecutedExecution, type PipelineSqlRow } from './pipeline-economics.js';

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
  readonly correction:(original:PipelineSqlRow,execution:ExecutedExecution)=>{
    readonly trusted:PipelineTrustedWorkerValuation;readonly correctionId:string;readonly previousCorrectionId:null;
  };
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
const runtimeLeases=new WeakSet<object>();
const RESET_RUNTIME=`SELECT set_config('app.current_user_id','',true),set_config('app.worker_execution_id','',true),
  set_config('app.bypass_rls','off',true),set_config('statement_timeout','15000',true),set_config('lock_timeout','5000',true),
  set_config('idle_in_transaction_session_timeout','30000',true)`;
function cancellation(signal:AbortSignal|undefined) { pipelineCheck(!signal?.aborted,'cancelled; retain durable obligations and reconcile immutable identity'); }
export class ExecutedPipelineCommitUncertainError extends Error {
  constructor(options?:ErrorOptions) { super('Canonical pipeline runtime COMMIT uncertain; no acknowledgement/publication; retain obligation and reconcile persisted receipt',options); }
}
/** No caller-owned transaction-success oracle. Owns actual command results and
 * lifetime, destroys escaped/failed clients, no retry/rollback claims after a
 * COMMIT attempt, and no post-commit enqueue/publication on cancellation. */
export function createExecutedPipelineRuntimeTransaction(acquire:()=>Promise<PipelineClientLease>,signal?:AbortSignal) {
  pipelineCheck(typeof acquire==='function','runtime physical lease required');
  let active=false;
  return async function transaction<T>(operation:(client:PoolClient)=>Promise<T>):Promise<T> {
    cancellation(signal);pipelineCheck(!active,'nested runtime transaction refused');active=true;
    let lease:PipelineClientLease|undefined,open=false,committing=false,broken=false,live=false,poisoned=false,pending:Promise<unknown>|null=null;
    try {
      lease=await acquire();pipelineCheck(lease?.client && typeof lease.release==='function','owned runtime lease required');
      pipelineCheck(!runtimeLeases.has(lease.client),'concurrent runtime physical lease reuse');runtimeLeases.add(lease.client);
      const initial=await lease.client.query(RUNTIME_IDENTITY_SQL),r=initial.rows[0];
      pipelineCheck(initial.rows.length===1 && r.role==='swat_app' && r.session==='swat_app' && r.role_setting==='none'
        && r.row_security==='on' && r.rolcanlogin===true && ['rolsuper','rolbypassrls','rolinherit','rolcreaterole','rolcreatedb','rolreplication','memberships','owns_objects','can_create']
          .every(k=>r[k]===false) && Number.isInteger(r.backend_pid) && r.backend_pid>0
        && ['pg_catalog, public','pg_catalog,public'].includes(r.search_path),'direct nonprivileged runtime identity refused');
      const begin=await lease.client.query('BEGIN ISOLATION LEVEL READ COMMITTED');pipelineCheck(begin.command==='BEGIN','runtime BEGIN refused');open=true;
      await lease.client.query(RESET_RUNTIME);cancellation(signal);live=true;
      const client={query:async(sql:string,values?:unknown[])=>{
        if(!live||pending||typeof sql!=='string'||/;|\/\*|^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|RESET|DO|CALL)\b/i.test(sql)) {
          poisoned=true;throw new Error('Runtime expired/overlapping/uncontrolled query refused');
        }
        cancellation(signal);const p=lease!.client.query(sql,values);pending=p;
        try{return await p;}catch(error){poisoned=true;throw error;}finally{if(pending===p)pending=null;}
      }} as PoolClient;
      const result=await operation(client);live=false;
      pipelineCheck(!pending&&!poisoned,'runtime query escaped callback');cancellation(signal);
      const final=await lease.client.query(RUNTIME_IDENTITY_SQL);
      pipelineCheck(final.rows.length===1 && pipelineCanonical(final.rows[0])===pipelineCanonical(r),'runtime authority/backend changed');
      await lease.client.query(RESET_RUNTIME);cancellation(signal);committing=true;
      const commit=await lease.client.query('COMMIT');
      pipelineCheck(commit.command==='COMMIT'&&!pending&&!poisoned,'runtime COMMIT did not commit');open=false;
      // Abort racing COMMIT is not rollback. Refuse acknowledgement/publication
      // and leave persisted capability/attempt/receipt for independently owned recovery.
      cancellation(signal);committing=false;return result;
    }catch(error){
      live=false;broken=true;
      if(pending){try{await pending;}catch{/* settle physical query before release */}}
      if(committing)throw new ExecutedPipelineCommitUncertainError({cause:error});
      if(open&&lease){try{await lease.client.query('ROLLBACK');}catch{/* never report rollback success */}}
      throw error;
    }finally{if(lease){runtimeLeases.delete(lease.client);lease.release(broken||open||poisoned);}active=false;}
  };
}
function plainCapture<T>(value:T):T { return JSON.parse(pipelineCanonical(value)) as T; }
function stepCapture(value:ExecutedPipelineStep):ExecutedPipelineStep {
  const {plan}=value;pipelineCheck(typeof plan==='function','candidate plan required');
  const event={...value.event,eventAt:new Date(value.event.eventAt),observedAt:value.event.observedAt?new Date(value.event.observedAt):undefined,
    verificationBinding:value.event.verificationBinding?plainCapture(value.event.verificationBinding):undefined};
  return {...value,event,evidence:plainCapture(value.evidence),signal:plainCapture(value.signal),plan};
}
function oneRow(rows:readonly PipelineSqlRow[],predicate:(row:PipelineSqlRow)=>boolean,reason:string):PipelineSqlRow {
  const matched=rows.filter(predicate);pipelineCheck(matched.length===1,reason);return matched[0]!;
}
function recoveryCandidate(snapshot:ExecutedPipelineSnapshot,execution:ExecutedExecution,
  correction:{trusted:PipelineTrustedWorkerValuation;correctionId:string;previousCorrectionId:null},now:Date):WorkerValuationSettlement {
  const f=snapshot.originals.find(r=>r.executionId===execution.id);pipelineCheck(f,'correction immutable original unavailable');
  const attempt=oneRow(snapshot.attempts,r=>r.execution_id===execution.id,'correction canonical attempt');
  const delivery=oneRow(snapshot.deliveries,r=>r.execution_id===execution.id,'correction canonical delivery');
  const risk=oneRow(snapshot.risk,r=>r.execution_id===execution.id,'correction retained risk');
  // Only immutable fields used by worker recoveryContext are reconstructed. The
  // protected worker rereads complete production context on its own runtime client.
  const e={id:execution.id,signalId:execution.signalId,sourceTradeId:execution.sourceTradeId,exitLotId:null,exitTrigger:null,
    userId:execution.userId,chain:execution.chain,tokenMint:execution.tokenMint,targetAccount:execution.targetAccount,
    executionMode:execution.executionMode,direction:execution.direction,clientOrderId:execution.clientOrderId,state:execution.state,
    requestedBaseQuantity:execution.requestedBase,requestedQuoteQuantity:execution.requestedQuote,confirmedBaseQuantity:execution.confirmedBase,
    confirmedQuoteQuantity:execution.confirmedQuote,quoteUnassessedFillCount:0,sourcePositionBeforeQuantity:execution.sourcePositionBefore,
    sourceSellFraction:execution.sourceSellFraction} as CopyExecutionRecord;
  pipelineCheck(f.quote!==null && f.price!==null && f.fee!==null && f.quoteCurrency==='USD','correction original paper price/fee required');
  return {execution:e,attempt:{executionId:execution.id,userId:execution.userId,fence:attempt.fence as string,
    policyRevision:attempt.policy_revision as string,riskEpoch:attempt.risk_epoch as string|null,state:'settled'},
    evidence:{executionId:execution.id,evidenceType:'paper_simulation',evidenceId:f.evidenceId,baseQuantity:f.base,
      quoteLeg:{amount:f.quote,currency:'USD'},priceUsd:f.price,feeUsd:f.fee,confirmationState:'confirmed',completesExecution:true,occurredAt:new Date(f.occurredAt)},
    executor:'paper-exact-simulated',slippageBps:0,risk:{account:risk.account as string,chain:e.chain,executionMode:'paper',
      executionId:execution.id,policyEpoch:risk.policy_epoch as string},
    delivery:{claim:{signalId:execution.signalId!,userId:execution.userId,executionMode:'paper',targetAccount:execution.targetAccount,
      fence:delivery.fence as string,owner:'wave4-economic-recovery'},now},
    correction:{originalEvidenceId:f.id,correctionId:correction.correctionId,valuationId:correction.trusted.valuationId,
      previousCorrectionId:correction.previousCorrectionId,now}};
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
  pipelineCheck(buy.event.side==='buy'&&sell.event.side==='sell'&&buy.event.confirmationState==='observed'
    && sell.event.confirmationState==='observed'&&reversal.finality==='reversed','observations plus protected evidence required');
  for(const step of [buy,sell]) pipelineCheck(step.event.chain===scope.chain && step.event.tokenMint===scope.tokenMint
    && step.event.walletAddress===scope.masterWalletAddress && step.evidence.binding.network===scope.network
    && step.event.sourceEventId.startsWith(`${scope.namespace}/`),'candidate source scope drift');
  const source=createProtectedPipelineSource(input.source),fanout=createProtectedPipelineFanout(input.fanout);
  const worker=createProtectedPipelineWorkerComposition({...input.worker,
    transaction:createExecutedPipelineRuntimeTransaction(input.runtimeAcquire,signal)});
  const observer=createPipelineSqlObserver(input.observer),authority=plainCapture(input.valuationAuthority);
  let inFlight=false;
  return Object.freeze({status:EXECUTED_PIPELINE_SOURCE_STATUS,
    async run():Promise<{journal:ExecutedPipelineJournal;economics:ReturnType<typeof reconcileExecutedPipelineJournal>}> {
      pipelineCheck(!inFlight,'overlapping joined driver refused');inFlight=true;
      try {
        cancellation(signal);await source.register();cancellation(signal);await worker.valuations.register(authority);
        const snapshots:ExecutedPipelineSnapshot[]=[],jobs:FanoutJobDescriptor[]=[];
        async function execute(step:ExecutedPipelineStep,stage:'buy'|'sell') {
          cancellation(signal);const observed=await source.intake(step.event);cancellation(signal);
          await source.verify(observed.event.id,step.evidence);cancellation(signal);
          const derived=await source.derive({sourceTradeId:observed.event.id,...step.signal,now:new Date(input.source.now())});
          cancellation(signal);const plan=step.plan({sourceTradeId:observed.event.id,signalId:derived.id});
          pipelineCheck(plan.operator.data.sourceTradeId===observed.event.id&&plan.operator.data.signalId===derived.id
            && plan.operator.data.tokenMint===scope.tokenMint,'candidate plan altered committed source/signal');
          const delivery=fanout.delivery({sourceTradeId:observed.event.id,walletAddress:scope.masterWalletAddress,tokenMint:scope.tokenMint,
            side:stage,eventAt:new Date(observed.event.eventAt)},step.eligibility,step.poolTvlUsd);
          const descriptors=await delivery.prepare(plan);cancellation(signal);
          pipelineCheck(descriptors.length===1&&descriptors[0]!.data.userId===scope.userId&&descriptors[0]!.data.executionMode==='paper',
            'one exact owned follower and durable operator exclusion required');
          const descriptor=plainCapture(descriptors[0]!);
          // Read committed claim from independent reader; no canonical business SQL clone.
          const preparation=await observer.observe(scope,stage);
          const execution=preparation.executions.find(e=>e.id===descriptor.data.copyExecutionId);pipelineCheck(execution,'committed canonical execution absent');
          if(stage==='buy')pipelineCheck(execution.requestedBase===null&&execution.requestedQuote!==null,'truthful quote-budget buy required');
          await worker.registry.register(plainCapture(capability(execution)));cancellation(signal);
          if(stage==='buy'){await worker.risk.write(plainCapture(riskPolicy(execution)));cancellation(signal);}
          // Production enqueue repeats immutable prepare and resolves only after
          // its own checked fanout COMMIT. Enqueue failure leaves durable obligation.
          await delivery.enqueue(chain=>({add:async(name,data,options)=>{
            cancellation(signal);const queue=queueFor(chain);const accepted=await queue.add(name,plainCapture(data),plainCapture(options));
            cancellation(signal);return accepted;
          }}),plan);cancellation(signal);
          const result=await worker.run(descriptor.data);cancellation(signal);
          pipelineCheck(result.status==='paper-filled'||result.status==='already-executed','worker did not commit complete paper accounting');
          // Worker receipt query is comparison-only. Journal never substitutes it
          // for independent canonical read-only committed SQL observation.
          await worker.financialReceipt(descriptor.data);cancellation(signal);
          jobs.push(descriptor);snapshots.push(await observer.observe(scope,stage));
          return observed.event.id;
        }
        await execute(buy,'buy');const sellId=await execute(sell,'sell');
        await source.verify(sellId,reversal);cancellation(signal);snapshots.push(await observer.observe(scope,'reversal'));
        const reversalSnapshot=snapshots[2]!,buyExecution=reversalSnapshot.executions.find(e=>e.direction==='buy');
        pipelineCheck(buyExecution,'buy correction lineage absent');const original=reversalSnapshot.originals.find(f=>f.executionId===buyExecution.id);
        pipelineCheck(original,'immutable acquisition original absent');
        const correctionTerms=plainCapture(correction(original as unknown as PipelineSqlRow,buyExecution));
        pipelineCheck(correctionTerms.trusted.executionId===buyExecution.id&&correctionTerms.trusted.originalEvidenceId===original.id
          && correctionTerms.trusted.lineageSourceTradeId===buyExecution.sourceTradeId,'correction candidate changed immutable original/source');
        await worker.valuations.record(correctionTerms.trusted);cancellation(signal);
        const correctionCandidate=recoveryCandidate(reversalSnapshot,buyExecution,correctionTerms,new Date(input.worker.now()));
        const corrected=await worker.reconcileValuation(jobs[0]!.data,correctionCandidate);cancellation(signal);
        pipelineCheck(corrected.accountingComplete&&corrected.execution.state==='confirmed','correction did not commit complete effective accounting');
        snapshots.push(await observer.observe(scope,'correction'));
        // Canonical terminal replay + same immutable correction identity, never a
        // second source intake/derive or a fixture row rewrite.
        for(const job of jobs){const result=await worker.run(job.data);cancellation(signal);
          pipelineCheck(result.status==='already-executed','replay was not canonical terminal');}
        const replay=await worker.reconcileValuation(jobs[0]!.data,correctionCandidate);cancellation(signal);
        pipelineCheck(replay.replayed&&replay.accountingComplete,'correction replay was not immutable receipt-owned');
        snapshots.push(await observer.observe(scope,'replay'));
        const journal:ExecutedPipelineJournal={kind:'canonical-executed-paper-pipeline',scope,snapshots,
          runtimeAccepted:false,sourceComplete:false,liveCapabilityAccepted:false};
        const economics=reconcileExecutedPipelineJournal(journal);cancellation(signal);
        return {journal,economics};
      }finally{inFlight=false;}
    }
  });
}
