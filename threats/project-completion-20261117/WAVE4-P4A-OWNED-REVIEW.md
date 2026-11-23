# P4a owned pipeline foundations — independent source review

## Verdict: REJECT

Reviewer: `agent_ab26c315-4c83-420c-924a-4210bb0d11ab`. Read-only source/history inspection, recorded by the coordinator. The earlier asynchronous reviewer handle was unavailable and yielded no retrievable verdict; this fresh review is the acceptance gate. Report date: 2026-11-23.

Two immutable-capture gaps prevent bounded P4a acceptance. Missing P4b/P4c backing and scenarios are intentionally excluded, not additional rejection reasons.

### R1 — nested signal trigger payload retains caller aliases

`packages/db/src/copy-trade-lifecycle-owned.ts:2925–2931` only shallow-copies `triggerData`. Nested objects, arrays, Dates and serialization hooks remain caller-owned. The ambient facade prepares before acquisition (`copy-trade-lifecycle.ts:38–39`), but the shared body awaits source/verification/position reads (`copy-trade-lifecycle-owned.ts:912–943`) before merging and serializing (`:945–956,989`). Nested mutation changes persisted JSON; cyclic/unserializable payloads fail after acquisition.

Required repair: synchronously capture the JSON-compatible trigger payload without nested aliases and reject serialization failures before acquisition. Merge authoritative source fields using only the captured representation. Add nested-mutation and pre-acquisition serialization-failure regressions.

### R2 — trade timestamps retain caller-owned Date objects

`packages/db/src/trades-owned.ts:182–183` puts the original `submittedAt` and `confirmedAt` objects into the prepared values array (`:192–197`). `trades.ts:7–10` prepares before acquisition, but later `setTime()` on the input changes timestamps sent to persistence.

Required repair: clone non-null timestamps during preparation without changing null/timestamp semantics. Test mutation of both original Dates between preparation and query. This alias predates extraction; it remains a gap against the explicit P4a immutable-capture requirement, not newly divergent SQL.

## Supporting independent observations

- All 67 lifecycle SQL literals matched pre-extraction history byte-for-byte. Trade INSERT/upsert, its 32 parameters/ownership predicates, and extracted risk body/seven SQL literals matched history.
- Inspected owned leaves neither construct/acquire pools nor issue BEGIN/COMMIT/ROLLBACK. PoolClient reexport is type-only.
- Shared forward-only/subscription state avoids the former ambient edge and preserves examined behavior. Subscription fixture acknowledges exact role/GUC/COMMIT controls without production weakening.
- Public confirmation refusal, non-executable intake, accepted verification, replay/quarantine, tenant identity, position-first lock ordering, cumulative evidence, conservative unknown risk and correction authorization remain.
- Each worker transaction resolves protected persisted capability and rechecks immutable terms; queue tenant does not grant scope. Shared production adapters provide this transaction, and actual worker wiring refuses missing authority. Settlement/uncertainty remains caller-owned.
- Fresh-child containment test source includes real source resolution, required modules, stale-dist/ambient exclusions, PG constructor traps and actual ambient positive control.
- SQL083/084/087 and checked seven-transfer boundary remain unchanged. Public joined pipeline still refuses.

## Limits

No tests, compilers, loaders, services, SQL, network, edits or nested agents were run by the reviewer. The supplied manifest `adb04f14db9653dac1bdd5fe2a5e9455d93d849b899cb9caa3533f544356cfad` and counts were not authenticated by the reviewer. Coordinator raw validation is separate. SQL literal parity is not PostgreSQL/RLS/concurrency/runtime proof. Full protected backing, current admission/cohort/provider/capability/receipt/valuation composition and durable scenario/observer remain P4b/P4c.

This report remains historical after repairs; acceptance requires a fresh re-review and independently reconciled repair epoch.
