#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const runsDir = resolve(process.cwd(), 'deploy/loadtest/wave4/runs');
let runDir = process.argv[2] ? resolve(process.argv[2]) : null;

if (!runDir) {
  if (!existsSync(runsDir)) {
    console.error(`No runs directory found at ${runsDir}`);
    process.exit(1);
  }
  const candidates = readdirSync(runsDir)
    .map((name) => join(runsDir, name))
    .filter((p) => existsSync(join(p, 'metrics.ndjson')) && statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (candidates.length === 0) {
    console.error(`No completed load runs found in ${runsDir}`);
    process.exit(1);
  }
  runDir = candidates[0];
}

const metricsPath = join(runDir, 'metrics.ndjson');
const summaryPath = join(runDir, 'summary.json');
const reportPath = join(runDir, 'report.json');

const samples = readFileSync(metricsPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

if (samples.length < 2) {
  console.error(`Insufficient samples in ${metricsPath}`);
  process.exit(1);
}

const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null;
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
const clkTck = report?.observations?.processes?.postgres?.clockTicksPerSecond ?? 100;

function cpuTotalJiffies(cpuLine) {
  if (!cpuLine) return null;
  const nums = cpuLine.trim().split(/\s+/).slice(1).map(Number).filter(Number.isFinite);
  if (nums.length < 4) return null;
  const idle = (nums[3] ?? 0) + (nums[4] ?? 0);
  const total = nums.reduce((a, b) => a + b, 0);
  return { busy: total - idle, total };
}

function heatBlock(pct, maxPct = 100) {
  const chars = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const norm = Math.max(0, Math.min(1, pct / maxPct));
  const idx = Math.min(chars.length - 1, Math.round(norm * (chars.length - 1)));
  return chars[idx];
}

function processCpuPct(prevProc, curProc, dtSec) {
  if (!prevProc || !curProc || dtSec <= 0) return 0;
  // Use cgroup CPU only for container-isolated processes (postgres/redis); host systemd
  // processes share a slice cgroup, so use per-PID proc ticks for application/worker/pgbouncer.
  const isContainerIsolated = prevProc.name === 'postgres' || prevProc.name === 'redis';
  if (isContainerIsolated) {
    const prevCg = /^usage_usec (\d+)/m.exec(prevProc.cgroup?.['cpu.stat'] ?? '')?.[1];
    const curCg = /^usage_usec (\d+)/m.exec(curProc.cgroup?.['cpu.stat'] ?? '')?.[1];
    if (prevCg && curCg) {
      return ((Number(curCg) - Number(prevCg)) / 1e6 / dtSec) * 100;
    }
  }
  const dTicks = (curProc.userTicks + curProc.systemTicks) - (prevProc.userTicks + prevProc.systemTicks);
  return Math.max(0, (dTicks / clkTck / dtSec) * 100);
}

const names = [...new Set(samples.flatMap((s) => (s.processes ?? []).map((p) => p.name)))];
const intervals = [];
const peakByProc = Object.fromEntries(names.map((n) => [n, 0]));
const sumByProc = Object.fromEntries(names.map((n) => [n, 0]));
const seriesByProc = Object.fromEntries(names.map((n) => [n, []]));
const hostSeries = [];

for (let i = 1; i < samples.length; i++) {
  const prev = samples[i - 1];
  const cur = samples[i];
  const dtSec = Math.max(0.001, (Date.parse(cur.at) - Date.parse(prev.at)) / 1000);
  const c0 = cpuTotalJiffies(prev.host?.cpu);
  const c1 = cpuTotalJiffies(cur.host?.cpu);
  const hostPct = c0 && c1 && c1.total > c0.total
    ? ((c1.busy - c0.busy) / (c1.total - c0.total)) * 100
    : 0;
  hostSeries.push(hostPct);

  for (const name of names) {
    const p0 = (prev.processes ?? []).find((p) => p.name === name);
    const p1 = (cur.processes ?? []).find((p) => p.name === name);
    const pct = processCpuPct(p0, p1, dtSec);
    seriesByProc[name].push(pct);
    sumByProc[name] += pct;
    if (pct > peakByProc[name]) peakByProc[name] = pct;
  }

  intervals.push({
    at: cur.at.slice(11, 19),
    hostPct,
    memAvailGb: ((cur.host?.memoryKb?.MemAvailable ?? 0) / 1048576).toFixed(1),
    pgWaiting: (cur.pgbouncer?.pools ?? []).reduce((a, p) => a + Number(p.cl_waiting ?? 0), 0)
  });
}

console.log('');
console.log('====================================================================');
console.log(` WAVE 4 / 4B CPU & LOAD HEAT MAP — ${runDir}`);
console.log('====================================================================');
console.log(`Samples: ${samples.length} (${intervals.length} intervals) | Start: ${samples[0].at} | End: ${samples.at(-1).at}`);
console.log('');
console.log('--- 1. Per-Process CPU Heat Map (% of 1 CPU core; scale 0% -> 400%) ---');
const avgHost = hostSeries.reduce((a, b) => a + b, 0) / hostSeries.length;
const peakHost = Math.max(...hostSeries);
console.log(
  `${'host_total'.padEnd(14)} | avg ${avgHost.toFixed(1).padStart(5)}% | peak ${peakHost.toFixed(1).padStart(5)}% | ${hostSeries.map((v) => heatBlock(v, 100)).join('')}`
);
for (const name of names) {
  const arr = seriesByProc[name];
  const avg = arr.length ? sumByProc[name] / arr.length : 0;
  const peak = peakByProc[name];
  const peakRssMb = (Math.max(...samples.map((s) => (s.processes ?? []).find((p) => p.name === name)?.rssKb ?? 0)) / 1024).toFixed(0);
  console.log(
    `${name.padEnd(14)} | avg ${avg.toFixed(1).padStart(5)}% | peak ${peak.toFixed(1).padStart(5)}% | RSS ${peakRssMb.padStart(4)}MB | ${arr.map((v) => heatBlock(v, 400)).join('')}`
  );
}

console.log('');
console.log('--- 2. Timeline Buckets (every interval across ramp + sustained hold) ---');
const step = Math.max(1, Math.floor(intervals.length / 24));
for (let i = 0; i < intervals.length; i += step) {
  const row = intervals[i];
  const pg = seriesByProc.postgres?.[i] ?? 0;
  const app = seriesByProc.application?.[i] ?? 0;
  const rd = seriesByProc.redis?.[i] ?? 0;
  console.log(
    `  ${row.at} | host ${row.hostPct.toFixed(0).padStart(3)}% ${heatBlock(row.hostPct, 100)} | pg ${pg.toFixed(0).padStart(3)}% ${heatBlock(pg, 400)} | api ${app.toFixed(0).padStart(3)}% ${heatBlock(app, 400)} | redis ${rd.toFixed(0).padStart(3)}% ${heatBlock(rd, 200)} | wait=${row.pgWaiting} | free=${row.memAvailGb}GB`
  );
}

const firstStmts = new Map((samples[0].pg?.statements ?? []).map((s) => [String(s.queryid), s]));
const lastStmts = samples.at(-1)?.pg?.statements ?? [];
const topQueries = lastStmts
  .map((s) => {
    const prev = firstStmts.get(String(s.queryid));
    const dTime = Number(s.total_exec_time ?? 0) - Number(prev?.total_exec_time ?? 0);
    const dCalls = Number(s.calls ?? 0) - Number(prev?.calls ?? 0);
    return { queryid: s.queryid, calls: dCalls, totalMs: dTime, meanMs: dCalls > 0 ? dTime / dCalls : 0 };
  })
  .filter((q) => q.calls > 0)
  .sort((a, b) => b.totalMs - a.totalMs)
  .slice(0, 8);

console.log('');
console.log('--- 3. Top PostgreSQL Hotspots (delta pg_stat_statements) ---');
for (const q of topQueries) {
  console.log(
    `  queryid=${String(q.queryid).padEnd(21)} | calls=${String(q.calls).padStart(7)} | total=${q.totalMs.toFixed(0).padStart(7)}ms | mean=${q.meanMs.toFixed(2).padStart(6)}ms`
  );
}

if (summary?.metrics) {
  const read = summary.metrics['application_latency{kind:read}']?.values;
  const write = summary.metrics['application_latency{kind:write}']?.values;
  const failed = summary.metrics.http_req_failed?.values;
  const vus = summary.metrics.vus?.values;
  console.log('');
  console.log('--- 4. k6 Load & Latency Summary ---');
  console.log(`  Peak VUs  : ${vus?.max ?? 'n/a'}`);
  console.log(`  HTTP Fail : ${failed ? (failed.rate * 100).toFixed(3) + '%' : 'n/a'}`);
  if (read) console.log(`  Read      : p50=${read.med?.toFixed(1)}ms | p95=${read['p(95)']?.toFixed(1)}ms | max=${read.max?.toFixed(1)}ms`);
  if (write) console.log(`  Write     : p50=${write.med?.toFixed(1)}ms | p95=${write['p(95)']?.toFixed(1)}ms | max=${write.max?.toFixed(1)}ms`);
}

if (report) {
  console.log('');
  console.log(`Qualification Verdict: ${report.loadQualification} (issues: ${report.issues?.length ?? 0})`);
  if (report.issues?.length) console.log('Issues:', report.issues);
}
console.log('');
