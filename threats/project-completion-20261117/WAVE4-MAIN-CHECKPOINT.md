# Wave 4 main build checkpoint — 2026-11-20

**P3 authentication retains bounded independent source acceptance; P4a owned production pipeline foundations started2026-11-20.** The preceding frozen checkpoint passed948 main offline tests/36 files,46 separate load contracts and five noEmit checks. Those passes do not cover new P4 bytes. One implementation owner is active; verification waits for source freeze. Wave4 remains source-incomplete, and dependent Wave5 runtime remains blocked. [Remaining-work map](WAVE4-REMAINING-WORK.md) records the full sequence.

## Source and review boundaries

- P1 protected LP admission and P2 repaired migration installation retain narrow independent source acceptance. SQL083 is preserved, 084 remains refused, and 085–087 are unapplied.
- Canonical selection is 001–087 excluding pinned084: 86 migrations. The existing 079/082 broker remains exactly seven transfers; 087 installs inert auth objects followed only by separate committed external DBA handoff and bounded external activation.
- The [second independent repair review](WAVE4-AUTHENTICATION-SECOND-REPAIR-REVIEW.md) resolved B (shared target binding) and C (runtime lease custody), while retaining **REJECT** for incoming FKs whose child was outside the auth inventory. Original findings 1/3/4/5/6 remain resolved. All preceding reviews are preserved as historical evidence.
- The latest four-file repair removes the ANY-FK exemption and independently pins 42 legitimate external-child plus five auth-child constraints: 47 constraints and 188 enforcement paths. It validates exact constraint/enforcement closure and rejects additional, orphaned or spoofed touching paths, including a private-table wallet unlink blocker. [Fresh independent read-only re-review](WAVE4-AUTHENTICATION-FK-CLOSURE-REVIEW.md) returned **ACCEPT for bounded P3 source**, closing original findings1–6 and A/B/C. The reviewer did not reproduce tests or independently authenticate the manifest; coordinator artifact reconciliation is separate.
- Actual LP authoritative injection, policy-helper/catalog/PUBLIC ACL closure, late capability poison fences, integrated nonce/signature/origin/session-intent wallet route execution and separate-client overlap source remain implemented. Synthetic catalog/lock fixtures do not prove PostgreSQL behavior.
- Evidence writer13, evidence session14, lifetime4 and owned obligation38 contracts retain their earlier scope and open independent review. Positive pipeline56 cases still reconcile inert journals rather than execute the protected production pipeline. Queue and local financial-domain contracts retain their earlier bounded scope.

Detailed repairs and artifact reconciliation are in [WAVE4-AUTHENTICATION-FK-CLOSURE-CHECKPOINT.md](WAVE4-AUTHENTICATION-FK-CLOSURE-CHECKPOINT.md). Earlier [781/36](WAVE4-AUTHENTICATION-SECOND-REPAIR-CHECKPOINT.md) and [748/36](WAVE4-AUTHENTICATION-REPAIR-CHECKPOINT.md) checkpoints remain historical.

## Frozen verification

| Immutable check label | Result |
| --- | --- |
| `build-w4-auth-fkclosure-main-offline-01` | 948 passed; 36 unique literal files; zero failed/skipped/todo |
| `build-w4-auth-fkclosure-load-offline-01` | 46 passed; one file; real MJS source-loader child exercised |
| `build-w4-auth-fkclosure-db-typecheck-01` | DB noEmit, incremental false; exit 0 |
| `build-w4-auth-fkclosure-qualification-typecheck-01` | Qualification noEmit, incremental false; exit 0 |
| `build-w4-auth-fkclosure-api-typecheck-01` | API noEmit; exit 0 |
| `build-w4-auth-fkclosure-api-tests-typecheck-01` | API tests noEmit; exit 0 |
| `build-w4-auth-fkclosure-lp-typecheck-01` | LP noEmit; exit 0 |

All seven first-run checks share immutable consumed-input manifest `738c69d08ce17fdd2cda58f9eb5fa75bd5dc95854495fbb8eaa4adb7a024dcf6` and report unchanged inputs. Current complete runner inputs match; report-only ledger/checkpoint/review edits are excluded by runner policy. Reconciliation validates raw command/log/result/manifest byte hashes and exact literal file/assertion inventories. The 59 preceding recorded checks were also validated against their historical artifacts. Config approval hashes and protected SQL083/084/087 and installation-plan pins remain unchanged.

Checks ran sequentially through `build-completion-runner.py` under CPU0 shared flock, one test fork/512MB Node heap and compiler640MB, synthetic environment and offline network/credential guard. `timeoutSeconds:null` removes runner wall-clock caps, not application transaction/operation/cancellation/shutdown/load-drain deadlines. Heap caps are not RSS/cgroup limits. Fresh DB emit `build-w4-auth-repair-db-emit-01` remains separately recorded; this round did not alter emitted DB implementation source.

No check failed in the incoming-FK repair epoch. Earlier second-repair fixture/promisification, wrapped-error and mock lease-type failures remain retained, along with historical 781/36, 748/36, 709/35, 602/24 and earlier epochs. They are never summed into current or runtime coverage. `git diff --check` passes.

## Remaining implementation and acceptance

P3 bounded source acceptance is reconciled. P4a now implements shared mandatory-client lifecycle/intake/signal/trade/risk, explicit fanout/worker/quote imports, mirror state and production owned obligation reuse. It requires fresh containment/injected/affected checks and independent review before slice acceptance. P4b protected backing/provisioning and P4c executed scenario/durable observer remain, followed by P5 financial integration, P6 races/faults, P7 durable load correctness, P8 private coordinator/cleanup and P9 final audit. These are coding work, not merely missing credentials.

Actual PostgreSQL16 catalog/deparser/RLS/ACL/locking/COMMIT, Redis7/BullMQ/PgBouncer, 100000-user seed, random10000 pool and 9000-peak staged load require separately authorized disposable infrastructure and real observations. No runtime services, real Docker inspection, SQL application, seeding, actual load traffic, real credentials, live signing capability, funds, commit, push or publication occurred. Offline tests used synthetic catalog/lock fixtures, ephemeral signatures and source-loader children only.

`authenticationSourceAccepted=true` is bounded P3 source acceptance only. `sourceComplete=false`, `runtimeAccepted=false`, `liveCapabilityAccepted=false`, `productionReady=false`. Public qualification/pipeline and Package28 refusals remain.
