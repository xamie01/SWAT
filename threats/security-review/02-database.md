# 02 — Database defensive security review

Authorized static review, 2026-11-06, repository `/home/xahmie/Documents/SWAT`. Source unchanged. **All tests NOT RUN**; no network, service entrypoints, real environment, secret files, installed roles or live database inspected. Verified denotes source/caller-established behavior, not demonstrated exploitation. Likely denotes a conditional behavior needing a controlled test. No Critical or High database exploit is established.

## A. Boundaries, map evidence and coverage

The architecture is multi-tenant trading with LP services (`README.md:5-7,55-67`). `user_id`, not settlement address, is the tenancy discriminator; NULL denotes legacy operator ownership (`docs/adr/0001-tenancy-key.md:43-73; packages/db/sql/050_copy_tenancy.sql:24-26`). Root CLAUDE was reported missing; inherited FHEVM-only guidance is inapplicable. Citations are full repository-relative paths; exact absolute inventory follows.

**Observed database map:** `@swat/db` exports shared client, transaction, tenancy, session, execution/risk and financial-query surfaces (`packages/db/src/index.ts:1-49,107-110`). `packages/db/src/client.ts:10-27` requires `DATABASE_URL` at import, creates one write pool and aliases it as `pool`; `query()` always uses that pool (`:65-68`). Optional replica use is explicit through `readQuery()` (`:43-48,78-83`), not an automatic auth-read split. Nothing was imported or executed. Runtime validates bounded pool/timeouts and recognizes pooler configuration, but that changes startup timeouts rather than backend affinity (`packages/db/src/client-runtime.ts:38-112`).

Migration entrypoint `packages/db/src/migrate.ts:10-46` discovers filename-sorted SQL, takes session advisory lock 1, and commits each file separately. Both `migrate` and `migrate:lp` package scripts invoke that same entrypoint (`packages/db/package.json:13-14`). Profile compatibility arguments are ignored (`packages/db/src/migration-discovery.ts:12-31`), matching README's explicit unified pipeline without segregation (`README.md:29,96`). **Profile isolation is not provided, but is not assumed to be promised security isolation.**

Tenant helper `withTenantTransaction()` sets transaction-local tenant GUCs on the same checked-out client (`packages/db/src/tenancy.ts:72-110`). Generic `withTransaction()` does not set them (`packages/db/src/transaction.ts:36-69`). API cookie auth resolves sessions through ordinary DB queries (`apps/api/src/auth/plugin.ts:135-151; packages/db/src/users.ts:231-264`); administrator portfolio likewise uses ordinary query access, deliberately cross-tenant (`apps/api/src/routes/admin-portfolio.ts:50-123; packages/db/src/admin-portfolio.ts:119-123`). No non-test production adoption of scoped helpers or `SET ROLE` was found in targeted searches of apps and DB source.

Trading boundary: operator emergency-off HTTP handler → `emergencyOff()` → shared config writer (`apps/api/src/index.ts:798-799; apps/api/src/trading-control.ts:45-47; packages/db/src/execution-config.ts:222-239`). A separately running executor reads its own cached mode before processing trade jobs (`apps/trade-executor/src/index.ts:1462-1475`). Robinhood runtime binds `withEvmNonceLock()` to actual nonce allocation and submissions (`apps/trade-executor/src/index.ts:669-695; apps/trade-executor/src/robinhood.ts:700-712,799-900`). Queue name definitions, transport authentication and complete consumer execution are **NOT VERIFIED**. Lot exits instead use transaction advisory locks with tenant predicates (`packages/db/src/copy-trade-lifecycle.ts:1634-1729`); this is a distinct, appropriately transaction-pinned pattern.

**Coverage yes/no:** migration discovery/order/transaction boundaries **yes**; representative populated-schema compatibility **yes, static only**; whole 69-file populated replay **no**; profile behavior **yes, unified not isolated**; RLS policy/helper/production adoption **yes, bounded searches**; all tenant tables/callers **no**; session/execution/risk cache invalidation **yes**; all caches **no**; pooled advisory locks and actual nonce caller **yes**; deployed pooler affinity/roles/privileges **no**; billing atomicity **yes, shared with API-04**.

## B. Findings

| ID | Severity | Confidence | Evidence file:line | Abuse or failure, maximum three conceptual steps | Code fix |
|---|---|---|---|---|---|
| DB-01 | Medium | Likely | `packages/db/src/evm-nonce.ts:87-126`; `deploy/pgbouncer/pgbouncer.ini:23`; `apps/trade-executor/src/robinhood.ts:799-900`; `packages/db/src/migrate.ts:18-37` | 1. Use the documented transaction pooler with concurrent workers. 2. A session lock statement loses backend affinity before the RPC section. 3. Nonce operations or migrations can overlap, or unlock can address the wrong backend. | Route session-lock work through a direct/session-pinned dedicated connection; validate unlock results and fence connection loss. |
| DB-02 | Medium | Verified | `packages/db/sql/064_row_level_security.sql:29-45,89-114`; `packages/db/src/tenancy.ts:72-110`; `packages/db/src/client.ts:65-68`; `packages/db/src/user-execution-settings.ts:389-449` | 1. An unscoped caller uses a non-`swat_app` role with unset tenant flags. 2. Policy explicitly allows all rows. 3. An application predicate defect would not encounter the advertised RLS backstop. | Explicit least-role pools and tenant transactions; separately constrained auth/bootstrap and audited administrative access. |
| DB-03 | Medium | Likely | `packages/db/src/users.ts:125-136,180-188,231-285`; `apps/api/src/auth/routes.ts:190-203`; `apps/api/src/auth/plugin.ts:135-151` | 1. A session is warmed on another process or an in-flight resolver. 2. Logout/revocation commits but only the local cache is invalidated, possibly before the write. 3. Retained cookie use can remain accepted within the cache window. | Post-commit distributed revocation/version invalidation, in-flight generation barrier, and absolute-expiry checks on cache hits. |
| DB-04 | Medium | Verified | `packages/db/src/execution-config.ts:6,68-89,175-179,222-239`; `apps/api/src/trading-control.ts:45-47`; `apps/trade-executor/src/index.ts:1462-1475` | 1. Executor has cached a permitted live mode. 2. API writes emergency-off and clears only its own cache. 3. A new job can observe the executor's previous mode for the remaining TTL. | Durable control epoch checked near submission, acknowledged worker invalidation, and explicit pending-stop status. |
| DB-05 | Low | Verified | `packages/db/sql/064_row_level_security.sql:47-64`; `packages/db/sql/066_lp_dashboard.sql:71-101`; `packages/db/sql/065_polymarket_perps.sql:86-103` | 1. A deployment creates the source-defined LOGIN role without overriding credentials/privileges. 2. A DB credential holder accesses unrestricted global or later tenant tables. 3. Broad DML grants permit changes outside the intended tenant surface. | Provision credentials separately, reconcile role attributes, revoke broad/default DML, and add tenant policies before granting later tables. |
| DB-06 | Low | Likely | `packages/db/src/migrate.ts:21-32`; `packages/db/sql/066_lp_dashboard.sql:168-193`; `packages/db/sql/067_lp_auto_rebalance.sql:24-44` | 1. Rerun the complete migration pipeline while LP writes continue. 2. Migration 066 commits an older, narrower transition function. 3. A permitted active-to-rebalancing update between files can fail before 067 restores it. | Forward-only versioned migrations, or quiesced maintenance with final-schema convergence checks. |

### 1. DB-01 — session lock lifetime differs from pooled client lifetime

The checked-out node-postgres client is held, but no transaction pins a PgBouncer backend across the nonce critical section (`packages/db/src/evm-nonce.ts:87-106`). The repository pooler explicitly uses transaction mode (`deploy/pgbouncer/pgbouncer.ini:21-23`). Later `pg_advisory_unlock()` Boolean is ignored (`packages/db/src/evm-nonce.ts:113-126`); wrong-backend unlock can return false without throwing. A backend still holding the key can also reenter its own session lock. Migration lock 1 has the same affinity problem between per-file transactions (`packages/db/src/migrate.ts:18-37`). Installed pooler use and concrete concurrency outcomes are **NOT VERIFIED**, so this is Medium/Likely rather than a proven High fund-loss exploit.

Actual caller validation matters: the Robinhood wrapper invokes the lock before `runRobinhoodOrder()` (`apps/trade-executor/src/robinhood.ts:700-712`); pending nonce, approval, nonce increment and swap occur inside that operation (`:799-900`). Empty client error listener prevents an unhandled event but does not cancel/fence ongoing RPC on backend loss (`packages/db/src/evm-nonce.ts:94-106`). No duplicate fill or replacement transaction was demonstrated.

Fix steps: (1) use a dedicated direct/session-pooling connection for each session lock, and a direct migration connection; reject transaction-pool usage for these paths. (2) inspect unlock success, destroy unsuitable connections, and propagate backend-loss cancellation before further submissions. (3) reconcile uncertain pending chain transactions before retry and add durable ownership/fencing where the signing boundary can enforce it. Compatibility: do not simply wrap long receipt waits in a DB transaction; the pooler advertises a 60-second idle transaction timeout (`deploy/pgbouncer/pgbouncer.ini:38`). Preserve canonical account lock keys and the separate short transaction-lock lifecycle design. Validation was static reread plus targeted lock/caller searches. **Tests NOT RUN**; a controlled local backend-switching fixture should prove exclusivity and false-unlock handling, without real RPC/signing.

### 2. DB-02 — implemented RLS is not an adopted production boundary

For exact role `swat_app`, bypass flags cannot bypass the policy. Other roles default to policy bypass when tenant scope is absent (`packages/db/sql/064_row_level_security.sql:29-45`). FORCE RLS does not override an explicitly permitting policy. Production functions read here call ordinary `query()`/`withTransaction()`; scoped helper and role-switch searches found only helper definitions/internal calls outside tests (`packages/db/src/client.ts:65-68; packages/db/src/tenancy.ts:88-110; packages/db/src/user-execution-settings.ts:389-449`). This **does not prove an HTTP cross-tenant exploit or deployed owner role**. It establishes that code presence and scoped unit tests are insufficient evidence of production isolation.

Fix steps: (1) separate tenant, auth-bootstrap, background/admin and migrator credentials; deny unscoped tenant access by default. (2) propagate authenticated scope through every statement of tenant transactions, including inserts and joins. (3) replace implicit unrestricted-role defaults with explicit narrow privileges and review future tenant tables. Compatibility: switching the URL to `swat_app` alone will break unscoped login/session lookup; design bootstrap token-to-user resolution without broad arbitrary tenant access. NULL legacy operator rows and administrative portfolio must retain intentional separate access. `forUser()` is a nominal constructor, not an independent authentication check (`packages/db/src/tenancy.ts:40-45`). **Tests NOT RUN**; test actual auth/settings callers with the least role, missing scope, two tenants, rollback/reuse and legacy/admin operations. Existing RLS tests explicitly call scoped helpers (`packages/db/src/rls.test.ts:8-16,39-76`), not production adoption.

### 3. DB-03 — revocation invalidation is local and ordered too early

Cache hits bypass DB revocation and expiry checks for 60 seconds (`packages/db/src/users.ts:180-188,231-238`). Logout calls `revokeSession()` and clears browser cookies, but the DB helper deletes the local cache before awaiting the write (`apps/api/src/auth/routes.ts:190-203; packages/db/src/users.ts:267-285`). Another process retains its map; a resolver already reading pre-revocation state can repopulate after invalidation. Ordinary warmed-entry exposure is bounded by TTL, not indefinite persistence. `changePassword()` also never invalidates after its session-revoking transaction, but no production caller was found (`packages/db/src/users.ts:125-136`); this is not presented as an exposed password-recovery attack.

Fix steps: (1) publish/advance revocation state only after commit and invalidate all API instances. (2) version cache fills so earlier in-flight reads cannot restore revoked identity; recheck version when serving results. (3) store and enforce absolute expiry locally, and choose a documented bounded-staleness model if immediate revocation cannot be guaranteed. Compatibility: billing currently invalidates inside its transaction (`packages/db/src/billing.ts:219`), permitting reload of old committed tier before commit; move that after successful commit too. Auth trusts cached active status (`apps/api/src/auth/plugin.ts:137-151`). **Tests NOT RUN**; mocked concurrent logout/fill, two isolated process caches, password-helper revocation and near-expiry hits should be covered beyond sequential cache tests.

### 4. DB-04 — emergency stop acknowledges a local view, not fleet cessation

The global `'*': 'off'` write is atomic and config generations prevent older local loads repopulating the cache (`packages/db/src/execution-config.ts:77-83,222-239`). They do not invalidate a different process. An already warmed executor can continue using its old snapshot for the remaining 30-second TTL (`:6,68-72`), and the examined job gate uses that snapshot (`apps/trade-executor/src/index.ts:1462-1475`). This is a verified source-level propagation gap, conditional on a warmed permitted worker; no active live deployment or actual post-stop transaction is proved. The reviewed pre-job check does not establish all later submission checks or cancellation behavior.

Fix steps: (1) commit an ordered durable stop epoch; coordinate worker acknowledgement. (2) recheck authoritative stop state immediately before each new submission; treat control-plane uncertainty as no new submission. (3) return stop-requested versus workers-acknowledged, while separately reconciling transactions already sent. Preserve certified-chain/live-enabled gates (`packages/db/src/execution-config.ts:122-161`). Risk policy has a similar local 30-second cache and no production invalidator found; its DB lookup is deliberately global, not a demonstrated tenant leak (`packages/db/src/risk-policy.ts:5,75-109,113-151`). **Tests NOT RUN**; two isolated module caches with mocked certified live modes should reject the next submission after durable stop and document in-flight semantics.

### 5. DB-05 — source role defaults and future grants need least privilege

Migration creates a predictable-password LOGIN only when absent, without reconciling an existing role, then grants all-table and future-table DML (`packages/db/sql/064_row_level_security.sql:47-64`). This is source configuration, not a real secret read or proof of deployed login reachability. Later LP tenant tables lack RLS in examined 066–068 migrations, unlike explicit perps policies in 065 (`packages/db/sql/066_lp_dashboard.sql:71-101; packages/db/sql/065_polymarket_perps.sql:86-103`). Migration 069 was not deeply reviewed; final installed LP policy coverage is **NOT VERIFIED**. Broad permissions also undermine append-only audit claims if DB credentials can issue arbitrary DML (`packages/db/sql/064_row_level_security.sql:61-64; packages/db/src/audit-log.ts:3-14`).

Fix steps: (1) remove role-password provisioning from application migrations and use managed credentials/NLOGIN where appropriate. (2) reconcile NOSUPERUSER/NOBYPASSRLS and memberships, revoke blanket defaults, explicitly grant needed verbs. (3) require tenant policies or approved privileged-only designation for each new table; make audit mutation unavailable to normal credentials. Compatibility: grant migration/worker capabilities separately rather than globally revoking required operations. **Tests NOT RUN**; verify actual effective roles, table privileges, audit UPDATE/DELETE rejection and LP/perps tenant isolation in a disposable database.

### 6. DB-06 — individual replay guards are not whole-pipeline convergence

Runner has no applied-version/checksum ledger and commits historical definitions in sequence (`packages/db/src/migrate.ts:21-32`). Migration 066's trigger omits active-to-rebalancing while 067 adds it (`packages/db/sql/066_lp_dashboard.sql:179; packages/db/sql/067_lp_auto_rebalance.sql:35`). Rerun therefore temporarily reinstalls an older definition; concurrent LP caller failure is Likely, not proven, because the LP action path was outside this module. This is not claimed to be permanent schema rollback or populated migration failure.

Fix steps: (1) adopt forward-only version/checksum tracking through an audited baseline, or explicitly quiesce all writers during replay. (2) compare final constraint/index/trigger definitions after replay and interruption. (3) test a populated newer schema, including source-less lot exits inserted by the actual caller (`packages/db/src/copy-trade-lifecycle.ts:1715-1722`). Compatibility: preserve migration 050's tenant/NULL-aware uniqueness and financial-history retention (`packages/db/sql/050_copy_tenancy.sql:24-68`); do not misdiagnose a same-name `CREATE INDEX IF NOT EXISTS` as automatically reverting a later definition (`packages/db/sql/030_source_signal_execution_linkage.sql:60-62`). **Tests NOT RUN**; discovery/text tests are not full populated replay validation.

## C. Explicit invariants and local test descriptions

Beyond each finding: tenant identity must participate in position/lot keys and ownership predicates, including intentional NULL legacy ownership (`packages/db/src/copy-trade-lifecycle.ts:1657-1679,1695-1705`). Test two users sharing a paper settlement address and duplicate lot-exit identities; transaction advisory locks must remain on the transaction client. `inTransaction()` delegates to the hardened transaction helper (`packages/db/src/copy-trade-lifecycle.ts:412-413; packages/db/src/transaction.ts:43-69`), which preserves original rollback errors and destroys failed connections. Test COMMIT/ROLLBACK failure, tenant GUC cleanup, and no partial financial state.

Strict financial audit must commit with the mutation it describes: current strict audit uses global query, while billing calls it from another checked-out transaction (`packages/db/src/audit-log.ts:30-45,75-76; packages/db/src/billing.ts:230; packages/db/src/transaction.ts:55-56`). This shared defect and sweep/renewal overwrite are recorded in **API-04**, not counted again. Mock failed payment commit and conditional renewal/sweep concurrency. Replica queries must never resolve security-sensitive identity or a read-after-write dependency (`packages/db/src/client.ts:70-83`). Profile tests should assert documented unification, not imaginary isolation. All tests are proposed only, **NOT RUN**; existing DB-backed RLS/migration fixtures were read, never invoked.

## D. Not reviewed and reasons

No installed DB/PgBouncer version, roles, credential exposure, network reachability, backups, TLS, replication permissions or live schema: prohibited network/env/secrets. No dependency/build/lockfile analysis. Migration 001–069 bodies were not exhaustively read; full populated replay and latest 069 LP behavior remain unverified. No complete LP/perps/API tenant-query/executor/signer audit, all queue producers/consumers, or every cache: bounded assigned module scope. CI's role-creation fixture is not evidence of production privileges (`packages/db/src/ci-setup.ts`, read as setup source). On-chain effects, delegated authority, shutdown fencing and external RPC behavior remain separate unverified boundaries.

## Appendix — exact depth/skim/excluded manifest

Deep means the listed **regions**, not all of each long file. Reused API evidence is explicitly included. Unlisted source is not reviewed; broad search matches alone are not depth evidence. JSON remains inside the assigned report; no separate evidence/ledger file was written.

```json
{
  "reportIds": ["DB-01", "DB-02", "DB-03", "DB-04", "DB-05", "DB-06"],
  "tested": false,
  "deep": [
    "/home/xahmie/Documents/SWAT/README.md",
    "/home/xahmie/Documents/SWAT/docs/adr/0001-tenancy-key.md",
    "/home/xahmie/Documents/SWAT/packages/db/package.json",
    "/home/xahmie/Documents/SWAT/packages/db/src/migrate.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/migration-discovery.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/migrations.test.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/ci-setup.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/client.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/client-runtime.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/transaction.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/tenancy.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/rls.test.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/users.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/users-session-cache.test.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/execution-config.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/risk-policy.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/evm-nonce.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/close-all.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/stop-loss.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/index.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/audit-log.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/billing.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/user-execution-settings.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/admin-portfolio.ts",
    "/home/xahmie/Documents/SWAT/apps/api/src/trading-control.ts",
    "/home/xahmie/Documents/SWAT/apps/api/src/index.ts",
    "/home/xahmie/Documents/SWAT/apps/api/src/auth/plugin.ts",
    "/home/xahmie/Documents/SWAT/apps/api/src/auth/routes.ts",
    "/home/xahmie/Documents/SWAT/apps/api/src/routes/admin-portfolio.ts",
    "/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts",
    "/home/xahmie/Documents/SWAT/apps/trade-executor/src/robinhood.ts",
    "/home/xahmie/Documents/SWAT/deploy/pgbouncer/pgbouncer.ini",
    "/home/xahmie/Documents/SWAT/packages/db/sql/028_copy_execution_lifecycle.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/029_attribution_semantics.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/030_source_signal_execution_linkage.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/047_user_execution_grants.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/049_user_execution_settings.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/050_copy_tenancy.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/051_subscription_states.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/054_copy_evidence_quote_units.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/056_master_membership.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/061_copy_position_lot_exits.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/063_crypto_billing.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/064_row_level_security.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/065_polymarket_perps.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/066_lp_dashboard.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/067_lp_auto_rebalance.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/068_lp_multichain.sql"
  ],
  "skim": [
    "/home/xahmie/Documents/SWAT/apps/scorer/src/index.ts",
    "/home/xahmie/Documents/SWAT/apps/web/components/SaaSNav.tsx",
    "/home/xahmie/Documents/SWAT/apps/web/components/AdminNav.tsx"
  ],
  "excluded": [
    {"path":"/home/xahmie/Documents/SWAT/**/.env*","reason":"Explicit environment/secret exclusion; no example env opened"},
    {"path":"/home/xahmie/Documents/SWAT/deploy/pgbouncer/userlist.txt","reason":"Potential credentials; filename discovery only"},
    {"path":"/home/xahmie/Documents/SWAT/**/node_modules/**","reason":"Explicit dependency exclusion"},
    {"path":"/home/xahmie/Documents/SWAT/**/{build,dist}/**","reason":"Explicit artifact exclusion"},
    {"path":"/home/xahmie/Documents/SWAT/**/*lock*","reason":"Explicit lockfile exclusion"},
    {"path":"/home/xahmie/Documents/SWAT/packages/db/sql/069_lp_copy_trading.sql","reason":"Filename enumeration only; latest LP behavior not depth-reviewed"},
    {"path":"/home/xahmie/Documents/SWAT/apps/lp/**","reason":"LP migration boundaries reviewed; full service/callers outside scope"},
    {"path":"/home/xahmie/Documents/SWAT/programs/**","reason":"On-chain enforcement outside database module"},
    {"path":"/home/xahmie/Documents/.claude/CLAUDE.md","reason":"Requester identifies inherited FHEVM-only instructions as inapplicable"}
  ]
}
```

Partial deep regions: copy lifecycle 409–417, 1440–1629 and 1634–1744; trade-executor index 635–749 and 1440–1509; Robinhood 1–175 and 690–978; stop-loss 1–75; SQL 028 255–384, 051 1–220, 054 1–210, 056 180–279, 066 1–240. API index includes previously reviewed 1–240/898–976 plus 775–815; auth plugin/routes and DB users/billing/audit were reused from full API reads. README/ADR and migration 047/063 likewise reuse API evidence. DB client-runtime, RLS tests, migrations tests and remaining named deep SQL/helpers were read in full across this review. Other SQL directory entries were filename-enumerated or targeted search-only; no claim relies on unread migration bodies. Workflow skill `/home/xahmie/Documents/SWAT/.agents/skills/research/SKILL.md` was loaded earlier, not treated as security evidence.
