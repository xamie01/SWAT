# Wave 4 main build checkpoint — 2026-11-23

**P1–P3, P4a owned production foundations and the bounded P4b fanout candidate/current-admission/cohort slice have independent source acceptance within their stated scopes.** The current frozen verification passed757 affected tests/28 files,948 main tests/36 files,46 separate load contracts and seven noEmit checks, with fresh DB emit04 separately verified. Full P4b, P4 and Wave4 source completion remain false; dependent Wave5 runtime remains blocked. The [remaining-work map](WAVE4-REMAINING-WORK.md) records the complete source and runtime sequence.

## Accepted source and boundaries

P1 protected LP admission and P2 migration installation retain narrow acceptance. Canonical selection001–087 excluding refused084 contains86 migrations. SQL083/084/087 and installation-plan pins remain preserved;085–087 are unapplied. The079/082 broker remains exactly seven transfers; committed external DBA handoff/activation is separate.

P3 incoming-FK closure retains42 external-child plus five auth-child constraints and188 enforcement paths. Its [independent ACCEPT](WAVE4-AUTHENTICATION-FK-CLOSURE-REVIEW.md) and [checkpoint](WAVE4-AUTHENTICATION-FK-CLOSURE-CHECKPOINT.md) remain historical bounded authentication evidence. Earlier [748/36](WAVE4-AUTHENTICATION-REPAIR-CHECKPOINT.md), [781/36](WAVE4-AUTHENTICATION-SECOND-REPAIR-CHECKPOINT.md) and REJECT reports are retained. Synthetic catalog/locking contracts are not PostgreSQL proof.

P4a shares canonical lifecycle/intake/signal/trade/risk bodies in mandatory-client pool-free leaves; ambient facades delegate. Fanout/worker/quote imports are explicit, shared predicates avoid ambient imports and persisted protected obligation scope is resolved every transaction. [Initial P4a REJECT](WAVE4-P4A-OWNED-REVIEW.md) identified nested trigger JSON/trade Date aliases; [repair ACCEPT](WAVE4-P4A-OWNED-REPAIR-REVIEW.md) closed both. Its [checkpoint](WAVE4-P4A-OWNED-CHECKPOINT.md) and534/22 affected epoch under manifest `5d25892e328624342df87393470fa0b06050b704670a414fcbab813af27b0a02` remain historical for their exact bytes, not the current complete inventory.

P4b now shares canonical candidate SQL/mapping, balance/default/projection helpers and current-recipient admission/cohort factories. Production boot delegates. Exact source/job/descriptor capture, accepted protected verification, current blacklist/policy/mode, reducing owned-inventory/target scope, stable/retryable refusal and cohort1000 are preserved. Both candidate/balance SELECTs use one caller transaction; no factory/client confers database authority. The [bounded source ACCEPT](WAVE4-P4B-FANOUT-OWNED-REVIEW.md) and [checkpoint](WAVE4-P4B-FANOUT-OWNED-CHECKPOINT.md) are separate from coordinator raw-artifact validation. Actual fresh-source containment invokes candidate/cohort/admission across16 source modules with zero owned PG constructors and a real ambient positive control. This is not server containment or complete executed pipeline proof.

## Current frozen verification

| Immutable check | Result |
| --- | --- |
| `build-w4-p4b-fanout-offline-04` | 757 passed/28 literal files |
| `build-w4-p4b-main-offline-04` | 948 passed/36 literal files |
| `build-w4-p4b-load-offline-04` | 46 passed/1 literal file; no actual load |
| `build-w4-p4b-db-typecheck-04` | noEmit/incremental:false; exit0 |
| `build-w4-p4b-qualification-typecheck-04` | noEmit/incremental:false; exit0 |
| `build-w4-p4b-signal-engine-typecheck-04` | noEmit/incremental:false; exit0 |
| `build-w4-p4b-trade-executor-typecheck-04` | noEmit/incremental:false; exit0 |
| `build-w4-p4b-api-typecheck-04` | noEmit/incremental:false; exit0 |
| `build-w4-p4b-api-tests-typecheck-04` | noEmit/incremental:false; exit0 |
| `build-w4-p4b-lp-typecheck-04` | noEmit/incremental:false; exit0 |

All ten test/noEmit commands share unchanged complete consumed-input manifest `770ccc9feb5dd1cce3800f97fc159bd24eecda9a9f7d118290361c2915ab8edf`, with current full inventory equality checked. Separate fresh DB emit `build-w4-p4b-db-emit-04` has verified complete emit inputs/output hashes.118 retained command records comprise97 preceding records plus21 P4b records; command/log/result/manifest hashes and literal/assertion inventories are reconciled. All P4b failures remain immutable: missing BalanceSource local type binding at emit01;14 missing-COMMIT-tag fixtures and one incomplete-capacity expectation at affected02; generic Vitest fixture typing at signal-engine-typecheck03. Each was repaired without weakening production checks. Earlier green partial epochs/reviews remain historical. Counts/scopes overlap and are never summed into runtime coverage.

CPU0/shared flock, one test fork/512MB heap, compiler640MB and synthetic offline network/credential guard retained. Runner caps are disabled (`timeoutSeconds:null`), not application transaction/operation/cancellation/shutdown/load-drain/containment-child deadlines. No root build, services, SQL application, real credentials/live signing/funds, traffic, commit/push/publication occurred. `git diff --check` and report/hash/link/flag consistency passed. No active implementation owner or unverified post-checkpoint source changes remain for this freeze.

## Remaining implementation and acceptance

P0 runner independent review; remaining P4b protected source/provider/exact-sizing/capability/risk/receipt/valuation/correction backing and full provisioning; P4c executed buy/sell/reversal/correction/replay and independent durable observer; P5 financial integration; P6 races/faults; P7 durable load correctness; P8 executable private coordinator/cleanup; P9 final audit remain coding work. Protected `swat_fanout` cross-tenant authorization is still missing, and balance projection is not exact approved follower sizing. No new SQL/grants/broker changes were part of this slice.

Actual I1–I8 PostgreSQL16/Redis7/BullMQ/PgBouncer/provider/financial/concurrency/fault/load/cleanup qualification requires separately authorized infrastructure and real observations. `authenticationSourceAccepted=true`, `p4aSourceAccepted=true`, `p4bFanoutSourceAccepted=true`; `p4bSourceAccepted=false`, `p4SourceAccepted=false`, `sourceComplete=false`, `runtimeAccepted=false`, `liveCapabilityAccepted=false`, `productionReady=false`. Public qualification/positive-pipeline and Package28 refusals remain. Dependent Wave5 runtime requires genuine Wave4 I1–I8 acceptance, not source acceptance alone.
