# Synthesis, prioritized fixes and regression acceptance

2026-11-06. **The bounded static review is complete; the financial execution boundaries are not ready to be treated as certified.** The strongest source-supported problems are tenant identity loss, operator/user authority confusion, broken lot exits, unbound external submission recovery, upstream transaction trust, and independent control-plane/testbed weaknesses. No source fixes were applied. The static phase executed no application tests/builds/services/live calls; subsequent execution and local role/schema revalidation are recorded in [runtime verification](04-runtime-verification.md). Counts below remain the static snapshot; RUN-01 strengthens the local bootstrap-role evidence without claiming production deployment.

## 1. Incorrect premises and final severity corrections

- An Anchor program and an adapter labelled audited do not prove that current user jobs invoke a user vault. Production supplies the operator signer; the user adapter invents a settlement identity and ordinary Jupiter dispatch uses an independent signer closure (`apps/trade-executor/src/index.ts:1125-1162,1782-1795`; `apps/trade-executor/src/execution-authority-adapters.ts:546-568,604-618`). Live downstream synthetic-address acceptance and user-PDA debits are **NOT VERIFIED**.
- The contract rejects zero `min_out` and genuinely bounds net input spend. The defect is that the authorized executor chooses those bounds without owner-enforced mint/expiry/cumulative economics (`programs/wake-vault/src/lib.rs:235-252,328-329,465-515`). OLD-02/03's earlier conditional Critical ratings are downgraded to High; there is **no supported Critical finding**.
- Polymarket L2 credentials are HTTP credentials, not independent wallet order-signing authority. User PM/RHC adapters deny (`apps/api/src/routes/me.ts:617-622`; `apps/trade-executor/src/execution-authority-adapters.ts:462-467,585-593`). Enrollment replay remains Likely; no indefinite replay window or float theft was demonstrated.
- Source age is checked before canonical claim; PM adds a resolution-aware pre-order gate. Blanket claims that shelf-life is absent are removed (`apps/trade-executor/src/index.ts:1632-1658`; `packages/db/src/copy-trade-lifecycle.ts:1872-1937`; `apps/trade-executor/src/polymarket.ts:797-848`). Universal last-sign freshness is **NOT VERIFIED**.
- API hash-case repeat credit and PM fill-identity economics were downgraded to Medium/Likely; actual provider acceptance/contracts are **NOT VERIFIED** (`apps/api/src/routes/billing.ts:274-287`; `apps/indexer/src/source-trade-lifecycle.ts:116-163`).
- LP/perps latent arithmetic/CORS findings are Medium where current live submission refuses or production/cookie reachability is unverified (`apps/lp/src/index.ts:369-394`; `apps/trade-executor/src/polymarket-perps.ts:87-217`). The bootstrap DB-role default is Medium/Likely, not proven deployed superuser compromise (`docker-compose.yml:13-18,45-50`; `packages/db/src/client.ts:10-27`).
- The standalone testbed's public-input signing key is a real source defect. Its funding/network are unknown; unsigned withdrawal fields do not prove attacker-chosen payouts because recipient remains the owner (`pda-test-ui/server.mjs:38-41,202-285`; `pda-test-ui/public/index.html:709-738`).

## 2. Counts, deduplication and posture

The twelve module tables contain **82 observations: 0 Critical, 27 High, 48 Medium, 7 Low**. After explicit root-cause consolidation: **76 findings: 0 Critical, 24 High, 46 Medium, 6 Low**; confidence is **52 Verified, 21 Likely, 3 Needs check**. These are review observations, not 76 demonstrated exploits. Verified denotes traced source/callers, not deployed execution. Many High impacts remain conditional on funded/enabled routes or listener access; those prerequisites are spelled out in each module.

Deduplication rules, applied exactly once:

| Retained finding | Folded observations | Reason |
|---|---|---|
| EXE-01 | CRY-01 | Same user/operator Solana authority fallback and ordinary swap path. |
| EXE-02 | SIG-01 | Same dropped tenant ID at claim/trade persistence. |
| API-03 | CRY-06 | Same credential proof logging/reassignment path; aggregate confidence Likely. |
| API-06 | CRY-07 | Same incomplete OTP intent and false queued response; retain Medium. |
| INF-04 | WEB-04 | Same insecure backend resolution/credential forwarding boundary; retain High. |
| EXE-06 | EXE-09 | Same submit-before-durable-identity/unknown-state root, with separate Jito and PM implementations/tests. |

Distinct master-capacity, account-exposure, lot-exit and registration/revocation defects remain separate despite sharing fixes. OLD-01–05 are architectural lenses, not counted again. Every table row and consolidation group is preserved in [finding-register.json](evidence/finding-register.json).

| Previous threat | Current disposition |
|---|---|
| OLD-01 predictable copy flow | Economic profit remains Likely; SIG-08, EXE-04 and the latency report define capacity/reservation and ordering closure. |
| OLD-02 global economic authority | High, conditional on reachable funded vaults; CHAIN-01/02/03 and EXE-05 define independent policy, revoke and signer containment. |
| OLD-03 tenant/signer mismatch | High; EXE-01/02/03 are authoritative. No demonstrated synthetic-address live acceptance or user-PDA drain. |
| OLD-04 source poisoning | High parser defects IDX-01/02; IDX-03/04/06/07/08 and SIG-06/07 cover evidence, uncertainty and control quality. |
| OLD-05 payment claim ownership | High API-01; API-02/04 and database compatibility notes cover canonical identity and atomic renewal/credit. |

**Posture:** keep current paper/off and certification safeguards; do not scale delegated live execution until principal, policy, lot exits, reservations and receipt-based recovery are tested together. This is a recommendation, not a mode/configuration change. Existing strong controls—login nonce consumption, CSRF, admin gates, canonical deduplication, owner withdrawal checks and unsupported-user adapter denials—must be preserved (`apps/api/src/auth/routes.ts:289-325`; `apps/api/src/auth/plugin.ts:98-195`; `packages/db/src/copy-trade-lifecycle.ts:633-716`; `programs/wake-vault/src/lib.rs:176-223`).

## 3. Cross-module compound risks

All abuse descriptions are conceptual, at most three steps; no payload or attack was executed.

### A. Transaction-builder compromise plus unrestricted signing — most dangerous current operator combination

**EXE-05 + EXE-01.** (1) An untrusted builder supplies economically unauthorized but valid instructions. (2) The operator-bound runtime signs them without full intent inspection. (3) Reachable operator assets are exposed, with user-looking identities obscuring scope. Simulation success is not consent (`packages/shared/src/jupiter-swap.ts:181-258`; `apps/trade-executor/src/solana-signer.ts:64-71`; `apps/trade-executor/src/execution-authority-adapters.ts:604-618`). **Break it:** deny unresolved user authority, inspect exact final bytes in a policy-enforcing signer, and reconcile real debited accounts. No present user-vault drain is established.

### B. Economic global authority plus false on-chain revocation

**CHAIN-01 + CHAIN-02.** (1) A compromised authorized executor selects destructive permitted economics. (2) User clicks the HTTP revoke path. (3) Only DB status changes while UI claims on-chain revoke/refund, leaving actual unrevoked funded vault authority conditional on deployment (`programs/wake-vault/src/lib.rs:235-329,465-515`; `apps/api/src/routes/me.ts:400-444`; `apps/web/app/vault/page.tsx:536-575`). **Break it:** independently owner-enforced finite policy and wallet-signed confirmed revocation. Deployed/funded program use **NOT VERIFIED**.

### C. Tenant loss plus master-aggregate sell sizing

**EXE-02 + SIG-02.** (1) User claims default to operator identity. (2) Master's fraction is applied to aggregate inventory. (3) Venue effects and master-scoped fills diverge, defeating user/lot risk accounting (`apps/trade-executor/src/index.ts:1209-1217`; `packages/db/src/trades.ts:179`; `packages/db/src/copy-trade-lifecycle.ts:1952-1976,2332-2365`). **Break it:** explicit tenant contracts and pre-submit master-lot reservation; do not merely alter fill allocation.

### D. Poisoned source plus blocked reducing exits

**IDX-01/02 + SIG-03/04/05.** (1) Ambiguous non-swap/raw-unit evidence creates unwanted inventory. (2) Close-all/stop-loss loses execution identity or source deterioration triggers entry-style denials. (3) Copied exposure can remain after the master exits (`apps/indexer/src/parse.ts:138-260`; `apps/scorer/src/stop-loss.ts:225-268`; `apps/trade-executor/src/index.ts:1683-1688`; `packages/db/src/fanout-eligibility.ts:204-259`). **Break it:** provenance before canonicalization plus independent owned-lot exits.

### E. Lost transport response plus missing reconciliation/reservations

**EXE-06/09 + EXE-07/04/SIG-08.** (1) Venue accepts before stable identity is stored. (2) Response/storage fails and local execution terminates or stays unaccounted. (3) Headroom/retry decisions no longer reflect actual exposure (`apps/trade-executor/src/jupiter-jito-runtime.ts:311-342`; `apps/trade-executor/src/polymarket.ts:878-884,986-989`; `apps/trade-executor/src/index.ts:2647-2655,2732-2758`). **Break it:** write-ahead submitting/unknown states, exact receipt mapping and retained atomic commitments. Duplicate venue effect remains Likely, not reproduced.

### F. Global MCP mutation plus weak source qualification

**MCP-01 + SIG-06/07.** (1) A non-operator reaches the independent listener. (2) It changes blacklist/scorer control through unguarded tools. (3) Shared admission/scoring changes outside REST admin authorization (`apps/mcp-server/src/index.ts:264-350,369-405`; `apps/signal-engine/src/index.ts:329-363`; `apps/scorer/src/index.ts:317-337`). **Break it:** authenticate/authorize the tool boundary and preserve independently assessed source uncertainty. No arbitrary trading, shell execution or unrestricted concurrent scoring was shown.

## 4. Top ten fixes ranked by estimated risk reduction per engineering hour

Estimates are planning judgments for an experienced maintainer, **not measured effort, loss probability or commitments**. First hours emphasize reversible containment; complete financial closure includes tests/migration/review and can take longer. Ranking assumes live growth is contemplated, not proven active. Do not perform credential rotation, history rewriting or fund migration without separate owner-authorized operations.

| Rank | Work package | Initial estimate | Primary reduction |
|---|---|---:|---|
| 1 | Fail-closed user authority and no policy widening | 4–8 h | Stops wrong-principal signing attempts. |
| 2 | Tenant identity through claims/trades/evidence | 4–8 h | Restores every downstream isolation/risk key. |
| 3 | Remove public-input signing testbed | 1–3 h containment | Prevents unsafe new funding/authorization. |
| 4 | Authenticate MCP and bind tool sessions | 4–8 h | Removes independent global-control bypass. |
| 5 | Enrollment/payment ownership and proof logging | 8–16 h | Stops entitlement theft and unsafe reassignment. |
| 6 | Pin/isolate deployment and secure service transport | 8–16 h | Reduces secret/host/session blast radius. |
| 7 | Unify master/close-all/stop-loss lot exits | 16–32 h | Prevents excess sells and stranded reductions. |
| 8 | Write-ahead submission plus receipt reconciliation | 24–48 h | Prevents unknown exposure/rebuild ambiguity. |
| 9 | Atomic exact-unit risk/capacity and stop epochs | 16–32 h | Removes pending headroom and stale stop gaps. |
| 10 | Final-byte intent policy plus owner economic bounds | 24–80+ h and audit | Constrains upstream/hot-key economic authority. |

### 1. Deny unresolved users; intersect policy

Files: `apps/trade-executor/src/execution-authority-adapters.ts:498-568,604-618`, `index.ts:1125-1162,1462-1469,1650-1658,1782-1795`; `apps/signal-engine/src/fanout-enqueue.ts:242-255`.

1. Remove synthetic settlement and default operator signer inheritance; require explicit installed user grant/vault capability. Denial must happen before any live signer/transport call.
2. Version queue intent with principal, maximum mode, scope, slippage, expiry and policy revision. At dequeue intersect current tenant intent with platform/certification readiness; paper/off never widens to live.
3. Preserve explicit operator/Trojan behavior and current stable user RHC/PM denial codes. A future user builder must produce real scoped contract instructions, not merely call an operator-backed `authority.sign`.
4. Regression: production factory plus actual runtime with fake transport must show zero signer calls for unresolved/revoked grants and queued-paper/global-live transitions.

### 2. Make tenant identity mandatory

Files: `apps/trade-executor/src/index.ts:318-410,1179-1217,1650-1658`; `packages/db/src/copy-trade-lifecycle.ts:1746-1770,1834-1849`; `packages/db/src/trades.ts:140-180`.

1. Add explicit principal-derived `userId` to canonical preparation and every `persistTrade` shape; verify returned execution, venue mapping and trade share it.
2. Keep null only in explicitly typed legacy-operator paths. Do not remove SQL tenant-aware uniqueness or scope shared source signals per tenant.
3. Quarantine ambiguous historical null records; do not automatically relabel financial history.
4. Regression: operator plus users A/B sharing a paper account yield three distinct claims/trades/lots, including replay and shadow effects.

### 3. Remove unsafe testbed custody

Files: `pda-test-ui/server.mjs:38-41,99-130,202-285`; `public/index.html:663-678,709-738,826-863`.

1. Disable new deposits/server signing until deterministic signing authority is removed; default to loopback and verified test network.
2. Choose real owner-controlled PDA operations or inert mocks consistently across vault-info, deposit and withdrawal. Changing derivation alone can strand historical funds; inventory/migration is a separate authorized operation.
3. If signed intents remain, reconstruct canonical action/resource/amount/network/expiry/nonce and consume nonce atomically. Recipient staying owner does not repair unsigned amount/replay.
4. Regression: changed fields/replay/invalid cluster produce zero signer calls; UI never funds an alternative public-input account.

### 4. Protect the independent MCP boundary

Files: `apps/mcp-server/src/index.ts:264-350,365-405`; `apps/api/src/auth/plugin.ts:98-195` for existing authorization semantics.

1. Require authentication at SSE and message submission; store immutable principal and permissions with the session.
2. Authorize each global read/write tool, share audited mutation logic, default bind loopback, and bound/dispose sessions.
3. Preserve tool names and authorized responses; do not assume REST cookies automatically protect Express.
4. Regression: unauthenticated/user/foreign-session requests cannot read global operational records, mutate blacklist or publish scorer work.

### 5. Bind enrollment and payment to their rightful owner

Files: `apps/api/src/routes/me.ts:502-651`; `routes/billing.ts:274-287,378-419`; `packages/db/src/billing.ts:188-230,390-425`; `apps/web/app/billing/page.tsx:191-205`.

1. Remove full signature logging, require linked-wallet plus separate single-use user-bound enrollment consent, and restrict credential upsert conflicts to the same owner. Keep venue-specific proof/contract-wallet compatibility.
2. Require owned pending unexpired fixed-plan intent and chain-visible payment binding. Support exchange payers via actual reference/receiver evidence, not assumed payer-wallet equality.
3. Canonicalize identity per chain, lock invoice, credit/consume/audit atomically, and condition sweep downgrade on still-expired state. Preserve case-sensitive Solana signatures and lifetime/null expiry.
4. Regression: two tenants/one receipt, wrong/missing/expired reference, venue-success foreign-owned row, log spies and renewal/sweep interleavings.

### 6. Narrow deployment authority and transport

Files: `.woodpecker.yaml:68-90`, `.woodpecker/ci.yaml:68-90`; `apps/web/next.config.ts:4-35`; `apps/web/middleware.ts:21-46`; `DEPLOYMENT.md:304-385`; `deploy/systemd/swat-api.service:8-19`; `packages/db/sql/064_row_level_security.sql:29-64`.

1. Pin CLI/image acquisition, separate credential-free build from minimal scoped deployment, and prevent production-env cache/artifact reuse. Reconcile both pipeline definitions; preserve prebuilt tracing.
2. Unify validated HTTPS cross-host backend resolver; forward only session cookie; allow HTTP only in explicit local development. Preserve API/LP rewrite ordering and CSRF.
3. Deploy unprivileged read-only releases outside `/root`, secrets separately, writable state narrowly. Do not solve protected-home access by running root.
4. Provision tenant/bootstrap/maintenance/migrator roles separately. Changing to a tenant-only role without redesigning login/global workers breaks legitimate callers; direct/session-lock work must avoid transaction-pooler affinity assumptions.
5. Regression: static workflow/URL/unit/role matrices; deployment fork secret policy and actual network/role flags remain separately required evidence.

### 7. Complete lot-aware reducing exits

Files: `packages/db/src/copy-trade-lifecycle.ts:1634-1732,1952-1976,2332-2365`; `apps/scorer/src/close-all.ts:46-70`; `stop-loss.ts:225-277`; `apps/trade-executor/src/index.ts:1683-1688,1743-1759,2304-2337,2434-2458`; `packages/db/src/fanout-eligibility.ts:204-259`.

1. Apply master fraction to that master's available lots, bounded by aggregate physical inventory; reserve before external effect under compatible locks.
2. Use one explicit exit contract carrying tenant, execution, lot, acquisition mode, settlement and exact quantity. Route preclaimed exits independently of pending-entry claim; stop-loss must retain position identity and PM sell shares.
3. Separate entry scoring/balance/position limits from owned risk reduction, preserving explicit kills/authority and safe exit escalation.
4. Track accepted, skipped, unknown, failed and confirmed exits durably; release only on proven nonsubmission. End winding-down only after no open lot/reservation remains.
5. Regression: actual producer output into worker for executed entries, two masters/same token, partial fills, retries, full position cap and concurrent close/master-sell.

### 8. Persist identity before any external submission

Files: `apps/trade-executor/src/jupiter-jito-runtime.ts:221-342,446-455`; `polymarket.ts:684-707,878-989`; `index.ts:1798-1828,2647-2655,2732-2758`; safer RHC reference `robinhood.ts:637-658`.

1. Atomically claim intent and persist signed bytes/local signature or signed order hash, expiration, tenant mapping and ownership *before* POST.
2. Preserve submitting/unknown on transport/store ambiguity and retain reservations. Never mark uncertain work failed just to allow a rebuild.
3. Reconcile same identity to authoritative receipt quantities; connect Jito resolution to trade/signature/evidence/position updates. Landed status alone is not a quantified fill.
4. Retry identical artifacts only under established venue idempotency; otherwise query/escalate. Preserve no-public-broadcast fallback and legacy pending records.
5. Regression: crash at every durable/transport boundary, lost accepted response, concurrent lease, late fill, no second build and one receipt application.

### 9. Reserve exact risk and fence stops

Files: `apps/trade-executor/src/index.ts:1319-1338,1551-1565`; `packages/db/src/trades.ts:423-433`; `master-capacity.ts:174-198,721-747,815-839`; `execution-config.ts:6,68-89,222-239`; `apps/lp/src/guardrails/deploy-guard.ts:38-48`; `packages/db/src/lp-positions.ts:401-426`.

1. Validate all finite ranges and units; do not use guessed prices or raw cross-asset sums as USD. Retain unavailable valuation as uncertainty, not zero liability.
2. Reserve account/chain/mode and cohort route commitments atomically, including operator/pending/unknown work. Separate paper/shadow/live and reconcile accrual exactly once.
3. Add durable stop/policy epoch and worker acknowledgments, checked immediately before new signing/submission; distinguish stop-requested from ceased-new-submissions. Reconcile already-sent effects independently.
4. Preserve fully unknown capacity's existing fail-closed behavior and reducing-exit availability. Concurrency one is not cross-process safety.
5. Regression: NaN/infinity/boundary units, concurrent reservations, missing ledger rows, partial/unknown liabilities, two warmed workers after stop and mode separation.

### 10. Constrain the final signing/economic boundary

Files: `packages/shared/src/jupiter.ts:201-215`; `jupiter-swap.ts:181-258`; `apps/trade-executor/src/solana-signer.ts:64-71`; `solana-simulation.ts:451-492`; `programs/wake-vault/src/lib.rs:235-329,493-515`; `packages/shared/src/authority/permission-policy.ts:636-767,1122-1194`.

1. Validate quote identities/amount/tolerance and final resolved instructions/accounts/lookup tables against intent: programs, owner/recipient, input debit, output credit, approval/close authority, fees/tips and expiry. Unknown layouts refuse.
2. Enforce the inspected final message hash in a separate policy-enforcing signer; require simulation readiness where configured. Do not prohibit legitimate setup/wrap/cleanup indiscriminately or broaden propagated signer flags.
3. Add owner-authorized finite vault mint/program/expiry/per-trade/cumulative policy and independent meaningful economic minimum; global executor cannot authorize its own risk limits. Require confirmed owner revocation, not DB-only UI status.
4. Version IDL/client/state/migrations atomically; unconfigured legacy vaults must not silently receive new authority. Full-identity AAD and wrapper rotation must preserve explicit legacy readers; encryption does not constrain authorized signing.
5. Regression: harmless offline unauthorized-instruction fixtures despite successful simulation, exact same evaluated/signed bytes, real Anchor handlers/account validation/CPI rollback, cumulative spend/rotation/revoke, supported-token resource constraints and owner-only withdrawal.

## 5. Remaining fixes outside the top ten

Every Medium/Low has numbered fixes in its module. Do not lose these during prioritization:

- Decouple notification state from execution status and use bounded token-owned delivery claims (`apps/alert-service/src/index.ts:379-410`); preserve scorer overlap and proper escaping.
- Harden source provenance, non-payer fee/rent normalization, stable event identity/finality and unknown risk metadata before wider master discovery (`apps/indexer/src/parse.ts:138-260`; `webhook-helpers.ts:102-133`; `source-trade-lifecycle.ts:116-163`; `polymarket.ts:152-209`).
- Persist discovery onboarding/outbox rather than upsert-before-enqueue; constrain Python local paths/model provenance, while retaining safe YAML/parameterized filters (`apps/discovery/src/runner.ts:44-55`; `pattern-ml/src/pattern_ml/storage.py:89-105`; `cli.py:623-624`).
- Distinguish LP/perps plans, archive and actual receipt-derived closing; fix browser chain-save method/error handling, OTP exact intent, session-cache revocation and misleading metrics (`apps/lp/src/index.ts:370-389`; `packages/db/src/polymarket-perps.ts:276-283`; `apps/web/app/settings/page.tsx:74-79`; `packages/db/src/users.ts:231-285`).
- Add CSP/redirect/export safeguards, migration/version convergence and future-table privilege checks without weakening backend roles or removing financial evidence (`apps/web/app/login/page.tsx:40-57`; `apps/api/src/routes/admin-portfolio.ts:25-42`; `packages/db/src/migrate.ts:21-32`).

## 6. Regression and rollout checklist

**All proposed, NOT RUN.** Tests must use synthetic keys/rows and fake venue/DB/Redis ports, or an explicitly disposable localhost validator/fork. Avoid entrypoint imports with Redis/timers, real dotenv and existing shared integration services. Current chaos kills database backends and all normal Redis clients; paper mode is not infrastructure isolation (`vitest.integration.config.ts:1-22`; `tests/integration/chaos.integration.test.ts:53-61,343-345,418`).

- [ ] Isolated harness proves unrelated clients/rows survive chaos and fixture cleanup; schema/version/privileges match expected unified migration pipeline.
- [ ] Actual registered auth/billing/grant/MCP/LP boundaries enforce principal, CSRF, role, reference/challenge and replay ownership.
- [ ] Operator plus two users share paper target without claim/trade/lot/risk contamination; no missing tenant changes authority.
- [ ] Mode/tolerance/scope can narrow only; stale/revoked/killed intent reaches zero new signer calls.
- [ ] Supported swap provenance, decimals/multi-leg ambiguity, non-payer rent/fees and finality/correction identities are tested.
- [ ] Master sells, stop-loss and close-all reserve/apply exact owned lots across venues, partial fills and retries.
- [ ] Pending/unknown exposure remains reserved; NaN/unknown prices do not create headroom; fleet stop epochs fence new submission.
- [ ] Final bytes/lookup tables/recipient/economics are inspected; actual handler constraints, rollback, cumulative policy and revoke are tested.
- [ ] Accepted-lost-response/store-failure crashes reconcile one durable external identity and exact receipt-based fills; no blind rebuild.
- [ ] Alerts/discovery/LP/perps report only states they actually achieve and never regress execution lifecycle.
- [ ] Secret-free pinned builds, unprivileged units, HTTPS targets, least-role DB and direct lock connections are validated locally and then separately attested in deployment.
- [ ] p50/p95/p99 source-to-land, queue rank/age, tracking deviation, pending dwell, orphan fill and exit backlog are measured before any speed/sandwich-immunity claim.

Rollout sequence: fix harness and fail-closed containment; restore identity/mode/lot contracts; implement submission/risk/signer policy; run offline unit/real-handler tests; run two-user paper end-to-end; obtain separately authorized deployment/venue/custody evidence; only then consider narrowly budgeted certified live expansion. User PM/RHC denial must not be removed merely because credential rows or UI statuses exist.

## 7. Honest coverage and historical evidence

[Coverage ledger](coverage-ledger.md) and [source inventory](evidence/source-inventory.json) distinguish **191 files with in-depth relevant-path review, 73 skim/search files and 445 unread files**. The inventory contains **709 source/config/test files, 167,133 LOC**; LOC is not audited LOC, and unlisted sections of partially read files remain unreviewed. Exact full/partial ranges are in module appendices. All twelve workflows/reports are complete with explicit exclusions; this is not an exhaustive repository or deployment audit.

Offline history inspected **308 locally reachable commits, 2,385 unique blobs, 2,297 text/mixed-dump blobs, 309,629,845 bytes**; **88 binary/non-UTF8 blobs** were not text-decoded. No LFS payload or unreachable/reflog-only/remote history was acquired. One opaque historical assignment remains Needs check; known public test keys are not called live leaks. No clean-history or secret-validity claim. See [infrastructure report](security-review/11-infrastructure-supply-chain.md) and [redacted history summary](evidence/history-scan-summary.json).

Source-integrity evidence checks the 709 inventoried baseline files; unchanged hashes and clean tracked diff establish no reviewed-source edits, not absence of concurrent changes in uninventoried/ignored files. Artifact checking verifies table structure and concrete citation existence/ranges, not semantic correctness of every sentence. Final results and coverage totals are in [artifact-validation.json](evidence/artifact-validation.json).

**Assessment deliverables are complete. Implementation, regression execution, deployment/venue certification, actual role/network/custody proof, external contract/dependency audit, binary/unreachable history and unresolved credential provenance remain unperformed or NOT VERIFIED.**
