# 01 — API defensive security review

Static authorized review, 2026-11-06. Repository `/home/xahmie/Documents/SWAT`. Source unchanged; no network, service execution, real environment/secret access, or tests. **Tests NOT RUN throughout.** Verified means the relevant source and callers establish the stated code behavior, not that deployment or a live exploit was tested. Likely requires a mocked dependency/concurrency test. No Critical finding is supported.

## A. Boundaries, map evidence, and coverage

The product describes a multi-tenant trading control plane and non-custodial vaults (`README.md:5-7,55-67,151`). Tenant identity must remain distinct from settlement address (`docs/adr/0001-tenancy-key.md:43-73`). Scoped authority is an architectural requirement, not proof of implementation (`docs/adr/0003-delegated-execution-authority.md:9-18`). Citations below are repository-relative for readability; the appendix supplies absolute paths.

**Observed map:** API entrypoint `apps/api/src/index.ts:52-68` constructs Fastify, Redis, per-chain trade queues via `tradeQueueForChain(chain)`, and `QUEUES.walletBackfill`; `apps/api/src/index.ts:70` constructs `QUEUES.tokenDiscovery`. Queue constant definitions and worker consumers were **NOT VERIFIED**. HTTP binds `0.0.0.0` at `apps/api/src/index.ts:972-975`; deployment's example forwards `/v1/` to localhost:3001 and sets forwarded headers (`DEPLOYMENT.md:480-487`). This is an example, not an inspected installed proxy.

Hook order is cookie → global rate limiter → auth → admin gate → scoped credential limiter (`apps/api/src/index.ts:124-177`). Public paths are health, signup/login, wallet nonce/verify (`apps/api/src/auth/plugin.ts:35-42`). Session cookies take precedence over other credentials; bearer authentication is explicitly rejected; the shared service key carries no tenant (`apps/api/src/auth/plugin.ts:135-194,204-209`). Operator `/v1/` routes are default-denied to ordinary users; only auth/me/billing prefixes are user-reachable (`apps/api/src/auth/plugin.ts:98-123`). SSE ticket issuance requires an admin and creates a 60-second Redis ticket (`apps/api/src/index.ts:219-224`); the auth hook atomically deletes it, then assigns service identity (`apps/api/src/index.ts:145; apps/api/src/auth/plugin.ts:171-175`). The stream receives Redis log messages and writes raw SSE (`apps/api/src/index.ts:898-940`); ticket logging/ingress retention are **NOT VERIFIED**.

Route registrations are `registerMeRoutes`, execution settings, billing, admin portfolio (`apps/api/src/index.ts:227-230`), and scoped auth (`apps/api/src/index.ts:168-176`). Load-bearing reviewed endpoints are `/v1/auth/{signup,login,logout,me,wallet/nonce,wallet/verify}` (`apps/api/src/auth/routes.ts:128-386`), billing plans/status/history/intent/verify/admin sweep (`apps/api/src/routes/billing.ts:297-462`), vault grant/revoke/Polymarket challenge/credentials (`apps/api/src/routes/me.ts:400-668`), withdrawal request-otp/confirm (`apps/api/src/routes/me.ts:1131-1297`), config and log stream (`apps/api/src/index.ts:909-967`). Additional bounded paths are settings GET/PATCH, kill-switch PUT and chain PATCH (`apps/api/src/routes/execution-settings.ts:419-608`), and administrator overview/users/detail/masters/tokens/export (`apps/api/src/routes/admin-portfolio.ts:50-134`). This is **not** an exhaustive route audit.

**Coverage yes/no:** auth/session **yes**; CSRF **yes**; CORS/proxy/configuration **yes, source/examples only**; rate-limit phase **yes, dependency internals no**; SIWE/SIWS nonce/domain **yes**; password recovery **no implementation found in searched API/web paths**; billing invoice/payer/replay/hash/expiry/sweep **yes**; withdrawals OTP **yes, no execution consumer verified**; grants/logging **yes for registration**; admin/config/errors **yes for global gate and selected handlers**, execution-settings/admin-portfolio internals **yes, including DB implementations and browser callers**; enforcement of every saved limit at execution **no**.

Positive controls: signed wallet nonce is CSPRNG, five-minute Redis TTL, atomically consumed, and checked against address, URI and domain (`apps/api/src/auth/wallet-signature.ts:34-38,116-163; apps/api/src/auth/routes.ts:263-325`). Linking an authenticated user additionally encounters CSRF (`apps/api/src/auth/plugin.ts:139-151`); wallet ownership conflicts are rejected (`packages/db/src/auth-wallets.ts:53-70`). Password hashing and token generation are explicit (`packages/db/src/credentials.ts:27-30,48-58,71-77`). Session DB resolution checks revocation and absolute/idle expiry (`packages/db/src/users.ts:241-253`), but cache caveats are assigned to module 02. General unknown errors return a stable 500 (`apps/api/src/index.ts:179-199`). Signup never forwards client role/tier (`apps/api/src/auth/routes.ts:134-138`).

## B. Findings

| ID | Severity | Confidence | Evidence file:line | Abuse (maximum three conceptual steps) | Code fix |
|---|---|---|---|---|---|
| API-01 | High | Verified | `apps/api/src/routes/billing.ts:274-286,378-419`; `packages/db/src/billing.ts:188-225` | 1. Authenticate as an ordinary user. 2. Identify an uncredited real treasury payment. 3. Submit its transaction without an owned payment reference and receive that user's tier credit. | Require authoritative owned intent and chain-specific payment-to-intent proof; fail closed for missing/unknown reference. |
| API-02 | Medium | Likely | `apps/api/src/routes/billing.ts:277,284,82,413`; `packages/db/src/billing.ts:195`; `packages/db/sql/063_crypto_billing.sql:18,34-35` | 1. Obtain a qualifying Polygon transaction. 2. Present equivalent mixed-case hash strings. 3. If RPC accepts them as the same hash, receive additional credits under different textual ledger keys. | Validate/canonicalize Polygon hashes before RPC and DB; enforce canonical uniqueness in SQL after reconciling collisions. |
| API-03 | High | Likely | `apps/api/src/routes/me.ts:502-515,536-539,603-651`; `packages/shared/src/polymarket-clob-credentials.ts:744-781` | 1. Obtain a valid victim ClobAuth tuple, including through authorized log access or leakage. 2. Submit it under a different session if venue derivation still accepts it. 3. Existing account ownership is overwritten. | Remove signature logging; require separate single-use, user-bound WAKE consent and reject cross-user conflicts. |
| API-04 | Medium | Verified | `packages/db/src/billing.ts:390-425`; `apps/api/src/routes/billing.ts:454-456`; `apps/api/src/cron/billing-sweep.ts:14-19` | 1. An expired user is selected by sweep. 2. A renewal commits before sweep's update. 3. Sweep overwrites the newly paid tier with free. | Conditional atomic update of still-expired rows, returning actual changed state; audit in the same transaction. |
| API-05 | Medium | Likely | `apps/api/src/index.ts:54,129-166`; `DEPLOYMENT.md:482-487` | 1. Requests arrive through reverse proxy. 2. IP-based limiter sees the proxy rather than the client; email may be absent at its hook phase. 3. Shared buckets cause lockouts and intended per-account limits are ineffective. | Explicit trusted proxy allowlist; early IP bucket plus post-validation credential bucket; shared store if replicas exist. |
| API-06 | Medium | Verified | `apps/api/src/routes/me.ts:98-107,1184-1189,1268-1297`; `apps/web/app/vault/page.tsx:498-524` | 1. Request OTP for a destination without an amount. 2. Confirm with a different amount; stored chain is not explicitly compared. 3. API reports queued execution although this handler only returns JSON. | Bind complete immutable withdrawal intent; durable atomic consume; return authorization-only status until an actual authorized execution handoff exists. |
| API-07 | Medium | Verified | `apps/api/src/routes/me.ts:447-477`; `packages/db/sql/047_user_execution_grants.sql:95-113`; `apps/web/app/vault/page.tsx:542-559,588-605` | 1. User supplies an arbitrary keyless Solana account. 2. Registration reserves the global account key without ownership proof. 3. Legitimate registration can conflict; the UI calls mere DB changes on-chain delegation. | Derive/verify vault ownership server-side; transactional replacement; explicit pending versus validated state; reject unsupported keyed grants. |
| API-08 | Medium | Verified | `apps/api/src/routes/execution-settings.ts:279,483,553`; `packages/db/src/user-execution-settings.ts:327-333,426-440`; `packages/db/sql/049_user_execution_settings.sql:44-48`; `apps/web/app/settings/page.tsx:67-79` | 1. An ordinary user submits a higher administrator-designated daily withdrawal cap. 2. It is persisted without an administrator ceiling or audit. 3. Independently, browser chain-limit updates use the wrong method and suppress failure while reporting success. | Separate administrator ceiling from user preference; enforce the ceiling at authorized execution; use PATCH for chains and surface failed saves. |

### 1. API-01 — payment ownership remains absent

The prior first-credit claim is **retained**, narrowly: a real successful, adequate transfer to treasury can be credited to the submitting user, not arbitrary fabricated transfers. Ownership lookup runs only when a nonempty memo and optional dependency exist; missing and unknown memos continue (`apps/api/src/routes/billing.ts:378-388,257-266`). Polygon checks treasury/token/amount but does not authenticate the requester as payer (`apps/api/src/routes/billing.ts:91-108`). Solana computes treasury balance increase and takes the first signer as a descriptive payer; its memo parameter is never parsed (`apps/api/src/routes/billing.ts:155-160,196-223`). The recorder stores payer without comparing it to linked wallets (`packages/db/src/billing.ts:188-203`). Intent completion does not require pending status, matching plan or unexpired time (`packages/db/src/billing.ts:222-225`), despite a 48-hour intent lifetime (`packages/db/src/billing.ts:87-88`). Exact-string uniqueness prevents a *second identical claim*, not the first unauthorized claim.

Fix steps: (1) choose explicit rails: verified linked payer for wallet payments, versus uniquely bound chain-visible reference/deposit address for exchange payments; a caller-supplied memo alone is not evidence. (2) Load and lock the owned pending unexpired intent and its plan/amount. (3) Verify the actual transfer/reference, finality and canonical identity; credit and complete atomically. Compatibility: the UI reads `intent.referenceMemo` although API returns `{intent,...}` (`apps/web/app/billing/page.tsx:191-194; apps/api/src/routes/billing.ts:344-348`); correct this and remove the invented fallback memo. Re-read validation: verify handler and DB insert/update path were reread, with targeted searches for verifier and UI callers. **Tests NOT RUN**; local mocked tests must reject omitted/unknown/wrong-user/expired/completed intent and mismatched on-chain reference while preserving approved exchange flows.

### 2. API-02 — text hash normalization is not enforced

The DB key is case-sensitive text; the route forwards raw input unchanged (`apps/api/src/routes/billing.ts:274-287; packages/db/src/billing.ts:195; packages/db/sql/063_crypto_billing.sql:18,35`). Polygon RPC semantic acceptance of different casing is **NOT VERIFIED**. This is **Medium / Likely**, not a supported High repeat-credit exploit; static text-key mismatch alone does not establish accepted equivalent receipts. Solana signatures are case-sensitive and must not be lowercased.

Fix steps: (1) strict chain-specific validation, Polygon `0x` plus 64 hexadecimal digits canonicalized to lowercase; preserve valid Solana base58 bytes. (2) inventory historical collisions before adding canonical constraints/index. (3) share normalization at every ledger writer and verifier boundary. Callers: billing UI trims only (`apps/web/app/billing/page.tsx:205`); recorder must defend direct callers too. Re-read validation includes route forwarding and DB uniqueness schema; targeted caller grep found the browser verification path. **Tests NOT RUN**; a fully mocked RPC returning the same receipt for case variants should produce one credit, with unchanged Solana signature behavior.

### 3. API-03 — logged authorization and mutable ownership

The complete signature tuple is explicitly logged; recovery results are only diagnostic and never gate the later branch (`apps/api/src/routes/me.ts:536-599`). Challenge uses constant credential nonce zero and has no stored WAKE/user challenge (`apps/api/src/routes/me.ts:502-515`). The helper forwards the supplied signature to the external create/derive endpoints (`packages/shared/src/polymarket-clob-credentials.ts:753-780`). On success, the route seals L2 credentials under the submitting tenant then executes `SET user_id = EXCLUDED.user_id` for a global `(chain, account_address)` conflict (`apps/api/src/routes/me.ts:610-651`). Envelope binding therefore does not establish consent from the existing tenant.

Correction to prior claim: no proof that an old signature remains valid indefinitely, no observed public log exposure, and no demonstrated withdrawal/root-key takeover. The payload holds L2 credentials, not a wallet root key (`apps/api/src/routes/me.ts:617-622`); the local auth module says orders additionally require wallet authorization (`packages/shared/src/polymarket-clob-auth.ts:17-18`). External replay window and executor impact are **NOT VERIFIED**. Signature disclosure and unsafe reassignment are static facts; the cross-session replay chain is Likely.

Fix steps: (1) remove and redact signature fields at logger configuration and route; handle retained logs as sensitive under incident policy. (2) require linked-wallet ownership plus a separate WAKE-domain single-use consent bound to session user and action, retaining venue-compatible ClobAuth separately. (3) transact revocation/upsert and restrict conflict update to existing same user, returning conflict otherwise. Preserve contract-wallet signature support rather than forcing 65-byte EOA signatures (`packages/shared/src/polymarket-clob-credentials.ts:408-421`). Caller challenge/sign/post sequence was read (`apps/web/app/vault/page.tsx:359-381`); route and helper were reread and targeted nonce/ownership searches performed. **Tests NOT RUN**; mocked venue success with a victim-owned row must not transfer ownership; duplicate challenge must fail; logger spies must never receive signature/secret/passphrase.

### 4. API-04 — sweep overwrites renewal

Fix steps: (1) downgrade with a rechecked expiry/tier predicate in an atomic transaction. (2) use returned rows for audit/counts. (3) insert strict audit using that transaction client. Current audit helper uses global `query`, not the payment transaction client (`packages/db/src/audit-log.ts:30-45,75-76; packages/db/src/transaction.ts:43-56`), so a payment audit can commit independently of a failed payment commit. Carry this secondary consistency defect into the same repair. Check both admin and standalone sweep callers above and lifetime/null expiry semantics (`packages/db/src/billing.ts:393-395`). **Tests NOT RUN**; schedule a mocked renewal between selection/update, and simulate transaction commit failure without orphan audit records.

### 5. API-05 — limiter intent versus phase/proxy

No `trustProxy` is supplied (`apps/api/src/index.ts:54`); key generator reads body without an explicit hook setting (`apps/api/src/index.ts:153-166`). Installed limiter behavior/default hook and edge settings were not inspected, so phase behavior is Likely. The comment claiming IP+email guarantees is not validation evidence.

Fix steps: (1) pin trusted ingress addresses and block untrusted direct forwarded headers. (2) use an early IP limiter for parsing/CPU defense and an explicit post-body-normalization account limiter. (3) validate finite positive limits and coordinate replicas. Verify proxy peer sharing, forged forwarded headers, email case/trim and URL query variants in local injection tests. **Tests NOT RUN**.

### 6. API-06 — incomplete withdrawal authorization, not demonstrated theft

Destination ownership, 24-hour cooling-off, random OTP, expiry, five-attempt lockout and synchronous consume exist (`apps/api/src/routes/me.ts:1144-1189,1228-1285`). The handler does **not** enqueue a withdrawal or persist an execution request before its “queued” response (`apps/api/src/routes/me.ts:1287-1297`); no funds movement exploit is inferred. Process-local storage and email delivery failures are operational limitations (`apps/api/src/routes/me.ts:1129,1193-1206`).

Fix steps: (1) create a durable intent binding user, exact chain, asset, amount and destination; email the summarized intent. (2) atomically consume its hashed OTP and attempt budget in a shared store. (3) recheck wallet/cooling-off and require user/on-chain execution authorization before a real handoff; otherwise explicitly respond authorization-only. Update UI status (`apps/web/app/vault/page.tsx:517-524`). **Tests NOT RUN**; test modified amount/chain, parallel consume, replica routing, restart, failed email, and no misleading execution success.

### 7. API-07 — unsupported registration and non-atomic replacement

Solana keyless rows can reserve arbitrary global account addresses; no signature/derivation check appears (`apps/api/src/routes/me.ts:450-477; packages/db/sql/047_user_execution_grants.sql:95-113`). Keyed kinds without secrets fail SQL rather than establish delegated authority. Revoking before a failing insert can lose the user's active record (`apps/api/src/routes/me.ts:462-477`). Neither this finding nor the UI's statements proves that an attacker can execute from the reserved vault.

Fix steps: (1) verify linked ownership and deterministic approved-network PDA or independently verified delegation receipt. (2) transact validated replacement, handling existing same-user account idempotently and other-user conflict safely. (3) hide unsupported keyed grant registration and label DB revocation separately from actual on-chain revocation. Check current UI synthetic Robinhood address and promises at `apps/web/app/vault/page.tsx:587-605`. **Tests NOT RUN**; reject arbitrary vaults, verify chain-kind compatibility, and roll back failed replacement.

### 8. API-08 — risk-setting authority and misleading save status

The schema accepts `maxDailyWithdrawalUsd` from an ordinary authenticated tenant; the DB requires only a nonnegative finite value and persists it (`apps/api/src/routes/execution-settings.ts:279,453-483; packages/db/src/user-execution-settings.ts:327-333,426-440`). The SQL explicitly designates raising this cap as an audited administrator action (`packages/db/sql/049_user_execution_settings.sql:44-48`). Neither settings write nor kill-switch helper emits that audit (`packages/db/src/user-execution-settings.ts:389-449,461-473`). This is a policy/authority defect in saved settings, **not a demonstrated withdrawal bypass**: the withdrawal handler currently only returns JSON (`apps/api/src/routes/me.ts:1287-1297`). Separately, the browser sends PUT to a chain endpoint registered only as PATCH, swallows the error, and displays success (`apps/web/app/settings/page.tsx:74-79; apps/api/src/routes/execution-settings.ts:553`). A user's chosen slippage can therefore remain unchanged while the UI says saved.

Fix steps: (1) distinguish an audited administrator ceiling from the user's lower requested limit; reject unprivileged ceiling increases and enforce the effective cap atomically wherever real execution is implemented. (2) audit accepted changes and kill-switch actions without secrets. (3) switch the browser to PATCH, stop suppressing failed chain saves, and display authoritative returned limits/partial success. Preserve session-derived tenancy, strict payload rejection and tier-derived live entitlement (`apps/api/src/routes/execution-settings.ts:271-295,593-595`). Barrel exports now exist (`packages/db/src/index.ts:37-43`); comments claiming they are missing are stale, not a present source packaging vulnerability. **Tests NOT RUN**; use mocked user/admin requests and browser failures to verify ceilings, audit, wrong-method rejection, and no success after unsaved limits. Actual downstream enforcement of all settings remains outside this bounded check.

## C. Explicit invariants and proposed local tests

In addition to each finding's tests: service credentials never satisfy tenant handlers (`apps/api/src/auth/plugin.ts:204-209`); non-admin users cannot mint SSE tickets (`apps/api/src/index.ts:219-224`); cookie mutations including wallet linking require CSRF (`apps/api/src/auth/plugin.ts:139-151`); nonces are single-use and bound to domain/URI/address (`apps/api/src/auth/routes.ts:292-325`). Use dependency-injected Redis/DB/Fastify fixtures only; reject concurrent nonce reuse and wrong-domain signatures. SIWE formatting is partial rather than full EIP-4361 parsing (`apps/api/src/auth/wallet-signature.ts:52-62,116-134`); test wallet interoperability separately, without claiming nonce/domain bypass.

Production invariants should require exact CORS allowlist and Secure cookies: current CORS reflects any origin when absent (`apps/api/src/index.ts:90-104`), while cookie security depends on override/protocol/raw forwarded header (`apps/api/src/auth/routes.ts:103-108`). This is hardening with **deployment NOT VERIFIED**, not a proved cross-site session theft; SameSite and CSRF still constrain exploitation. Global config validates keys but not value shapes, and does not emit audit in that handler (`apps/api/src/index.ts:947-967`); test consumers before stricter schemas. Recovery completeness is not assumed: searched API routes contain no reset endpoint; `changePassword` has no API caller found and has cache concerns in module 02 (`packages/db/src/users.ts:125-136`). All tests here **NOT RUN**.


Administrator portfolio coverage: every route has `requireRole(..., 'admin')` before queries (`apps/api/src/routes/admin-portfolio.ts:50-123`), and DB filters use SQL parameters for search/user IDs (`packages/db/src/admin-portfolio.ts:197-219,341-350`). Read results expose summaries, not `sealed_secret`, API-key secrets or passwords (`packages/db/src/admin-portfolio.ts:221-280,341-401,563-604`). No non-admin exposure was established. CSV quoting does not neutralize spreadsheet formulas (`apps/api/src/routes/admin-portfolio.ts:25-42`); harden spreadsheet-safe exports and test hostile stored text before administrative downloads. Revenue UI requests only the first 100 users and computes nominal prices rather than payments (`apps/web/app/admin/revenue/page.tsx:31,49-57`), despite calling this a live verified audit (`apps/web/app/admin/revenue/page.tsx:116`). Treat these metrics as estimates, not a reconciled treasury ledger. Portfolio PnL/win-rate uses trade cashflow/positive sells and contains fixed placeholder values (`packages/db/src/admin-portfolio.ts:133-170,449-464,506-543`); no money-moving administrator revenue endpoint was found in these reviewed paths. Browser portfolio fetch/export uses cookie credentials (`apps/web/app/admin/portfolio/page.tsx:91-159`). These are explicit coverage qualifications, not proof of all fleet accounting correctness.

## D. Not reviewed and reasons

No installed proxy/TLS/CORS/env/roles/log retention or external RPC/CLOB behavior: prohibited live/secret inspection. No node_modules, build artifacts or lockfiles: expressly excluded; limiter defaults and viem hash transport remain unverified. No full executor, queue consumers, smart contracts, LP service, perps or exhaustive tenant query audit: separate modules/time scope. No recovery page at `apps/web/app/forgot-password/page.tsx`: attempted path does not exist; absence at that path is not a full product guarantee. Root CLAUDE reported missing by requester; inherited FHEVM-only instruction file was not read or applied.

## Appendix — exact read inventory

“Deep” includes the **specified regions**, not an assertion that the entire long file was read. “Skim” includes search-only inspection. All unlisted source is not reviewed. Machine-readable manifest below stays inside the only authorized report paths; no separate evidence file was created.

```json
{
  "reportIds": ["API-01", "API-02", "API-03", "API-04", "API-05", "API-06", "API-07", "API-08"],
  "tested": false,
  "deep": [
    "/home/xahmie/Documents/SWAT/README.md",
    "/home/xahmie/Documents/SWAT/docs/adr/0001-tenancy-key.md",
    "/home/xahmie/Documents/SWAT/docs/adr/0003-delegated-execution-authority.md",
    "/home/xahmie/Documents/SWAT/apps/api/src/auth/plugin.ts",
    "/home/xahmie/Documents/SWAT/apps/api/src/auth/routes.ts",
    "/home/xahmie/Documents/SWAT/apps/api/src/auth/wallet-signature.ts",
    "/home/xahmie/Documents/SWAT/apps/api/src/index.ts",
    "/home/xahmie/Documents/SWAT/apps/api/src/routes/billing.ts",
    "/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts",
    "/home/xahmie/Documents/SWAT/apps/api/src/cron/billing-sweep.ts",
    "/home/xahmie/Documents/SWAT/packages/shared/src/billing.ts",
    "/home/xahmie/Documents/SWAT/packages/shared/src/polymarket-clob-auth.ts",
    "/home/xahmie/Documents/SWAT/packages/shared/src/polymarket-clob-credentials.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/billing.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/users.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/credentials.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/auth-wallets.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/transaction.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/audit-log.ts",
    "/home/xahmie/Documents/SWAT/packages/db/sql/063_crypto_billing.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/047_user_execution_grants.sql",
    "/home/xahmie/Documents/SWAT/apps/web/lib/api.ts",
    "/home/xahmie/Documents/SWAT/apps/web/app/billing/page.tsx",
    "/home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx",
    "/home/xahmie/Documents/SWAT/DEPLOYMENT.md",
    "/home/xahmie/Documents/SWAT/apps/api/src/routes/execution-settings.ts",
    "/home/xahmie/Documents/SWAT/apps/api/src/routes/admin-portfolio.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/user-execution-settings.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/admin-portfolio.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/index.ts",
    "/home/xahmie/Documents/SWAT/packages/db/sql/049_user_execution_settings.sql",
    "/home/xahmie/Documents/SWAT/apps/web/app/settings/page.tsx",
    "/home/xahmie/Documents/SWAT/apps/web/app/admin/revenue/page.tsx",
    "/home/xahmie/Documents/SWAT/apps/web/app/admin/portfolio/page.tsx"
  ],
  "skim": [
    "/home/xahmie/Documents/SWAT/docs/DEPLOYMENT_AND_ARCHITECTURE_GUIDE.md",
    "/home/xahmie/Documents/SWAT/apps/api/package.json",
    "/home/xahmie/Documents/SWAT/apps/api/src/routes/billing.test.ts",
    "/home/xahmie/Documents/SWAT/packages/db/src/execution-grants.ts",
    "/home/xahmie/Documents/SWAT/apps/trade-executor/src/execution-authority.ts",
    "/home/xahmie/Documents/SWAT/apps/trade-executor/src/execution-authority-adapters.ts",
    "/home/xahmie/Documents/SWAT/apps/trade-executor/src/execution-authority-wiring.test.ts",
    "/home/xahmie/Documents/SWAT/apps/trade-executor/src/execution-authority.test.ts",
    "/home/xahmie/Documents/SWAT/apps/trade-executor/src/execution-authority-adapters.test.ts",
    "/home/xahmie/Documents/SWAT/apps/web/lib/route-access.ts",
    "/home/xahmie/Documents/SWAT/apps/web/lib/route-access.test.ts",
    "/home/xahmie/Documents/SWAT/apps/web/lib/wallets.ts",
    "/home/xahmie/Documents/SWAT/apps/web/app/learn/page.tsx",
    "/home/xahmie/Documents/SWAT/apps/web/app/logs/page.tsx",
    "/home/xahmie/Documents/SWAT/apps/web/app/lp/whales/page.tsx",
    "/home/xahmie/Documents/SWAT/apps/web/app/workspace/views/AttributionView.tsx",
    "/home/xahmie/Documents/SWAT/apps/web/app/workspace/views/HealthView.tsx",
    "/home/xahmie/Documents/SWAT/packages/shared/src/email.ts",
    "/home/xahmie/Documents/SWAT/packages/shared/src/jito.ts",
    "/home/xahmie/Documents/SWAT/packages/shared/src/jupiter-swap.ts",
    "/home/xahmie/Documents/SWAT/packages/shared/src/rpc-failover.ts",
    "/home/xahmie/Documents/SWAT/packages/db/sql/015_audit_schema_repairs.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/042_user_api_keys.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/046_polymarket_redemptions.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/050_copy_tenancy.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/051_subscription_states.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/052_user_email_verification.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/054_copy_evidence_quote_units.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/055_polymarket_position_exits.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/056_master_membership.sql",
    "/home/xahmie/Documents/SWAT/packages/db/sql/064_row_level_security.sql"
  ],
  "excluded": [
    {"path":"/home/xahmie/Documents/SWAT/**/.env*","reason":"No environment or secret reads, including example files"},
    {"path":"/home/xahmie/Documents/SWAT/**/node_modules/**","reason":"Explicit dependency exclusion"},
    {"path":"/home/xahmie/Documents/SWAT/**/{build,dist}/**","reason":"Explicit artifact exclusion"},
    {"path":"/home/xahmie/Documents/SWAT/**/*lock*","reason":"Explicit lockfile exclusion"},
    {"path":"/home/xahmie/Documents/SWAT/apps/web/app/forgot-password/page.tsx","reason":"Read attempted; path absent"},
    {"path":"/home/xahmie/Documents/SWAT/programs/**","reason":"On-chain enforcement excluded from API module"},
    {"path":"/home/xahmie/Documents/SWAT/apps/lp/**","reason":"Separate service outside module"},
    {"path":"/home/xahmie/Documents/.claude/CLAUDE.md","reason":"Requester identifies inherited FHEVM-only guidance as inapplicable"}
  ]
}
```

Additional partial deep ranges: settings UI 1-135; revenue UI 1-120; portfolio UI 1-176; DB barrel 1-111. Both added route implementations, both DB implementations and migration 049 were read in full.

Partial deep ranges: ADR-0003 1-230; index 1-240 and 898-976; me 1-160,400-684,1120-1342; clob-credentials 390-504 and 700-782; web API 1-270; billing UI 165-249; vault UI 350-424 and 475-699; DEPLOYMENT 445-519. Files otherwise marked deep were read in full. The research skill was loaded from `/home/xahmie/Documents/SWAT/.agents/skills/research/SKILL.md` as workflow guidance, not security evidence. Search-only results are not end-to-end validation of those files.
