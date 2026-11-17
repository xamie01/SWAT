# Wave 4 — isolated paper and infrastructure qualification

Status: **requires separately authorized isolated environment; runtime not accepted.** The added load harness is source preparation for one subgate. It does not replace any original Wave 4 obligation, and no test below has been executed against infrastructure on this host.

## Mandatory gates retained

| Gate | Required evidence before acceptance |
| --- | --- |
| I1 — environment and migration identity | Independent PostgreSQL 16 reference/candidate and Redis identities; immutable image/source/dependency hashes; explicit resource/network/volume boundaries; exact migration journal and schema/catalog comparison through the reviewed suffix. Never apply schemas on this host. |
| I2 — roles, authentication and tenant isolation | Separate least-privilege runtime, migration, custody, settlement, capture/worker and observer capabilities; no ownership or ambient bypass; forced RLS read/write and pooled-transaction tenant-reset negative tests; authenticated application identity and cross-tenant refusals. Resolve NOLOGIN/session/global-read boundary prerequisites through reviewed capabilities, never broad grants. |
| I3 — real paper pipeline | Verified synthetic source descriptor through durable obligations, fanout, worker admission, trusted injected paper quotes, exact fills/accounting and immutable correction journals on actual infrastructure. Providerless/unavailable paths remain unavailable. Fixtures do not qualify live provider trust. |
| I4 — financial/domain integration | Custody envelope/delegation revision, revocation/deadline boundaries; withdrawal single-use OTP/outbox/cooling; uncertain-execution reconciliation; receipt-backed reducing/independent collateral; exact LP acquisition/copy/budget/receipt close/rebalance. Actual database constraints and transactions, not SQL-text inspection. No signing, funds or external trading. |
| I5 — concurrency and rollback | Competing claims/admissions, duplicate retries, tenant/account interference, post-lock expiry/cancel races, same-intent fee-only completion, receipt/operation INSERT guards, exact inventory conservation and rollback with actual PostgreSQL schedules. Record assertions, isolation levels, lock waits and final journals. |
| I6 — crash/restart and durable queues | Kill-point/restart recovery before/after database commit and enqueue/ack; no lost obligations or duplicate economics; BullMQ retry/stall recovery; run-bound durable completion evidence and failed/uncertain reconciliation. No queue count alone proves acknowledgement. |
| I7 — load and resource qualification (added) | Portable `deploy/loadtest/wave4/run.sh`; 100,000 new users, random 10,000 session identities, 9,000 peak VUs following gradual 2,000+7,000 schedule; weighted application reads/writes, PostgreSQL/PgBouncer waits/slow logs, Redis/BullMQ hot-memory and host/application/generator observations. Review actual achieved throughput, phase span, limiter behavior and durable admissions/completions. |
| I8 — independent acceptance | Frozen source/tool/config/artifact hashes; retained raw assertions and failures; actual cleanup/drain/time/resource evidence; independent review, supported repairs and affected reruns; coordinator report and ledger update. Only then may Wave 5's dependent runtime acceptance proceed. |

## Execution order

Qualify I1/I2 first. Exercise real injected paper seams and domain SQL invariants (I3–I5), then controlled crash/restart/queue durability (I6). Run the additional load simulation (I7) only after authentication, fixture consumers, egress containment, pooling and monitoring are proven. A final independent reviewer reconciles all gates (I8). Source work independent of missing runtime inputs may continue, but blocked work is not completed work.

The load script intentionally does not provision services, apply migrations, repair production auth/roles, implement provider adapters or run crash tests. Those are independent reviewed Wave 4 tasks. Source review identified the current unscoped session lookup under forced RLS, NOLOGIN runtime deployment mismatch and restricted global reads as prerequisites; these are not runtime-reproduced findings or fixed by the load harness.

## Load subgate specifics

- Schedule: ramp 0→2,000 over three minutes; sustain five minutes; gradually add 7,000 (two-minute configurable default); sustain 9,000 fifteen minutes; two-minute cooldown and bounded 60-second drain. The 10,000 sampled pool has 1,000 reserve, not invented extra concurrency.
- Default 80% reads/20% writes, adjustable 10–90% reads. Ordinary application endpoints only; no direct k6 SQL. Authenticated GETs still update sessions. Finite queue lanes permit one wallet and token attempt per identity, with attempted HTTP requests and admission observations separated.
- Source/plan/offline checks do not seed records or consume credentials. Remote `--run` requires exact target allowlists, private configuration and independently reviewed deployment evidence.
- Full prerequisites, commands, metrics, failure semantics and limitations: [operator README](../../deploy/loadtest/wave4/README.md).
- The assessment can report observations complete while leaving correctness unassessed. It cannot advance Wave 4, certify queue acknowledgements or infer production readiness.

All Wave 1–3 acceptance scopes remain unchanged. `runtimeAccepted`, `liveCapabilityAccepted` and `productionReady` remain false until their distinct evidence gates are actually passed.
