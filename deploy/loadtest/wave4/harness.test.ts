import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { base58, plan, sampleIndices, stages, validateConfig } from './core.mjs';
import { evaluate, requiredThresholds } from './report.mjs';

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
function config() {
  const c = JSON.parse(source('config.example.json'));
  c.authorization = 'AUTHORIZED_DISPOSABLE_WAVE4_LOAD';
  for (const key of Object.keys(c.attestations)) c.attestations[key] = true;
  for (const evidence of c.evidence) evidence.sha256 = 'a'.repeat(64);
  return c;
}
function sample(at: number, c = config()) {
  return {
    at:new Date(at).toISOString(),collectionMs:10,
    pg:{ database:{started:'unchanged',stats_reset:null,xact_commit:1,xact_rollback:0,blks_read:1,blks_hit:1,tup_inserted:1,tup_updated:1,tup_deleted:0,deadlocks:0,temp_bytes:0,blk_read_time:0,blk_write_time:0},statementReset:{stats_reset:'unchanged'},statements:[],blockers:[] },
    pgbouncer:{pools:[{cl_waiting:0}]},
    redis:{memory:{used_memory:100,used_memory_rss:120,mem_fragmentation_ratio:1.2},stats:{evicted_keys:0,rejected_connections:0,total_error_replies:0},persistence:{rdb_last_bgsave_status:'ok',aof_last_write_status:'ok'}},
    queues:c.queues.map((queue: string) => ({queue,counts:{wait:0,active:0,paused:0,prioritized:0,delayed:0,completed:0,failed:0,'waiting-children':0},oldestSampledAgeMs:0,recentEventSample:{},jobSequence:'0'})),
    host:{memoryKb:{MemTotal:1000,MemAvailable:500},vm:{oom_kill:'0'}},
    processes:c.processes.map((p: any) => ({name:p.name,pid:p.pid,startTicks:'1',rssKb:100,userTicks:1,systemTicks:1,cgroup:{'memory.events':'oom 0\noom_kill 0'}}))
  };
}
function evidence() {
  const c = config(), start=1700000000000, end=start+27*60000;
  const samples = Array.from({length:170},(_,i) => sample(start-10000+i*10000,c));
  samples.at(-1)!.at = new Date(end+60000).toISOString();
  for (const s of samples) if (Date.parse(s.at)>start+15000 && Date.parse(s.at)<end-15000) s.processes.push({name:'generator',pid:999,startTicks:'1',rssKb:100,userTicks:1,systemTicks:1,cgroup:{'memory.events':'oom 0\noom_kill 0'}});
  for (const q of samples.at(-1)!.queues) q.jobSequence='8000';
  const metrics: any = {vus:{values:{max:9000}}};
  for (const [name,predicates] of Object.entries(requiredThresholds(c))) metrics[name]={thresholds:Object.fromEntries(predicates.map(p => [p,{ok:true}]))};
  for (const lane of ['wallet','token']) metrics[`queue_admitted{lane:${lane}}`].values={count:8000};
  return {c,summary:{metrics},samples,collector:{ok:true},lifecycle:{start:new Date(start).toISOString(),end:new Date(end).toISOString()}};
}
function assess(e = evidence()) { return evaluate(e.summary,e.samples,e.collector,e.c,0,e.lifecycle); }

function workload(readPercent=80) {
  const observations: any[] = [], requests: any[] = [];
  let random=0;
  class Metric { name: string; constructor(name: string) {this.name=name;} add(value: any,tags: any) {observations.push({name:this.name,value,tags});} }
  const identity={id:'fixture',token:'fixture-token',csrf:'fixture-csrf',historyWallet:'solana:owned',queueWallet:'fixture-wallet',queueToken:'fixture-token-mint'};
  const math=Object.create(Math); math.random=() => random;
  const exec={vu:{idInTest:1},instance:{currentTestRunDuration:200000,vusActive:2000}};
  const context:any={http:{request:(method: string,url: string,body: any,params: any) => {
    requests.push({method,url,body,params});
    return {status:method==='POST'?201:200,timings:{duration:10},json:() => ({wallets:[{}],events:[{}],signals:[{}],transactions:[{}],backfillQueued:true,watch:{id:'watch'}})};
  }},SharedArray:class {constructor(_name: string,loader: any){return loader();}},open:(path: string) => JSON.stringify(path==='config'?{baseUrl:'http://fixture',readPercent,secondRamp:'2m',stages:stages(),readP95Ms:750,writeP95Ms:1500,minQueueAdmissions:8000}:[identity]),__ENV:{WAVE4_WORKLOAD:'config',WAVE4_IDENTITIES:'identities',WAVE4_SUMMARY:'summary'},Counter:Metric,Rate:Metric,Trend:Metric,exec,Math:math,sleep:()=>{},fail:(message: string)=>{throw new Error(message);}};
  const code=source('workload.js').replace(/^import .*;\n/gm,'').replace('export const options','globalThis.options').replace('export default function ()','globalThis.iteration = function ()').replace('export function handleSummary','globalThis.handleSummary = function');
  vm.runInNewContext(code,context);
  return {context,observations,requests,pick:(percent: number)=>{random=percent/100;context.iteration();}};
}

describe('Wave4 offline load harness contracts',() => {
  it('keeps the requested sampled population and honest peak separate',() => {expect(plan()).toMatchObject({seededUsers:100000,sampledIdentities:10000,peakVus:9000,reserveIdentities:1000,runtimeAccepted:false});});
  it('preserves both requested holds and gradual additional users',() => {expect(stages()).toEqual([{duration:'3m',target:2000},{duration:'5m',target:2000},{duration:'2m',target:9000},{duration:'15m',target:9000},{duration:'2m',target:0}]);});
  it('samples without replacement using bounded partial shuffle',() => {const draw=(low: number,high: number)=>high-1;expect(new Set(sampleIndices(100000,10000,draw)).size).toBe(10000);});
  it.each([[1,2],[1,0],[1,1.5]])('rejects invalid sampling %s/%s',(size,count)=>{expect(()=>sampleIndices(size,count)).toThrow();});
  it('encodes synthetic public address bytes without signing keys',()=>{expect(base58(new Uint8Array(32))).toBe('1'.repeat(32));expect(base58(new Uint8Array([1]))).toBe('2');});
  it('rejects the deliberately unauthorized template',()=>{expect(()=>validateConfig(JSON.parse(source('config.example.json')))).toThrow();});
  it('accepts explicit isolated configuration',()=>{expect(validateConfig(config()).sampleCount).toBe(10000);});
  it.each(['path','sentinels','connectionString','options'])('rejects indirect Redis destination %s',key=>{const c=config();c.redis[key]='unapproved';expect(()=>validateConfig(c)).toThrow();});
  it('rejects disabling TLS verification',()=>{const c=config();c.monitorDb.ssl={rejectUnauthorized:false};expect(()=>validateConfig(c)).toThrow();});
  it('rejects targets not allowlisted',()=>{const c=config();c.baseUrl='https://unapproved.invalid';expect(()=>validateConfig(c)).toThrow();});
  it('rejects privileged runtime identity',()=>{const c=config();c.runtimeDb.user='swat_migrator';expect(()=>validateConfig(c)).toThrow();});
  it('requires every infrastructure process observation',()=>{const c=config();c.processes=c.processes.filter((p: any)=>p.name!=='redis');expect(()=>validateConfig(c)).toThrow();});
  it('requires separately authorized metric publication',()=>{const c=config();c.remoteWrite={url:'http://unapproved.invalid/api/v1/write'};expect(()=>validateConfig(c)).toThrow();});
  it('does not upgrade complete observations to correctness acceptance',()=>{const result=assess();expect(result.issues).toEqual([]);expect(result).toMatchObject({loadQualification:'observations-complete-correctness-unassessed',runtimeAccepted:false,productionReady:false});});
  it('requires exact predicates, not ten unrelated green thresholds',()=>{const e=evidence();e.summary.metrics={'unrelated':{thresholds:{'rate<1':{ok:true}}}};expect(assess(e).issues).toContain('missing or failed workload threshold: application_refused');});
  it('refuses missing telemetry fields instead of NaN green comparisons',()=>{const e=evidence();(e.samples[0].redis.memory as any).used_memory=null;expect(assess(e).issues).toContain('missing or malformed required telemetry');});
  it('requires generator lifecycle evidence',()=>{const e=evidence();(e as any).lifecycle=undefined;expect(assess(e).issues).toContain('missing generator lifecycle timestamps');});
  it('requires a final drain observation',()=>{const e=evidence();e.lifecycle.end=new Date(Date.parse(e.samples.at(-1)!.at)).toISOString();expect(assess(e).issues).toContain('baseline or final drain sample missing');});
  it('fails on collector errors',()=>{const e=evidence();e.collector.ok=false;expect(assess(e).issues).toContain('required telemetry collector failed');});
  it('fails on Redis errors',()=>{const e=evidence();e.samples[1].redis.stats.total_error_replies=1;expect(assess(e).issues).toContain('Redis eviction, rejection or error observed');});
  it('fails on cgroup OOM despite passing HTTP thresholds',()=>{const e=evidence();e.samples[1].processes[0].cgroup['memory.events']='oom 1\noom_kill 1';expect(assess(e).issues).toContain('Process restart or cgroup OOM: application');});
  it('fails on unacknowledged queue backlog',()=>{const e=evidence();e.samples.at(-1)!.queues[0].counts.wait=1;expect(assess(e).issues).toContain('queue did not return to baseline after bounded drain: swat-backfill-wallet');});
  it('normalizes bigint deadlock counters rather than comparing strings',()=>{const e=evidence();for(const s of e.samples)(s.pg.database as any).deadlocks='9';(e.samples[1].pg.database as any).deadlocks='10';expect(assess(e).issues).toContain('PostgreSQL deadlocks observed');});
  it.each([true,' ',null])('refuses malformed admission count %s',value=>{const e=evidence();e.summary.metrics['queue_admitted{lane:wallet}'].values.count=value;expect(assess(e).issues).toContain('finite queue lanes did not reach valid bounded HTTP admissions');});
  it('refuses missing reset fields',()=>{const e=evidence();delete (e.samples[0].pg.database as any).stats_reset;expect(assess(e).issues).toContain('missing or malformed required telemetry');});
  it('refuses malformed cgroup counters',()=>{const e=evidence();e.samples[1].processes[0].cgroup['memory.events']='';expect(assess(e).issues).toContain('malformed cgroup event counters');});
  it('requires increasing telemetry timestamps',()=>{const e=evidence();e.samples[1].at=e.samples[0].at;expect(assess(e).issues).toContain('required telemetry sampling gap or non-increasing timestamp');});
  it('requires generator observations during load',()=>{const e=evidence();e.samples[10].processes=e.samples[10].processes.filter(p=>p.name!=='generator');expect(assess(e).issues).toContain('generator telemetry missing during load');});
  it('bounds gaps in actual phase observations',()=>{const w=workload();w.pick(1);w.context.exec.instance.currentTestRunDuration=220000;w.pick(1);expect(w.observations).toContainEqual({name:'phase_gap',value:20,tags:{phase:'hold2000'}});expect(w.context.options.thresholds['phase_gap{phase:hold2000}']).toEqual(['max<15']);});
  it('sends stable endpoint tags and CSRF session auth',()=>{const w=workload();w.pick(1);expect(w.requests[0]).toMatchObject({method:'GET',params:{tags:{name:'wallets',kind:'read'},redirects:0,timeout:'10s'}});expect(w.requests[0].params.headers.Cookie).toBe('swat_session=fixture-token; swat_csrf=fixture-csrf');});
  it('attempts each queue lane once and falls back to safe settings writes',()=>{const w=workload();w.pick(98.5);w.pick(98.5);w.pick(99.5);w.pick(99.5);expect(w.requests.map(r=>r.params.tags.name)).toEqual(['wallet_subscribe','settings_write','token_backfill','settings_write']);expect(w.observations.filter(m=>m.name==='queue_attempts')).toHaveLength(2);});
  it('rescales read/write groups while retaining write safety',()=>{const w=workload(50);w.pick(49);w.pick(51);expect(w.requests.map(r=>r.params.tags.kind)).toEqual(['read','write']);expect(JSON.parse(w.requests[1].body)).toEqual({autoExecute:false});});
  it('records actual sustained phase concurrency',()=>{const w=workload();w.pick(1);expect(w.observations).toContainEqual({name:'phase_vus',value:2000,tags:{phase:'hold2000'}});});
  it('rejects a VU without a unique sampled identity',()=>{const w=workload();w.context.exec.vu.idInTest=2;expect(()=>w.pick(1)).toThrow('Unique VU identity pool exhausted');});
  it('binds fixture source identity to observed canonical columns',()=>{expect(source('runtime.mjs')).toContain('source_event_type,source_event_id,confirmation_state');expect(source('runtime.mjs')).toContain("'transaction',$1,'observed'");});
  it('requires pilot auth and reviewed global reads before bulk seeding',()=>{expect(source('runtime.mjs')).toContain('only ten users retained, bulk seeding refused');expect(source('runtime.mjs')).toContain('Reviewed runtime global-read capability is missing; refuse before seeding');});
  it('sanitizes all Node commands and aborts stale telemetry',()=>{expect(source('run.sh')).toContain('node() { env -i');expect(source('run.sh')).toContain('|| ! telemetry_fresh');expect(source('run.sh')).not.toMatch(/\b(?:pkill|flushall|docker compose down)\b/i);});
});
