# All retained security weaknesses — assessment only

Date: 2026-11-06. Repository: `/home/xahmie/Documents/SWAT`.

## What the evidence establishes

**The reviews identify weaknesses, not proof that an attacker has breached SWAT or stolen funds.** No unauthorized compromise, theft, wallet takeover, real duplicate venue execution or remote production exposure is established by these records. The highest source-supported retained severity is High; no product Critical finding is supported. Local superuser row-isolation failures are actual runtime evidence of a dangerous configuration, not evidence that an unauthorized person used it.

The most consequential clusters concern wrong-principal signing, missing tenant identity, incomplete user policy enforcement, excessive swap economic authority, source misclassification, blocked reducing exits, and external submissions lacking durable recovery/accounting. The independent agent listener, unsafe funded-testbed design, deployment privileges and backend transport add separate access/credential risks. Availability, misleading UI/health states, build failures and missing test assurance are included, but are not all security exploits.

This is a consolidation of existing bounded reviews, not a new full code audit. All twelve module finding tables, synthesis, finding register and runtime verification/summary were read; selected source snippets were followed for claim qualification. This assessment ran no tests, builds, validators, services or network calls, loaded no credentials, and made no commits or application fixes. Only this requested report was created, under `threats/`.

Primary records:
- `/home/xahmie/Documents/SWAT/threats/evidence/finding-register.json`
- `/home/xahmie/Documents/SWAT/threats/02-synthesis-and-remediation.md:14-29,210-218`
- `/home/xahmie/Documents/SWAT/threats/04-runtime-verification.md:4-14,55-70,107-123`
- `/home/xahmie/Documents/SWAT/threats/runtime/runtime-summary.json`

## Exact counts and meanings

| Snapshot | Critical | High | Medium | Low | Total |
|---|---:|---:|---:|---:|---:|
| Twelve raw module tables | 0 | 27 | 48 | 7 | 82 |
| Retained root-cause register | 0 | 24 | 46 | 6 | 76 |

Retained confidence: **52 Verified, 21 Likely, 3 Needs check**. Verified in the static register means traced source/callers, not a reproduced live exploit; Likely preserves input, race or integration uncertainty; Needs check lacks decisive external evidence. Runtime labels belong to the separate RUN observations and do not overwrite the static snapshot.

The six exact folds are `CRY-01 → EXE-01`, `SIG-01 → EXE-02`, `CRY-06 → API-03`, `CRY-07 → API-06`, `WEB-04 → INF-04`, and `EXE-09 → EXE-06`. Previous `OLD-01..05` are architectural lenses, not five additional retained findings. Distinct defects sharing a repair remain separate.

## Complete deduplicated listing

Every retained ID, severity and confidence below is unchanged from the register, including all six Low findings; each explanation is one sentence and the original file/range evidence and source report are preserved. Absolute paths replace relative paths for clarity; historical locations remain explicitly historical.

### 1. API and billing — 8

- **API-01 — High / Verified — Payment credit ownership missing.** A user can claim a real uncredited treasury payment without proving that the payment belongs to their subscription intent; this is not fabricated-payment acceptance.
  - Original evidence: `/home/xahmie/Documents/SWAT/apps/api/src/routes/billing.ts:274-286,378-419`; `/home/xahmie/Documents/SWAT/packages/db/src/billing.ts:188-225`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/01-api.md` (finding table; detailed qualifications follow there).

- **API-02 — Medium / Likely — Payment hash case may defeat deduplication.** Equivalent Polygon hash spellings may receive separate ledger identities if the provider accepts them; repeat credit was not demonstrated and Solana signatures are case-sensitive.
  - Original evidence: `/home/xahmie/Documents/SWAT/apps/api/src/routes/billing.ts:277,284,82,413`; `/home/xahmie/Documents/SWAT/packages/db/src/billing.ts:195`; `/home/xahmie/Documents/SWAT/packages/db/sql/063_crypto_billing.sql:18,34-35`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/01-api.md` (finding table; detailed qualifications follow there).

- **API-03 — High / Likely — Credential proof logging and account reassignment.** The API logs full Polymarket enrollment signatures and can overwrite account ownership after venue acceptance; cross-user replay, log exposure and wallet theft are not established.
  - Original evidence: `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:502-515,536-539,603-651`; `/home/xahmie/Documents/SWAT/packages/shared/src/polymarket-clob-credentials.ts:744-781`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/01-api.md` (finding table; detailed qualifications follow there).
  - Included observations: CRY-06.

- **API-04 — Medium / Verified — Billing renewal race and detached audit.** An expiry sweep can overwrite a newly renewed tier, and payment audit writes can commit separately from the payment transaction.
  - Original evidence: `/home/xahmie/Documents/SWAT/packages/db/src/billing.ts:390-425`; `/home/xahmie/Documents/SWAT/apps/api/src/routes/billing.ts:454-456`; `/home/xahmie/Documents/SWAT/apps/api/src/cron/billing-sweep.ts:14-19`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/01-api.md` (finding table; detailed qualifications follow there).

- **API-05 — Medium / Likely — Rate limiting may group the wrong clients.** Proxy handling and request-hook timing may undermine intended per-client or per-account limits, with actual limiter and deployment behavior unverified.
  - Original evidence: `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:54,129-166`; `/home/xahmie/Documents/SWAT/DEPLOYMENT.md:482-487`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/01-api.md` (finding table; detailed qualifications follow there).

- **API-06 — Medium / Verified — Withdrawal approval does not bind full intent.** The OTP does not bind the amount or explicitly recheck the stored chain, is process-local, and the handler reports queued withdrawal without an execution handoff.
  - Original evidence: `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:98-107,1184-1189,1268-1297`; `/home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:498-524`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/01-api.md` (finding table; detailed qualifications follow there).
  - Included observations: CRY-07.

- **API-07 — Medium / Verified — Vault registration lacks ownership proof.** Arbitrary keyless Solana account registration can reserve another account identity, and failed non-atomic replacement can remove an existing grant without establishing usable delegation.
  - Original evidence: `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:447-477`; `/home/xahmie/Documents/SWAT/packages/db/sql/047_user_execution_grants.sql:95-113`; `/home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:542-559,588-605`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/01-api.md` (finding table; detailed qualifications follow there).

- **API-08 — Medium / Verified — Withdrawal ceiling authority and false settings saves.** Ordinary users can raise an administrator-designated saved withdrawal ceiling without the intended audit, while browser chain-limit saves use the wrong method and hide failures; actual withdrawal bypass is not shown.
  - Original evidence: `/home/xahmie/Documents/SWAT/apps/api/src/routes/execution-settings.ts:279,483,553`; `/home/xahmie/Documents/SWAT/packages/db/src/user-execution-settings.ts:327-333,426-440`; `/home/xahmie/Documents/SWAT/packages/db/sql/049_user_execution_settings.sql:44-48`; `/home/xahmie/Documents/SWAT/apps/web/app/settings/page.tsx:67-79`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/01-api.md` (finding table; detailed qualifications follow there).

### 2. Database isolation and controls — 6

- **DB-01 — Medium / Likely — Session locks may fail through transaction pooling.** Nonce and migration session locks can lose database-backend ownership through the documented transaction pooler, although actual overlap and duplicate effects were not reproduced.
  - Original evidence: `/home/xahmie/Documents/SWAT/packages/db/src/evm-nonce.ts:87-126`; `/home/xahmie/Documents/SWAT/deploy/pgbouncer/pgbouncer.ini:23`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/robinhood.ts:799-900`; `/home/xahmie/Documents/SWAT/packages/db/src/migrate.ts:18-37`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/02-database.md` (finding table; detailed qualifications follow there).

- **DB-02 — Medium / Verified — Row isolation is not a universal application backstop.** Unscoped non-swat_app identities can be permitted all rows by the policy, and reviewed production callers do not adopt the scoped helper as a universal boundary.
  - Original evidence: `/home/xahmie/Documents/SWAT/packages/db/sql/064_row_level_security.sql:29-45,89-114`; `/home/xahmie/Documents/SWAT/packages/db/src/tenancy.ts:72-110`; `/home/xahmie/Documents/SWAT/packages/db/src/client.ts:65-68`; `/home/xahmie/Documents/SWAT/packages/db/src/user-execution-settings.ts:389-449`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/02-database.md` (finding table; detailed qualifications follow there).

- **DB-03 — Medium / Likely — Session revocation can remain cached.** Logout clears only a local cache before the database write, allowing other processes or in-flight reads to retain a revoked session within the 60-second cache window.
  - Original evidence: `/home/xahmie/Documents/SWAT/packages/db/src/users.ts:125-136,180-188,231-285`; `/home/xahmie/Documents/SWAT/apps/api/src/auth/routes.ts:190-203`; `/home/xahmie/Documents/SWAT/apps/api/src/auth/plugin.ts:135-151`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/02-database.md` (finding table; detailed qualifications follow there).

- **DB-04 — Medium / Verified — Emergency stop can leave a stale worker mode.** A separately warmed executor can retain its previously permitted mode for the remaining 30-second cache window after the API acknowledges emergency-off; post-stop live execution was not demonstrated.
  - Original evidence: `/home/xahmie/Documents/SWAT/packages/db/src/execution-config.ts:6,68-89,175-179,222-239`; `/home/xahmie/Documents/SWAT/apps/api/src/trading-control.ts:45-47`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1462-1475`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/02-database.md` (finding table; detailed qualifications follow there).

- **DB-05 — Low / Verified — Default role credentials and overly broad grants.** The migration defines a predictable login password and blanket current/future table write privileges, while reviewed later LP tables lack the same isolation coverage; deployed credentials and final policies are unverified.
  - Original evidence: `/home/xahmie/Documents/SWAT/packages/db/sql/064_row_level_security.sql:47-64`; `/home/xahmie/Documents/SWAT/packages/db/sql/066_lp_dashboard.sql:71-101`; `/home/xahmie/Documents/SWAT/packages/db/sql/065_polymarket_perps.sql:86-103`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/02-database.md` (finding table; detailed qualifications follow there).

- **DB-06 — Low / Likely — Migration replay temporarily reinstalls older rules.** Replaying historical migrations can temporarily restore a narrower LP transition rule between file commits, potentially interrupting concurrent rebalance writes; clean final replay success does not disprove that window.
  - Original evidence: `/home/xahmie/Documents/SWAT/packages/db/src/migrate.ts:21-32`; `/home/xahmie/Documents/SWAT/packages/db/sql/066_lp_dashboard.sql:168-193`; `/home/xahmie/Documents/SWAT/packages/db/sql/067_lp_auto_rebalance.sql:24-44`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/02-database.md` (finding table; detailed qualifications follow there).

### 3. Encryption and authorization helpers — 4

- **CRY-02 — Medium / Likely — Encrypted credentials lack full identity binding.** Encryption authenticates user, broad chain kind and key version but not concrete account, network, grant or purpose, leaving substitution risk conditional on row modification and a future decrypting consumer.
  - Original evidence: Verified primitive; likely needs integration test. AAD omits chain/account/grant/purpose and current API uses constant `evm`, version 1 (/home/xahmie/Documents/SWAT/packages/shared/src/authority/key-wrapper.ts:7–11,27–29; /home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:611–651; /home/xahmie/Documents/SWAT/packages/db/sql/047_user_execution_grants.sql:18–22,31–63). No production decrypt caller identified.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/03-crypto-authority.md` (finding table; detailed qualifications follow there).

- **CRY-03 — Medium / Verified — Credential wrapping is not isolated or rotation-complete.** The API holds the symmetric wrapping capability despite seal-only documentation, and default-version construction lacks a complete wrapper rotation path; this concerns L2 credentials, not independent wallet signing authority.
  - Original evidence: Verified design gap; deployment distribution needs check. API needs the environment wrapping key to seal; wrapper stores it locally, while SQL commentary claims the API has no wrapper key (/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:611–623; /home/xahmie/Documents/SWAT/packages/shared/src/authority/key-wrapper.ts:40–68; /home/xahmie/Documents/SWAT/packages/db/sql/047_user_execution_grants.sql:74–81). Opening rejects a different wrapper ID; caller creates only default version 1 (/home/xahmie/Documents/SWAT/packages/shared/src/authority/envelope.ts:92–95; /home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:611–615).
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/03-crypto-authority.md` (finding table; detailed qualifications follow there).

- **CRY-04 — Medium / Likely — Unused withdrawal signature helper permits replay.** The helper lacks full deployment/vault identity and single-use nonce consumption, so future adoption without another replay guard could reuse approvals; the current OTP API does not use it.
  - Original evidence: Verified helper path; likely needs test. Withdrawal message lacks deployment/network/program/vault identity and verification does not issue or consume nonce (/home/xahmie/Documents/SWAT/packages/shared/src/authority/withdrawal-authorization.ts:4–11,34–43,55–149). Inspected API uses OTP instead, not this helper (/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:1215–1297). Impact qualification: conditional before integration.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/03-crypto-authority.md` (finding table; detailed qualifications follow there).

- **CRY-05 — Medium / Likely — Unused permission compiler checks incomplete semantics.** Allowance policies can constrain unrelated address/amount fields and omit required spender, recipient or economic limits; no production policy-signing caller was identified and user EVM execution currently denies.
  - Original evidence: Verified compiler/evaluator path; likely needs test. Permit primary types require merely any address condition and any amount condition, not their semantic fields; contract allowance checks trust configured function name rather than selector binding (/home/xahmie/Documents/SWAT/packages/shared/src/authority/permission-policy.ts:636–692,709–767,1105–1115). Engine checks whatever conditions are supplied, not mandatory swap recipient/minimum constraints (/home/xahmie/Documents/SWAT/packages/shared/src/authority/permission-policy.ts:1185–1194). No runtime policy caller identified; per-user EVM denies (/home/xahmie/Documents/SWAT/apps/trade-executor/src/execution-authority-adapters.ts:462–467). Impact/confidence qualification: for compiler weakness; application exposure unproven.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/03-crypto-authority.md` (finding table; detailed qualifications follow there).

### 4. On-chain programs and vault presentation — 7

- **CHAIN-01 — High / Verified — Executor chooses its own vault economic limits.** An authorized global executor selects swap assets and bounds without owner-enforced expiry, cumulative spend or meaningful price policy; harm requires reachable funded vaults and zero minimum output is already rejected.
  - Original evidence: Verified code path/callers read. Global executor chooses `max_in`, positive `min_out`, raw CPI data and token accounts; vault has no mint, expiry, cumulative-spend or price policy (/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:235–329,465–481,493–515). Impact/confidence qualification: for economic scope; deployed impact conditional.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/04-on-chain-programs.md` (finding table; detailed qualifications follow there).

- **CHAIN-02 — High / Verified — Local revocation is presented as on-chain revocation.** The UI claims on-chain revoke and rent refund after a database-only API change, leaving any actually deployed unrevoked vault authority unchanged; the real owner-signed instruction does not refund rent.
  - Original evidence: Verified callers read. UI reports on-chain revocation/rent refund after HTTP; API only changes DB status; actual program revocation requires owner Signer and changes on-chain flag (/home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:536–575; /home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:400–444; /home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:164–172,399–409). Impact/confidence qualification: for false revocation guarantee; deployed effect conditional.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/04-on-chain-programs.md` (finding table; detailed qualifications follow there).

- **CHAIN-03 — Medium / Verified — Administrator authority lacks built-in recovery.** Configuration trusts an administrator signer without intrinsic multisignature enforcement or administrator replacement, so key loss or compromise has broad consequences conditional on actual governance and deployment.
  - Original evidence: Verified authority shape; operational setup needs check. Pinned initializer and `has_one` admin checks are real, but admin is a Signer, not intrinsic threshold enforcement; updater cannot replace admin (/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:35–39,46–79,339–367).
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/04-on-chain-programs.md` (finding table; detailed qualifications follow there).

- **CHAIN-04 — Medium / Needs check — Additional vault-controlled resources may escape checks.** The swap scan monitors legacy token accounts while forwarding vault signing authority to selected extra accounts, leaving Token2022 or other resource effects conditional on unverified Jupiter support.
  - Original evidence: Needs check. Named input/output require legacy `TokenAccount`/`Token`; rogue scan only considers that legacy owner ID; CPI gives vault signer to caller-selected remaining accounts (/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:25,273–315,471–486). Token2022 CPI routes/holdings were not verified. Impact qualification: conditional.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/04-on-chain-programs.md` (finding table; detailed qualifications follow there).

- **CHAIN-05 — Medium / Verified — Contract tests do not exercise real handlers.** Helper and synthetic-state tests do not establish actual instruction, account-validation or cross-program behavior, leaving fund-facing contract enforcement untested at runtime.
  - Original evidence: Verified coverage gap. Rust tests and “Trident” suite call pure helpers/synthetic state, not real instructions/Anchor account validation/CPI (/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:635–881; /home/xahmie/Documents/SWAT/programs/wake-vault/trident-/home/xahmie/Documents/SWAT/tests/fuzz_0/src/lib.rs:4–5,44–102,109–141). Initial-admin test compares keys, prefund test evaluates booleans (/home/xahmie/Documents/SWAT/programs/wake-vault/src/lib.rs:698–704,720–729).
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/04-on-chain-programs.md` (finding table; detailed qualifications follow there).

- **CHAIN-06 — Medium / Verified — Invalid vault identity is replaced with an active-looking fallback.** Failed vault-address derivation returns the program address and the page supplies active-looking fallback data, potentially misleading users about valid funding or delegation identity.
  - Original evidence: Verified helper/callers. PDA derivation error returns program ID as purported vault; page uses it as active identity/grant and substitutes active-looking fallback data on API failure (/home/xahmie/Documents/SWAT/apps/web/lib/wallets.ts:12–29; /home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:131–163,197–224,632–649). Impact/confidence qualification: for fail-open identity presentation.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/04-on-chain-programs.md` (finding table; detailed qualifications follow there).

- **CHAIN-07 — Low / Verified — Minimal vault lacks explicit account prechecks.** The demonstration withdrawal handler omits explicit system-owner, empty-data, writable-account and system-program checks before its external instruction, but existing owner/PDA checks remain and no bypass was shown.
  - Original evidence: Verified minimal handler. Signature, own destination, PDA, positive amount and balance checks exist; vault System-owner/empty-data, account writable and System-program identity checks are not explicit before CPI (/home/xahmie/Documents/SWAT/programs/pda-vault-minimal/src/lib.rs:30–79). Impact/confidence qualification: for hardening, not demonstrated bypass.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/04-on-chain-programs.md` (finding table; detailed qualifications follow there).

### 5. Indexer and source parsing — 8

- **IDX-01 — High / Verified — Balance changes can be mistaken for swaps.** Opposite balance changes can become copyable trades without adequate successful supported-swap proof, although the sampled failed runtime transaction correctly produced no event for the checked owners.
  - Original evidence: /home/xahmie/Documents/SWAT/apps/indexer/src/parse.ts:183-209,234-260; /home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:157-164,251-305; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:597-631
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/05-indexer-parsers.md` (finding table; detailed qualifications follow there).

- **IDX-02 — High / Verified — Raw-unit ranking can misidentify trade legs.** Choosing the largest positive and negative raw balances across mixed-decimal or multi-leg assets can produce the wrong copied token, direction or quantity.
  - Original evidence: /home/xahmie/Documents/SWAT/apps/indexer/src/parse.ts:138-155,179-209; /home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:285-324; /home/xahmie/Documents/SWAT/apps/indexer/src/source-trade-lifecycle.ts:81-106
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/05-indexer-parsers.md` (finding table; detailed qualifications follow there).

- **IDX-03 — Medium / Verified — Fees and rent can distort source quantities.** Enhanced normalization can treat the tracked wallet as fee payer and misattribute fees, rent or wrapping flows, making raw and enhanced trade quantities disagree.
  - Original evidence: /home/xahmie/Documents/SWAT/apps/indexer/src/webhook.ts:64-75; /home/xahmie/Documents/SWAT/apps/indexer/src/webhook-helpers.ts:102-133; /home/xahmie/Documents/SWAT/apps/indexer/src/parse.ts:76-78,162-176
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/05-indexer-parsers.md` (finding table; detailed qualifications follow there).

- **IDX-04 — Medium / Verified — Source confirmation and reversal recovery are incomplete.** Builders mark observations confirmed without a reviewed production finality-advancement path, leaving reversal-driven inventory errors conditional on actual provider or chain events.
  - Original evidence: /home/xahmie/Documents/SWAT/apps/indexer/src/source-trade-lifecycle.ts:92-105,148-163,188-203; /home/xahmie/Documents/SWAT/apps/indexer/src/evm.ts:166-195; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:719-746,872-880 (external reversal incidence: Needs check)
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/05-indexer-parsers.md` (finding table; detailed qualifications follow there).

- **IDX-05 — Medium / Likely — Fill identity can diverge between ledgers.** Polymarket identities based on economic fields differ from legacy identities, so split fills or corrections may collapse or duplicate events if the unverified provider contract permits those cases.
  - Original evidence: /home/xahmie/Documents/SWAT/apps/indexer/src/source-trade-lifecycle.ts:116-163; /home/xahmie/Documents/SWAT/packages/db/src/transactions.ts:110-132; /home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts:355-390; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:644-645,700-710
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/05-indexer-parsers.md` (finding table; detailed qualifications follow there).

- **IDX-06 — Medium / Verified — Gross route flows can overstate wallet inventory.** Robinhood route and transfer attribution can count gross or multi-beneficiary flows rather than the tracked wallet’s actual net trade quantity.
  - Original evidence: /home/xahmie/Documents/SWAT/apps/indexer/src/robinhood-ingestion.ts:190-262; /home/xahmie/Documents/SWAT/apps/indexer/src/evm.ts:313-329,455-488
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/05-indexer-parsers.md` (finding table; detailed qualifications follow there).

- **IDX-07 — Medium / Verified — Unknown market risk is replaced with safe-looking defaults.** Missing Polymarket risk, tick or end metadata can be turned into complete-looking market context without authoritative evidence.
  - Original evidence: /home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts:152-157,180-185,199-209,245-272; /home/xahmie/Documents/SWAT/packages/db/src/polymarket.ts:146-174
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/05-indexer-parsers.md` (finding table; detailed qualifications follow there).

- **IDX-08 — Medium / Verified — Backfill work lacks total resource bounds.** Cycling pagination or hanging metadata can consume unbounded worker time or memory despite individual request and row handling.
  - Original evidence: /home/xahmie/Documents/SWAT/apps/indexer/src/polymarket.ts:67-128,314-317; /home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:91-109,130-153,261-283
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/05-indexer-parsers.md` (finding table; detailed qualifications follow there).

### 6. Signals, scoring and reducing exits — 8

- **SIG-02 — High / Verified — Master sells are sized against shared inventory.** A master’s sell fraction is applied to aggregate inventory instead of that master’s lots, allowing an external over-sale before narrower bookkeeping rejects or misallocates it.
  - Original evidence: /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:1952-1976,2332-2365; /home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1743-1759,2304-2337; /home/xahmie/Documents/SWAT/packages/db/src/lot-allocation.ts:25-73
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/06-signals-scorer.md` (finding table; detailed qualifications follow there).

- **SIG-03 — High / Verified — Close-all exits are blocked by the entry gate.** The worker requires an acquisition signal to remain pending even for a reserved close-all exit, allowing a completed queue job to leave the owned lot and reservation open.
  - Original evidence: /home/xahmie/Documents/SWAT/apps/scorer/src/close-all.ts:46-70; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:1665-1732; /home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1683-1688,2434-2435; /home/xahmie/Documents/SWAT/packages/db/src/trades.ts:309-318
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/06-signals-scorer.md` (finding table; detailed qualifications follow there).

- **SIG-04 — High / Verified — Stop-loss jobs lose exact exit identity and quantity.** Stop-loss jobs omit required position/execution identity, leaving live Polygon without sell shares and legacy Solana using a full-wallet proportion instead of the intended lot quantity.
  - Original evidence: /home/xahmie/Documents/SWAT/packages/db/src/pnl-queries.ts:300-317; /home/xahmie/Documents/SWAT/apps/scorer/src/stop-loss.ts:225-268; /home/xahmie/Documents/SWAT/packages/db/src/stop-loss.ts:85-123; /home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1505-1516,1902-1909,2304-2313,2454-2458,2608-2620; /home/xahmie/Documents/SWAT/apps/trade-executor/src/polymarket.ts:719-720
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/06-signals-scorer.md` (finding table; detailed qualifications follow there).

- **SIG-05 — High / Verified — Entry restrictions can block exposure-reducing exits.** Source score, balance, safety or full-position entry checks can reject sells during deterioration or wind-down, stranding exposure even when the master exits.
  - Original evidence: /home/xahmie/Documents/SWAT/packages/db/src/fanout-eligibility.ts:204-259; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:274-283,435-475,507,586-587; /home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:858-862
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/06-signals-scorer.md` (finding table; detailed qualifications follow there).

- **SIG-06 — Medium / Likely — Scores do not establish independent trading skill.** Legacy score admission lacks counterparty-control and sample-quality evidence, so poisoned or controlled profitable-looking histories may qualify; manipulable venue economics were not demonstrated.
  - Original evidence: /home/xahmie/Documents/SWAT/packages/db/src/scoring-queries.ts:19-115; /home/xahmie/Documents/SWAT/packages/shared/src/scoring.ts:44-59; /home/xahmie/Documents/SWAT/apps/scorer/src/index.ts:96-101,159-175; /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:630,507
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/06-signals-scorer.md` (finding table; detailed qualifications follow there).

- **SIG-07 — Medium / Verified — Independence warnings confuse unassessed with safe.** Small observed-degree hubs and limited cluster membership checks can yield no warning without positively establishing independent ownership or control.
  - Original evidence: /home/xahmie/Documents/SWAT/packages/db/src/clustering-queries.ts:34-44; /home/xahmie/Documents/SWAT/packages/db/src/independence.ts:288-317; /home/xahmie/Documents/SWAT/packages/db/src/independence-queries.ts:32-65,79-98; /home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:839-870
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/06-signals-scorer.md` (finding table; detailed qualifications follow there).

- **SIG-08 — Medium / Verified — Capacity accounting can omit committed exposure.** Unpriced obligations, post-enqueue write failures and missing ledger rows can understate commitments and overstate headroom, although fully unknown primary capacity already fails closed.
  - Original evidence: /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:540-574; /home/xahmie/Documents/SWAT/apps/signal-engine/src/capacity-inputs.ts:641-655,685-702; /home/xahmie/Documents/SWAT/packages/db/src/master-capacity.ts:721-747,815-839,1596-1605,1673-1685; /home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1318-1338
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/06-signals-scorer.md` (finding table; detailed qualifications follow there).

- **SIG-09 — Medium / Verified — Accepted work lacks complete durable delivery recovery.** User enumeration failures can become operator-only dispatch, while later skipped or exhausted exit jobs can leave missing deliveries or stuck stop-loss guards without a reviewed durable repair path.
  - Original evidence: /home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:306-313,540-552,586-587; /home/xahmie/Documents/SWAT/apps/signal-engine/src/fanout-enqueue.ts:349-359; /home/xahmie/Documents/SWAT/apps/scorer/src/stop-loss.ts:269-277; /home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:2894-2908; /home/xahmie/Documents/SWAT/packages/db/src/stop-loss.ts:110-123
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/06-signals-scorer.md` (finding table; detailed qualifications follow there).

### 7. Trade execution and recovery — 8

- **EXE-01 — High / Verified — User Solana authority inherits the operator signer.** A user-labelled job can receive an operator signer and synthetic settlement identity without a verified grant, and ordinary Jupiter dispatch bypasses the delegated signing method; live synthetic-address acceptance and user-vault theft remain unverified.
  - Original evidence: Verified production construction, user adapter, dispatch and signer. User Solana inherits the operator signer, needs no grant, synthesizes an address, and ordinary Jupiter bypasses `authority.sign`: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/execution-authority-adapters.ts:498-568,604-618`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1125-1162,1774-1795`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/jupiter-jito-config.ts:109-131`.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/07-trade-executor.md` (finding table; detailed qualifications follow there).
  - Included observations: CRY-01.

- **EXE-02 — High / Verified — Tenant identity is dropped during execution persistence.** User jobs lose userId at canonical claim and trade writes, defaulting to operator ownership and risking merged claims, missing attribution and incorrect exposure or exit accounting.
  - Original evidence: Verified fan-out to canonical claim and trade SQL. `userId` is omitted by `prepareCanonicalExecutions` and by every `persistTrade` input shape; DB normalizes omission to null: `/home/xahmie/Documents/SWAT/apps/signal-engine/src/fanout-enqueue.ts:242-255`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1179-1217,318-410`; `/home/xahmie/Documents/SWAT/packages/db/src/copy-trade-lifecycle.ts:1746-1770,1834-1849`; `/home/xahmie/Documents/SWAT/packages/db/src/trades.ts:140-180`.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/07-trade-executor.md` (finding table; detailed qualifications follow there).
  - Included observations: SIG-01.

- **EXE-03 — High / Verified — Worker can override user mode and tolerance.** The worker ignores queued user execution mode and mirror policy and lacks full user-slippage propagation, potentially widening paper/off intent or tolerance; unsupported user PM/RHC routes still deny.
  - Original evidence: Verified producer-to-consumer policy mismatch. Producer carries user `executionMode`/`mirrors`; worker ignores both and re-resolves platform mode: `/home/xahmie/Documents/SWAT/apps/signal-engine/src/fanout-enqueue.ts:246-253`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1412-1436,1462-1469,1650-1657`. No producer `maxSlippageBps`; Polymarket call has no user slippage: `/home/xahmie/Documents/SWAT/apps/signal-engine/src/fanout-enqueue.ts:215-255`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1700,2304-2314`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/polymarket.ts:740-746`.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/07-trade-executor.md` (finding table; detailed qualifications follow there).

- **EXE-04 — High / Likely — Daily exposure limit is inexact and non-atomic.** Malformed ceilings, guessed prices, zero-valued unknown fills and missing pending reservations can misstate or exceed exposure, with paper/live budget mixing and race consequences not reproduced.
  - Original evidence: Verified arithmetic failure and non-atomic cap, Likely—race test needed for overlap. Unvalidated `parseFloat` cap; guessed SOL/ETH rates; sum only confirmed filled/partial trades, excludes shadow but includes paper; unknown fill valuation writes zero: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1551-1565,353-368`; `/home/xahmie/Documents/SWAT/packages/db/src/trades.ts:423-433`. Legacy/replica concurrency exists: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/trade-workers.ts:93-99`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:2893-2902`.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/07-trade-executor.md` (finding table; detailed qualifications follow there).

- **EXE-05 — High / Verified — Upstream swap bytes are signed without full intent inspection.** Quote identity and final instructions/accounts are insufficiently checked before operator signing, so valid but unauthorized upstream-built effects remain possible; simulation success does not establish consent.
  - Original evidence: Verified build-to-sign trust boundary. Quote checks amounts/mode but not requested mints, amount equality or tolerance; builder trusts returned bytes/instructions and supplied ALT contents; signer only deserializes and signs: `/home/xahmie/Documents/SWAT/packages/shared/src/jupiter.ts:201-215`; `/home/xahmie/Documents/SWAT/packages/shared/src/jupiter-swap.ts:181-258`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/solana-signer.ts:64-71`.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/07-trade-executor.md` (finding table; detailed qualifications follow there).

- **EXE-06 — High / Likely — External submission precedes durable recovery identity.** Jito and the folded Polymarket path can send before durable signed identity is stored and mishandle uncertain outcomes, creating missing exposure or possible duplicate rebuilds that were not reproduced.
  - Original evidence: Verified runtime unknown-state gap, Likely—crash/race test needed for duplicate effect. Jito reads pending state without claim, transmits before saving, and retryable failure returns unknown without saving anything: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/jupiter-jito-runtime.ts:221-235,311-342`. Outer catch terminates canonical rows: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:2647-2655`.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/07-trade-executor.md` (finding table; detailed qualifications follow there).
  - Included observations: EXE-09.
  - Folded Polymarket evidence: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/polymarket.ts:684-707,878-884,986-989`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:2321-2327,2647-2655`; original EXE-09 in the same source report.

- **EXE-07 — High / Verified — Jito resolution does not complete financial accounting.** The sweeper resolves its Redis record but its caller only logs, while missing chain identity prevents reliable receipt quantities, canonical fills and exposure updates.
  - Original evidence: Verified Jito sweeper caller and sinks. Sweep resolves its Redis state but caller only logs; submitted rows initially lack chain signature and canonical submission identity: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1798-1828,2732-2758`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/jupiter-jito-runtime.ts:446-455`. Generic fallback cannot reconstruct quantities without identity: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/reconciliation-venues.ts:30-50,96-118`.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/07-trade-executor.md` (finding table; detailed qualifications follow there).

- **EXE-08 — Medium / Verified — Live readiness can omit simulation.** Signer RPC fallback and simulation RPC requirements differ, so a configured route can report ready while the simulation gate is absent.
  - Original evidence: Verified simulation factory/readiness gap. Signer can use shared RPC fallback, whereas simulator requires explicit RPC or Helius key; null gate becomes undefined while runtime still reports ready: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/solana-signer.ts:112-120`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/solana-simulation.ts:451-492`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/jupiter-jito-config.ts:109-135`.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/07-trade-executor.md` (finding table; detailed qualifications follow there).

### 8. LP, perps, alerts, discovery and local ML — 10

- **SEC-01 — Medium / Likely — LP accepts arbitrary credentialed browser origins.** LP permits every origin with credentials, creating conditional same-site response exposure if cookies reach an attacker-controlled origin; unrelated-site access is still constrained by SameSite and CSRF.
  - Original evidence: Verified credentialed CORS accepts every origin, contradicting allowlist comments: `/home/xahmie/Documents/SWAT/apps/lp/src/index.ts:272-295`. Session issuer uses host-only `SameSite=Lax`: `/home/xahmie/Documents/SWAT/apps/api/src/auth/routes.ts:106-124`. Needs check browser/deployment cookie delivery.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/08-secondary-services.md` (finding table; detailed qualifications follow there).

- **SEC-02 — Medium / Verified — Missing development key disables session authentication.** A nonproduction LP instance without the service key omits the whole session hook and makes principal-gated routes unusable despite its warning; this is not demonstrated public write access.
  - Original evidence: Verified missing nonproduction key omits session hook despite warning: `/home/xahmie/Documents/SWAT/apps/lp/src/index.ts:60-62,298-300`; routes require principal/user (`/home/xahmie/Documents/SWAT/apps/lp/src/routes.ts:218-220,406-408`).
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/08-secondary-services.md` (finding table; detailed qualifications follow there).

- **SEC-03 — Medium / Verified — Subscriber can overwrite shared wallet configuration.** A user subscription invokes the otherwise service-only global writer and changes an existing wallet’s label or scan cadence before subscription success.
  - Original evidence: Verified user subscription calls service-only global registry writer before subscription; writer overwrites label and cadence on conflict: `/home/xahmie/Documents/SWAT/apps/lp/src/routes.ts:403-408,490-505`; `/home/xahmie/Documents/SWAT/packages/db/src/lp-tracked-wallets.ts:64-80`.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/08-secondary-services.md` (finding table; detailed qualifications follow there).

- **SEC-04 — Medium / Verified — LP concentration checks mix incompatible asset units.** Raw amounts across assets and chains are treated as USD and checked before a separate insert, making concentration limits unreliable; actual live submission currently refuses and race overshoot remains untested.
  - Original evidence: Verified raw asset amounts are summed as USD across assets/chains, then compared with raw requested amount: `/home/xahmie/Documents/SWAT/packages/db/src/lp-positions.ts:192-205,401-426`; `/home/xahmie/Documents/SWAT/apps/lp/src/guardrails/deploy-guard.ts:38-48`. Likely—race test needed read/check/insert overshoot (`/home/xahmie/Documents/SWAT/apps/lp/src/builder/build-position.ts:151-201`). Current live submission refuses.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/08-secondary-services.md` (finding table; detailed qualifications follow there).

- **SEC-05 — Medium / Verified — LP plans and no-op jobs leave misleading position states.** Manual rebalance can remain stuck after a successful no-op worker and live builds have no broadcast handoff, while related archive/copy states must not be mistaken for actual venue execution.
  - Original evidence: Verified manual rebalance sets `rebalancing`, worker returns success without transition; monitor excludes that state: `/home/xahmie/Documents/SWAT/apps/lp/src/routes.ts:332-350`; `/home/xahmie/Documents/SWAT/apps/lp/src/index.ts:370-389`; `/home/xahmie/Documents/SWAT/packages/db/src/lp-positions.ts:286-290`. Live plans remain building without a broadcast caller (`/home/xahmie/Documents/SWAT/apps/lp/src/builder/build-position.ts:228-243`).
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/08-secondary-services.md` (finding table; detailed qualifications follow there).

- **SEC-06 — Medium / Likely — Dormant perps execution has risk and recovery gaps.** Invalid margin/order arithmetic can pass, zero withdrawable funds fall back, and submission precedes durable identity with incomplete order fields; no production caller or funded external effect was verified.
  - Original evidence: Verified latent perps arithmetic and submit-before-record: `/home/xahmie/Documents/SWAT/apps/trade-executor/src/polymarket-perps.ts:97-99,172-217`. Zero withdrawable falls back, NaN margin/order comparisons can pass, client ID/leverage/builder not sent. Needs check production caller/session ownership; duplicate external effect Likely—test needed.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/08-secondary-services.md` (finding table; detailed qualifications follow there).

- **SEC-07 — Medium / Verified — Perps close only changes local records and reports failure.** The user close path archives SQL state rather than closing venue exposure and returns false after a successful update because affected rows are not returned.
  - Original evidence: Verified tenant perps close updates SQL only; `query` returns rows and UPDATE has no RETURNING, so method reports false after a successful update: `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:1330-1338`; `/home/xahmie/Documents/SWAT/packages/db/src/polymarket-perps.ts:276-283`; `/home/xahmie/Documents/SWAT/packages/db/src/client.ts:65-67`.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/08-secondary-services.md` (finding table; detailed qualifications follow there).

- **SEC-08 — High / Likely — Alert delivery can regress execution state.** Delayed alert delivery can overwrite a later signal lifecycle state while its expiring unowned lock and unbounded send create possible duplicate or lost delivery races.
  - Original evidence: Verified alert delivery writes signal `status='alerted'` regardless of prior lifecycle after external send; TTL60 lock lacks ownership and send lacks timeout: `/home/xahmie/Documents/SWAT/apps/alert-service/src/index.ts:41-60,379-410`. Likely—race test needed regression/duplicate/lost alert consequences.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/08-secondary-services.md` (finding table; detailed qualifications follow there).

- **SEC-09 — Medium / Verified — Discovery can persist a wallet without scheduling its history.** A wallet is saved before backfill enqueue, so queue failure can leave it excluded from future discovery retries without a reviewed recovery path.
  - Original evidence: Verified discovery upsert persists before failed enqueue, while subsequent queries exclude known wallets: `/home/xahmie/Documents/SWAT/apps/discovery/src/runner.ts:44-55`; `/home/xahmie/Documents/SWAT/packages/db/src/wallets.ts:44-64`; `/home/xahmie/Documents/SWAT/packages/db/src/discovery-queries.ts:29-64`. Other recovery paths NOT VERIFIED.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/08-secondary-services.md` (finding table; detailed qualifications follow there).

- **SEC-10 — Medium / Verified — Local ML inputs are not confined or safe to deserialize.** Untrusted roster paths or model files could cause writes outside the intended directory or execute code during pickle loading, conditional on an operator accepting those local inputs; no remote ingress was established.
  - Original evidence: Verified Python confinement not enforced: configured absolute/parent paths accepted; roster Solana address not syntax-validated, then used as filesystem component; score deserializes pickle (`/home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/config.py:116-142,159-180`; `/home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/storage.py:89-105`; `/home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/cli.py:623-624`). Needs check untrusted artifact/roster distribution.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/08-secondary-services.md` (finding table; detailed qualifications follow there).

### 9. Agent/MCP boundary — 3

- **MCP-01 — High / Verified — Independent agent listener lacks administrative authorization.** The MCP listener exposes shared blacklist mutations and scorer commands without application authentication or per-tool authorization, conditional on listener reachability and working database/Redis privileges.
  - Original evidence: Unauthenticated routes and dispatch: `/home/xahmie/Documents/SWAT/apps/mcp-server/src/index.ts:123-127,369-399`; mutations: `/home/xahmie/Documents/SWAT/apps/mcp-server/src/index.ts:264-350`; transaction commit: `/home/xahmie/Documents/SWAT/packages/db/src/transaction.ts:36-69`; consumers: `/home/xahmie/Documents/SWAT/apps/signal-engine/src/index.ts:329-363`, `/home/xahmie/Documents/SWAT/apps/scorer/src/index.ts:317-337`. Protocol exchange, listener access and operational DB/Redis privileges NOT VERIFIED.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/09-agent-mcp.md` (finding table; detailed qualifications follow there).

- **MCP-02 — Medium / Verified — Agent tools expose unscoped operational reads.** MCP queries shared signals and performance without a tenant context or publication gate, conditional on reachable sessions, readable records and actual data sensitivity.
  - Original evidence: Global SQL-to-output: `/home/xahmie/Documents/SWAT/apps/mcp-server/src/index.ts:128-140,189-240`; unscoped wrapper: `/home/xahmie/Documents/SWAT/packages/db/src/client.ts:26-28,65-68`; reviewed RLS target list: `/home/xahmie/Documents/SWAT/packages/db/sql/064_row_level_security.sql:66-117`. Actual data and exchange NOT VERIFIED.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/09-agent-mcp.md` (finding table; detailed qualifications follow there).

- **MCP-03 — Medium / Likely — Agent sessions share unbounded server state.** One server and transport registry lack principal-bound ownership and connection/idle bounds, with cross-session interference dependent on unverified SDK behavior.
  - Original evidence: Shared server/registry is verified source: `/home/xahmie/Documents/SWAT/apps/mcp-server/src/index.ts:19-30,365-399`. Cross-session disruption depends on excluded SDK behavior; Needs check, protocol isolation NOT VERIFIED.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/09-agent-mcp.md` (finding table; detailed qualifications follow there).

### 10. Web and standalone test UI — 5

- **WEB-01 — High / Verified — Test UI funding account has public-input signing authority.** The standalone UI funds an interactive keypair derived from public inputs rather than the claimed program-controlled vault, exposing any such funded account; actual funding and active network were not verified.
  - Original evidence: Public-input keypair and address response: `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:38-41,99-130`; UI funding caller: `/home/xahmie/Documents/SWAT/pda-test-ui/public/index.html:663-678,709-738`. Funding, active network and transfer NOT VERIFIED.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/10-web-app.md` (finding table; detailed qualifications follow there).

- **WEB-02 — High / Verified — Test UI signature does not bind withdrawal parameters.** The server verifies an arbitrary message separately from amount and timestamp and has no replay state, allowing intent reuse or alteration in principle; payout remains to the owner and no transfer was demonstrated.
  - Original evidence: Separate unsigned parameters, arbitrary-message verification and signing: `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:202-285`; honest client message: `/home/xahmie/Documents/SWAT/pda-test-ui/public/index.html:826-863`. Actual transfer NOT VERIFIED; recipient remains owner.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/10-web-app.md` (finding table; detailed qualifications follow there).

- **WEB-03 — Medium / Likely — Test UI inserts provider text into HTML.** Raw error and result text reaches HTML interpretation, creating possible script injection if attacker-controlled text reaches a victim; that influence and execution were not demonstrated.
  - Original evidence: Raw sinks: `/home/xahmie/Documents/SWAT/pda-test-ui/public/index.html:463-470,503-507,586-589,789-805,865-887`; raw server errors: `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:132-135,189-197,299-302`. Needs check: attacker influence over victim-visible text and script execution NOT VERIFIED.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/10-web-app.md` (finding table; detailed qualifications follow there).

- **WEB-05 — Low / Likely — Post-login destination validation may be ambiguous.** The login page validates next with string checks rather than a normalized same-origin URL, leaving unexpected navigation conditional on framework behavior.
  - Original evidence: Raw destination validation/router call: `/home/xahmie/Documents/SWAT/apps/web/app/login/page.tsx:25,40-57`. Needs framework check: off-origin navigation NOT VERIFIED.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/10-web-app.md` (finding table; detailed qualifications follow there).

- **WEB-06 — Low / Needs check — Browser response protections are not established.** Application configuration lacks an established content/framing/header protection set, while actual proxy/runtime headers remain unverified; no framing or injection exploit was shown.
  - Original evidence: Application config omission: `/home/xahmie/Documents/SWAT/apps/web/next.config.ts:19-49`, `/home/xahmie/Documents/SWAT/apps/web/middleware.ts:56-86`, `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:311-369`. Runtime/proxy headers NOT VERIFIED.
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/10-web-app.md` (finding table; detailed qualifications follow there).

### 11. Infrastructure, supply chain and history — 6

- **INF-01 — High / Likely — Secret-bearing deployment installs unpinned tooling.** CI installs the latest deploy CLI with production deployment secrets available, leaving supply-chain compromise impact conditional on a malicious fetched dependency rather than an observed compromise.
  - Original evidence: `/home/xahmie/Documents/SWAT/.woodpecker.yaml:68-90`; `/home/xahmie/Documents/SWAT/.woodpecker/ci.yaml:68-90`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/11-infrastructure-supply-chain.md` (finding table; detailed qualifications follow there).

- **INF-02 — High / Verified — Root service examples amplify application compromise.** The runbook runs applications as root while hardened service files point into protected root-home paths, creating excessive privilege and conflicting startup guidance; installed units were not verified.
  - Original evidence: `/home/xahmie/Documents/SWAT/DEPLOYMENT.md:304-385`; `/home/xahmie/Documents/SWAT/deploy/systemd/swat-api.service:8-19`; `/home/xahmie/Documents/SWAT/deploy/systemd/swat-trade-executor.service:8-23`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/11-infrastructure-supply-chain.md` (finding table; detailed qualifications follow there).

- **INF-03 — Medium / Likely — Application defaults reuse the database bootstrap identity.** Templates reuse a potentially privileged bootstrap identity without application startup rejection; runtime follow-up confirms the local role is superuser/BYPASSRLS, not the remote production role.
  - Original evidence: `/home/xahmie/Documents/SWAT/docker-compose.yml:13-18,45-50`; `/home/xahmie/Documents/SWAT/packages/db/src/client.ts:10-27`; `/home/xahmie/Documents/SWAT/packages/db/sql/064_row_level_security.sql:47-64`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/11-infrastructure-supply-chain.md` (finding table; detailed qualifications follow there).

- **INF-04 — High / Verified — Remote backend transport can expose session data.** Web rewrites default to cross-host HTTP with weak URL validation and the folded middleware path forwards full cookies, creating conditional credential exposure without proven interception or deployment activation.
  - Original evidence: `/home/xahmie/Documents/SWAT/apps/web/next.config.ts:4-17,24-35`; `/home/xahmie/Documents/SWAT/.woodpecker.yaml:84-90`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/11-infrastructure-supply-chain.md` (finding table; detailed qualifications follow there).
  - Included observations: WEB-04.
  - Folded web evidence: `/home/xahmie/Documents/SWAT/apps/web/middleware.ts:21-25,37-46`; `/home/xahmie/Documents/SWAT/apps/web/lib/api-server.ts:39-47`; `/home/xahmie/Documents/SWAT/threats/security-review/10-web-app.md`, WEB-04.

- **INF-05 — Medium / Needs check — Historical credential-shaped assignment is unresolved.** Reachable Git history retains one opaque credential-like assignment of unknown provenance or validity; known public test keys are not classified as live leaks and no secret value is reproduced.
  - Original evidence: Historical commit `d4d543139755a82560513fef4aa173b2c5b1d327`, `swat.md:1351`; `/home/xahmie/Documents/SWAT/.gitignore:3-7,25-26,39-40`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/11-infrastructure-supply-chain.md` (finding table; detailed qualifications follow there).

- **INF-06 — Medium / Verified — Secondary installation paths are not reproducibly pinned.** Python lower-bound dependencies and unpinned privileged bootstrap/tool installs execute newly acquired code without the same reproducibility as the frozen pnpm workspace; no malicious package was established.
  - Original evidence: `/home/xahmie/Documents/SWAT/pattern-ml/scripts/setup-server.sh:41-48`; `/home/xahmie/Documents/SWAT/pattern-ml/pyproject.toml:7-40,45-47`; `/home/xahmie/Documents/SWAT/DEPLOYMENT.md:142-145,393-395`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/11-infrastructure-supply-chain.md` (finding table; detailed qualifications follow there).

### 12. Test safety and assurance — 3

- **TEST-01 — Medium / Verified — Chaos tests can disrupt shared infrastructure.** Original test configuration can select shared infrastructure and terminate database or normal Redis clients despite paper mode; the existing follow-up avoided this by using new isolated services.
  - Original evidence: `/home/xahmie/Documents/SWAT/vitest.integration.config.ts:1-17`; `/home/xahmie/Documents/SWAT/tests/integration/chaos.integration.test.ts:53-61,343-345,418`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/12-test-assurance.md` (finding table; detailed qualifications follow there).

- **TEST-02 — Medium / Verified — Fixed fixture identities allow cross-run cleanup damage.** Independent test runs reuse Solana addresses and address-scoped cleanup can delete a neighboring run’s positions or evidence; serial execution inside one process does not establish cross-process safety.
  - Original evidence: `/home/xahmie/Documents/SWAT/tests/integration/helpers/lifecycle-fixture.ts:4-6,20-28,95-115,152-155,195-224`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/12-test-assurance.md` (finding table; detailed qualifications follow there).

- **TEST-03 — Low / Verified — Sparse schema guard can provide misleading assurance.** Checking a small table/column list does not establish current constraints, policies or complete migration identity, even when clean unified migration replay succeeds.
  - Original evidence: `/home/xahmie/Documents/SWAT/tests/integration/helpers/schema-guard.ts:25-70,73-76,80-109`
  - Source report: `/home/xahmie/Documents/SWAT/threats/security-review/12-test-assurance.md` (finding table; detailed qualifications follow there).

## Runtime observations — overlaps and additional gaps, not extra static counts

The following labels are copied from `/home/xahmie/Documents/SWAT/threats/04-runtime-verification.md:55-70`; their six rows are separate follow-up evidence, not six automatically unique additions to the 76.

- **RUN-01 — High / Verified — Local superuser bypasses tenant row isolation.** Existing local `swat` is superuser and BYPASSRLS, six assertions failed in the isolated equivalent, and the dedicated non-superuser scoped subset passed 10/10; this strengthens **INF-03**, overlaps **DB-02/DB-05**, and does not establish the remote role or all production caller isolation (`/home/xahmie/Documents/SWAT/threats/runtime/existing-postgres-read-only.log:1-9`; `/home/xahmie/Documents/SWAT/threats/runtime/unit-db.json`; `/home/xahmie/Documents/SWAT/threats/runtime/rls-runtime-role.json`; `/home/xahmie/Documents/SWAT/packages/db/sql/064_row_level_security.sql:28-63`).
- **RUN-02 — High / Verified — Existing local schema is missing five required tables.** Missing `copy_position_master_lots`, `user_payment_intents`, `crypto_payments`, `lp_copy_subscriptions` and `lp_copy_executions` confirms local operational schema drift, overlapping **DB-06/TEST-03** in readiness/migration assurance rather than proving their specific race or guard behavior (`/home/xahmie/Documents/SWAT/threats/runtime/existing-schema-check.json:17-23`; `/home/xahmie/Documents/SWAT/packages/db/src/migrate.ts:11-30`; `/home/xahmie/Documents/SWAT/tests/integration/helpers/schema-guard.ts:25-69`).
- **RUN-03 — Medium / Verified — Unsupported transaction versions can disappear as empty evidence.** Current version-0 requests rejected a sampled version-1 transaction, overlapping **IDX-01/IDX-04/IDX-08** only in source-completeness concerns; the actual version-1 sample failed on-chain and no successful version-1 trade or resulting missed profitable copy was established (`/home/xahmie/Documents/SWAT/apps/indexer/src/index.ts:441-446,533-541`; `/home/xahmie/Documents/SWAT/threats/runtime/solana-transaction.json`; `/home/xahmie/Documents/SWAT/threats/runtime/solana-transaction-v1-0.json`).
- **RUN-04 — Medium / Verified — Local frontend dependencies prevent a successful build.** Unresolved declared `@solana/web3.js` and `tailwindcss` made original typechecking and copied production build fail, with font-fetch failures as additional environment problems; this relates to **INF-06** build reproducibility but is a separate operational build gap, not a confirmed security exploit (`/home/xahmie/Documents/SWAT/apps/web/package.json:10-25`; `/home/xahmie/Documents/SWAT/apps/web/lib/wallets.ts:2`; `/home/xahmie/Documents/SWAT/apps/web/tailwind.config.ts:1`; `/home/xahmie/Documents/SWAT/threats/runtime/web-original-typecheck.log`; `/home/xahmie/Documents/SWAT/threats/runtime/web-build-isolated.log`).
- **RUN-05 — Medium / Verified — RPC health reports configuration rather than connectivity.** Intentionally unreachable configured localhost RPCs were labelled healthy while aggregate success depended on database/Redis, relating to **EXE-08** readiness semantics but not proving its simulation path ran (`/home/xahmie/Documents/SWAT/apps/api/src/index.ts:256-305`; `/home/xahmie/Documents/SWAT/threats/runtime/service-smoke.json`).
- **RUN-06 — High / Likely — Installed dependency versions match registry advisories.** The prior audit returned 114 registry entries—6 Critical, 45 High, 54 Moderate, 9 Low—relating to **INF-01/INF-06** supply-chain assurance but not proving those acquisition-compromise scenarios or deployed feature reachability (`/home/xahmie/Documents/SWAT/threats/runtime/dependency-audit-summary.json`; `/home/xahmie/Documents/SWAT/threats/runtime/dependency-audit.log`; `/home/xahmie/Documents/SWAT/apps/web/package.json:10-15`; `/home/xahmie/Documents/SWAT/apps/mcp-server/package.json:14-20`).

### Precisely what passed, and what did not

The prior follow-up completed and replayed 69 clean isolated migrations, passed 124/124 integration tests, and executed 3,042 unit tests with 3,036 passes and six superuser RLS failures; the later non-superuser 10/10 subset does not erase those failures or prove arbitrary SQL/role switching cannot bypass policies. Review aliases bypassed the original integration global setup/schema guard, so integration success is not original-harness readiness proof (`/home/xahmie/Documents/SWAT/threats/04-runtime-verification.md:6-38`).

Five public Polymarket fills were replayed into five local paper trades, and sequential API/LP service probes rejected service keys on user-only routes; these are staged local effects and denial checks, not autonomous two-user follower execution, real venue orders or authenticated end-user success-path certification (`/home/xahmie/Documents/SWAT/threats/04-runtime-verification.md:9-12,40,107-111`). A successful version-0 Solana transaction parsed, and the checked failed sample did not; neither establishes general parser safety or successful version-1 support.

Fresh review-only declarations resolved initial DB/API/indexer/LP compilation failures, and direct executor source typechecking passed; artificial heap limits, temporary declaration layout errors and queue-waiter harness errors are not additional product vulnerabilities, and a green original executor emitted build or monorepo production build was not established (`/home/xahmie/Documents/SWAT/threats/04-runtime-verification.md:38,99-105`).

### Dependency caveats

Registry Critical does **not** mean proven product Critical. Next.js 15.5.18 matched three Critical advisory records, but one is Windows-host-specific, two concern image optimization with exposure unverified, proxy-addr trust configuration is unverified, and tinypool is test tooling; MCP client redirect advisories do not automatically apply to this server listener (`/home/xahmie/Documents/SWAT/threats/04-runtime-verification.md:66-70`). No actual malicious dependency or locally reproduced advisory exploit was established.

## Additional small observations and assurance gaps outside the retained tables

These were mentioned in module prose or excluded coverage, lack independent retained IDs/severity/confidence, and are explicitly **not added to the 76** or represented as newly verified exploit findings.

- **API origin/cookie/export hardening:** unset-origin CORS reflection, conditionally Secure cookies influenced by protocol/forwarded headers, and CSV escaping that does not neutralize spreadsheet formulas are additional conditional concerns (`/home/xahmie/Documents/SWAT/apps/api/src/index.ts:90-104`; `/home/xahmie/Documents/SWAT/apps/api/src/auth/routes.ts:103-108`; `/home/xahmie/Documents/SWAT/apps/api/src/routes/admin-portfolio.ts:25-42`; `/home/xahmie/Documents/SWAT/threats/security-review/01-api.md:79-86`).
- **Misleading administrative reporting:** nominal-price/first-100-user revenue estimates, cashflow-based PnL and placeholders are not reconciled treasury evidence or money-moving exploits (`/home/xahmie/Documents/SWAT/apps/web/app/admin/revenue/page.tsx:31,49-57,116`; `/home/xahmie/Documents/SWAT/packages/db/src/admin-portfolio.ts:133-170,449-464,506-543`).
- **Error and display leakage:** MCP returns raw exception messages, alert signal strings need escaping/validated links, and the standalone UI publishes its configured RPC URL, which is sensitive only if the uninspected URL contains credentials (`/home/xahmie/Documents/SWAT/apps/mcp-server/src/index.ts:356-361`; `/home/xahmie/Documents/SWAT/apps/alert-service/src/index.ts:253-265,293-294,355-369`; `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:78-85`).
- **Incomplete source/price/precision assurance:** routability failures return pass, universal final-sign source freshness is unverified, approximate AMM depth is not exact usable liquidity, and Number-based reporting has not established full financial precision; safe-integer sell checks do reject oversized quantities rather than silently rounding them (`/home/xahmie/Documents/SWAT/apps/signal-engine/src/routability-probe.ts:127-159`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/index.ts:1715-1759,1782-1795,1987-1988`; `/home/xahmie/Documents/SWAT/packages/db/src/master-capacity.ts:174-198`; `/home/xahmie/Documents/SWAT/apps/trade-executor/src/solana-dispatch.ts:101-106`; `/home/xahmie/Documents/SWAT/threats/security-review/07-trade-executor.md:60-65`).
- **Dormant/placeholder secondary protection:** LP monitor receives null prices/zero economics, copy-worker activation was not found, perps is not verified active, and alert pUSD inputs are null without a reviewed decision path; these gaps do not establish active live losses (`/home/xahmie/Documents/SWAT/apps/lp/src/index.ts:211-222,252-259`; `/home/xahmie/Documents/SWAT/apps/lp/src/copy/copy-worker.ts:62-73`; `/home/xahmie/Documents/SWAT/apps/alert-service/src/index.ts:130-137`; `/home/xahmie/Documents/SWAT/threats/security-review/08-secondary-services.md:26-34,59-65,87`).
- **Local ML pacing/configuration:** nonpositive rate settings can disable pacing, numeric Retry-After lacks a reviewed upper bound, and configuration can fall back to repository dotenv; accepting unsafe local configuration is not a demonstrated remote exploit (`/home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/sources/base.py:36-43,110-115`; `/home/xahmie/Documents/SWAT/pattern-ml/src/pattern_ml/config.py:29-36,122-142`).

## Remaining exposure unknowns

- Real funded custody, actual signer distribution, program upgrade/governance authority, successful user-vault routing and live duplicate-effect behavior are unverified; user PM/RHC adapters deny, other unimplemented live chains reject, and current LP live submission refuses (`/home/xahmie/Documents/SWAT/threats/security-review/07-trade-executor.md:8-14`; `/home/xahmie/Documents/SWAT/threats/security-review/08-secondary-services.md:26-30`).
- Rust/Cargo/Anchor/Solana tools were unavailable in the prior follow-up, so actual contract handlers/CPI/validator tests never ran; Python services, browser-rendered acceptance and actual transaction-pooler lock semantics were also unexecuted (`/home/xahmie/Documents/SWAT/threats/04-runtime-verification.md:107-111`).
- Full autonomous two-user real-source fan-out, owned-lot reducing exits, unknown-acceptance recovery and independent final-byte policy remain uncertified, as do latency percentiles or sandwich-resistance claims (`/home/xahmie/Documents/SWAT/threats/04-runtime-verification.md:97,107-111`).
- Prior remote health DNS failed, Polygon verification was blocked, and the declared WAKE program address was absent at one sampled finalized mainnet slot; this does not prove no alternative deployment exists, and no custody balances were scanned (`/home/xahmie/Documents/SWAT/threats/04-runtime-verification.md:85-97`).
- Remote roles, TLS/firewalls/forwarding, live credentials, advisory reachability and binary/unreachable/unfetched history remain unknown; no clean-history or no-secret-leak guarantee follows from the bounded evidence (`/home/xahmie/Documents/SWAT/threats/02-synthesis-and-remediation.md:210-218`).
- The earlier inventory recorded 191 in-depth relevant-path files, 73 skim/search files and 445 unread files out of 709 source/config/test files, so neither the twelve reports nor this consolidation is a full repository/deployment audit (`/home/xahmie/Documents/SWAT/threats/02-synthesis-and-remediation.md:210-216`).

**Bottom line:** there are 76 retained static weaknesses, several important runtime confirmations and additional assurance gaps; the evidence supports concern about unauthorized execution, account isolation, fund-loss prevention and misleading protection claims, but not a declaration that an attacker already breached SWAT. This report assesses only; it applies no remediation.
