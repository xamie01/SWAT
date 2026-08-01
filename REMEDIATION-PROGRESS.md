# Remediation Progress

Updated: 2026-07-30

## Completed

- A3: untracked committed build artifacts from git.
- Verification: `git ls-files | grep -E '(^|/)(dist/|\.turbo/)'` returns no tracked paths.

## Current Handoff

- Next recommended batch item: B1, re-key the circuit breaker to `(account, chain)`.
- Repository state: tracked Turbo cache and discovery build outputs have been removed from the index, but remain on disk.

## Recent Changes (2026-07-31)

- B1: Re-keyed circuit breaker to `(account, chain)`:
	- Updated `apps/trade-executor/src/index.ts` to pass the `operator` account to circuit-breaker calls.
	- Updated `packages/db` tests to use the account parameter and adjusted expectations.
	- Added migration `packages/db/sql/033_breaker_account_key.sql` to seed `breaker:operator:<chain>` keys from legacy `breaker:<chain>` rows (idempotent).
