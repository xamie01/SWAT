import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EXECUTED_PIPELINE_SOURCE_STATUS, ExecutedPipelineCommitUncertainError,
  createExecutedPipelineRuntimeTransaction, reconstructPipelineValuationSettlement,
  requireExecutedPipelineRuntimeSql, requireExecutedPipelineReversedReplay } from './pipeline-executed.js';
import { createPipelineLifetime, pipelineCanonical, pipelineFinancialReceiptDigest,
  executedOriginalSnapshot, exactPipelineDecimal, pipelineExactText, foldProtectedPaperTerms,
  type ExecutedExecution, type ExecutedOriginalEvidence, type ExecutedPipelineSnapshot,
  type PipelineRawFinancialSnapshot } from './pipeline-economics.js';
import type { PipelineTrustedWorkerValuation } from '../../../packages/db/src/wave4-pipeline-valuation-owned.js';

/** Authored inert cases only. No pool, service, network, SQL execution, credentials,
 * loader subprocess, business-body mock or runtime/DB isolation acceptance. */
function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};
}
function runtimeHarness() {
  const identity={role:'swat_app',session:'swat_app',role_setting:'none',row_security:'on',rolcanlogin:true,
    rolsuper:false,rolbypassrls:false,rolinherit:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,
    memberships:false,owns_objects:false,can_create:false,backend_pid:41,search_path:'pg_catalog, public'};
  const calls:string[]=[],state={begin:'BEGIN',commit:'COMMIT',identityCount:0,drift:false,
    hook:undefined as undefined|((sql:string)=>void),hold:undefined as undefined|string};
  const never=new Promise<never>(()=>{});
  const query=vi.fn(async(sql:string)=>{
    calls.push(sql);state.hook?.(sql);
    if(sql===state.hold)return never;
    if(sql.includes('FROM pg_catalog.pg_roles r')) {
      state.identityCount++;return {command:'SELECT',rows:[{...identity,backend_pid:state.drift&&state.identityCount>1?42:identity.backend_pid}]};
    }
    return {command:sql.startsWith('BEGIN')?state.begin:sql==='COMMIT'?state.commit:sql==='ROLLBACK'?'ROLLBACK':'SELECT',rows:[]};
  });
  const release=vi.fn(),client={query} as any,acquire=vi.fn(async()=>({client,release}));
  return {identity,calls,state,query,release,client,acquire};
}
function financial():PipelineRawFinancialSnapshot {
  return {executionId:'inert-execution',userId:'inert-user',tradeId:'inert-trade',fence:'7',totals:{
    base:'1.000000000000000000',quote:'9007199254740993.000000000000000001',debit:'9007199254740993.000000000000000002',
    fee:'0.000000000000000001',unknown:'0',quoteUnknown:'0',completes:true,evidenceCount:'1',invalidCorrections:'0'},accountingComplete:true};
}
function recovery(knownQuote=false) {
  const user='22222222-2222-4222-8222-222222222222',source='33333333-3333-4333-8333-333333333333';
  const execution:ExecutedExecution={id:'11111111-1111-4111-8111-111111111111',userId:user,sourceTradeId:source,
    signalId:'44444444-4444-4444-8444-444444444444',chain:'solana',tokenMint:'solana:inert-mint',targetAccount:'solana:inert-account',
    executionMode:'paper',direction:'buy',state:'confirmed',clientOrderId:'inert-order',exitLotId:null,exitTrigger:null,
    reservedBase:'0',submissionAttempts:1,maxSubmissionAttempts:3,simulationId:'inert-simulation',submissionType:null,submissionId:null,
    nextReconciliationAt:null,reconciliationClaimId:null,reconciliationAttempts:0,maxReconciliationAttempts:3,
    requestedBase:null,requestedQuote:'20',confirmedBase:'1.000000000000000000',confirmedQuote:knownQuote?'20.000000000000000000':null,
    quoteUnknown:knownQuote?'0':'1',
    sourcePositionBefore:null,sourceSellFraction:null};
  const original:ExecutedOriginalEvidence={id:'55555555-5555-4555-8555-555555555555',executionId:execution.id,userId:user,
    sourceTradeId:source,evidenceType:'paper_simulation',evidenceId:'inert-original',base:'1.000000000000000000',
    quote:knownQuote?'20.000000000000000000':null,nativeQuote:knownQuote?'20.000000000000000000':null,
    quoteCurrency:knownQuote?'USD':null,nativePrice:knownQuote?'1.000000000000000000':null,
    price:knownQuote?'20.000000000000000000':null,fee:null,occurredAt:'2026-11-24T00:00:00.000Z',
    completes:true,confirmationState:'confirmed'};
  const snapshot={executions:[execution],originals:[original],attempts:[{execution_id:execution.id,user_id:user,state:'settled',
    fence:'7',policy_revision:'a'.repeat(64),risk_epoch:'2'}],
    policies:[{execution_id:execution.id,user_id:user,chain:execution.chain,target_account:execution.targetAccount,
      token_mint:execution.tokenMint,master_wallet_address:'solana:inert-master',execution_mode:'paper',snapshot:{
        policyId:'b'.repeat(64),revision:'a'.repeat(64),maxSlippageBps:125,
        scope:{account:user,chain:execution.chain,tokenMint:execution.tokenMint,
          masterWalletAddress:'solana:inert-master'}}}],
    trades:[{id:'inert-trade',copy_execution_id:execution.id,user_id:user,chain:execution.chain,token_mint:execution.tokenMint,
      execution_mode:'paper',direction:'buy',signal_id:execution.signalId,source_trade_id:source,status:'filled',slippage_bps:250}],
    risk:[{execution_id:execution.id,account:user,chain:execution.chain,execution_mode:'paper',policy_epoch:'2',state:'confirmed'}],
    riskPolicies:[{account:user,chain:execution.chain,execution_mode:'paper',epoch:'3',enabled:false}],
    deliveries:[{execution_id:execution.id,user_id:user,signal_id:execution.signalId,execution_mode:'paper',
      target_account:execution.targetAccount,state:'completed',fence:'11',lease_owner:null,job_id:'inert-job',descriptor:{
        data:{copyExecutionId:execution.id,userId:user,signalId:execution.signalId,sourceTradeId:source,chain:execution.chain,
          tokenMint:execution.tokenMint,targetAccount:execution.targetAccount,executionMode:'paper'},options:{jobId:'inert-job'}}}],
    paperValuations:[{executionId:execution.id,userId:user,chain:execution.chain,tokenMint:execution.tokenMint,
      targetAccount:execution.targetAccount,sourceTradeId:source,requestedBase:null,requestedQuote:'20',
      evidenceId:'inert-protected',evidenceDigest:'d'.repeat(64),priceUsd:'20',simulatedFixedFeeUsd:'1'}],
    paperReceipts:[{executionId:execution.id,userId:user,chain:execution.chain,tokenMint:execution.tokenMint,
      targetAccount:execution.targetAccount,executionMode:'paper',workerFence:'7',policyRevision:'a'.repeat(64),riskEpoch:'2',
      paperValuationEvidenceId:'inert-protected',paperValuationDigest:'d'.repeat(64),executor:'paper-exact-simulated',evidence:{
        executionId:execution.id,evidenceType:'paper_simulation',evidenceId:original.evidenceId,baseQuantity:'1',
        quoteLeg:knownQuote?{amount:'20',currency:'USD'}:null,priceUsd:knownQuote?'20':null,
        feeUsd:null,confirmationState:'confirmed',completesExecution:true,occurredAt:original.occurredAt}}]};
  const correction={correctionId:'inert-correction',previousCorrectionId:null,
    trusted:{executionId:execution.id,userId:user,originalEvidenceId:original.id,lineageSourceTradeId:source,
      valuationId:'inert-trusted',quoteUsd:'20',feeUsd:'1'} as PipelineTrustedWorkerValuation};
  return {execution,original,snapshot:snapshot as unknown as ExecutedPipelineSnapshot,correction,
    now:new Date('2026-11-24T00:00:01.000Z')};
}

describe('FROZEN executed pipeline hostile inert authoring cases, not acceptance',()=>{
  it('never raises source or runtime acceptance flags',()=>{
    expect(EXECUTED_PIPELINE_SOURCE_STATUS).toEqual({sourceComplete:false,runtimeAccepted:false,
      liveCapabilityAccepted:false,publicExercisePaperPipelineEnabled:false});
  });
  it('allows supported canonical UPDATE SET without allowing transaction or scope commands',()=>{
    expect(()=>requireExecutedPipelineRuntimeSql("UPDATE source_fanout_deliveries SET state=$1 WHERE execution_id=$2")).not.toThrow();
    expect(()=>requireExecutedPipelineRuntimeSql("WITH changed AS (UPDATE copy_executions SET state=$1 RETURNING id) SELECT id FROM changed")).not.toThrow();
    expect(()=>requireExecutedPipelineRuntimeSql("SELECT '; COMMIT set_config(' AS inert /* nested /* SET ROLE */ comment */")).not.toThrow();
    expect(()=>requireExecutedPipelineRuntimeSql("SELECT set_config('app.worker_execution_id', $1, true)")).not.toThrow();
  });
  it.each([
    'INSERT INTO copy_execution_worker_attempts (execution_id) VALUES ($1) ON CONFLICT (execution_id) DO NOTHING RETURNING fence::text',
    'INSERT INTO source_fanout_batches (signal_id) VALUES ($1) ON CONFLICT (signal_id) DO UPDATE SET updated_at=source_fanout_batches.updated_at RETURNING signal_id',
    'INSERT INTO copy_execution_financial_receipts (receipt_id) VALUES ($1) ON CONFLICT DO NOTHING',
    'INSERT INTO inert (id) VALUES ($1) ON CONFLICT ON CONSTRAINT inert_key DO UPDATE SET id=$1',
    'INSERT INTO inert (id) VALUES ($1) ON CONFLICT (id) WHERE id IS NOT NULL DO NOTHING',
    'INSERT INTO inert (id) SELECT id FROM retained ON CONFLICT (id) DO NOTHING',
    'WITH persisted AS (INSERT INTO inert (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id) SELECT id FROM persisted',
    'INSERT INTO inert (id) VALUES ($1) ON /* inert DO */ CONFLICT (id) DO /* nested /* comment */ */ UPDATE SET id=$1'
  ])('allows contained canonical upsert %s',sql=>{expect(()=>requireExecutedPipelineRuntimeSql(sql)).not.toThrow();});
  it.each(['pg_advisory_xact_lock','pg_try_advisory_xact_lock','pg_advisory_xact_lock_shared','pg_try_advisory_xact_lock_shared'])
  ('retains transaction-lifetime advisory function %s',name=>{
    expect(()=>requireExecutedPipelineRuntimeSql(`SELECT pg_catalog.${name}(hashtextextended($1, 0))`)).not.toThrow();
  });
  it.each(['pg_advisory_lock','pg_try_advisory_lock','pg_advisory_lock_shared','pg_try_advisory_lock_shared',
    'pg_advisory_unlock','pg_advisory_unlock_shared','pg_advisory_unlock_all'])
  ('refuses session-lifetime advisory function %s',name=>{
    for(const sql of [`SELECT ${name}($1)`,`SELECT "pg_catalog"."${name}"($1)`,
      `SELECT pg_catalog.${name.toUpperCase()} /* inert */ ($1)`])
      expect(()=>requireExecutedPipelineRuntimeSql(sql)).toThrow();
    expect(()=>requireExecutedPipelineRuntimeSql(`SELECT '${name}($1)' AS inert`)).not.toThrow();
  });
  it.each(['BEGIN','COMMIT','ROLLBACK','SAVEPOINT x','SET ROLE swat_app','RESET ALL','SELECT 1; COMMIT',
    'DO $body$ BEGIN PERFORM 1; END $body$','SELECT 1 DO NOTHING',
    'INSERT INTO inert (id) VALUES ($1) DO NOTHING',
    'INSERT INTO inert (id) VALUES ($1) ON CONFLICT (id) DO UPDATE id=$1',
    'INSERT INTO inert (id) VALUES ($1) ON CONFLICT (id) DO CALL inert()',
    'INSERT INTO inert (id) VALUES ($1) ON CONFLICT (id) DO NOTHING DO NOTHING',
    'WITH persisted AS (INSERT INTO inert (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id) SELECT id FROM persisted DO NOTHING',
    'SELECT (INSERT INTO inert (id) VALUES ($1)) ON CONFLICT (id) DO NOTHING',
    'SELECT $$inert$$','SELECT "set_config"($1,$2,true)',"SELECT set_config('app.bypass_rls','on',true)",
    "UPDATE copy_executions SET state=$1; SET ROLE swat_app",'SELECT 1 /* unterminated',"SELECT 'unterminated"])
  ('refuses hostile operation %s',sql=>{expect(()=>requireExecutedPipelineRuntimeSql(sql)).toThrow();});
  it('checks actual BEGIN and COMMIT on the same physical lease',async()=>{
    const h=runtimeHarness(),transaction=createExecutedPipelineRuntimeTransaction(h.acquire);
    expect(await transaction(async client=>{await client.query('SELECT $1',['inert']);return 'transport-only';})).toBe('transport-only');
    expect(h.calls.filter(sql=>sql.startsWith('BEGIN'))).toEqual(['BEGIN ISOLATION LEVEL READ COMMITTED']);
    expect(h.calls.filter(sql=>sql==='COMMIT')).toHaveLength(1);expect(h.release).toHaveBeenCalledWith(false);
  });
  it.each(['role','session','role_setting','row_security','memberships','owns_objects','can_create','rolbypassrls'])
  ('refuses direct runtime identity drift in %s before BEGIN',async key=>{
    const h=runtimeHarness();(h.identity as Record<string,unknown>)[key]=typeof(h.identity as Record<string,unknown>)[key]==='boolean'?true:'foreign';
    await expect(createExecutedPipelineRuntimeTransaction(h.acquire)(async()=>undefined)).rejects.toThrow('identity');
    expect(h.calls.some(sql=>sql.startsWith('BEGIN'))).toBe(false);expect(h.release).toHaveBeenCalledWith(true);
  });
  it('refuses failed BEGIN and final backend drift without success',async()=>{
    const h=runtimeHarness();h.state.begin='ROLLBACK';
    await expect(createExecutedPipelineRuntimeTransaction(h.acquire)(async()=>true)).rejects.toThrow('BEGIN');
    expect(h.calls).not.toContain('COMMIT');
    const drift=runtimeHarness();drift.state.drift=true;
    await expect(createExecutedPipelineRuntimeTransaction(drift.acquire)(async()=>true)).rejects.toThrow('backend changed');
    expect(drift.calls).toContain('ROLLBACK');expect(drift.calls).not.toContain('COMMIT');
  });
  it('never acknowledges uncertain or cancellation-during-COMMIT outcomes',async()=>{
    for(const mode of ['tag','cancel','pending']) {
      const h=runtimeHarness(),cancel=new AbortController();
      if(mode==='tag')h.state.commit='ROLLBACK';
      if(mode==='pending')h.state.hold='COMMIT';
      if(mode!=='tag')h.state.hook=sql=>{if(sql==='COMMIT')cancel.abort();};
      await expect(createExecutedPipelineRuntimeTransaction(h.acquire,cancel.signal)(async()=>true))
        .rejects.toBeInstanceOf(ExecutedPipelineCommitUncertainError);
      expect(h.release).toHaveBeenCalledWith(true);expect(h.calls).not.toContain('ROLLBACK');
    }
  });
  it('poisons caught nested and overlapping query attempts',async()=>{
    const h=runtimeHarness(),transaction=createExecutedPipelineRuntimeTransaction(h.acquire);
    await expect(transaction(async()=>{try{await transaction(async()=>undefined);}catch{}return true;})).rejects.toThrow('escaped callback');
    expect(h.calls).not.toContain('COMMIT');
    const other=runtimeHarness();
    await expect(createExecutedPipelineRuntimeTransaction(other.acquire)(async client=>{
      await Promise.allSettled([client.query('SELECT 1'),client.query('SELECT 2')]);return true;
    })).rejects.toThrow('escaped callback');expect(other.calls).not.toContain('COMMIT');
  });
  it('bounds acquisition and destroys a late owned lease without querying it',async()=>{
    const late=deferred<{client:any;release:(broken:boolean)=>void}>();
    const cancel=new AbortController(),release=vi.fn(),query=vi.fn();
    const operation=createExecutedPipelineRuntimeTransaction(()=>late.promise,cancel.signal)(async()=>true);
    const rejection=expect(operation).rejects.toThrow();await Promise.resolve();await Promise.resolve();cancel.abort();await rejection;
    late.resolve({client:{query},release});await Promise.resolve();await Promise.resolve();
    expect(query).not.toHaveBeenCalled();expect(release).toHaveBeenCalledWith(true);
  });
  it('bounds a callback that never settles and refuses an escaped query',async()=>{
    vi.useFakeTimers();
    try {
      const h=runtimeHarness(),promise=createExecutedPipelineRuntimeTransaction(h.acquire,undefined,25)(async()=>new Promise<never>(()=>{}));
      const rejection=expect(promise).rejects.toThrow();await vi.advanceTimersByTimeAsync(26);await rejection;
      expect(h.release).toHaveBeenCalledWith(true);expect(h.calls).not.toContain('COMMIT');
    }finally{vi.useRealTimers();}
    const h=runtimeHarness();let escaped:any;
    await createExecutedPipelineRuntimeTransaction(h.acquire)(async client=>{escaped=client;return true;});
    await expect(escaped.query('SELECT 1')).rejects.toThrow('expired');
  });
  it('does not release a conflicting physical checkout belonging to another lifetime',async()=>{
    const h=runtimeHarness(),first=createPipelineLifetime(),second=createPipelineLifetime();
    try {
      const lease=await first.acquire(h.acquire);
      await expect(second.acquire(h.acquire)).rejects.toThrow('reuse');expect(h.release).not.toHaveBeenCalled();
      lease.release(false);expect(h.release).toHaveBeenCalledTimes(1);
    }finally{first.dispose();second.dispose();}
  });
  it('hashes SQL080 ordered fields using raw NUMERIC text, not jsonb key order or normalized numbers',()=>{
    const snapshot=financial(),expected=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const reordered={accountingComplete:snapshot.accountingComplete,totals:Object.fromEntries(Object.entries(snapshot.totals).reverse()),
      fence:snapshot.fence,tradeId:snapshot.tradeId,userId:snapshot.userId,executionId:snapshot.executionId} as unknown as PipelineRawFinancialSnapshot;
    expect(pipelineFinancialReceiptDigest(reordered)).toBe(expected);
    expect(expected).not.toBe(createHash('sha256').update(pipelineCanonical(snapshot)).digest('hex'));
    expect(pipelineFinancialReceiptDigest({...snapshot,totals:{...snapshot.totals,base:'1'}})).not.toBe(expected);
    const {invalidCorrections,...missing}=snapshot.totals;
    expect(()=>pipelineFinancialReceiptDigest({...snapshot,totals:missing} as any)).toThrow('exact fields');
    expect(()=>pipelineFinancialReceiptDigest({...snapshot,extra:'hostile'} as any)).toThrow('exact fields');
  });
  it('keeps exact values beyond Number precision and quote-sized buy base null',()=>{
    expect(pipelineExactText(exactPipelineDecimal('9007199254740993.000000000000000001'))).toBe('9007199254740993.000000000000000001');
    const terms={direction:'buy' as const,requestedBase:null,requestedQuote:'20',baseDecimals:18,priceUsd:'3',
      simulatedFeeBps:'0',simulatedFixedFeeUsd:'0.000000000000000001'};
    expect(foldProtectedPaperTerms(terms).base).toBe('6.666666666666666666');expect(terms.requestedBase).toBeNull();
    expect(()=>foldProtectedPaperTerms({...terms,requestedBase:'1'})).toThrow('null base');
  });
  it('reconstructs candidate recovery from independent persisted fields without filling null originals',()=>{
    const f=recovery(),before=pipelineCanonical(f.snapshot);
    const candidate=reconstructPipelineValuationSettlement(f.snapshot,f.execution,f.correction,f.now);
    expect(candidate.evidence.quoteLeg).toBeNull();expect(candidate.evidence.priceUsd).toBeNull();expect(candidate.evidence.feeUsd).toBeNull();
    expect(candidate.evidence.baseQuantity).toBe('1');expect(candidate.attempt.policyRevision).toBe('a'.repeat(64));
    expect(candidate.attempt.riskEpoch).toBe('2');expect(candidate.slippageBps).toBe(125);
    expect((f.snapshot.trades[0] as any).slippage_bps).toBe(250);
    expect(candidate.attempt.fence).toBe('7');expect(candidate.delivery?.claim.fence).toBe('11');
    expect(candidate.delivery?.claim.owner).toBe('receipt-owned-recovery');expect(pipelineCanonical(f.snapshot)).toBe(before);
    const originalSnapshot=executedOriginalSnapshot(f.original);
    expect(originalSnapshot.quoteQuantity).toBeNull();expect(originalSnapshot.priceUsd).toBeNull();expect(originalSnapshot.feeUsd).toBeNull();
  });
  it('retains canonical original USD amount/USD/1 while preserving receipt decimal bytes',()=>{
    const f=recovery(true),before=pipelineCanonical(f.snapshot);
    const candidate=reconstructPipelineValuationSettlement(f.snapshot,f.execution,f.correction,f.now);
    expect(candidate.evidence.quoteLeg).toEqual({amount:'20',currency:'USD'});
    expect(candidate.evidence.priceUsd).toBe('20');expect(candidate.evidence.feeUsd).toBeNull();
    expect(candidate.delivery?.claim.fence).toBe('11');expect(candidate.attempt.fence).toBe('7');
    expect(pipelineCanonical(f.snapshot)).toBe(before);
  });
  it.each([
    [true,'nativeQuote',null],[true,'nativeQuote','21'],[true,'nativePrice',null],[true,'nativePrice','0'],
    [true,'quoteCurrency',null],[true,'quoteCurrency','EUR'],[true,'quote',null],
    [false,'nativeQuote','0'],[false,'nativePrice','1'],[false,'quoteCurrency','USD'],[false,'quote','0']
  ] as const)('refuses noncanonical original quote shape known=%s %s=%s',(knownQuote,key,value)=>{
    const f=recovery(knownQuote);(f.original as any)[key]=value;
    expect(()=>reconstructPipelineValuationSettlement(f.snapshot,f.execution,f.correction,f.now)).toThrow();
  });
  it.each([undefined,null,-1,0.5,5001,'125',NaN])('refuses missing/invalid historical captured slippage %s',value=>{
    const f=recovery(),s=f.snapshot as any;s.policies[0].snapshot.maxSlippageBps=value;
    expect(()=>reconstructPipelineValuationSettlement(f.snapshot,f.execution,f.correction,f.now)).toThrow('captured slippage');
  });
  it.each([0,5000])('accepts bounded historical captured slippage %s without trade fallback',value=>{
    const f=recovery();(f.snapshot.policies[0]!.snapshot as any).maxSlippageBps=value;
    expect(reconstructPipelineValuationSettlement(f.snapshot,f.execution,f.correction,f.now).slippageBps).toBe(value);
  });
  it.each(['attempts','deliveries'] as const)('validates the independent persisted %s fence',collection=>{
    for(const fence of ['0','-1','01','1.0','9223372036854775808',7,null]) {
      const f=recovery();(f.snapshot[collection][0] as any).fence=fence;
      expect(()=>reconstructPipelineValuationSettlement(f.snapshot,f.execution,f.correction,f.now)).toThrow();
    }
  });
  it('requires canonical reversed-source refusal and an unchanged independent snapshot',()=>{
    const f=recovery(),before={...f.snapshot,stage:'reversal' as const},after={...before};
    const refused={status:'skipped',reason:'owned-execution-context-unavailable'};
    expect(()=>requireExecutedPipelineReversedReplay(refused,before,after)).not.toThrow();
    for(const result of [{status:'already-executed'}, {status:'paper-filled'},
      {status:'skipped',reason:'different-refusal'}, {status:'submitted',reason:refused.reason}])
      expect(()=>requireExecutedPipelineReversedReplay(result,before,after)).toThrow('canonical context');
    expect(()=>requireExecutedPipelineReversedReplay(refused,{...before,stage:'sell'},after)).toThrow('observation');
    for(const changed of [
      {...after,executions:[{...f.execution,submissionAttempts:2}]},
      {...after,originals:[{...f.original,fee:'0'}]},
      {...after,deliveries:[{...after.deliveries[0],fence:'12'}]},
      {...after,risk:[{...after.risk[0],state:'unknown'}]},
      {...after,financialReceipts:[{receipt_id:'unexpected'}]}
    ])expect(()=>requireExecutedPipelineReversedReplay(refused,before,changed)).toThrow('durable rows');
  });
  it.each(['candidate','duplicate-attempt','policy','revision','risk','receipt-null','worker-fence','delivery',
    'delivery-identity','delivery-user','delivery-signal','delivery-target','delivery-mode','slippage','counter','correction'])
  ('refuses hostile persisted recovery %s',mode=>{
    const f=recovery(),s=f.snapshot as any;let candidate=f.execution,correction=f.correction;
    if(mode==='candidate')candidate={...candidate,targetAccount:'solana:foreign'};
    if(mode==='duplicate-attempt')s.attempts.push({...s.attempts[0]});
    if(mode==='policy')s.policies[0].snapshot.scope.account='foreign';
    if(mode==='revision')s.policies[0].snapshot.revision='c'.repeat(64);
    if(mode==='risk')s.risk[0].policy_epoch='3';
    if(mode==='receipt-null')s.paperReceipts[0].evidence.feeUsd='0';
    if(mode==='worker-fence')s.paperReceipts[0].workerFence='11';
    if(mode==='delivery')s.deliveries[0].descriptor.options.jobId='foreign';
    if(mode==='delivery-identity')s.deliveries[0].execution_id='foreign';
    if(mode==='delivery-user')s.deliveries[0].user_id='foreign';
    if(mode==='delivery-signal')s.deliveries[0].signal_id='foreign';
    if(mode==='delivery-target')s.deliveries[0].target_account='foreign';
    if(mode==='delivery-mode')s.deliveries[0].execution_mode='live';
    if(mode==='slippage')s.trades[0].slippage_bps=0.5;
    if(mode==='counter')s.executions[0].maxReconciliationAttempts=NaN;
    if(mode==='correction')correction={...correction,trusted:{...correction.trusted,originalEvidenceId:'foreign'}};
    expect(()=>reconstructPipelineValuationSettlement(f.snapshot,candidate,correction,f.now)).toThrow();
  });
});
