import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PIPELINE_OBSERVER_IDENTITY_SQL, PIPELINE_OBSERVER_TABLES, PIPELINE_SQL_OBSERVER_SOURCE_BLOCKERS,
  PIPELINE_PAPER_VALUATION_SCAN_SQL, PIPELINE_PAPER_RECEIPT_SCAN_SQL, PipelineObserverCommitUncertainError,
  createPipelineSqlObserver, createPipelineObserverReadTransaction, requirePipelineObserverIdentity,
  requirePipelineObserverEnrollment, requirePipelineObserverReadSql, decodePipelineSqlRows,
  decodePipelinePaperValuation, decodePipelinePaperReceipt } from './pipeline-sql-observer.js';
import { pipelineCanonical, type ExecutedPipelineScope } from './pipeline-economics.js';
import type { PipelinePaperValuationEvidence } from '../../../packages/db/src/wave4-pipeline-valuation-owned.js';
import type { PipelineWorkerPaperReceipt } from '../../../packages/db/src/wave4-pipeline-receipt-owned.js';

/** Inert physical reply/decode authoring, never PostgreSQL/RLS/ACL/enrollment or
 * runtime proof. No SQL runner, pool, loader subprocess, service or network. */
const USER='22222222-2222-4222-8222-222222222222',EXECUTION='11111111-1111-4111-8111-111111111111';
const scope:ExecutedPipelineScope={runId:EXECUTION,userId:USER,chain:'solana',network:`solana:wave4-${EXECUTION}`,
  namespace:`wave4/${EXECUTION}/pipeline`,tokenMint:'solana:inert-mint',targetAccount:'solana:inert-user',masterWalletAddress:'solana:inert-master'};
function identity() {
  return {role:'swat_pipeline_observer',session:'swat_pipeline_observer',role_setting:'none',row_security:'on',
    read_only:'on',isolation:'repeatable read',bypass:'off',tenant:'',worker:'',rolcanlogin:true,rolsuper:false,
    rolbypassrls:false,rolinherit:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,memberships:false,
    owns_objects:false,can_create:false,can_write:false,other_public_function:false,backend_pid:73,
    observed_at:new Date('2026-11-24T00:00:00.000Z'),search_path:'pg_catalog, public'};
}
function harness() {
  const row=identity(),calls:string[]=[],state={begin:'BEGIN',commit:'COMMIT',readCommand:'SELECT',identities:0,
    drift:false,hold:undefined as string|undefined,hook:undefined as undefined|((sql:string)=>void)};
  const never=new Promise<never>(()=>{});
  const query=vi.fn(async(sql:string)=>{
    calls.push(sql);state.hook?.(sql);if(sql===state.hold)return never;
    if(sql===PIPELINE_OBSERVER_IDENTITY_SQL){state.identities++;return {command:'SELECT',rows:[{...row,
      backend_pid:state.drift&&state.identities>2?74:row.backend_pid,observed_at:new Date(row.observed_at.getTime()+state.identities)}]};}
    return {command:sql.startsWith('BEGIN')?state.begin:sql==='COMMIT'?state.commit:sql==='ROLLBACK'?'ROLLBACK':state.readCommand,rows:[]};
  });
  const release=vi.fn(),client={query},acquire=vi.fn(async()=>({client,release}));
  return {row,calls,state,query,release,client,acquire};
}
function digest(value:unknown) {return createHash('sha256').update(pipelineCanonical(value)).digest('hex');}
function valuation(overrides:Partial<PipelinePaperValuationEvidence>={}) {
  const rawBody={executionId:EXECUTION,userId:USER,chain:'solana',
    tokenMint:scope.tokenMint,targetAccount:scope.targetAccount,executionMode:'paper',direction:'buy',requestedBase:null,
    requestedQuote:'20',authorityId:'inert-authority',providerId:'inert-provider',providerIdentity:'a'.repeat(64),
    verifierVersion:'inert-v1',network:scope.network,baseDecimals:18,sourceTradeId:'33333333-3333-4333-8333-333333333333',
    sourceEvidenceId:'inert-source-evidence',bindingDigest:'b'.repeat(64),rawQuantity:'9007199254740993000000000000000001',
    quantityScale:18,priceUsd:'3',quoteCurrency:'USD',evidenceId:'inert-paper-evidence',observedAt:'2026-11-24T00:00:00.000Z',
    expiresAt:'2026-11-24T00:00:30.000Z',simulationModelId:'inert-model',simulatedFeeBps:'0',simulatedFixedFeeUsd:'0',...overrides};
  const body=Object.fromEntries(Object.entries(rawBody).filter(([k])=>k!=='evidenceDigest')) as Omit<PipelinePaperValuationEvidence,'evidenceDigest'>;
  const terms={...body,evidenceDigest:digest(body)} as PipelinePaperValuationEvidence;
  return {terms,row:{execution_id:terms.executionId,user_id:terms.userId,evidence_id:terms.evidenceId,
    authority_id:terms.authorityId,source_trade_id:terms.sourceTradeId,source_evidence_id:terms.sourceEvidenceId,
    evidence_digest:terms.evidenceDigest,terms}};
}
function receipt() {
  const body:Omit<PipelineWorkerPaperReceipt,'receiptId'>={executionId:EXECUTION,userId:USER,chain:'solana',
    tokenMint:scope.tokenMint,targetAccount:scope.targetAccount,executionMode:'paper',workerFence:'7',policyRevision:'c'.repeat(64),
    riskEpoch:'2',paperValuationEvidenceId:'inert-paper-evidence',paperValuationDigest:valuation().terms.evidenceDigest,
    executor:'paper-exact-simulated',evidence:{executionId:EXECUTION,evidenceType:'paper_simulation',evidenceId:'inert-original',
      baseQuantity:'1',quoteLeg:null,priceUsd:null,feeUsd:null,confirmationState:'confirmed',completesExecution:true,
      occurredAt:'2026-11-24T00:00:01.000Z'}};
  const terms={...body,receiptId:digest(body)};
  return {terms,row:{receipt_id:terms.receiptId,execution_id:terms.executionId,user_id:terms.userId,worker_fence:terms.workerFence,
    evidence_id:terms.evidence.evidenceId,paper_valuation_evidence_id:terms.paperValuationEvidenceId,terms}};
}

describe('FROZEN independent pipeline SQL observer hostile inert cases, not acceptance',()=>{
  it('refuses missing SOURCE enrollment before physical acquire, regardless of role spelling',async()=>{
    const h=harness(),observer=createPipelineSqlObserver({acquire:h.acquire});
    expect(()=>observer.preflight(scope)).toThrow('SOURCE refusal');
    await expect(observer.observe(scope,'buy')).rejects.toThrow('SOURCE refusal');
    expect(()=>requirePipelineObserverEnrollment()).toThrow('SOURCE refusal');expect(h.acquire).not.toHaveBeenCalled();
    expect(PIPELINE_SQL_OBSERVER_SOURCE_BLOCKERS).toHaveLength(2);
    const named=createPipelineSqlObserver({acquire:h.acquire,role:'swat_approved_observer'});
    await expect(named.observe(scope,'buy')).rejects.toThrow('SOURCE refusal');expect(h.acquire).not.toHaveBeenCalled();
  });
  it('identity checks are comparison-only; clean identity and USING true cannot enroll a reader',()=>{
    expect(requirePipelineObserverIdentity([identity()],'swat_pipeline_observer',true)).toBe(73);
    const alleged={...identity(),relrowsecurity:true,relforcerowsecurity:true,using:'true',readable:true};
    expect(requirePipelineObserverIdentity([alleged],'swat_pipeline_observer',true)).toBe(73);
    expect(()=>requirePipelineObserverEnrollment()).toThrow('scoped read policies');
  });
  it.each(['session','role_setting','row_security','bypass','tenant','worker','memberships','owns_objects','can_create',
    'can_write','other_public_function','rolbypassrls','rolsuper','read_only','isolation','search_path','backend_pid'])
  ('refuses hostile identity %s',key=>{
    const row:Record<string,unknown>=identity();row[key]=typeof row[key]==='boolean'?true:typeof row[key]==='number'?0:'foreign';
    expect(()=>requirePipelineObserverIdentity([row],'swat_pipeline_observer',true)).toThrow('identity');
  });
  it('uses actual .terms columns and broad discovery without tenant-filter hiding',()=>{
    expect(PIPELINE_OBSERVER_TABLES).toContain('pipeline_paper_valuation_evidence');
    expect(PIPELINE_PAPER_VALUATION_SCAN_SQL).toContain('public.pipeline_paper_valuation_evidence');
    expect(PIPELINE_PAPER_VALUATION_SCAN_SQL).toContain("OR terms->>'tokenMint'=$2");
    expect(PIPELINE_PAPER_RECEIPT_SCAN_SQL).toContain('public.pipeline_worker_paper_receipts');
    expect(PIPELINE_PAPER_RECEIPT_SCAN_SQL).toContain('paper_valuation_evidence_id,terms');
    expect(PIPELINE_PAPER_VALUATION_SCAN_SQL).not.toContain('pipeline_paper_valuations');
    expect(PIPELINE_PAPER_RECEIPT_SCAN_SQL).not.toContain('user_id=$');
    expect(()=>requirePipelineObserverReadSql(PIPELINE_OBSERVER_IDENTITY_SQL)).not.toThrow();
    expect(()=>requirePipelineObserverReadSql("SELECT has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')")).not.toThrow();
  });
  it.each(['COMMIT','SELECT 1; COMMIT','SELECT "set_config"($1,$2,true)','SELECT $$inert$$',
    'UPDATE copy_executions SET state=$1','WITH changed AS (DELETE FROM trades RETURNING id) SELECT id FROM changed',
    'SELECT 1 /* unterminated',"SELECT 'unterminated"])
  ('refuses observer control/effect text %s',sql=>{expect(()=>requirePipelineObserverReadSql(sql)).toThrow();});
  it.each(['pg_advisory_lock','pg_try_advisory_lock','pg_advisory_lock_shared','pg_try_advisory_lock_shared',
    'pg_advisory_unlock','pg_advisory_unlock_shared','pg_advisory_unlock_all'])
  ('refuses persistent session advisory effects before dispatch: %s',async name=>{
    for(const callable of [name,`pg_catalog.${name}`,`"${name}"`,`pg_catalog."${name}"`,
      `"pg_catalog".${name}`,`"pg_catalog"."${name}"`,`"inert_schema"."${name.toUpperCase()}"`,
      `"pg_catalog" /* outer /* nested */ comment */ . "${name}" /* call */`]) {
      for(const args of name==='pg_advisory_unlock_all'?['']:['$1','$1,$2']) {
        const sql=`SELECT ${callable}(${args})`;
        expect(()=>requirePipelineObserverReadSql(sql)).toThrow('observer uncontrolled SQL refused');
        const h=harness(),sessionLocks=new Set(['prior']);
        // Inert model only: BEGIN/COMMIT/ROLLBACK do not clear session locks.
        // Neither acquiring a new lock nor unlocking a prior one may dispatch.
        h.state.hook=sent=>{if(sent===sql){if(name.startsWith('pg_advisory_unlock'))sessionLocks.delete('prior');else sessionLocks.add('new');}};
        await expect(createPipelineObserverReadTransaction({acquire:h.acquire})(async client=>{
          try {await client.query(sql,[1,2]);}catch{}return 'caught-session-effect';
        })).rejects.toThrow('escaped');
        expect(h.calls).not.toContain(sql);expect([...sessionLocks]).toEqual(['prior']);
        expect(h.calls).not.toContain('COMMIT');expect(h.calls).toContain('ROLLBACK');
        expect(h.release).toHaveBeenCalledWith(true);
      }
    }
  });
  it.each(['pg_advisory_xact_lock','pg_try_advisory_xact_lock','pg_advisory_xact_lock_shared','pg_try_advisory_xact_lock_shared'])
  ('retains the existing transaction advisory lexical policy, not enrollment: %s',async name=>{
    for(const callable of [name,`pg_catalog.${name}`,`"${name}"`,`pg_catalog."${name}"`,
      `"pg_catalog".${name}`,`"pg_catalog"."${name}"`,`"inert_schema"."${name.toUpperCase()}"`,
      `"pg_catalog" /* outer /* nested */ comment */ . "${name}" /* call */`]) {
      for(const args of ['$1','$1,$2']) {
        const sql=`SELECT ${callable}(${args})`,h=harness(),transactionLocks=new Set<string>();
        // Inert lifetime distinction only, not a PostgreSQL lock/ACL proof.
        h.state.hook=sent=>{if(sent===sql)transactionLocks.add('current');if(sent==='COMMIT'||sent==='ROLLBACK')transactionLocks.clear();};
        expect(()=>requirePipelineObserverReadSql(sql)).not.toThrow();
        expect(await createPipelineObserverReadTransaction({acquire:h.acquire})(async client=>{
          await client.query(sql,[1,2]);expect([...transactionLocks]).toEqual(['current']);return 'transport-only';
        })).toBe('transport-only');
        expect(h.calls).toContain(sql);expect(h.calls).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        expect(h.calls).toContain('COMMIT');expect([...transactionLocks]).toEqual([]);expect(h.release).toHaveBeenCalledWith(false);
        expect(()=>requirePipelineObserverEnrollment()).toThrow('SOURCE refusal');
      }
    }
  });
  it('treats advisory names in literals, comments and non-call identifiers as inert data',()=>{
    expect(()=>requirePipelineObserverReadSql(`SELECT 'pg_advisory_lock(1)',1 AS "pg_advisory_unlock_all"
      /* pg_advisory_unlock_all() /* pg_try_advisory_lock_shared(1) */ */ -- pg_advisory_lock_shared(1)
    `)).not.toThrow();
  });
  it('owns checked read-only repeatable-read BEGIN and checked COMMIT, without enrollment acceptance',async()=>{
    const h=harness(),read=createPipelineObserverReadTransaction({acquire:h.acquire});
    expect(await read(async client=>{await client.query('SELECT $1',['inert']);return 'transport-only';})).toBe('transport-only');
    expect(h.calls).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');expect(h.calls).toContain('COMMIT');
    expect(h.release).toHaveBeenCalledWith(false);expect(()=>requirePipelineObserverEnrollment()).toThrow('SOURCE refusal');
  });
  it('refuses failed BEGIN, non-readonly identity, SELECT outcome and final backend drift',async()=>{
    for(const mode of ['begin','readonly','select','drift']) {
      const h=harness();
      if(mode==='begin')h.state.begin='ROLLBACK';
      if(mode==='readonly')h.row.read_only='off';
      if(mode==='select')h.state.readCommand='UPDATE';
      if(mode==='drift')h.state.drift=true;
      await expect(createPipelineObserverReadTransaction({acquire:h.acquire})(async client=>{
        await client.query('SELECT 1');return true;
      })).rejects.toThrow();expect(h.calls).not.toContain('COMMIT');expect(h.release).toHaveBeenCalledWith(true);
    }
  });
  it('withholds observation for uncertain tag or cancellation during COMMIT',async()=>{
    for(const mode of ['tag','cancel','pending']) {
      const h=harness(),cancel=new AbortController();
      if(mode==='tag')h.state.commit='ROLLBACK';
      if(mode==='pending')h.state.hold='COMMIT';
      if(mode!=='tag')h.state.hook=sql=>{if(sql==='COMMIT')cancel.abort();};
      await expect(createPipelineObserverReadTransaction({acquire:h.acquire,signal:cancel.signal})(async()=>({inert:true})))
        .rejects.toBeInstanceOf(PipelineObserverCommitUncertainError);
      expect(h.release).toHaveBeenCalledWith(true);expect(h.calls).not.toContain('ROLLBACK');
    }
  });
  it('bounds a stalled query and destroys rather than waiting indefinitely for rollback',async()=>{
    vi.useFakeTimers();
    try {
      const h=harness();h.state.hold='SELECT 1';
      const promise=createPipelineObserverReadTransaction({acquire:h.acquire,maximumLifetimeMs:25})(client=>client.query('SELECT 1'));
      const rejection=expect(promise).rejects.toThrow();await vi.advanceTimersByTimeAsync(26);await rejection;
      expect(h.release).toHaveBeenCalledWith(true);expect(h.calls).not.toContain('COMMIT');
    }finally{vi.useRealTimers();}
  });
  it('poisons nested/overlapping reads even if the callback catches their failure',async()=>{
    const h=harness(),read=createPipelineObserverReadTransaction({acquire:h.acquire});
    await expect(read(async()=>{try{await read(async()=>undefined);}catch{}return true;})).rejects.toThrow('escaped');
    expect(h.calls).not.toContain('COMMIT');
    const other=harness();
    await expect(createPipelineObserverReadTransaction({acquire:other.acquire})(async client=>{
      await Promise.allSettled([client.query('SELECT 1'),client.query('SELECT 2')]);return true;
    })).rejects.toThrow('escaped');expect(other.calls).not.toContain('COMMIT');
  });
  it('bounds pre-aborted and late acquisitions and refuses escaped reads',async()=>{
    const h=harness(),cancel=new AbortController();cancel.abort();
    await expect(createPipelineObserverReadTransaction({acquire:h.acquire,signal:cancel.signal})(async()=>true)).rejects.toThrow();
    expect(h.acquire).not.toHaveBeenCalled();
    let finish!:(lease:{client:typeof h.client;release:typeof h.release})=>void;
    const pending=new Promise<{client:typeof h.client;release:typeof h.release}>(resolve=>{finish=resolve;}),lateCancel=new AbortController();
    const result=createPipelineObserverReadTransaction({acquire:()=>pending,signal:lateCancel.signal})(async()=>true);
    const rejection=expect(result).rejects.toThrow();await Promise.resolve();await Promise.resolve();lateCancel.abort();await rejection;
    finish({client:h.client,release:h.release});await Promise.resolve();await Promise.resolve();
    expect(h.query).not.toHaveBeenCalled();expect(h.release).toHaveBeenCalledWith(true);
    const other=harness();let escaped:any;
    await createPipelineObserverReadTransaction({acquire:other.acquire})(async client=>{escaped=client;return true;});
    await expect(escaped.query('SELECT 1')).rejects.toThrow('expired');
  });
  it('preserves raw SQL numeric scale/nulls/timestamps without mutating input rows',()=>{
    const original={base:'1.000000000000000000',quote:null,fee:null,at:new Date('2026-11-24T00:00:00.000Z')};
    expect(decodePipelineSqlRows({command:'SELECT',rows:[original]},1,['base','quote','fee']))
      .toEqual([{...original,at:'2026-11-24T00:00:00.000Z'}]);
    expect(original.at).toBeInstanceOf(Date);expect(original.base).toBe('1.000000000000000000');
  });
  it('refuses overflow/truncation, missing columns, float/undefined/accessor/cycle/sparse/deep replies',()=>{
    expect(()=>decodePipelineSqlRows({command:'SELECT',rows:[{},{}]},1)).toThrow('overflow');
    expect(()=>decodePipelineSqlRows({command:'UPDATE',rows:[]},1)).toThrow();
    expect(()=>decodePipelineSqlRows({command:'SELECT',rows:[{}]},1,['base'])).toThrow('missing');
    expect(()=>decodePipelineSqlRows({command:'SELECT',rows:[{base:0.1}]},1,['base'])).toThrow('text');
    expect(()=>decodePipelineSqlRows({command:'SELECT',rows:[{base:undefined}]},1)).toThrow();
    const getter=vi.fn();expect(()=>decodePipelineSqlRows({command:'SELECT',rows:[{get base(){return getter();}}]},1)).toThrow('accessor');
    expect(getter).not.toHaveBeenCalled();
    const cycle:any={};cycle.next=cycle;expect(()=>decodePipelineSqlRows({command:'SELECT',rows:[cycle]},1)).toThrow('acyclic');
    expect(()=>decodePipelineSqlRows({command:'SELECT',rows:[{values:new Array(2)}]},1)).toThrow('sparse');
    let deep:unknown=null;for(let i=0;i<66;i++)deep={next:deep};
    expect(()=>decodePipelineSqlRows({command:'SELECT',rows:[{deep}]},1)).toThrow('depth');
  });
  it('decodes protected sorted compact hashes, immutable physical column ties and exact source raw',()=>{
    const v=valuation(),r=receipt();
    expect(decodePipelinePaperValuation(v.row)).toEqual(v.terms);
    expect(decodePipelinePaperValuation(v.row).requestedBase).toBeNull();
    expect(decodePipelinePaperValuation(v.row).rawQuantity).toBe('9007199254740993000000000000000001');
    const decoded=decodePipelinePaperReceipt(r.row);
    expect(decoded.evidence.quoteLeg).toBeNull();expect(decoded.evidence.priceUsd).toBeNull();expect(decoded.evidence.feeUsd).toBeNull();
    expect(Object.isFrozen(decoded.evidence)).toBe(true);
    const {receiptId,...body}=r.terms;expect(receiptId).toBe(digest(body));
    expect(receiptId).not.toBe(createHash('sha256').update(JSON.stringify(body)).digest('hex'));
    expect(()=>decodePipelinePaperValuation({...v.row,execution_id:USER})).toThrow('columns');
    expect(()=>decodePipelinePaperReceipt({...r.row,worker_fence:'8'})).toThrow('columns');
  });
  it.each(['numeric-price','buy-base','raw','scale','extra','digest'])('refuses malformed protected valuation %s',mode=>{
    let v=valuation();
    if(mode==='numeric-price')v=valuation({priceUsd:3 as any});
    if(mode==='buy-base')v=valuation({requestedBase:'1'});
    if(mode==='raw')v=valuation({rawQuantity:'1e18'});
    if(mode==='scale')v=valuation({quantityScale:-1});
    if(mode==='extra') {const body:any={...v.terms,extra:'hostile'};delete body.evidenceDigest;v.row.terms={...body,evidenceDigest:digest(body)};v.row.evidence_digest=v.row.terms.evidenceDigest;}
    if(mode==='digest')v.row.terms={...v.terms,evidenceDigest:'f'.repeat(64)};
    expect(()=>decodePipelinePaperValuation(v.row)).toThrow();
  });
  it('refuses receipt omission, null substitution, foreign original and malformed nested evidence',()=>{
    const r=receipt();
    const bad:any={...r.terms,evidence:{...r.terms.evidence,feeUsd:undefined}};
    expect(()=>decodePipelinePaperReceipt({...r.row,terms:bad})).toThrow();
    expect(()=>decodePipelinePaperReceipt({...r.row,terms:{...r.terms,evidence:{...r.terms.evidence,feeUsd:'0'}}})).toThrow('digest');
    expect(()=>decodePipelinePaperReceipt({...r.row,evidence_id:'foreign'})).toThrow('columns');
    const body:any={...r.terms,evidence:{...r.terms.evidence,extra:'hostile'}};delete body.receiptId;
    const terms={...body,receiptId:digest(body)};
    expect(()=>decodePipelinePaperReceipt({...r.row,receipt_id:terms.receiptId,terms})).toThrow();
  });
});
