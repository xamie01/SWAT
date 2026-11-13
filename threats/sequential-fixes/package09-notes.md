# Package09 — database role, session-lock and migration boundaries

Status: **source-fixed-runtime-blocked**. Branch: `fix/sequential-threat-remediation`. Only package09 was implemented. Packages01–08 remain source-qualified; package10 and later were not started.

**No database, Redis, network, credential store, migration, service, install, commit or push was used/applied.** All shell workloads were CPU0-bound. Tests ran sequentially through `/home/xahmie/Documents/SWAT/threats/sequential-fixes/run-check.py` and its guarded Vitest configuration, with one worker, synthetic environment, network/credential-read guards and source aliases.

## Source corrections

- **PF-DATA-10:** `/home/xahmie/Documents/SWAT/packages/db/src/client.ts` exposes checked runtime pool facades, not the underlying raw pools. Role verification happens after BEGIN on the backend pinned for the transaction, including replica reads. It requires both current/session identities to be `swat_app`, rejects superuser/BYPASSRLS/role creation/database creation/replication/inheritance/membership, object ownership and schema/database CREATE authority, and requires row security on. The tenant setting is reset transaction-locally before work. Failed validation poisons the checkout; catching that error cannot allow further SQL. `/home/xahmie/Documents/SWAT/packages/db/src/tenancy.ts` rechecks authority, rejects wildcard user identities and refuses implicit cross-tenant privileged scope.
- **PF-DATA-09:** `/home/xahmie/Documents/SWAT/packages/db/src/direct-session.ts` owns a new `pg.Client` connected exclusively through mandatory `DIRECT_DATABASE_URL`. No runtime-pool fallback exists. Known pooler endpoints and unconfirmed topology are refused. The session remains owned until the callback settles; acquire/unlock/backend PID are checked, false/error unlocks reject, and the physical client is always ended, never returned to a transaction pool. `/home/xahmie/Documents/SWAT/packages/db/src/evm-nonce.ts` uses this boundary without opening a database transaction over RPC work. Busy means no callback. Session failure/uncertain cleanup is not financial success; callers must reconcile uncertain submissions instead of blindly resubmitting. This is not a distributed fencing guarantee after a backend dies.
- **Neighboring transaction semantics:** `/home/xahmie/Documents/SWAT/packages/db/src/transaction.ts` requires a real COMMIT acknowledgement, rejects asynchronous client failure before commit and discards failed sessions. Existing synthetic payment/settings/grant/wallet fixtures now return PostgreSQL's actual COMMIT command tag; their business assertions were not relaxed.
- **PF-DATA-13:** `/home/xahmie/Documents/SWAT/packages/db/src/migration-discovery.ts` validates filenames/unique versions and retains the SQL bytes' SHA-256 alongside the SQL to execute. `/home/xahmie/Documents/SWAT/packages/db/src/migrate.ts` is import-safe and uses the same dedicated-session owner, requiring `swat_migrator` rather than bootstrap/runtime credentials. Advisory key **1** is retained to exclude the legacy runner. A busy runner refuses before reading/mutating history. The protected `public.swat_schema_migrations` journal must be an exact checksummed source prefix; drift, gaps and unknown files refuse replay. SQL plus journal entries for the entire pending suffix share one transaction/commit, so no committed 066-only lifecycle window is published. Recorded 066/067 are never replayed.
- **PF-DATA-12:** `/home/xahmie/Documents/SWAT/deploy/postgres/roles.sql` is a **manual, unapplied DBA provisioning script**, separate from application migrations. Both new/existing runtime and migration roles are reconciled to NOLOGIN, PASSWORD NULL, NOSUPERUSER, NOBYPASSRLS, NOINHERIT, NOCREATEDB, NOCREATEROLE and NOREPLICATION; memberships in both directions and historical blanket runtime defaults are revoked. Credentials must be independently provisioned out of band. `/home/xahmie/Documents/SWAT/packages/db/src/ci-setup.ts` now refuses the legacy automatic known-password bootstrap instead of recreating it.
- `/home/xahmie/Documents/SWAT/packages/db/sql/070_runtime_role_boundary.sql` is a **new, unapplied forward migration**. It requires the disabled/reconciled runtime identity, rejects unexpected policies/ownership, allows RLS bypass only to the exact migration current/session identity, replaces the reviewed tenant policies, and grants DML only on their explicit 17-table set after FORCE RLS. Broad table/sequence/function and PUBLIC grants/defaults are revoked, including global defaults (schema-scoped REVOKE alone does not undo global privileges). Other resources/capabilities stay denied pending review.
- `/home/xahmie/Documents/SWAT/deploy/pgbouncer/pgbouncer.ini` stays in transaction mode, removes the bootstrap auth fallback and app/bootstrap pooler administration, and documents separate direct runtime/migration endpoints. No userlist or credentials were read or written.

## Historical compatibility and explicit baseline adoption

SQL064 was changed **only** to remove fresh-install known-password role creation and the legacy bootstrap membership grant, replacing provisioning with an explicit prerequisite. Its historical table/policy body was not rewritten. SQL066/067 were not modified. Existing installations must not replay the edited SQL064.

Source SHA-256 values (not evidence of what any live DB installed):

- HEAD SQL064: `4445fe1040d683dd13d22ffa6cdde8e48da16ddbb308aa9c023375da8a74575d`
- Reviewed SQL064: `a32d87fac14bb77eadb7fe690b694896a198a7b0308965e6ad8dc4717c8cfeb3`
- Unchanged SQL066: `9d69591ea3a51e5bc91381f52a6df40960a2053e7ab0d7624620d12083cc7adf`
- Unchanged SQL067: `6da8d4e08247b1a43e13ff4a07eaff06ff90e192b06488e3c87f1d8280473340`
- New SQL070: `da161d1490e6e821c026518ec0885495aea6c25a9bfb329d6bcf7919bd4940c6`

An existing DB with no journal, or an empty journal plus existing user objects, is refused. No highest-filename/schema-existence inference is accepted as applied history. A genuinely empty DB requires explicit `--initialize-empty --quiesced`.

Baseline adoption requires an independently audited JSON manifest containing `database`, a nonempty `auditReference`, and an ordered exact source-prefix `migrations` array. Each entry has `file`, `checksum` (reviewed source SHA-256) and `installedChecksum` (independently established installed-artifact SHA-256). This permits an explicitly audited old064/new064 correspondence without pretending the edited file ran. The audit must establish installed schema/function convergence and provenance; the program does not manufacture or verify those facts. Wrong DB name, hashes or prefix are refused. Existing nonempty journal history cannot be overwritten through baseline adoption.

The CLI's `--adopt-baseline <approved-manifest> --quiesced` operation **only journals the audited prefix**, recording both hashes, audit reference, session identity and time. It exits without applying pending SQL. Applying the pending suffix is a separate, explicitly quiesced invocation. No manifest was created and neither operation was invoked here.

## Remaining operational and availability gate

**Do not switch production credentials or deploy this as a working login/trading service merely because source tests pass.** Unscoped login/session queries, many existing per-user calls using plain `query`, cross-tenant/admin jobs, audit writes and unreviewed global resources will fail closed or see no tenant rows under the strict role. Separate constrained auth/admin/global capabilities, caller scoping and reviewed minimum grants must be completed/accepted before enabling those flows. This is deliberate containment, not a claim of functional runtime readiness.

Before any future database operation, an authorized operator must independently:

1. Audit the target DB/installed artifacts, back up and quiesce all writers and old migration runners; drain existing DB sessions. NOLOGIN/password changes do not invalidate already-open sessions. Old bootstrap credentials must not remain in runtime services.
2. Review and explicitly run the separate DBA provisioning script in its own authorized window; explicitly transfer only reviewed application schema/table/function/journal ownership to `swat_migrator`, never blindly REASSIGN OWNED. Resolve extension ownership/privilege prerequisites separately. `pg_stat_statements` remains the historical optional extension, not silently certified here.
3. Provision a separate migration credential out of band. Supply it only to the migration process's `DIRECT_DATABASE_URL`, never the service runtime. Keep `swat_app` NOLOGIN through SQL070. The migration role is not a superuser or role administrator.
4. Establish and audit the baseline if required; only then authorize the pending forward migration. Check installed policy/function/ACL/default-ACL convergence and LP lifecycle invariants. Re-enable runtime only with a fresh independently provisioned credential and after the availability/capability work above.
5. Verify actual primary/replica role attributes, HBA/PgBouncer identity mapping, cross-tenant read/write denial and login behavior against isolated disposable infrastructure. Verify two direct backend sessions' lock exclusion, checked cleanup, interrupted migration rollback and a no-replay second migration run. No such infrastructure acceptance occurred here.
6. Set `DIRECT_DATABASE_SESSION_CONFIRMED=true` only after confirming the endpoint bypasses transaction pooling. A URL/port/hostname check and PID comparison cannot prove arbitrary proxy topology. Runtime nonce work uses a separate direct session as `swat_app`; migration uses its own process-local direct URL as `swat_migrator`.

## Exact verification evidence

All files below are under `/home/xahmie/Documents/SWAT/threats/sequential-fixes/`.

| Evidence | Result |
|---|---|
| `package09-role-red.json` → `package09-role-green.json` | 15 failing behavioral regressions → 15 passing |
| `package09-lock-red-valid.json` → `package09-lock-green.json` | 12 failing lock regressions → 27 passing combined role/lock tests |
| `package09-migration-red.json` → `package09-migration-green.json` | 19 failing behavioral regressions → 19 passing |
| `package09-policy-red.json` → `package09-policy-green.json` | 4 missing source/deployment contracts → 4 passing; not SQL execution |
| `package09-transaction-red.json` → `package09-transaction-green.json` | 2 failing acknowledgement/error regressions plus 7 existing passes → 24 combined transaction/role passes |
| `package09-legacy-provisioning-red.json` | 1 failing known-password bootstrap contract; corrected and green in final run |
| `package09-review-red.json` | 2 additional failures: use after rejected role check; global default grants. Both corrected and green in final run |
| `package09-neighbors.json` | 44 safe neighboring tests passed |
| **`package09-final.json`** | **185 passed, 0 failed, 23 files**: 56 package09 sequential tests, 44 neighbors (including 2 new transaction regressions), 85 retained package01–08 tests |
| **`package09-focused-final-typecheck-640.log`** | **Exit 0**: source-alias noEmit check of 10 package09 modules and their source dependencies |

Final focused tests include reused-session A/B/no-scope separation, poisoned checkout denial, direct lock contention/failure/PID cleanup, two actual migration-runner invocations contending on a synthetic session owner, actual checked-in migration discovery and skipped 066/067 source SQL, prefix/checksum/baseline refusal and atomic SQL/journal rollback. These establish application/query orchestration, not a live PostgreSQL RLS or PgBouncer result.

Retained nonfinal limitations/failures are explicit: `package09-lock-red.json` was a fixture-hoisting collection error (0 tests), not valid red evidence; `package09-complete.json` had 179 passes/2 missing mock COMMIT-tag failures, fixed without weakening production; `package09-review-green.json` had 40 passes/4 fixture query-matcher collisions after the stricter catalog probe, fixed by matching the correct query. `package09-confirm.json` passed 183 tests before the final two review regressions were added. The ordinary package typecheck (`package09-typecheck-640.log`, exit 2) resolved stale shared declarations; the wider source-alias backend check (`package09-source-typecheck-640.log`, exit -6) exhausted the 640 MB heap. Neither is claimed as a full typecheck pass. Package09-scoped diff whitespace check passed; an unrelated pre-existing billing-page whitespace finding was left untouched. Command/env/affinity/exit records are in `commands.jsonl`.

Review was performed inline, with no nested agent. Final disposition remains source-qualified and operationally blocked. Stop after package09.
