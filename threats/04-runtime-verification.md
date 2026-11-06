# Runtime verification and live-data replay

Date: 2026-11-06. This operational follow-up supersedes the earlier assessment's **NOT RUN** statements only for the checks explicitly recorded here. The earlier 76-finding register remains a static-review snapshot; registry advisories and runtime observations below are not silently added to its severity counts.

## Outcome

- **69 migrations completed and replayed successfully** against a newly created isolated PostgreSQL instance.
- **124/124 integration tests passed**, across 18 files, including canonical lifecycle, tenant isolation, lot accounting, subscriptions, pipeline attribution, database-connection termination and Redis-client reconnect scenarios.
- **3,042 unit-suite tests executed: 3,036 passed, six failed** across 205 files. All six failures were RLS assertions using the bootstrap superuser. **The same RLS file passed all ten tests with a dedicated non-superuser role** in the isolated database. This is configuration-sensitive evidence, not a clean default-role test run.
- Public live Solana, Jupiter, Polymarket and Meteora data was acquired read-only. Five public Polymarket fills passed through canonical source persistence, replay deduplication, signal creation, paper claims/evidence, trade persistence and populated API reads. The final API reported five wallets, five signals and five paper trades. These paper fills are synthetic local effects using real source economics, **not venue executions**.
- A real successful Solana transaction parsed into events; a sampled failed transaction returned no parsed event for the checked owners. The provider also returned a version-1 transaction which the current version-0 request configuration rejects.
- Three real Meteora pools normalized. Active TVL remained explicitly approximate because no on-chain bin source was replayed. A real fill completed through a one-worker BullMQ queue with durable completion and result verification.
- API and LP entrypoints started sequentially against isolated infrastructure, served HTTP reads, and were stopped. Service keys could access permitted global reads but were rejected on user-only account/position routes.
- Backend compilation and source type checks were exercised with output confined to `threats/`; stale existing workspace declarations caused initial failures. Fresh declarations resolved DB/API/indexer/LP errors. Direct executor source type-checking passed after the temporary declaration-layout error was isolated. Frontend original type-checking and copied build **failed** because local `@solana/web3.js` and `tailwindcss` are unresolved; the copied build also could not fetch some Google Fonts.
- `pnpm audit --json` completed with a nonzero finding exit and returned **114 registry vulnerability entries: six Critical, 45 High, 54 Moderate, nine Low**. These are not 114 demonstrated application exploits.

## Execution matrix

| Unit suite | Passed | Failed |
|---|---:|---:|
| Shared | 509 | 0 |
| Database | 887 | 6 |
| API | 86 | 0 |
| Indexer | 208 | 0 |
| Signal engine | 176 | 0 |
| Scorer | 78 | 0 |
| Trade executor | 816 | 0 |
| LP | 206 | 0 |
| Discovery | 3 | 0 |
| Alerts | 17 | 0 |
| MCP | 4 | 0 |
| Web | 46 | 0 |
| **Total** | **3,036** | **6** |

The 124 integration tests are additional to the 3,042 initial unit tests. RLS reruns are separate executions, not additional distinct tests. The misleadingly named `rls-nonsuperuser` attempt still used a superuser after bootstrap-role demotion was refused; only `rls-runtime-role` is the successful non-superuser run. That role inherited `swat_app` grants but its current identity was `swat_review_runtime`; the suite separately switches to `swat_app` in one test. Passing scoped queries does not prove arbitrary SQL cannot change tenant flags or bypass policies under other role identities (`packages/db/sql/064_row_level_security.sql:29-43`).

Vitest used review-only source aliases and did **not** invoke the original integration configuration's global setup/schema guard. The 69 migrations were run beforehand. Existing chaos tests terminated database connections and killed normal Redis clients only inside the new isolated containers.

Emitted TypeScript builds passed for shared, signal engine, scorer, discovery, alerts and MCP; DB, API, indexer and LP passed after fresh dependency declarations were generated under `threats/`. The executor's emitted retry failed TS7006 in the temporary declaration layout; its direct source-resolved no-emit typecheck passed. Web typecheck/build failed as recorded. These review-only outputs do not establish a green original monorepo production build.

Actual HTTP results: API `/health` without a key was 401, whereas `/v1/health` was 200 without a key; authenticated health returned 200. Authenticated `/v1/stats` returned the five paper trades; `/v1/me/account` rejected the service key. LP `/v1/health` returned 200, keyed `/v1/lp/discover` returned 200 with an empty pool list, and `/v1/lp/positions` rejected the service key. The live Meteora normalization was a separate parser replay, not a populated LP discovery-route test. Full authenticated end-user success paths were not established by these service-key denial probes.

## Resource controls and isolation

All commands, test workers and service processes launched by the review inherited affinity to **CPU 0**. No reviewer agents, parallel package test runners or multi-core builds were used. Vitest used one fork worker, no file parallelism and maximum test concurrency one. Concurrent requests inside existing concurrency tests still ran, on that same core.

Two existing PostgreSQL/Redis containers were already healthy and were **not restarted, reconfigured, migrated or used for test writes**. Their existing unrestricted CPU settings were observed but not changed. The Docker daemon and unrelated existing processes were not globally pinned; the one-core claim applies to review-launched workloads, not the whole machine.

New containers:

- `swat-review-postgres`: CPU 0, 0.65 CPU quota, 256 MiB memory, loopback port 55432, database `swat_runtime_integration`; PostgreSQL parallel workers disabled.
- `swat-review-redis`: CPU 0, 0.15 CPU quota, 64 MiB memory, loopback port 56379, persistence disabled and 32 MiB Redis maximum memory.

Node heap started at 384 MiB. Three initial compilers hit that artificial limit; later compilation used a bounded 640 MiB heap after checking available memory. These were child-process heap failures, not evidence of a two-core crash. No dependency installation or package-source fix was applied. Service startup used a minimal explicit environment, no real dotenv file, no signer or venue credentials, paper mode and `AUTO_EXECUTE=false`; billing/startup jobs were disabled where supported. Service RPC targets were intentionally dead localhost endpoints; public acquisition ran separately.

## Runtime findings and precise closure

| ID | Severity | Confidence | Evidence | Observation | Code-level or operational fix |
|---|---|---|---|---|---|
| RUN-01 | High | Verified | `packages/db/src/tenancy.ts:71-109`; `packages/db/sql/064_row_level_security.sql:28-63`; `packages/db/src/rls.test.ts:119-259`; [role output](runtime/existing-postgres-read-only.log), [failed suite](runtime/unit-db.json), [passing non-superuser suite](runtime/rls-runtime-role.json) | Existing local `swat` is superuser and BYPASSRLS. The isolated equivalent permits cross-tenant queries/updates despite tenant settings; six RLS assertions fail. Dedicated non-superuser execution passes. Remote production role remains unknown. | Separate bootstrap/migrator, global-maintenance and user-runtime roles. Assert NOSUPERUSER/NOBYPASSRLS on application connection startup. Exercise real registered callers under the intended roles, preserving legitimate global/login paths; do not simply replace every pool with `swat_app`, whose bypass is deliberately forbidden. Never attempt to demote PostgreSQL's bootstrap role: create a separate runtime identity. |
| RUN-02 | High | Verified | `tests/integration/helpers/schema-guard.ts:25-69`; `packages/db/src/migrate.ts:11-30`; [existing schema](runtime/existing-schema-check.json), [clean migration](runtime/migrations.log) | Existing local `swat` is missing `copy_position_master_lots`, `user_payment_intents`, `crypto_payments`, `lp_copy_subscriptions`, and `lp_copy_executions`. Clean unified migrations succeed. This is local schema drift, not proof of remote schema state. | Back up and assess the actual populated database before separately authorized migration. Add required-table/column/schema readiness at application startup and deploy gating. Verify migration replay against a disposable populated copy and do not use generic `SELECT 1` as schema readiness. No existing-data migration was performed. |
| RUN-03 | Medium | Verified | `apps/indexer/src/index.ts:441-446,533-541`; [version-0 rejection](runtime/solana-transaction.json), [version-1 response](runtime/solana-transaction-v1-0.json), [fetch provenance](runtime/live-fetches.json) | A public RPC sample is a version-1 transaction; current requests cap supported version at 0. One discovery path catches the rejection as null, which can omit evidence without an explicit compatibility record. The sampled version-1 transaction failed on-chain; no successful version-1 trade was established. | Negotiate/validate supported RPC and SDK transaction versions; retain an unsupported-version observation and retry/quarantine instead of counting it as empty evidence. Add the captured provider error and transaction as offline compatibility fixtures. Increasing the numeric limit alone is not proof downstream SDKs accept the new layout. |
| RUN-04 | Medium | Verified | `apps/web/package.json:10-25`; `apps/web/lib/wallets.ts:2`; `apps/web/tailwind.config.ts:1`; [original typecheck](runtime/web-original-typecheck.log), [module resolution](runtime/web-dependency-resolution.log), [copied build](runtime/web-build-isolated.log) | The installed local dependency graph cannot resolve two declared frontend dependencies, so original type-checking and copied build fail. Some Google Font fetches also fail; no successful frontend production build/UI acceptance is established. | Restore a reproducible frozen-lockfile installation in a separately reviewed build environment; verify package-local links before build. Prefer bundled fonts or a controlled fetch stage. Repeat original typecheck/build and rendered UI tests after installation; do not suppress errors or call the four web unit files a production build. |
| RUN-05 | Medium | Verified | `apps/api/src/index.ts:256-305`; [service smoke](runtime/service-smoke.json) | RPC health fields derive from a nonempty configured URL, not a successful call. Intentionally unreachable localhost targets can still be described as healthy while database/Redis make aggregate status OK. | Separate configured, recently probed, stale and failed RPC states. Keep liveness separate from execution readiness, with timestamped bounded probes and redacted URLs. Add a dead-localhost regression; generic liveness may remain 200 but must not imply venue readiness. |
| RUN-06 | High | Likely | `apps/web/package.json:10-15`; `apps/mcp-server/package.json:14-20`; [registry response](runtime/dependency-audit.log), [summary](runtime/dependency-audit-summary.json) | Installed versions have registry advisories, including Critical-rated Next.js, proxy-addr and test-only tinypool entries. Dependency/version matches are verified; affected feature reachability and production deployment are not. | Triage each advisory against actual features/platforms and runtime versus development paths. Upgrade compatible vulnerable dependencies in a separately authorized fix, rebuild frozen-lockfile artifacts and rerun regression/security checks. Do not install arbitrary major versions, infer Linux exposure from a Windows-only advisory, or relabel all entries as exploitable Critical product findings. |

### Dependency advisory qualification

The registry reported Next.js 15.5.18 matching three Critical advisories. One is Windows-host-specific; this checkout is Linux and the actual hosting platform was not attested. Two involve image optimization; no application `next/image` use was found in the targeted source search, but that does not prove the optimizer endpoint is inaccessible. The reported SVG fix floor reaches 15.5.28; use the full advisory list rather than patching only to an earlier floor.

`proxy-addr` 2.0.7 affects trust-subnet assumptions; deployed proxy trust settings and exploitability are unverified. `tinypool` 1.1.1 entries are reached through Vitest development/test tooling, not demonstrated public application ingress. MCP client redirect advisories do not automatically apply to this server's SSE listener. All registry descriptions are external advisory claims, not locally reproduced exploits.

## Ordered remediation and acceptance

These are unapplied instructions, not completed fixes. Preserve paper/off safeguards throughout.

1. **Converge schema safely.** Identify the actual target/profile and take a verified backup before any populated-database change. Restore to an isolated disposable copy, replay the selected migration set, and inspect every required table/column and existing constraints. Promote only after the populated-copy migration and replay tests pass; gate startup on required schema rather than database connectivity. Acceptance: a deliberately missing lot/billing/LP table blocks readiness with its name, and existing-data replay preserves balances/lot totals.
2. **Separate runtime authority from bootstrap authority.** Inventory user-scoped, authentication, operator and maintenance callers; assign explicit roles/pools rather than relying on superuser tenant flags. Deny user pool startup for SUPERUSER/BYPASSRLS and forbid bypass flags for all user-runtime identities, not only a single role name. Verify permission/role-switch and tenant-ID mutation behavior under those exact identities. Acceptance: real two-user HTTP and queue paths cannot read/update the other user's rows, unscoped user queries fail closed, while separately authorized global jobs still work. The current 10/10 scoped suite is only part of this gate.
3. **Restore reproducible build artifacts.** In a separately authorized dependency-remediation task, use a clean frozen-lockfile environment, verify frontend package-local links, and build shared then DB then consumers. Build originals, not only review aliases; bundle fonts or isolate their network fetch step. Acceptance: original web typecheck/production build, original executor emitted build and backend builds pass from a clean checkout, followed by rendered UI checks. Keep the initial failures as provenance.
4. **Record unsupported source evidence.** Capture version rejection as a typed ingestion observation, validate new response layouts with the actual SDK/parser, and retry or quarantine with bounded backoff. Acceptance: the captured version error is visible and cannot be classified as no transaction; the failed version-1 sample creates no actionable swap. Obtain an independently successful new-version fixture before asserting support for successful swaps.
5. **Make health honest.** Keep liveness lightweight, but expose configured versus recently verified RPCs and schema/execution readiness separately, with bounded probes and timestamps. Acceptance: a dead localhost RPC is never reported as verified healthy, schema absence blocks readiness, and probe failure leaks no credential-bearing URL.
6. **Triage dependency advisories without overstating reachability.** Match each advisory/version/path to deployed platform, exposed endpoint and production or test usage. Select compatible releases covering the complete applicable advisory set, update lockfile/build artifacts in an authorized fix and run regressions on one core. Acceptance: the follow-up audit has no unexplained applicable Critical/High entry; nonapplicable/development-only entries have explicit prerequisites and evidence, not blanket suppression.

Full autonomous two-user real-source paper fan-out and reducing-exit verification remains a distinct acceptance gap after these environmental controls, not a reason to enable live execution now. Contract runtime and remote/funded verification remain blocked by absent tooling, network evidence or separately scoped credentials/authority.

## Live-call and deployment evidence

[Live fetch records](runtime/live-fetches.json) contain URL, bounded response hash/size, timestamp and elapsed time. No account keys, signed orders, swap building/submission, remote mutations, fund transfers, credential validity tests or paid authenticated venue operations were used. Public calls were sequential and bounded.

- Solana version/finalized slot/signatures/transactions: public read-only JSON-RPC succeeded.
- Jupiter small SOL/USDC quote: HTTP succeeded; no signing, build or submission followed.
- Polymarket v2 trades and Gamma markets: HTTP succeeded. Public trade rows were parsed/replayed; Gamma response availability does not establish full settlement/certification.
- Meteora pool page: HTTP succeeded; three normalized pools.
- Polygon public endpoint: network unreachable; alternate endpoint returned 401. Polygon chain identity, receipt contract state and finality remain unverified.
- `https://api.wakeprotocol.io/health`, named in deployment documentation: DNS resolution failed. No remote application, firewall, TLS forwarding or production database role was verified. The hard-coded HTTP backend address was not used to send credentials.
- Declared WAKE program `6t6dRetG3Hns4vCfZaj392e9bZ6uTEEmvL37KnDWErfS` (`programs/wake-vault/src/lib.rs:27`): finalized mainnet `getAccountInfo` returned null at the recorded slot. That one address was absent in this observation; it does not prove no alternative deployment exists. No user custody account/balance was scanned.

The isolated queue sample took approximately 91 ms in its independent durable-state check, with another final replay also completing. These are single low-load observations on throttled local hardware, **not p95/p99, throughput or master-to-land measurements**.

## Harness errors kept separate from product defects

Initial report-only harness failures included CommonJS top-level-await selection, missing token fixture rows, missing reconciliation deadline, replaying a confirmed state backwards, and an executor label exceeding the schema's 20-character limit. Those were corrected only in `threats/`; final replay succeeds. The database rejected invalid fixture transitions, which is positive invariant evidence, not a product failure.

An initial QueueEvents waiter missed a completion event while using its default stream position; the durable Redis job already showed processed/finished timestamps and return value. A new queue with explicit stream start completed and its durable state was independently checked. This supports an event-waiting harness issue, not an inferred duplicate venue submission or Redis job loss.

Initial declaration errors were produced while resolving existing package `dist` outputs; fresh declarations under `threats/` resolved the DB/API/indexer/LP builds. A later implicit-any error occurred only in the temporary executor declaration-build layout, while direct source-resolved type checking passed. The exact resolution cause was not independently proven, and a successful executor emitted build was not established. Do not open an application fix for that temporary-layout error.

## Coverage still not established

This follow-up is stronger than static review but **not live-trading certification**. The full autonomous indexer/signal/scorer/executor fleet was not launched; the replay directly invokes production stage functions and a separate minimal BullMQ worker. Metadata/source eligibility was staged in the disposable database. No full two-user real-source follower fan-out/lot exit, unknown external acceptance reconciliation, independent final-byte policy, measured end-to-end latency distribution or paid venue submission was certified.

Rust, Cargo, Anchor and Solana CLI were unavailable; no on-chain handler/CPI/local-validator build/test ran. External deployed contracts, upgrade authority, signer custody and funded-account behavior remain unverified. Python secondary services, browser-rendered acceptance, PgBouncer transaction-pool semantics and remote TLS/network hardening were not executed. Historical binary/unreachable coverage and credential provenance remain the earlier bounded exclusions.

The existing databases/containers were left untouched except read-only observations. Review-launched API/LP processes were stopped. Both review containers were stopped after final evidence capture; containers/volumes were retained and the existing containers remain running. PostgreSQL data remains in its retained review storage; Redis had persistence disabled, so stopped-container retention does not preserve its in-memory job state (the durable-state observation is retained in JSON/log evidence). All 709 baseline source hashes remained unchanged and the tracked Git diff was empty. No application fixes, installs, commits, pushes or deployments were performed. [Cleanup evidence](runtime/cleanup.json), [final database counts](runtime/final-review-database-snapshot.log) and [final integrity checks](runtime/final-integrity.json) record these outcomes.

## Evidence index

- [Command ledger](runtime/commands.jsonl): exit codes, commands, wall time, CPU and log paths, including failures/retries.
- [Runtime summary](runtime/runtime-summary.json): test counts, role revalidation, container limits and source-integrity snapshot.
- [Unit results](runtime/unit-db.json), [integration results](runtime/integration-tests.json), [RLS dedicated-role results](runtime/rls-runtime-role.json); other unit JSON/log files are adjacent.
- [Final live replay](runtime/live-replay.json), [successful Solana parse](runtime/solana-success-replay.json), [durable queue result](runtime/queue-real-data.json), [HTTP checks](runtime/service-smoke.json).
- [Dependency audit summary](runtime/dependency-audit-summary.json) and [raw registry response](runtime/dependency-audit.log).

No inferred pass is substituted for a blocked test. Operational changes to existing schema/roles, dependency remediation, funding/trades and deployments require their own implementation/operations authorization.
