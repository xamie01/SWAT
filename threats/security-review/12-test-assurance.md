# 12 — Cross-cutting test assurance and local safety

Date: 2026-11-06. Source-only review. **Tests NOT RUN.** This module was added because integration harnesses can cross infrastructure trust boundaries even when execution mode is paper. No service or test suite was started.

## A. Trust boundaries and existing controls

- Root test execution is Turbo-driven and depends on builds (`package.json:8`; `turbo.json:25-29`), so it can write generated source-package output outside `threats/`. That is incompatible with this review's report-only restriction unless a separate isolated worktree/output arrangement is prepared.
- Integration configuration imports `dotenv/config`, accepts either `INTEGRATION_DATABASE_URL` or `DATABASE_URL`, validates only a test-looking DB name and sets paper mode (`vitest.integration.config.ts:1-22`). Serial file execution/maxConcurrency 1 lowers within-process fixture races (`vitest.integration.config.ts:27-32`), but does not isolate a shared server or another test process.
- Global setup runs a schema guard and closes its pool (`tests/integration/global-setup.ts:7-15`). The guard checks explicit tables/columns (`tests/integration/helpers/schema-guard.ts:25-70,80-109`), not a complete migration ledger or profile/version identity.
- The chaos suite directly exercises canonical DB lifecycle helpers and checks no duplicate execution/fabricated fill (`tests/integration/chaos.integration.test.ts:4-12,114-119,147-178,181-250`). This is meaningful ledger coverage, not a venue-signing or contract authorization test.
- Cross-tenant tests deliberately build stand-in user/admin routes around the real auth plugin, not the complete production route set (`tests/integration/cross-tenant.integration.test.ts:39-76`). They check wallet separation, missing/service-key credentials, role denial, CSRF, logout isolation and wallet relinking (`:114-250`). They do not prove all production billing/grant/execution handlers preserve tenant identity.
- Lot-exit tests call real lifecycle helpers, exercise concurrent claims and replay/partial fills, but use paper evidence and `userId:null` for the primary claim (`tests/integration/lot-exits.integration.test.ts:19-59,85-117`). The negative tenant test is useful; production user signer behavior remains outside that test.

## B. Findings table

| ID | Severity | Confidence | file:line | Abuse scenario (≤3 conceptual steps) | Code-level fix |
|---|---|---|---|---|---|
| TEST-01 | Medium | Verified | `vitest.integration.config.ts:1-17`; `tests/integration/chaos.integration.test.ts:53-61,343-345,418` | 1. A test-looking URL selects shared/non-local infrastructure. 2. Chaos runs backend/client termination against that server. 3. Other workloads lose connections despite paper trade mode. | Require explicit isolated-test configuration, loopback-only endpoints for security review, disposable DB/Redis instances and narrowly scoped kill operations. |
| TEST-02 | Medium | Verified | `tests/integration/helpers/lifecycle-fixture.ts:4-6,20-28,95-115,152-155,195-224` | 1. Two independent Solana fixture runs reuse constant wallet/token addresses. 2. Address-scoped cleanup removes shared positions/lots. 3. The neighboring run fails or loses its fixture evidence. | Generate unique valid local addresses per fixture; include tenant/run ownership in cleanup; isolate databases per run. |
| TEST-03 | Low | Verified | `tests/integration/helpers/schema-guard.ts:25-70,73-76,80-109` | 1. A database contains the few named tables/columns but has a divergent profile or stale constraints. 2. The guard passes. 3. Later tests provide misleading assurance or fail far from the missing schema property. | Assert profile/version/digest and key constraints/policies, not only a sparse object list; rebuild a disposable profile DB for acceptance. |

### TEST-01 — shared infrastructure must not be selected implicitly

**Revalidation:** reread the complete integration configuration, backend terminator and both Redis kill call sites. The database terminator filters only by current database and excludes its own backend (`tests/integration/chaos.integration.test.ts:53-61`). Redis kills all normal clients, not only a unique test queue (`:343-345,415-418`). Queue deletion is uniquely named and scoped (`:314-334,362-365`); that mitigates key deletion but not connection termination. Real endpoint configuration/reachability is **NOT VERIFIED**.

Step-by-step fixes:
1. In `vitest.integration.config.ts`, stop fallback to generic `DATABASE_URL` for destructive integration tests. Require a dedicated security-test mode and validated disposable endpoint identity. For this localhost-only review, reject non-loopback database/Redis URLs; production CI can use a separately reviewed service-container policy.
2. Refactor chaos setup to allocate a fresh disposable DB/Redis instance or require an explicit marker verified via a read-only identity probe before destructive actions. Paper mode only governs trading; it does not authorize database/backend termination.
3. Replace broad Redis `CLIENT KILL TYPE normal` with named client-ID tracking for connections created by this test. Keep queue-specific obliteration and avoid shared-server-wide commands.
4. Scope Postgres termination to test-created backend PIDs/application names or the dedicated disposable database with an explicit guard; do not terminate other clients merely because they share the database name.
5. Run these scenarios as a separate opt-in suite. Read neighboring lifecycle fixtures and setup callers to preserve retry/no-fill assertions (`tests/integration/chaos.integration.test.ts:114-178,181-250`; `tests/integration/global-setup.ts:7-15`).

Tests to catch violation: configuration tests rejecting remote/ambiguous DB and Redis URLs before import; a local synthetic unrelated client survives fault injection; test-created clients disconnect/reconnect; queue keys belonging to other runs remain unchanged. **NOT RUN**.

### TEST-02 — constant Solana fixtures have cross-process cleanup hazards

**Revalidation:** Solana source/target/token constants are reused (`tests/integration/helpers/lifecycle-fixture.ts:4-6,20-28`). Source-row selection correctly avoids the address fallback for Solana (`:53-67`), but lot/position deletions still select shared target/chain/token (`:95-115,152-155`) and source-position/wallet cleanup selects the shared source (`:195-210`). Sequential execution within one Vitest instance does not constrain a second invocation (`vitest.integration.config.ts:29-30`).

Step-by-step fixes:
1. Derive valid unique Solana public keys from synthetic per-run keys without contacting any chain. Preserve validation rules used by `resolveChainAddress` (`tests/integration/helpers/lifecycle-fixture.ts:1,45-47`). No real secret material is required.
2. Link fixture-created aggregate positions/lots to the same run/tenant ownership used for executions. Cleanup by concrete created IDs where available, not broad target/token alone.
3. Make cleanup verification report owned row counts only. Current token-wide trade count can see another run's rows (`:259-264`).
4. Give each test process a disposable DB/profile or explicit namespace; never clean an existing shared integration database as part of this review.

Tests: run two fixture operations concurrently in a disposable local DB; clean A while B is active; assert B's source/position/lots/trades survive and A leaves none. **NOT RUN**.

### TEST-03 — sparse schema checks are not complete migration acceptance

The guard finds the lexicographically highest SQL file for error messaging but checks a fixed object list (`tests/integration/helpers/schema-guard.ts:25-76`). It does not prove that all later constraints, RLS policies, profile branches or replay effects match expected schema (`:80-109`). Those properties are module 02's responsibility; this finding is test-assurance weakness, not a demonstrated production migration exploit.

Step-by-step fixes:
1. Add profile-specific expected schema identity and migration/replay evidence to the disposable test bootstrap.
2. Assert load-bearing indexes, foreign keys, tenant policy state and key function behavior alongside tables/columns; keep errors actionable.
3. Test clean creation and safe rerun against dedicated disposable databases with the documented unified core/LP migration identity. Never infer newest schema from the existence of an older table or assume that compatibility profile flags provide migration isolation.
4. Preserve setup's pool-close behavior and serial runner constraints (`tests/integration/global-setup.ts:7-15`; `vitest.integration.config.ts:27-32`).

Tests: remove one key constraint/policy from a disposable fixture schema and assert fail-fast guard rejection; divergent or incomplete migration identity rejects the suite. Module 02 verifies that the current runner is unified rather than profile-isolated. **NOT RUN**.

## C. Regression invariants beyond the harness findings

These are proposed acceptance requirements, not claims that current tests cover them:

1. **Production principal survives every boundary.** Start with two real route registrations and a mocked/inert signing service; verify userId, queued maximum mode, grant and actual debited account reach canonical claim/evidence unchanged. Current stand-ins are not enough (`tests/integration/cross-tenant.integration.test.ts:56-76`).
2. **Contract tests call actual handlers.** A local validator/program-test must exercise the compiled actual instruction/account constraints. On-chain test depth and current helper-only coverage are assessed in module 04; deployment/audit behavior is **NOT VERIFIED**.
3. **Unknown submission remains unknown and does not resubmit.** Current ledger chaos tests preserve submitted state on replay (`tests/integration/chaos.integration.test.ts:190-216`); extend to the production venue dispatch and crash between external accept and durable persistence.
4. **Master lots and aggregate ledger agree across tenants.** Existing lot tests cover canonical concurrent claim/replay (`tests/integration/lot-exits.integration.test.ts:85-117`); add multiple tenants, multiple masters and aggregate close/redemption races using actual worker consumer paths.
5. **Security tests never contact live systems or load private credentials.** Provide dummy env explicitly, prohibit network except localhost, avoid root Turbo build/test side effects, and record exact executed cases/environment. This review intentionally did not run tests due report-only and infrastructure-contact constraints (`package.json:8`; `turbo.json:25-29`; `vitest.integration.config.ts:1-4`).

## D. Coverage and exclusions

### In-depth files (complete reads)
- `vitest.integration.config.ts:1-35`
- `tests/integration/global-setup.ts:1-17`
- `tests/integration/helpers/schema-guard.ts:1-110`
- `tests/integration/helpers/lifecycle-fixture.ts:1-309`
- `tests/integration/chaos.integration.test.ts:1-432`
- `tests/integration/cross-tenant.integration.test.ts:1-252`
- `tests/integration/lot-exits.integration.test.ts:1-119`
- `tsconfig.integration.json:1-71`
- `package.json:1-46` and `turbo.json:1-33` for runner/output behavior.

### Not reviewed in this module
Remaining integration tests were inventoried, not read here; module reviewers may cite specific ones in their own depth appendices. Installed Vitest/Fastify/BullMQ/SDK behavior, generated outputs, actual DB/Redis state, test results, local validator execution and runtime network enforcement are **NOT VERIFIED**. No root test/build/typecheck command was executed. This module's status is review-workflow complete with explicit file gaps, not full test-suite coverage.

```json
{"deep":["vitest.integration.config.ts","tests/integration/global-setup.ts","tests/integration/helpers/schema-guard.ts","tests/integration/helpers/lifecycle-fixture.ts","tests/integration/chaos.integration.test.ts","tests/integration/cross-tenant.integration.test.ts","tests/integration/lot-exits.integration.test.ts","tsconfig.integration.json","package.json","turbo.json"],"skim":[],"excluded":[{"path":"tests/integration/* other suites","reason":"Inventoried only; targeted module reviewers may supply independent depth evidence."}]}
```
