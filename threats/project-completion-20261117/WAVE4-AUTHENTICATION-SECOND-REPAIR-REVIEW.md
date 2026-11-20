# Protected authentication second repair re-review — 2026-11-19

## Verdict: REJECT

Independent reviewer: `agent_e7557d7d-ea77-4685-8673-8f5c8362f38a`. Read-only bounded P3 source review of second-repair manifest `d151ca0b2a2ef93a5a78d08549ae2eb0f09fb2f2a3ff47aa895c3641a33b8ac8`. No files changed; no tests, compilers, SQL, infrastructure, signing or nested agents run. Reported verification was not independently reproduced.

## Disposition

B (shared target binding) and C (runtime lease custody) are resolved in bounded source scope. A substantially repairs the disabled proof-cascade path but remains incomplete for incoming FKs whose child is outside the auth relation inventory. Original findings1/3/4/5/6 remain resolved; original relation closure finding2 remains open through A. Source acceptance is withheld.

## Remaining supported finding — Medium

At the reviewed freeze, `deploy/postgres/auth-provisioning.ts:190–193` exempts internal triggers associated with any FK and matching either side of that constraint. `deploy/postgres/auth-catalog-dependencies.ts:184–205,208–237` validates only constraints whose child relation is one of the five auth relations.

A noninventory table containing `wallet_id REFERENCES public.user_auth_wallets(id) ON DELETE RESTRICT`, without PUBLIC/auth-owner/auth-service grants, creates admitted parent-side internal triggers. The external child constraint and trigger inventory receive no detailed validation. A referencing row then blocks protected unlink at `packages/db/sql/087_wave4_protected_authentication.sql:226–234`, even though all three catalog phases accept the added dependency. Those admitted incoming triggers likewise receive no builtin/event/options closure checks.

Required repair: independently pin legitimate incoming FK constraints and trigger paths touching protected relations from the canonical migration baseline; reject additional constraints/triggers and validate their applicable builtin/event/options/dependency/enabled closure while preserving legitimate existing incoming FKs. The existing extra-trigger contract duplicates a row in an already reviewed FK, rather than exercising this outside-inventory path.

## Resolved B/C evidence

- Shared schema helpers bind database/address/port to inspected infrastructure and connected target/system identifier before corresponding DBA acquisition, repeat reference binding after checked migration COMMIT, require distinct cluster identifiers, and keep candidate validation-only. Source: `tests/integration/helpers/schema-guard.ts:89–92,149–199,219–245`; contracts: `tests/unit/build-schema.test.ts:107–170`.
- Runtime qualification checks clean direct identity/backend before target/BEGIN, rechecks before settlement, discards borrowed/drifted or ACL-aborted unobservable transactions, and never rolls back after uncertain COMMIT attempt. Source: `tests/qualification/wave4/authentication.ts:32–73,87–94`; contracts: `authentication.offline.test.ts:149–233`.

PG16 trigger predicates were reviewed directly; no speculative compatibility defect was asserted. Actual PostgreSQL catalog/deparser/RLS/ACL/locking/COMMIT behavior remains unqualified. Forced RLS, explicit auth injection, no app fallback, seven broker transfers and existing refusals remain preserved. P4–P8 remain incomplete.
