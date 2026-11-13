# 07 — Post-remediation OWASP, sensitive-data and deep logic audit

**Date:** 2026-11-08. **Reviewed HEAD:** `8905505595802c21053118b5fab3fd53a8a1654c`.

## Outcome

**The fixes are not complete, and several changes introduce new defects. Do not use the “97/97 Complete & Verified” remediation report as release acceptance.** The current source still has high-impact authorization, payment, signing, follower-isolation and exit-accounting failures. Isolated tests reproduce multiple missing safeguards. No production breach, actual secret theft, real trade or lost funds was demonstrated.

The audit compares:

- Original audited baseline: `d5852a0e31e8e9a517c6e7c47ed9623819c7fc71`.
- Remediation commit: `ec3c5fefe4424be4d9a015a7402e2cfc7d8c6ab7`.
- Subsequent WalletConnect/Robinhood delegation feature: current HEAD `8905505`. This feature adds substantial authorization code after the remediation commit, with no added tests in that feature diff.

Excluding assessment/build/lockfile noise, the comparison contains 46 source/config/test files with approximately +1,388/−819 lines. The post-remediation feature accounts for eight files and approximately +730/−88 lines. Changed-file metadata was used only for scope—not as evidence that an unchanged vulnerability remains exploitable or that a changed file is repaired.

### Closure assessment

| Original core register: 76 retained findings | Count |
|---|---:|
| Closed in reviewed source | 5 |
| Source surface removed | 3 |
| Partially fixed; residual issue remains | 25 |
| Open | 39 |
| Not verified | 4 |

Across **all 97 tracked IDs**—the original 76 plus 15 overlapping OWASP and six runtime rows—the disposition is **10 closed(source), 4 surface-removed, 33 partial, 43 open, 7 not-verified**. Those 97 are **not** 97 independent vulnerabilities. Source closure is narrower than deployed closure. Original severity/confidence is preserved separately; it is not silently replaced by a completion checkbox.

Full per-ID reasoning: [closure ledger](post-fix-8905505/closure-ledger.md), [machine-readable ledger](post-fix-8905505/closure-ledger.json).

## Most important remaining and new problems

All code evidence below is from the current checkout. **Verified** means the relevant source behavior was traced; isolated reproduction is stated separately. None means a live attack occurred.

### 1. New Robinhood enrollment accepts unverified wallet ownership — High / Verified, isolated reproduction

`apps/api/src/routes/me.ts:616-631` inserts or refreshes an authentication-wallet row before checking the signature. At `:633-672`, signature recovery is diagnostic: rejection or a different signer never denies enrollment. The route continues to sealed grant persistence and a success response at `:720-744`.

A synthetic invalid-proof request caused a wallet-link query and returned HTTP 200. The database, sealing and signature provider were mocked; no real wallet was touched. Auth-wallet ownership is subsequently trusted by billing and withdrawal-destination checks, so this is more serious than a cosmetic grant status. Existing other-owner wallet rows are not simply overwritten; the defect includes unproven new claims and ignored zero-row conflicts, not an established arbitrary existing-user login bypass.

**Fix sequence:** verify the exact user/address/domain/chain-bound challenge before any write; reject mismatched/rejected recovery; atomically consume nonce and link/persist authority; roll back all state on failure. Preserve the legitimate wallet-login proof checks.

**Acceptance:** wrong signer, malformed proof, expired/replayed challenge and failed sealing must return rejection with **zero persistent mutations**. See PF-WEB-01.

### 2. Treasury credit still lacks proof of payment ownership; Polygon also accepts the wrong event shape — High / Verified, isolated reproduction

The new owned-memo check at `apps/api/src/routes/billing.ts:388-429` is not tied to the submitted on-chain transfer. Supplying that memo bypasses the linked-payer check at `:438-457`. An owned memo with an unrelated payer reached the credit writer in the isolated route test.

Separately, `apps/api/src/routes/billing.ts:84-115` reads a USDC log's topics/data without validating the Transfer event signature. A fake receipt with a non-Transfer signature topic was accepted. A standard Approval log shares the indexed owner/spender/value layout; no real Approval or payment was submitted.

**Fix sequence:** strictly decode the expected Transfer event; bind chain/token/treasury/payer or a chain-visible user deposit reference; lock and consume the exact pending intent in the credit transaction; reject zero-row/expired/used intent transitions. Normalize the same memo/hash at validation and persistence.

**Acceptance:** no payment from an unproven payer/reference, no Approval/non-Transfer credit, no concurrent intent reuse, no credit if intent consumption fails. See PF-WEB-02/03/20.

### 3. Final signing and on-chain economics are still insufficiently constrained — High / Verified source

`apps/trade-executor/src/solana-signer.ts:64-79` checks transaction structure, not the economic meaning of final instructions/accounts. Upstream quote checks and successful simulation do not prove recipients, maximum debit, approvals, fees or minimum return match the user's intent.

Separately, `programs/wake-vault/src/lib.rs:235-329,450-515` lets the authorized global executor choose `max_in`, `min_out`, mints and CPI bytes without owner-defined per-vault asset/expiry/cumulative-spend policy. These are distinct boundaries: an untrusted builder can affect an honest operator signer, while a compromised authorized executor can call the contract directly. No specific malicious route or funded vault was tested.

**Fix sequence:** bind final resolved transaction bytes to an immutable scoped intent at the signer; enforce owner-authorized asset/expiry/budget policy in the contract; consume allowances atomically and independently of caller-selected limits.

**Acceptance:** a structurally valid extra transfer/wrong recipient/approval or owner-policy-violating swap must be rejected despite successful simulation. See PF-EXE-02 and PF-SEC-01.

### 4. Jito settlement uses the wrong identity and submission is not write-ahead — High / Verified source; durability failures reproduced

`packages/db/src/copy-trade-lifecycle.ts:1159-1191` creates `swat-<digest>` client order IDs. New reconciliation passes that string as `signalId` at `apps/trade-executor/src/index.ts:2788-2803`, while `:727-744` casts it to UUID. The runtime marks Redis resolution first at `apps/trade-executor/src/jupiter-jito-runtime.ts:448-455`. The downstream SQL cannot accept that identity; status-only settlement also omits receipt-derived quantities/fees/canonical evidence.

At `apps/trade-executor/src/jupiter-jito-runtime.ts:221-344`, pending state is saved after fake transport invocation, including on lost response. A stateful-memory test reproduced two sends for two overlapping calls and storage of `pending_unknown` rather than a recoverable transaction identity. No actual transaction was signed or transmitted.

**Fix sequence:** claim submission atomically; durably store exact signed identities before transport; resolve venue/client identity to the exact tenant execution; apply receipt-derived evidence/trades/lots transactionally; acknowledge resolution only after durable accounting or a persisted repair obligation.

**Acceptance:** lost response/store failure/concurrent callers/restart cannot create another external intent or discard the unknown one; settlement never casts an order ID as a signal UUID. See PF-EXE-01/03.

### 5. Completed first follower still blocks later followers — High / Verified source

`packages/db/src/copy-trade-lifecycle.ts:1834-1870` allows new claims only for eligible/alerted or resumable-executing shared signals. First completion updates the shared signal to executed (`:2718-2728`); a later tenant has no existing execution and is rejected. The operator-first queue and concurrency-one default make this a normal sequence, not just an unlikely race. Improved `userId` propagation does not close it.

**Fix sequence:** separate source validity from per-tenant delivery/execution state; claim by source/user/mode and preserve expected delivery obligations independently of another tenant's result. Scope cooldowns appropriately.

**Acceptance:** operator plus two paper users must each execute one fresh source sequentially, with separate trades/lots and no cross-tenant suppression. See PF-EXE-07.

### 6. Exits still cross lot, mode and lifecycle boundaries — High / Verified source; selected consequences Likely

- No selling-master lots still falls back to aggregate inventory; outstanding master reservations are not subtracted correctly (`packages/db/src/copy-trade-lifecycle.ts:1952-1984`).
- Close-all persistence drops `exit_lot_id` (`apps/trade-executor/src/index.ts:318-411,2638-2653`), violating `packages/db/sql/061_copy_position_lot_exits.sql:45-91`. Canonical evidence is written first in a separate operation (`index.ts:2612-2635`).
- An existing live exit can enter a current-paper execution slot without checking acquisition mode and complete as paper evidence; explicit execution ID lookup lacks expected owner/chain/token validation (PF-EXE-05).
- Reducing sells still meet final entry-score/safety gates despite the pure eligibility-helper fix (`apps/signal-engine/src/index.ts:435-477,509-591`; `apps/trade-executor/src/index.ts:1477-1489`).
- Stop-loss still loses canonical lot identity; the Robinhood path can default to a full-balance proportion rather than the breached lot (PF-EXE-09, financial result Likely).

**Fix sequence:** one immutable owned-lot exit contract across producer, queue, adapter and evidence; preserve acquisition mode/tenant/token/quantity; atomically reserve master availability; never fabricate paper closure for live exposure; commit or durably reconcile all financial views.

**Acceptance:** two masters sharing inventory, simultaneous stop-loss/close-all/source sell, and platform mode changes cannot sell another lot, exceed owned quantity, lose trade records or mark unsold live exposure closed. See PF-EXE-04/05/06/08/09.

### 7. Input provenance and session revocation remain faulty — High parser / Medium session, reproduced in isolation

The Solana parser still accepts opposite balance movements without swap provenance and ranks mixed asset legs by raw-unit magnitude (`apps/indexer/src/parse.ts:138-209,234-260`). Enhanced conversion attributes a nonpayer's fee incorrectly (`apps/indexer/src/webhook-helpers.ts:102-133`). Four parser assertions fail despite 19 existing parser tests passing.

`packages/db/src/users.ts:182-288` still uses process-local cached identities. Moving cache deletion after the DB write does not prevent an earlier lookup completing afterward and repopulating a revoked session; the isolated race reproduced this behavior.

**Acceptance:** only successful attributable swaps create events, ambiguous routes fail, raw/enhanced economics agree, and late/other-process cache entries never revive a revoked session. See PF-DATA-01/02/03/11.

### 8. User-visible financial state still overstates what occurred — High/Medium, source verified

The vault UI announces on-chain revocation and refunded rent after an HTTP-only database update (`apps/web/app/vault/page.tsx:536-575`; `apps/api/src/routes/me.ts:405-449`). The contract's owner-signed revoke merely toggles a reversible flag and does not refund rent.

New Robinhood enrollment fabricates an address by prefix substitution (`apps/api/src/routes/me.ts:613`) rather than proving deployed/authorized account ownership. It stores incomplete signed context and labels delegation successful without on-chain installation. Default user-live executor adapters currently deny, so enrollment success is not evidence working delegated execution.

LP manual rebalance can become permanently unmonitored; perps close updates SQL then returns 404 because affected rows are not returned (`packages/db/src/polymarket-perps.ts:276-283`; `apps/api/src/routes/me.ts:1634-1642`). Neither SQL-only closure nor queue acceptance proves a venue action occurred.

**Acceptance:** separate local disablement/planning/authorization/submission/confirmation states; never display fabricated funding addresses, refunded rent, settled exits or on-chain authority without corresponding evidence. See PF-WEB-04/05/06/09/10, PF-SEC-02/03/06/07.

## Frontend/API credential and sensitive-data result

**No embedded production secret was identified by the bounded current-source and existing-client-artifact literal scan. This is not a clean-bundle or deployed-response certificate.** The scanner examined 118 source files and 22 existing client artifacts (2.86 MB) without emitting suspected values. Existing artifacts were not rebuilt/proven current; actual secrets, dotenv, production logs and runtime-injected values were not inspected.

Confirmed/conditional remaining paths:

| Path | Current conclusion |
|---|---|
| Polymarket info-level signature tuple | Original explicit proof log removed; source-closed. No private key was ever established in that log. |
| SSR session forwarding | Still resolves remote HTTP defaults independently of fixed middleware. Both API/LP production resolver assertions fail. `apps/web/lib/api.ts:124-151`; `apps/web/lib/api-server.ts:34-47`. |
| RPC configuration/errors | Raw URL reaches exception/log serialization and operator diagnostics. A synthetic credential marker survives. Actual credential leakage requires credential-bearing config, which was not read. `packages/shared/src/rpc-failover.ts:228-247,309-332`; `packages/shared/src/logger.ts:19-51,68-85`. |
| Route-local errors | Raw exception messages still reach clients, including the new Robinhood route and LP catches. Full CLOB-secret disclosure not established. `apps/api/src/routes/me.ts:746-751,946-951`; `apps/lp/src/routes.ts:345-347,508-509`. |
| Log-stream ticket | Still in URL, mitigated by 60-second/single-use behavior; no actual capture shown. `apps/web/app/logs/page.tsx:139-166`. |
| Sensitive cache headers | Some mutations/export now use no-store, but no uniform inspected policy covers sensitive reads/auth responses. Actual cache leak unverified. |
| Own-user CLOB identifier | Still returned in full; minimization Low, not unauthorized complete credential theft. `apps/api/src/routes/me.ts:385-387,914-943`. |
| Browser API requests | Continue to use cookies/CSRF, not an injected operator key. Public WalletConnect project IDs are not private credentials. `apps/web/lib/api.ts:96-112`. |

## Verification results

- **176/176 existing selected tests passed** across 12 files, including five changed regression suites.
- **17 new synthetic security/control assertions ran: 16 failed, one passed.** Failures cover invalid proof, payment attribution/event type, source provenance/quantities, session revocation, transport/error redaction, probe validation and Jito durability. They demonstrate missing isolated controls, not 16 production compromises.
- **PDA server syntax failed:** duplicate `requestedLamports` at `pda-test-ui/server.mjs:302` prevents startup. Other PDA runtime findings are dormant in this exact source until that parser error is fixed.
- **Frontend typecheck failed** with ten unresolved-module diagnostics, including new AppKit/Wagmi/query imports. Dependencies are declared but unresolved in this installed checkout; no install attempted.
- **Backend source-aliased typecheck passed** on a 640 MB retry after a 512 MB heap exhaustion. This is no-emit selected backend source checking, not the original full production build.
- No application service, database/Redis instance, production endpoint, paid service, wallet or on-chain program was contacted. No source fixes, real key use, fund movement, installs, commits or pushes occurred.

Full methods, test limitations, errors and command evidence: [verification report](post-fix-8905505/verification.md).

## Standards — OWASP and repository requirements

Mapped to **OWASP Web Top 10:2025, API Security Top 10:2023 and ASVS 5.0.0**, using the official-source evidence already retained in `threats/evidence/owasp-standards-reference.json`. ASVS L2 remains a recommended baseline, with additional custody/financial authorization controls. No certification or invented compliance percentage is given.

| Web 2025 category | Current assessment |
|---|---|
| A01 Broken Access Control | Invalid wallet linking, incomplete payment ownership, queue execution-ID and global registry boundaries remain. |
| A02 Security Misconfiguration | SSR/plaintext exceptions, inconsistent cache/header policy and role/daemon configuration remain; deployment configuration not certified. |
| A03 Software Supply Chain Failures | CLI top-level pin improved; privileged installation boundary and unconstrained secondary tooling remain. Fresh advisory reachability not assessed. |
| A04 Cryptographic Failures | Public-only test signing seed fixed, but ephemeral-key recovery/resource-bound AAD/authority separation remain. Primitive AES-GCM tests pass. |
| A05 Injection | Dynamic test-UI HTML sinks remain conditionally unsafe. CSV leading-formula protection added. No newly proven SQL injection. |
| A06 Insecure Design | Financial intent, per-tenant execution, lot reservation and truthful lifecycle defects remain. |
| A07 Authentication Failures | New delegation proof gate and session-cache revocation are defective. Main session/CSRF gates still provide real protection. |
| A08 Software or Data Integrity Failures | Transaction-event provenance, final signing bytes and receipt/accounting continuity remain insufficient. |
| A09 Security Logging and Alerting Failures | Explicit proof logging fixed; raw RPC URL/error propagation, detached audit and ticket URL concerns remain. |
| A10 Mishandling of Exceptional Conditions | Submission uncertainty, stale session results, queue/write gaps, syntax failure and raw error responses remain. |

API 2023: API1/2/3/5/6 authorization/authentication/property/business-flow boundaries are covered by corresponding findings; API4 has pagination/limiter limits; API8 configuration and API10 provider-data consumption remain material. **No new attacker-controlled SSRF exploit was established (API7)**. Source inventory/removal was checked, but **production API inventory is not certified (API9)**. Lack of a new finding is not a pass.

Repository standards were checked separately: ADR-0001 tenancy, ADR-0003 contract-enforced scoped authority, ADR-0004 owner-controlled vault lifecycle, and ADR-0007 master-attributed inventory remain materially unmet in the identified paths. Style heuristics were not promoted into vulnerabilities.

## Spec — claimed remediation versus delivered behavior

`threats/REMEDIATION-EXECUTION-REPORT.md:6,16,37` claims full completion. It describes a different checkout and two-core runs; those are historical assertions, not local evidence. This audit uses the user's one-core constraint.

Real improvements deserve credit: removed tracked MCP surface, denied unresolved default user signers, repaired explicit user-ID propagation at reviewed writes, same-owner Polymarket conflict predicates, removed ordinary proof log, production CORS rejection, CSV escaping, post-commit local invalidation, conditional billing downgrade and alert-state update, and clearer configured-versus-healthy labeling.

They do not establish the claimed end-to-end fixes. Examples: parsing/contract files still implement the specific original defects; mandatory amount binding is optional on the actual UI request; Jito “write-ahead” saves after send; “settled” can lack receipt amounts; “RLS fixed” does not establish actual pool identity; and on-chain revoke/refund text remains false. The later feature introduces an independently broken proof/persistence path and has no new tests.

**Standards outcome:** material control failures, especially authorization and financial integrity. **Spec outcome:** only 10/97 tracked IDs source-closed and four source-removed; 76 remain open/partial and seven unverified. Counts describe tracked overlapping IDs, not independent vulnerability totals or a compliance score.

## Remediation acceptance order — unapplied

1. **Contain new false authorization and payment credit:** fix PF-WEB-01/02/03 before enrolling wallets or accepting new payment claims. Use the supplied failing synthetic assertions as acceptance, then exercise real database transactions in isolation.
2. **Keep live signing restricted until exact intent/authority is enforceable:** close PF-EXE-02 and PF-SEC-01/02, distinguish local UI state from contract state, and never fund synthetic account addresses.
3. **Repair durable financial execution:** correct Jito identity/order/recovery; one tenant's state cannot end others' deliveries; preserve owned lot/mode/exact quantity through exits and ledger writes.
4. **Fix source data and policy continuity:** provenance, raw-unit ambiguity, net flows, reduce-only gates, reservations, unknown prices and emergency-stop epoch/freshness.
5. **Close data propagation and operational defects:** session revocation, SSR HTTPS, pre-log credential redaction, fixed public errors, durable audit/notification/discovery, LP/perps truthful lifecycle, test isolation.
6. **Complete build and deployment acceptance without overclaiming:** syntax fix, clean dependency install/build in an approved isolated environment, exact schema/role/pooler tests, real instruction/CPI tests, then separately authorized end-to-end paper and funded/deployment gates.

No fixes were applied. These are prioritized closure criteria, not a claim they were completed during the audit.

## Detailed artifacts and coverage

- [API/browser and new delegation review](post-fix-8905505/api-web-review.md).
- [Execution, reservations and recovery review](post-fix-8905505/execution-review.md).
- [Contract, LP/perps, discovery and infrastructure review](post-fix-8905505/secondary-contract-review.md).
- [Database, source attribution and test assurance review](post-fix-8905505/data-indexer-review.md).
- [Complete historical-ID closure ledger](post-fix-8905505/closure-ledger.md).
- [Executed verification and limitations](post-fix-8905505/verification.md).
- [Final source/report consistency validation](post-fix-8905505/final-validation.json): all 778 hashed source files unchanged; current HEAD preserved; only tracked change is the report index under `threats/`; explicit citation ranges, links, closure IDs and test totals passed. This validates consistency, not exploitability or compliance.
- `post-fix-8905505/source-snapshot.json`, per-partition coverage JSON and `read-ledger.jsonl` distinguish hashed/search-only material from relevant-path reads. Source snapshot: 778 selected tracked text files; not all fully reviewed.
- `post-fix-8905505/sensitive-literal-scan.json` contains classifications/hashes only, no actual credentials.

The detailed partition reports contain 78 current observations, including shared roots and one explicit duplicate transport observation (PF-SEC-15/PF-WEB-15). They are not added to the historical 97 or claimed as 78 novel independent vulnerabilities. Older partition 'tests not run' statements describe those source-only subreviews; the coordinator verification report is authoritative for later executed checks.

**Exclusions:** actual production credentials/logs/responses, external requests, installed database roles/schema, remote TLS/ingress/CDN/cache headers, real funds, venue certification, full autonomous multi-user worker operation, actual contract dispatch/CPI, fresh advisory reachability, full transitive frontend bundle provenance, opaque historical credentials and unlisted source paths. No audit can establish absence of all bugs; this one records bounded source evidence, reproducible local failures and explicit remaining validation limits.
