import { fileURLToPath } from 'node:url';
import { readFile, readdir, stat } from 'node:fs/promises';
import { digest, loadConfig, stages, writeNewJson, requireValue } from './core.mjs';

export function difference(first, last, keys) {
  return Object.fromEntries(keys.map(key => [key, Number(last[key]) - Number(first[key])]));
}
export function requiredThresholds(config) {
  const peak = 480 + Number.parseInt(config.secondRamp)*60;
  return {
    'application_latency{kind:read}': ['p(95)<750'], 'application_latency{kind:write}': ['p(95)<1500'],
    application_refused: ['rate<0.01'], application_throttled: ['rate<0.001'], application_unavailable: ['rate<0.01'],
    fixture_nonempty: ['rate>0.99'], http_req_failed: ['rate<0.01'],
    'queue_admitted{lane:wallet}': [`count>=${config.minQueueAdmissions}`], 'queue_admitted{lane:token}': [`count>=${config.minQueueAdmissions}`],
    'phase_vus{phase:hold2000}': ['min>=1990','max<=2000'], 'phase_vus{phase:hold9000}': ['min>=8990','max<=9000'],
    'phase_gap{phase:hold2000}': ['max<15'], 'phase_gap{phase:hold9000}': ['max<15'],
    'phase_elapsed{phase:hold2000}': ['min<190','max>470'], 'phase_elapsed{phase:hold9000}': [`min<${peak+10}`,`max>${peak+890}`]
  };
}

function numeric(value) {
  return (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value))) && Number.isFinite(Number(value));
}
function resetFields(object, keys) { return object && keys.every(key => Object.hasOwn(object,key) && (object[key] === null || (typeof object[key] === 'string' && object[key].length > 0))); }
function cgroupEvents(p) {
  if (!p.cgroup) return null;
  const text = p.cgroup['memory.events'];
  requireValue(typeof text === 'string' && ['oom','oom_kill'].every(key => new RegExp(`^${key} (\\d+)$`,'m').test(text)), 'Malformed cgroup memory events');
  return Object.fromEntries(text.split('\n').map(line => line.split(' ')));
}
function validSample(s, config) {
  const finite = numeric;
  const fields = (object, keys) => object && keys.every(key => finite(object[key]) && Number(object[key]) >= 0);
  return Boolean(
    Number.isFinite(Date.parse(s?.at)) && fields(s,['collectionMs']) &&
    fields(s.pg?.database,['xact_commit','xact_rollback','blks_read','blks_hit','tup_inserted','tup_updated','tup_deleted','deadlocks','temp_bytes','blk_read_time','blk_write_time']) &&
    s.pg.database.started && resetFields(s.pg.database,['stats_reset']) && resetFields(s.pg.statementReset,['stats_reset']) && Array.isArray(s.pg.statements) && Array.isArray(s.pg.blockers) &&
    Array.isArray(s.pgbouncer?.pools) && s.pgbouncer.pools.length > 0 && s.pgbouncer.pools.every(p => fields(p,['cl_waiting'])) &&
    fields(s.redis?.memory,['used_memory','used_memory_rss','mem_fragmentation_ratio']) && fields(s.redis?.stats,['evicted_keys','rejected_connections','total_error_replies']) &&
    s.redis.persistence?.rdb_last_bgsave_status && s.redis.persistence?.aof_last_write_status &&
    Array.isArray(s.queues) && config.queues.every(name => s.queues.some(q => q.queue === name && fields(q,['oldestSampledAgeMs']) && fields(q.counts,['wait','active','paused','prioritized','delayed','completed','failed','waiting-children']) && q.recentEventSample && finite(q.jobSequence ?? 0))) &&
    fields(s.host?.memoryKb,['MemTotal','MemAvailable']) && finite(s.host?.vm?.oom_kill) &&
    Array.isArray(s.processes) && config.processes.every(p => s.processes.some(q => q.name === p.name && q.pid === p.pid && q.startTicks && fields(q,['rssKb','userTicks','systemTicks'])))
  );
}

export function evaluate(summary, samples, collector, config, k6Exit, lifecycle) {
  const issues = [];
  if (!Array.isArray(samples)) samples = [];
  const first = samples[0], last = samples.at(-1);
  if (k6Exit !== 0) issues.push('k6 exited nonzero');
  if (collector?.ok !== true) issues.push('required telemetry collector failed');
  if (samples.length < 2) issues.push('insufficient baseline/load/drain samples');
  for (const [metric, predicates] of Object.entries(requiredThresholds(config))) {
    if (predicates.some(predicate => summary?.metrics?.[metric]?.thresholds?.[predicate]?.ok !== true)) issues.push(`missing or failed workload threshold: ${metric}`);
  }
  if (!Array.isArray(samples) || samples.some(sample => !validSample(sample,config))) {
    return { loadQualification:'blocked-or-failed', issues:[...issues,'missing or malformed required telemetry'], observations:{}, runtimeAccepted:false, liveCapabilityAccepted:false, productionReady:false };
  }
  const start = Date.parse(lifecycle?.start), end = Date.parse(lifecycle?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) issues.push('missing generator lifecycle timestamps');
  else if (!first || !last || Date.parse(first.at) > start || Date.parse(last.at) < end+45000) issues.push('baseline or final drain sample missing');
  const vus = summary?.metrics?.vus?.values?.max;
  if (vus !== 9000) issues.push('9,000 active virtual-user peak was not observed');
  const counts = Object.fromEntries(['wallet','token'].map(lane => [lane, summary?.metrics?.[`queue_admitted{lane:${lane}}`]?.values?.count ?? 0]));
  if (Object.values(counts).some(value => !numeric(value) || !Number.isInteger(Number(value)) || Number(value) > 9000 || Number(value) < config.minQueueAdmissions)) issues.push('finite queue lanes did not reach valid bounded HTTP admissions');
  const observations = {};
  if (first && last) {
    const durationMs = Date.parse(last.at) - Date.parse(first.at);
    const scheduledMs = (3 + 5 + Number.parseInt(config.secondRamp) + 15 + 2) * 60000;
    if (durationMs < scheduledMs - 30000) issues.push('telemetry did not cover the scheduled sustained load');
    for (let i = 1; i < samples.length; i++) {
      const gap = Date.parse(samples[i].at)-Date.parse(samples[i-1].at);
      if (gap <= 0 || gap > config.intervalSeconds*3000) issues.push('required telemetry sampling gap or non-increasing timestamp');
    }
    for (const sample of samples) {
      const at = Date.parse(sample.at);
      if (at > start+15000 && at < end-15000 && !sample.processes.some(p => p.name === 'generator' && numeric(p.rssKb))) issues.push('generator telemetry missing during load');
      try { sample.processes.forEach(cgroupEvents); } catch { issues.push('malformed cgroup event counters'); }
    }
    const reset = sample => JSON.stringify([sample.pg.database.started, sample.pg.database.stats_reset, sample.pg.statementReset.stats_reset]);
    if (samples.some(sample => reset(sample) !== reset(first))) issues.push('PostgreSQL restart/statistics reset invalidated cumulative deltas');
    if (samples.some(sample => Number(sample.pg.database.deadlocks) > Number(first.pg.database.deadlocks))) issues.push('PostgreSQL deadlocks observed');
    if (samples.some(sample => sample.redis.stats.evicted_keys > first.redis.stats.evicted_keys || sample.redis.stats.rejected_connections > first.redis.stats.rejected_connections || sample.redis.stats.total_error_replies > first.redis.stats.total_error_replies)) issues.push('Redis eviction, rejection or error observed');
    if (samples.some(sample => sample.redis.persistence.rdb_last_bgsave_status !== 'ok' || sample.redis.persistence.aof_last_write_status !== 'ok')) issues.push('Redis persistence error observed');
    if (samples.some(sample => Number(sample.host.vm.oom_kill) > Number(first.host.vm.oom_kill))) issues.push('Host OOM event observed');
    if (samples.some(sample => sample.host.memoryKb.MemAvailable < sample.host.memoryKb.MemTotal*0.05)) issues.push('Host memory headroom below 5 percent');
    for (const p of first.processes) {
      const event = (process,key) => Number(new RegExp(`^${key} (\\d+)$`,'m').exec(process.cgroup?.['memory.events'] ?? '')?.[1] ?? 0);
      if (samples.some(sample => sample.processes.some(q => q.name === p.name && (q.startTicks !== p.startTicks || event(q,'oom_kill') > event(p,'oom_kill') || event(q,'oom') > event(p,'oom'))))) issues.push(`Process restart or cgroup OOM: ${p.name}`);
    }

    const cpuTicksPerSecond = config.clockTicksPerSecond;
    observations.processes = {};
    for (const name of new Set(samples.flatMap(sample => sample.processes.map(p => p.name)))) {
      const series = samples.flatMap(sample => sample.processes.filter(p => p.name === name).map(p => ({ ...p, at: sample.at })));
      const begin = series[0], end = series.at(-1);
      const elapsed = (Date.parse(end.at)-Date.parse(begin.at))/1000;
      observations.processes[name] = { baselineRssKb: begin.rssKb, peakRssKb: Math.max(...series.map(p => p.rssKb)), finalRssKb: end.rssKb, averageCpuCores: elapsed > 0 ? ((end.userTicks+end.systemTicks)-(begin.userTicks+begin.systemTicks))/cpuTicksPerSecond/elapsed : null, clockTicksPerSecond: cpuTicksPerSecond };
    }
    observations.pgDatabaseDelta = difference(first.pg.database, last.pg.database, ['xact_commit','xact_rollback','blks_read','blks_hit','tup_inserted','tup_updated','tup_deleted','deadlocks','temp_bytes','blk_read_time','blk_write_time']);
    observations.maxBlockedBackends = Math.max(...samples.map(sample => sample.pg.blockers.length));
    observations.maxPoolWaitingClients = Math.max(...samples.map(sample => sample.pgbouncer.pools.reduce((sum,pool) => sum + Number(pool.cl_waiting ?? 0),0)));
    observations.redis = { baselineUsedBytes: first.redis.memory.used_memory, peakUsedBytes: Math.max(...samples.map(sample => sample.redis.memory.used_memory)), baselineRssBytes: first.redis.memory.used_memory_rss, peakRssBytes: Math.max(...samples.map(sample => sample.redis.memory.used_memory_rss)), peakFragmentationRatio: Math.max(...samples.map(sample => sample.redis.memory.mem_fragmentation_ratio)), evictionsDelta: last.redis.stats.evicted_keys-first.redis.stats.evicted_keys };
    observations.queues = [];
    for (const queue of config.queues) {
      const begin = first.queues.find(q => q.queue === queue), end = last.queues.find(q => q.queue === queue);
      if (!begin || !end) { issues.push(`missing queue telemetry ${queue}`); continue; }
      const series = samples.map(sample => sample.queues.find(q => q.queue === queue));
      const admittedJobs = Number(end.jobSequence ?? 0) - Number(begin.jobSequence ?? 0);
      const lane = queue === 'swat-backfill-wallet' ? 'wallet' : queue === 'swat-token-discovery' ? 'token' : null;
      if (lane && admittedJobs < counts[lane]) issues.push(`HTTP admission/queue sequence mismatch for ${queue}`);
      if (series.some(q => q.counts.failed > begin.counts.failed || q.recentEventSample.stalled > 0)) issues.push(`failed/stalled jobs observed in ${queue}`);
      if (['wait','active','paused','prioritized','delayed','waiting-children'].some(state => end.counts[state] > begin.counts[state])) issues.push(`queue did not return to baseline after bounded drain: ${queue}`);
      if (series.some(q => q.oldestSampledAgeMs > 60000)) issues.push(`Sampled queue age exceeded 60 seconds: ${queue}`);
      observations.queues.push({ queue, jobSequenceDelta: admittedJobs, httpAdmissions: lane ? counts[lane] : null, peakDepth: Math.max(...series.map(q => Object.values(q.counts).reduce((a,b) => a+b,0))), oldestSampledAgeMs: Math.max(...series.map(q => q.oldestSampledAgeMs)), baseline: begin.counts, final: end.counts, completionProof: 'Counts and bounded events are observations, not durable per-job acknowledgements' });
    }
    const initialStatements = new Map(first.pg.statements.map(row => [`${row.userid}:${row.queryid}`,row]));
    observations.slowQueryDeltas = last.pg.statements.map(row => {
      const previous = initialStatements.get(`${row.userid}:${row.queryid}`) ?? { calls:0,total_exec_time:0 };
      const calls = Number(row.calls)-Number(previous.calls), ms = Number(row.total_exec_time)-Number(previous.total_exec_time);
      return { queryid:row.queryid, userid:row.userid, callsDelta:calls, executionMsDelta:ms, meanDeltaMs:calls > 0 ? ms/calls : null };
    }).sort((a,b) => b.executionMsDelta-a.executionMsDelta).slice(0,30);
  }
  return { loadQualification: issues.length ? 'blocked-or-failed' : 'observations-complete-correctness-unassessed', issues: [...new Set(issues)], observations, runtimeAccepted: false, liveCapabilityAccepted: false, productionReady: false, limitation: 'No automatic Wave 4 acceptance. Operator must review server slow/lock logs, durable queue acknowledgements, isolation, resource limits and restart/concurrency evidence.' };
}

async function finish(configPath, out, k6Exit) {
  const config = await loadConfig(configPath);
  const summary = JSON.parse(await readFile(`${out}/k6-summary.json`, 'utf8'));
  const samples = (await readFile(`${out}/metrics.ndjson`, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const collector = JSON.parse(await readFile(`${out}/collector-result.json`, 'utf8'));
  const lifecycle = JSON.parse(await readFile(`${out}/lifecycle.json`, 'utf8'));
  const result = evaluate(summary,samples,collector,config,k6Exit,lifecycle);
  const artifacts = {};
  for (const file of await readdir(out)) {
    if (['identities.json','workload.json','k6.pid'].includes(file)) continue;
    if ((await stat(`${out}/${file}`)).isFile()) artifacts[file] = digest(await readFile(`${out}/${file}`));
  }
  result.artifactSha256 = artifacts;
  await writeNewJson(`${out}/assessment.json`,result);
  console.log(JSON.stringify({ loadQualification:result.loadQualification, issues:result.issues, assessment:`${out}/assessment.json`, runtimeAccepted:false },null,2));
  return result.issues.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'workload') {
      const config = await loadConfig(process.argv[3]);
      await writeNewJson(`${process.argv[4]}/workload.json`, { baseUrl:new URL(config.baseUrl).origin, stages:stages(config.secondRamp), readPercent:config.readPercent, readP95Ms:750,writeP95Ms:1500,minQueueAdmissions:config.minQueueAdmissions, secondRamp:config.secondRamp, remoteWrite:config.remoteWrite ?? null });
    } else process.exitCode = await finish(process.argv[3],process.argv[4],Number(process.argv[5]));
  } catch { console.error('Wave4 assessment incomplete; required evidence missing.'); process.exitCode = 1; }
}
