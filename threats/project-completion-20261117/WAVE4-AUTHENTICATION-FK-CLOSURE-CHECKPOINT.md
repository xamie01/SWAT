# Protected authentication foreign-key closure checkpoint — 2026-11-20

## Status

The frozen incoming-FK repair passes **948 main offline tests across 36 unique literal files**, **46 separate load-harness contracts** and **five noEmit compiler checks**. Raw artifacts and the complete current consumed-input inventory are reconciled. [Independent read-only re-review](WAVE4-AUTHENTICATION-FK-CLOSURE-REVIEW.md) returned **ACCEPT for bounded P3 source**, closing original findings1–6 and repair findings A/B/C. It supersedes the second-repair REJECT only within source scope. The reviewer did not reproduce tests or independently authenticate the manifest; coordinator artifact reconciliation is separate.

## Bounded repair

Only these four source/contract files changed from the second-repair freeze:

- `deploy/postgres/auth-provisioning.ts`
- `deploy/postgres/auth-catalog-dependencies.ts`
- `deploy/postgres/auth-catalog-fixture.ts`
- `deploy/postgres/auth-provisioning.offline.test.ts`

The gate no longer exempts internal triggers associated with any FK. An independently transcribed canonical inventory includes 42 external-child FKs referencing `users(id)` and the five auth-child FKs: **47 constraints and 188 enforcement paths**. One validator checks exact constraint metadata, column/type/equality identities, dependencies and the four enabled, constraint-associated builtin trigger paths. A final touching-trigger scan uses only validated constraint OIDs and refuses additional, orphaned or spoofed paths. Generated trigger names and OIDs are not portable source constants.

The synthetic protocol fixture is not imported by production. Contracts anchor all 42 external-child entries to canonical migration source and reject additional private-table wallet unlink blockers, same-size constraint substitutions, expected constraint/enforcement drift, and orphaned/spoofed touching paths. Hostile pre-handoff catalog paths refuse before grants, routine alteration or COMMIT. The auth provisioning suite now has 210 tests, up from 43 in the historical second-repair epoch.

## Immutable verification

| Check label | Result |
| --- | --- |
| `build-w4-auth-fkclosure-main-offline-01` | 948 passed; 36 unique literal files; zero failed/skipped/todo |
| `build-w4-auth-fkclosure-load-offline-01` | 46 passed; one literal file; real MJS source-loader child exercised with database construction forbidden |
| `build-w4-auth-fkclosure-db-typecheck-01` | DB noEmit, incremental false; exit 0 |
| `build-w4-auth-fkclosure-qualification-typecheck-01` | Qualification noEmit, incremental false; exit 0 |
| `build-w4-auth-fkclosure-api-typecheck-01` | API noEmit; exit 0 |
| `build-w4-auth-fkclosure-api-tests-typecheck-01` | API tests noEmit; exit 0 |
| `build-w4-auth-fkclosure-lp-typecheck-01` | LP noEmit; exit 0 |

All seven first-run checks passed with unchanged consumed-input manifest:

`738c69d08ce17fdd2cda58f9eb5fa75bd5dc95854495fbb8eaa4adb7a024dcf6`

Each immutable label has `.command.json`, `.log` and `.inputs.json` artifacts in this directory; test labels also have `.json` assertion results. Reconciliation checks command/log/result/manifest byte hashes, exact literal file/assertion inventories, approved config hashes and full current runner input equality. All 59 preceding recorded checks were also validated against their own historical manifests and result inventories. Earlier epochs and failures remain separate and are not summed into current or runtime coverage.

Checks ran sequentially through the shared CPU0 flock with one test fork/512MB Node heap, compiler640MB, synthetic environment and offline network/credential guard. `timeoutSeconds:null` removes the runner wall-clock cap, not application transaction, operation, cancellation, shutdown or load-drain deadlines. Heap caps are not RSS/cgroup limits. No DB emit was needed in this round because emitted DB implementation source was unchanged; the earlier fresh emit remains historical.

## Preserved boundaries

Canonical selection remains 001–087 excluding pinned/refused084 (86 migrations). SQL083, SQL084, SQL087 and `installation-plan.ts` byte pins are unchanged. The existing 079/082 broker remains exactly seven transfers. Forced RLS, explicit auth injection, no ambient app fallback, checked owned transaction/lease custody and uncertain-COMMIT lease discard remain preserved. SQL085–087 remain unapplied; no implicit auth LOGIN/password SQL or additional authority was introduced.

The original [six-finding review](WAVE4-AUTHENTICATION-REVIEW.md), [first repair review](WAVE4-AUTHENTICATION-REPAIR-REVIEW.md), [second repair review](WAVE4-AUTHENTICATION-SECOND-REPAIR-REVIEW.md), [748/36 checkpoint](WAVE4-AUTHENTICATION-REPAIR-CHECKPOINT.md) and [781/36 checkpoint](WAVE4-AUTHENTICATION-SECOND-REPAIR-CHECKPOINT.md) remain historical.

Actual PostgreSQL16 catalog/deparser/builtin metadata/dependencies, ACL/RLS/locking/COMMIT outcomes and broader runtime services/load/economics/cleanup remain unqualified. Synthetic catalog/lock fixtures, ephemeral in-memory signatures and source-loader children are not runtime evidence. No services, real Docker inspection, SQL application, seeding, load traffic, real credentials, live signing capability, funds, commit, push or publication occurred.

P4 has not started; P4–P8 implementation and P9 final audit remain outstanding. `authenticationSourceAccepted=true` is bounded P3 source acceptance only. `sourceComplete=false`, `runtimeAccepted=false`, `liveCapabilityAccepted=false` and `productionReady=false` remain unchanged.
