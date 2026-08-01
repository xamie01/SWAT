# Remediation Progress

Updated: 2026-08-01

## Completed

- A3: untracked committed build artifacts from git (`apps/discovery/dist/`, `.turbo/cache/`, all `*.turbo-build.log`).
- Verification: `git ls-files | grep -E '(^|/)(dist/|\.turbo/)'` returns no tracked paths.
- B1: re-keyed the circuit breaker to `(account, chain)`. `apps/trade-executor/src/index.ts` passes `'operator'`; migration `033_breaker_account_key.sql` seeds `breaker:operator:<chain>` keys and leaves the old rows for the next release (expand-and-contract, Standing Rule 4).
- B2: implemented `resolveRiskPolicy(account, chain)` in `packages/db/src/risk-policy.ts` (DB `config` -> env -> `DEFAULT_RISK_CONFIG`, 30s TTL). **Fixed a cross-chain cache aliasing defect**: the original single-slot cache returned polygon's env fallback to a robinhood-chain caller within the TTL. The cache is now a `Map` keyed by `account:chain`, with in-flight deduplication per key. Wired into the executor's `getAvailablePositionBalance` and `getBalanceAwarePositionSize`. Tests in `packages/db/src/risk-policy.test.ts` (7).
- B3: enforced stop-loss. `packages/db/src/stop-loss.ts` holds the pure threshold math and the exactly-once claim (`INSERT ... ON CONFLICT DO NOTHING RETURNING`). Migration `034_stop_loss_triggers.sql` creates `signal_stop_losses` keyed `(account, signal_id)`. The scorer's mark-to-market sweep now runs `runStopLossSweep` (`apps/scorer/src/stop-loss.ts`), which queues one full-position sell per breach on `swat-trades` and alerts `STOP_LOSS_TRIGGERED`. The executor's `handleJob` skips the pending claim for a `stopLoss` job, exempts it from `AUTO_EXECUTE`, and sells the ledger quantity (`sellTokenAmount`) rather than a bankroll-derived size. Tests: `packages/db/src/stop-loss.test.ts` (13), `apps/scorer/src/stop-loss.test.ts` (8), `apps/trade-executor/src/stop-loss-job.test.ts` (5).
- C1: built the canonical reconciliation coordinator, closing `F-CORE7`. `apps/trade-executor/src/reconciliation-coordinator.ts` claims ambiguous `copy_executions` rows, routes each to a per-chain handler (`reconciliation-venues.ts`), and always releases the claim. It runs inside the **existing** `reconcilePending` guarded loop — no second timer. Handlers are deliberately narrow: the coordinator only sees executions whose venue-side pending record is gone, so a handler settles a proven failure, reschedules a genuine in-flight, and reports `unresolved` for a success it cannot quantify (guessing a fill quantity would permanently corrupt the position ledger). Polygon is the exception via the new `reconcilePolymarketExecution`, since its pending state lives in `trades` next to `copy_execution_id`. Exhausted rows publish `RECONCILIATION_EXHAUSTED` rather than being auto-failed. **Two bugs caught during the work**: (1) `account` was initially wired as a filter on `copy_executions.target_account`, which stores a chain-prefixed wallet address — passing `'operator'` would have claimed zero rows forever, so it is now a logical escalation label and scoping is by chain; (2) migration `033_breaker_account_key.sql` inserted a `created_at` column `config` does not have, breaking migrations on any fresh database from `033` onward. Tests: `apps/trade-executor/src/reconciliation-coordinator.test.ts` (27), `tests/integration/reconciliation-coordinator.integration.test.ts` (3).

## Current Handoff

- Batch C is 1/2. Next: C2, the copy-eligibility policy at the claim boundary (closes `F-CORE3`), built on the existing `evaluateCopyPolicy` in `packages/shared/src/copy-trade-lifecycle.ts`.
- Repository state: green end to end in CI order — `db:migrate` 34/34 on a fresh database, `typecheck` 13/13, `test` 496 unit tests across 13 packages, `build` 11/11, `test:integration` 13/13.


## Completed (2026-08-01)

- B1: Re-keyed circuit breaker to `(account, chain)`:
	- Updated `apps/trade-executor/src/index.ts` to pass the `operator` account to circuit-breaker calls.
	- Updated `packages/db` tests to use the account parameter and adjusted expectations.
	- Added migration `packages/db/sql/033_breaker_account_key.sql` to seed `breaker:operator:<chain>` keys from legacy `breaker:<chain>` rows (idempotent).
