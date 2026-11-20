# Wave 4 authentication repair checkpoint — 2026-11-19

**The P3 authentication repairs pass 748 main offline tests across 36 literal files, 46 separate load-harness contracts, and five noEmit compiler checks. The original independent source verdict remains REJECT; all six findings await independent re-review. Wave 4 is not source-complete, and Wave 5 remains blocked.**

This is a coordinator repair and evidence checkpoint, not independent acceptance or PostgreSQL evidence. No implementation owner is active, and P4 has not started. The original [authentication review](WAVE4-AUTHENTICATION-REVIEW.md) is preserved unchanged.

## Implemented repair scope

1. **Policy-helper dependency closure.** The auth catalog gate validates the exact `is_rls_bypassed()` and `current_app_user_id()` identities, owners, bodies, options and ACLs alongside the 17 fixed auth routine signatures. Hostile helper substitutions are covered by offline contracts. The existing 079/082 migration broker still has exactly seven ownership transfers.
2. **Auth relation and executable dependency inventory.** The gate pins the reviewed users, sessions, wallets, wallet proofs and audit relations, including columns, types, nullability, defaults, constraints, indexes, opclasses, audit sequence and narrow citext support. Unexpected rules, inheritance, storage hazards and executable dependencies are refused. The fixture uses synthetic catalog OIDs; actual PostgreSQL 16 catalog/deparser behavior is unqualified.
3. **Global PUBLIC column ACLs.** The noncatalog relation scan includes column ACLs as well as table ACLs. A hostile column-only PUBLIC grant is rejected before handoff and committed validation.
4. **Late capability poison and uncertain COMMIT.** The checked auth transaction rechecks settlement and poison after cleanup reset, after final backend/identity observation and immediately before COMMIT. Deferred escaped and nested callbacks are covered. A detected pre-COMMIT violation withholds admission; a COMMIT attempt with uncertain outcome discards the lease without claiming rollback.
5. **Existing LP authentication consumer.** LP now requires explicitly injected authoritative session resolution through a checked direct-auth lease. Its entrypoint loads local external auth composition before runtime service construction. There is no app-role or legacy unscoped resolver fallback. Three actual LP consumer contracts are included in the hash-approved main literal inventory.
6. **Integrated wallet and overlap qualification.** The inject-only HTTP composition uses the actual auth routes, nonce consumption, signature verifier and owned store. It exercises ephemeral synthetic signatures, replay, origin/session-intent/signature hostility and cookie withholding on uncertain COMMIT. Independently acquired backend/client schedules exercise protocol overlap rather than serializing all leases. The synthetic lock fixture is not PostgreSQL locking proof; real execution requires observed blocking edges and separate authorization.

Committed-auth installation source now stages inert 087 migration and committed broker retirement before a separate external DBA handoff, fresh disabled validation, separately authorized bounded external activation and active validation. Reference/candidate/Wave 4 composition requires explicit inspected targets and owned capabilities. No implicit LOGIN/password SQL or new broker transfer is introduced. The public qualification entrypoint and unqualified positive pipeline remain refused.

## Supported verification repairs

The first expanded repair run had 743 passed and five failed assertions out of 748. Repairs kept the production boundaries intact:

- Two orchestrator assertions now distinguish pre-COMMIT action failure, which may roll back, from postattempt uncertainty, which must not claim rollback.
- The provisioning assertion only detects activation clauses in `ALTER ROLE` statements, rather than matching inspection text containing password routine names.
- The auth observer fixture distinguishes `AS role,` from `AS role_setting` and returns the expected observation row shape.
- The migration/catalog fixture constructs a genuine local installation plan instead of bypassing the bootstrap WeakMap provenance check with a fabricated plan.

Qualification typing now uses the DB leaf's exported `AuthQueryRow` rather than a root-level `pg` dependency and copies the readonly blocked list at the mutable result boundary. The new LP test matches the existing localized cookie-plugin registration cast for the installed duplicate Fastify types. The previously unverified custody query facade now passes the API-test compiler. No package installation, policy widening or production provenance bypass was used.

## Final frozen verification

| Immutable check label | Result |
| --- | --- |
| `build-w4-auth-repair-main-offline-04` | 748 passed; 36 unique literal files; zero failed, skipped or todo |
| `build-w4-auth-repair-load-offline-02` | 46 passed; one literal file; actual MJS source-loader child exercised |
| `build-w4-auth-repair-db-typecheck-03` | DB noEmit, incremental false; exit 0 |
| `build-w4-auth-repair-qualification-typecheck-03` | Qualification noEmit, incremental false; exit 0 |
| `build-w4-auth-repair-api-typecheck-02` | API noEmit after fresh DB emit; exit 0 |
| `build-w4-auth-repair-api-tests-typecheck-02` | API tests noEmit; exit 0 |
| `build-w4-auth-repair-lp-typecheck-02` | LP noEmit, incremental false; exit 0 |

All seven checks share the consumed-input manifest SHA-256:

`3e0126e15f7c8c87db5001c404e7b5163351e0961f1035d037a2c30f42fa50dd`

They report unchanged workspace inputs. Reconciliation compares the complete current runner input inventory with that manifest, verifies command/log/result/input-manifest byte hashes, and checks actual result file identities against each literal config. Report-only checkpoint, ledger and evidence edits are outside the runner input manifest; executable configs and their approval inventory remain included.

The main config hash is `e884d87fe41cbce907af4d2bfa7e1135e9983f473826ec81c7e6043a3a18e611`. The preserved load config hash is `2adbfa9d60d2206fc26f71fc17d19edd0fd731f30061ca7f21f46d55e5b9ebec`.

Fresh DB emit `build-w4-auth-repair-db-emit-01` passed on its separately recorded pre-emit manifest `f15e4e322a69720ee80a32199a2ab69990a5e57e875788d2582466dfaa35234b`. Its generated artifact hashes were reconciled independently. Neither generated-output epochs nor main/load assertion scopes are summed into runtime coverage.

Checks ran sequentially through `build-completion-runner.py` under CPU 0 and the shared flock. Tests used one fork and a 512 MB Node heap; compilers used 640 MB. The synthetic environment and offline network/credential guard were enabled. `timeoutSeconds: null` removes runner wall-clock caps, not application SQL, operation, cancellation, shutdown or load-drain deadlines. Heap caps are not RSS/cgroup limits.

## Retained evidence and review boundary

Raw failed and passing artifacts remain unchanged under their original labels. New failed repair labels are:

- `build-w4-auth-repair-main-offline-01`: five failing assertions, corrected as described above.
- `build-w4-auth-repair-qualification-typecheck-01`: root `pg` resolution and readonly list type errors.
- `build-w4-auth-repair-lp-typecheck-01`: cookie-plugin/Fastify type incompatibility in the new test.

Earlier 709/35 authentication, 602/24 P2 and prior checkpoints remain historical evidence, not current coverage and not additive totals. [WAVE4-MAIN-EVIDENCE.json](WAVE4-MAIN-EVIDENCE.json) retains these epochs and all failures; [STAGE-LEDGER.json](STAGE-LEDGER.json) records the current scope.

The attempted read-only Explore continuation lookup failed with a provider pre-consume quota error before performing work. It was not an independent re-review. No new independent verdict exists. All three high and three medium findings in the original REJECT remain open for independent re-review despite implemented repairs and green contracts.

## Remaining acceptance and implementation

P1 and P2 retain their earlier bounded source acceptance. P3 requires independent repair re-review before the next sequential package. P4 protected positive intake/fanout/worker/receipt/valuation composition, P5 shared financial backing, P6 canonical races/faults, P7 durable load/economic reconciliation, P8 private executable coordinator/long-load/cleanup and P9 final independent audit remain outstanding. These are not merely missing credentials.

No runtime services, Docker inspection, SQL application, seeding, live load traffic, real credentials, live signing capability, funds, commit, push or publication were used. Existing offline tests exercised ephemeral in-memory synthetic signatures and source-loader children only. Actual PostgreSQL/RLS/ACL/locking/COMMIT, Redis/BullMQ/PgBouncer, seed/load and cleanup observations require separately authorized disposable infrastructure.

`sourceComplete=false`, `authenticationSourceAccepted=false`, `runtimeAccepted=false`, `liveCapabilityAccepted=false`, `productionReady=false`. SQL 083 and 084 refusal, sealed Waves 1–3, unrelated work and Package 28/public positive-pipeline refusal are preserved.
