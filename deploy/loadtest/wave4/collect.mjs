import { appendFile, readFile, open, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig, requireValue, writeNewJson } from './core.mjs';
import { db, redis } from './runtime.mjs';

function infoMap(text) {
  return Object.fromEntries(text.split('\r\n').filter(line => line && !line.startsWith('#') && line.includes(':')).map(line => {
    const at = line.indexOf(':'); const key = line.slice(0, at), value = line.slice(at + 1);
    return [key, /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value];
  }));
}
const memoryFields = ['used_memory','used_memory_rss','used_memory_peak','used_memory_dataset','maxmemory','mem_fragmentation_ratio','mem_fragmentation_bytes','allocator_frag_ratio','allocator_rss_ratio','rss_overhead_ratio','mem_not_counted_for_evict'];
const statsFields = ['total_commands_processed','instantaneous_ops_per_sec','total_net_input_bytes','total_net_output_bytes','evicted_keys','expired_keys','keyspace_hits','keyspace_misses','rejected_connections','total_error_replies'];
const persistenceFields = ['rdb_bgsave_in_progress','rdb_last_bgsave_status','aof_enabled','aof_rewrite_in_progress','aof_last_write_status','aof_current_size','aof_buffer_length'];
const select = (map, names) => Object.fromEntries(names.map(name => [name, map[name] ?? null]));
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

export async function processSample(spec) {
  const stat = await readFile(`/proc/${spec.pid}/stat`, 'utf8');
  const command = (await readFile(`/proc/${spec.pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
  if (spec.name === 'generator' && !command.trim()) { const error = new Error('Generator exited'); error.code = 'ENOENT'; throw error; }
  requireValue(command.includes(spec.commandIncludes), `Process identity changed for ${spec.name}`);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const status = await readFile(`/proc/${spec.pid}/status`, 'utf8');
  const kb = name => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(status)?.[1] ?? 0);
  const sample = { name: spec.name, pid: spec.pid, startTicks: fields[19], userTicks: Number(fields[11]), systemTicks: Number(fields[12]), threads: Number(fields[17]), rssKb: kb('VmRSS'), highWaterKb: kb('VmHWM'), swapKb: kb('VmSwap') };
  const cgroup = /^0::(.+)$/m.exec(await readFile(`/proc/${spec.pid}/cgroup`, 'utf8'))?.[1];
  if (cgroup) {
    sample.cgroup = {};
    for (const name of ['memory.current','memory.peak','memory.max','memory.events','cpu.stat','cpu.max','memory.pressure','cpu.pressure']) {
      try { sample.cgroup[name] = (await readFile(`/sys/fs/cgroup${cgroup}/${name}`, 'utf8')).trim(); }
      catch (error) { if (['memory.peak','memory.pressure','cpu.pressure'].includes(name) && error.code === 'ENOENT') sample.cgroup[name] = 'unavailable'; else throw error; }
    }
  }
  return sample;
}

async function hostSample() {
  const memory = await readFile('/proc/meminfo', 'utf8');
  const vm = await readFile('/proc/vmstat', 'utf8');
  return {
    memoryKb: Object.fromEntries(['MemTotal','MemAvailable','Cached','SwapTotal','SwapFree','Dirty','Writeback'].map(name => [name, Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(memory)?.[1] ?? 0)])),
    vm: Object.fromEntries(vm.split('\n').filter(line => /^(pswpin|pswpout|pgmajfault|oom_kill) /.test(line)).map(line => line.split(' '))),
    load: (await readFile('/proc/loadavg', 'utf8')).trim(),
    cpu: (await readFile('/proc/stat', 'utf8')).split('\n')[0],
    pressure: Object.fromEntries(await Promise.all(['cpu','memory','io'].map(async name => [name, (await readFile(`/proc/pressure/${name}`, 'utf8')).trim()])))
  };
}

async function queueSample(r, prefix, queue) {
  const key = `${prefix}:${queue}`;
  const counts = {};
  for (const state of ['wait','active','paused']) counts[state] = await r.llen(`${key}:${state}`);
  for (const state of ['prioritized','delayed','completed','failed','waiting-children']) counts[state] = await r.zcard(`${key}:${state}`);
  let oldestSampledAgeMs = 0;
  // Bounded head/tail samples avoid unbounded Redis scans while workers are hot.
  for (const state of ['wait','active','paused']) {
    const ids = [...await r.lrange(`${key}:${state}`, 0, 9), ...await r.lrange(`${key}:${state}`, -10, -1)];
    for (const id of new Set(ids)) {
      const timestamp = Number(await r.hget(`${key}:${id}`, 'timestamp'));
      if (timestamp > 0) oldestSampledAgeMs = Math.max(oldestSampledAgeMs, Date.now() - timestamp);
    }
  }
  for (const state of ['prioritized','delayed']) {
    for (const id of await r.zrange(`${key}:${state}`, 0, 19)) {
      const timestamp = Number(await r.hget(`${key}:${id}`, 'timestamp'));
      if (timestamp > 0) oldestSampledAgeMs = Math.max(oldestSampledAgeMs, Date.now() - timestamp);
    }
  }
  const events = await r.xrevrange(`${key}:events`, '+', '-', 'COUNT', 100);
  const recent = {};
  for (const [, fields] of events) {
    const event = fields[fields.indexOf('event') + 1];
    if (typeof event === 'string') recent[event] = (recent[event] ?? 0) + 1;
  }
  return { queue, counts, oldestSampledAgeMs, eventStreamLength: await r.xlen(`${key}:events`), lastEventId: events[0]?.[0] ?? null, recentEventSample: recent, completedMetric: await r.hgetall(`${key}:metrics:completed`), failedMetric: await r.hgetall(`${key}:metrics:failed`), jobSequence: await r.get(`${key}:id`) };
}

export async function collect(c, out, once = false) {
  let observer, pool, r;
  const file = `${out}/metrics.ndjson`;
  const starts = new Map();
  let count = 0;
  try {
    const handle = await open(file, 'wx', 0o600); await handle.close();
    observer = await db(c.monitorDb, 'metrics');
    pool = await db(c.poolAdmin, 'pool-metrics');
    r = redis(c.redis); await r.connect();
    do {
      const started = Date.now();
      const pg = {
        database: (await observer.query(`SELECT pg_postmaster_start_time() AS started, datname,numbackends,xact_commit,xact_rollback,
          blks_read,blks_hit,tup_returned,tup_fetched,tup_inserted,tup_updated,tup_deleted,conflicts,temp_files,temp_bytes,
          deadlocks,blk_read_time,blk_write_time,session_time,active_time,idle_in_transaction_time,stats_reset
          FROM pg_stat_database WHERE datname=current_database()`)).rows[0],
        activity: (await observer.query(`SELECT application_name,state,wait_event_type,wait_event,count(*)::int AS count,
          max(EXTRACT(epoch FROM clock_timestamp()-xact_start)) AS max_transaction_seconds
          FROM pg_stat_activity WHERE datname=current_database() GROUP BY 1,2,3,4`)).rows,
        blockers: (await observer.query(`SELECT pid,pg_blocking_pids(pid) AS blocking_pids,wait_event_type,wait_event,
          EXTRACT(epoch FROM clock_timestamp()-query_start) AS wait_seconds FROM pg_stat_activity
          WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0 LIMIT 200`)).rows,
        locks: (await observer.query(`SELECT locktype,mode,granted,count(*)::int AS count FROM pg_locks
          WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) GROUP BY 1,2,3`)).rows,
        statements: (await observer.query(`SELECT queryid::text,userid, calls,total_exec_time,mean_exec_time,max_exec_time,rows,
          shared_blks_hit,shared_blks_read,shared_blks_dirtied,shared_blks_written,temp_blks_read,temp_blks_written,
          blk_read_time,blk_write_time FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
          ORDER BY total_exec_time DESC LIMIT 200`)).rows,
        statementReset: (await observer.query('SELECT stats_reset,dealloc FROM pg_stat_statements_info')).rows[0]
      };
      const pgbouncer = {};
      for (const command of ['POOLS','STATS']) pgbouncer[command.toLowerCase()] = (await pool.query(`SHOW ${command}`)).rows;
      // Client/server snapshots are aggregated; no credentials or client addresses retained.
      for (const command of ['CLIENTS','SERVERS']) {
        const rows = (await pool.query(`SHOW ${command}`)).rows;
        pgbouncer[command.toLowerCase()] = { count: rows.length, states: rows.reduce((map, row) => { const key = `${row.database}:${row.user}:${row.state}`; map[key] = (map[key] ?? 0) + 1; return map; }, {}) };
      }
      const redisMetrics = {};
      for (const [section, names] of [['memory',memoryFields],['stats',statsFields],['persistence',persistenceFields],['clients',['connected_clients','blocked_clients','client_recent_max_input_buffer','client_recent_max_output_buffer']]]) redisMetrics[section] = select(infoMap(await r.info(section)), names);
      const queues = [];
      for (const queue of c.queues) queues.push(await queueSample(r, c.queuePrefix, queue));
      const specs = [...c.processes, { name: 'collector', pid: process.pid, commandIncludes: 'collect.mjs' }];
      try { const pid = Number(await readFile(`${out}/k6.pid`, 'utf8')); if (pid > 1) specs.push({ name: 'generator', pid, commandIncludes: 'k6' }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const processes = [];
      for (const spec of specs) {
        try {
          const sample = await processSample(spec);
          if (starts.has(spec.pid)) requireValue(starts.get(spec.pid) === sample.startTicks, 'PID reused during collection');
          starts.set(spec.pid, sample.startTicks); processes.push(sample);
        } catch (error) {
          if (!(spec.name === 'generator' && error.code === 'ENOENT')) throw error;
        }
      }
      await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), collectionMs: Date.now()-started, pg, pgbouncer, redis: redisMetrics, queues, host: await hostSample(), processes })}\n`);
      count++;
      await writeFile(`${out}/heartbeat.next`, String(Date.now()), { mode:0o600 });
      await rename(`${out}/heartbeat.next`, `${out}/heartbeat`);
      if (count === 1) await writeNewJson(`${out}/collector-ready.json`, { at: new Date().toISOString(), intervalSeconds: c.intervalSeconds });
      if (once || stopping) break;
      const deadline = started + c.intervalSeconds * 1000;
      while (!stopping && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
    } while (!stopping);
    await writeNewJson(`${out}/collector-result.json`, { ok: true, samples: count, stopped: stopping });
  } catch {
    await writeNewJson(`${out}/collector-result.json`, { ok: false, samples: count, reason: 'Required telemetry unavailable or process identity changed; inspect observer permissions and private server logs' });
    throw new Error('Required telemetry collection failed');
  } finally { r?.disconnect(); await pool?.end(); await observer?.end(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await collect(await loadConfig(process.argv[2]), process.argv[3], process.argv[4] === '--once'); }
  catch { console.error('Wave4 collector failed; acceptance is blocked.'); process.exitCode = 1; }
}
