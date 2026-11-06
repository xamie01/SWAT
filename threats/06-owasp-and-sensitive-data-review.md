# 06 — OWASP and sensitive-data review

## 1. Executive result and scope

**Assessment date:** 2026-11-06; local source integrity checkpoint **2026-11-06T21:34:23Z**. **HEAD:** `d5852a0e31e8e9a517c6e7c47ed9623819c7fc71`.

This is a fresh, authorized, **bounded current-source assessment**, not a penetration test, production-response inspection, dependency audit, or deployment certification. It covers the Next frontend/proxy, main API authorization and registered handlers, LP HTTP boundary, independent MCP transport, standalone PDA test UI, and selected shared/database producers and serializers. Existing reports were orientation and overlap context; findings below were traced in current source. No application requests, tests, builds, service starts, installations, fixes, git changes, or credential-file reads were performed by the local assessor. The coordinator separately fetched public official OWASP references.

**New assessment snapshot: 15 findings — 0 Critical, 4 High, 8 Medium, 3 Low.** These are this report's IDs, **not 15 newly discovered or independently additive weaknesses** across the prior report series. Several overlap existing findings. Severity describes the stated prerequisites; confidence distinguishes a confirmed source behavior from an unverified exploitation/deployment consequence.

Most important conclusions:

- MCP has no application authentication before global database reads and administrative mutations. Exposure depends on listener reachability and backend privileges.
- The standalone test UI derives an **interactive signing account** from public inputs. It is not the actual Solana PDA. Any funds held by that interactive account would lack confidential signing authority.
- Billing can credit the submitting user without binding a valid treasury payment to that user's verified intent/payer. Polymarket enrollment can overwrite another user's grant owner on a global address conflict.
- **Confirmed sensitive logging:** the Polymarket enrollment signature/address/time/nonce tuple is explicitly sent to Fastify logging. This is signed authorization material, **not a wallet private key**.
- **Conditional credential disclosure paths:** configured RPC URLs reach unauthenticated test-UI status, operator diagnostics, and failure logs; session cookies can traverse a plaintext cross-host backend fallback. Actual credential-bearing runtime values and production transport were not inspected.
- No embedded production credential was located in the bounded current frontend source scan. Current client requests do not inject the operator API key. Own-user Polymarket responses contain an API-key **identifier**, not its secret/passphrase or wallet key. No compiled bundle or actual response was examined, so this is **not certification that frontend artifacts contain no secrets**.

Application source was not modified. Indexed source hashes were unchanged at the checkpoint; HEAD and tracked working-tree state also remained unchanged. Untracked `LP-BUILD-RECORD.md`, `apps/lp/.zcodeignore`, and `threats/` were already present initially. Hash baselines were collected per file, not atomically; unindexed files and later concurrent edits remain outside that assurance.

## 2. Standards and interpretation

Use **OWASP Web Top 10 2025**, **OWASP API Security Top 10 2023**, and **ASVS 5.0.0**. Recommend **ASVS L2** as a baseline, with stronger risk-based custody, signer, and authorization-intent controls for a financial application. No compliance score, certification, or exhaustive ASVS verification is claimed.

Official references, retrieved by the coordinator:

- Web 2025: https://top10.owasp.org/2025/ ; retrieved official source https://raw.githubusercontent.com/OWASP/Top10/master/2025/docs/en/index.md
- API 2023: https://api-security.owasp.org/editions/2023/en/0x11-t10/ ; retrieved official source https://raw.githubusercontent.com/OWASP/API-Security/master/editions/2023/en/0x11-t10.md
- ASVS pinned release: https://github.com/OWASP/ASVS/tree/v5.0.0 ; pinned requirements https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv
- Local reference evidence: `/home/xahmie/Documents/SWAT/threats/evidence/owasp-standards-reference.json`.

Family labels used below: V1 Encoding and Sanitization; V2 Validation and Business Logic; V3 Web Frontend Security; V4 API and Web Service; V6 Authentication; V7 Session Management; V8 Authorization; V11 Cryptography; V12 Secure Communication; V13 Configuration; V14 Data Protection; V15 Secure Coding and Architecture; V16 Security Logging and Error Handling. Exact requirement IDs appear only where independently supplied from the pinned CSV; other mappings are family-level control objectives.

## 3. Authorization and data-flow boundaries

| Surface | Current source boundary and response observations |
|---|---|
| Browser → main/LP API | `credentials: include`; mutation CSRF header from readable cookie; no operator-key header injection in `/home/xahmie/Documents/SWAT/apps/web/lib/api.ts:96-112`. Browser default is relative-origin; server URL resolution is separate at `:124-151`. |
| Next proxy/SSR | Rewrites in `/home/xahmie/Documents/SWAT/apps/web/next.config.ts:9-17,24-36`; middleware forwards the whole Cookie header at `/home/xahmie/Documents/SWAT/apps/web/middleware.ts:21-25,37-46`. SSR helper forwards only `swat_session`, using no-store at `/home/xahmie/Documents/SWAT/apps/web/lib/api-server.ts:34-47`. |
| Public main routes | Explicit set: health, signup/login, wallet nonce/verify in `/home/xahmie/Documents/SWAT/apps/api/src/auth/plugin.ts:36-42`. `/v1/health` suppresses raw RPC URLs in `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:249-306`. `/health` is **not** in that public set. |
| Global main routes | Admin-or-service default outside auth/me/billing prefixes: `/home/xahmie/Documents/SWAT/apps/api/src/auth/plugin.ts:89-125`; hook registration `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:140-148`. Stats, global wallets/discovery/clusters/signals/tokens/trading/config/logs/RPC diagnostics are not ordinary-user/public endpoints. |
| Tenant main routes | `requireUser` constructs identity from session principal, rejects service identity: `/home/xahmie/Documents/SWAT/apps/api/src/auth/plugin.ts:204-209`. Explicit admin role rejects service identity too at `:212-224`. Account, positions, subscriptions, billing and perps use own-user scopes; exceptions are the enrollment/payment authorization relationships discussed below. |
| LP | Session plus mutation CSRF and tenant requirement in `/home/xahmie/Documents/SWAT/apps/lp/src/auth.ts:1-103`; position/copy routes check user scope in `/home/xahmie/Documents/SWAT/apps/lp/src/routes.ts:218-556`. Public health is distinct. Keyless nonproduction omits the auth hook at `/home/xahmie/Documents/SWAT/apps/lp/src/index.ts:298-300`, but route principal checks still reject access: this is not proof of unauthenticated tenant reads/writes. |
| Independent MCP/PDA | These do not inherit Next/main API middleware. MCP has unauthenticated SSE/session dispatch; PDA status is public and withdrawal implements its own signature checks. See OWA-01/02/05 and LEAK-03. |

## 4. Finding register

| ID | Severity | Confidence / qualification | Summary |
|---|---|---|---|
| OWA-01 | High | Verified — source path traced; reachability unverified | MCP exposes global control/data without application authentication |
| OWA-02 | High | Verified — public derivation traced; funding unverified | Publicly derivable interactive test-vault signing key |
| OWA-03 | High | Verified — missing binding traced; payment prerequisite | Billing claims need not belong to submitting user |
| OWA-04 | High | Verified — owner overwrite traced; venue/replay impact conditional | Polymarket grant conflict can reassign tenant ownership |
| OWA-05 | Medium | Verified — missing binding traced; valid signature prerequisite | Test withdrawal verifies message but uses unsigned parallel fields |
| OWA-06 | Medium | Likely — permissive source configuration confirmed; browser impact untested | Main permissive fallback and ineffective LP credentialed CORS allowlist |
| OWA-07 | Medium | Likely — HTML sinks confirmed; attacker influence/execution untested | Test UI interprets provider/API text as HTML |
| OWA-08 | Medium | Likely — escaping gap confirmed; spreadsheet interpretation untested | Admin CSV cells lack formula neutralization |
| LEAK-01 | Medium | Verified — explicit proof-to-log flow traced; retention/replay unverified | Polymarket enrollment proof enters application logs |
| LEAK-02 | Medium | Likely — plaintext fallback/forwarding confirmed; topology unverified | Cookie credentials can cross an insecure backend hop |
| LEAK-03 | Medium | Likely — URL flows confirmed; credential-bearing configuration unverified | Raw RPC URLs reach public status, operator diagnostics/logs |
| LEAK-04 | Medium | Likely — error echo confirmed; sensitive producer payload unverified | Route-local/provider errors bypass generic public error policy |
| LEAK-05 | Low | Verified — ticket flow traced; one-use 60-second limitation | Admin log-stream ticket appears in URL |
| LEAK-06 | Low | Likely — explicit header policy absent in reviewed source; actual caching unverified | Sensitive API responses lack explicit no-store policy |
| LEAK-07 | Low | Verified — own-user identifier flow traced; not unauthorized disclosure | Full CLOB API identifier unnecessarily returned to browser |

**Confidence convention:** Verified means the relevant source path and callers were traced, not that a production exploit occurred. Likely means the source concern is supported but the stated browser, deployment, or sensitive-payload consequence still needs a controlled test. Unreviewed deployment properties remain NOT VERIFIED.

### OWA-01 — MCP global data/control without application authentication

**Mapping:** Web A01 Broken Access Control / A07 Authentication Failures; API2 Broken Authentication / API5 Broken Function Level Authorization; ASVS V4, V6, V8, V14.

**Evidence and flow:** `/home/xahmie/Documents/SWAT/apps/mcp-server/src/index.ts:365-405` creates an SSE session, looks up a caller-supplied session ID on POST, and binds all interfaces without authentication/role/origin middleware. A random transport session ID is not a verified principal. Global SQL result → tool output at `:128-241`; blacklist mutations at `:264-343`; Redis scorer command at `:346-350`. Data class: operational signals, financial aggregates/open positions/fills, shared administrative policy. There is no tenant or role decision in the tool dispatch.

**Prerequisites/impact:** a reachable listener, functioning protocol exchange, and usable DB/Redis privileges. Those were not tested. No credential columns were identified in the read-tool projections; this finding is global data/control exposure, not proven database-password or root-key leakage. Conceptual abuse is limited to reaching the listener, obtaining its transport session, and invoking an otherwise privileged tool.

**Fix, unapplied:** (1) Default to loopback/private exposure and require authenticated principal on both routes. (2) Bind transport lifecycle to that principal and authorize every tool; separate tenant tools from operator tools. (3) Bound sessions/work and return sanitized errors. **Proposed verification, not run:** anonymous route/tool rejection; user/service/admin matrix; cross-session ownership; authorized global-operation regression.

### OWA-02 — Publicly derivable interactive signing key

**Mapping:** Web A04 Cryptographic Failures / A06 Insecure Design; ASVS V11, V15.

**Evidence and flow:** `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:38-40` hashes a fixed public label and public owner address to seed a signing keypair; `:99-130` uses it for the interactive account; `:244-285` derives it again and signs a transfer. The genuine PDA derivation at `:102-105` is a separate account. Data class: wallet signing authority. No private entropy or confidential server key participates in the interactive-key derivation.

**Prerequisites/impact:** any funded interactive account produced by this scheme has publicly reproducible signing authority. Network, balances, actual signing/submission, and production use were not examined. Do not call this a compromised actual PDA or a leaked production seed.

**Fix, unapplied:** (1) Disable funding and signing for the deterministic interactive model. (2) Use a real PDA/program authority or disposable confidential random test keys, with explicit account-role labeling. (3) Enforce isolated test network/custody policy. **Proposed verification, not run:** test-only derivation policy checks, account-role assertions, and migration/deposit blocking; do not derive or sweep a real owner's account during validation.

### OWA-03 — Treasury payment not bound to claimant

**Mapping:** Web A01 Broken Access Control / A06 Insecure Design; API1 Broken Object Level Authorization / API6 Unrestricted Access to Sensitive Business Flows; ASVS V2, V8.

**Evidence and flow:** `/home/xahmie/Documents/SWAT/apps/api/src/routes/billing.ts:378-388` rejects only a **resolved** memo owned by another user; absent/unknown memo is not rejected. Current chain verifiers at `:65-123,155-231` validate treasury payment conditions without binding the payer to the session; Solana does not establish a chain-visible intent memo binding. Successful verification → `scope.userId` credit at `:393-419`. `/home/xahmie/Documents/SWAT/packages/db/src/billing.ts:150-205` locks/inserts for that submitting scope and records payer only as metadata. Data class: payment ownership and paid entitlement, not credentials.

**Prerequisites/impact:** an authenticated user, an otherwise accepted unclaimed treasury transaction, and relevant payment state. Unique transaction insertion and atomic user-row update are useful safeguards, but do not establish rightful ownership. No chain request, claim, or theft was reproduced.

**Fix, unapplied:** (1) Require an existing pending unexpired user-bound intent. (2) Prove its binding through supported chain evidence or explicitly verified payer authorization, rather than trusting supplied memo text. (3) Consume intent and canonical transaction identity atomically with entitlement update. **Proposed verification, not run:** missing/unknown/other-user/expired intent rejection; alternate user's valid-payment claim rejection; duplicate and concurrent valid-owner claims.

### OWA-04 — Cross-owner Polymarket grant overwrite

**Mapping:** Web A01 Broken Access Control / A06 Insecure Design; API1 Broken Object Level Authorization; ASVS V2, V8, V11.

**Evidence and flow:** authenticated enrollment checks session scope at `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:525-539`. The challenge uses timestamp and constant nonce without a stored user-bound enrollment challenge at `:489-515`. Venue-accepted credentials are sealed using the **submitting** user AAD at `:603-623`, then `ON CONFLICT (chain, account_address)` sets `user_id = EXCLUDED.user_id` without same-owner condition at `:639-651`. The global unique address constraint is `/home/xahmie/Documents/SWAT/packages/db/sql/047_user_execution_grants.sql:113`. Data class: tenant ownership of signing authorization and sealed venue credentials.

**Prerequisites/impact:** accepted venue enrollment proof for an address already assigned to another tenant. A logged proof may be relevant (LEAK-01), but venue replay acceptance/window and downstream executor consequences were not tested. Signature recovery diagnostics are not an ownership gate. No wallet root key is disclosed by this operation.

**Fix, unapplied:** (1) Reject different-owner conflict, matching the ownership-preserving pattern in `/home/xahmie/Documents/SWAT/packages/db/src/auth-wallets.ts:26-62`. (2) Bind enrollment authorization to an authenticated linked wallet and single-use user/address challenge in the application in addition to venue requirements. (3) Revoke/replace grants transactionally and audit without proof contents. **Proposed verification, not run:** alternate-session reuse and cross-owner conflict must leave the victim row untouched; legitimate same-owner renewal remains supported; venue-response stubs avoid real credential derivation.

### OWA-05 — Withdrawal signature does not bind executed intent

**Mapping:** Web A06 Insecure Design / A08 Software or Data Integrity Failures; API6 Unrestricted Access to Sensitive Business Flows; ASVS V2, V8, V11.

**Evidence and flow:** `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:206-230` verifies caller-supplied message bytes while independently checking an unsigned timestamp. `:244-283` uses independently supplied amount and owner to derive/sign the transfer. No canonical-message comparison or single-use nonce store is present. Honest client signs amount/owner/time at `/home/xahmie/Documents/SWAT/pda-test-ui/public/index.html:826-862`; server does not enforce that structure. Data class: signed financial intent.

**Prerequisites/impact:** a valid owner signature and usable interactive account; funds and submission untested. Recipient remains the owner at server `:275`, so this is not demonstrated attacker-destination theft. Independent deterministic-key weakness is OWA-02, not double-counted here.

**Fix, unapplied:** (1) Construct/validate one canonical domain-separated intent binding every executable field, network, expiry, and nonce. (2) Strictly validate integer ranges and consume a server nonce atomically before side effects. (3) Preserve durable idempotency through uncertain submission. **Proposed verification, not run:** changed amount/time/network/message rejection, nonce replay/concurrency rejection, legitimate signed intent succeeds using mocked chain dependencies.

### OWA-06 — Credentialed CORS trusts unlisted origins

**Mapping:** Web A02 Security Misconfiguration; API8 Security Misconfiguration; ASVS V3, V4, V13; pinned `v5.0.0-3.4.2`.

**Evidence and flow:** main CORS reflects origin when `CORS_ORIGIN` is absent at `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:90-104`. LP callback returns `true` even for disallowed origin at `/home/xahmie/Documents/SWAT/apps/lp/src/index.ts:277-295`; the configured list is ineffective. Data class: cookie-authenticated own-user account/financial responses readable from an untrusted origin **if the browser actually sends credentials**.

**Prerequisites/limits:** browser cookie delivery/topology, e.g. attacker-controlled same-site origin, is not verified. Host-only SameSite=Lax cookies limit unrelated-site fetch, and CSRF header checks protect cookie-authenticated mutations (`/home/xahmie/Documents/SWAT/apps/api/src/auth/routes.ts:106-124`; `/home/xahmie/Documents/SWAT/apps/api/src/auth/plugin.ts:79-86`; `/home/xahmie/Documents/SWAT/apps/lp/src/auth.ts:1-103`). Do not equate reflection with proven arbitrary cross-site account takeover.

**Fix, unapplied:** (1) Reject unlisted origins; remove suffix-based acceptance. (2) Fail closed in production on absent origin policy while preserving needed no-Origin service callers. (3) Keep CSRF and restrictive cookie settings. **Proposed verification, not run:** exact allowed/disallowed/no-Origin preflight matrix plus same-site/unrelated-site browser credential-delivery tests in an isolated deployment.

### OWA-07 — Test UI error/response text reaches HTML sinks

**Mapping:** Web A05 Injection; API10 Unsafe Consumption of APIs where provider-derived content is consumed; ASVS V1, V3, V16.

**Evidence and flow:** `/home/xahmie/Documents/SWAT/pda-test-ui/public/index.html:463-470,503-507` inserts log/error text with innerHTML. Own API error → `Error(data.error)` → catch → log at `:865-887`; successful response fields also enter innerHTML at `:876-883`. Raw server error producers include `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:299-302`. Data class: integrity of the wallet-connected browser and its runtime test signer; not a located hardcoded secret. Browser-generated test key stays in memory at HTML `:623-639`.

**Prerequisites/limits:** attacker influence over victim-visible upstream/API/provider text and browser markup execution are unverified. Main Next layout's static theme script is **not** this vulnerability (`/home/xahmie/Documents/SWAT/apps/web/app/layout.tsx:73-88`).

**Fix, unapplied:** (1) Use textContent and constructed DOM nodes for errors/logs. (2) Validate explorer URLs and use fixed public errors. (3) Add compatible CSP as defense in depth. **Proposed verification, not run:** inert markup fixtures remain text across errors, logs, and success banners; valid links still work; wallet signing behavior unchanged.

### OWA-08 — Spreadsheet formula injection in admin export

**Mapping:** Web A05 Injection; ASVS V1, V14.

**Evidence and flow:** `/home/xahmie/Documents/SWAT/apps/api/src/routes/admin-portfolio.ts:25-42` escapes CSV syntax but not formula-leading cells; export at `:116-134` is explicitly admin-only. `/home/xahmie/Documents/SWAT/packages/db/src/admin-portfolio.ts:555-620` exports user/portfolio text and financial data. Data class: administrator workstation and exported personal/financial data; tenant data is intentionally admin-visible, not an anonymous JSON leak.

**Prerequisites/limits:** attacker-controlled exported text, an administrator exporting it, and spreadsheet interpretation of that cell. No spreadsheet or formula was executed.

**Fix, unapplied:** (1) Define a spreadsheet-safe export policy for all string cells including leading whitespace/control characters. (2) Neutralize dangerous formula prefixes or emit a typed format with cells as text. (3) Preserve CSV syntax escaping. **Proposed verification, not run:** formula-shaped inert strings remain literal in supported readers; commas/quotes/newlines and financial numeric cells still round-trip.

### LEAK-01 — Signed enrollment proof explicitly logged

**Mapping:** Web A09 Security Logging and Alerting Failures; ASVS V14, V16; pinned `v5.0.0-16.2.5`.

**Evidence and flow:** wallet typed-data signature → cookie-authenticated request at `/home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:279-297,359-381` → `request.log.info({address, signature, timestampSeconds, nonce}, ...)` at `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:534-539` → Fastify/Pino application log. Fastify logger enabled without explicit redaction at `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:54`. Data class: cryptographic authorization tuple; public address/time/nonce are context, signature is replay-sensitive proof. Actual retention, access permissions and venue replayability unverified.

**Important sink distinction:** `request.log.info` is **not** console.log; `/home/xahmie/Documents/SWAT/packages/shared/src/logger.ts:94-110` intercepts console only. The traced enrollment proof cannot therefore be claimed to reach Redis `/v1/logs` through that interceptor. Log readers obtaining a proof still differ from readers obtaining a wallet private key. OWA-04 is the separate unsafe enrollment-owner operation.

**Fix, unapplied:** (1) Remove signature/proof fields from normal logs; use outcome, principal ID, request ID and safe correlation metadata. (2) Apply credential/proof redaction across structured and console logs; use hash/masked correlation only where necessary. (3) Review existing log retention/access and owner-led invalidation decisions without publishing values. **Proposed verification, not run:** mocked successful/failed enrollment with unique inert proof marker must not leave that marker in any captured log; normal audit events remain useful.

### LEAK-02 — Cookie forwarding over plaintext fallback; conditional Secure flag

**Mapping:** Web A04 Cryptographic Failures / A02 Security Misconfiguration; API8 Security Misconfiguration; ASVS V7, V12, V13, V14; pinned `v5.0.0-12.3.3` for internal HTTP TLS.

**Evidence and flow:** production remote HTTP backend fallback at `/home/xahmie/Documents/SWAT/apps/web/middleware.ts:21-25` → whole Cookie header at `:37-46`. Server-only rewrite destinations also allow remote HTTP at `/home/xahmie/Documents/SWAT/apps/web/next.config.ts:9-17,24-36`; SSR resolver `/home/xahmie/Documents/SWAT/apps/web/lib/api.ts:124-151` → **session-only** header at `/home/xahmie/Documents/SWAT/apps/web/lib/api-server.ts:34-47`. Data class: bearer session cookie and, for middleware, unrelated cookies in the same request. This is a transport disclosure path, not API_KEY bundling. Browser→frontend HTTPS does not encrypt a separate server→backend HTTP hop, and HttpOnly does not protect that hop.

Cookie issuer additionally permits `COOKIE_SECURE=false` or a non-HTTPS protocol/header decision in production at `/home/xahmie/Documents/SWAT/apps/api/src/auth/routes.ts:103-121`. Trusted proxy/header handling was not inspected at deployment, so actual insecure cookie issuance is conditional.

**Prerequisites/limits:** insecure configured/fallback backend selected and an observer/untrusted upstream on that path; actual ingress/network configuration unknown. Relative-origin browser default and SSR session-only minimization are preserved safeguards.

**Fix, unapplied:** (1) Require approved HTTPS cross-host backend targets in production, with no plaintext remote fallback; explicitly document any confined local hop. (2) Forward only needed session cookies; validate redirect/target behavior. (3) Enforce production Secure cookie policy and trusted ingress metadata; configure browser TLS/HSTS after verification. **Proposed verification, not run:** reject unsafe/missing production backend config, inspect outgoing cookie allowlist with mock fetch, and test Set-Cookie under trusted/untrusted forwarded headers.

### LEAK-03 — RPC URL disclosure through three distinct sinks

**Mapping:** Web A02 Security Misconfiguration / A09 Security Logging and Alerting Failures / A10 Mishandling of Exceptional Conditions; API3 Broken Object Property Level Authorization / API8 Security Misconfiguration; ASVS V13, V14, V16; pinned `v5.0.0-14.2.3`, `v5.0.0-16.2.5`.

Data class: endpoint configuration; **credentials only if a configured URL contains userinfo, provider token path, or query credentials**. Runtime config was deliberately not read.

1. **Public test UI:** runtime RPC variable → `DEFAULT_RPC` → unauthenticated `/api/status` `rpcUrl` at `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:17-22,78-85`; independent listener at `:373-394`. An actually secret-bearing configured URL and reachability are prerequisites. Default public RPC URL is not a secret.
2. **Operator diagnostics:** pool stores/returns raw `primaryUrl`, `activeHealthyUrl`, endpoint `url` and provider errors at `/home/xahmie/Documents/SWAT/packages/shared/src/rpc-failover.ts:258-332` → `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:312-325`. This is **admin/service-gated**, not public `/v1/health`, and exposes more configuration than necessary to operators/browser responses.
3. **Redis logs:** candidate URL/error embedded in thrown summary at `/home/xahmie/Documents/SWAT/packages/shared/src/rpc-failover.ts:228-247` → billing catch `console.error` at `/home/xahmie/Documents/SWAT/apps/api/src/routes/billing.ts:119-121,228-230` → generic inspect serialization and Redis list/pubsub at `/home/xahmie/Documents/SWAT/packages/shared/src/logger.ts:19-51,68-85,105-109` → admin/service log API/SSE at `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:874-885,909-942` → admin UI `/home/xahmie/Documents/SWAT/apps/web/app/logs/page.tsx:113,166-187`. Failure of the configured credential-bearing endpoint is the additional log-path prerequisite. Generic serialization truncates, but does not redact.

**Fix, unapplied:** (1) Return stable endpoint IDs, provider/network labels and health booleans, never authenticated URL components. (2) Redact URL credentials and sensitive provider text **before** exceptions/logging/serialization, covering structured and console paths. (3) Restrict diagnostic access and log retention; rotate only actual exposed credentials after owner-controlled verification. **Proposed verification, not run:** inert userinfo/path/query token markers with stubbed RPC failure must be absent from public status, operator diagnostics, Redis list and SSE output; normal public endpoint/health observability remains functional.

### LEAK-04 — Local error responses echo internal exception messages

**Mapping:** Web A10 Mishandling of Exceptional Conditions; API8 Security Misconfiguration / API10 Unsafe Consumption of APIs; ASVS V4, V14, V16; pinned `v5.0.0-16.5.1`.

**Evidence and flow:** caught error → public/client output in `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:661-666`, `/home/xahmie/Documents/SWAT/apps/api/src/routes/billing.ts:349-353`, `/home/xahmie/Documents/SWAT/apps/lp/src/routes.ts:347,397,509`, unauthenticated MCP tool response `/home/xahmie/Documents/SWAT/apps/mcp-server/src/index.ts:356-361`, and standalone test UI `/home/xahmie/Documents/SWAT/pda-test-ui/server.mjs:299-302`. Browser helper retains API message and error body at `/home/xahmie/Documents/SWAT/apps/web/lib/api.ts:201-213,250-261`; vault catch logs the error object at `/home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:300-301`. Data class: conditional internal DB/provider/config detail; credentials require a sensitive producer error, not merely an error echo.

**Important negative evidence:** the credential helper deliberately omits venue response bodies from errors at `/home/xahmie/Documents/SWAT/packages/shared/src/polymarket-clob-credentials.ts:449-489`; credential parse errors name shapes/fields rather than values at `:519-555`. **Complete CLOB secret/passphrase response leakage was not established.** Main global unexpected-500 handler is generic at `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:179-199`, but route-local catches bypass it.

**Fix, unapplied:** (1) Map known client errors to fixed public codes/messages; return generic unexpected errors with request ID. (2) Keep redacted diagnostic causes server-side, avoiding raw credential objects/body values. (3) Avoid routine browser console logging of full ApiError bodies. **Proposed verification, not run:** stub DB/provider exceptions with inert confidential markers; markers must be absent from route bodies/browser-facing errors while correlation and safe known errors remain usable.

### LEAK-05 — Log-stream bearer ticket in URL

**Mapping:** Web A09 Security Logging and Alerting Failures; ASVS V7, V14, V16; pinned `v5.0.0-14.2.1`.

**Evidence and flow:** explicit admin ticket issue with Redis TTL 60 seconds at `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:219-224` → frontend EventSource query at `/home/xahmie/Documents/SWAT/apps/web/app/logs/page.tsx:139-166` → auth ticket consumption `/home/xahmie/Documents/SWAT/apps/api/src/auth/plugin.ts:167-175`. Consumption uses atomic Redis DEL injected at main index `:143-145`. Data class: short-lived bearer authorization to operator logs.

**Limits:** single-use and short lifetime substantially bound theft/replay. No query-log capture or ticket theft verified. Query URLs can be recorded by request/ingress diagnostics; this is not a claim that EventSource necessarily creates browser history or leaks a referrer.

**Fix, unapplied:** (1) Prefer same-origin authenticated-cookie SSE where feasible. (2) If tickets remain necessary, redact query credentials in every request/edge log and bind issuance/consumption to principal/scope. (3) Retain atomic single-use TTL. **Proposed verification, not run:** expired/replayed/concurrently consumed ticket rejection; no ticket marker in captured request logs; authorized cookie stream regression.

### LEAK-06 — Sensitive API caching policy not explicit

**Mapping:** Web A02 Security Misconfiguration; API8 Security Misconfiguration; ASVS V14; pinned `v5.0.0-14.3.2`.

**Evidence:** own-user account/vault and billing bodies `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:126-229,332-397` and `/home/xahmie/Documents/SWAT/apps/api/src/routes/billing.ts:292-321,421-427`; admin export `/home/xahmie/Documents/SWAT/apps/api/src/routes/admin-portfolio.ts:116-134`. No explicit sensitive-response no-store policy was located in the bounded handler/global-header search. Log SSE sets **no-cache**, not no-store, at `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:918`. Data class: personal/financial information and own-user credential identifier.

**Limits:** actual framework/edge headers and cache storage were not inspected; cookie/proxy defaults may already prevent shared caching. Next middleware/SSR fetches use no-store, but that does not prove browser/edge response policy. This is a hardening gap, **not a demonstrated cross-user cache leak**.

**Fix, unapplied:** (1) Add explicit no-store to sensitive authenticated JSON, export and log responses. (2) Ensure CDN/reverse-proxy rules never cache user-dependent responses. (3) Preserve any reviewed safe public-data caching separately. **Proposed verification, not run:** actual header assertions across account/billing/admin/log routes and isolated alternate-session/edge cache checks.

### LEAK-07 — Own-user API-key identifier returned in full

**Mapping:** data-minimization review, not automatically Broken Access Control; ASVS V14 Data Protection.

**Evidence and flow:** derived identifier in plaintext `scope_policy` and enrollment response at `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:633-660`; own vault response at `:380-382` → React state at `/home/xahmie/Documents/SWAT/apps/web/app/vault/page.tsx:299,315` → display only prefix/suffix at `:1273-1278`. Data class: CLOB API-key identifier, **not** complete authentication secret/passphrase. Auth is own-user, and complete credentials are sealed server-side at me `:610-623`.

**Limits:** identifier appears in browser response/memory even though DOM is masked. No cross-user exposure or ability to authenticate using identifier alone established; intentional one-time API-key issuance is not inherently a vulnerability. This recommendation is minimization where this UI needs only status/masked identification.

**Fix, unapplied:** (1) Return only status and a server-derived masked identifier if full value is unnecessary. (2) Keep complete L2 credential set server-side and document intentional display requirements. (3) Avoid identifiers in routine browser logs. **Proposed verification, not run:** UI still shows enrollment/status and masked prefix/suffix; full identifier/secret/passphrase absent from account/enrollment JSON where not explicitly required.

## 5. Positive safeguards and bounded no-leak results

These are paths actually reviewed, not a promise about unseen artifacts or runtime values.

| Category | Current evidence and bounded conclusion |
|---|---|
| Operator API key in main frontend | No literal credential hit in scanned current web source; `/home/xahmie/Documents/SWAT/apps/web/lib/api.ts:96-112` adds cookies/CSRF but no API key. `NEXT_PUBLIC_API_KEY` occurs in a historical explanatory comment/test and root build/CI metadata, not a verified executable frontend request path. Comments about an older bundled key are not fresh leak proof. |
| Database/Redis/master key in client bundles | No current browser source producer→serialization/import path located for `DATABASE_URL`, `REDIS_URL`, or custody master keys in the bounded scan. Next config contains no env-export block (`/home/xahmie/Documents/SWAT/apps/web/next.config.ts:1-49`). Runtime DB URLs remain pool inputs (`/home/xahmie/Documents/SWAT/packages/db/src/client.ts:10-27`; `/home/xahmie/Documents/SWAT/packages/db/src/client-runtime.ts:1-180`). No complete transitive bundle graph/build was verified. |
| Password/session serialization | Public user projection omits password hash at `/home/xahmie/Documents/SWAT/apps/api/src/auth/routes.ts:77-85`. DB authentication selects hash internally and returns projected user; session storage hashes tokens in `/home/xahmie/Documents/SWAT/packages/db/src/users.ts:1-286`. Credentials primitives use Argon2/random tokens/constant-time digest checks at `/home/xahmie/Documents/SWAT/packages/db/src/credentials.ts:1-138`. Session emitted HttpOnly Set-Cookie at auth routes `:101-124`, not login JSON. Login/signup hold passwords in form memory and submit to own API, without persistent storage at `/home/xahmie/Documents/SWAT/apps/web/app/login/page.tsx:27-37` and `/home/xahmie/Documents/SWAT/apps/web/app/signup/page.tsx:67-102`. HttpOnly does not mitigate LEAK-02 transport or all XSS actions. |
| Browser storage | Identified localStorage use is theme preference in `/home/xahmie/Documents/SWAT/apps/web/components/ThemeProvider.tsx:26-57` and static layout theme script `/home/xahmie/Documents/SWAT/apps/web/app/layout.tsx:73-88`; no sessionStorage credential use found in indexed web source. The layout does not interpolate stored text into script source or HTML. |
| Wallet signing and public config | Main wallet provider returns signatures/public addresses, not root keys (`/home/xahmie/Documents/SWAT/apps/web/lib/wallets.ts:152-183`; vault page `:279-297,359-381`). Program IDs and `NEXT_PUBLIC_APP_URL` metadata are public configuration, not secrets. No verified client Helius-secret substitution was located; server LP RPC configuration is not a browser bundle proof. Standalone runtime-generated test signer is distinct from embedded-secret leakage and from OWA-02. |
| Complete Polymarket credentials/ciphertext | Complete credentials seal server-side with AES-256-GCM and user/chain/version AAD; fresh data key/IV and wrapper validation in `/home/xahmie/Documents/SWAT/packages/shared/src/authority/envelope.ts:1-135` and `/home/xahmie/Documents/SWAT/packages/shared/src/authority/key-wrapper.ts:1-127`. Own-user responses traced above return identifier, not secret/passphrase/master key/sealed_secret. Explicit grant projection excludes ciphertext at `/home/xahmie/Documents/SWAT/packages/db/src/execution-grants.ts:96-98`; separate ciphertext loader is `id AND user_id` scoped at `:315-327`, with no web/API caller found in search. API does instantiate the master-key wrapper for enrollment: comments that only executor can hold it must not replace current source evidence. |
| Tenant and service isolation | Main cookie session takes precedence; invalid protected cookie does not downgrade to shared key; mutation CSRF is checked; Bearer is rejected pending feature support (`/home/xahmie/Documents/SWAT/apps/api/src/auth/plugin.ts:127-194`). `requireUser` rejects service identity; explicit admin role rejects it too. Own positions/subscriptions/feed/perps use session-derived scope in `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:233-329,713-758,973-1128,1309-1338`; scoped perps SQL `/home/xahmie/Documents/SWAT/packages/db/src/polymarket-perps.ts:169-174,221-230,276-283`. LP position/copy serializers project financial fields and readers scope by user at `/home/xahmie/Documents/SWAT/packages/db/src/lp-positions.ts:219-267` and `/home/xahmie/Documents/SWAT/packages/db/src/lp-copy-trading.ts:249-262`. This does not assert universal database RLS enforcement or fix OWA-03/04. |
| Wallet login/linking | Single-use Redis nonce and domain/URI/address/signature checks at `/home/xahmie/Documents/SWAT/apps/api/src/auth/routes.ts:224-387` and `/home/xahmie/Documents/SWAT/apps/api/src/auth/wallet-signature.ts:1-167`; cross-owner auth-wallet linking refuses reassignment in `/home/xahmie/Documents/SWAT/packages/db/src/auth-wallets.ts:26-62`. This differs from Polymarket conflict overwrite. |
| Public health/global responses | Public health excludes raw RPC URLs; diagnostics/logs/config are global admin/service-gated. Config handler reads DB config, not process.env at `/home/xahmie/Documents/SWAT/apps/api/src/index.ts:864-867,949-967`. Selected global `SELECT *` queries (`:572,629,658,764`) warrant future explicit projections, but SELECT * alone is not evidence of password/key disclosure. All historical/future schema additions and stored config payloads were not fully traced. |

Safe root/config metadata scan also classified credential-bearing connection-URL literals in `.woodpecker.yaml` at lines 33,40-42,54-55, under integration/admin database variable names. Values were not emitted or used. Provenance, reuse and validity were not established; these are **not claimed production leaks**. Historical opaque assignments and historical commit claims were not revalidated; no historical secret values were retrieved.

## 6. OWASP coverage matrix — not a compliance score

### Web Top 10 2025

| Category | Bounded outcome |
|---|---|
| A01 Broken Access Control | OWA-01/03/04; positive tenant/role boundaries above. |
| A02 Security Misconfiguration | OWA-06, LEAK-02/03/04/06. Deployment headers, edge policy and public reachability unknown. |
| A03 Software Supply Chain Failures | Package/config metadata only; no fresh installed-version/advisory or dependency-code audit. Earlier runtime advisory evidence is separate. |
| A04 Cryptographic Failures | OWA-02 and LEAK-02; reviewed envelope primitives have authenticated encryption/AAD. Not a cryptographic implementation audit. |
| A05 Injection | OWA-07/08. Inspected SQL parameters/projections showed no independently confirmed SQL injection; not an exhaustive query/taint analysis. |
| A06 Insecure Design | OWA-02/03/04/05. Durable intent and ownership binding are load-bearing financial controls. |
| A07 Authentication Failures | OWA-01; positive cookie/nonce/service-key checks. Installed hook/proxy behavior and auth rate-limiter efficacy not tested. |
| A08 Software or Data Integrity Failures | OWA-05 signed-intent mismatch. No complete external-feed/execution integrity assessment. |
| A09 Security Logging and Alerting Failures | LEAK-01/03/05. No runtime log sampling, alerting efficacy or incident-readiness verification. |
| A10 Mishandling of Exceptional Conditions | LEAK-03/04; generic main unexpected-500 safeguard preserved. No chaos/queue/DB failure tests. |

### API Security Top 10 2023

| Category | Bounded outcome |
|---|---|
| API1 Broken Object Level Authorization | OWA-03/04; tenant object readers traced; no blanket IDOR assurance. |
| API2 Broken Authentication | OWA-01; main/LP auth primitives examined without runtime auth testing. |
| API3 Broken Object Property Level Authorization | LEAK-03 conditional raw configuration disclosure; LEAK-07 is own-user minimization, not proven unauthorized property access. |
| API4 Unrestricted Resource Consumption | Main limiter exists (`/home/xahmie/Documents/SWAT/apps/api/src/index.ts:129-133,153-166`); LP/MCP lack a located comparable application limiter in reviewed entrypoints. Thresholds, hook phase, ingress and load behavior not verified; no fresh separate resource finding scored. |
| API5 Broken Function Level Authorization | OWA-01; main global and explicit admin gates traced. |
| API6 Unrestricted Access to Sensitive Business Flows | OWA-03/05; grant enrollment also needs replay/ownership controls. No financial actions invoked. |
| API7 Server Side Request Forgery | Configured server RPC/backend URLs traced, but no new attacker-controlled arbitrary server-fetch exploit established. No reachability testing or full URL-input taint audit. |
| API8 Security Misconfiguration | OWA-06, LEAK-02/03/04/06; deployment effectiveness unknown. |
| API9 Improper Inventory Management | Independent listeners inventoried; 92 main, 18 LP, 2 MCP literal HTTP registrations plus PDA dispatcher. No live inventory, retired endpoints or production service discovery. |
| API10 Unsafe Consumption of APIs | OWA-07/LEAK-04 conditional provider-content handling; complete credential helper deliberately suppresses venue bodies. Full provider response/schema review excluded. |

## 7. Prior-report overlap and additional bounded follow-ups

- OWA-01 overlaps MCP-01/02 in `/home/xahmie/Documents/SWAT/threats/security-review/09-agent-mcp.md`; no fresh SDK session-isolation finding is asserted.
- OWA-02/05/07 and LEAK-02 overlap WEB-01/02/03/04 in `/home/xahmie/Documents/SWAT/threats/security-review/10-web-app.md`; plaintext transport also overlaps INF-04 in `/home/xahmie/Documents/SWAT/threats/security-review/11-infrastructure-supply-chain.md`.
- OWA-03/04 and LEAK-01 overlap API-01/API-03 in `/home/xahmie/Documents/SWAT/threats/security-review/01-api.md`; venue replay and Polygon transaction-case acceptance remain untested. No old race/test result is relabeled fresh.
- OWA-06 overlaps SEC-01 in `/home/xahmie/Documents/SWAT/threats/security-review/08-secondary-services.md`. LP keyless auth omission is an availability/config issue, not confirmed public tenant bypass. LP subscription's shared tracked-wallet update and unsupported live lifecycle deserve their separate existing business-policy work; no live loss claimed here.
- `/home/xahmie/Documents/SWAT/threats/04-runtime-verification.md` separately records local RLS-role/schema/dependency/build observations. Those were **not reproduced in this assessment**, do not establish remote role/schema/deployment state, and are not added to this report's counts. In particular, a prior failed frontend build is not evidence of a clean bundle today.
- Generic grant registration at `/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:447-485` does not prove ownership of arbitrary supplied address; keyed grants still require sealed secrets under `/home/xahmie/Documents/SWAT/packages/db/sql/047_user_execution_grants.sql:95-103`, so no usable keyed authority should be inferred from a success label alone.
- Main withdrawal request stores destination/chain and OTP but not amount; confirmation checks linked destination, cooling-off, attempt cap and code, then says queued without visible queue handoff (`/home/xahmie/Documents/SWAT/apps/api/src/routes/me.ts:1131-1189,1215-1297`). Intent-completeness/lifecycle concerns overlap existing API-06; no actual executor withdrawal was established.
- Session caching at `/home/xahmie/Documents/SWAT/packages/db/src/users.ts:1-286` is process-local with a 60-second window; local revoke helpers invalidate locally, not demonstrably across processes. Password-change caller reachability and distributed revocation were not fully traced; no fresh password-reset exploit claimed.
- Withdrawal-ceiling policy validation, all DB migration extensions to SELECT * tables, executor sealed-secret consumers, stored config payloads and every LP worker error producer are incomplete. Do not use this report to certify these paths safe.

## 8. Remediation order and acceptance

1. **Contain independent signer/control surfaces:** isolate MCP, add route/tool principal authorization; disable deterministic interactive vault funding/signing. Preserve normal admin workflows and real PDA semantics.
2. **Repair authorization relationships:** enforce payment-intent/payer binding and reject cross-owner grant conflicts; use canonical, single-use financial/enrollment intents and atomic state changes.
3. **Stop sensitive-data propagation:** remove enrollment proofs from logs; redact authenticated RPC URLs before diagnostics/exceptions; use fixed public errors; preserve complete credential sealing and tenant projections.
4. **Harden transport/browser trust:** production trusted HTTPS targets, session-only forwarding, Secure-cookie ingress policy, real CORS allowlists, text-based DOM rendering, spreadsheet-safe CSV.
5. **Minimize residual artifacts:** no-store sensitive responses, ticket-query redaction or cookie SSE, masked-only credential identifiers. Verify built browser artifacts and real response headers later in a separately authorized environment.

All proposed tests above are **descriptions, not executed results**. Use synthetic markers, mocked chain/provider/DB responses and isolated browser/proxy fixtures, not actual credentials or real financial transfers. No exploit scripts are included. Existing CSRF, HttpOnly, SameSite, session hashing, tenant filters, global admin gate, role restrictions, generic 500 handling and AES-GCM/AAD safeguards must survive fixes.

## 9. Search/read inventory, integrity and exclusions

Artifacts:

- `/home/xahmie/Documents/SWAT/threats/evidence/06-local-source-inventory.json`: file-by-file path, hash, line count, indexed-search flag, test-source flag, **requestedReadRanges**, config classifications, coverage and integrity metadata.
- `/home/xahmie/Documents/SWAT/threats/evidence/06-route-register.json`: exact literal method/path/file/line registration inventory, not runtime router output.
- `/home/xahmie/Documents/SWAT/threats/evidence/06-local-review.py`: resource-light defensive scan/read helper; classifications omit suspected literal values. Detection is heuristic and includes false positives, not a secret-validity test.
- `/home/xahmie/Documents/SWAT/threats/evidence/06-validate-report.py` and `/home/xahmie/Documents/SWAT/threats/evidence/06-coordinator-validation.json`: coordinator's single-core finding-count, explicit citation-range, index-link and indexed-source integrity checks. These validate artifact consistency, not exploitability or OWASP compliance.

### Inventory depth

| Component | Non-test source files indexed/searched | Files with requested read ranges |
|---|---:|---:|
| apps/web | 56 | 13 |
| apps/api | 13 | 11 |
| apps/lp | 50 | 3 |
| apps/mcp-server | 3 | 1 |
| pda-test-ui | 2 | 2 |
| packages/shared | 37 | 5 |
| packages/db | 135 | 13 |

**296 non-test files** across these components were indexed for literal-sensitive-pattern search; keyword/flow sweeps were targeted subsets, not every pattern in every file. Test source was indexed separately where present, not run. Additional safe root/config metadata and literal-classification scans covered `docker-compose.yml`, `.woodpecker.yaml`, `.mcp.json`, `package.json`, `turbo.json`, app package manifests and web `vercel.json`; values were not printed. Templates beginning `.env` were excluded even if tracked/example. No broad historical scan was performed.

Core current-source reads: API index/auth/wallet-signature/me/billing/admin-portfolio/execution-settings/attribution/trading-control/billing-sweep; LP auth/index/routes; MCP index; web proxy/middleware/helpers/route-access plus targeted login/signup/vault/logs/admin-portfolio/layout/theme/wallet-provider ranges; selected DB users/credentials/auth-wallets/tenancy/client/grants/billing/admin-portfolio/perps/LP serializers; shared logger/RPC/credential helper/envelope/wrapper. Full exact requested ranges and file identities are in inventory, not silently summarized as full-module verification.

**Display truncation caveat:** some earlier combined reads exceeded visible output limits. Inventory now labels ranges as **requested**, not fully observed. Critical claim-specific gaps were reread in bounded chunks. A range in the JSON is not proof that every line was visually reviewed. Current claim citations identify reviewed evidence; other indexed files may have search-only or partial depth. In particular admin-portfolio DB, credential helper, wallets, LP DB tails, schema migrations and ancillary frontend pages are not complete-module reads. Prior reports are context only, and some were read via headings/finding summaries rather than complete documents.

**Integrity:** at 21:34:23Z, no indexed file differed from its per-file recorded hash and none was missing; HEAD unchanged; no tracked working-tree modification reported. This is source stability within the indexed interval, not an atomic whole-repository attestation. Writes by the local assessor were only this report and the three `threats/evidence/06-*` artifacts. Coordinator-owned standards evidence is separate.

**Explicit exclusions:** current `.env/.env.*`, real credentials, private-key/wallet/keypair files, secret directories, historical secret contents, git-object credential inspection, node_modules/dependency internals, lockfile/advisory audit, `.next`/dist/build/target/generated artifacts, symlinks, minified vendor bundles, network application targets, actual logs/responses, database contents/roles/schema, Redis contents, CDN/ingress/TLS/firewall state, browser runtime tests, contract/ML/worker-wide security audit. Root `CLAUDE.md` was absent; inherited `/home/xahmie/Documents/.claude/CLAUDE.md` is FHEVM-only and its activation conditions were not established for this web/API task.

**Coordinator acceptance check:** at 2026-11-06T21:48:00Z on CPU 0, all 608 indexed source/config/test files matched their recorded hashes, HEAD and tracked diff were unchanged, and 95 explicit citation occurrences and 12 index links passed structural checks. The register contains 8 Verified and 7 Likely findings under the convention above. The coordinator also reread the four High finding anchors, enrollment logging, insecure cookie forwarding and LP CORS. Built artifacts, actual response headers and deployment consequences remain outside this check.

**Bottom line:** source establishes several actionable authorization and data-propagation flaws, but does not establish a production leak, breach, credential validity, public deployment exposure, complete exploitability, or absence of secrets in built frontend artifacts.
