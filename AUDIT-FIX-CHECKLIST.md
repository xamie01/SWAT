# Unified Audit Remediation & Goal Delivery Checklist

Sources:

- `AUDIT-REPORT.md`, dated 2026-07-15, defines defects and unsafe behavior.
- `gaol.md`, dated 2026-07-16, defines the required end state. The repository currently uses the filename `gaol.md`.

This file is the single execution tracker. Audit IDs are retained for traceability; `G*` items are goal deliverables. Check an item only after implementation, focused tests, and inspection of the resulting data or external state. A live-chain certification item also requires recorded evidence under `docs/certification/`.

## Status Legend

- `[x]` **COMPLETE** - implementation, focused tests, and repository evidence are present.
- `[ ] ... **PARTIAL**` - a usable implementation exists, but one or more stated behaviors or tests are missing.
- `[ ] ... **NOT BUILT**` - no substantive implementation for the stated deliverable was found.
- `[ ] ... **EXTERNAL EVIDENCE**` - code may be ready, but production credentials, measured canaries, operator review, or certification evidence is still required.

## Verified State and Recommended Plan - 2026-07-30

This section re-verified the repository against `docs/plans/BUILDER-GUIDE.md` and supersedes the 2026-07-27 ledger where they disagree. It exists to answer one question: **what to do next, in what order.** Audit IDs are preserved so work still checks off against the phases below.

### Corrections to earlier claims

Facts re-checked in the working tree on 2026-07-30. Each of these was asserted differently above:

| Earlier claim | Verified reality |
|---|---|
| "`pnpm test` passes / prior gates recorded" | **`pnpm typecheck`, `pnpm test`, and `pnpm build` all failed from a clean checkout.** `packages/shared/tsconfig.tsbuildinfo` was committed while `dist/` is gitignored, so `tsc` read a stale incremental cache, emitted nothing, and exited 0; every consumer then failed to resolve `@swat/shared`. `turbo.json` also declared `test`/`typecheck` as `dependsOn: ["^test"]`/`["^typecheck"]` rather than `^build`. **Fixed 2026-07-30**: buildinfo untracked, `*.tsbuildinfo` ignored, `^build` added. Now green from a clean tree — typecheck 13/13, **439 tests across 13/13 packages**, build 11/11. |
| CI exists and was reviewed (G7-T3 marked `[x]`) | The workflow exists and is correct, but **had never completed a run.** Every push failed at the Typecheck step with `Cannot find module '@swat/shared'`; the Test, build, and Integration steps never executed. G7-T3 cannot be considered evidenced until one GitHub-hosted run goes green. |
| "`.env` currently allowlists `robinhood-chain` prematurely" (G2-R13, DoD item 7) | **Stale — already resolved.** `.env:128` is `LIVE_ENABLED_CHAINS=` (empty). No chain is allowlisted. Both items' remaining work is the certification document and canary, not an env removal. |
| G5-R3 breaker "complete" | Implemented and durable, but keyed **`breaker:${chain}`** only (`packages/db/src/circuit-breaker.ts:33`). This satisfies the audit item and **violates Builder Guide Standing Rule 2**, which requires `(account, chain)`. See step S0.3. |
| Generated artifacts "remain in the dirty worktree" | Worse than dirty — **they are committed.** `apps/discovery/dist/` (4 files) plus `.turbo/cache/*` and `apps/*/.turbo/turbo-build.log` are tracked in git, so `.gitignore` does not affect them. Requires `git rm --cached`. |

### Ordering principle

Builder Guide Standing Rule 2 (account-parameterization) is the load-bearing constraint. Any execution or risk code touched from here on must take an account/scope parameter with `'operator'` as today's only value. The schema already supports this — migration `028_copy_execution_lifecycle.sql` defines `target_account` with `UNIQUE (source_trade_id, target_account, execution_mode)` and `UNIQUE (chain, target_account, client_order_id)`. **Every hour spent writing single-account code now is an hour of rework plus a live-money migration later.** Steps are ordered so no step builds on something a later step must re-key.

### Stage 0 - Engine hardening (do these in order)

- [x] **S0.1 Restore the green gate.** Untrack `packages/shared/tsconfig.tsbuildinfo`, add `*.tsbuildinfo` to `.gitignore`, make `test`/`typecheck`/`lint` depend on `^build` in `turbo.json`. **Done 2026-07-30** (commit `ebbed82`): clean-tree typecheck 13/13, test 439 passing 13/13, build 11/11. Closes the `pnpm test` half of the Working Rules gate.
- [ ] **S0.2 Prove CI green once.** Push S0.1 and confirm a GitHub-hosted run completes all five steps. Expect new failures in `pnpm test:integration`, which has never executed in CI and needs a `*_integration` database. Nothing downstream is trustworthy until one run is green end to end. **Evidences G7-T3**; unblocks every later stage gate.
- [ ] **S0.3 Re-key the circuit breaker to `(account, chain)`.** Change the config key from `breaker:${chain}` to `breaker:${account}:${chain}`, thread an `account` parameter through `readCircuitBreakerState`, `recordCircuitBreakerFailure`, `recordCircuitBreakerSuccess`, and `claimCircuitBreakerProbe`, and add an idempotent migration that copies each existing `breaker:<chain>` row to `breaker:operator:<chain>` without dropping the old key in the same release (expand-and-contract, Standing Rule 4). Touch `packages/db/src/circuit-breaker.ts`, its callers in `apps/trade-executor/src/index.ts`, and add `packages/db/sql/033_*.sql`. **Do this before S0.4 and S0.5** — both consume breaker state. Reopens and re-closes **G5-R3** under Standing Rule 2.
- [ ] **S0.4 Add the DB-resolved risk policy (`G5-R1`).** No `resolveRiskPolicy` exists anywhere in the repo. The DB value `trading.max_position_pct` is currently read only by `apps/api/src/attribution-routes.ts:43` for reporting; the executor sizes from env (`USDC_BALANCE_RISK_PCT`, `BASE_POSITION_*`, `PAPER_MAX_POSITION_PCT` at `apps/trade-executor/src/index.ts:341-370`). Introduce `resolveRiskPolicy({account, chain})` in `packages/db`, returning one validated policy from DB config with env as explicit fallback, and enforce it **before claim** in every mode. Migrate existing operator config explicitly rather than overwriting (per `H15`).
- [ ] **S0.5 Define and enforce one stop-loss contract (`L17`).** `stopLossPct: 20` exists in `DEFAULT_RISK_CONFIG` and `config.risk.stop_loss_pct` (migration `001`), and both the API and dashboard read it — but **nothing enforces it.** Fold it into the S0.4 policy object so runtime, DB, env docs, and alerts share one source, then enforce and test it. This is the only `NOT BUILT` row remaining in Phase 5.
- [ ] **S0.6 Wire the unused canonical-lifecycle entry points (`F-CORE7`, `F-CORE3`).** These `packages/db/src/copy-trade-lifecycle.ts` exports have **zero runtime callers**: `claimCopyExecutionsForReconciliation`, `releaseCopyExecutionReconciliationClaim`, `requestCopyExecution`, `buildCopyExecutionClientOrderId`, `advanceSourceTradeConfirmation`. Per-venue reconciliation exists (Trojan, Robinhood, Polymarket), but no single coordinator sweeps *every* ambiguous canonical execution at startup and on a schedule. Build that coordinator on `claimCopyExecutionsForReconciliation`, account-parameterized. Also add the explicit minimum-activity/selected-wallet policy at the canonical claim boundary for `F-CORE3`.
- [ ] **S0.7 Untrack committed build artifacts.** `git rm --cached` for `apps/discovery/dist/` (4 files), `.turbo/cache/*`, and `apps/*/.turbo/turbo-build.log` + `packages/*/.turbo/turbo-build.log`. `.gitignore` already lists `.turbo/` and `dist/`, which has no effect on already-tracked paths. Closes the Final Repository Gate artifact row and part of the third Working Rule.
- [ ] **S0.8 Activate the D17 database items.** None are present: no `readPool`/`writePool` split in `packages/db/src/client.ts`, no BRIN index on transaction timestamps, no `pg_stat_statements`. Cheap now, and the pool split is far easier before per-user query volume arrives in Stage 2.
- [ ] **S0.9 Add the missing Stage 0 test coverage (`G7-T5`, `G7-T1`).** `G7-T5` chaos checks (executor death after submit, Redis restart, PostgreSQL restart, worker reconnection) are `NOT BUILT`. Add them once S0.3-S0.6 have settled, so they exercise the account-parameterized machinery rather than needing a rewrite.

**Stage 0 exit gate:** CI green on every merge; risk policy DB-resolved and enforced pre-claim; one reconciliation coordinator covering all ambiguous executions; breaker keyed `(account, chain)`; no generated artifacts tracked. D1/D2/D3/D7/D10/D15 infrastructure is a parallel operational track and does not block code work.

### After Stage 0

Do not start these until the Stage 0 gate holds — each one multiplies the cost of the rework above.

- **Stage 1 (auth/tenancy)** may begin in parallel once S0.2 is green, since it touches no execution code. Migrations `033+` for `users`/`user_sessions`/`user_auth_wallets`/`user_api_keys`, `apps/api/src/auth/`, and the audit-log table. Note the migration number collides with S0.3's breaker migration — whichever lands second renumbers.
- **Stage 2 (per-user tracking)** carries the `G6-A2`-`G6-A10` attribution track as a non-blocking parallel effort.
- **Stage 3 (venue certification)** is pull-based: certify a venue only when live money is actually wanted there. `DG-1` is resolved in favor of direct Jupiter signing with Jito bundles, so `F-SOL2`/`F-SOL3` are retargeted to that path and the Trojan work (`H4`, `TROJAN_*` env) retires with it. Paper mode ships everywhere without this stage. With `LIVE_ENABLED_CHAINS` empty and zero certification rows, all three chains are correctly clamped to paper today.
- **Stage 4 (custody)** is hard-blocked by `DG-2` (legal opinion), which is non-negotiable and has no code workaround.
- **Stages 5-7** are unchanged from the Builder Guide. Stage 7's chain-registry refactor stays strictly last; the green suite from S0.1 is its safety net.

### What is genuinely working today

So this plan is not read as "everything is broken": all nine services build and pass tests; ingestion, scoring, clustering, signal detection, alerting, and paper execution are implemented end to end across all three chains; the canonical source-event and execution state machine has real runtime callers in `apps/trade-executor`; live execution is correctly gated off by two independent controls. The gaps above are real but bounded, and none of them block paper-mode operation.

## Full Codebase Status Review - 2026-07-27

This review inspected the current source, SQL migrations, tests, CI, runtime documentation, and live-certification records. Existing checkmarks were treated as claims to verify, not as evidence. Current focused verification passed 112 database tests and 127 trade-executor tests; both packages typechecked. Migrations `001` through `032` replayed twice on a clean temporary database and twice on the upgraded local database. A real PostgreSQL breaker probe tripped on the third failure, granted one half-open lease, rejected a concurrent probe, and reset durably. No production order was submitted and no chain certification is inferred from tests.

Current disposition:

- **Complete implementation: 173 rows.** This includes the newly validated canonical lifecycle, Polymarket reconciliation, shadow isolation, persisted breaker/exposure controls, and latency reporting rows below.
- **Partial implementation: 44 rows.** Named implementation gaps are `F-CORE3`, `F-CORE7`, `F-SOL2`, `F-SOL3`, `G1-S1`, `G2-R3`, `G2-R4`, `G2-R5`, `F-RH3`, `F-RH5`, `F-RH6`, `F-PM5`, `G3-P6`, `F-PM7`, `F-PM8`, `G3-P10`, `M14`, `G4-S2`, `G4-S7`, `G5-R1`, `G5-R7`, `G6-A6`, `G6-A7`, `G6-A9`, `G6-A10`, `G7-T1`, `G7-T2`, `G7-A1`, `G7-A3`, `G7-A5`, and `G7-A6`; working-rule and final-gate gaps are also marked inline.
- **Not built: 3 rows.** These are `L17`, `G7-T5`, and final generated-artifact cleanup.
- **External evidence required: 14 rows.** These cover authenticated round trips, eligibility, canaries, certification records, production acceptance, measured latency/expectancy/completeness targets, environment funding checks, and manual reconciliation.

## Working Rules

- [x] Record the initial baseline: 11/11 workspace typechecks, 31/31 tests, and a production build passed on 2026-07-15.
- [x] Keep Solana, Polygon/Polymarket, and Robinhood ingestion and paper paths available throughout remediation.
- [x] Keep Polygon and Robinhood live execution clamped to paper until their certification gates pass.
- [x] Treat source events and submitted executions as idempotent; never infer or fabricate a fill.
- [x] Use least-privilege, bounded token approvals; never grant infinite ERC-20 allowances.
- [ ] Run focused tests after each item group and update this file immediately after validation. **PARTIAL** - focused suites are current, but this tracker was not updated immediately after every prior batch.
- [ ] Run full `pnpm typecheck`, `pnpm test`, and `pnpm build` at every phase gate. **PARTIAL** - all three now pass from a clean tree as of 2026-07-30 (typecheck 13/13, 439 tests across 13/13 packages, build 11/11) after the S0.1 build fix. Prior recorded gates were unreliable: the committed `tsbuildinfo` meant a fresh checkout emitted no build output while `tsc` exited 0. One GitHub-hosted CI run must still go green (S0.2), and the final post-audit repository gate remains open.
- [ ] Review each phase diff for secrets, generated artifacts, unrelated changes, and unchecked failure paths. **PARTIAL** - no secrets or private keys are tracked (verified 2026-07-30), but `apps/discovery/dist/`, `.turbo/cache/*`, and the per-package `.turbo/turbo-build.log` files are **committed**, not merely dirty; `.gitignore` cannot affect tracked paths. See S0.7.

Migration numbering is authoritative from `packages/db/sql/`: `015_audit_schema_repairs.sql` is followed by `016_timestamp_tz.sql`, `017_execution_config.sql`, `018_shadow_trades.sql`, and subsequent ordered migrations.

Scope boundaries: do not add new chains, general Polygon DEX indexing, new signal patterns, automatic threshold tuning, or hand-written Polymarket signing during this plan. Complete and measure the existing three-chain loops first.

## Independent Validation Review - 2026-07-24

Items reopened by this review are **Problematic**: code, tests, runtime state, or required evidence does not support the prior completion mark. Historical verification notes remain for traceability but do not override the current repository state.

Historical review result: 114 completion marks were reopened on 2026-07-24. The 2026-07-27 status ledger above supersedes those counts and the then-current implementation descriptions below.

Validated after review:

- 2026-07-24: **C-T1, C-T2, C-T3, L5, G1-M2, and G1-M6 / F-CORE8**. Live mode now requires both `LIVE_ENABLED_CHAINS` and a non-expired reviewed record in `chain_certifications`; no certifications are seeded. Mode values require exact lowercase input. Focused shared tests passed 46/46, execution/certification database tests passed 11/11, database typecheck and affected builds passed, migration `024_chain_certifications.sql` replayed twice, and rollback-only PostgreSQL probes rejected evidence-free certification and recognized valid reviewed evidence. The live database retained zero certification rows and resolved all chains to paper.
- 2026-07-24: **L12**. Filled non-shadow trades are processed chronologically with average-cost accounting. Partial reductions persist separate realized and unrealized P&L, closed positions require no market quote, and oversells fail closed. P&L tests passed 16/16, the database suite passed 48/48, database typecheck/build passed, migration `025_signal_pnl_components.sql` replayed twice, and a cleaned PostgreSQL probe persisted total/realized/unrealized P&L of `32/32/0` for a multi-sale closed position.
- 2026-07-24: **L14 and L18**. Migration `016_timestamp_tz.sql` now converts only `TIMESTAMP WITHOUT TIME ZONE`, leaves `TIMESTAMPTZ` unchanged, and raises on missing or unexpected columns. Migration `023_copy_trade_lifecycle.sql` no longer owns a nested transaction. Migration contract tests passed 2/2, database typecheck passed, the full migration set replayed twice without transaction warnings, and a rollback-only `America/New_York` probe preserved the same epoch through two timestamp-migration executions.
- 2026-07-24: **L30**. `start.sh` now accepts an empty argument safely, validates options, tracks the exact Turbo process in a PID file, and shuts it down without broad `pkill`. Compose bind hosts and ports are configurable, and the web launcher uses dedicated `WEB_BIND_HOST`/`WEB_PORT` values instead of the API `PORT`. Shell syntax/help/error checks passed, Compose rendered custom ports `55432` and `56379`, invalid web ports failed closed, and Next.js reached ready state on temporary port `3017` before a clean interrupt.
- 2026-07-25: **L15**. Shared chain resolution now rejects raw EVM values without an explicit chain and EVM-shaped values labelled Solana. Queue payloads and database wallet, token, transaction, signal, trade, and relationship write boundaries resolve and canonicalize chain values before persistence. Shared regressions passed 48/48, database tests passed 54/54, affected typechecks and the database build passed, and a cleaned PostgreSQL probe rejected ambiguous/misclassified writes while persisting prefixed Polygon wallet, token, and signal values in lowercase with `chain = 'polygon'`. A runtime scan found no existing `solana:0x...` rows in the affected tables.
- 2026-07-25: **L29**. `.env.example` is now the single exhaustive environment reference; README and deployment guidance link to it and document exact mode precedence and certification gates without duplicating a stale table. A source-derived inventory currently matches all 87 runtime, indirect database, Compose, and launcher keys with no omissions or duplicates. Default-value loading, shell syntax, Compose rendering, and stale-claim scans passed; the nine execution-mode resolution tests also passed. The reference now uses runtime defaults including auto-execute score 85, documents all four modes and per-chain overrides, supplies non-empty RPC defaults, and no longer exports the unused `STOP_LOSS_PCT` variable.
- 2026-07-25: **H1**. Static and dynamic sizing now share a floor-based cap against the currently available balance; rounding cannot produce an amount above that balance. Solana live sizing reads the exact configured Trojan wallet twice through confirmed Helius RPC and retains `SOLANA_GAS_RESERVE_SOL`; Polymarket reads collateral for buys and outcome shares for sells, then caps again before order creation; Robinhood caps exact wei immediately before simulation and retains `ROBINHOOD_GAS_RESERVE_ETH`. Persisted rows use the actual capped amount, paper modes use the virtual bankroll, and unsupported Solana/Robinhood sells fail before claiming. Executor tests passed 32/32, including a `0.25 -> 0.19 SOL`, `100 -> 5` Polymarket USD, `8 -> 3.25` share, and `0.5 -> 0.002 ETH` cap. Workspace tests, typecheck, and production build each passed 11/11 tasks; no live order was submitted during verification.
- 2026-07-25: **G0-D11**. The production backfill processor is now directly exercised by an isolated BullMQ/PostgreSQL acceptance runner. It enqueues each production job twice, proves job-ID deduplication, waits for the real worker, and verifies one correctly chain-qualified transaction for Solana, Polygon, and Robinhood Chain. The runner closes the worker, force-obliterates only its run-specific queue, deletes fixtures, asserts zero fixture rows, and aggregates cleanup failures instead of suppressing them. `pnpm acceptance:g0-d11` passed, an independent post-run probe found zero matching Redis keys and zero transaction, wallet, or token fixtures, and indexer tests passed 38/38 with typecheck and build green.
- 2026-07-25: **G0-H5**. The dedicated Health view and default Workspace ingestion widget now poll the authenticated `/v1/health/ingestion` endpoint every 30 seconds. Both fail closed for missing chains, malformed payloads, loading failures, stale data, and explicit `empty` state; no-data chains render as `No data` / `NO DATA`, never healthy. Fabricated chain rows, source health, timeline, uptime, and aggregate telemetry were removed from the Health view and replaced with API-derived lag, counters, ratios, timestamps, evidence, and CSV export. The live endpoint returned HTTP 200 with all three chains explicitly `empty`; web typecheck and production build passed, and `/workspace` returned HTTP 200 from the local dev server.
- 2026-07-26: **F-PM1, F-PM2 / L22, G3-P1, and G3-P2**. Polymarket ingestion now reads only confirmed Data API `/trades`, validates the source transaction hash, and persists the exact `proxyWallet`, full decimal `asset` token ID, condition ID, side, size, price, and timestamp in immutable `polymarket_trades` rows before deriving canonical Polygon transactions. Migration `026_polymarket_context.sql` adds normalized full-token outcome mappings and complete market context including exact outcome, question, tick size, neg-risk, end date, accepting-orders flag, market state, and resolution status; incomplete Gamma/CLOB mappings fail closed and no fallback token or truncated-symbol lookup remains. Polygon signal generation now refuses missing context and includes every required field. Certification assertions require non-empty fixtures, 100% context coverage, and bounded lag. The migration replayed twice; `pnpm acceptance:polymarket-context` proved one deduplicated source trade, one derived transaction, two outcomes, 100% coverage, and 30-second lag, then an independent probe confirmed zero fixtures. Database tests passed 57/57, indexer tests 54/54, signal tests 2/2, and workspace tests, typecheck, and production build each passed all 11 tasks.
- 2026-07-26: **Wave 1 controller validation: G1-M8, G1-M9, F-CORE1, F-SOL1, F-RH1, G2-R2, F-RH2, G2-R6-G2-R11 except proportional-exit certification, G5-R5, and G6-A2-G6-A4**. Production Solana, reviewed Robinhood receipt, and confirmed Polymarket ingestion paths persist immutable canonical source events and propagate retryable failures. Robinhood startup verifies the configured chain and contracts, exercises configured fee tiers, clamps failed readiness, supports typed BUY/SELL submission and receipt/restart reconciliation, and preserves exact quantities and unknown legacy fee tiers. Attribution now keys outcomes by signal, chain, and execution mode, preserves unknown P&L as `NULL`, persists eligible-only expectancy snapshots, and exposes database-backed reporting. Focused validation passed 97 indexer tests, 90 executor tests, 17 database attribution tests, 13 scorer/API/web tests, and five PostgreSQL lifecycle integration tests. The combined `pnpm test`, `pnpm typecheck`, and `pnpm build` gates each passed all 11 workspace tasks; the integration suite passed 5/5. No live order or certification was inferred from these tests.
- 2026-07-26: **Alert and CI validation: G2-R1, G6-A5, and G7-T3**. Alert service now validates and bridges Robinhood/system and nightly expectancy publications from `swat:alert:queue` into the durable `swat-alerts` BullMQ worker, formats Telegram-safe messages, deduplicates publications, retries delivery failures, rejects malformed payloads, and closes bridge resources cleanly. Missing Telegram configuration now fails delivery instead of marking a signal alerted. Alert tests passed 13/13 with typecheck and build green. API, web, and MCP placeholder tests were replaced by 5, 3, and 4 real Vitest cases. The reviewed CI workflow provisions PostgreSQL 16 and Redis 7, applies migrations, clamps execution to paper, and runs typecheck, tests, build, and `pnpm test:integration`; the three package suites and five-test local integration command passed. A real Telegram credential smoke test and GitHub-hosted workflow run remain release evidence, not inferred certification.

| Problematic area | Affected checklist items | Evidence | Recommended approach |
|---|---|---|---|
| Canonical execution lifecycle | F-CORE3, F-CORE7 | Source, signal, execution, confirmed-position linkage, proportional exits, replay safety, and transition persistence are implemented. The canonical claim boundary lacks one unified selected-wallet/minimum-activity policy, and system-wide ambiguous balance reconciliation is not complete. | Consolidate copy eligibility at the canonical claim boundary and run every due ambiguous execution through one startup/periodic reconciliation coordinator. |
| Robinhood execution and certification | G2-R3-G2-R5, F-RH3, F-RH5-F-RH6, G2-R12-G2-R13 | Typed execution, proportional exits, receipts, actual quantities, timeout/restart reconciliation, exact caps, and ops clamping exist. Reviewed metrics, fee-on-transfer coverage, full route fixtures, canaries, and certification remain open. | Complete reviewed samples and the missing fixture cases, remove premature operator allowlisting, then collect canary/restart evidence and independent review. |
| Polymarket execution and certification | G3-P3, G3-P5-G3-P6, F-PM5, F-PM7-F-PM8, G3-P10-G3-P12 | Official SDK/Polygon/startup attestation, pUSD/onramp readiness, bounded approvals, depth walking, proportional FAK sells, confirmed partials, fees, and delayed reconciliation are implemented. Atomic market-state refresh, distinct mined state, complete neg-risk/redemption tests, authenticated canaries, and review remain open. | Finish the remaining state/test contracts, then collect authenticated account, order, cancellation, duplicate, balance, eligibility, and reviewer evidence. |
| Shadow execution | M14, G4-S2, G4-S7 | Live-first independent shadow persistence, fill-based cost reporting, isolation, and exclusions are implemented. Polygon paper pricing still uses a top-of-book price instead of a size-aware depth walk; same-observation snapshots and simultaneous three-chain acceptance are also open. | Reuse the depth planner for Polygon simulation, persist one immutable pre-submit quote snapshot per mode pair, and run a mixed-mode three-chain acceptance fixture. |
| Risk enforcement | G5-R1, G5-R7, L17 | Balance caps, rolling exposure, deduplicated alerts, gas reserves, kill switch, and persisted per-chain breaker/probe leasing are implemented. The executor does not consume the database `trading.max_position_pct`, and stop-loss plus multi-process restart/isolation acceptance remain open. | Resolve the hot database risk policy before sizing, define one enforced stop-loss contract, and add process-level risk restart/isolation tests. |
| Attribution and cross-chain scoring | G6-A6-G6-A7, G6-A9-G6-A10 | Resolution-aware wallet math, chain/mode outcomes, expectancy, persisted reports, dashboard data, alerts, and latency percentiles exist. Redemption, Polygon-weight golden coverage, immutable threshold justification, and per-score chain evidence remain open. | Add redemption settlement, golden scoring vectors, database-linked threshold approvals, and API/dashboard chain-evidence breakdowns. |
| Automated and release acceptance | G7-T1-G7-T2, G7-T5, F-ACC1-F-ACC4, G7-A1-G7-A9, final gates | Real package/unit/integration tests and CI infrastructure exist. Full production-worker, chaos, external KPI, certification, artifact cleanup, and manual acceptance evidence remain absent. | Complete the inline partial test gaps, run chaos and simultaneous pipelines, clean generated artifacts, and collect measured reviewer-approved evidence. |

## Phase 0 - Finish the Foundation

**Exit gate:** all remaining audit defects that can corrupt data, expose an unsafe API, lose jobs, or invalidate scoring are fixed. Audit items explicitly owned by later execution phases remain open until those phases.

### Live-Money and Data Repairs

- [x] **C-T1** Disable unsafe Robinhood live swaps until verified router execution exists.
- [x] **C-T2** Disable fabricated Polymarket fills until signed CLOB execution exists.
- [x] **C-T3** Parse `TRADING_MODE` strictly and require exact live opt-in.
- [x] **C-I1** Add and use `polymarket_markets.updated_at`.
- [x] **C-I2** Authenticate and parse Helius webhooks against supported payloads.
- [x] **C-I3** Strip storage prefixes before Solana and Robinhood backfills.
- [x] **C-I4** Store Polymarket condition IDs unprefixed and preserve foreign keys.
- [x] **C-S1** Strip prefixes before chain RPC/API safety checks and remain fail-closed.
- [x] **C-S2** Require three distinct wallets for snipe detection.
- [x] **C-S3** Deduplicate accumulation signals across the seven-day window.
- [x] **H1** Never size above the available chain balance.
- [x] **H2** Use actual token decimals for Jupiter paper fills.
- [x] **H3** Use a chain-correct native price for Robinhood trades.
- [x] **H4** Add Trojan timeout, idempotency, and bounded retry behavior.
- [x] **H5** Release failed execution claims to `pending`.
- [x] **H6** Classify token-to-USDC and token-to-token exits as sells.
- [x] **H7** Convert Polymarket Unix seconds to JavaScript milliseconds.
- [x] **H8** Store funding relationships with chain-prefixed addresses.
- [x] **H9** Upsert SOL before persisting sell transactions.
- [x] **H10** Upsert the EVM native-token placeholder before native swaps.
- [x] **H11** Store EVM raw amounts beyond PostgreSQL `BIGINT`.
- [x] **H12** Make USD backfill prefix-aware.
- [x] **H13** Persist cluster performance during scoring.
- [x] **H14** Normalize blacklist comparisons.
- [x] **H15** Stop rerun migrations from overwriting operator configuration.
- [x] **H17** Prefix wallet history and holdings queries correctly.
- [x] **H18** Delete wallets and dependent records transactionally.
- [x] **H19** Prefix token mints in inline discovery queries.
- [x] **M7** Reject manual execution without a token and preserve cluster tier.
- [x] **M8** Propagate post-fill persistence failures for reconciliation.
- [x] **M10** Make the current circuit breaker time-correct and delay blocked work.
- [x] **M11** Reject unknown live-execution chains.
- [x] **M15** Calculate holder concentration against total supply.
- [x] **M16** Preserve wallets with open positions during pruning.
- [x] **M17** Isolate scorer post-processing stages.
- [x] **M18** Await every signal detector before releasing the tick guard.
- [x] **M19** Isolate queue failures per detected signal.
- [x] **M22** Preserve chain identity for discovered counterparties.
- [x] **M28** Normalize EVM address casing on every write path.
- [x] **M29** Reject mismatched and nested chain prefixes.
- [x] **M30** Enforce prefixed asset identifiers when inserting trades.
- [x] **M32** Claim only `pending` signals.
- [x] **M33** Chunk EVM scans, fix metadata/pricing inputs, and remove fabricated safety flags.
- [x] **M35** Stop migration 010 from rebuilding the dedupe index on every run.
- [x] **L1** Reject invalid signal scores and auto-execute thresholds.
- [x] **L4** Persist truthful slippage values for each execution path.
- [x] **L5** Keep Robinhood live disabled while chain/router assumptions are unverified.
- [x] **L6** Exclude null target assets from signal detection.
- [x] **L8** Determine the safety-check chain from the prefixed asset.
- [x] **L13** Align signal status types with the real lifecycle.
- [x] **L21** Exclude EVM self-transfers and ERC-721 transfers from swap inference.

### Discovery and Backfill

- [x] **G0-D1 / M20** Honor token-seeded discovery payloads and remove duplicate generic runs.
- [x] **G0-D2 / M21** After every discovered-wallet upsert, enqueue `swat-backfill-wallet` with raw address, resolved chain, and deterministic `backfill-${chain}-${rawAddress}` job ID.
- [x] **G0-D3 / M23** Route scheduled discovery through the same in-flight guard as manual runs.
- [x] **G0-D4 / M34** Preserve the existing wallet discovery method during webhook and discovery upserts.
- [x] **G0-D5 / H24** Page starter-pack signatures back to the actual token launch window.
- [x] **G0-D6 / M38** Search enough history to find starter-pack funding transactions.
- [x] **G0-D7 / M39** Compute starter-pack win rate from complete wins and losses.
- [x] **G0-D8 / L23** Accept chain-aware seed wallets and clamp Helius signature limits.
- [x] **G0-D9 / L27** Exclude pool/program addresses and require valid token-age metadata.
- [x] **G0-D10 / L28** Resolve scorer fixture paths robustly and validate input type and chain.
- [x] **G0-D11** Dev acceptance: insert one discovered wallet per supported chain, observe one deduplicated backfill job, and verify resulting transaction rows.

Verification on 2026-07-16: discovery runner tests 3/3, shared queue/address tests 16/16, indexer tests 27/27, PostgreSQL upsert preservation and cleanup confirmed, workspace typecheck 11/11, workspace test tasks 11/11 (64 Vitest assertions), and production build 11/11.

Verification on 2026-07-19: launch/funder pagination now proves the oldest boundary or fails closed at the cap, including an exact-cap probe; starter-pack outcomes include completed wins and losses; startup and file-based wallet seeds preserve explicit chain identity and reject ambiguous EVM input; Helius signature limits are bounded to 1-1000. Focused shared tests 22/22, indexer tests 30/30, scorer tests 4/4, indexer/scorer/tool typechecks, workspace typecheck 11/11 plus the standalone tool, workspace test tasks 11/11 (77 Vitest assertions), and production build 11/11 all passed.

Verification on 2026-07-25: `pnpm acceptance:g0-d11` used a run-specific queue and the production processor to deduplicate two enqueues for each chain, complete one Solana, Polygon, and Robinhood Chain backfill, and verify all three transaction rows. Cleanup force-obliterated the isolated queue and asserted zero fixture rows before closing PostgreSQL. An independent probe confirmed zero `*acceptance-g0d11*` Redis keys and zero G0-D11 transaction, wallet, and token fixtures. Indexer tests passed 38/38; indexer typecheck and build passed.

### Ingestion Health

- [x] **G0-H1** Add an idempotent `ingestion_health` schema keyed by chain with last event/batch times and inserted, skipped, and failed counters.
- [x] **G0-H2** Update health atomically from Solana backfill/webhook, Polymarket Data API, and Robinhood EVM batches, including failed batches.
- [x] **G0-H3** Add `GET /v1/health/ingestion` with per-chain lag, 24-hour counts, and insert/skip ratio.
- [x] **G0-H4** Send a distinct Telegram ops alert when lag exceeds Solana 5 minutes, Polygon 10 minutes, or Robinhood 15 minutes; target Polygon ingestion lag below 5 minutes, deduplicate alerts, and send recovery notices.
- [x] **G0-H5** Expose ingestion state on the dashboard without treating an empty dataset as healthy.
- [x] **G0-H6** Add tests for counter updates, lag calculation, threshold boundaries, alert dedupe, and recovery.

Verification completed 2026-07-20: all migrations through `015_audit_schema_repairs.sql` replayed successfully twice; a temporary PostgreSQL batch produced exact 24-hour deltas of 2 inserted, 1 skipped, and 1 failed before cleanup restored prior state. A live alert-state probe confirmed one stale alert, deduplication, one recovery, and final `healthy` state before restoring the prior row; missing Telegram credentials now release the reservation instead of recording false delivery. The authenticated ingestion-health API returned Solana, Polygon, and Robinhood Chain with correct thresholds and classified missing events as `empty`. Workspace tests passed 11/11 tasks with 90 Vitest assertions, including shared 25/25, database 11/11, indexer 34/34, and alert-service 3/3; workspace typecheck passed 11/11 plus root tools, and production build passed 11/11.

Verification completed 2026-07-25: both dashboard ingestion surfaces now consume `/v1/health/ingestion`, preserve one fail-closed row per supported chain, and refresh every 30 seconds. The current authenticated response returned HTTP 200 and classified Solana, Polygon, and Robinhood Chain as `empty`; the UI renders that state as no data and treats API failures as unavailable. Web typecheck and production build passed, `/workspace` returned HTTP 200, and a stale-value scan found none of the removed mock ingestion metrics.

### Data, Scoring, and Infrastructure

- [x] **M24** Add PostgreSQL pool error handling, connection/query timeouts, and shutdown behavior.

Verification on 2026-07-20: database runtime tests passed 6/6 for bounded configuration, idle-client error handling, idempotent close, clean shutdown, close failure, and shutdown timeout. Migrations replayed successfully through `015_audit_schema_repairs.sql`; a real `pg_sleep(2)` query under `DB_QUERY_TIMEOUT_MS=1000` failed with `Query read timeout` after 1.09 seconds, and a connected child process closed the pool and exited 0 on `SIGINT`. Database tests passed 17/17; workspace typecheck passed 11/11 plus root tools, workspace tests passed 11/11 tasks with 96 Vitest assertions, and production build passed 11/11.

- [x] **M25** Serialize logger arguments safely when values are circular or non-JSON.

Verification completed 2026-07-22: focused logger tests passed 4/4 for circular references, `BigInt`, errors, functions, getters/custom inspectors, revoked proxies, truncation, and safe console-to-Redis publication. On 2026-07-20, shared tests passed 29/29, workspace typecheck passed 11/11 plus root tools, and workspace tests passed 11/11 tasks with 100 Vitest assertions. The current production build passed 11/11 on 2026-07-22, including all nine Next.js routes.

- [x] **M26** Filter DexScreener results by the requested chain before selecting liquidity.

Verification completed 2026-07-22: shared pricing now maps `solana -> solana`, `polygon -> polygon`, and `robinhood-chain -> robinhood`, filters before selecting the highest-liquidity pair, and applies the same selector to price, metadata, and signal-safety liquidity lookups. Bare Solana mints remain supported while raw EVM addresses require an explicit chain. Six mocked-fetch regressions cover wrong-chain liquidity collisions, missing chain matches, metadata selection, Robinhood filtering, Solana compatibility, and ambiguous EVM input. Shared tests passed 35/35; affected package builds and typechecks passed; workspace tests passed 11/11 tasks with 106 Vitest assertions; workspace typecheck passed 11/11 plus root tools; and the production build passed 11/11, including all nine Next.js routes.

- [x] **M27** Use a verified Robinhood Chain price source instead of Solana CoinGecko routes.

Verification completed 2026-07-22: canonical Robinhood stock tokens now resolve through Robinhood's official asset registry and live bid/ask API, requiring an active chain-4663 deployment, a matching contract, an unhalted quote no older than two minutes, and multiplier-adjusted midpoint pricing. The asset registry is cached for five minutes. Non-stock tokens fall back only to chain-filtered DexScreener; Robinhood pricing now returns `null` when neither source succeeds and never routes through CoinGecko's Solana platform. Live read-only probes of the registry and CRWD quote returned HTTP 200 with the expected schema, and the built helper returned a positive multiplier-adjusted price. Shared tests passed 36/36; workspace tests passed 11/11 tasks with 107 Vitest assertions; workspace typecheck passed 11/11 plus root tools; and the uncached production build passed 11/11, including all nine Next.js routes.

- [x] **M31** Treat only completed sell quantities as closing a position.

Verification completed 2026-07-22: open-position mark-to-market now excludes a position only when a matching sell has `status = 'filled'`; pending, failed, rejected, or otherwise incomplete sell attempts no longer hide the holding. A query-contract regression locks both filled-buy and filled-sell requirements. Database tests passed 18/18. A rollback-only PostgreSQL transaction confirmed that a failed sell leaves the filled buy open and changing that sell to filled closes it, with no verification rows retained. Workspace tests passed 11/11 tasks with 108 Vitest assertions; workspace typecheck passed 11/11 plus root tools; and the production build passed 11/11, including all nine Next.js routes.

- [x] **L9** Normalize PostgreSQL numeric strings at application boundaries.

Verification completed 2026-07-22: node-postgres now installs precision-aware parsers for `INT8` and `NUMERIC`. Safe counts, scores, percentages, USD metrics, slots, and ordinary aggregates arrive as JavaScript numbers, while unsafe integers and decimals with more than 15 significant digits remain exact strings. Explicit `::text` contracts and large on-chain quantities therefore retain precision instead of being blindly passed through `Number`. Parser tests cover safe, unsafe, fractional, malformed, and registration cases; database tests passed 22/22. A live PostgreSQL probe confirmed signal-style metrics and all `getWalletStats` counts are numbers, while unsafe `BIGINT`, high-precision decimal, and `10^18` exact amounts remain strings. Workspace tests passed 11/11 tasks with 112 Vitest assertions; workspace typecheck passed 11/11 plus root tools; and the production build passed 11/11, including all nine Next.js routes.

- [x] **L10** Remove stale cluster memberships during cluster regeneration.
- [x] **L11** Calculate early-entry ratios only when launch metadata exists.
- [x] **L12** Apply quantity-aware cost basis and realized P&L to partial sells.
- [x] **L14** Standardize UTC timestamp parsing, storage, and comparison semantics.
- [x] **L15** Infer supported EVM chains where unambiguous; never silently classify unknown EVM data as Solana.
- [x] **L18** Serialize migrations with an advisory lock and per-file transactions.
- [x] **L19** Limit signal dedupe checks to the intended active lifecycle states.
- [x] **L20** Handle missing block times without inventing launch-window order.
- [x] **L29** Reconcile all environment-variable documentation with runtime names and defaults.
- [x] **L30** Make scripts and Compose honor configured hosts, ports, and service lifecycle.
- [x] **L31** Remove the unused `SOL_MINT` price constant.

### API, Web, Alerts, and MCP

- [x] **H16** Authenticate SSE without URL-secret leakage and call Fastify `reply.hijack()`.
- [x] **H20** Guard nullable trade token mints on the performance page.
- [x] **H21** Query real wallet score columns and resolve prefixed wallet addresses in MCP.
- [x] **H22** Query the actual signal/trade lifecycle and schema in MCP performance.
- [x] **H23** Escape every dynamic Telegram HTML value.
- [x] **M1** Align wallet dashboard fields with the API response contract.
- [x] **M2** Normalize nullable performance aggregates to zero.
- [x] **M3** Use one documented web API-key configuration path.
- [x] **M4** Strip storage prefixes from display text and external links.
- [x] **M5** Validate route params/bodies and return stable public errors without database details.
- [x] **M6** Resolve token lookups through prefixed storage keys.
- [x] **M12** Generate chain-correct, unprefixed explorer and market links.
- [x] **M13** Add error listeners to every BullMQ worker and queue event stream.
- [x] **M36** Track MCP SSE transports per session and clean them up on disconnect.
- [x] **M37** Forward rejected async Express handlers to error middleware.
- [x] **L2** Respect Telegram `retry_after`, bound retries, and enforce message limits.
- [x] **L3** Set alert state only after successful delivery or roll back the claim.
- [x] **L24** Stabilize React keys, malformed-log handling, retry cleanup, and wallet error state.
- [x] **L25** Correct API ignore/log parsing behavior and route ordering.
- [x] **L26** Validate MCP limits and make blacklist mutation concurrency-safe.

## Phase 1 - Per-Chain Control and Canonical Execution

**Depends on:** Phase 0 exit gate.

**Exit gate:** one executor safely handles independent `off`, `paper`, `live`, and `live+shadow` modes, while a canonical event/position lifecycle prevents duplicate or unsupported execution.

### Execution Mode Matrix

- [x] **G1-M1** Add shared `ExecutionMode` and `ExecutionConfig` types for all three chains.
- [x] **G1-M2** Implement a fail-closed parser for `off|paper|live|live+shadow`, including tested legacy `TRADING_MODE` mapping.
- [x] **G1-M3** Add idempotent, seed-once migration `017_execution_config.sql` with paper defaults.
- [x] **G1-M4** Resolve mode per job from DB config cached for at most 30 seconds, then chain env fallback, legacy mode, and finally paper.
- [x] **G1-M5** In `off`, skip without claiming; in `paper`, simulate; in `live`, route to a certified executor; in `live+shadow`, persist live and shadow independently.
- [x] **G1-M6 / F-CORE8** Enforce `LIVE_ENABLED_CHAINS`; clamp uncertified live modes to paper with an explicit warning and reason.
- [x] **G1-M7** Add `GET /v1/trading/status` returning requested mode, effective mode, certification, and clamp reason per chain.
- [x] **G1-M8** Add dashboard controls/status for the exact effective matrix and an all-chain emergency-off action.
- [x] **G1-M9** Test parser failures, precedence, cache expiry, clamp logic, hot changes, and concurrent jobs on different chains.

### Canonical Copy-Trade Lifecycle

- [x] **F-CORE1** Persist immutable source-trade events keyed by chain plus transaction hash/order ID, with wallet, asset, side, quantity, price, timestamp, and confirmation state.
- [x] **F-CORE2** Track per-wallet, per-asset positions across entries, transfers, partial reductions, full exits, duplicates, and out-of-order events.
- [ ] **F-CORE3** Add selected-wallet/cluster copy policy with stale-event, minimum activity, liquidity, exposure, and chain-native safety gates. **PARTIAL** - canonical stale-event/position checks, cluster evidence, exposure, and chain safety exist, but one explicit minimum-activity/selected-wallet policy is not enforced at the canonical claim boundary.
- [x] **F-CORE4 / L7** Convert a source-wallet reduction into a proportional sell capped by SWAT's confirmed available balance; never sell an unheld asset.
- [x] **F-CORE5** Route chain-native BUY and SELL jobs with stable client order IDs, bounded retries, simulation, and explicit terminal/ambiguous states.
- [x] **F-CORE6** Persist requested, submitted, partially filled, confirmed, failed, cancelled, and reconciliation-required execution states.
- [ ] **F-CORE7** Reconcile balances, orders, and ambiguous submissions at startup and on a periodic schedule. **PARTIAL** - Trojan and Robinhood startup/periodic reconciliation and Polymarket periodic order reconciliation exist; one system-wide balance reconciliation pass for every canonical ambiguous execution is not demonstrated.
- [x] **G1-C1** Mark copied positions only from confirmed quantities and link each execution to its immutable source event.
- [x] **G1-C2** Add schema constraints and tests proving duplicate source events and worker retries cannot create duplicate executions.

### Solana Operational Gate

- [x] **F-SOL1** Prove Helius webhook and backfill paths emit the same canonical BUY/SELL event for SOL, USDC, and supported token-to-token routes.
- [ ] **F-SOL2** Confirm Trojan BUY and proportional SELL submissions using a stable signal ID, returned transaction identity, chain confirmation, actual balances, and truthful failure/timeout states. **PARTIAL** - the runtime and reconciliation state machine are implemented and tested, but authenticated production confirmation and balance reconciliation evidence is absent.
- [ ] **F-SOL3** Replay entry, partial exit, full exit, failed trade, duplicate webhook, and timeout-after-submit fixtures; then record a deliberately capped live canary. **PARTIAL** - lifecycle/retry fixtures exist; the complete fixture matrix and live canary do not.
- [x] **L16** Remove unsafe Jupiter decimal defaults and apply direction-correct ExactIn/ExactOut thresholds to paper and shadow quotes.
- [ ] **G1-S1** Measure webhook event to signal, alert, and execution timestamps; retain the Solana median signal-to-alert target below 60 seconds. **PARTIAL** - timestamps and p50/p95 reporting exist, but the Solana production target has not been measured over a review window.
- [x] **G1-S2** Do not treat existing Solana live capability as certified until the canary and reconciliation evidence are recorded.

## Phase 2 - Robinhood Chain Live Executor

**Depends on:** Phase 1 lifecycle and Robinhood ingestion correctness.

**Exit gate:** `robinhood-chain` enters `LIVE_ENABLED_CHAINS` only after a receipt-verified tiny trade, failure test, and restart reconciliation.

### Startup and Route Verification

- [x] **F-RH1** Read chain ID and router/quoter/WETH9 addresses from configuration; verify chain ID and deployed bytecode before enabling live.
- [x] **G2-R1** Run a known-liquid sanity quote across configured Uniswap fee tiers and clamp to paper plus an ops alert on failure.
- [x] **G2-R2** Log the verified chain/router/quoter/WETH9 tuple without exposing signer material.

### Ingestion and Safety

- [x] **F-RH2** Replace transfer-only inference with router/pool/receipt decoding that rejects self-transfers, ERC-721s, airdrops, and ordinary transfers.
- [ ] **G2-R3** Validate direction-classification accuracy above 95% on a reviewed fixture/sample set. **PARTIAL** - classification metrics and fail-closed fixture assertions exist, but no sufficiently sized operator-reviewed production sample proves the threshold.
- [ ] **G2-R4** Expose inserted/skipped completeness and require greater than 90% on the certification sample. **PARTIAL** - ingestion counters and completeness calculations exist, but no reviewed certification sample proves greater than 90%.
- [ ] **G2-R5** Implement EVM-native pre-trade safety checks, including sell simulation, ownership/admin powers, liquidity, verification, and holder concentration where reliable data exists. **PARTIAL** - exact simulation, owner/admin and liquidity checks exist; verified-source and reliable holder-concentration evidence is not complete for Robinhood assets.

### Buy, Sell, and Reconciliation

- [ ] **F-RH3** Discover liquid entry/exit routes and pin the deployed router ABI/version verified on Robinhood Chain. **PARTIAL** - configured fee-tier discovery and typed ABI/version validation exist, but the deployed tuple has no reviewed production certification evidence.
- [x] **G2-R6** Quote configured fee tiers, derive `minOut` from bounded slippage, and skip honestly when no route exists.
- [x] **G2-R7** Encode real typed swap calldata and simulate the exact transaction before signing.
- [x] **F-RH4** Implement quote-sign-submit, gas/value checks, exact allowances or Permit2 where supported, receipt status checks, decoded actual amounts, and balance reconciliation.
- [x] **G2-R8** Persist no-route and simulation failures as non-fill skips; persist RPC failures, reverts, and ambiguous confirmations distinctly.
- [x] **G2-R9** On receipt timeout, store the hash as `pending_confirmation`; sweep for 10 minutes without resubmitting the same client order.
- [ ] **F-RH5** Execute proportional exits into the configured base asset, capped to actual token balance, with fee-on-transfer/no-route/high-impact handling. **PARTIAL** - source-derived proportional exits, exact balance caps, no-route, simulation, and slippage handling exist; explicit fee-on-transfer exit coverage is missing.
- [x] **G2-R10** Keep gas reserves untouched and cap estimated fees; preserve concurrency/nonce correctness.

### Robinhood Verification

- [ ] **F-RH6** Test native/token and token/token entry/exit, duplicate logs, no-route, simulation revert, reverted receipt, timeout, restart, and reconciliation. **PARTIAL** - entry/exit, route, revert, timeout, receipt, and restart cases exist, but the full native/token plus token/token matrix is not covered.
- [x] **G2-R11** Add a golden-vector calldata encoding test for the certified router ABI.
- [ ] **G2-R12** Record a tiny successful buy with receipt-derived amounts, a forced failure with released claim, and an orphaned receipt resolved after restart. **EXTERNAL EVIDENCE** - mocked/runtime tests are not a production canary record.
- [ ] **G2-R13** Add `robinhood-chain` to `LIVE_ENABLED_CHAINS` only after `docs/certification/robinhood-chain.md` is reviewed. **EXTERNAL EVIDENCE** - the premature allowlist entry is gone: `.env:128` is `LIVE_ENABLED_CHAINS=` (empty, verified 2026-07-30). Remaining work is the reviewed certification document and canary evidence, not an env change.

## Phase 3 - Polymarket Live CLOB Executor

**Depends on:** Phase 1 lifecycle, verified market/outcome mapping, operator eligibility, and current Polymarket CLOB V2 documentation.

**Exit gate:** Polygon enters `LIVE_ENABLED_CHAINS` only after authenticated production canaries and order-state reconciliation.

### Canonical Market Data

- [x] **F-PM1** Ingest confirmed Data API trades using `proxyWallet`, asset/token ID, condition ID, side, size, price, timestamp, and transaction hash; do not infer fills from generic activity.
- [x] **F-PM2 / L22** Model positions by full outcome token ID and map each to market, outcome, tick size, neg-risk state, end date, and resolution status without truncated-symbol matching.
- [x] **G3-P1** Ensure every Polygon signal includes market question, outcome, end date, and current market state.
- [x] **G3-P2** Add ingestion-lag and context-coverage assertions; require 100% market context on certification fixtures.

Verification completed 2026-07-26: confirmed-trade parsing and backfill tests preserve the Data API proxy and full asset ID, reject activity-shaped or incomplete rows, and refuse mismatched market mappings. The normalized database contract stores exact source trades and token-indexed outcomes; the signal helper fails closed unless all required market fields are present. Migration `026_polymarket_context.sql` replayed successfully twice. The cleaned PostgreSQL acceptance persisted one source trade, one derived transaction, and two outcomes with 100% context coverage and 30-second lag; duplicate source and derived writes were rejected, and an independent exact-identity probe found zero remaining rows. Focused database, indexer, and signal tests passed 57/57, 54/54, and 2/2; all 11 workspace test, typecheck, and build tasks passed.

### Authentication and Collateral

- [x] **F-PM3** Verify and pin the official production CLOB V2 client and Polygon chain ID 137; configure explicit signer, funder/proxy, signature type, and authenticated API credentials.
- [ ] **G3-P3** Derive or load CLOB API credentials without logging secrets and validate them with an authenticated round trip. **EXTERNAL EVIDENCE** - credential derivation/loading and startup checks are implemented, but no credentialed production round-trip evidence is recorded.
- [x] **F-PM4 / M9** Size from available pUSD with 6-decimal handling; implement and verify the current USDC.e-to-pUSD onramp/allowance path where required.
- [x] **G3-P4** Attest current CLOB, exchange, collateral, and proxy contracts from official sources at startup; clamp to paper on mismatch.
- [ ] **G3-P5** Confirm operator account, jurisdiction, venue terms, and wallet funding are eligible before any production order. **EXTERNAL EVIDENCE** - this requires operator/legal/account review and funded-wallet inspection.

### Orders and Reconciliation

- [ ] **F-PM5** Re-read the book for each source BUY and reject stale, closed, resolving, paused, thin, near-certain, or excessive-deviation markets. **PARTIAL** - each order gets a fresh timestamped depth walk with thin-book, price, and slippage bounds; current market closure/resolution/pause context is not reloaded atomically with every submission.
- [ ] **G3-P6** Walk ask depth, calculate a marketable limit, round price/size to venue rules, and use `signalId` as the stable client order ID. **PARTIAL** - depth walking and downward size/price constraints exist; idempotency uses the persisted signal/canonical identity because the installed SDK order contract has no explicit client-order-ID field.
- [x] **G3-P7** Check existing orders before posting so timeout retries cannot double-buy.
- [x] **F-PM6** Place proportional SELL orders for the exact outcome token, capped to available confirmed shares, and reconcile/cancel unfilled remainder.
- [ ] **F-PM7** Treat submitted, matched, mined, partial, confirmed, failed, cancelled, and ambiguous orders distinctly; only confirmed quantities create fills. **PARTIAL** - submitted, terminal fill/partial, failed, cancelled, and ambiguous states are distinct and only confirmed trades create quantities; intermediate `matched` versus `mined` trade states are both retained as pending rather than persisted distinctly.
- [x] **G3-P8** Poll boundedly, cancel timed-out remainders, and send unresolved cancellation/order states to a sweeper without duplicate submission.
- [x] **G3-P9** Persist CLOB order ID, actual filled size, average price, fees, and settlement identity; never synthesize a transaction signature.

### Polymarket Verification

- [ ] **F-PM8** Test binary and neg-risk markets, partial entry/exit, duplicate trades, resolution/redemption, thin books, and restart reconciliation. **PARTIAL** - partial/full/cancelled/ambiguous reconciliation, duplicates, and thin books are tested; the complete binary/neg-risk entry-exit plus resolution/redemption matrix is not.
- [ ] **G3-P10** Round shares/prices downwards and limit risk exactly per exchange UI constraints. **PARTIAL** - floor-based shares, tick-grid validation, balance caps, and price bounds are tested; exact parity with all current venue UI precision cases is not demonstrated.
- [ ] **G3-P11** Record a tiny filled BUY, an unfillable order that cancels cleanly, and a duplicate-client-ID rejection. **EXTERNAL EVIDENCE** - unit tests are not authenticated production order records.
- [ ] **G3-P12** Add `polygon` to `LIVE_ENABLED_CHAINS` only after `docs/certification/polygon-polymarket.md` is reviewed. **EXTERNAL EVIDENCE** - no reviewed certification document or active certification row exists.

## Phase 4 - Paper and Live+Shadow

**Depends on:** Phase 1 modes; each live path may shadow only after that chain is certified.

**Exit gate:** paper simulation is meaningful on all chains and shadow rows cannot affect positions, exposure, cooldown, or reported trading P&L.

- [x] **G4-S1** Add idempotent migration `018_shadow_trades.sql` with `execution_mode='shadow'` support and `shadow_of` trade linkage.
- [ ] **M14** Persist meaningful Polygon outcome quantities/prices from an orderbook walk and Robinhood quantities/prices from a verified quoter simulation. **PARTIAL** - Robinhood uses the verified quoter and Polygon persists quantities/prices, but Polygon paper simulation uses one best-side price rather than walking depth for the requested size.
- [ ] **G4-S2** Run Solana Jupiter, Polymarket book-walk, and Robinhood quoter simulators from the same size and observation time as the live order. **PARTIAL** - all three simulators exist and use the selected size, but one immutable pre-submit observation is not shared with every live path.
- [x] **G4-S3** In `live+shadow`, persist the live trade first, then an independently failing shadow row linked to it.
- [x] **G4-S4** Exclude shadow rows from balances, positions, exposure, cooldown, win rate, realized P&L, and portfolio APIs.
- [x] **G4-S5** Report per-chain live-versus-shadow execution cost in basis points using actual live fills.
- [x] **G4-S6** Test shadow simulator failure after a confirmed live fill and prove the live trade remains committed.
- [ ] **G4-S7** Support legal concurrent combinations such as Solana `live+shadow`, Polygon `paper`, and Robinhood `live` in one worker process. **PARTIAL** - per-chain mode resolution and concurrent worker execution exist; a simultaneous three-chain production-worker acceptance run is absent.

## Phase 5 - Enforced Risk Controls

**Depends on:** canonical execution states and per-chain modes.

**Exit gate:** every paper and live order is checked before claim/submission, failures are isolated per chain, and emergency-off takes effect within 30 seconds.

- [ ] **G5-R1** Enforce per-trade `maxPositionPct` against live balance or `PAPER_BANKROLL_USD` (default USD 10,000) in paper mode. **PARTIAL** - balance-aware sizing and the USD 10,000 paper bankroll are enforced, but executor sizing reads environment percentages (`apps/trade-executor/src/index.ts:341-370`) and does not consume the hot database `trading.max_position_pct`, which is read only by `apps/api/src/attribution-routes.ts:43` for reporting. No `resolveRiskPolicy` exists in the repo. See S0.4.
- [x] **G5-R2** Enforce per-chain rolling 24-hour exposure and emit one deduplicated daily-cap alert.
- [ ] **G5-R3** Upgrade the circuit breaker to persisted, per-chain `{consecutiveFailures,trippedAt}` state that trips on the Nth failure and resets on success. **PARTIAL - reopened 2026-07-30 under Builder Guide Standing Rule 2.** The implementation is complete and durable as an audit item, but state is keyed `breaker:${chain}` (`packages/db/src/circuit-breaker.ts:33`) with no account dimension. Builder Guide Standing Rule 2 requires `(account, chain)`, and the schema already supports it via `target_account` in migration `028`. Re-key before any further risk or execution work builds on breaker state. See S0.3.
- [x] **G5-R4** Delay blocked BullMQ jobs by five minutes instead of completing or dropping them.
- [x] **G5-R5** Honor an all-chain `{"*":"off"}` kill switch within one execution-config cache TTL.
- [x] **G5-R6** Reserve configured native gas balances and size down or skip rather than flooring upward.
- [ ] **L17** Align stop-loss defaults across runtime, database config, environment docs, and alerts. **NOT BUILT** - the old environment knob was removed, but no single enforced runtime/database/alert stop-loss policy replaces it.
- [ ] **G5-R7** Test cap boundaries, breaker transitions/restart persistence, chain isolation, kill-switch latency, and gas-floor behavior. **PARTIAL** - cap, gas floor, breaker persistence/lease, and kill-switch tests exist; full multi-process restart/chain-isolation acceptance is not demonstrated.

## Phase 6 - Attribution and Learning Loop

**Depends on:** canonical fills, quantity-aware P&L, and shadow exclusion.

**Exit gate:** every actionable signal can be traced to outcome, execution quality, and latency; reports show whether each chain/pattern/tier has positive expectancy.

- [x] **G6-A1** Verify or implement five-minute price snapshots required for 1-hour and 24-hour mark-to-market attribution.
- [x] **G6-A2** Add an idempotent `signal_outcomes` schema linking signal, pattern, chain, cluster, tier, mode, entry, P&L horizons, realized P&L, and hit result.
- [x] **G6-A3** Run nightly attribution after scoring/clustering and exclude shadow rows from trading outcomes.
- [x] **G6-A4** Calculate count, hit rate, average win, average loss, and expectancy by pattern, tier, chain, and mode.
- [x] **G6-A5** Persist the expectancy report, expose it in the dashboard beside manual thresholds, and send a daily Telegram digest.
- [ ] **G6-A6** Detect Polymarket resolution/redemption, backfill realized outcomes, and calculate wallet win rate from resolved markets. **PARTIAL** - market resolution, winning-token backfill, and resolution-aware wallet P&L/win rate exist; redemption detection and reconciliation are missing.
- [ ] **G6-A7** Add resolution-derived Polymarket skill to composite scoring with an explicit tested weight. **PARTIAL** - Polygon uses a 50% resolution-aware win-rate weight, but no golden test asserts the Polygon-specific weight and resolved-market contribution end to end.
- [x] **G6-A8** Persist `detected_at`, `alerted_at`, `submitted_at`, `confirmed_at`, and report p50/p95 chain latency.
- [ ] **G6-A9** Keep threshold changes manual and require the expectancy report as recorded justification. **PARTIAL** - a manual script records free-text justification, but it does not validate/store a specific immutable `expectancy_reports` record as a database-enforced prerequisite.
- [ ] **G6-A10** Preserve chain identity in cross-chain clustering and expose each score's per-chain evidence without conflating unrelated addresses. **PARTIAL** - chain-qualified wallets and cluster chain storage exist; the dashboard/API does not expose a complete per-chain evidence breakdown for each score.

## Phase 7 - System Acceptance and Release

**Depends on:** all preceding phase gates.

**Exit gate:** the definition of done in `gaol.md` is demonstrated, not inferred.

### Automated Verification

- [ ] **G7-T1** Add focused regression tests for every audit and goal data contract where practical. **PARTIAL** - every package now has real tests and high-risk contracts have focused suites, but several broad acceptance and external contracts below remain uncovered.
- [ ] **G7-T2** Add per-chain Docker integration fixtures: seed wallet -> backfill -> transactions -> signal -> paper trade -> attribution. **PARTIAL** - PostgreSQL canonical lifecycle fixtures are chain-parameterized, but they do not run all production workers from seed/backfill through attribution for each chain.
- [x] **G7-T3** Add `pnpm test:integration` and run it in CI with PostgreSQL and Redis.
- [x] **G7-T4** Unit-test execution config, Robinhood calldata, Polymarket rounding, risk math, breaker state, and reconciliation idempotency.
- [ ] **G7-T5** Run chaos checks for executor death after submit, Redis restart, PostgreSQL restart, and worker reconnection. **NOT BUILT** - no automated infrastructure fault-injection suite was found.

### Functional Acceptance

- [ ] **F-ACC1** Replay end-to-end signal pipelines for Solana, Polygon, and Robinhood chains simultaneously. **EXTERNAL EVIDENCE** - isolated/integration paths exist, but no simultaneous production-worker replay is recorded.
- [ ] **F-ACC2** Prove that an infrastructure failure in one executor (e.g. Robinhood rpc offline) does not stall or corrupt Solana and Polymarket pipelines. **EXTERNAL EVIDENCE** - unit-level reconciliation isolation is tested; process/infrastructure acceptance is not.
- [ ] **F-ACC3** Verify environment prerequisites: Postgres, Redis, API keys (Helius, Robinhood API, Polymarket CLOB), funding wallets. **EXTERNAL EVIDENCE** - local Postgres/Redis are healthy; production credentials and wallet funding were not inspected.
- [ ] **F-ACC4** Manually reconcile balances, positions, transaction/order IDs, fees, P&L, and shadow comparison before declaring three-chain live execution functional. **EXTERNAL EVIDENCE** - requires authenticated venue/chain records and operator sign-off.

- [ ] **G7-A1** Add Vitest coverage for expectancy report formulas (hit rate, avg_win/loss, ROI). **PARTIAL** - SQL shape and report persistence are tested, but numeric golden vectors do not cover every listed formula including ROI.
- [ ] **G7-A2** Verify live paper trading respects cluster latency under p95 < 2s for all 3 chains. **EXTERNAL EVIDENCE** - latency reporting exists; no three-chain measured acceptance window proves the target.
- [ ] **G7-A3** Ensure no UI components throw uncaught promise rejections on config load failure. **PARTIAL** - primary workspace/config views catch and surface failures, but there is no component-wide rejection regression suite.
- [ ] **G7-A4** Run a full `pnpm build` and `pnpm typecheck` to verify no remaining TypeScript `any` or strictness violations. **PARTIAL** - strict typechecks/builds have passed previously, but explicit `any` remains in source/tests and the final post-review gate is still required.
- [ ] **G7-A5** Verify signals carry chain-native context: Solana safety, Polymarket market/outcome/end date, Robinhood contract safety. **PARTIAL** - Polymarket context is fail-closed and safety fields exist, but one cross-chain fixture suite does not prove every signal contract.
- [ ] **G7-A6** Verify nightly expectancy and latency reports contain all active chains, patterns, tiers, and modes. **PARTIAL** - reports are chain/mode aware, but complete active-dimension coverage is not asserted from production data.
- [ ] **G7-A7** Demonstrate Solana median snipe-to-alert latency below 60 seconds, positive 1-hour snipe expectancy net of slippage, and at least one executed signal per day from healthy clusters over the review window. **EXTERNAL EVIDENCE** - the query script exists; production KPI evidence does not.
- [ ] **G7-A8** Demonstrate 100% Polymarket signal-context coverage, resolution-based wallet scoring, target ingestion lag below 5 minutes, and functioning lag alarms. **EXTERNAL EVIDENCE** - fixture coverage and code exist; a production review window is not recorded.
- [ ] **G7-A9** Demonstrate Robinhood ingestion completeness above 90%, sampled direction accuracy above 95%, and a growing scored-wallet roster with at least 20 classified trades per scored wallet. **EXTERNAL EVIDENCE** - metrics exist; production sample and roster evidence do not.

### Final Repository Gate

- [ ] Run package-level tests after the final change in every service/package. **PARTIAL** - all database and executor package tests pass; the final all-package rerun after checklist/code stabilization remains required.
- [ ] Run full `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, and `pnpm build`. **PARTIAL** - prior full gates and current focused gates pass; one uninterrupted final four-command gate remains required.
- [x] Run migrations twice against a clean database and once against an upgraded database.
- [ ] Inspect queues and database constraints for duplicate-event and duplicate-execution protection. **PARTIAL** - deterministic queue IDs, source/execution unique indexes, and retry tests exist; final queue-state inspection across all running services is not recorded.
- [x] Confirm `.env.example`, `README.md`, and `DEPLOYMENT.md` match the effective runtime configuration.
- [ ] Remove agent-generated build artifacts from the diff and review all remaining changes. **NOT BUILT** - and more serious than a dirty worktree: `apps/discovery/dist/` (4 files), `.turbo/cache/*`, and every `apps/*/.turbo/turbo-build.log` and `packages/*/.turbo/turbo-build.log` are **tracked in git**. Requires `git rm --cached`; `.gitignore` already lists `.turbo/` and `dist/` but does not apply to already-tracked paths. See S0.7.
- [ ] Confirm no secret, private key, API credential, generated wallet data, or production order artifact is committed. **PARTIAL** - no production artifact was intentionally created, but the final full-worktree secret scan/review is not recorded.

## Final Definition of Done

- [x] Any chain can be changed independently between `off`, `paper`, `live`, and `live+shadow` from the dashboard.
- [ ] Every live fill is chain-receipt or venue-fill verified and reconciled after timeout/restart. **PARTIAL** - all three executors require receipt/venue evidence and have reconciliation paths; complete startup balance reconciliation and production proof remain open.
- [ ] Every source trade, copied order, fill, position change, and outcome is traceable and idempotent. **PARTIAL** - canonical linkage and constraints are implemented, but the unresolved system-wide reconciliation and acceptance gaps prevent a final claim.
- [x] Every chain has visible ingestion lag, completeness, failure counts, and recovery alerts.
- [ ] Every trade participates in risk enforcement and attribution; shadow trades affect benchmarking only. **PARTIAL** - shadow exclusion and core risk/attribution are implemented; the incomplete canonical policy and production acceptance prevent a universal claim.
- [ ] The nightly report shows actual expectancy and latency per pattern, tier, chain, and mode. **PARTIAL** - expectancy dimensions and chain/mode latency exist, but latency is not fully broken down by pattern and tier with active-dimension coverage assertions.
- [ ] No chain is declared live-capable before its manual certification document is reviewed. **PARTIAL** - both controls are correctly closed as of 2026-07-30: `LIVE_ENABLED_CHAINS` is empty and no active certification row exists, so all three chains resolve to paper. The item stays open only until a chain is actually certified through the reviewed-document path.

## Implementation References

Re-check current official documentation during implementation; deployment facts and venue APIs can change:

- Polymarket CLOB V2 migration and current official client.
- Polymarket contracts, proxy/signature types, pUSD collateral, and onramp.
- Uniswap router/quoter versions and deployed Robinhood Chain contracts.
- Helius webhook payload and authentication behavior.
