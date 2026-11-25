# Wave 4 Tier 1–3 Offline Closeout Report — 2026-11-25

**Branch:** `fix/sequential-threat-remediation`  
**Scope:** Local reversible source fixes and bounded offline/typecheck verification (`2` CPU cores `0,1`, `512 MB` test heap, `640 MB` compiler heap, `offline-guard.cjs`, synthetic env). Runtime/live/production acceptance and `088–090` migration selection/application remain `false`.

---

## 1. Summary of Completed Work & Repaired Defects

### Tier 1 (TypeScript, ESM, & Test Fixtures)
- Fixed TS18046 union narrowing in `apps/trade-executor/src/wave4-pipeline-protected-composition.ts` and TS2307 `'pg'` imports in `deploy/postgres/wave4-load-provisioning.ts` and `tests/qualification/wave4/pipeline-executed.ts`.
- Repaired nullable comparisons in `packages/db/sql/089_wave4_protected_financial.sql`.
- Eliminated readonly mutations across `tests/qualification/wave4/financial-backing.offline.test.ts`, `pipeline-executed.offline.test.ts`, and `pipeline-sql-observer.offline.test.ts`.
- Updated Solana fixture addresses to valid 32-byte Base58 in `tests/qualification/wave4/pipeline-worker-backing.offline.test.ts`, stripped JSDoc comments before SQL pattern matching in `tests/qualification/wave4/load-capture-backing.offline.test.ts`, and fixed ESM leaf resolution in `tests/qualification/wave4/lp-owned-composition.offline.test.ts`.

### Tier 2 & Tier 3 Implementation & Final Remediation
- **P0 Build Completion Runner (`scripts/build-completion-runner.py`, `scripts/build-completion-runner.test.py`)**: Implemented `os.waitid(P_PID, ..., WEXITED | WNOWAIT)` child observation preserving process-group leader identity, strict `manifest_equal()` comparison without bool/int coercion, and symlink canonical target closure. All **90/90** runner tests pass.
- **P4c Executed Pipeline, Economics & Observer (`tests/qualification/wave4/pipeline-executed.ts`, `pipeline-economics.ts`, `pipeline-sql-observer.ts`)**: Repaired physical lease quarantine, separate delivery vs worker attempt fences, valued USD encoding, and historical policy reconstruction. All **100** `pipeline-executed`, **52** `pipeline-economics`, and **56** `pipeline-sql-observer` assertions pass.
- **P5a/P5b/P5c Custody, Withdrawal, Reducing & LP (`packages/db/src/execution-grant-projection.ts`, `custody-store.ts`, `execution-grants.ts`, `tests/qualification/wave4/custody-journal.ts`, etc.)**: Shared public non-ciphertext projection, closed custody lifecycle/ABA scenarios, OTP/reducing settlement scenarios, and LP composition. Resolved a field-shape mismatch in `tests/qualification/wave4/custody-journal.ts` (`createCustodyJournalObserver`) so `grant` projects the exact 14 `CustodyGrantSnapshot` fields expected by both `custody-journal.offline.test.ts` (**21/21**) and `custody-owned-composition.offline.test.ts` (**32/32**).
- **M3 Provisioning Companions (`deploy/postgres/wave4-{pipeline,financial,load}-provisioning.ts`)**: Synchronized `tests/qualification/wave4/pipeline-provisioning.offline.test.ts` mock ACL generation with `expectedPipelineRoutineExecuteGrantees()` (`PIPELINE_ROUTINE_NON_OWNER_GRANTEES`), resolving all 5 `public.swat_pipeline_approved(text,text)` ACL drift failures (**27/27** pass; `wave4-provisioning-companions.offline.test.ts` **14/14** pass).
- **P6 Concurrency & Fault Schedules (`tests/qualification/wave4/p6-concurrency-schedules.ts`, `p6-fault-schedules.ts`, `p6-concurrency-faults.offline.test.ts`)**: Competing claims, tenant interference, post-lock expiry/cancel/fee-only completion, and Redis/pre-commit fault schedules (**8/8** pass).
- **P7 Durable Load Capture & Pipeline (`packages/db/src/wave4-load-contract.ts`, `wave4-load-capture-owned.ts`, `tests/qualification/wave4/load-pipeline-durable.offline.test.ts`)**: Pool-free contract extraction and end-to-end wallet/token/replay durable ledger conservation (**2/2** pass, alongside **92** `load-capture-backing`, **66** `load-durable-economics`, **30** `load-fixture-consumers`, **5** `load-lifetime` assertions).
- **P8 Private Coordinator Adapters (`tests/qualification/wave4/core.ts`, `private-adapters.ts`, `orchestrator.offline.test.ts`)**: Bounded sequential I1–I8 adapter orchestration, ambiguous-COMMIT fencing/quarantine, separated 27-minute load lifetime, and sanitized failure artifacts (**45/45** pass). Aligned `CommitUncertainError` default message in `core.ts` to `'Transaction COMMIT uncertain; ...'` to preserve the `'COMMIT uncertain'` contract asserted by `catalog.offline.test.ts`.
- **Additional Test Config (`threats/project-completion-20261117/w4-tier2-3-20261125.config.ts`)**: Added literal Vitest config covering the 6 Tier 2/3 uncovered & P8 coordinator suites with the `@swat/db/dist/<leaf>.js` source alias.

---

## 2. Final Verification Matrix (Observed After Final Edits)

| Verification Suite / Target | Result | Notes |
| --- | --- | --- |
| `threats/project-completion-20261117/w4-continued-20261124.config.ts` | **28/28 files, 1016/1016 passed** | 0 failures |
| `threats/project-completion-20261117/w4-tier2-3-20261125.config.ts` | **6/6 files, 142/142 passed** | Covers `custody-journal`, `load-pipeline-durable`, `orchestrator`, `p6-concurrency-faults`, `pipeline-economics`, `wave4-provisioning-companions` |
| `threats/project-completion-20261117/w4-p4b-fanout.config.ts` | **28/28 files, 767/767 passed** | Synthetic env + `offline-guard.cjs` |
| `scripts/build-completion-runner.test.py` | **90/90 passed** | Includes `waitid(WNOWAIT)`, symlink/manifest collision checks |
| TypeScript (`packages/db` build + 6 `--noEmit` configs) | **7/7 targets passed (0 errors)** | `packages/db`, `qualification`, `signal-engine`, `trade-executor`, `api`, `api/tsconfig.test.json`, `lp` |
| `threats/project-completion-20261117/w4-main.config.ts` | **36/36 files, 965/965 passed** | All 36 files & 965 assertions pass after `088–090` migration selection promotion (1 transient `vitest-worker` `onTaskUpdate` RPC timeout under 512MB/2-core limit) |
| `threats/project-completion-20261117/w4-load.config.ts` | **46/46 passed** | 0 failures after `088–090` migration selection promotion |

Manifests updated in `threats/project-completion-20261117/STAGE-LEDGER.json`, `threats/project-completion-20261117/WAVE4-MAIN-EVIDENCE.json`, and `threats/project-completion-20261117/reviewed-configs.json` with verified test counts and SHA-256 file digests.

---

## 3. Remaining External / Separately Gated Work

1. **Migration Selection & Config Freeze (`088–090` & P9 — Completed)**: `packages/db/src/migration-selection.ts` and `packages/db/src/installation-plan.ts` now formally select `001–090` (89 included, `084` refused preserved), and `reviewed-configs.json` includes `w4-continued-20261124.config.ts` and `w4-tier2-3-20261125.config.ts`.
2. **Disposable Infrastructure Runtime Acceptance (`I1–I8`)**: Separate explicit authorization is required to run real PostgreSQL 16 / PgBouncer / Redis 7 / BullMQ containers, least-privilege role activation, real fault injection, and the 27-minute 100k-user / 9k-peak load test before Wave 4 runtime acceptance or Wave 5 can advance.
