# Runtime build issues — first full verification run

**Recorded:** 2026-10-18 (verification run started 2026-10-18, entries timestamped individually).
**Environment:** local Docker — Postgres 16.13 (`postgres:16-alpine`, container `e6c153c61e35_swat-postgres-1`), Redis 7 (`redis:7-alpine`, container `6873d13d7d79_swat-redis-1`), Node v22.22.2, pnpm 10.2.0. All commands run at `--concurrency=1` per the operator's OOM constraint.
**Significance:** this is the first time anything in this branch has executed against a real database or Redis. Every prior claim of "verified" meant mocked unit tests only. This file records what that first contact with runtime actually revealed.

## What ran

| Step | Command | Result | When |
|---|---|---|---|
| Infra check | `docker ps`, port probe | Postgres + Redis up and healthy | 2026-10-18 ~12:40 UTC+1 |
| Secret/env checks | `pnpm check:secrets`, `pnpm check:env` | both pass (409 / 242 files) | 2026-10-18 ~12:45 |
| Migrations | `pnpm db:migrate` (via `migrate.ts`) | applied through `060` on `swat` **and** `swat_integration`, replayed cleanly | 2026-10-18 ~12:47 |
| Typecheck | `npx turbo run typecheck --concurrency=1` | 14/14 tasks, ~4 min | 2026-10-18 ~12:50 |
| Unit suite | `npx turbo run test --concurrency=1` | 14/14 tasks, 6m02s | 2026-10-18 ~13:05 |
| Integration suite | `npx vitest run -c vitest.integration.config.ts` vs `swat_integration` | **112 passed / 7 failed** (16 files) — stable across two full runs | 2026-10-18 12:51, 13:00, 21:09 |

## Findings

### ISS-001 — Integration fixtures used removed `quoteQuantity` field (S4-M35 drift) — RESOLVED

**Found:** 2026-10-18 ~12:55.
**Severity:** high — test fixtures were wrong; production code was correct.
**Root cause:** `RecordCopyExecutionEvidenceInput` requires structured `quoteLeg` evidence. The stale bare field was ignored, producing `confirmedQuoteQuantity = null`.
**Fix:** updated all seven integration fixtures to typed `quoteLeg: { amount, currency: 'USD' }` values. No production change.
**Evidence:** `tsc --noEmit -p tsconfig.integration.json` passes; the lifecycle and pipeline integration files pass.
**Why it survived:** `tsconfig.integration.json` is not part of the turbo `typecheck` graph — this is checklist item **S4-M25** made concrete. Fixtures drifted into type errors that only surface against a live database.

### ISS-002 — `master-attributed-inventory.integration.test.ts` uses invalid fixture addresses

**Found:** 2026-10-18 ~13:05.
**Severity:** medium — the S4-M3 acceptance test has never executed for this reason.
**Symptom:** `Error: Invalid solana address` from `resolveChainAddress` at `recordSourceTradeEvent`.
**Root cause:** the test invents addresses like `solana:MasterA${runId}` — not valid base58 — and `recordSourceTradeEvent` validates through `resolveChainAddress` → `isValidAddressForChain` (`packages/shared/src/validation.ts`). The older `lifecycle-fixture.ts` uses real-format pubkeys (`1111…`), which is why only the new test hits this.
**Fix direction:** derive fixture addresses from a valid base58 encoding of the run id (or reuse the fixture-helper pattern). No production change.

### ISS-003 — `master-capacity` window-aggregate test contaminated by earlier cases — RESOLVED

**Found:** 2026-10-18 ~13:10; reproduced during the repair run.
**Severity:** low — test isolation, not production logic.
**Symptom:** "sums only this master, this token and this window" expected `1500`, got `4100` because earlier cases in the same file left live rows for the same run-scoped master.
**Root cause:** the aggregate case ran after writer/idempotency cases without clearing the run's ledger rows. The query correctly included those rows.
**Fix:** the aggregate test now deletes only its two run-scoped master addresses before inserting its five cases. No production code changed.
**Evidence:** `master-capacity.integration.test.ts` passes 15/15, including the aggregate assertion at `1500`; the full integration suite passes 119/119.

### ISS-004 — membership race fixtures exhausted the pool during user setup — RESOLVED

**Found:** 2026-10-18 ~13:12; reproduced and repaired during the follow-up run.
**Severity:** low — test setup pressure, not membership logic.
**Symptom:** the two race tests timed out while `createUser` was creating 50/60 fixture users before the subscription race began.
**Root cause:** both fixture batches used `Promise.all`, opening dozens of database operations on a one-CPU host. Raising `DB_POOL_MAX` alone did not remove the setup bottleneck.
**Fix:** create fixture users sequentially, then retain the concurrent `Promise.allSettled` subscription calls that exercise the membership race. No production code changed.
**Evidence:** `master-membership.integration.test.ts` passes 10/10 with `DB_POOL_MAX=20`; the full integration suite passes 119/119.

### ISS-005 — `copy-position-tenancy` assertion expected strings from numeric SQL columns — RESOLVED

**Found:** 2026-10-18 21:09; isolated 2026-10-18 21:33.
**Severity:** low — test assertion typing, not tenant isolation.
**Symptom:** the direct `pg` query returned `{ confirmed_quantity: 500, cost_basis_usd: 1000 }`, while the test expected string values.
**Root cause:** this test reads numeric columns without `::text`; the repository's PostgreSQL numeric parser returns JavaScript numbers. The tenant predicates and migration were correct.
**Fix:** type the direct query as numbers and assert numeric values. No production code changed.
**Evidence:** the isolated file passes 5/5, and the full integration suite passes 119/119.

### ISS-006 — `migrate.ts` ignores `INTEGRATION_DATABASE_URL`, so the first migration run hit the dev database

**Found:** 2026-10-18 ~12:47.
**Severity:** medium — process hazard, not a code defect. Disclosed because it touched a database the operator may not have expected.
**Symptom:** the first `pnpm db:migrate` applied migrations to `swat` (dev), not `swat_integration`.
**Root cause:** `migrate.ts` reads only `DATABASE_URL` (from `.env` via `tsx --env-file`). `INTEGRATION_DATABASE_URL` is honored only by `vitest.integration.config.ts`, which also **overwrites** `process.env.DATABASE_URL` for the test files. So "migrate the integration DB" requires an explicit `DATABASE_URL` override, and the integration suite silently runs against whatever that variable names.
**Fix direction:** either make `migrate.ts` honor `INTEGRATION_DATABASE_URL` when set, or document the override idiom in the checklist's Stage B section. The dev database was migrated through 060 as a result — idempotent replay makes this harmless, but it was not the intent.

### ISS-007 — the migration ledger was stale: LP took `059`/`060` — RESOLVED

**Found:** 2026-10-18 ~12:48.
**Severity:** low — documentation drift with a real collision risk.
**Fix:** `AUDIT-FIX-CHECKLIST.md` §11 now records `059_lp_dashboard.sql` and `060_lp_auto_rebalance.sql`; the next allocatable migration is `061` (with `052` still reserved for `users.email_verified_at`).

### ISS-008 — the integration typecheck exposed fixture drift (S4-M25) — RESOLVED

**Found:** 2026-10-18 ~13:20.
**Severity:** medium — systemic verification gap, repaired in this round.
**Root cause:** the integration project was not visible in the Turbo task summary, allowing stale fixture contracts to survive until runtime.
**Fix:** repaired the integration fixtures and ran `tsc --noEmit -p tsconfig.integration.json` explicitly; it now passes. The root `typecheck` script already includes this project, so no production build-graph change was made.

### ISS-009 — Polymarket book acceptance failed against external CLOB — OPEN

**Found:** 2026-10-18 21:52.
**Severity:** external/integration — does not block the Postgres-backed runtime suite, but the book-feed acceptance gate is not green.
**Symptom:** Redis PONG and Gamma token discovery passed; `POST https://clob.polymarket.com/books` returned HTTP 400 for both discovered tokens. The harness then attempted `slice` on an undefined response field at `apps/indexer/src/polymarket-book-acceptance.ts:177`.
**Status:** open. No production or harness change made in this runtime-repair round. The next investigation should capture the exact CLOB 400 body and compare the request shape with the current venue contract before changing the feed.

## What this follow-up changed

Test fixtures and test isolation were repaired; no production runtime code was modified. The checklist and this issue record were updated with the evidence. The Postgres-backed integration suite is green, while the external Polymarket book acceptance remains open as ISS-009.

## Immediate next actions

1. Investigate ISS-009 by capturing the CLOB `/books` HTTP 400 response body and validating the request shape against the current venue contract.
2. Continue the remaining S4-M3 implementation work: aggregate manual/redemption exit allocation, lot-aware stop-loss/P&L/capacity consumers, close-all execution, and lot-aware race/replay coverage.
3. Keep the explicit integration typecheck in the build loop so fixture drift cannot bypass compile verification.
4. Do not allocate migration `061` without updating the checklist ledger in the same change.
