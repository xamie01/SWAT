# Post-fix secondary-services and contract review

## Scope, method and verdict

- Repository: `/home/xahmie/Documents/SWAT`.
- HEAD verified as `8905505595802c21053118b5fab3fd53a8a1654c`; baseline verified as `d5852a0e31e8e9a517c6e7c47ed9623819c7fc71`. Comparison metadata used `git diff d5852a0e31e8e9a517c6e7c47ed9623819c7fc71...8905505595802c21053118b5fab3fd53a8a1654c`. File-change metadata was triage only, never closure evidence.
- Partition: CHAIN-01..07, SEC-01..10, MCP-01..03, INF-01..06. API/browser/DB overlaps were traced only as needed for these retained boundaries and sent to the coordinator for deduplication.
- Static source review only: 24 source-tool calls, including one rejected helper invocation and one read of that helper; every Bash call was sequential and pinned with `taskset -c 0`. No tests, builds, application/service execution, network calls, nested agents, credential-file reads, historical credential inspection, or Git writes. Application files were not changed. All described regressions and fixes below are **unexecuted and unapplied**.
- Source was read from the current workspace after confirming HEAD. This review does not certify an atomic snapshot or a clean worktree. Exact inspected ranges and search limitations are in the coverage artifact.

**The report's “100% Complete & Verified” conclusion is not supported for this partition.** Of 26 retained IDs: **2 closed(source), 4 partial, 14 open, 3 not-verified, 3 surface-removed**. These are source-boundary dispositions, not production-exploit counts. `Verified` means the cited source behavior was directly traced; it does not mean an exploit, deployment, role configuration, or test was executed.

Highest-impact verified residuals are the globally authorized executor's self-selected economic limits, false on-chain revoke/refund assurances, and contradictory root/unstartable hardened deployment examples. LP arithmetic/state and discovery durability defects are reachable in the reviewed service wiring. Reviewed live LP broadcasting explicitly refuses; the perps order helper has only observed test callers.

## Standards

Accepted ADR-0003 requires **scoped, revocable, expiring authority enforced at the protocol/contract layer**, not just application checks (`/home/xahmie/Documents/SWAT/docs/adr/0003-delegated-execution-authority.md:11-18`). The contract still lacks owner-defined asset/expiry/budget policy. ADR-0004 requires owner signatures for withdrawal/revocation and describes global executor rotation and balance-delta checks (`/home/xahmie/Documents/SWAT/docs/adr/0004-solana-vault.md:25-47`): those positive safeguards exist, but do not imply scoped economic authorization, mandatory multisig governance, or refunded rent. The LP service-key-only registry rule in `/home/xahmie/Documents/SWAT/apps/lp/src/routes.ts:403-408` is bypassed by another authenticated-user route.

No root `AGENTS.md` or `CONTRIBUTING.md` appeared in the limited tracked-path query; broader standards discovery was not exhaustive. This is not a lint/style review, and no heuristic code smell is promoted to a security defect.

## Spec / remediation claims

The supplied remediation report is the closure specification, not proof of execution. Its overall claim is at `/home/xahmie/Documents/SWAT/threats/REMEDIATION-EXECUTION-REPORT.md:6,16`; relevant catalogs are `:119-128`, `:167-185`, `:197-205`.

- Quote validation in the signer does **not** remediate CHAIN-01's malicious-authorized-executor threat, nor do off-chain account checks close CHAIN-04/07's contract-side boundaries.
- The CHAIN-02 wording claim is contradicted by the current UI; CHAIN-05's real-handler-fixture claim is not reflected in the inspected contract suites.
- SEC-03 ownership checks on subscriptions do not protect the separately written global registry. SEC-04 still lacks USD conversion; SEC-05's worker still completes without a state transition. SEC-09 is not transactional across storage and enqueue. SEC-10's claimed discovery-input changes do not remove the Python pickle/path sinks.
- Real improvements are present for SEC-01/02, the status-regression component of SEC-08, the exact Vercel CLI version, normal production HTTP upgrading/session-only middleware forwarding, and tracked MCP source removal.
- The test/build totals in the report (`:245-278`) were **not independently rerun or certified**. Python, contract-runtime, deployment, and failure-order properties cannot be inferred from the enumerated TypeScript build/unit-test totals.

## Retained-ID disposition matrix

| Retained ID | Disposition | Confidence | Current finding / qualification |
|---|---|---|---|
| CHAIN-01 | open | Verified | PF-SEC-01; owner policy is absent on chain |
| CHAIN-02 | open | Verified | PF-SEC-02; HTTP-only revoke still claims chain revocation/refund |
| CHAIN-03 | open | Verified | PF-SEC-16; one configured signer, no in-program admin succession; actual governance unknown |
| CHAIN-04 | not-verified | Needs check | Legacy-only extra-account scan remains; Token2022/Jupiter exploit path not established |
| CHAIN-05 | open | Verified | PF-SEC-17; inspected suites still test helpers/synthetic state |
| CHAIN-06 | partial | Verified | PF-SEC-03; initial empty view improved, derivation fallback/active consumer remains |
| CHAIN-07 | open | Verified | PF-SEC-18; low-priority hardening, not a demonstrated runtime bypass |
| SEC-01 | closed(source) | Verified | Arbitrary-origin credentialed CORS removed; no duplicate auth finding |
| SEC-02 | closed(source) | Verified | Auth hook registered without development service key |
| SEC-03 | open | Verified | PF-SEC-04; subscriber can change global registry metadata |
| SEC-04 | open | Verified | PF-SEC-05; unvalued amounts passed as USD, non-atomic check/insert |
| SEC-05 | open | Verified | PF-SEC-06; accepted manual rebalance can strand state |
| SEC-06 | open | Likely | PF-SEC-11; latent/testing-only helper, no observed production order caller |
| SEC-07 | open | Verified | PF-SEC-07; reachable SQL-only close mutates then reports 404 |
| SEC-08 | partial | Likely | PF-SEC-08; execution-state regression fixed, delivery race remains |
| SEC-09 | open | Verified | PF-SEC-09; persist-before-enqueue can remove retry eligibility |
| SEC-10 | open | Verified | PF-SEC-10; local operator/artifact trust boundary, not proven remote RCE |
| MCP-01 | surface-removed | Verified | Tracked implementation gone; existing listener/deployment not assessed |
| MCP-02 | surface-removed | Verified | Tracked global-read tools gone; operational DB access not certified |
| MCP-03 | surface-removed | Verified | Tracked lifecycle gone; excluded generated residue remains on disk |
| INF-01 | partial | Likely | PF-SEC-13; exact CLI pin, still registry acquisition in deployment step |
| INF-02 | open | Verified | PF-SEC-12; root runbook and protected `/root` code path conflict |
| INF-03 | not-verified | Needs check | Shared bootstrap/pool defaults remain; actual role separation not assessed |
| INF-04 | partial | Verified | PF-SEC-15; raw substring loopback test is not an origin policy |
| INF-05 | not-verified | Needs check | Historical opaque credential provenance/rotation deliberately excluded |
| INF-06 | open | Verified | PF-SEC-14; Python/global operator tooling outside pnpm pin |

## Detailed remaining findings

### PF-SEC-01 — Global executor can satisfy self-selected limits while destroying economic value

**High · Verified · CHAIN-01 · Contract entrypoint; deployed exposure conditional.**

`/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:235-329` takes executor-supplied `max_in`, `min_out`, and raw CPI bytes. `:450-486` requires the current global executor signer and vault-owned legacy token accounts, but does not constrain their mints or impose an owner-set policy. `:493-515` stores global configuration and only `owner`, `bump`, `revoked` per vault. There is no per-vault expiry, remaining authorized budget, mint allowlist, or independent economically meaningful return requirement.

A compromised **authorized** global executor can choose most of a funded vault's input, an economically undesirable output, and a minimal positive return; if the pinned Jupiter route supports it, all inspected balance-delta checks can succeed. Repetition is not constrained by an owner-authorized cumulative allowance. This is not an arbitrary outsider signature bypass, and availability of a particular malicious route/liquidity was not tested. Upstream quote validation cannot constrain a malicious executor making direct contract calls.

**Unapplied fix:** persist owner-signed asset/expiry/cumulative-spend policy or an equivalent finite session authorization on chain; enforce it before CPI and consume allowances atomically. Bind output requirements to that policy rather than solely to the executor's arguments.

**Synthetic regression assertion:** under an otherwise authorized executor, a disallowed output mint, expired authorization, exhausted cumulative allowance, or owner-policy-violating output must revert even when the caller's chosen deltas pass. Exercise the real instruction/accounts and a controlled CPI fixture.

### PF-SEC-02 — UI still announces on-chain revocation and rent refund after a database update

**High · Verified · CHAIN-02 · Reachable authenticated browser/API path.**

`/home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:536-575` calls only `/v1/me/vault/revoke`, replaces the address with `REVOKED (Rent Lamports Returned to Wallet)`, and announces refunded rent. Its reactivation branch likewise announces on-chain registration after an HTTP grant. `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:405-449` only updates `user_execution_grants` and returns a success message.

The actual contract requires the owner's signature and updates the on-chain flag (`/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:163-172,399-409`). Neither browser/API branch submits that instruction or confirms its state. Thus a locally revoked grant can coexist with an unrevoked contract; direct use by an already authorized global executor is not disabled by the DB row. Importantly, contract revocation is **reversible by the owner**, not account closure or an irreversible burn. Even owner SOL withdrawal retains minimum rent (`:202-221`). No rent refund follows from the inspected revoke handler.

**Unapplied fix:** explicitly label this endpoint as local execution deactivation, or implement owner-wallet signing, submission, confirmation, and state reread for actual revoke/restore. Do not claim account closure, irreversibility, or refunded rent without a separately implemented and confirmed operation.

**Synthetic regression assertion:** HTTP 200 alone must leave chain status unknown/local-paused and show no refund. Failed/rejected transactions must not claim chain revocation; confirmed revoke must block actual swaps, and owner-only restore must be tested separately.

### PF-SEC-03 — PDA derivation still fails into a program address, then an active-looking vault

**Medium · Verified · CHAIN-06 · Reachable browser connection flow.**

`/home/xahmie/Documents/SWAT/apps/web/lib/wallets.ts:12-29` catches derivation errors and returns the **program ID** with bump 255. The caller at `/home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:192-209` attempts to register that address, swallows registration failure, and sets `status: 'active'`. The restore branch also consumes this helper (`:539-559`). The initial fallback view now uses an empty address and `uninitialized` (`:135-158`), which merits partial credit but does not repair the helper/consumer boundary.

**Unapplied fix:** return a typed failure or throw; block registration/active presentation until derivation and required chain-state validation succeed. Surface grant persistence errors. Do not use a program identity as an account placeholder.

**Synthetic regression assertion:** invalid owner/program/cluster inputs cannot produce an address-shaped success or register a grant; a rejected grant cannot set active state. Funding-button/transaction behavior beyond these excerpts was not traced, so actual misdirected funding is not asserted.

### PF-SEC-04 — User copy-subscription route overwrites service-owned LP registry settings

**Medium · Verified · SEC-03 · Reachable authenticated LP route.**

`/home/xahmie/Documents/SWAT/apps/lp/src/routes.ts:403-408` explicitly restricts tracked-wallet management to service principals. Nevertheless the user-scoped subscription route (`:467-505`) calls `trackLpWallet` before creating a subscription. `/home/xahmie/Documents/SWAT/packages/db/src/lp-tracked-wallets.ts:64-80` defaults cadence to 300 and updates both cadence and label on conflict. A subscriber can therefore replace an existing operator label/cadence with `Copied LP Master`/300; the change survives a later subscription failure. Authentication and subscription ownership do not authorize this global mutation.

**Unapplied fix:** separate insert-only, quota-controlled external-wallet onboarding from operator configuration updates; never update an existing registry row's operator metadata from a subscriber path. Coordinate onboarding/subscription durability with a transaction/outbox where needed. Do not require ownership of a copied external master wallet as a substitute for this separation.

**Synthetic regression assertion:** subscribing to an already tracked wallet preserves its label/cadence, including when subscription creation is forced to fail; direct registry updates still require a service principal.

### PF-SEC-05 — LP concentration guard treats asset quantities as USD and has no atomic reservation

**Medium · Verified (unit error); race consequence Likely · SEC-04 · Reachable build path; reviewed live worker refuses broadcast.**

The authenticated deploy route passes `depositAmount` and `depositAsset` through (`/home/xahmie/Documents/SWAT/apps/lp/src/routes.ts:218-249,274-291`). `/home/xahmie/Documents/SWAT/apps/lp/src/builder/build-position.ts:151-201` checks risk before insertion and stores the same amount. `/home/xahmie/Documents/SWAT/packages/db/src/lp-positions.ts:188-205,401-426` sums `deposit_amount`, without asset conversion, across all nonclosed positions or a selected pool. `/home/xahmie/Documents/SWAT/apps/lp/src/guardrails/deploy-guard.ts:38-48` names those sums USD and assigns `requestedUsd: input.depositAmount`; the pure ratio is at `/home/xahmie/Documents/SWAT/apps/lp/src/guardrails/exposure-cap.ts:68-83`.

Synthetic example: 10,000 units of a cheap asset worth $1 total can make a new one-unit $1,000 deposit look like roughly 0.01% rather than roughly 99.9% concentration. This is not a token valuation calculation. Separately, two simultaneous requests can both pass a stale read: base 100, pool 40, top-up 20 each, cap 50%; each sees 60/120, while both produce 80/140. No reservation is made by the guard; insertion occurs later in a separate transaction.

**Unapplied fix:** store exact asset quantities separately from timestamped trusted USD valuation; reject unavailable/stale valuation; serialize or reserve per-user exposure atomically, including in-flight requests and appropriate paper/live separation.

**Synthetic regression assertion:** changing asset denominations at equal economic value cannot change the cap decision; the cheap/high-value example must fail a 50% cap; concurrent accepted reservations cannot exceed the post-commit cap. No live LP loss is established: `/home/xahmie/Documents/SWAT/apps/lp/src/index.ts:392-395` explicitly refuses live submission.

### PF-SEC-06 — Accepted manual LP rebalance can become permanently unmonitored

**Medium · Verified · SEC-05 · Reachable route and queue-worker wiring; paper/off no-op behavior.**

`/home/xahmie/Documents/SWAT/apps/lp/src/routes.ts:316-350` queues a manual job then attempts `rebalancing`. Its real queue adapter is `/home/xahmie/Documents/SWAT/apps/lp/src/index.ts:331-338`. The worker (`:370-395`) returns successful nonbroadcast results for an existing nonclosed/nonbuilding position without completing or undoing the state transition. `/home/xahmie/Documents/SWAT/packages/db/src/lp-positions.ts:275-293` monitors only active/near-edge/out-of-range positions, not rebalancing. For a successfully accepted state transition, completion of the queue job therefore does not complete the lifecycle.

Paper **initial builds** do transition to active (`/home/xahmie/Documents/SWAT/apps/lp/src/builder/build-position.ts:228-243`); that is not a manual-rebalance fix. The same builder creates a building row before requiring/building SDK steps (`:189-225`), and live submission remains unsupported in the inspected worker. Broader recovery callers were not exhaustively traced.

**Unapplied fix:** use explicit simulated/planned/submitted/confirmed outcomes, conditionally finalize paper rebalances, reconcile failures, and reject unsupported live operations before recording a deployable lifecycle. Preserve concurrent close decisions; do not blindly reactivate a closed position.

**Synthetic regression assertion:** an accepted paper rebalance processed by the real worker adapter ends in a documented monitorable state or explicit failure, never indefinitely rebalancing; queue/worker races with close preserve closed state; unavailable live capability creates no misleading active/building work.

### PF-SEC-07 — Perps close mutates an owned row, then reports failure, without a venue close

**Medium · Verified · SEC-07 · Registered authenticated API; populated position rows conditional.**

`/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:1634-1642` calls `closePerpsPosition` and returns 404 when it returns false. `/home/xahmie/Documents/SWAT/packages/db/src/polymarket-perps.ts:276-283` updates an owned open position to closed **without RETURNING** and decides success from the returned array length. `/home/xahmie/Documents/SWAT/packages/db/src/client.ts:65-67` returns `result.rows`, not affected-row count. A successful PostgreSQL UPDATE therefore yields an empty array and a false response. The portfolio route requests only open positions (`/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:1613-1619`). The close path has no reduce-only venue order or confirmation.

**Unapplied fix:** distinguish local archival from financial closure. A financial close requires durable reduce-only order submission/reconciliation before marking exposure closed; a genuine local archive must be named as such and use `RETURNING id` or a row-count API.

**Synthetic regression assertion:** an owned open fixture must not be mutated and then reported missing; another user's row cannot change. A mocked venue refusal cannot close local live exposure. Dormancy of the separate perps order executor does not remove this registered API route.

### PF-SEC-08 — Alert lifecycle regression is fixed, but notification ownership/deduplication remains racy

**Medium residual severity · Likely race impact · SEC-08 partial · Production worker source wiring.**

`/home/xahmie/Documents/SWAT/apps/alert-service/src/index.ts:400-404` now changes status only when its current value is pending, and only stamps an unalerted row. This genuinely prevents the previously reported late overwrite of executing/executed lifecycle states.

However, `:379-411` acquires an ownerless value `1` with TTL 60, sends externally before storing success, and unconditionally deletes the lock. The sender at `:40-60` has no fetch deadline and can sleep based on provider retry-after. If A outlives its lease and B acquires it, A may delete B's lease; both may send before either commits alerted_at. A failed DB write after a successful send also permits a repeat. A failed claim returns normally, so that attempt is not a durable delivery obligation.

**Unapplied fix:** separate notification lifecycle from signal state, use bounded delivery, token-owned compare-and-delete/renewal, and a durable retry/outbox record. Do not promise external exactly-once semantics unless the provider supports an idempotency mechanism.

**Synthetic regression assertion:** with a fake clock and a delayed sender exceeding the lease, an old worker cannot release the new owner's claim; DB failure after send has a defined reconciliation outcome; executing/executed/failed statuses never change because of notification delivery. No race was executed here.

### PF-SEC-09 — Discovery commits wallets before enqueue and then excludes them from rediscovery

**Medium · Verified · SEC-09 · Wired nightly and pub/sub-triggered runner.**

`/home/xahmie/Documents/SWAT/apps/discovery/src/index.ts:24-41,44-51,75-77` wires real persistence and BullMQ enqueue into the runner. `/home/xahmie/Documents/SWAT/apps/discovery/src/runner.ts:44-55` upserts first, enqueues second, and only logs either failure. The upsert is standalone SQL (`/home/xahmie/Documents/SWAT/packages/db/src/wallets.ts:44-64`); later discovery selects only addresses absent from wallets (`/home/xahmie/Documents/SWAT/packages/db/src/discovery-queries.ts:29-64`). A queue outage after persistence can thus remove the wallet from these retry candidates without ever scheduling its historical indexing.

**Unapplied fix:** transactionally create a wallet plus durable backfill intent, dispatch idempotently, and retry/reconcile intents until acknowledged. Queue naming alone is not transactional durability.

**Synthetic regression assertion:** inject enqueue failure after a committed upsert; a later recovery pass must enqueue exactly one durable logical job without rediscovering the wallet. `/home/xahmie/Documents/SWAT/apps/discovery/src/runner.test.ts:57-79` tests an **upsert** failure, not this post-commit enqueue failure; the other inspected tests cover success and in-process overlap. Other platform-wide recovery mechanisms were not certified.

### PF-SEC-10 — Python ML artifacts remain executable, and path confinement is not enforced

**Medium · Verified source sinks · SEC-10 · Local/operator trust boundary; remote exploit not established.**

`/home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/cli.py:596-624` exposes `score` and directly `pickle.load`s the local ranker before scoring. A substituted artifact is executable Python content. The normal writer at `:587-592` also uses pickle, so this is a deliberate unsafe-format trust requirement, not a sink eliminated by unrelated feature sanitization.

`/home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/config.py:116-142` permits absolute/parent paths for configured storage. `:159-180,197-223` accepts nonempty non-EVM-looking Solana strings without base58/length validation. `/home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/storage.py:89-105` uses that string as a path component without resolving it under an allowed root. The `pull --kols` caller passes roster addresses into that sink (`/home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/cli.py:177-219`), **only after obtaining a nonempty source frame**. Whether an invalid roster address can yield such a frame from actual providers was not tested; reliable arbitrary roster-to-write exploitation is not asserted.

**Unapplied fix:** treat pickle files as executable trusted artifacts with controlled ownership/provenance, or migrate to a non-executable model format and validate its schema. Parse canonical chain addresses; resolve paths and enforce containment/symlink policy. If external configured paths are intentional, document explicit operator privilege instead of claiming sandbox confinement.

**Synthetic regression assertion:** slash/parent/absolute roster components are rejected before a mocked nonempty pull reaches storage; allowed output stays beneath an approved root. Scoring must reject untrusted or unverifiable artifacts rather than deserializing them. No malicious pickle was constructed or loaded.

### PF-SEC-11 — Latent perps order helper still has fail-open arithmetic and submit-before-record

**Medium · Likely financial impact; source defects directly verified · SEC-06 · Only test callers observed.**

`/home/xahmie/Documents/SWAT/apps/trade-executor/src/polymarket-perps.ts:97-99` treats zero withdrawable as false and falls back to another amount; invalid margin values can become zero or NaN. `:172-198` multiplies unchecked price/quantity, divides by unchecked leverage, and refuses only on `requiredInitialMargin > availableMargin`. NaN comparisons are false; negative/nonfinite inputs are not reliably rejected. The order payload omits the supplied client-order ID and leverage used in the local calculation. `placeOrder` happens before `recordPerpsOrder` (`:198-217`), leaving external-effect/DB-recovery ambiguity. Session-to-user ownership is not enforced inside this helper.

A bounded static symbol/import search found `executePerpsOrder` in its implementation and `/home/xahmie/Documents/SWAT/apps/trade-executor/src/polymarket-perps.test.ts`, not a production order caller. Thus this is **latent/testing-only in observed wiring**, not a demonstrated production risk bypass. Venue validation and SDK recovery behavior were not inspected. Existing dormancy is not proof that the numeric/state bugs were repaired.

**Unapplied fix:** retain a fail-closed enablement gate; require exact finite positive instrument quantities/prices and bounded leverage, respect literal zero margin, bind sessions to the authenticated principal, and persist a pending request with a stable client ID before submission/reconciliation.

**Synthetic regression assertion:** zero withdrawable remains zero; malformed, negative, NaN, and nonfinite numeric inputs cannot call placeOrder; transport uncertainty or post-submit DB failure reconciles one stable client ID rather than submitting another order. No provider/session was contacted.

### PF-SEC-12 — Deployment examples still choose root or an inaccessible hardened code path

**High · Verified source contradiction · INF-02 · Operator-run deployment instructions; installed units unknown.**

`/home/xahmie/Documents/SWAT/DEPLOYMENT.md:304-317` still supplies an API unit with `User=root`; its web example repeats root at `:324-332`. The dedicated-user alternatives at `/home/xahmie/Documents/SWAT/deploy/systemd/swat-api.service:8-20` and `/home/xahmie/Documents/SWAT/deploy/systemd/swat-trade-executor.service:8-24` use `User=swat` but set WorkingDirectory/ExecStart under `/root/SWAT` while enabling `ProtectHome=true`. As supplied, the protected home path cannot be a usable service code location. This encourages either root execution or disabling protections to make the service start.

**Unapplied fix:** make one canonical unprivileged deployment definition; put immutable code outside protected homes, explicitly provision writable state directories, and place environment/secret references under controlled system locations. Remove the contradictory root recipe. No filesystem permission or installed-unit state was inspected.

**Synthetic regression assertion:** deployment templates/runbook agree on the unprivileged user; no executable/working path is beneath a protected home; a disposable unit validation/start harness can access code without root or weakening ProtectHome.

### PF-SEC-13 — Exact Vercel CLI version is pinned, but acquisition still shares the deployment trust domain

**High · Likely supply-chain impact · INF-01 partial · CI source only.**

Both `/home/xahmie/Documents/SWAT/.woodpecker.yaml:68-90` and `/home/xahmie/Documents/SWAT/.woodpecker/ci.yaml:68-90` now install `vercel@65.11.0` at line 83. The prior unversioned top-level command is genuinely repaired. The registry installation remains in the same deployment step whose environment declares deployment credential references; those lines and credential-bearing command/URL values were redacted during review.

The source does not establish credential-free acquisition, repository-lockfile-controlled CLI resolution, or immutable deployment artifacts. The published CLI's transitive lock/shrinkwrap behavior was **not inspected**, so unpinned transitive versions or a malicious release are not asserted as verified. The remaining issue is the unseparated install/deployment privilege boundary, not a claim that the exact version pin is absent.

**Unapplied fix:** acquire and verify locked tooling/artifacts in a credential-free stage; inject least-privilege short-lived deployment credentials only into the minimal publish stage, with no package installation there.

**Synthetic regression assertion:** static CI policy rejects package acquisition in steps declaring deployment-secret references; artifact/tool integrity is fixed before those references become available. CI secret configuration and actual permissions were not assessed.

### PF-SEC-14 — Python/server installation remains outside the claimed reproducible dependency boundary

**Medium · Verified · INF-06 · Operator-invoked setup.**

`/home/xahmie/Documents/SWAT/pattern-ml/scripts/setup-server.sh:41-48` upgrades pip without a version and performs an editable install of dev/service dependencies. `/home/xahmie/Documents/SWAT/pattern-ml/pyproject.toml:7-40,45-47` uses open lower bounds, including build tooling. `/home/xahmie/Documents/SWAT/DEPLOYMENT.md:393-395` still recommends unversioned global PM2 installation. The real pnpm pin at `/home/xahmie/Documents/SWAT/package.json:4` does not govern these tools.

**Unapplied fix:** use hash-locked Python/tool dependency sets and immutable, unprivileged artifacts; pin/isolate operator process-management tooling or remove that installation path. No package compromise or vulnerability inventory is claimed.

**Synthetic regression assertion:** a clean offline install from an approved artifact set resolves identical dependencies; deployment setup cannot upgrade or fetch unconstrained tools. No dependency installer was run.

### PF-SEC-15 — Production HTTP exception checks the whole string, not the destination host

**Medium residual severity · Verified source behavior · INF-04 partial · Operator configuration prerequisite.**

`/home/xahmie/Documents/SWAT/apps/web/next.config.ts:4-23,30-40` upgrades ordinary nonloopback HTTP destinations, but exempts any target containing `localhost` or `127.0.0.1`. `/home/xahmie/Documents/SWAT/apps/web/middleware.ts:21-34` repeats that decision, then forwards the session cookie (`:46-55`). Synthetic `http://localhost.attacker.invalid:3001` or an unrelated host with `/127.0.0.1` in its path remains HTTP. The latter is a string classification error, not evidence of a remotely user-controlled SSRF vector. Actual backend settings, TLS availability, and hosting forwarding behavior were not inspected.

Session-only middleware cookie forwarding is a real improvement, and the normal production default/HTTP-upgrade paths are improved. Neither establishes the claimed universal prohibition on remote plaintext targets.

**Unapplied fix:** parse with URL, reject unexpected schemes/userinfo, and apply exact hostname/origin policy; require HTTPS for nonlocal approved origins instead of guessing via substring. Consolidate middleware/rewrite target validation.

**Synthetic regression assertion:** loopback-looking hostname suffixes, paths, userinfo, and protocol casing cannot bypass production HTTPS policy; only explicitly permitted local origins can use HTTP. Coordinate this item with the primary browser review rather than count it twice.

### PF-SEC-16 — Global config signer is not an intrinsic multisig/timelock or admin recovery mechanism

**Medium · Verified authority shape · CHAIN-03 · Actual governance deployment not verified.**

`/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:35-79,339-367` pins the initial admin and correctly requires the configured admin signer for updates. That signer can immediately replace the executor across all vaults; the update interface cannot replace admin. No threshold, delay, staged transfer, or recovery rule appears in these handlers/state. A governance program could satisfy the signer via CPI, but neither that deployment nor its policy is established here; it would be wrong to assert the configured key is definitely an EOA.

**Unapplied fix:** explicitly verify/enforce the intended governance caller and governed executor/config changes; add owner-independent, staged admin succession/recovery consistent with the threat model. Preserve users' immediate revoke/withdraw route. Documentation about program **upgrade** authority is not proof of runtime `WakeConfig.admin` controls.

**Synthetic regression assertion:** actual governance-approved change/rotation succeeds, an unapproved direct signer operation cannot bypass intended delay/threshold, and a staged admin transfer cannot strand configuration. Program upgrade authority and deployed permissions were not assessed.

### PF-SEC-17 — Inspected contract assurance still bypasses real handler/account/CPI validation

**Medium · Verified coverage mismatch · CHAIN-05 · Testing-only assurance finding.**

`/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:635-729` tests pure invariant helpers; the initializer test only compares public keys and the prefunded check evaluates booleans. `/home/xahmie/Documents/SWAT/programs/wake-vault/trident-tests/fuzz_0/src/lib.rs:1-143` imports the helpers, mutates a synthetic `FuzzVaultState`, and invokes synthetic steps. It does not dispatch the real Anchor instructions with runtime account metadata or execute Jupiter CPI. These examples cannot establish account owner, writable, signer, PDA, CPI, or rollback coverage. Other possible test suites outside the bounded program-path inspection are not certified absent.

**Unapplied fix:** add isolated program-runtime instruction tests with constructed accounts and a controlled CPI program; keep helper/property tests as a complementary layer, not evidence of runtime enforcement.

**Synthetic regression assertion:** missing/wrong signer, wrong PDA/owner/program, nonwritable output, rogue writable vault account, malformed prefunding, revoked swap, failing CPI, and failed post-CPI invariants all reject with atomic rollback through actual dispatch.

### PF-SEC-18 — Minimal System-PDA withdrawal still relies on runtime rejection of incompatible accounts

**Low · Verified hardening gap, not an exploit · CHAIN-07 · Minimal/demo program deployment unknown.**

`/home/xahmie/Documents/SWAT/programs/pda-vault-minimal/src/lib.rs:14-79,100-116` dispatches tag 0 with owner signature, destination-equals-owner, canonical PDA, positive amount, and balance checks. It does not explicitly verify the vault's System ownership/empty data, writable metas, or the supplied System program account before CPI. The constructed transfer instruction targets the System program, and normal Solana runtime checks should reject incompatible accounts; no forged-program or signature bypass is demonstrated. Tag 1 always fails and is not an alternate withdrawal path.

**Unapplied fix:** state and validate the System-account model explicitly and test real tag-0 dispatch. Do not substitute this model for the separate stateful Anchor vault model.

**Synthetic regression assertion:** wrong account owner/data shape, nonwritable vault/destination, or substituted System-program account rejects without state change; correct owner withdrawal works. Client-only mint/owner checks do not repair this local contract hardening item.

## Qualified/unverified retained boundaries (not claimed exploits)

### CHAIN-04 — Broader writable resource scope

`/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:273-315,471-486` scans extra writable accounts only when their owner equals the legacy Token program, while granting the vault PDA signer to Jupiter. This demonstrates a legacy-only scan, not a verified Token2022 theft path. Actual vault holdings, extension behavior, and a supported Jupiter route mutating a nonlegacy vault-controlled resource were not inspected. **Not-verified / Needs check**, not closed by executor preflight checks. Proposed regression: a controlled CPI fixture must reject or explicitly account for every additional writable vault-controlled resource, including unsupported token programs/extensions.

### INF-03 — Runtime database identity/privileges

`/home/xahmie/Documents/SWAT/docker-compose.yml:13-18,45-58` still maps PostgreSQL bootstrap and PgBouncer DB user from the same configuration variable/default. `/home/xahmie/Documents/SWAT/packages/db/src/client.ts:10-27` constructs the pool from the configured URL; `/home/xahmie/Documents/SWAT/packages/db/sql/064_row_level_security.sql:47-64` creates/grants an application role, which does not prove the runtime connection selects it. Role flags, installed migrations, connection initialization, effective SET ROLE behavior, and production credentials are outside this partition. **Not-verified / Needs check**; do not certify separation from comments or role existence. Primary DB review may refine this disposition. Proposed assertion: in an isolated provisioned DB, actual runtime sessions are neither superuser nor BYPASSRLS and cannot become migrator/admin.

### INF-05 — Historical credential-shaped material

The prior finding concerns opaque historical material, not whether a current example contains placeholders. The remediation report's example/secret-script claim at `/home/xahmie/Documents/SWAT/threats/REMEDIATION-EXECUTION-REPORT.md:204` cannot resolve provenance, exposure, validity, or rotation. **Not-verified / Needs check**. No historical credential bytes, dotenv files, keypairs, secret files, or certificates were opened or scanned. Owner-led provenance/rotation and redacted historical evidence are required; this review does not assert a live leak.

## Genuine closures and removed surfaces

- **SEC-01 closed(source):** `/home/xahmie/Documents/SWAT/apps/lp/src/index.ts:277-299` now allows listed origins plus explicit local origins, rather than reflecting arbitrary origins. This closes the original arbitrary-origin behavior, not a certification of production origin configuration or browser cookie delivery.
- **SEC-02 closed(source):** `/home/xahmie/Documents/SWAT/apps/lp/src/index.ts:300-302` always registers auth. `/home/xahmie/Documents/SWAT/apps/lp/src/auth.ts:60-103` resolves active user sessions with CSRF checks, treats the service key as optional, and refuses nonuser principals on tenant routes. No duplicate auth finding is raised.
- **MCP-01/02/03 surface-removed:** read-only tracked-path metadata shows no current tracked files under `/home/xahmie/Documents/SWAT/apps/mcp-server`; the scoped safe source/manifest search found no `apps/mcp-server` or `@swat/mcp-server` reference. `/home/xahmie/Documents/SWAT/package.json:5-30` has no MCP launch script; `/home/xahmie/Documents/SWAT/pnpm-workspace.yaml:1-3` remains generic app/package globs. A **names-only** directory check found `.turbo`, `dist`, and `node_modules` under the old app directory. Their contents were excluded. Removal of the tracked server eliminates the original reviewed source surface; it does not certify deletion of generated artifacts, termination of a deployed listener, SDK session isolation in old deployments, or revocation of operational DB/Redis access. Proposed source assertion: a fresh checkout has no launchable MCP package. Operators must separately verify deployed process/artifact/permission removal.

## Coverage and limitations

Detailed machine-readable dispositions: `/home/xahmie/Documents/SWAT/threats/post-fix-8905505/secondary-contract-closures.json`.

Exact current-source ranges, retained-table coverage, bounded search scope, and exclusions: `/home/xahmie/Documents/SWAT/threats/post-fix-8905505/secondary-contract-coverage.json`.

Not assessed: actual chain deployment/upgrade authority, Jupiter implementation and routes, Token2022 holdings/extensions, actual governance, real LP/perps/Telegram/RPC effects, installed daemons/filesystem permissions, CI secret configuration, runtime DB role flags, historical credential validity/rotation, excluded compiled/dependency artifacts, complete subprocess/ML HTTP reachability, or all repository tests. Broad outputs that were truncated were not treated as complete-file inspection. Claims outside these source paths remain with the primary reviewers.
