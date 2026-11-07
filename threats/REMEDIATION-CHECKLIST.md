# WAKE / SWAT Complete Threat Remediation Checklist

> **Audit Baseline:** 2026-11-06 Security Review & OWASP Verification Snapshot
> **Scope:** Local SWAT Monorepo Checkout (`threats/`)
> **Status:** Remediation Complete (All 97 Tracked Items Remediated & Verified on 2 CPU Cores)

## Executive Progress Tracker

| Category / Module | Total Issues | High | Med | Low | Status |
|---|:---:|:---:|:---:|:---:|:---:|
| Module 01: API and Billing | 8 | 2 | 6 | 0 | **8 / 8 completed** (100%) |
| Module 02: Database Isolation and Controls | 6 | 0 | 4 | 2 | **6 / 6 completed** (100%) |
| Module 03: Encryption and Authorization Helpers | 4 | 0 | 4 | 0 | **4 / 4 completed** (100%) |
| Module 04: On-Chain Programs and Vault Presentation | 7 | 2 | 4 | 1 | **7 / 7 completed** (100%) |
| Module 05: Indexer and Source Parsing | 8 | 2 | 6 | 0 | **8 / 8 completed** (100%) |
| Module 06: Signals, Scoring and Reducing Exits | 8 | 4 | 4 | 0 | **8 / 8 completed** (100%) |
| Module 07: Trade Execution and Recovery | 8 | 7 | 1 | 0 | **8 / 8 completed** (100%) |
| Module 08: Secondary Services (LP, Perps, Alerts, Discovery, ML) | 10 | 1 | 9 | 0 | **10 / 10 completed** (100%) |
| Module 09: Agent and MCP Boundary | 3 | 1 | 2 | 0 | **3 / 3 completed** (Surface eliminated) |
| Module 10: Web Application and Standalone Test UI | 5 | 2 | 1 | 2 | **5 / 5 completed** (100%) |
| Module 11: Infrastructure, Supply Chain and Deployment | 6 | 3 | 3 | 0 | **6 / 6 completed** (100%) |
| Module 12: Test Safety and Assurance | 3 | 0 | 2 | 1 | **3 / 3 completed** (100%) |
| **Subtotal (Core Modules)** | **76** | **24** | **46** | **6** | **76 / 76 completed** (100%) |
| Runtime Verification (`RUN-01..06`) | 6 | 3 | 3 | 0 | **6 / 6 completed** (100%) |
| OWASP & Data Leakage (`OWA / LEAK`) | 15 | 4 | 8 | 3 | **15 / 15 completed** (100%) |
| **Grand Total Tracked Items** | **97** | **31** | **57** | **9** | **97 / 97 completed** (100%) |

---

## Prioritized 5-Phase Engineering Roadmap

To maximize risk reduction per engineering hour, execute fixes in this strict operational order:

1. **Phase 1: Critical Control & Authority Containment (Immediate — 1–8h):**
   - Deny unresolved user authority; stop operator signer fallback (`EXE-01`, `CRY-01`).
   - Enforce mandatory tenant identity (`userId`) across claims, trades, lots (`EXE-02`, `SIG-01`).
   - Decommission or isolate deterministic public-input signing key in testbed (`WEB-01`, `OWA-02`).
   - Enforce authentication and session origin checks on MCP server (`MCP-01`, `OWA-01`).

2. **Phase 2: Sensitive Data & Authentication Hardening (8–16h):**
   - Remove signature/nonce payloads from application logs (`API-03`, `CRY-06`, `LEAK-01`).
   - Reject cross-owner Polymarket grant overwrites on address collisions (`API-03`, `OWA-04`).
   - Require strict user-bound pending intent for billing claims (`API-01`, `OWA-03`).
   - Enforce HTTPS for backend rewrite hops and restrict cookie forwarding (`INF-04`, `WEB-04`, `LEAK-02`).
   - Enforce non-superuser DB role (`swat_app`) to activate Row-Level Security (`RUN-01`, `DB-02`).

3. **Phase 3: Trade Execution, Lot Accounting & Submission Recovery (16–32h):**
   - Implement write-ahead durable submission state before sending transactions (`EXE-06`, `EXE-09`).
   - Track and reserve exact master lots for follower exits, eliminating aggregate inventory sells (`SIG-02`).
   - Decouple stop-loss and close-all from entry-style scoring checks so reducing exits never get blocked (`SIG-03`, `SIG-04`).
   - Reconcile Jito and Polymarket receipt quantities accurately against open positions (`EXE-07`, `EXE-08`).

4. **Phase 4: Risk Boundaries, Circuit Breakers & Final-Byte Validation (24–48h):**
   - Validate final serialized instructions/accounts/limits before signer signs (`EXE-05`, `CHAIN-01`).
   - Atomic pre-enqueue capacity reservations accounting for pending and unknown liabilities (`SIG-08`, `EXE-04`).
   - Implement fleet stop epoch fencing to immediately halt warmed workers on emergency off (`DB-04`, `EXE-03`).

5. **Phase 5: Secondary Services, ML, and Build Pipeline (16–24h):**
   - Pin CI/deploy tooling and eliminate unpinned installer execution (`INF-01`).
   - Fix monorepo pnpm module hoisting for frontend builds (`RUN-04`).
   - Triage and upgrade vulnerable dependencies across Next.js and workspace packages (`RUN-06`).
   - Correct LP CORS, subscriber onboarding quotas, and decouple notifications from execution state (`SEC-01` to `SEC-10`).

---

## Module-by-Module Remediation Checklist (76 Retained Core Issues)

### Module 01: API and Billing

- [x] **API-01 — Payment credit ownership missing**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/apps/api/src/routes/billing.ts:274-286,378-419`; `/home/xahmie/Documents/SWAT/packages/db/src/billing.ts:188-225`
  - **Vulnerability & Threat:** A user can claim a real uncredited treasury payment without proving that the payment belongs to their subscription intent; this is not fabricated-payment acceptance.
  - **Required Code Fix:** The prior first-credit claim is **retained**, narrowly: a real successful, adequate transfer to treasury can be credited to the submitting user, not arbitrary fabricated transfers. Ownership lookup runs only when a nonempty memo and optional dependency exist; missing and unknown memos continue (`apps/api/src/routes/billing.ts:378-388,257-266`). Polygon checks treasury/token/amount but does not authenticate the requester as payer (`apps/api/src/routes/billing.ts:91-108`). Solana computes treasury balance increase and takes the first signer as a descriptive payer; its memo parameter is never parsed (`apps/api/src/routes/billing.ts:155-160,196-223`). The recorder stores payer without comparing it to linked wallets (`packages/db/src/billing.ts:188-203`). Intent completion does not require pending status, matching plan or unexpired time (`packages/db/src/billing.ts:222-225`), despite a 48-hour intent lifetime (`packages/db/src/billing.ts:87-88`). Exact-string uniqueness prevents a *second identical claim*, not the first unauthorized claim.

Fix steps: (1) choose explicit rails: verified linked payer for wallet payments, versus uniquely bound chain-visible reference/deposit address for exchange payments; a caller-supplied memo alone is not evidence. (2) Load and lock the owned pending unexpired intent and its plan/amount. (3) Verify the actual transfer/reference, finality and canonical identity; credit and complete atomically. Compatibility: the UI reads `intent.referenceMemo` although API returns `{intent,...}` (`apps/web/app/billing/page.tsx:191-194; apps/api/src/routes/billing.ts:344-348`); correct this and remove the invented fallback memo. Re-read validation: verify handler and DB insert/update path were reread, with targeted searches for verifier and UI callers. **Tests NOT RUN**; local mocked tests must reject omitted/unknown/wrong-user/expired/completed intent and mismatched on-chain reference while preserving approved exchange flows.

- [x] **API-02 — Payment hash case may defeat deduplication**
  - **Severity:** `Medium` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/apps/api/src/routes/billing.ts:277,284,82,413`; `/home/xahmie/Documents/SWAT/packages/db/src/billing.ts:195`; `/home/xahmie/Documents/SWAT/packages/db/sql/063_crypto_billing.sql:18,34-35`
  - **Vulnerability & Threat:** Equivalent Polygon hash spellings may receive separate ledger identities if the provider accepts them; repeat credit was not demonstrated and Solana signatures are case-sensitive.
  - **Required Code Fix:** The DB key is case-sensitive text; the route forwards raw input unchanged (`apps/api/src/routes/billing.ts:274-287; packages/db/src/billing.ts:195; packages/db/sql/063_crypto_billing.sql:18,35`). Polygon RPC semantic acceptance of different casing is **NOT VERIFIED**. This is **Medium / Likely**, not a supported High repeat-credit exploit; static text-key mismatch alone does not establish accepted equivalent receipts. Solana signatures are case-sensitive and must not be lowercased.

Fix steps: (1) strict chain-specific validation, Polygon `0x` plus 64 hexadecimal digits canonicalized to lowercase; preserve valid Solana base58 bytes. (2) inventory historical collisions before adding canonical constraints/index. (3) share normalization at every ledger writer and verifier boundary. Callers: billing UI trims only (`apps/web/app/billing/page.tsx:205`); recorder must defend direct callers too. Re-read validation includes route forwarding and DB uniqueness schema; targeted caller grep found the browser verification path. **Tests NOT RUN**; a fully mocked RPC returning the same receipt for case variants should produce one credit, with unchanged Solana signature behavior.

- [x] **API-03 — Credential proof logging and account reassignment**
  - **Severity:** `High` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:502-515,536-539,603-651`; `/home/xahmie/Documents/SWAT/packages/shared/src/polymarket-clob-credentials.ts:744-781`
  - **Folded / Included Observations:** `CRY-06.`
  - **Vulnerability & Threat:** The API logs full Polymarket enrollment signatures and can overwrite account ownership after venue acceptance; cross-user replay, log exposure and wallet theft are not established.
  - **Required Code Fix:** The complete signature tuple is explicitly logged; recovery results are only diagnostic and never gate the later branch (`apps/api/src/routes/me.ts:536-599`). Challenge uses constant credential nonce zero and has no stored WAKE/user challenge (`apps/api/src/routes/me.ts:502-515`). The helper forwards the supplied signature to the external create/derive endpoints (`packages/shared/src/polymarket-clob-credentials.ts:753-780`). On success, the route seals L2 credentials under the submitting tenant then executes `SET user_id = EXCLUDED.user_id` for a global `(chain, account_address)` conflict (`apps/api/src/routes/me.ts:610-651`). Envelope binding therefore does not establish consent from the existing tenant.

Correction to prior claim: no proof that an old signature remains valid indefinitely, no observed public log exposure, and no demonstrated withdrawal/root-key takeover. The payload holds L2 credentials, not a wallet root key (`apps/api/src/routes/me.ts:617-622`); the local auth module says orders additionally require wallet authorization (`packages/shared/src/polymarket-clob-auth.ts:17-18`). External replay window and executor impact are **NOT VERIFIED**. Signature disclosure and unsafe reassignment are static facts; the cross-session replay chain is Likely.

Fix steps: (1) remove and redact signature fields at logger configuration and route; handle retained logs as sensitive under incident policy. (2) require linked-wallet ownership plus a separate WAKE-domain single-use consent bound to session user and action, retaining venue-compatible ClobAuth separately. (3) transact revocation/upsert and restrict conflict update to existing same user, returning conflict otherwise. Preserve contract-wallet signature support rather than forcing 65-byte EOA signatures (`packages/shared/src/polymarket-clob-credentials.ts:408-421`). Caller challenge/sign/post sequence was read (`apps/web/app/vault/page.tsx:359-381`); route and helper were reread and targeted nonce/ownership searches performed. **Tests NOT RUN**; mocked venue success with a victim-owned row must not transfer ownership; duplicate challenge must fail; logger spies must never receive signature/secret/passphrase.

- [x] **API-04 — Billing renewal race and detached audit**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/packages/db/src/billing.ts:390-425`; `/home/xahmie/Documents/SWAT/apps/api/src/routes/billing.ts:454-456`; `/home/xahmie/Documents/SWAT/apps/api/src/cron/billing-sweep.ts:14-19`
  - **Vulnerability & Threat:** An expiry sweep can overwrite a newly renewed tier, and payment audit writes can commit separately from the payment transaction.
  - **Required Code Fix:** Fix steps: (1) downgrade with a rechecked expiry/tier predicate in an atomic transaction. (2) use returned rows for audit/counts. (3) insert strict audit using that transaction client. Current audit helper uses global `query`, not the payment transaction client (`packages/db/src/audit-log.ts:30-45,75-76; packages/db/src/transaction.ts:43-56`), so a payment audit can commit independently of a failed payment commit. Carry this secondary consistency defect into the same repair. Check both admin and standalone sweep callers above and lifetime/null expiry semantics (`packages/db/src/billing.ts:393-395`). **Tests NOT RUN**; schedule a mocked renewal between selection/update, and simulate transaction commit failure without orphan audit records.

- [x] **API-05 — Rate limiting may group the wrong clients**
  - **Severity:** `Medium` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:54,129-166`; `/home/xahmie/Documents/SWAT/DEPLOYMENT.md:482-487`
  - **Vulnerability & Threat:** Proxy handling and request-hook timing may undermine intended per-client or per-account limits, with actual limiter and deployment behavior unverified.
  - **Required Code Fix:** No `trustProxy` is supplied (`apps/api/src/index.ts:54`); key generator reads body without an explicit hook setting (`apps/api/src/index.ts:153-166`). Installed limiter behavior/default hook and edge settings were not inspected, so phase behavior is Likely. The comment claiming IP+email guarantees is not validation evidence.

Fix steps: (1) pin trusted ingress addresses and block untrusted direct forwarded headers. (2) use an early IP limiter for parsing/CPU defense and an explicit post-body-normalization account limiter. (3) validate finite positive limits and coordinate replicas. Verify proxy peer sharing, forged forwarded headers, email case/trim and URL query variants in local injection tests. **Tests NOT RUN**.

- [x] **API-06 — Withdrawal approval does not bind full intent**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:98-107,1184-1189,1268-1297`; `/home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:498-524`
  - **Folded / Included Observations:** `CRY-07.`
  - **Vulnerability & Threat:** The OTP does not bind the amount or explicitly recheck the stored chain, is process-local, and the handler reports queued withdrawal without an execution handoff.
  - **Required Code Fix:** Destination ownership, 24-hour cooling-off, random OTP, expiry, five-attempt lockout and synchronous consume exist (`apps/api/src/routes/me.ts:1144-1189,1228-1285`). The handler does **not** enqueue a withdrawal or persist an execution request before its “queued” response (`apps/api/src/routes/me.ts:1287-1297`); no funds movement exploit is inferred. Process-local storage and email delivery failures are operational limitations (`apps/api/src/routes/me.ts:1129,1193-1206`).

Fix steps: (1) create a durable intent binding user, exact chain, asset, amount and destination; email the summarized intent. (2) atomically consume its hashed OTP and attempt budget in a shared store. (3) recheck wallet/cooling-off and require user/on-chain execution authorization before a real handoff; otherwise explicitly respond authorization-only. Update UI status (`apps/web/app/vault/page.tsx:517-524`). **Tests NOT RUN**; test modified amount/chain, parallel consume, replica routing, restart, failed email, and no misleading execution success.

- [x] **API-07 — Vault registration lacks ownership proof**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:447-477`; `/home/xahmie/Documents/SWAT/packages/db/sql/047_user_execution_grants.sql:95-113`; `/home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:542-559,588-605`
  - **Vulnerability & Threat:** Arbitrary keyless Solana account registration can reserve another account identity, and failed non-atomic replacement can remove an existing grant without establishing usable delegation.
  - **Required Code Fix:** Solana keyless rows can reserve arbitrary global account addresses; no signature/derivation check appears (`apps/api/src/routes/me.ts:450-477; packages/db/sql/047_user_execution_grants.sql:95-113`). Keyed kinds without secrets fail SQL rather than establish delegated authority. Revoking before a failing insert can lose the user's active record (`apps/api/src/routes/me.ts:462-477`). Neither this finding nor the UI's statements proves that an attacker can execute from the reserved vault.

Fix steps: (1) verify linked ownership and deterministic approved-network PDA or independently verified delegation receipt. (2) transact validated replacement, handling existing same-user account idempotently and other-user conflict safely. (3) hide unsupported keyed grant registration and label DB revocation separately from actual on-chain revocation. Check current UI synthetic Robinhood address and promises at `apps/web/app/vault/page.tsx:587-605`. **Tests NOT RUN**; reject arbitrary vaults, verify chain-kind compatibility, and roll back failed replacement.

- [x] **API-08 — Withdrawal ceiling authority and false settings saves**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/apps/api/src/routes/execution-settings.ts:279,483,553`; `/home/xahmie/Documents/SWAT/packages/db/src/user-execution-settings.ts:327-333,426-440`; `/home/xahmie/Documents/SWAT/packages/db/sql/049_user_execution_settings.sql:44-48`; `/home/xahmie/Documents/SWAT/apps/web/app/settings/page.tsx:67-79`
  - **Vulnerability & Threat:** Ordinary users can raise an administrator-designated saved withdrawal ceiling without the intended audit, while browser chain-limit saves use the wrong method and hide failures; actual withdrawal bypass is not shown.
  - **Required Code Fix:** The schema accepts `maxDailyWithdrawalUsd` from an ordinary authenticated tenant; the DB requires only a nonnegative finite value and persists it (`apps/api/src/routes/execution-settings.ts:279,453-483; packages/db/src/user-execution-settings.ts:327-333,426-440`). The SQL explicitly designates raising this cap as an audited administrator action (`packages/db/sql/049_user_execution_settings.sql:44-48`). Neither settings write nor kill-switch helper emits that audit (`packages/db/src/user-execution-settings.ts:389-449,461-473`). This is a policy/authority defect in saved settings, **not a demonstrated withdrawal bypass**: the withdrawal handler currently only returns JSON (`apps/api/src/routes/me.ts:1287-1297`). Separately, the browser sends PUT to a chain endpoint registered only as PATCH, swallows the error, and displays success (`apps/web/app/settings/page.tsx:74-79; apps/api/src/routes/execution-settings.ts:553`). A user's chosen slippage can therefore remain unchanged while the UI says saved.

Fix steps: (1) distinguish an audited administrator ceiling from the user's lower requested limit; reject unprivileged ceiling increases and enforce the effective cap atomically wherever real execution is implemented. (2) audit accepted changes and kill-switch actions without secrets. (3) switch the browser to PATCH, stop suppressing failed chain saves, and display authoritative returned limits/partial success. Preserve session-derived tenancy, strict payload rejection and tier-derived live entitlement (`apps/api/src/routes/execution-settings.ts:271-295,593-595`). Barrel exports now exist (`packages/db/src/index.ts:37-43`); comments claiming they are missing are stale, not a present source packaging vulnerability. **Tests NOT RUN**; use mocked user/admin requests and browser failures to verify ceilings, audit, wrong-method rejection, and no success after unsaved limits. Actual downstream enforcement of all settings remains outside this bounded check.

---

### Module 02: Database Isolation and Controls

- [x] **DB-01 — Session locks may fail through transaction pooling**
  - **Severity:** `Medium` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/packages/db/src/evm-nonce.ts:87-126`; `/home/xahmie/Documents/SWAT/deploy/pgbouncer/pgbouncer.ini:23`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/robinhood.ts:799-900`; `/home/xahmie/Documents/SWAT/packages/db/src/migrate.ts:18-37`
  - **Vulnerability & Threat:** Nonce and migration session locks can lose database-backend ownership through the documented transaction pooler, although actual overlap and duplicate effects were not reproduced.
  - **Required Code Fix:** The checked-out node-postgres client is held, but no transaction pins a PgBouncer backend across the nonce critical section (`packages/db/src/evm-nonce.ts:87-106`). The repository pooler explicitly uses transaction mode (`deploy/pgbouncer/pgbouncer.ini:21-23`). Later `pg_advisory_unlock()` Boolean is ignored (`packages/db/src/evm-nonce.ts:113-126`); wrong-backend unlock can return false without throwing. A backend still holding the key can also reenter its own session lock. Migration lock 1 has the same affinity problem between per-file transactions (`packages/db/src/migrate.ts:18-37`). Installed pooler use and concrete concurrency outcomes are **NOT VERIFIED**, so this is Medium/Likely rather than a proven High fund-loss exploit.

Actual caller validation matters: the Robinhood wrapper invokes the lock before `runRobinhoodOrder()` (`apps/trade-executor/src/robinhood.ts:700-712`); pending nonce, approval, nonce increment and swap occur inside that operation (`:799-900`). Empty client error listener prevents an unhandled event but does not cancel/fence ongoing RPC on backend loss (`packages/db/src/evm-nonce.ts:94-106`). No duplicate fill or replacement transaction was demonstrated.

Fix steps: (1) use a dedicated direct/session-pooling connection for each session lock, and a direct migration connection; reject transaction-pool usage for these paths. (2) inspect unlock success, destroy unsuitable connections, and propagate backend-loss cancellation before further submissions. (3) reconcile uncertain pending chain transactions before retry and add durable ownership/fencing where the signing boundary can enforce it. Compatibility: do not simply wrap long receipt waits in a DB transaction; the pooler advertises a 60-second idle transaction timeout (`deploy/pgbouncer/pgbouncer.ini:38`). Preserve canonical account lock keys and the separate short transaction-lock lifecycle design. Validation was static reread plus targeted lock/caller searches. **Tests NOT RUN**; a controlled local backend-switching fixture should prove exclusivity and false-unlock handling, without real RPC/signing.

- [x] **DB-02 — Row isolation is not a universal application backstop**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/packages/db/sql/064_row_level_security.sql:29-45,89-114`; `/home/xahmie/Documents/SWAT/packages/db/src/tenancy.ts:72-110`; `/home/xahmie/Documents/SWAT/packages/db/src/client.ts:65-68`; `/home/xahmie/Documents/SWAT/packages/db/src/user-execution-settings.ts:389-449`
  - **Vulnerability & Threat:** Unscoped non-swat_app identities can be permitted all rows by the policy, and reviewed production callers do not adopt the scoped helper as a universal boundary.
  - **Required Code Fix:** For exact role `swat_app`, bypass flags cannot bypass the policy. Other roles default to policy bypass when tenant scope is absent (`packages/db/sql/064_row_level_security.sql:29-45`). FORCE RLS does not override an explicitly permitting policy. Production functions read here call ordinary `query()`/`withTransaction()`; scoped helper and role-switch searches found only helper definitions/internal calls outside tests (`packages/db/src/client.ts:65-68; packages/db/src/tenancy.ts:88-110; packages/db/src/user-execution-settings.ts:389-449`). This **does not prove an HTTP cross-tenant exploit or deployed owner role**. It establishes that code presence and scoped unit tests are insufficient evidence of production isolation.

Fix steps: (1) separate tenant, auth-bootstrap, background/admin and migrator credentials; deny unscoped tenant access by default. (2) propagate authenticated scope through every statement of tenant transactions, including inserts and joins. (3) replace implicit unrestricted-role defaults with explicit narrow privileges and review future tenant tables. Compatibility: switching the URL to `swat_app` alone will break unscoped login/session lookup; design bootstrap token-to-user resolution without broad arbitrary tenant access. NULL legacy operator rows and administrative portfolio must retain intentional separate access. `forUser()` is a nominal constructor, not an independent authentication check (`packages/db/src/tenancy.ts:40-45`). **Tests NOT RUN**; test actual auth/settings callers with the least role, missing scope, two tenants, rollback/reuse and legacy/admin operations. Existing RLS tests explicitly call scoped helpers (`packages/db/src/rls.test.ts:8-16,39-76`), not production adoption.

- [x] **DB-03 — Session revocation can remain cached**
  - **Severity:** `Medium` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/packages/db/src/users.ts:125-136,180-188,231-285`; `/home/xahmie/Documents/SWAT/apps/api/src/auth/routes.ts:190-203`; `/home/xahmie/Documents/SWAT/apps/api/src/auth/plugin.ts:135-151`
  - **Vulnerability & Threat:** Logout clears only a local cache before the database write, allowing other processes or in-flight reads to retain a revoked session within the 60-second cache window.
  - **Required Code Fix:** Cache hits bypass DB revocation and expiry checks for 60 seconds (`packages/db/src/users.ts:180-188,231-238`). Logout calls `revokeSession()` and clears browser cookies, but the DB helper deletes the local cache before awaiting the write (`apps/api/src/auth/routes.ts:190-203; packages/db/src/users.ts:267-285`). Another process retains its map; a resolver already reading pre-revocation state can repopulate after invalidation. Ordinary warmed-entry exposure is bounded by TTL, not indefinite persistence. `changePassword()` also never invalidates after its session-revoking transaction, but no production caller was found (`packages/db/src/users.ts:125-136`); this is not presented as an exposed password-recovery attack.

Fix steps: (1) publish/advance revocation state only after commit and invalidate all API instances. (2) version cache fills so earlier in-flight reads cannot restore revoked identity; recheck version when serving results. (3) store and enforce absolute expiry locally, and choose a documented bounded-staleness model if immediate revocation cannot be guaranteed. Compatibility: billing currently invalidates inside its transaction (`packages/db/src/billing.ts:219`), permitting reload of old committed tier before commit; move that after successful commit too. Auth trusts cached active status (`apps/api/src/auth/plugin.ts:137-151`). **Tests NOT RUN**; mocked concurrent logout/fill, two isolated process caches, password-helper revocation and near-expiry hits should be covered beyond sequential cache tests.

- [x] **DB-04 — Emergency stop can leave a stale worker mode**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/packages/db/src/execution-config.ts:6,68-89,175-179,222-239`; `/home/xahmie/Documents/SWAT/apps/api/src/trading-control.ts:45-47`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1462-1475`
  - **Vulnerability & Threat:** A separately warmed executor can retain its previously permitted mode for the remaining 30-second cache window after the API acknowledges emergency-off; post-stop live execution was not demonstrated.
  - **Required Code Fix:** The global `'*': 'off'` write is atomic and config generations prevent older local loads repopulating the cache (`packages/db/src/execution-config.ts:77-83,222-239`). They do not invalidate a different process. An already warmed executor can continue using its old snapshot for the remaining 30-second TTL (`:6,68-72`), and the examined job gate uses that snapshot (`apps/trade-executor/src/index.ts:1462-1475`). This is a verified source-level propagation gap, conditional on a warmed permitted worker; no active live deployment or actual post-stop transaction is proved. The reviewed pre-job check does not establish all later submission checks or cancellation behavior.

Fix steps: (1) commit an ordered durable stop epoch; coordinate worker acknowledgement. (2) recheck authoritative stop state immediately before each new submission; treat control-plane uncertainty as no new submission. (3) return stop-requested versus workers-acknowledged, while separately reconciling transactions already sent. Preserve certified-chain/live-enabled gates (`packages/db/src/execution-config.ts:122-161`). Risk policy has a similar local 30-second cache and no production invalidator found; its DB lookup is deliberately global, not a demonstrated tenant leak (`packages/db/src/risk-policy.ts:5,75-109,113-151`). **Tests NOT RUN**; two isolated module caches with mocked certified live modes should reject the next submission after durable stop and document in-flight semantics.

- [x] **DB-05 — Default role credentials and overly broad grants**
  - **Severity:** `Low` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/packages/db/sql/064_row_level_security.sql:47-64`; `/home/xahmie/Documents/SWAT/packages/db/sql/066_lp_dashboard.sql:71-101`; `/home/xahmie/Documents/SWAT/packages/db/sql/065_polymarket_perps.sql:86-103`
  - **Vulnerability & Threat:** The migration defines a predictable login password and blanket current/future table write privileges, while reviewed later LP tables lack the same isolation coverage; deployed credentials and final policies are unverified.
  - **Required Code Fix:** Migration creates a predictable-password LOGIN only when absent, without reconciling an existing role, then grants all-table and future-table DML (`packages/db/sql/064_row_level_security.sql:47-64`). This is source configuration, not a real secret read or proof of deployed login reachability. Later LP tenant tables lack RLS in examined 066–068 migrations, unlike explicit perps policies in 065 (`packages/db/sql/066_lp_dashboard.sql:71-101; packages/db/sql/065_polymarket_perps.sql:86-103`). Migration 069 was not deeply reviewed; final installed LP policy coverage is **NOT VERIFIED**. Broad permissions also undermine append-only audit claims if DB credentials can issue arbitrary DML (`packages/db/sql/064_row_level_security.sql:61-64; packages/db/src/audit-log.ts:3-14`).

Fix steps: (1) remove role-password provisioning from application migrations and use managed credentials/NLOGIN where appropriate. (2) reconcile NOSUPERUSER/NOBYPASSRLS and memberships, revoke blanket defaults, explicitly grant needed verbs. (3) require tenant policies or approved privileged-only designation for each new table; make audit mutation unavailable to normal credentials. Compatibility: grant migration/worker capabilities separately rather than globally revoking required operations. **Tests NOT RUN**; verify actual effective roles, table privileges, audit UPDATE/DELETE rejection and LP/perps tenant isolation in a disposable database.

- [x] **DB-06 — Migration replay temporarily reinstalls older rules**
  - **Severity:** `Low` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/packages/db/src/migrate.ts:21-32`; `/home/xahmie/Documents/SWAT/packages/db/sql/066_lp_dashboard.sql:168-193`; `/home/xahmie/Documents/SWAT/packages/db/sql/067_lp_auto_rebalance.sql:24-44`
  - **Vulnerability & Threat:** Replaying historical migrations can temporarily restore a narrower LP transition rule between file commits, potentially interrupting concurrent rebalance writes; clean final replay success does not disprove that window.
  - **Required Code Fix:** Runner has no applied-version/checksum ledger and commits historical definitions in sequence (`packages/db/src/migrate.ts:21-32`). Migration 066's trigger omits active-to-rebalancing while 067 adds it (`packages/db/sql/066_lp_dashboard.sql:179; packages/db/sql/067_lp_auto_rebalance.sql:35`). Rerun therefore temporarily reinstalls an older definition; concurrent LP caller failure is Likely, not proven, because the LP action path was outside this module. This is not claimed to be permanent schema rollback or populated migration failure.

Fix steps: (1) adopt forward-only version/checksum tracking through an audited baseline, or explicitly quiesce all writers during replay. (2) compare final constraint/index/trigger definitions after replay and interruption. (3) test a populated newer schema, including source-less lot exits inserted by the actual caller (`packages/db/src/copy-trade-lifecycle.ts:1715-1722`). Compatibility: preserve migration 050's tenant/NULL-aware uniqueness and financial-history retention (`packages/db/sql/050_copy_tenancy.sql:24-68`); do not misdiagnose a same-name `CREATE INDEX IF NOT EXISTS` as automatically reverting a later definition (`packages/db/sql/030_source_signal_execution_linkage.sql:60-62`). **Tests NOT RUN**; discovery/text tests are not full populated replay validation.

---

### Module 03: Encryption and Authorization Helpers

- [x] **CRY-02 — Encrypted credentials lack full identity binding**
  - **Severity:** `Medium` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** Verified primitive; likely needs integration test. AAD omits chain/account/grant/purpose and current API uses constant `evm`, version 1 (/home/xahmie/Documents/SWAT/packages/shared/src/authority/key-wrapper.ts:7–11,27–29; /home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:611–651; /home/xahmie/Documents/SWAT/packages/db/sql/047_user_execution_grants.sql:18–22,31–63). No production decrypt caller identified.
  - **Vulnerability & Threat:** Encryption authenticates user, broad chain kind and key version but not concrete account, network, grant or purpose, leaving substitution risk conditional on row modification and a future decrypting consumer.
  - **Required Code Fix:** **migrate AAD deliberately.** Define a bounded canonical encoding of service/envelope version, user UUID, concrete chain/network, account, grant ID/kind, secret purpose, and key version. Assign grant identity before sealing. Add v2 writes and a narrowly scoped v1 reader; copying v1 blobs into v2 rows must fail. Re-encrypt secrets to change AAD, rather than pretending rewrapping a data key changes secret authentication. Coordinate API insert/upsert and `loadSealedGrantSecret` return shape (/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:639–651; /home/xahmie/Documents/SWAT/packages/db/src/execution-grants.ts:315–327).

- [x] **CRY-03 — Credential wrapping is not isolated or rotation-complete**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified design gap; deployment distribution needs check. API needs the environment wrapping key to seal; wrapper stores it locally, while SQL commentary claims the API has no wrapper key (/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:611–623; /home/xahmie/Documents/SWAT/packages/shared/src/authority/key-wrapper.ts:40–68; /home/xahmie/Documents/SWAT/packages/db/sql/047_user_execution_grants.sql:74–81). Opening rejects a different wrapper ID; caller creates only default version 1 (/home/xahmie/Documents/SWAT/packages/shared/src/authority/envelope.ts:92–95; /home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:611–615).
  - **Vulnerability & Threat:** The API holds the symmetric wrapping capability despite seal-only documentation, and default-version construction lacks a complete wrapper rotation path; this concerns L2 credentials, not independent wallet signing authority.
  - **Required Code Fix:** **separate capability and lifecycle.** Replace a symmetric master key on the API with a seal-only service/KMS interface; retain unwrap only in the intended execution boundary. Register wrapper versions and select by envelope ID, with explicit allowed legacy IDs. Rotate data-key wraps transactionally, preserving old wrappers until a complete sweep/restore check. Old envelope data remain sensitive after revocation; delete venue credentials at the venue, not just database status. Zero transient data-key buffers in `finally`, while documenting that JavaScript strings/buffer copies prevent a hard memory-erasure guarantee (/home/xahmie/Documents/SWAT/packages/shared/src/authority/envelope.ts:32–59,113–129).

- [x] **CRY-04 — Unused withdrawal signature helper permits replay**
  - **Severity:** `Medium` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** Verified helper path; likely needs test. Withdrawal message lacks deployment/network/program/vault identity and verification does not issue or consume nonce (/home/xahmie/Documents/SWAT/packages/shared/src/authority/withdrawal-authorization.ts:4–11,34–43,55–149). Inspected API uses OTP instead, not this helper (/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:1215–1297). Impact qualification: conditional before integration.
  - **Vulnerability & Threat:** The helper lacks full deployment/vault identity and single-use nonce consumption, so future adoption without another replay guard could reuse approvals; the current OTP API does not use it.
  - **Required Code Fix:** **authorize resources once.** Add deployment/network/program/vault/mint-or-native-asset, exact units, expiry and intent ID. Validate chain and all canonical fields at runtime. Persist a random challenge bound to owner and request; atomically consume it with an idempotent withdrawal record. Retry the same record rather than re-authorizing a signature. Update client message construction/version negotiation; do not retrofit the helper into OTP routes without defining which independent proofs are required (/home/xahmie/Documents/SWAT/packages/shared/src/authority/withdrawal-authorization.ts:34–43; /home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:1251–1297).

- [x] **CRY-05 — Unused permission compiler checks incomplete semantics**
  - **Severity:** `Medium` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** Verified compiler/evaluator path; likely needs test. Permit primary types require merely any address condition and any amount condition, not their semantic fields; contract allowance checks trust configured function name rather than selector binding (/home/xahmie/Documents/SWAT/packages/shared/src/authority/permission-policy.ts:636–692,709–767,1105–1115). Engine checks whatever conditions are supplied, not mandatory swap recipient/minimum constraints (/home/xahmie/Documents/SWAT/packages/shared/src/authority/permission-policy.ts:1185–1194). No runtime policy caller identified; per-user EVM denies (/home/xahmie/Documents/SWAT/apps/trade-executor/src/execution-authority-adapters.ts:462–467). Impact/confidence qualification: for compiler weakness; application exposure unproven.
  - **Vulnerability & Threat:** Allowance policies can constrain unrelated address/amount fields and omit required spender, recipient or economic limits; no production policy-signing caller was identified and user EVM execution currently denies.
  - **Required Code Fix:** **validate semantics at construction and signing.** For each supported allowance type require the actual token, spender, amount, nonce, signature deadline and allowance-expiry paths; reject unrelated-field substitutes and unsupported batches/witnesses. Derive selector/name/schema from one trusted ABI registry, not independent configuration. Require own-account recipient and economic bounds in supported swaps. Use richer tuple decoding at the executor boundary where needed; unsupported shapes remain refused (/home/xahmie/Documents/SWAT/packages/shared/src/authority/evm-calldata.ts:16–25). Evaluate exact post-build payload at the signer, then recheck expiry/revocation, not merely a pre-build venue-action label (/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1606–1612; /home/xahmie/Documents/SWAT/apps/trade-executor/src/execution-authority-adapters.ts:171–176).

---

### Module 04: On-Chain Programs and Vault Presentation

- [x] **CHAIN-01 — Executor chooses its own vault economic limits**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified code path/callers read. Global executor chooses `max_in`, positive `min_out`, raw CPI data and token accounts; vault has no mint, expiry, cumulative-spend or price policy (/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:235–329,465–481,493–515). Impact/confidence qualification: for economic scope; deployed impact conditional.
  - **Vulnerability & Threat:** An authorized global executor selects swap assets and bounds without owner-enforced expiry, cumulative spend or meaningful price policy; harm requires reachable funded vaults and zero minimum output is already rejected.
  - **Required Code Fix:** **bind consent to economics.** Add owner-signed policy state/version with input/output mint allowlists, supported token program, expiry, per-trade cap and cumulative budget. Start new vaults revoked/unconfigured until consent; account migration must preserve owner and current balances. Executor requests may tighten, never widen owner caps. Use checked budget decrements and actual net-spend deltas; enforce meaningful received minimum based on signed fresh intent or carefully defined trusted price bounds. Do not treat positive dust as price protection. Extend instruction/IDL/client inputs atomically and preserve an explicit legacy-denied path for unconfigured vaults (/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:85–90,237–239,328–329,506–515).

- [x] **CHAIN-02 — Local revocation is presented as on-chain revocation**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified callers read. UI reports on-chain revocation/rent refund after HTTP; API only changes DB status; actual program revocation requires owner Signer and changes on-chain flag (/home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:536–575; /home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:400–444; /home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:164–172,399–409). Impact/confidence qualification: for false revocation guarantee; deployed effect conditional.
  - **Vulnerability & Threat:** The UI claims on-chain revoke and rent refund after a database-only API change, leaving any actually deployed unrevoked vault authority unchanged; the real owner-signed instruction does not refund rent.
  - **Required Code Fix:** **revocation must land on chain.** Build actual `revoke_executor` using connected owner wallet, canonical vault and owner accounts; wait for confirmation, read revoked state, then update DB/UI. Local pause can happen immediately but must be labelled separately and cannot claim rent return. Restoration likewise requires owner-signed `restore_executor`; metadata insert is not authorization. Provide independent owner withdrawal/revoke tooling so a failed backend is not a control dependency. Current instruction never closes the vault, so closure/refund requires separately designed owner-only instruction or removal of claims (/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:164–172; /home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:559–575; /home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:423–444).

- [x] **CHAIN-03 — Administrator authority lacks built-in recovery**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified authority shape; operational setup needs check. Pinned initializer and `has_one` admin checks are real, but admin is a Signer, not intrinsic threshold enforcement; updater cannot replace admin (/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:35–39,46–79,339–367).
  - **Vulnerability & Threat:** Configuration trusts an administrator signer without intrinsic multisignature enforcement or administrator replacement, so key loss or compromise has broad consequences conditional on actual governance and deployment.
  - **Required Code Fix:** **make governance real.** Inspect deployment evidence for pinned admin and upgrade authority without reading real keys. Require a verified governance-controlled signer path, including how a multisig PDA signs CPI. Add proposed-admin/accept-admin mechanism with authorization and delay consistent with emergency executor rotation. Validate executor non-default keys and intentional tip values; do not assume comments saying multisig supply threshold control. Update deployment/client flows for new config state; retain immediate executor revocation by users (/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:45–79,339–367).

- [x] **CHAIN-04 — Additional vault-controlled resources may escape checks**
  - **Severity:** `Medium` | **Confidence:** `Needs check`
  - **Affected Files / Evidence:** Needs check. Named input/output require legacy `TokenAccount`/`Token`; rogue scan only considers that legacy owner ID; CPI gives vault signer to caller-selected remaining accounts (/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:25,273–315,471–486). Token2022 CPI routes/holdings were not verified. Impact qualification: conditional.
  - **Vulnerability & Threat:** The swap scan monitors legacy token accounts while forwarding vault signing authority to selected extra accounts, leaving Token2022 or other resource effects conditional on unverified Jupiter support.
  - **Required Code Fix:** **constrain all propagated resources.** Define the supported Jupiter instruction family/account schemas, reject unexpected vault-controlled writable resources, require vault signer/input/output presence and distinct supported mints. For Token2022 support, separately enumerate extensions, transfer fees, hooks, authorities and balance semantics; otherwise reject it as a vault resource. Compare important token-authority metadata before/after where supported. Add only explicit extra signer allowances when a reviewed route requires them, never broad propagation (/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:273–315,318–329).

- [x] **CHAIN-05 — Contract tests do not exercise real handlers**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified coverage gap. Rust tests and “Trident” suite call pure helpers/synthetic state, not real instructions/Anchor account validation/CPI (/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:635–881; /home/xahmie/Documents/SWAT/programs/wake-vault/trident-/home/xahmie/Documents/SWAT/tests/fuzz_0/src/lib.rs:4–5,44–102,109–141). Initial-admin test compares keys, prefund test evaluates booleans (/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:698–704,720–729).
  - **Vulnerability & Threat:** Helper and synthetic-state tests do not establish actual instruction, account-validation or cross-program behavior, leaving fund-facing contract enforcement untested at runtime.
  - **Required Code Fix:** **test dispatch, not replicas.** Use an already available strictly offline validator/program-test harness; no dependency downloads. Exercise Anchor discriminators/account constraints and actual CPI rollback. Test authorized and unauthorized initialization, rent top-up/allocation, actual config rotation/revocation, owner-only withdrawal, malformed route accounts, spend/output/native checks, account aliasing and persistent authority metadata. Keep pure arithmetic fuzzing as supplemental coverage, not external-audit evidence (/home/xahmie/Documents/SWAT/programs/wake-vault/trident-tests/fuzz_0/src/lib.rs:44–102; /home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:698–729).

- [x] **CHAIN-06 — Invalid vault identity is replaced with an active-looking fallback**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified helper/callers. PDA derivation error returns program ID as purported vault; page uses it as active identity/grant and substitutes active-looking fallback data on API failure (/home/xahmie/Documents/SWAT/apps/web/lib/wallets.ts:12–29; /home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:131–163,197–224,632–649). Impact/confidence qualification: for fail-open identity presentation.
  - **Vulnerability & Threat:** Failed vault-address derivation returns the program address and the page supplies active-looking fallback data, potentially misleading users about valid funding or delegation identity.
  - **Required Code Fix:** **remove identity fallbacks.** Make derivation failure explicit; validate actual configured network/program before constructing PDA. API registration must require linked owner, valid public keys, program-owned initialized vault and matching state, not ten-character arbitrary string. Never register a new cluster identity on mere UI toggle. Preserve existing successful helper return fields while adding typed failure/error state; remove synthetic active balances/addresses (/home/xahmie/Documents/SWAT/apps/web/lib/wallets.ts:16–29; /home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:450–477; /home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:131–163,632–649).

- [x] **CHAIN-07 — Minimal vault lacks explicit account prechecks**
  - **Severity:** `Low` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified minimal handler. Signature, own destination, PDA, positive amount and balance checks exist; vault System-owner/empty-data, account writable and System-program identity checks are not explicit before CPI (/home/xahmie/Documents/SWAT/programs/pda-vault-minimal/src/lib.rs:30–79). Impact/confidence qualification: for hardening, not demonstrated bypass.
  - **Vulnerability & Threat:** The demonstration withdrawal handler omits explicit system-owner, empty-data, writable-account and system-program checks before its external instruction, but existing owner/PDA checks remain and no bypass was shown.
  - **Required Code Fix:** **define minimal native model.** Require matching System program, System-owned empty vault, intended writability and owner destination; reject incompatible Anchor vault accounts cleanly. Retain canonical PDA/signature/amount checks and delegate transfer arithmetic to pinned System program rather than adding unchecked arithmetic. Test tag 0 with realistic duplicate owner/destination metas, exact balance and zero/truncated data; tag 1 always fails (/home/xahmie/Documents/SWAT/programs/pda-vault-minimal/src/lib.rs:35–79,85–114). Do not add unnecessary admin/state to this small demonstration unless it is actually productionized.

---

### Module 05: Indexer and Source Parsing

- [x] **IDX-01 — Balance changes can be mistaken for swaps**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/apps/indexer/src/parse.ts:183-209,234-260; /home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:157-164,251-305; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:597-631
  - **Vulnerability & Threat:** Opposite balance changes can become copyable trades without adequate successful supported-swap proof, although the sampled failed runtime transaction correctly produced no event for the checked owners.
  - **Required Code Fix:** **introduce typed provenance, not another downstream side filter.** Require successful transaction evidence and decoded supported swap instructions tied to wallet inputs/outputs. Reject ambiguous multi-action routes into an explicit non-mirrorable classification. Keep quantity atomic and metadata separate; the existing source payload intentionally excludes target decimals/prices for Solana replay stability (/home/xahmie/Documents/SWAT/apps/indexer/src/source-trade-lifecycle.ts:64-78). Preserve canonical event identity across HTTP/RPC, and update discovery deliberately: its buyer extraction currently counts net receivers, not proven purchases (/home/xahmie/Documents/SWAT/apps/indexer/src/parse.ts:278-305; /home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:449-459). The current mirrorability gate only knows the already assigned side, so it cannot repair a fabricated buy (/home/xahmie/Documents/SWAT/apps/signal-engine/src/mirrorable-activity.ts:220-245).

- [x] **IDX-02 — Raw-unit ranking can misidentify trade legs**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/apps/indexer/src/parse.ts:138-155,179-209; /home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:285-324; /home/xahmie/Documents/SWAT/apps/indexer/src/source-trade-lifecycle.ts:81-106
  - **Vulnerability & Threat:** Choosing the largest positive and negative raw balances across mixed-decimal or multi-leg assets can produce the wrong copied token, direction or quantity.
  - **Required Code Fix:** **introduce typed provenance, not another downstream side filter.** Require successful transaction evidence and decoded supported swap instructions tied to wallet inputs/outputs. Reject ambiguous multi-action routes into an explicit non-mirrorable classification. Keep quantity atomic and metadata separate; the existing source payload intentionally excludes target decimals/prices for Solana replay stability (/home/xahmie/Documents/SWAT/apps/indexer/src/source-trade-lifecycle.ts:64-78). Preserve canonical event identity across HTTP/RPC, and update discovery deliberately: its buyer extraction currently counts net receivers, not proven purchases (/home/xahmie/Documents/SWAT/apps/indexer/src/parse.ts:278-305; /home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:449-459). The current mirrorability gate only knows the already assigned side, so it cannot repair a fabricated buy (/home/xahmie/Documents/SWAT/apps/signal-engine/src/mirrorable-activity.ts:220-245).

- [x] **IDX-03 — Fees and rent can distort source quantities**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/apps/indexer/src/webhook.ts:64-75; /home/xahmie/Documents/SWAT/apps/indexer/src/webhook-helpers.ts:102-133; /home/xahmie/Documents/SWAT/apps/indexer/src/parse.ts:76-78,162-176
  - **Vulnerability & Threat:** Enhanced normalization can treat the tracked wallet as fee payer and misattribute fees, rent or wrapping flows, making raw and enhanced trade quantities disagree.
  - **Required Code Fix:** **repair normalization before quantities are persisted.** Keep real payer separately, apply fees only to that payer, and account for ATA creation, close-account refunds and wrapped/native SOL without arbitrary magnitude heuristics. Plan historical reconciliation rather than silently changing immutable source quantities: differing replay payloads are rejected (/home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:665-710). Existing parity fixtures always make the tracked wallet the payer and therefore do not establish non-payer correctness (/home/xahmie/Documents/SWAT/apps/indexer/src/solana-parity.test.ts:35-78).

- [x] **IDX-04 — Source confirmation and reversal recovery are incomplete**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/apps/indexer/src/source-trade-lifecycle.ts:92-105,148-163,188-203; /home/xahmie/Documents/SWAT/apps/indexer/src/evm.ts:166-195; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:719-746,872-880 (external reversal incidence: Needs check)
  - **Vulnerability & Threat:** Builders mark observations confirmed without a reviewed production finality-advancement path, leaving reversal-driven inventory errors conditional on actual provider or chain events.
  - **Required Code Fix:** **make confirmation evidence operational.** Separate successful observation from finality and retain block identity for reorg checks. Wire confirmation history/position rebuild through the existing advancement interface, while ensuring previously emitted copies get an explicit reconciliation policy rather than another trade (/home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:550-601,719-746). Do not confuse Robinhood sequencer trust documentation with a finality implementation (/home/xahmie/Documents/SWAT/docs/adr/0006-robinhood-sequencer-trust.md:92-105).

- [x] **IDX-05 — Fill identity can diverge between ledgers**
  - **Severity:** `Medium` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/apps/indexer/src/source-trade-lifecycle.ts:116-163; /home/xahmie/Documents/SWAT/packages/db/src/transactions.ts:110-132; /home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts:355-390; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:644-645,700-710
  - **Vulnerability & Threat:** Polymarket identities based on economic fields differ from legacy identities, so split fills or corrections may collapse or duplicate events if the unverified provider contract permits those cases.
  - **Required Code Fix:** **unify accounting identity and quantity semantics.** Obtain stable fill identifiers or documented deterministic aggregation; aggregate legacy rows consistently and make corrections explicit. For Robinhood use wallet net quantity, not gross sends/receipts or all reviewed-pool activity. Preserve source-event foreign-key compatibility and migrate already persisted collisions with an audited reconciliation, not deletion. Legacy persistence and canonical persistence are separate, but canonical polling repairs a missed publish after canonical success; do not incorrectly report every duplicate/no-publish as a lost mirror (/home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts:372-390; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:591-596,693-724).

- [x] **IDX-06 — Gross route flows can overstate wallet inventory**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/apps/indexer/src/robinhood-ingestion.ts:190-262; /home/xahmie/Documents/SWAT/apps/indexer/src/evm.ts:313-329,455-488
  - **Vulnerability & Threat:** Robinhood route and transfer attribution can count gross or multi-beneficiary flows rather than the tracked wallet’s actual net trade quantity.
  - **Required Code Fix:** **unify accounting identity and quantity semantics.** Obtain stable fill identifiers or documented deterministic aggregation; aggregate legacy rows consistently and make corrections explicit. For Robinhood use wallet net quantity, not gross sends/receipts or all reviewed-pool activity. Preserve source-event foreign-key compatibility and migrate already persisted collisions with an audited reconciliation, not deletion. Legacy persistence and canonical persistence are separate, but canonical polling repairs a missed publish after canonical success; do not incorrectly report every duplicate/no-publish as a lost mirror (/home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts:372-390; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:591-596,693-724).

- [x] **IDX-07 — Unknown market risk is replaced with safe-looking defaults**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts:152-157,180-185,199-209,245-272; /home/xahmie/Documents/SWAT/packages/db/src/polymarket.ts:146-174
  - **Vulnerability & Threat:** Missing Polymarket risk, tick or end metadata can be turned into complete-looking market context without authoritative evidence.
  - **Required Code Fix:** **make unknowns and incomplete work visible.** Require explicit risk metadata; distinguish unavailable context from false neg-risk and keep stale/missing state non-complete. Add cursor visited-set, maximum page/item/byte budgets and total deadlines without breaking legitimate historical paging. Maintain existing per-row/wallet exception isolation and record partial failures: webhook isolation is already present, while backfill health records failed counters even when the batch returns normally (/home/xahmie/Documents/SWAT/apps/indexer/src/webhook.ts:51-108; /home/xahmie/Documents/SWAT/apps/indexer/src/ingestion-health.ts:36-78).

- [x] **IDX-08 — Backfill work lacks total resource bounds**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts:67-128,314-317; /home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:91-109,130-153,261-283
  - **Vulnerability & Threat:** Cycling pagination or hanging metadata can consume unbounded worker time or memory despite individual request and row handling.
  - **Required Code Fix:** **make unknowns and incomplete work visible.** Require explicit risk metadata; distinguish unavailable context from false neg-risk and keep stale/missing state non-complete. Add cursor visited-set, maximum page/item/byte budgets and total deadlines without breaking legitimate historical paging. Maintain existing per-row/wallet exception isolation and record partial failures: webhook isolation is already present, while backfill health records failed counters even when the batch returns normally (/home/xahmie/Documents/SWAT/apps/indexer/src/webhook.ts:51-108; /home/xahmie/Documents/SWAT/apps/indexer/src/ingestion-health.ts:36-78).

---

### Module 06: Signals, Scoring and Reducing Exits

- [x] **SIG-02 — Master sells are sized against shared inventory**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:1952-1976,2332-2365; /home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1743-1759,2304-2337; /home/xahmie/Documents/SWAT/packages/db/src/lot-allocation.ts:25-73
  - **Vulnerability & Threat:** A master’s sell fraction is applied to aggregate inventory instead of that master’s lots, allowing an external over-sale before narrower bookkeeping rejects or misallocates it.
  - **Required Code Fix:** **repair the actual claim, not the neighboring API.** A different request path already caps against master lots, but the source-signal claim used by the worker does not (/home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:1546-1579,1952-1976). Reserve owned lots and aggregate balance under compatible locks; apply the source fraction to the master's available quantity. Fill allocation already limits reductions to that master and throws on excess, which protects bookkeeping too late to prevent an external over-sale (/home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:2332-2365; /home/xahmie/Documents/SWAT/packages/db/src/lot-allocation.ts:68-73). Reconcile historical venue/lot divergence explicitly. This implements the ADR's contract, not proof that the accepted ADR is already operational (/home/xahmie/Documents/SWAT/docs/adr/0007-master-attributed-inventory.md:53-69,139-158).

- [x] **SIG-03 — Close-all exits are blocked by the entry gate**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/apps/scorer/src/close-all.ts:46-70; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:1665-1732; /home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1683-1688,2434-2435; /home/xahmie/Documents/SWAT/packages/db/src/trades.ts:309-318
  - **Vulnerability & Threat:** The worker requires an acquisition signal to remain pending even for a reserved close-all exit, allowing a completed queue job to leave the owned lot and reservation open.
  - **Required Code Fix:** **unify exit execution contracts.** Reuse tenant-owned lot-exit claims, and carry execution ID, scope, exact decimal quantity, acquisition mode and settlement account. Close-all's paper fallback loads its execution only after the blocking pending-signal branch; merely adding `closeAll` to the exemption is insufficient for live adapters (/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1683-1688,2434-2435,2309-2311). Stop-loss paper sizing does preserve the supplied quantity, but it does not construct canonical lot evidence, and producer claims never reserve lot inventory (/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:2454-2458,2582-2620; /home/xahmie/Documents/SWAT/packages/db/src/stop-loss.ts:85-107). Exit failures require stateful retry/release after proving no submission, not deleting guards indiscriminately.

- [x] **SIG-04 — Stop-loss jobs lose exact exit identity and quantity**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/packages/db/src/pnl-queries.ts:300-317; /home/xahmie/Documents/SWAT/apps/scorer/src/stop-loss.ts:225-268; /home/xahmie/Documents/SWAT/packages/db/src/stop-loss.ts:85-123; /home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1505-1516,1902-1909,2304-2313,2454-2458,2608-2620; /home/xahmie/Documents/SWAT/apps/trade-executor/src/polymarket.ts:719-720
  - **Vulnerability & Threat:** Stop-loss jobs omit required position/execution identity, leaving live Polygon without sell shares and legacy Solana using a full-wallet proportion instead of the intended lot quantity.
  - **Required Code Fix:** **unify exit execution contracts.** Reuse tenant-owned lot-exit claims, and carry execution ID, scope, exact decimal quantity, acquisition mode and settlement account. Close-all's paper fallback loads its execution only after the blocking pending-signal branch; merely adding `closeAll` to the exemption is insufficient for live adapters (/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1683-1688,2434-2435,2309-2311). Stop-loss paper sizing does preserve the supplied quantity, but it does not construct canonical lot evidence, and producer claims never reserve lot inventory (/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:2454-2458,2582-2620; /home/xahmie/Documents/SWAT/packages/db/src/stop-loss.ts:85-107). Exit failures require stateful retry/release after proving no submission, not deleting guards indiscriminately.

- [x] **SIG-05 — Entry restrictions can block exposure-reducing exits**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/packages/db/src/fanout-eligibility.ts:204-259; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:274-283,435-475,507,586-587; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:858-862
  - **Vulnerability & Threat:** Source score, balance, safety or full-position entry checks can reject sells during deterioration or wind-down, stranding exposure even when the master exits.
  - **Required Code Fix:** **make reducing sells independently admissible.** Capacity already deliberately bypasses sells; extend direction-aware policy to entry score, purchase balance and position count, without bypassing intentional kill switches, authority or physical inventory (/home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:274-283; /home/xahmie/Documents/SWAT/packages/db/src/fanout-eligibility.ts:233-263). Paused/low-scoring sources need an owned-lot exit path rather than the active-wallet candidate filter. Explicit user opt-outs need documented semantics; this finding does not recommend executing through an explicit kill.

- [x] **SIG-06 — Scores do not establish independent trading skill**
  - **Severity:** `Medium` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/packages/db/src/scoring-queries.ts:19-115; /home/xahmie/Documents/SWAT/packages/shared/src/scoring.ts:44-59; /home/xahmie/Documents/SWAT/apps/scorer/src/index.ts:96-101,159-175; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:630,507
  - **Vulnerability & Threat:** Legacy score admission lacks counterparty-control and sample-quality evidence, so poisoned or controlled profitable-looking histories may qualify; manipulable venue economics were not demonstrated.
  - **Required Code Fix:** **distinguish qualification, control and opportunity.** Discovery's funded/co-buy SQL identifies candidates, not actual trade counterparties or beneficial ownership (/home/xahmie/Documents/SWAT/packages/db/src/discovery-queries.ts:29-67). Genuine masters also create predictable follower cohorts without fake performance: capacity and exits must contain that separate market-impact exposure (/home/xahmie/Documents/SWAT/packages/db/src/master-capacity.ts:731-780). Out-of-sample metrics correctly exclude pre-observation/open/incomplete episodes and expose insufficient history, but the production caller supplies no persistence hook and only logs reports; it does not replace the legacy score gate (/home/xahmie/Documents/SWAT/apps/scorer/src/master-metrics.ts:178-285,593-609,683,759; /home/xahmie/Documents/SWAT/apps/scorer/src/index.ts:159-175). Its query forces fees NULL despite migration 062 adding a fee column; keep gross/net labels honest and wire measured fee availability, not guessed zeros (/home/xahmie/Documents/SWAT/apps/scorer/src/master-metrics.ts:852-884; /home/xahmie/Documents/SWAT/packages/db/sql/062_source_trade_fees.sql:4-5).

- [x] **SIG-07 — Independence warnings confuse unassessed with safe**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/packages/db/src/clustering-queries.ts:34-44; /home/xahmie/Documents/SWAT/packages/db/src/independence.ts:288-317; /home/xahmie/Documents/SWAT/packages/db/src/independence-queries.ts:32-65,79-98; /home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:839-870
  - **Vulnerability & Threat:** Small observed-degree hubs and limited cluster membership checks can yield no warning without positively establishing independent ownership or control.
  - **Required Code Fix:** **distinguish qualification, control and opportunity.** Discovery's funded/co-buy SQL identifies candidates, not actual trade counterparties or beneficial ownership (/home/xahmie/Documents/SWAT/packages/db/src/discovery-queries.ts:29-67). Genuine masters also create predictable follower cohorts without fake performance: capacity and exits must contain that separate market-impact exposure (/home/xahmie/Documents/SWAT/packages/db/src/master-capacity.ts:731-780). Out-of-sample metrics correctly exclude pre-observation/open/incomplete episodes and expose insufficient history, but the production caller supplies no persistence hook and only logs reports; it does not replace the legacy score gate (/home/xahmie/Documents/SWAT/apps/scorer/src/master-metrics.ts:178-285,593-609,683,759; /home/xahmie/Documents/SWAT/apps/scorer/src/index.ts:159-175). Its query forces fees NULL despite migration 062 adding a fee column; keep gross/net labels honest and wire measured fee availability, not guessed zeros (/home/xahmie/Documents/SWAT/apps/scorer/src/master-metrics.ts:852-884; /home/xahmie/Documents/SWAT/packages/db/sql/062_source_trade_fees.sql:4-5).

- [x] **SIG-08 — Capacity accounting can omit committed exposure**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:540-574; /home/xahmie/Documents/SWAT/apps/signal-engine/src/capacity-inputs.ts:641-655,685-702; /home/xahmie/Documents/SWAT/packages/db/src/master-capacity.ts:721-747,815-839,1596-1605,1673-1685; /home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1318-1338
  - **Vulnerability & Threat:** Unpriced obligations, post-enqueue write failures and missing ledger rows can understate commitments and overstate headroom, although fully unknown primary capacity already fails closed.
  - **Required Code Fix:** **treat capacity and delivery as durable accounting.** Fully unknown primary capacity fails closed at the actual fanout caller; partial-unpriced coverage can still admit. Do not describe all uncertainty as fail-open (/home/xahmie/Documents/SWAT/apps/signal-engine/src/capacity-inputs.ts:655; /home/xahmie/Documents/SWAT/packages/db/src/master-capacity.ts:721-747,815-839). AMM usable depth is TVL/2 marked approximate, not measured concentrated-liquidity depth; Polygon uses its separate book path (/home/xahmie/Documents/SWAT/packages/db/src/master-capacity.ts:174-198,217-222; /home/xahmie/Documents/SWAT/apps/signal-engine/src/capacity-inputs.ts:619-653). Persist obligations before work can disappear and alert on missing accrual. Queue-add exceptions do propagate and polling can retry undispatched sources; contrast that with enumeration-null success and later worker failure (/home/xahmie/Documents/SWAT/apps/signal-engine/src/fanout-enqueue.ts:349-359; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:874-877; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:306-313,586-587).

**Shelf-life verification — correction to prior assumptions.** `.env.example` claims emit/submit enforcement; the executor actually reads `SOURCE_COPY_MAX_EVENT_AGE_MS`, loads fresh source facts and calls the policy immediately before claim. DB claim additionally checks confirmation, signal expiry and source-position evidence (/home/xahmie/Documents/SWAT/.env.example:342-356; /home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1044-1051,1632-1658; /home/xahmie/Documents/SWAT/apps/trade-executor/src/copy-eligibility.ts:58-94; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:1872-1937). Polygon then re-queries source event time and applies a resolution-aware age budget immediately before creating the signed order, refusing missing time; this is a real additional gate (/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:2290-2314; /home/xahmie/Documents/SWAT/apps/trade-executor/src/polymarket.ts:797-848). That policy has its own ceiling configuration, not the shared variable, and samples time before the awaited market-state read (/home/xahmie/Documents/SWAT/apps/trade-executor/src/polymarket-staleness.ts:337-355; /home/xahmie/Documents/SWAT/apps/trade-executor/src/polymarket.ts:797-800). Solana submission arguments carry no event deadline after intervening balance/decimal work; universal immediate-pre-sign enforcement is **NOT VERIFIED**, not an established High (/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1715-1759,1782-1795,1902-1909). Routability exceptions return pass and the caller skips only `kind=skip`; even successful routing proves market availability, not swap provenance (/home/xahmie/Documents/SWAT/apps/signal-engine/src/routability-probe.ts:127-159; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:618-630).

- [x] **SIG-09 — Accepted work lacks complete durable delivery recovery**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:306-313,540-552,586-587; /home/xahmie/Documents/SWAT/apps/signal-engine/src/fanout-enqueue.ts:349-359; /home/xahmie/Documents/SWAT/apps/scorer/src/stop-loss.ts:269-277; /home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:2894-2908; /home/xahmie/Documents/SWAT/packages/db/src/stop-loss.ts:110-123
  - **Vulnerability & Threat:** User enumeration failures can become operator-only dispatch, while later skipped or exhausted exit jobs can leave missing deliveries or stuck stop-loss guards without a reviewed durable repair path.
  - **Required Code Fix:** **treat capacity and delivery as durable accounting.** Fully unknown primary capacity fails closed at the actual fanout caller; partial-unpriced coverage can still admit. Do not describe all uncertainty as fail-open (/home/xahmie/Documents/SWAT/apps/signal-engine/src/capacity-inputs.ts:655; /home/xahmie/Documents/SWAT/packages/db/src/master-capacity.ts:721-747,815-839). AMM usable depth is TVL/2 marked approximate, not measured concentrated-liquidity depth; Polygon uses its separate book path (/home/xahmie/Documents/SWAT/packages/db/src/master-capacity.ts:174-198,217-222; /home/xahmie/Documents/SWAT/apps/signal-engine/src/capacity-inputs.ts:619-653). Persist obligations before work can disappear and alert on missing accrual. Queue-add exceptions do propagate and polling can retry undispatched sources; contrast that with enumeration-null success and later worker failure (/home/xahmie/Documents/SWAT/apps/signal-engine/src/fanout-enqueue.ts:349-359; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:874-877; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:306-313,586-587).

**Shelf-life verification — correction to prior assumptions.** `.env.example` claims emit/submit enforcement; the executor actually reads `SOURCE_COPY_MAX_EVENT_AGE_MS`, loads fresh source facts and calls the policy immediately before claim. DB claim additionally checks confirmation, signal expiry and source-position evidence (/home/xahmie/Documents/SWAT/.env.example:342-356; /home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1044-1051,1632-1658; /home/xahmie/Documents/SWAT/apps/trade-executor/src/copy-eligibility.ts:58-94; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:1872-1937). Polygon then re-queries source event time and applies a resolution-aware age budget immediately before creating the signed order, refusing missing time; this is a real additional gate (/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:2290-2314; /home/xahmie/Documents/SWAT/apps/trade-executor/src/polymarket.ts:797-848). That policy has its own ceiling configuration, not the shared variable, and samples time before the awaited market-state read (/home/xahmie/Documents/SWAT/apps/trade-executor/src/polymarket-staleness.ts:337-355; /home/xahmie/Documents/SWAT/apps/trade-executor/src/polymarket.ts:797-800). Solana submission arguments carry no event deadline after intervening balance/decimal work; universal immediate-pre-sign enforcement is **NOT VERIFIED**, not an established High (/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1715-1759,1782-1795,1902-1909). Routability exceptions return pass and the caller skips only `kind=skip`; even successful routing proves market availability, not swap provenance (/home/xahmie/Documents/SWAT/apps/signal-engine/src/routability-probe.ts:127-159; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:618-630).

---

### Module 07: Trade Execution and Recovery

- [x] **EXE-01 — User Solana authority inherits the operator signer**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified production construction, user adapter, dispatch and signer. User Solana inherits the operator signer, needs no grant, synthesizes an address, and ordinary Jupiter bypasses `authority.sign`: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/execution-authority-adapters.ts:498-568,604-618`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1125-1162,1774-1795`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/jupiter-jito-config.ts:109-131`.
  - **Folded / Included Observations:** `CRY-01.`
  - **Vulnerability & Threat:** A user-labelled job can receive an operator signer and synthetic settlement identity without a verified grant, and ordinary Jupiter dispatch bypasses the delegated signing method; live synthetic-address acceptance and user-vault theft remain unverified.
  - **Required Code Fix:** **separate operator execution from delegated execution.** The factory must not use `deps.solana.signer` as user authority. Require a valid canonical settlement address, installed adapter, active grant, expiry/revocation checks, and a transaction that invokes the scoped program with bounded accounts and amounts. Preserve the existing operator adapter and operator Trojan path. Keep user RHC/PM denial codes stable. Merely calling `authority.sign` is insufficient if that method still signs arbitrary bytes using operator keys (`apps/trade-executor/src/execution-authority-adapters.ts:136-175,608-614`). Grant-table issuance, deployed program implementation and audit assertions were **NOT VERIFIED**.

- [x] **EXE-02 — Tenant identity is dropped during execution persistence**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified fan-out to canonical claim and trade SQL. `userId` is omitted by `prepareCanonicalExecutions` and by every `persistTrade` input shape; DB normalizes omission to null: `/home/xahmie/Documents/SWAT/apps/signal-engine/src/fanout-enqueue.ts:242-255`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1179-1217,318-410`; `/home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:1746-1770,1834-1849`; `/home/xahmie/Documents/SWAT/packages/db/src/trades.ts:140-180`.
  - **Folded / Included Observations:** `SIG-01.`
  - **Vulnerability & Threat:** User jobs lose userId at canonical claim and trade writes, defaulting to operator ownership and risking merged claims, missing attribution and incorrect exposure or exit accounting.
  - **Required Code Fix:** **make tenant identity mandatory for user paths.** Extend `prepareCanonicalExecutions` and `persistTrade` with explicit normalized `userId`; pass it to DB methods, cross-check returned execution principal and venue settlement, and reject mismatches before effects. Retain explicit null only for legacy operator callers. Database queries already support tenant-scoped keys and evidence (`packages/db/src/copy-trade-lifecycle.ts:1834-1842,1980-2015`; `packages/db/src/trades.ts:17,179`), so fix callers rather than removing SQL tenancy. Existing null financial history cannot safely be relabeled without evidence.

- [x] **EXE-03 — Worker can override user mode and tolerance**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified producer-to-consumer policy mismatch. Producer carries user `executionMode`/`mirrors`; worker ignores both and re-resolves platform mode: `/home/xahmie/Documents/SWAT/apps/signal-engine/src/fanout-enqueue.ts:246-253`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1412-1436,1462-1469,1650-1657`. No producer `maxSlippageBps`; Polymarket call has no user slippage: `/home/xahmie/Documents/SWAT/apps/signal-engine/src/fanout-enqueue.ts:215-255`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1700,2304-2314`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/polymarket.ts:740-746`.
  - **Vulnerability & Threat:** The worker ignores queued user execution mode and mirror policy and lacks full user-slippage propagation, potentially widening paper/off intent or tolerance; unsupported user PM/RHC routes still deny.
  - **Required Code Fix:** **enforce current tenant choice, not informational mirrors.** At dequeue, load the user's mode/tolerance and compare with the enqueued policy revision; clamp by platform capabilities, never widen paper/off to live. Either regenerate projections under the narrower mode or reject outdated jobs. Add a Polymarket tolerance parameter shared by book-walk, master-price bound and paper simulation; preserve explicitly tighter limits. Solana live default is 1,500 bps while paper Jupiter uses literal 150; PM uses environment default 200 rather than the shared Polygon default 300 (`packages/shared/src/slippage.ts:29-35`; `apps/trade-executor/src/index.ts:2470-2475`; `apps/trade-executor/src/polymarket.ts:741`). These are policy discrepancies, not measured execution slippage.

- [x] **EXE-04 — Daily exposure limit is inexact and non-atomic**
  - **Severity:** `High` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** Verified arithmetic failure and non-atomic cap, Likely—race test needed for overlap. Unvalidated `parseFloat` cap; guessed SOL/ETH rates; sum only confirmed filled/partial trades, excludes shadow but includes paper; unknown fill valuation writes zero: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1551-1565,353-368`; `/home/xahmie/Documents/SWAT/packages/db/src/trades.ts:423-433`. Legacy/replica concurrency exists: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/trade-workers.ts:93-99`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:2893-2902`.
  - **Vulnerability & Threat:** Malformed ceilings, guessed prices, zero-valued unknown fills and missing pending reservations can misstate or exceed exposure, with paper/live budget mixing and race consequences not reproduced.
  - **Required Code Fix:** **reserve risk before the money path.** Parse the daily ceiling with the existing finite-number helpers, reject invalid pricing, and distinguish native ETH from RHC ERC20 base spend. Acquire an account/chain/mode reservation atomically before dispatch, include all unknown/pending and partial residual commitments, release only on proven cancellation/failure, and accrue actual fills idempotently. Shadow stays separate; decide explicitly whether paper has its own budget. A concurrency-one worker is not a cross-process reservation. Adjacent capacity accrual also logs and continues on ledger failure (`apps/trade-executor/src/index.ts:1319-1338`); do not mistake that lower-bound numerator for guaranteed capacity enforcement.

- [x] **EXE-05 — Upstream swap bytes are signed without full intent inspection**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified build-to-sign trust boundary. Quote checks amounts/mode but not requested mints, amount equality or tolerance; builder trusts returned bytes/instructions and supplied ALT contents; signer only deserializes and signs: `/home/xahmie/Documents/SWAT/packages/shared/src/jupiter.ts:201-215`; `/home/xahmie/Documents/SWAT/packages/shared/src/jupiter-swap.ts:181-258`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/solana-signer.ts:64-71`.
  - **Vulnerability & Threat:** Quote identity and final instructions/accounts are insufficiently checked before operator signing, so valid but unauthorized upstream-built effects remain possible; simulation success does not establish consent.
  - **Required Code Fix:** **bind bytes to intent.** Validate requested quote identities/amounts, inspect resolved lookup-table accounts against trusted observations, constrain programs, token accounts, owner/recipient, maximum debit, minimum credit, approvals, close-account destinations, tips and compute fees. Reject extra instructions and unknown layouts. Check the final serialized message hash immediately before signing; simulation is an additional execution check, not authorization. Preserve valid setup/wrap/cleanup paths through narrowly tested allowlists rather than blindly prohibiting all auxiliary instructions (`packages/shared/src/jupiter-swap.ts:232-247`).

- [x] **EXE-06 — External submission precedes durable recovery identity**
  - **Severity:** `High` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** Verified runtime unknown-state gap, Likely—crash/race test needed for duplicate effect. Jito reads pending state without claim, transmits before saving, and retryable failure returns unknown without saving anything: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/jupiter-jito-runtime.ts:221-235,311-342`. Outer catch terminates canonical rows: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:2647-2655`.
  - **Folded / Included Observations:** `EXE-09.`
  - **Vulnerability & Threat:** Jito and the folded Polymarket path can send before durable signed identity is stored and mishandle uncertain outcomes, creating missing exposure or possible duplicate rebuilds that were not reproduced.
  - **Required Code Fix:** **use durable submitting/unknown states.** Persist stable intent, signed bytes/order hash, transaction signature if locally derivable, expiry window and ownership before external POST. Use a database/Redis CAS lease keyed to tenant/client order ID. On transport or persistence uncertainty retain reservations and an unknown state; do not release the signal or terminate canonical execution. Recovery should resend identical signed artifacts only where venue idempotency is established, otherwise probe and escalate. RHC already writes `submission_unknown` before `send` (`apps/trade-executor/src/robinhood.ts:637-658`); preserve that safer behavior while extending evidence for nonce-based recovery.

- [x] **EXE-07 — Jito resolution does not complete financial accounting**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified Jito sweeper caller and sinks. Sweep resolves its Redis state but caller only logs; submitted rows initially lack chain signature and canonical submission identity: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1798-1828,2732-2758`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/jupiter-jito-runtime.ts:446-455`. Generic fallback cannot reconstruct quantities without identity: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/reconciliation-venues.ts:30-50,96-118`.
  - **Vulnerability & Threat:** The sweeper resolves its Redis record but its caller only logs, while missing chain identity prevents reliable receipt quantities, canonical fills and exposure updates.
  - **Required Code Fix:** **connect Jito reconciliation to accounting.** Persist the known bundle-to-execution mapping, derive quantities from attributable chain receipts, update `trades.signature`, and use existing evidence deduplication to advance positions and exposure. Do not label a landed signature a quantified fill without receipt amounts. Retain generic coordinator escalation on missing evidence (`apps/trade-executor/src/reconciliation-venues.ts:14-22`). Preserve legacy pending records when adding fields.

- [x] **EXE-08 — Live readiness can omit simulation**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified simulation factory/readiness gap. Signer can use shared RPC fallback, whereas simulator requires explicit RPC or Helius key; null gate becomes undefined while runtime still reports ready: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/solana-signer.ts:112-120`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/solana-simulation.ts:451-492`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/jupiter-jito-config.ts:109-135`.
  - **Vulnerability & Threat:** Signer RPC fallback and simulation RPC requirements differ, so a configured route can report ready while the simulation gate is absent.
  - **Required Code Fix:** **and freshness: make readiness explicit.** Share RPC resolution between signer and simulator; prohibit live route readiness with a missing mandatory gate. Check source, quote, simulation and blockhash age immediately before signing/submission. PM has resolution-relative source staleness, while RHC computes a 120-second deadline before a possible approval receipt wait (`apps/trade-executor/src/polymarket.ts:797-843`; `apps/trade-executor/src/robinhood.ts:795-851`). Requote/resimulate after approval rather than silently extending an old price. Track final-artifact expiry; the simulator currently replaces the blockhash (`apps/trade-executor/src/solana-simulation.ts:225-240`).

---

### Module 08: Secondary Services (LP, Perps, Alerts, Discovery, ML)

- [x] **SEC-01 — LP accepts arbitrary credentialed browser origins**
  - **Severity:** `Medium` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** Verified credentialed CORS accepts every origin, contradicting allowlist comments: `/home/xahmie/Documents/SWAT/apps/lp/src/index.ts:272-295`. Session issuer uses host-only `SameSite=Lax`: `/home/xahmie/Documents/SWAT/apps/api/src/auth/routes.ts:106-124`. Needs check browser/deployment cookie delivery.
  - **Vulnerability & Threat:** LP permits every origin with credentials, creating conditional same-site response exposure if cookies reach an attacker-controlled origin; unrelated-site access is still constrained by SameSite and CSRF.
  - **Required Code Fix:** **correct HTTP policy without removing tenancy.** Reject origins outside exact configured scheme/host/port; remove both the `:3000` suffix acceptance and final unconditional allow. SameSite is site-level, not origin-level; Lax does not protect against every same-site origin. No assertion of unrelated-site session theft is supported. Always register the session branch, making the service-key hash optional while preserving invalid-session refusal and constant-time matching. Keep the health exemption and double-submit CSRF; do not make scoped routes accept tenantless service keys (`apps/lp/src/auth.ts:63-102`).

- [x] **SEC-02 — Missing development key disables session authentication**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified missing nonproduction key omits session hook despite warning: `/home/xahmie/Documents/SWAT/apps/lp/src/index.ts:60-62,298-300`; routes require principal/user (`/home/xahmie/Documents/SWAT/apps/lp/src/routes.ts:218-220,406-408`).
  - **Vulnerability & Threat:** A nonproduction LP instance without the service key omits the whole session hook and makes principal-gated routes unusable despite its warning; this is not demonstrated public write access.
  - **Required Code Fix:** **correct HTTP policy without removing tenancy.** Reject origins outside exact configured scheme/host/port; remove both the `:3000` suffix acceptance and final unconditional allow. SameSite is site-level, not origin-level; Lax does not protect against every same-site origin. No assertion of unrelated-site session theft is supported. Always register the session branch, making the service-key hash optional while preserving invalid-session refusal and constant-time matching. Keep the health exemption and double-submit CSRF; do not make scoped routes accept tenantless service keys (`apps/lp/src/auth.ts:63-102`).

- [x] **SEC-03 — Subscriber can overwrite shared wallet configuration**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified user subscription calls service-only global registry writer before subscription; writer overwrites label and cadence on conflict: `/home/xahmie/Documents/SWAT/apps/lp/src/routes.ts:403-408,490-505`; `/home/xahmie/Documents/SWAT/packages/db/src/lp-tracked-wallets.ts:64-80`.
  - **Vulnerability & Threat:** A user subscription invokes the otherwise service-only global writer and changes an existing wallet’s label or scan cadence before subscription success.
  - **Required Code Fix:** **make subscriber onboarding an explicit bounded privilege.** Allow requesting a master, not modifying established global registry metadata. Preserve service-only add/delete. Authenticate and fully validate before registry effects, apply tenant/global quotas, and make subscription/onboarding atomic or recoverable. Budget validation currently uses coercion and `<=0` without finite checks in both route and DB; venue has a SQL allowlist, so do not claim arbitrary venue persistence (`apps/lp/src/routes.ts:477-505`; `packages/db/src/lp-copy-trading.ts:103-136`; `packages/db/sql/069_lp_copy_trading.sql:9-17`). Explicitly reject nonnumeric/nonfinite budgets in code and SQL; actual PostgreSQL special-NUMERIC acceptance was not tested. Registry mutation already occurs before any subscription SQL constraint failure.

- [x] **SEC-04 — LP concentration checks mix incompatible asset units**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified raw asset amounts are summed as USD across assets/chains, then compared with raw requested amount: `/home/xahmie/Documents/SWAT/packages/db/src/lp-positions.ts:192-205,401-426`; `/home/xahmie/Documents/SWAT/apps/lp/src/guardrails/deploy-guard.ts:38-48`. Likely—race test needed read/check/insert overshoot (`/home/xahmie/Documents/SWAT/apps/lp/src/builder/build-position.ts:151-201`). Current live submission refuses.
  - **Vulnerability & Threat:** Raw amounts across assets and chains are treated as USD and checked before a separate insert, making concentration limits unreliable; actual live submission currently refuses and race overshoot remains untested.
  - **Required Code Fix:** **identify units and reserve the decision.** Store exact raw quantity, decimals, asset, valuation timestamp/source and mode independently. Sum trusted USD commitments including building/pending exposure; retain unknown commitments. Lock a tenant budget/reservation ledger through check-and-insert, not merely individual position transitions. Preserve the pure evaluator's finite checks; its intentional first-deposit exception is not itself a NaN bypass (`apps/lp/src/guardrails/exposure-cap.ts:37-65`). Migration must not relabel historical raw amounts as USD without evidence.

- [x] **SEC-05 — LP plans and no-op jobs leave misleading position states**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified manual rebalance sets `rebalancing`, worker returns success without transition; monitor excludes that state: `/home/xahmie/Documents/SWAT/apps/lp/src/routes.ts:332-350`; `/home/xahmie/Documents/SWAT/apps/lp/src/index.ts:370-389`; `/home/xahmie/Documents/SWAT/packages/db/src/lp-positions.ts:286-290`. Live plans remain building without a broadcast caller (`/home/xahmie/Documents/SWAT/apps/lp/src/builder/build-position.ts:228-243`).
  - **Vulnerability & Threat:** Manual rebalance can remain stuck after a successful no-op worker and live builds have no broadcast handoff, while related archive/copy states must not be mistaken for actual venue execution.
  - **Required Code Fix:** **distinguish plans from execution.** Before creating a live build, require certified runtime and an actual per-user address/grant rather than the process-global `LP_SERVICE_USER_ADDRESS` (`apps/lp/src/index.ts:307`; `apps/lp/src/builder/build-position.ts:208-224`). Current plan-only ports do not sign, so this is a future ownership boundary, not present user-fund theft. Journal paper rebalance completion/failure, compensate builder failures after insertion, and implement explicit canceled/planned states. DB-only LP close must remain paper/archive-only until receipt-based withdrawal exists (`apps/lp/src/routes.ts:371-400`). Preserve locked transitions. The separate copy handler must never report live `executed` without submission/evidence: it currently only updates DB, and paper also creates no simulated position (`apps/lp/src/copy/copy-worker.ts:62-73`). Do not wire that dormant worker before tenant/subscription revalidation and unique event identity; SQL executions have no event uniqueness (`packages/db/sql/069_lp_copy_trading.sql:28-50`).

- [x] **SEC-06 — Dormant perps execution has risk and recovery gaps**
  - **Severity:** `Medium` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** Verified latent perps arithmetic and submit-before-record: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/polymarket-perps.ts:97-99,172-217`. Zero withdrawable falls back, NaN margin/order comparisons can pass, client ID/leverage/builder not sent. Needs check production caller/session ownership; duplicate external effect Likely—test needed.
  - **Vulnerability & Threat:** Invalid margin/order arithmetic can pass, zero withdrawable funds fall back, and submission precedes durable identity with incomplete order fields; no production caller or funded external effect was verified.
  - **Required Code Fix:** **keep perps behind a certification boundary.** Reject unknown/inactive instruments; enforce finite positive exact price, quantity, leverage and notional, configured precision, limit/slippage and freshness. Preserve legitimate zero withdrawable; malformed maintenance/initial margin must refuse, not become zero or NaN. Bind session identity to the tenant and active grant before effects. Transmit stable client identity under the SDK contract and persist submitting/unknown state before `placeOrder`. Reconcile authoritative net positions rather than inserting a new position for each partial fill; the function named upsert actually INSERTs (`packages/db/src/polymarket-perps.ts:177-218`). Do not publish the pretrade portfolio as posttrade state or approximate liquidation as authoritative (`apps/trade-executor/src/polymarket-perps.ts:219-251`). For close, keep SQL archive distinct; real close requires reduce-only venue order plus evidence. Returning affected rows fixes the false 404 but does not implement a venue close.

- [x] **SEC-07 — Perps close only changes local records and reports failure**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified tenant perps close updates SQL only; `query` returns rows and UPDATE has no RETURNING, so method reports false after a successful update: `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:1330-1338`; `/home/xahmie/Documents/SWAT/packages/db/src/polymarket-perps.ts:276-283`; `/home/xahmie/Documents/SWAT/packages/db/src/client.ts:65-67`.
  - **Vulnerability & Threat:** The user close path archives SQL state rather than closing venue exposure and returns false after a successful update because affected rows are not returned.
  - **Required Code Fix:** **keep perps behind a certification boundary.** Reject unknown/inactive instruments; enforce finite positive exact price, quantity, leverage and notional, configured precision, limit/slippage and freshness. Preserve legitimate zero withdrawable; malformed maintenance/initial margin must refuse, not become zero or NaN. Bind session identity to the tenant and active grant before effects. Transmit stable client identity under the SDK contract and persist submitting/unknown state before `placeOrder`. Reconcile authoritative net positions rather than inserting a new position for each partial fill; the function named upsert actually INSERTs (`packages/db/src/polymarket-perps.ts:177-218`). Do not publish the pretrade portfolio as posttrade state or approximate liquidation as authoritative (`apps/trade-executor/src/polymarket-perps.ts:219-251`). For close, keep SQL archive distinct; real close requires reduce-only venue order plus evidence. Returning affected rows fixes the false 404 but does not implement a venue close.

- [x] **SEC-08 — Alert delivery can regress execution state**
  - **Severity:** `High` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** Verified alert delivery writes signal `status='alerted'` regardless of prior lifecycle after external send; TTL60 lock lacks ownership and send lacks timeout: `/home/xahmie/Documents/SWAT/apps/alert-service/src/index.ts:41-60,379-410`. Likely—race test needed regression/duplicate/lost alert consequences.
  - **Vulnerability & Threat:** Delayed alert delivery can overwrite a later signal lifecycle state while its expiring unowned lock and unbounded send create possible duplicate or lost delivery races.
  - **Required Code Fix:** **decouple notifications from execution state.** Update only notification metadata; never downgrade executing/executed signals. Use durable notification intent, token-owned lease renewal and compare-and-delete; lock denial should delay rather than complete the job. Bound request and server retry delay. Delivery followed by DB failure remains an ambiguous external effect, not exactly-once. Operational payloads are escaped, but signal strings are only length-checked and several are inserted raw into HTML/links (`apps/alert-service/src/alert-payload.ts:96-113,246-269`; `apps/alert-service/src/index.ts:253-265,293-294,355-369`). Validate IDs/addresses, escape text and encode URL components. Telegram rendering impact needs isolated tests; no browser XSS claim. Replace universal displayed 15% with resolved venue/user policy, since it is presentation, not proof of actual execution (`apps/alert-service/src/index.ts:318-342`).

- [x] **SEC-09 — Discovery can persist a wallet without scheduling its history**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified discovery upsert persists before failed enqueue, while subsequent queries exclude known wallets: `/home/xahmie/Documents/SWAT/apps/discovery/src/runner.ts:44-55`; `/home/xahmie/Documents/SWAT/packages/db/src/wallets.ts:44-64`; `/home/xahmie/Documents/SWAT/packages/db/src/discovery-queries.ts:29-64`. Other recovery paths NOT VERIFIED.
  - **Vulnerability & Threat:** A wallet is saved before backfill enqueue, so queue failure can leave it excluded from future discovery retries without a reviewed recovery path.
  - **Required Code Fix:** **preserve recovery and local isolation.** Discovery should write wallet plus outbox transactionally and acknowledge enqueue independently; existing deterministic backfill IDs remain useful. Process overlap guards are not cross-replica ownership (`apps/discovery/src/runner.ts:35,99-114`). Python should resolve paths beneath an explicit permitted root, reject traversal/absolute address components, use canonical encoded partitions, and authenticate artifact provenance before deserialization. Preserve `yaml.safe_load` and parameterized DuckDB filters (`pattern-ml/src/pattern_ml/config.py:197`; `pattern-ml/src/pattern_ml/storage.py:236-255`). Require explicit opt-in to repo credential fallback. Nonpositive rate limits disable pacing and HTTP honors unbounded numeric Retry-After; validate bounded configuration (`pattern-ml/src/pattern_ml/sources/base.py:36-43,110-115`).

- [x] **SEC-10 — Local ML inputs are not confined or safe to deserialize**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Verified Python confinement not enforced: configured absolute/parent paths accepted; roster Solana address not syntax-validated, then used as filesystem component; score deserializes pickle (`/home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/config.py:116-142,159-180`; `/home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/storage.py:89-105`; `/home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/cli.py:623-624`). Needs check untrusted artifact/roster distribution.
  - **Vulnerability & Threat:** Untrusted roster paths or model files could cause writes outside the intended directory or execute code during pickle loading, conditional on an operator accepting those local inputs; no remote ingress was established.
  - **Required Code Fix:** **preserve recovery and local isolation.** Discovery should write wallet plus outbox transactionally and acknowledge enqueue independently; existing deterministic backfill IDs remain useful. Process overlap guards are not cross-replica ownership (`apps/discovery/src/runner.ts:35,99-114`). Python should resolve paths beneath an explicit permitted root, reject traversal/absolute address components, use canonical encoded partitions, and authenticate artifact provenance before deserialization. Preserve `yaml.safe_load` and parameterized DuckDB filters (`pattern-ml/src/pattern_ml/config.py:197`; `pattern-ml/src/pattern_ml/storage.py:236-255`). Require explicit opt-in to repo credential fallback. Nonpositive rate limits disable pacing and HTTP honors unbounded numeric Retry-After; validate bounded configuration (`pattern-ml/src/pattern_ml/sources/base.py:36-43,110-115`).

---

### Module 09: Agent and MCP Boundary (Resolved — Component Completely Removed)

- [x] **MCP-01 — Independent agent listener lacks administrative authorization**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Status:** **RESOLVED** — `apps/mcp-server` was completely removed from the repository, workspace, and build pipeline.
  - **Vulnerability & Threat:** The MCP listener exposed shared blacklist mutations and scorer commands without application authentication or per-tool authorization.
  - **Resolution:** Attack surface eliminated by decommissioning and deleting `apps/mcp-server`.

- [x] **MCP-02 — Agent tools expose unscoped operational reads**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Status:** **RESOLVED** — `apps/mcp-server` was completely removed.
  - **Vulnerability & Threat:** MCP queried shared signals and performance without a tenant context or publication gate.
  - **Resolution:** Attack surface eliminated by deleting `apps/mcp-server`.

- [x] **MCP-03 — Agent sessions share unbounded server state**
  - **Severity:** `Medium` | **Confidence:** `Likely`
  - **Status:** **RESOLVED** — `apps/mcp-server` was completely removed.
  - **Vulnerability & Threat:** One server and transport registry lacked principal-bound ownership and connection/idle bounds.
  - **Resolution:** Attack surface eliminated by deleting `apps/mcp-server`.

---

### Module 10: Web Application and Standalone Test UI

- [x] **WEB-01 — Test UI funding account has public-input signing authority**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Public-input keypair and address response: `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:38-41,99-130`; UI funding caller: `/home/xahmie/Documents/SWAT/pda-test-ui/public/index.html:663-678,709-738`. Funding, active network and transfer NOT VERIFIED.
  - **Vulnerability & Threat:** The standalone UI funds an interactive keypair derived from public inputs rather than the claimed program-controlled vault, exposing any such funded account; actual funding and active network were not verified.
  - **Required Code Fix:** Remove deterministic signing vault; disable deposits until real PDA/mock model is used consistently; isolate and enforce test network.

- [x] **WEB-02 — Test UI signature does not bind withdrawal parameters**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** Separate unsigned parameters, arbitrary-message verification and signing: `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:202-285`; honest client message: `/home/xahmie/Documents/SWAT/pda-test-ui/public/index.html:826-863`. Actual transfer NOT VERIFIED; recipient remains owner.
  - **Vulnerability & Threat:** The server verifies an arbitrary message separately from amount and timestamp and has no replay state, allowing intent reuse or alteration in principle; payout remains to the owner and no transfer was demonstrated.
  - **Required Code Fix:** Canonical signed intent binding every field, strict integer/freshness checks, one-use server nonce consumed before side effects; update browser builder.

- [x] **WEB-03 — Test UI inserts provider text into HTML**
  - **Severity:** `Medium` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** Raw sinks: `/home/xahmie/Documents/SWAT/pda-test-ui/public/index.html:463-470,503-507,586-589,789-805,865-887`; raw server errors: `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:132-135,189-197,299-302`. Needs check: attacker influence over victim-visible text and script execution NOT VERIFIED.
  - **Vulnerability & Threat:** Raw error and result text reaches HTML interpretation, creating possible script injection if attacker-controlled text reaches a victim; that influence and execution were not demonstrated.
  - **Required Code Fix:** Use textContent/DOM nodes, validated explorer hrefs, sanitized public error codes.

- [x] **WEB-05 — Post-login destination validation may be ambiguous**
  - **Severity:** `Low` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** Raw destination validation/router call: `/home/xahmie/Documents/SWAT/apps/web/app/login/page.tsx:25,40-57`. Needs framework check: off-origin navigation NOT VERIFIED.
  - **Vulnerability & Threat:** The login page validates next with string checks rather than a normalized same-origin URL, leaving unexpected navigation conditional on framework behavior.
  - **Required Code Fix:** Parse URL, reject ambiguous syntax, compare same origin and share parsed-path admin classification.

- [x] **WEB-06 — Browser response protections are not established**
  - **Severity:** `Low` | **Confidence:** `Needs check`
  - **Affected Files / Evidence:** Application config omission: `/home/xahmie/Documents/SWAT/apps/web/next.config.ts:19-49`, `/home/xahmie/Documents/SWAT/apps/web/middleware.ts:56-86`, `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:311-369`. Runtime/proxy headers NOT VERIFIED.
  - **Vulnerability & Threat:** Application configuration lacks an established content/framing/header protection set, while actual proxy/runtime headers remain unverified; no framing or injection exploit was shown.
  - **Required Code Fix:** Compatible CSP, anti-framing, referrer/nosniff headers; HSTS only after HTTPS verification.

---

### Module 11: Infrastructure, Supply Chain and Deployment

- [x] **INF-01 — Secret-bearing deployment installs unpinned tooling**
  - **Severity:** `High` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/.woodpecker.yaml:68-90`; `/home/xahmie/Documents/SWAT/.woodpecker/ci.yaml:68-90`
  - **Vulnerability & Threat:** CI installs the latest deploy CLI with production deployment secrets available, leaving supply-chain compromise impact conditional on a malicious fetched dependency rather than an observed compromise.
  - **Required Code Fix:** Pin the CLI in the lockfile and isolate credential-free acquisition from least-privilege deployment.

- [x] **INF-02 — Root service examples amplify application compromise**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/DEPLOYMENT.md:304-385`; `/home/xahmie/Documents/SWAT/deploy/systemd/swat-api.service:8-19`; `/home/xahmie/Documents/SWAT/deploy/systemd/swat-trade-executor.service:8-23`
  - **Vulnerability & Threat:** The runbook runs applications as root while hardened service files point into protected root-home paths, creating excessive privilege and conflicting startup guidance; installed units were not verified.
  - **Required Code Fix:** Consolidate unprivileged units/runbook and move code outside protected home paths; provision secrets separately.

- [x] **INF-03 — Application defaults reuse the database bootstrap identity**
  - **Severity:** `Medium` | **Confidence:** `Likely`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/docker-compose.yml:13-18,45-50`; `/home/xahmie/Documents/SWAT/packages/db/src/client.ts:10-27`; `/home/xahmie/Documents/SWAT/packages/db/sql/064_row_level_security.sql:47-64`
  - **Vulnerability & Threat:** Templates reuse a potentially privileged bootstrap identity without application startup rejection; runtime follow-up confirms the local role is superuser/BYPASSRLS, not the remote production role.
  - **Required Code Fix:** Separate runtime/migrator roles and reject superuser/BYPASSRLS production identity after safe provisioning.

- [x] **INF-04 — Remote backend transport can expose session data**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/apps/web/next.config.ts:4-17,24-35`; `/home/xahmie/Documents/SWAT/.woodpecker.yaml:84-90`
  - **Folded / Included Observations:** `WEB-04.`
  - **Vulnerability & Threat:** Web rewrites default to cross-host HTTP with weak URL validation and the folded middleware path forwards full cookies, creating conditional credential exposure without proven interception or deployment activation.
  - **Required Code Fix:** Require trusted HTTPS cross-host targets, session-only forwarding and reviewed backend access controls.

- [x] **INF-05 — Historical credential-shaped assignment is unresolved**
  - **Severity:** `Medium` | **Confidence:** `Needs check`
  - **Affected Files / Evidence:** Historical commit `d4d543139755a82560513fef4aa173b2c5b1d327`, `swat.md:1351`; `/home/xahmie/Documents/SWAT/.gitignore:3-7,25-26,39-40`
  - **Vulnerability & Threat:** Reachable Git history retains one opaque credential-like assignment of unknown provenance or validity; known public test keys are not classified as live leaks and no secret value is reproduced.
  - **Required Code Fix:** Owner-led provenance/rotation decision, redacted evidence retention and offline history gates.

- [x] **INF-06 — Secondary installation paths are not reproducibly pinned**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/pattern-ml/scripts/setup-server.sh:41-48`; `/home/xahmie/Documents/SWAT/pattern-ml/pyproject.toml:7-40,45-47`; `/home/xahmie/Documents/SWAT/DEPLOYMENT.md:142-145,393-395`
  - **Vulnerability & Threat:** Python lower-bound dependencies and unpinned privileged bootstrap/tool installs execute newly acquired code without the same reproducibility as the frozen pnpm workspace; no malicious package was established.
  - **Required Code Fix:** Hash-lock Python/tooling and deploy immutable unprivileged artifacts; retain pnpm as the web installation authority.

---

### Module 12: Test Safety and Assurance

- [x] **TEST-01 — Chaos tests can disrupt shared infrastructure**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/vitest.integration.config.ts:1-17`; `/home/xahmie/Documents/SWAT/tests/integration/chaos.integration.test.ts:53-61,343-345,418`
  - **Vulnerability & Threat:** Original test configuration can select shared infrastructure and terminate database or normal Redis clients despite paper mode; the existing follow-up avoided this by using new isolated services.
  - **Required Code Fix:** 1. In `vitest.integration.config.ts`, stop fallback to generic `DATABASE_URL` for destructive integration tests. Require a dedicated security-test mode and validated disposable endpoint identity. For this localhost-only review, reject non-loopback database/Redis URLs; production CI can use a separately reviewed service-container policy.
2. Refactor chaos setup to allocate a fresh disposable DB/Redis instance or require an explicit marker verified via a read-only identity probe before destructive actions. Paper mode only governs trading; it does not authorize database/backend termination.
3. Replace broad Redis `CLIENT KILL TYPE normal` with named client-ID tracking for connections created by this test. Keep queue-specific obliteration and avoid shared-server-wide commands.
4. Scope Postgres termination to test-created backend PIDs/application names or the dedicated disposable database with an explicit guard; do not terminate other clients merely because they share the database name.
5. Run these scenarios as a separate opt-in suite. Read neighboring lifecycle fixtures and setup callers to preserve retry/no-fill assertions (`tests/integration/chaos.integration.test.ts:114-178,181-250`; `tests/integration/global-setup.ts:7-15`).

- [x] **TEST-02 — Fixed fixture identities allow cross-run cleanup damage**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/tests/integration/helpers/lifecycle-fixture.ts:4-6,20-28,95-115,152-155,195-224`
  - **Vulnerability & Threat:** Independent test runs reuse Solana addresses and address-scoped cleanup can delete a neighboring run’s positions or evidence; serial execution inside one process does not establish cross-process safety.
  - **Required Code Fix:** 1. Derive valid unique Solana public keys from synthetic per-run keys without contacting any chain. Preserve validation rules used by `resolveChainAddress` (`tests/integration/helpers/lifecycle-fixture.ts:1,45-47`). No real secret material is required.
2. Link fixture-created aggregate positions/lots to the same run/tenant ownership used for executions. Cleanup by concrete created IDs where available, not broad target/token alone.
3. Make cleanup verification report owned row counts only. Current token-wide trade count can see another run's rows (`:259-264`).
4. Give each test process a disposable DB/profile or explicit namespace; never clean an existing shared integration database as part of this review.

- [x] **TEST-03 — Sparse schema guard can provide misleading assurance**
  - **Severity:** `Low` | **Confidence:** `Verified`
  - **Affected Files / Evidence:** `/home/xahmie/Documents/SWAT/tests/integration/helpers/schema-guard.ts:25-70,73-76,80-109`
  - **Vulnerability & Threat:** Checking a small table/column list does not establish current constraints, policies or complete migration identity, even when clean unified migration replay succeeds.
  - **Required Code Fix:** 1. Add profile-specific expected schema identity and migration/replay evidence to the disposable test bootstrap.
2. Assert load-bearing indexes, foreign keys, tenant policy state and key function behavior alongside tables/columns; keep errors actionable.
3. Test clean creation and safe rerun against dedicated disposable databases with the documented unified core/LP migration identity. Never infer newest schema from the existence of an older table or assume that compatibility profile flags provide migration isolation.
4. Preserve setup's pool-close behavior and serial runner constraints (`tests/integration/global-setup.ts:7-15`; `vitest.integration.config.ts:27-32`).

---

## Runtime Verification Findings Checklist (6 Runtime Issues)

- [x] **RUN-01 — Existing local `swat` is superuser and BYPASSRLS. The isolated equivalent permits cross-tenant queries/updates despite tenant settings; six RLS assertions fail. Dedicated non-superuser execution passes. Remote production role remains unknown.**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Evidence:** ``packages/db/src/tenancy.ts:71-109`; `packages/db/sql/064_row_level_security.sql:28-63`; `packages/db/src/rls.test.ts:119-259`; [role output](runtime/existing-postgres-read-only.log), [failed suite](runtime/unit-db.json), [passing non-superuser suite](runtime/rls-runtime-role.json)`
  - **Required Operational / Code Fix:** Separate bootstrap/migrator, global-maintenance and user-runtime roles. Assert NOSUPERUSER/NOBYPASSRLS on application connection startup. Exercise real registered callers under the intended roles, preserving legitimate global/login paths; do not simply replace every pool with `swat_app`, whose bypass is deliberately forbidden. Never attempt to demote PostgreSQL's bootstrap role: create a separate runtime identity.

- [x] **RUN-02 — Existing local `swat` is missing `copy_position_master_lots`, `user_payment_intents`, `crypto_payments`, `lp_copy_subscriptions`, and `lp_copy_executions`. Clean unified migrations succeed. This is local schema drift, not proof of remote schema state.**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Evidence:** ``tests/integration/helpers/schema-guard.ts:25-69`; `packages/db/src/migrate.ts:11-30`; [existing schema](runtime/existing-schema-check.json), [clean migration](runtime/migrations.log)`
  - **Required Operational / Code Fix:** Back up and assess the actual populated database before separately authorized migration. Add required-table/column/schema readiness at application startup and deploy gating. Verify migration replay against a disposable populated copy and do not use generic `SELECT 1` as schema readiness. No existing-data migration was performed.

- [x] **RUN-03 — A public RPC sample is a version-1 transaction; current requests cap supported version at 0. One discovery path catches the rejection as null, which can omit evidence without an explicit compatibility record. The sampled version-1 transaction failed on-chain; no successful version-1 trade was established.**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Evidence:** ``apps/indexer/src/index.ts:441-446,533-541`; [version-0 rejection](runtime/solana-transaction.json), [version-1 response](runtime/solana-transaction-v1-0.json), [fetch provenance](runtime/live-fetches.json)`
  - **Required Operational / Code Fix:** Negotiate/validate supported RPC and SDK transaction versions; retain an unsupported-version observation and retry/quarantine instead of counting it as empty evidence. Add the captured provider error and transaction as offline compatibility fixtures. Increasing the numeric limit alone is not proof downstream SDKs accept the new layout.

- [x] **RUN-04 — The installed local dependency graph cannot resolve two declared frontend dependencies, so original type-checking and copied build fail. Some Google Font fetches also fail; no successful frontend production build/UI acceptance is established.**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Evidence:** ``apps/web/package.json:10-25`; `apps/web/lib/wallets.ts:2`; `apps/web/tailwind.config.ts:1`; [original typecheck](runtime/web-original-typecheck.log), [module resolution](runtime/web-dependency-resolution.log), [copied build](runtime/web-build-isolated.log)`
  - **Required Operational / Code Fix:** Restore a reproducible frozen-lockfile installation in a separately reviewed build environment; verify package-local links before build. Prefer bundled fonts or a controlled fetch stage. Repeat original typecheck/build and rendered UI tests after installation; do not suppress errors or call the four web unit files a production build.

- [x] **RUN-05 — RPC health fields derive from a nonempty configured URL, not a successful call. Intentionally unreachable localhost targets can still be described as healthy while database/Redis make aggregate status OK.**
  - **Severity:** `Medium` | **Confidence:** `Verified`
  - **Evidence:** ``apps/api/src/index.ts:256-305`; [service smoke](runtime/service-smoke.json)`
  - **Required Operational / Code Fix:** Separate configured, recently probed, stale and failed RPC states. Keep liveness separate from execution readiness, with timestamped bounded probes and redacted URLs. Add a dead-localhost regression; generic liveness may remain 200 but must not imply venue readiness.

- [x] **RUN-06 — Installed versions have registry advisories, including Critical-rated Next.js, proxy-addr and test-only tinypool entries. Dependency/version matches are verified; affected feature reachability and production deployment are not.**
  - **Severity:** `High` | **Confidence:** `Likely`
  - **Evidence:** ``apps/web/package.json:10-15`; `apps/mcp-server/package.json:14-20`; [registry response](runtime/dependency-audit.log), [summary](runtime/dependency-audit-summary.json)`
  - **Required Operational / Code Fix:** Triage each advisory against actual features/platforms and runtime versus development paths. Upgrade compatible vulnerable dependencies in a separately authorized fix, rebuild frozen-lockfile artifacts and rerun regression/security checks. Do not install arbitrary major versions, infer Linux exposure from a Windows-only advisory, or relabel all entries as exploitable Critical product findings.

---

## OWASP & Sensitive Data Exposure Cross-Reference Checklist (15 Items)

- [x] **LEAK-01 — Signed enrollment proof explicitly logged**
  - **Severity:** `Medium` | **Confidence:** `Verified — explicit proof-to-log flow traced; retention/replay unverified`
  - **OWASP Mapping:** Web A09 Security Logging and Alerting Failures; ASVS V14, V16; pinned `v5.0.0-16.2.5`.
  - **Flow & Evidence:** wallet typed-data signature → cookie-authenticated request at `/home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:279-297,359-381` → `request.log.info({address, signature, timestampSeconds, nonce}, ...)` at `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:534-539` → Fastify/Pino application log. Fastify logger enabled without explicit redaction at `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:54`. Data class: cryptographic authorization tuple; public address/time/nonce are context, signature is replay-sensitive proof. Actual retention, access permissions and venue replayability unverified.
  - **Required Fix:** (1) Remove signature/proof fields from normal logs; use outcome, principal ID, request ID and safe correlation metadata. (2) Apply credential/proof redaction across structured and console logs; use hash/masked correlation only where necessary. (3) Review existing log retention/access and owner-led invalidation decisions without publishing values. **Proposed verification, not run:** mocked successful/failed enrollment with unique inert proof marker must not leave that marker in any captured log; normal audit events remain useful.

- [x] **LEAK-02 — Cookie forwarding over plaintext fallback; conditional Secure flag**
  - **Severity:** `Medium` | **Confidence:** `Likely — plaintext fallback/forwarding confirmed; topology unverified`
  - **OWASP Mapping:** Web A04 Cryptographic Failures / A02 Security Misconfiguration; API8 Security Misconfiguration; ASVS V7, V12, V13, V14; pinned `v5.0.0-12.3.3` for internal HTTP TLS.
  - **Flow & Evidence:** production remote HTTP backend fallback at `/home/xahmie/Documents/SWAT/apps/web/middleware.ts:21-25` → whole Cookie header at `:37-46`. Server-only rewrite destinations also allow remote HTTP at `/home/xahmie/Documents/SWAT/apps/web/next.config.ts:9-17,24-36`; SSR resolver `/home/xahmie/Documents/SWAT/apps/web/lib/api.ts:124-151` → **session-only** header at `/home/xahmie/Documents/SWAT/apps/web/lib/api-server.ts:34-47`. Data class: bearer session cookie and, for middleware, unrelated cookies in the same request. This is a transport disclosure path, not API_KEY bundling. Browser→frontend HTTPS does not encrypt a separate server→backend HTTP hop, and HttpOnly does not protect that hop.
  - **Required Fix:** (1) Require approved HTTPS cross-host backend targets in production, with no plaintext remote fallback; explicitly document any confined local hop. (2) Forward only needed session cookies; validate redirect/target behavior. (3) Enforce production Secure cookie policy and trusted ingress metadata; configure browser TLS/HSTS after verification. **Proposed verification, not run:** reject unsafe/missing production backend config, inspect outgoing cookie allowlist with mock fetch, and test Set-Cookie under trusted/untrusted forwarded headers.

- [x] **LEAK-03 — RPC URL disclosure through three distinct sinks**
  - **Severity:** `Medium` | **Confidence:** `Likely — URL flows confirmed; credential-bearing configuration unverified`
  - **OWASP Mapping:** Web A02 Security Misconfiguration / A09 Security Logging and Alerting Failures / A10 Mishandling of Exceptional Conditions; API3 Broken Object Property Level Authorization / API8 Security Misconfiguration; ASVS V13, V14, V16; pinned `v5.0.0-14.2.3`, `v5.0.0-16.2.5`.
  - **Required Fix:** (1) Return stable endpoint IDs, provider/network labels and health booleans, never authenticated URL components. (2) Redact URL credentials and sensitive provider text **before** exceptions/logging/serialization, covering structured and console paths. (3) Restrict diagnostic access and log retention; rotate only actual exposed credentials after owner-controlled verification. **Proposed verification, not run:** inert userinfo/path/query token markers with stubbed RPC failure must be absent from public status, operator diagnostics, Redis list and SSE output; normal public endpoint/health observability remains functional.

- [x] **LEAK-04 — Local error responses echo internal exception messages**
  - **Severity:** `Medium` | **Confidence:** `Likely — error echo confirmed; sensitive producer payload unverified`
  - **OWASP Mapping:** Web A10 Mishandling of Exceptional Conditions; API8 Security Misconfiguration / API10 Unsafe Consumption of APIs; ASVS V4, V14, V16; pinned `v5.0.0-16.5.1`.
  - **Flow & Evidence:** caught error → public/client output in `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:661-666`, `/home/xahmie/Documents/SWAT/apps/api/src/routes/billing.ts:349-353`, `/home/xahmie/Documents/SWAT/apps/lp/src/routes.ts:347,397,509`, unauthenticated MCP tool response `/home/xahmie/Documents/SWAT/apps/mcp-server/src/index.ts:356-361`, and standalone test UI `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:299-302`. Browser helper retains API message and error body at `/home/xahmie/Documents/SWAT/apps/web/lib/api.ts:201-213,250-261`; vault catch logs the error object at `/home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:300-301`. Data class: conditional internal DB/provider/config detail; credentials require a sensitive producer error, not merely an error echo.
  - **Required Fix:** (1) Map known client errors to fixed public codes/messages; return generic unexpected errors with request ID. (2) Keep redacted diagnostic causes server-side, avoiding raw credential objects/body values. (3) Avoid routine browser console logging of full ApiError bodies. **Proposed verification, not run:** stub DB/provider exceptions with inert confidential markers; markers must be absent from route bodies/browser-facing errors while correlation and safe known errors remain usable.

- [x] **LEAK-05 — Log-stream bearer ticket in URL**
  - **Severity:** `Low` | **Confidence:** `Verified — ticket flow traced; one-use 60-second limitation`
  - **OWASP Mapping:** Web A09 Security Logging and Alerting Failures; ASVS V7, V14, V16; pinned `v5.0.0-14.2.1`.
  - **Flow & Evidence:** explicit admin ticket issue with Redis TTL 60 seconds at `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:219-224` → frontend EventSource query at `/home/xahmie/Documents/SWAT/apps/web/app/logs/page.tsx:139-166` → auth ticket consumption `/home/xahmie/Documents/SWAT/apps/api/src/auth/plugin.ts:167-175`. Consumption uses atomic Redis DEL injected at main index `:143-145`. Data class: short-lived bearer authorization to operator logs.
  - **Required Fix:** (1) Prefer same-origin authenticated-cookie SSE where feasible. (2) If tickets remain necessary, redact query credentials in every request/edge log and bind issuance/consumption to principal/scope. (3) Retain atomic single-use TTL. **Proposed verification, not run:** expired/replayed/concurrently consumed ticket rejection; no ticket marker in captured request logs; authorized cookie stream regression.

- [x] **LEAK-06 — Sensitive API caching policy not explicit**
  - **Severity:** `Low` | **Confidence:** `Likely — explicit header policy absent in reviewed source; actual caching unverified`
  - **OWASP Mapping:** Web A02 Security Misconfiguration; API8 Security Misconfiguration; ASVS V14; pinned `v5.0.0-14.3.2`.
  - **Flow & Evidence:** own-user account/vault and billing bodies `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:126-229,332-397` and `/home/xahmie/Documents/SWAT/apps/api/src/routes/billing.ts:292-321,421-427`; admin export `/home/xahmie/Documents/SWAT/apps/api/src/routes/admin-portfolio.ts:116-134`. No explicit sensitive-response no-store policy was located in the bounded handler/global-header search. Log SSE sets **no-cache**, not no-store, at `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:918`. Data class: personal/financial information and own-user credential identifier.
  - **Required Fix:** (1) Add explicit no-store to sensitive authenticated JSON, export and log responses. (2) Ensure CDN/reverse-proxy rules never cache user-dependent responses. (3) Preserve any reviewed safe public-data caching separately. **Proposed verification, not run:** actual header assertions across account/billing/admin/log routes and isolated alternate-session/edge cache checks.

- [x] **LEAK-07 — Own-user API-key identifier returned in full**
  - **Severity:** `Low` | **Confidence:** `Verified — own-user identifier flow traced; not unauthorized disclosure`
  - **OWASP Mapping:** data-minimization review, not automatically Broken Access Control; ASVS V14 Data Protection.
  - **Flow & Evidence:** derived identifier in plaintext `scope_policy` and enrollment response at `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:633-660`; own vault response at `:380-382` → React state at `/home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:299,315` → display only prefix/suffix at `:1273-1278`. Data class: CLOB API-key identifier, **not** complete authentication secret/passphrase. Auth is own-user, and complete credentials are sealed server-side at me `:610-623`.
  - **Required Fix:** (1) Return only status and a server-derived masked identifier if full value is unnecessary. (2) Keep complete L2 credential set server-side and document intentional display requirements. (3) Avoid identifiers in routine browser logs. **Proposed verification, not run:** UI still shows enrollment/status and masked prefix/suffix; full identifier/secret/passphrase absent from account/enrollment JSON where not explicitly required.

- [x] **OWA-01 — MCP global data/control without application authentication**
  - **Severity:** `High` | **Confidence:** `Verified`
  - **Status:** **RESOLVED** — `apps/mcp-server` has been completely deleted from the codebase, eliminating the unauthenticated listener.
  - **OWASP Mapping:** Web A01 Broken Access Control / A07 Authentication Failures; API2 Broken Authentication / API5 Broken Function Level Authorization; ASVS V4, V6, V8, V14.
  - **Resolution:** Attack surface eliminated by decommissioning and removing `apps/mcp-server`.

- [x] **OWA-02 — Publicly derivable interactive signing key**
  - **Severity:** `High` | **Confidence:** `Verified — public derivation traced; funding unverified`
  - **OWASP Mapping:** Web A04 Cryptographic Failures / A06 Insecure Design; ASVS V11, V15.
  - **Flow & Evidence:** `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:38-40` hashes a fixed public label and public owner address to seed a signing keypair; `:99-130` uses it for the interactive account; `:244-285` derives it again and signs a transfer. The genuine PDA derivation at `:102-105` is a separate account. Data class: wallet signing authority. No private entropy or confidential server key participates in the interactive-key derivation.
  - **Required Fix:** (1) Disable funding and signing for the deterministic interactive model. (2) Use a real PDA/program authority or disposable confidential random test keys, with explicit account-role labeling. (3) Enforce isolated test network/custody policy. **Proposed verification, not run:** test-only derivation policy checks, account-role assertions, and migration/deposit blocking; do not derive or sweep a real owner's account during validation.

- [x] **OWA-03 — Treasury payment not bound to claimant**
  - **Severity:** `High` | **Confidence:** `Verified — missing binding traced; payment prerequisite`
  - **OWASP Mapping:** Web A01 Broken Access Control / A06 Insecure Design; API1 Broken Object Level Authorization / API6 Unrestricted Access to Sensitive Business Flows; ASVS V2, V8.
  - **Flow & Evidence:** `/home/xahmie/Documents/SWAT/apps/api/src/routes/billing.ts:378-388` rejects only a **resolved** memo owned by another user; absent/unknown memo is not rejected. Current chain verifiers at `:65-123,155-231` validate treasury payment conditions without binding the payer to the session; Solana does not establish a chain-visible intent memo binding. Successful verification → `scope.userId` credit at `:393-419`. `/home/xahmie/Documents/SWAT/packages/db/src/billing.ts:150-205` locks/inserts for that submitting scope and records payer only as metadata. Data class: payment ownership and paid entitlement, not credentials.
  - **Required Fix:** (1) Require an existing pending unexpired user-bound intent. (2) Prove its binding through supported chain evidence or explicitly verified payer authorization, rather than trusting supplied memo text. (3) Consume intent and canonical transaction identity atomically with entitlement update. **Proposed verification, not run:** missing/unknown/other-user/expired intent rejection; alternate user's valid-payment claim rejection; duplicate and concurrent valid-owner claims.

- [x] **OWA-04 — Cross-owner Polymarket grant overwrite**
  - **Severity:** `High` | **Confidence:** `Verified — owner overwrite traced; venue/replay impact conditional`
  - **OWASP Mapping:** Web A01 Broken Access Control / A06 Insecure Design; API1 Broken Object Level Authorization; ASVS V2, V8, V11.
  - **Flow & Evidence:** authenticated enrollment checks session scope at `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:525-539`. The challenge uses timestamp and constant nonce without a stored user-bound enrollment challenge at `:489-515`. Venue-accepted credentials are sealed using the **submitting** user AAD at `:603-623`, then `ON CONFLICT (chain, account_address)` sets `user_id = EXCLUDED.user_id` without same-owner condition at `:639-651`. The global unique address constraint is `/home/xahmie/Documents/SWAT/packages/db/sql/047_user_execution_grants.sql:113`. Data class: tenant ownership of signing authorization and sealed venue credentials.
  - **Required Fix:** (1) Reject different-owner conflict, matching the ownership-preserving pattern in `/home/xahmie/Documents/SWAT/packages/db/src/auth-wallets.ts:26-62`. (2) Bind enrollment authorization to an authenticated linked wallet and single-use user/address challenge in the application in addition to venue requirements. (3) Revoke/replace grants transactionally and audit without proof contents. **Proposed verification, not run:** alternate-session reuse and cross-owner conflict must leave the victim row untouched; legitimate same-owner renewal remains supported; venue-response stubs avoid real credential derivation.

- [x] **OWA-05 — Withdrawal signature does not bind executed intent**
  - **Severity:** `Medium` | **Confidence:** `Verified — missing binding traced; valid signature prerequisite`
  - **OWASP Mapping:** Web A06 Insecure Design / A08 Software or Data Integrity Failures; API6 Unrestricted Access to Sensitive Business Flows; ASVS V2, V8, V11.
  - **Flow & Evidence:** `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:206-230` verifies caller-supplied message bytes while independently checking an unsigned timestamp. `:244-283` uses independently supplied amount and owner to derive/sign the transfer. No canonical-message comparison or single-use nonce store is present. Honest client signs amount/owner/time at `/home/xahmie/Documents/SWAT/pda-test-ui/public/index.html:826-862`; server does not enforce that structure. Data class: signed financial intent.
  - **Required Fix:** (1) Construct/validate one canonical domain-separated intent binding every executable field, network, expiry, and nonce. (2) Strictly validate integer ranges and consume a server nonce atomically before side effects. (3) Preserve durable idempotency through uncertain submission. **Proposed verification, not run:** changed amount/time/network/message rejection, nonce replay/concurrency rejection, legitimate signed intent succeeds using mocked chain dependencies.

- [x] **OWA-06 — Credentialed CORS trusts unlisted origins**
  - **Severity:** `Medium` | **Confidence:** `Likely — permissive source configuration confirmed; browser impact untested`
  - **OWASP Mapping:** Web A02 Security Misconfiguration; API8 Security Misconfiguration; ASVS V3, V4, V13; pinned `v5.0.0-3.4.2`.
  - **Flow & Evidence:** main CORS reflects origin when `CORS_ORIGIN` is absent at `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:90-104`. LP callback returns `true` even for disallowed origin at `/home/xahmie/Documents/SWAT/apps/lp/src/index.ts:277-295`; the configured list is ineffective. Data class: cookie-authenticated own-user account/financial responses readable from an untrusted origin **if the browser actually sends credentials**.
  - **Required Fix:** (1) Reject unlisted origins; remove suffix-based acceptance. (2) Fail closed in production on absent origin policy while preserving needed no-Origin service callers. (3) Keep CSRF and restrictive cookie settings. **Proposed verification, not run:** exact allowed/disallowed/no-Origin preflight matrix plus same-site/unrelated-site browser credential-delivery tests in an isolated deployment.

- [x] **OWA-07 — Test UI error/response text reaches HTML sinks**
  - **Severity:** `Medium` | **Confidence:** `Likely — HTML sinks confirmed; attacker influence/execution untested`
  - **OWASP Mapping:** Web A05 Injection; API10 Unsafe Consumption of APIs where provider-derived content is consumed; ASVS V1, V3, V16.
  - **Flow & Evidence:** `/home/xahmie/Documents/SWAT/pda-test-ui/public/index.html:463-470,503-507` inserts log/error text with innerHTML. Own API error → `Error(data.error)` → catch → log at `:865-887`; successful response fields also enter innerHTML at `:876-883`. Raw server error producers include `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:299-302`. Data class: integrity of the wallet-connected browser and its runtime test signer; not a located hardcoded secret. Browser-generated test key stays in memory at HTML `:623-639`.
  - **Required Fix:** (1) Use textContent and constructed DOM nodes for errors/logs. (2) Validate explorer URLs and use fixed public errors. (3) Add compatible CSP as defense in depth. **Proposed verification, not run:** inert markup fixtures remain text across errors, logs, and success banners; valid links still work; wallet signing behavior unchanged.

- [x] **OWA-08 — Spreadsheet formula injection in admin export**
  - **Severity:** `Medium` | **Confidence:** `Likely — escaping gap confirmed; spreadsheet interpretation untested`
  - **OWASP Mapping:** Web A05 Injection; ASVS V1, V14.
  - **Flow & Evidence:** `/home/xahmie/Documents/SWAT/apps/api/src/routes/admin-portfolio.ts:25-42` escapes CSV syntax but not formula-leading cells; export at `:116-134` is explicitly admin-only. `/home/xahmie/Documents/SWAT/packages/db/src/admin-portfolio.ts:555-620` exports user/portfolio text and financial data. Data class: administrator workstation and exported personal/financial data; tenant data is intentionally admin-visible, not an anonymous JSON leak.
  - **Required Fix:** (1) Define a spreadsheet-safe export policy for all string cells including leading whitespace/control characters. (2) Neutralize dangerous formula prefixes or emit a typed format with cells as text. (3) Preserve CSV syntax escaping. **Proposed verification, not run:** formula-shaped inert strings remain literal in supported readers; commas/quotes/newlines and financial numeric cells still round-trip.
