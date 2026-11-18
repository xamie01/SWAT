# Wave4 LP-copy observer affected-source review — 2026-11-18

**Disposition: narrow repaired ONE-CLOSE source/injected-contract seam accepted. Whole Wave4 source and runtime acceptance remain withheld.**

## Scope and repair

`tests/qualification/wave4/lp-copy-observer.ts` requires a caller-supplied `LpTenantTransaction`; it has no ambient pool, credential loader, queue or service startup. It captures a primitive UUIDv4 tenant before awaiting, observes exact current/session `swat_app`, tenant helper, row security and bypass settings, locks the tenant owner, checks exact/base position agreement, and exports at most one receipt using a bounded two-row probe. It recomputes the stored receipt body hash and snapshots exported DTOs.

Independent read-only reviewer `agent_ecbee261-52f0-447d-9347-6d915b119aba` accepted the initial limited scope with a nonblocking operation-ID coercion finding. The repair requires `typeof operation_id === 'string'` before UUID validation. The affected regression rejects a hostile coercible identifier without calling `toString`; a second regression proves caller-scope mutation after awaiting does not replace the captured tenant. The reviewer confirmed repaired narrow acceptance with exactly two targeted Reads. A subsequent result relay performed no additional Reads.

## Coordinator verification reconciliation

- `build-w4-main-offline-22`: 396 passed across 14 literal files, including 30 observer contracts; zero failed/skipped/todo, exit0.
- `build-w4-main-typecheck-20`: qualification noEmit, incremental false, exit0.
- Both consumed-input manifests have SHA256 `30edcb7a79173968e857aa51889ffe45f54a2bc913616eb56859a97f50b21f3b` and report workspaceInputsUnchanged=true.
- CPU0 shared flock runner, one test fork/512MB Node heap and 640MB compiler heap, synthetic environment and offline network/credential guard. Heap bounds are not whole-process RSS/cgroup limits.
- Compiler17's hostile `toString` return annotation and compiler19's readonly mutation fixture errors remain retained. Repairs were test-only; production readonly types and validation were not weakened. Intermediate 394/396 checks are superseded, not added to current totals.

The reviewer did not independently verify command outputs or manifest integrity. The coordinator reconciles raw command/log/result/input hashes and current source/config bytes in `WAVE4-MAIN-EVIDENCE.json`.

## Required limitations

The supplied transaction must commit before resolving and own all pending client work. The interface does not prove ownership, provide credentials or cancel arbitrary noncooperating ports. Inert SQL transcript responses do not prove actual authentication, forced RLS, PostgreSQL snapshots, writer-lock cooperation, COMMIT durability, concurrency or runtime containment. This observer is specific to one-close scenarios, not a general multi-operation receipt export.

Hash and stored identity consistency are not independent provider/quote/economic admission. The HIGH SQL083 protected admitted receipt/quote/economics finding remains unresolved. SQL083 and accepted load source remain unchanged; SQL084 application, the public CLI and positive pipeline remain refused. No SQL, infrastructure, load, signing, commit or publication ran. `sourceComplete=false`, `runtimeAccepted=false`, `liveCapabilityAccepted=false`, `productionReady=false`; Wave5 remains blocked.
