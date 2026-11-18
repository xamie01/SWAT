# Wave4 main build checkpoint — 2026-11-18

**Outcome: 422 offline tests across 15 files and qualification typecheck21 pass. The repaired one-close SQL observer, unwired admission comparison contract, credential repair and SQL084 refusal received narrow independent acceptance; whole Wave4 remains incomplete.** The original gates and added load subgate are preserved. No services, Docker inspection, SQL application, seeding, real credentials, fault children, signing or load traffic ran.

## Current source coverage

- Shared monotonic deadlines, owned PG/Redis/command/child lifetimes, private bounded no-follow configuration reads and numeric tmpfs/resource checks remain implemented as source/mocked contracts. Socket destruction does not prove server COMMIT rollback.
- Actual SQL-store LP acquisition/rebalance/close/recovery and controlled rollback/competing schedules remain unexecuted source. IPC acknowledgement is not BullMQ completion.
- Genuine same-job BullMQ normal stall/redelivery retains narrowly accepted queue repairs: run-derived namespace and Redis identity, owned Worker post-COMMIT kill boundary, persisted attempts/stalls/events and exact immutable receipt/acquisition/history/economics reconciliation. No actual queue ran.
- Catalog retains exact migration rows and digests; credential components are decoded once and password stays in PGPASSWORD.
- Withdrawal has 35 injected actual-service/store contracts for OTP/idempotency/one-use/cooling/reservation/refusal and reducing admission, not deployed OTP/dispatch/receipt/collateral composition.
- LP-copy has 32 actual-service/inert-store contracts for independent BigInt sizing, provenance/budget/receipt/closed economics/replay, plus a concrete ONE-CLOSE SQL observer with 30 injected transcript contracts and narrow repaired acceptance. Authenticated owned runtime composition, actual lock/COMMIT proof and protected initialization remain missing.
- Custody has 16 contracts using explicit synthetic bytes and fresh local AEAD, full binding/lifecycle/ABA/expiry/zeroing checks. No wallet key, signing, deployed wrap/unwrap identity or delegation proof.
- Pipeline has 56 inert journal reconciliation contracts for buy/sell/reversal/correction/replay, not a protected executed pipeline. Public entrypoint remains refused.
- A new unwired admission comparison contract has 26 synthetic contracts for full quote/context/actual settlement binding, independent record absence, exact rebalance positivity and chronology. Narrow repaired comparison-only review is accepted; no protected registry, writer, SQL/store/service integration or authority exists. See `WAVE4-LP-ADMISSION-SOURCE.md`.
- SQL084 now refuses application before all eleven proposed grants, which remain inside the same block. Proposed trigger/body prerequisites are stronger but unexecuted. SQL083 remains unchanged and its independent receipt-admission/economic boundary remains unresolved.

## Independent review

Expanded reviewer `agent_2c9a653b-3ab4-41b1-a6c5-57e942cf5018` withheld acceptance for incomplete SQL084 trigger/function checks, SQL083 tenant-writable paper receipts without independently admitted quote/economic binding, and URL-encoded catalog credentials. Narrow reviewer `agent_4f7b29ea-0748-4d30-9ba6-63ebb0adf334` accepted credential repair and unconditional proposal containment after six focused reads. That acceptance is not usable migration, installed ACL, whole-source or runtime acceptance. HIGH receipt integrity remains unresolved. See `WAVE4-REVIEW-REPAIRS.md`. Earlier queue affected-source acceptance is preserved separately. Reviewer `agent_ecbee261-52f0-447d-9347-6d915b119aba` confirmed narrow repaired ONE-CLOSE observer acceptance after two targeted Reads; actual transaction ownership, authentication, cancellation, COMMIT and concurrency remain unproven. The reviewer did not verify raw command results; the coordinator reconciled those separately. See `WAVE4-LP-COPY-OBSERVER-REVIEW.md`.

## Actual offline verification

All checks ran sequentially via CPU0 shared flock and `scripts/build-completion-runner.py`; synthetic environment and offline Node network/credential guard. Tests use one fork/512MB heap; compiler 640MB. Heap bounds are not process RSS/cgroup limits.

| Current check | Result |
| --- | --- |
| build-w4-main-offline-23 | 422 passed, zero failed/skipped/todo; 15 literal files; exit0 |
| build-w4-main-typecheck-21 | Qualification noEmit, incremental false; exit0 |

Per-file totals: orchestrator38, containment39, rollback4, queue56, catalog9, LP privileges10, withdrawal35, pipeline56, LP-copy32, LP-copy observer30, admission comparison26, custody16, Package28 preflight56, Package28 containment2, schema13.

Shared consumed-input manifest: `1dfae5d1bb77647abd90bc5360979bff58dcd984797fc9571993d6375b4d0c19`. Both commands report workspaceInputsUnchanged=true. Coordinator reconciliation checked raw command/log/result/input hashes, literal inventory and all current consumed code/config/SQL bytes with zero mismatches. Documentation-only reconciliation followed. Raw artifacts remain local; compact records are in `WAVE4-MAIN-EVIDENCE.json`.

Earlier passing 208/344/360/366/394 checkpoints and the396 checkpoint and intermediate396 checks are superseded, not summed. Retained failures include offline05 (two fixture/static-contract errors), typecheck05/09 (typing), expanded offline15 (334 passed/10 failed from one-rung fixture versus required two-rung plan), typecheck13 (missing/narrowed types), typecheck17 (hostile toString return annotation) and typecheck19 (readonly mutation fixture). The observer compiler repairs were test-only and did not weaken production readonly types. Production validation was not weakened; fixture allocations conserve exact BigInt capital. Historical LP160/DB/runner checks retain their own inputs and are not current full-workspace rechecks.

## Every remaining gate

- **I1:** independently owned infrastructure/images/migrations/catalog/identity, narrow observer capability, actual server/socket/child settlement and measured resource/shutdown containment.
- **I2:** safe authenticated login/pre-session/global-read composition, least-privilege roles and real forced RLS/PgBouncer reset/limits; usable canonical LP privileges and protected receipt admission. SQL084 refusal is containment, not completion.
- **I3:** concrete pool-free protected source/provider/capture/obligation/fanout/worker/receipt/valuation composition and actual durable pipeline journals.
- **I4:** deployed distinct custody/delegation/OTP/funding/receipt/mapping composition, canonical reducing/collateral/accounting and concrete authenticated LP observers; hostile SQL receipt/economic integrity proof.
- **I5:** canonical claims, post-lock expiry/cancel, cross-tenant/account/fee races, actual controlled lock/rollback evidence and exact conservation.
- **I6:** actual accepted same-job queue execution plus missing Redis-loss/source/outbox/canonical fault source and uncertain reconciliation. Wording is current; functional gaps remain.
- **I7:** independently joined durable load completions/economics and actual PostgreSQL/PgBouncer/Redis/BullMQ/host/app/worker/generator observations. Accepted 44-contract portable load addition remains unchanged and unexecuted; it still pins SQL083, so the future baseline needs affected review.
- **I8:** whole repaired source review, authorized actual I1–I7 evidence, frozen artifact/source/config joins, cleanup and coordinator acceptance. No such acceptance exists.

Precise separately authorized disposable environment/tool/target/image/provision/migration/seed/fault/load/cleanup inputs are absent. They must not be improvised. `sourceComplete=false`, `runtimeAccepted=false`, `liveCapabilityAccepted=false`, `productionReady=false`; public CLI/pipeline/Package28 refusals remain. Wave5 is blocked. No commit/push/publication.
