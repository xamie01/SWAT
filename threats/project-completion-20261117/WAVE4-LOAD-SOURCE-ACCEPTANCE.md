# Wave 4 load harness — source/offline acceptance

**Accepted for source and injected offline load-harness contracts only.** This is additional subgate I7; original Wave 4 gates I1–I6/I8 remain required and unaccepted. No PostgreSQL/Redis connection, user seeding, migrations, service/container startup, k6 traffic, provider activation, signing, commit or push was performed.

## Deliverable

`deploy/loadtest/wave4/run.sh` is the portable shell entrypoint, with supporting core/runtime/k6/collector/report modules, private configuration template, output exclusions and operator README. It implements the 100,000-user seed/random10,000 SharedArray identity plan and gradual2,000+7,000 peak9,000 schedule. Default second ramp is configurable two minutes; the requested initial five-minute and peak fifteen-minute holds are retained. Default80/20 application read/write weighting is configurable. Queue lanes are finite and separately counted; observations never certify durable worker completion.

Full original Wave 4 scope and execution order: [WAVE4-QUALIFICATION.md](WAVE4-QUALIFICATION.md). No stage acceptance was advanced by this source work.

## Verification

Final bounded command:

```bash
taskset -c 0 flock /tmp/swat-package11-checks.lock python3 -I /root/SWAT/scripts/build-completion-runner.py build-w4-load-offline-02 test threats/project-completion-20261117/w4-load.config.ts --evidence-dir threats/project-completion-20261117
```

44 actual assertionResults passed across one literal test file; zero failed/skipped/pending/todo. Command/child exit0, no timeout, elapsed3.187seconds, unchanged inputs. CPU affinity[0],512MB Node heap,onefork,synthetic environment and network/credential guard. The heap setting is not a whole-process RSS/cgroup memory cap. The outer shared flock is recorded in the invocation, not in runner JSON. Earlier35-test source run also passed; its assertions are not added to the final44.

Separate foreground `bash -n run.sh` and `node --check` for core/runtime/collect/report all exited0 under CPU0/sharedflock. `git diff --check` passed. Private run/token/local-config paths are ignored. No full build, emit or browser check was needed or run. Actual k6 parsing/runtime and shell process control against real infrastructure remain unqualified; VM tests stub the k6 runtime.

Raw final result SHA256: `3b0d91c20661199d04844d2f9ce69652880b40ba6dde144b916e7f7b6352f8bb`.
Input manifest SHA256: `c5858953f10ed0794a3e0a55a71b88aff15b0eadbc24af64151961bdf63e8023`.
Source/evidence summary: [WAVE4-LOAD-SOURCE-EVIDENCE.json](WAVE4-LOAD-SOURCE-EVIDENCE.json), SHA256 `8c14adcf1e3a5b2ef52287eddb7f40e988bc68cb66eb733642d4afa262f9d910`.
Raw build artifacts remain local/ignored; summary is trackable. Archive nonsecret raw evidence to separately approved durable storage before remote acceptance.

## Independent sequential review

One independent read-only reviewer reviewed the source, approved the literal offline import surface and rechecked affected repairs. Initial review used22calls (above its approximate20-call target); affected rechecks used8 and4calls. No independent tests/network/services/edits were performed by that reviewer.

Supported findings repaired:

- Required canonical source event type/id/observed-state fields supplied; schema/global-read preflight and ten pilot sessions precede bulk seeding.
- Exact threshold/predicate validation replaces mismatched arbitrary threshold counts.
- Indirect Redis/DB connector options rejected; TLS verification may not be disabled.
- All Node/k6 child environments sanitized against inherited debug/preload/cloud/proxy options.
- Collector initialization/cleanup protected; atomic heartbeat and stale-telemetry abort; direct collector PID launch and generator-exit boundary handling.
- Required finite telemetry, reset fields, numeric bigint deadlocks, bounded integer admissions and supplied cgroup event validation.
- Strict increasing sample times, interior generator observations, phase spans/concurrency and15-second phase observation gap bounds.
- Redis/persistence/OOM/queue-age/drain failures are surfaced; successful output is explicitly `observations-complete-correctness-unassessed`, never runtime acceptance.

Final reviewer verdict: all supported blocking source findings repaired;44raw assertions and current reviewed source/input hashes independently reconciled. No remaining blocking finding in that focused offline scope. Nonblocking edge: Redis/queue comparison paths expect the collector's numeric output; externally authored numeric-string evidence is not a supported input contract despite broader numeric field validation. Do not substitute external telemetry for the actual collector.

## Retained runtime limitations

Current repository authentication/RLS, NOLOGIN deployment identity and global-read capability prerequisites are source-identified, not runtime-reproduced or repaired here. A remote run must qualify least-privilege boundaries first; never switch runtime to migrator/superuser or disable RLS. The harness requires separately reviewed egress-contained fixture workers and rate-limiter capacity; neither is manufactured by labels/attestations.

Infrastructure observations are local-host/PID/cgroup based. Private token manifests are0600 on0700directories, not application-layer encrypted. Bounded queue events/ages and sequence deltas cannot prove completion, recovery or exactly-once economics. Server slow/lock logs, actual phase/resource limits, approved durable job acknowledgements, real financial/domain invariants and controlled crash/restart evidence remain independent Wave4 requirements. Grafana remote-write is optional and separately allowlisted/authorized; no cloud/publication occurred here. Runtime/live/production readiness remain false.
