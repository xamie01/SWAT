# Wave4 queue source repair review — 2026-11-18

## Outcome and boundary

Independent reviewer `agent_e26c3a8d-8181-4265-a1bf-95f0aac2f2b9` accepted all four supported queue-source repairs after sequential read-only review and two targeted rechecks. This accepts the affected repairs only, not the entire Wave4 package, real infrastructure, actual stall/redelivery or production readiness. Runtime CLI, positive pipeline and Package28 entrypoints remain unconditionally refused.

## Findings and repaired disposition

1. **Completion waiter — high:** installed BullMQ5.76.8 `waitUntilFinished` has an async Promise executor whose internal readiness/poll errors are not joined, and closing QueueEvents does not reliably cancel its TTL. Replaced with owned persisted `getState` polling, tracked errors and cancellation-owned interval; retained job and Redis stream still independently prove completion.
2. **Detached stalled checker — medium:** installed Worker `run`/`close` do not join its separately launched checker, including an in-flight-check/post-close-timer race. Added a BullMQ5.76.8 version-gated adapter that tracks the checker promise and uses cancellation-owned interval waits. No manual lock/job repair or suppression of normal stall detection.
3. **Populated Redis binding — medium:** optional observed run ID allowed unbound populated observation. Split private initial observer from populated binding; latter requires a canonical previously observed run ID before observation, and queue runtime validates it before creating connections. Initial admission still requires pristine Redis7/db0.
4. **Financial reconciliation — medium:** original selected aggregates admitted a materially incomplete receipt/acquisition snapshot. Added durable acquisition and stored receipt row/hash capture, independently computed expected acquisition/close fingerprints, run-bound tenant/provider/network/pool/asset identities, exact raw/scale amounts, receipt/quote hashes, arithmetic from exact basis and receipt, and three-transition history. First recheck found an acquisition-quote provenance gap; final repair and two-file recheck closed it.

Initial review was read-only. First targeted recheck used eight reads; final targeted recheck used two reads. No reviewer tests, writes, queues, clients, services or infrastructure effects occurred. Coordinator verification followed the last source repair; a reviewer message saying the rerun was pending described its own observation time, not the final checkpoint state.

## Final affected verification

- `build-w4-main-offline-14`:208 passed/7 literal files;56 queue contracts,38 orchestrator,39 containment,4 rollback,58 Package28 and13 schema. No failed/skipped/todo assertions.
- `build-w4-main-typecheck-12`:qualification no-emit compiler exit0.
- Both consumed-input manifests match `a04f20c67162bb6aa3892304bc4f54f08c3b1d883803bcfce4d2a9d7cb2627fa`.
- Commands ran sequentially under CPU0 shared flock. Tests512MB/onefork; compiler640MB. Heap bounds are not RSS/cgroup bounds.
- Retained failed compiler09 reported unknown bridge values and a zero-argument mock tuple; narrow typing repairs were followed by passing compilers10–12. Superseded successful runs are not added to totals.

## Coordinator disposition

The queue scenario source is a partial I6 implementation with independently accepted affected repairs and offline contracts. No SQL, Redis, BullMQ, fault child or load scenario was executed. Other Wave4 source/containment/capability gates remain open. No runtime acceptance or Wave5 advancement is granted.
