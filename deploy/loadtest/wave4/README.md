# Wave 4 portable load qualification

This is **one additional gate within Wave 4**, not a replacement for its infrastructure, financial correctness, concurrency, crash/restart, queue acknowledgement or paper integration gates. Creating this harness does not qualify runtime or production. Run it only on a separately approved disposable server, never a production/shared database or Redis instance.

## What the shell entrypoint does

`run.sh` orchestrates preflight, synthetic seeding, authenticated route probes, Grafana k6 traffic, continuous infrastructure observations, a bounded drain and a hash-indexed assessment. Supporting Node modules are required: a shell-only implementation would otherwise need thousands of subprocesses or unsafe credential handling. It neither installs dependencies nor starts containers/services, changes database configuration, applies migrations, enables live execution, deletes records, flushes Redis or pushes anything.

Default `--plan` is offline and reads no credentials. `--run` is the only network/seeding entrypoint. Required software must already be installed from the reviewed lockfile: Linux, Bash, Node >=20, k6 OSS with `experimental-prometheus-rw` if used, GNU flock/coreutils, repository dependencies (`pg`, `ioredis`, `@node-rs/argon2`). Copy the repository and its approved dependencies to the server; the modules resolve dependencies relative to `packages/db` and `apps/api`.

```bash
bash deploy/loadtest/wave4/run.sh --plan
# Only on the approved isolated server, after completing the prerequisites below:
bash deploy/loadtest/wave4/run.sh --run /private/wave4/config.local.json
```

## Load schedule and identity model

The requested 2,000 + 7,000 active users total **9,000**, not 10,000. The script samples 10,000 identities without replacement from 100,000 new ordinary free-tier `.invalid` users. One identity is bound to each active VU through `exec.vu.idInTest`; 1,000 identities remain reserve. No admin users, verified ownership, custody secrets, grants, balances or financial receipts are manufactured.

| Elapsed time with default second ramp | Active virtual users |
| --- | --- |
| 0–3 minutes | Gradually ramp from 0 to 2,000 |
| 3–8 minutes | Hold 2,000 for five minutes |
| 8–10 minutes | Gradually add 7,000 |
| 10–25 minutes | Hold 9,000 for fifteen minutes |
| 25–27 minutes | Gradually ramp down to zero |
| After load | Observe a 60-second bounded queue drain |

The two-minute second ramp is an implementation default, not an extra time the user specified. `secondRamp` accepts `2m`–`99m`. Each VU makes one request then sleeps a random 1–3 seconds. This is a closed-concurrency test, not an arrival-rate or 10,000 simultaneous-request test. Slow endpoints reduce achieved requests/second; inspect both throughput and latency. VUs are not PostgreSQL connections.

A `SharedArray` loads the private sampled manifest once. Password hashing happens once using the repository's Argon2 parameters with a discarded random password; this **does not benchmark signup/login/password hashing**. Each user has an independent CSPRNG session token; only SHA-256 bytes are stored in PostgreSQL. Tokens/CSRF values exist only in a caller-owned mode-0600 manifest under a mode-0700 run directory. Keep the server volume encrypted; the manifest is not application-layer encrypted. Sessions expire after one day. Raw credentials and request bodies are never metric labels.

## Required prerequisites — do these outside the harness

1. Provision **fresh, disposable PostgreSQL 16 and Redis 7**, isolated networks and explicit CPU/RAM/disk limits. Finish Wave 4's reference-versus-candidate migration/catalog/role qualification first. No persistent/shared Compose volumes. Record image digests, source commit, lockfile hash, migration installed/source checksums and service graph.
2. Apply reviewed migrations through 083 using the separately authorized migration procedure. This harness validates the exact journal, including audited installed-checksum deviations; it does not apply/adopt SQL. If new migrations are added, update/review this harness instead of pretending a stale schema is current.
3. Qualify the runtime identity/authentication boundary. Current source has known prerequisites: `swat_app` is provisioned NOLOGIN while deployment connections expect it, session resolution uses unscoped queries under forced RLS, and migration 070 restricts global reads required by the selected routes. These must be addressed by independently reviewed least-privilege capabilities, **not** by running the application as the migrator/superuser, disabling RLS or broad grants. Preflight checks global read permissions and probes ten pilot sessions before allowing the remaining 99,990 users to be seeded. A failure retains the pilot; there is no silent retry or cleanup.
4. Configure PgBouncer **transaction pooling**. Use the application's qualified runtime pool role, and a separate PgBouncer admin observer. Record `SHOW CONFIG`, `SHOW POOLS` and maximum client/database/pool/reserve limits. Repository defaults (2,000 PgBouncer clients, pool 25/reserve 5/database 50, Node pool 10/process) are starting configuration, not proof of capacity. Never map VUs one-to-one to database connections.
5. Use independently approved credentials: `swat_migrator` for this empty-only synthetic seed; non-superuser PostgreSQL observer with `pg_read_all_stats`, migration-journal SELECT and catalog/statistics access, but no user INSERT; separate PgBouncer observer. Redis observer needs only INFO, EXISTS, LLEN, LRANGE, ZCARD, ZRANGE, HGET, HGETALL, GET, XLEN, XREVRANGE for approved queue keys. No FLUSH/DEL/queue removal commands are used. Database roles must be server-configured with finite timeouts. The harness never writes role grants.
6. Enable `pg_stat_statements` in shared preload libraries, `track_io_timing=on`, `log_lock_waits=on`, `deadlock_timeout<=1000ms`, and `log_min_duration_statement` between 0 and 1000ms. Configure a finite observer statement timeout. Export server slow/lock logs privately with timestamps spanning the run; SQL log literals may include credentials during seeding, so apply separately reviewed PostgreSQL parameter-log redaction and never publish raw seed/auth logs. The harness records query IDs/timing counters, not SQL text, and does not issue ALTER SYSTEM or reset statistics.
7. Deploy approved **egress-contained fixture workers** for wallet-backfill/token-discovery. Existing real workers may contact external providers even in paper mode. Record the fixture adapter source/image hash, finite synthetic payload/latency profile, explicit network-denial proof and job acknowledgement evidence. This harness does not provide or authorize production provider workers. Initialize the two queue metadata keys before the run; keep unrelated producers off. List any additional actual queues in `queues`.
8. Qualify rate limiting first. The default per-IP limit can reject a single generator long before the database saturates. Use approved distributed source capacity or reviewed isolated deployment limiter settings; **do not spoof forwarded IPs or bypass production security**. A 429-heavy run fails. A single-host 9,000-VU run may require more limiter capacity than supported settings allow; that is a prerequisite failure, not database performance.
9. Run on the deployment host with access to host PIDs and cgroup v2/proc pressure readings, or an approved observation namespace that sees them. Fill actual application, fixture-worker, PostgreSQL, Redis and PgBouncer PID/command matches in the config; add all relevant workers/application processes. PostgreSQL child processes are represented by the service cgroup, not only postmaster RSS. cgroups shared by services cannot attribute memory to one service—record this in deployment evidence. Generator CPU/RAM is observed separately. Remote-host infrastructure requires extending/reviewing collection rather than substituting local generator memory.

## Private configuration

Copy `config.example.json` into a caller-owned private directory, set mode 0600, replace every placeholder and keep it out of Git. The template deliberately fails validation. Set `authorization` to `AUTHORIZED_DISPOSABLE_WAVE4_LOAD` only after the exact server work is authorized. Provide a unique 8–48-character lowercase `runId`; existing run directories are never overwritten.

Populate the explicit API/DB/PgBouncer/Redis endpoint allowlists and matching connection objects. No credential-bearing URL, Redis Sentinel/socket override, HTTP proxy, TLS verification bypass or connection string is allowed. TLS accepts only trusted CA contents and `rejectUnauthorized:true`. Record `getconf CLK_TCK` in `clockTicksPerSecond`. Keep `readPercent=80` initially; 10–90 is supported. `minQueueAdmissions=8000` is a per-lane default and probabilistic under the weighted mix, not guaranteed.

Set each deployment attestation only after validation and provide real files/hashes for `deployment`, `egress`, `limiter`, `worker` evidence. Flags/hashes record the operator's prerequisite claims; they are **not** permission or independent proof. The final independent reviewer must inspect the evidence itself. Node/k6 environments are sanitized to exclude inherited debug/preload/proxy/cloud variables.

The database must have no users/wallets/signals/source trades. Batches commit incrementally (initial ten-user auth pilot, then batches of 500; observation batches of 100). Partial failure retains committed data and a failed run; prepare a separately authorized new environment rather than reusing or deleting financial history. All 100,000 users get sessions; only the 10,000 selected users get one owned wallet, five history rows, one expired synthetic signal/cluster, one **observed/unverified** feed event and disabled execution settings. The fixture distribution is deliberately modest: add a reviewed production-shaped dataset qualification separately; do not call small synthetic fixtures representative of all portfolio workloads.

## Endpoint weighting

Defaults are percentages of all requests. Changing `readPercent` rescales read and write groups while preserving internal relative weights.

| Default share | Application endpoint |
| --- | --- |
| 20% | GET `/v1/me/wallets` |
| 20% | GET `/v1/me/feed` |
| 15% | GET `/v1/me/signals` |
| 10% | GET `/v1/me/wallets/:ownedAddress/history` |
| 10% | GET `/v1/me/execution-settings` |
| 5% | GET `/v1/me/masters` |
| 18% | PATCH `/v1/me/execution-settings`, `autoExecute:false` |
| 1% | POST `/v1/me/wallets`, finite unique synthetic address |
| 1% | POST `/v1/me/tokens/backfill`, finite unique synthetic mint |

After each identity has attempted its one wallet and one token request, those write choices fall back to the settings PATCH, preserving the read/write ratio. The maximum is 9,000 attempts **per queue lane**, not a sustained enqueue storm. Every GET still incurs authenticated session writes. Backfill HTTP admission is counted separately from attempted requests; BullMQ job sequence/count/event observations are separately reconciled. Neither proves worker completion. Financial withdrawal/reducing/live/LP throughput is not included because unavailable default runtime ports must not be fabricated.

## Measurements, thresholds and interpretation

`metrics.ndjson` samples at `intervalSeconds` (5–60 seconds):

- PostgreSQL transaction/tuple/cache/temp/I/O/deadlock deltas, wait classes, blocking PID chains, lock modes, top-200 cumulative statement timings by query ID and statistics-reset markers. Top lists may change/evict; query deltas are observations, not a complete slow-query ledger. Server slow/lock logs remain required.
- PgBouncer pools/stats and aggregated client/server states, separating waiting clients from backend connections.
- Redis allocated/RSS/peak/dataset memory, fragmentation, commands, eviction/errors/clients and persistence status.
- BullMQ wait/active/paused/prioritized/delayed/completed/failed/waiting-children counts, bounded head/tail age samples, recent bounded events and metric counters. Sampled age is **not exact oldest age**; bounded events may miss stalls or removed failed jobs. Do not certify acknowledgement correctness from them.
- Host RAM/swap/VM counters, pressure/load/CPU; per-process RSS/high-water/CPU and cgroup RAM/CPU/OOM/throttling/pressure. PID reuse/service restart fails collection.

Default k6 SLOs: read p95 <750ms, write p95 <1500ms, failed/unavailable requests <1%, throttled <0.1%, nonempty read-fixture success >99%, configured finite queue admission minima. Phase-specific thresholds verify both sustained-user plateaus and their elapsed span, with phase-observation gaps below 15 seconds. Assessment also requires strictly increasing infrastructure sample timestamps and generator observations during the interior load interval. These are initial engineering defaults, **not achieved results or user-specified business SLOs**. Assessment requires actual baseline/load/drain samples, exact predicates, finite telemetry, no statistics restart/reset, no observed deadlocks, Redis errors/evictions/persistence failure, host/cgroup OOM, <5% host free-memory headroom, sampled queue age >60s or undrained queues. Required collector failure/stale heartbeat aborts only the owned k6 process. Heartbeat abort bound is 180 seconds; assessment additionally rejects sampling gaps exceeding three intervals. Kill/cleanup affects only owned children, never services.

`assessment.json` reports either `blocked-or-failed` or `observations-complete-correctness-unassessed`. Even the latter is **not load correctness acceptance**: independently reconcile run-bound durable worker acknowledgements, server logs, resource-limit/pressure/throttling budgets and original Wave 4 crash/recovery evidence. It never changes the stage ledger automatically. CPU/RAM correlation does not establish bottleneck causality; use timed waits/pool/throughput/resource evidence and controlled repeat runs on fresh qualified environments.

## Grafana

Grafana k6 OSS works without cloud publication. Local summary and sampled infrastructure evidence are always retained. For an **explicitly authorized** private Prometheus/Mimir remote-write receiver, add:

```json
"remoteWrite": { "url": "http://metrics.internal:9090/api/v1/write" }
```

Also add the origin to `allowlist.metricsOrigins` and set the separate `authorizedMetricsPublication` attestation. The script selects `experimental-prometheus-rw`, with p95/p99/average trends. No cloud token, public service or credential-bearing URL is accepted. Configure Grafana against that receiver outside the harness; useful panels include `k6_vus`, `k6_http_reqs_total`, application latency/refusal/throttle metrics and queue admission counters. Infrastructure samples remain private NDJSON; existing approved PostgreSQL/PgBouncer/Redis/node/cgroup exporters may feed the same dashboard, but their absence must not be mistaken for harness-provided exporters. Enable remote-write receiver support on the approved Prometheus deployment before running. The harness does not install Grafana or open ports.

## Evidence and next gate

Runs are stored under `deploy/loadtest/wave4/runs/<runId>/` (ignored by Git). Keep the private token manifest separate from any audit archive. Review `preflight.json`, `auth-pilot.json`, `seed.json`, `auth-probe.json`, k6 summary, lifecycle, collector result, NDJSON and `assessment.json`, with tool versions and artifact hashes. Archive nonsecret evidence to approved durable storage; publishing is separately authorized. Keep failed attempts. No commit/push is performed by the harness.

Original Wave 4 gates are tracked in `threats/project-completion-20261117/WAVE4-QUALIFICATION.md`. The load test can expose contention and throughput limits; it cannot replace role/RLS isolation, exact financial settlement, concurrency, crash/restart or durable queue acknowledgement tests. Wave 5 remains blocked until those gates and independent acceptance are complete.
