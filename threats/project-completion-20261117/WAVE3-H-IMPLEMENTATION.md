# Wave 3 H implementation submission — 2026-11-17

**H source frozen for independent review. Not tested, accepted or self-approved.**

Implementation began only after coordinator explicitly released E's slot. Scope is H-owned API routes/helpers/tests and web source/tests, plus the explicitly requested H report/config. E/F/G modules, barrels, root entrypoints, schemas, permissions and runner/registry were not edited. Inherited changes are preserved; this is not a clean checkout diff.

## Implemented joins

- `/root/SWAT/apps/api/src/routes/me.ts` joins optional `financial` and `custody` services. Its providerless root invocation remains unchanged and fail-closed. Compatibility OTP Map/email callbacks are never read by durable domain routes.
- `/root/SWAT/apps/api/src/routes/me-financial.ts` registers actual withdrawal request/confirm/status, reducing status and capability handlers. Injected F interfaces expose only `requestOtp/submit/status` and `request/status`; no provider effect/runner/sign/receipt-admission port is accepted by the API.
- Withdrawal request is strict `{requestKey,chain,network,assetId,assetScale,sourceWalletId,destination,amountRaw,maxFeeRaw,mode}`. Confirm is strict `{intentId,authorizationId,otp}` only. Network/amount/fee/unit values remain literal exact strings; F freshly checks trusted same-client network/mode/ownership/cooling/balance authority. Server policy supplies expiry/cooling. Body user IDs, expiry, receipt and authority fields refuse, not silently authorize.
- Spot exit `/v1/me/positions/:id/exit` and perps close `/v1/me/perps/positions/:id/close` invoke actual F reducing service when explicitly injected. Path supplies positionId, route supplies venue. Strict body carries exact account/network/asset/scale/mode/positionSide/quantityRaw/maxFeeRaw/limitPriceExact/expectedRevision/requestKey. F derives opposite order side and persists reservations/outbox; route never adjusts inventory or marks closed.
- Tenant-scoped status paths are `GET /v1/me/trading/withdraw/:intentId` and `GET /v1/me/reducing/:intentId`. Projection checks principal tenant and immutable digest, explicitly allowlists intent/status fields, and refuses contradictory settled progress. Public output omits internal user IDs, OTP/digest/proof/ciphertext/provider objects. Unknown/storage errors sanitize to unavailable, never success.
- `GET /v1/me/financial-capabilities` exposes configured **admission only**, separately from source/injected verification/runtime/live. `supported=false`, `injectedVerified=false`, `runtimeAccepted=false`, `liveAccepted=false` remain explicit. Configuration is not test acceptance or execution authority.
- Account/spot observations additionally retain `balanceNativeExact`, `confirmedQuantityExact`, and `costBasisUsdExact`; existing approximate valuation presentation remains observation-only. Perps exact DB strings retained.
- `/root/SWAT/apps/api/src/routes/me-custody.ts` registers `POST /v1/me/vault/enrollment` with strict account/kind/chain/consentId/expectedRevision DTO, no secret/signature/key material. An injected independent `withVerifiedConsent` callback must verify current linked ownership, exact single-use consent and actual deployed mechanism, hold/recheck through commit, and supply already-authorized enrollment input. Route pins principal, account/kind/chain, deployment/network/revision/consent/policy digest/freshness and executes actual E wrap-only enrollment inside callback. Route copies/zeros owned bytes and projects local-record status only, ignoring arbitrary callback return output. This interface does NOT implement or qualify an actual independent consent/deployment service.
- Providerless Solana/delegation grants still refuse. CLOB challenge and credential-acquisition endpoints now refuse before issuing signing data or reading/acquiring credentials, even when local-record enrollment ports exist. E generic enrollment is not CLOB enrollment or execution authority. Local revoke remains local only.

## Web changes

- `/root/SWAT/apps/web/lib/domain-transport.ts` uses existing session/CSRF `api` transport; exact raw requests and confirmation identifiers remain strings. It provides explicit admission capability observation and raw/decimal lossless conversion. Status notices distinguish awaiting/queued/prepared/uncertain/partial/settled and never equate HTTP success with close/transfer. Full settlement requires terminal evidence with exact target quantity in the recorded ledger, not a live acceptance claim.
- `/root/SWAT/apps/web/components/FinancialRequestPanel.tsx` supplies exact withdrawal/reduction forms and durable-status refresh for portfolio/vault. Stable per-intent keys survive request retries; admitted/uncertain/partial intents prevent starting a replacement intent in that mounted panel. Only assetScale is numeric. Local enrollment panel takes independently established consent/revision IDs, never opens a signing/credential flow. Capability gates are UI observations only; server revalidation remains authority.
- `/root/SWAT/apps/web/app/workspace/views/LpView.tsx` now reuses standalone discover/whales/builder/positions components, removing a second action/valuation implementation that omitted operation keys and falsely claimed deployment/queue completion.
- Standalone copy and whales share `/root/SWAT/apps/web/components/LpCopyPanel.tsx`. Removed hardcoded curated masters/PnL/win rates, 85% null substitution, forward-only/freshness/execution guarantees and submission-success-as-execution notices. Loading, failed, malformed and successfully empty observations are distinct; nullable economic values remain unassessed. Subscription close explicitly does not close acquired positions.
- Discover no longer reports null APR/TVL/volume as zero or advertises a verified live feed. Builder/LP actions retain existing G contracts, not assumed replacement-owner results. Paper-only notices and position guards retained; action keys persist on retry. Builder/copy inputs stay strings until existing numeric paper DTO boundary, where only positive safe whole units are accepted. Fractional/scientific/unsafe amounts refuse instead of silently losing precision. Exact raw/fractional LP acquisition contract remains unavailable pending G.
- All funding/CLOB signing/user-live guards remain unavailable by default. Genuine wallet ownership linking is unchanged and not execution authority.

## Deliberate limitations / required joins

1. **No aggregate financial close-all contract exists in final F services.** `/v1/me/positions/close-all` stays unavailable; no invented non-atomic loop or false aggregate close. Existing wallet subscription close-all is request/wind-down bookkeeping only, not financial completion.
2. Coordinator alone retains `/root/SWAT/apps/api/src/index.ts`. Its `registerMeRoutes(app,{backfillQueue,tokenDiscoveryQueue})` should remain providerless. Future authorized injected wiring uses optional `financial:{withdrawal,reducing}` and `custody:{enrollment,now,deploymentId,chainIds,withVerifiedConsent}`; cannot instantiate signing/provider flows merely from source readiness.
3. API runtime imports use exact API-safe `@swat/db/dist/withdrawal-contract.js` and `@swat/db/dist/custody-contract.js`; enrollment/service interfaces are type-only exact subpaths. **No db barrel changes requested and no executor unwrap barrel import.** Coordinator must emit current db declaration/artifacts through its approved bounded runner before dependent API typecheck/artifact integration. H config exact source aliases avoid stale dist at offline test time.
4. F runner imports its financial helpers through `@swat/db`; H test hoists a restricted pure-domain mock supplying those exports. Any production runner barrel joins remain coordinator/F responsibility, not H edits.
5. E generic local enrollment requires real independently approved linked-account/consent/deployment service, authenticated wrap identity/admission writer/tenant commit identity. The callback contract and inert test are not cryptographic deployment, consent persistence, remote-service isolation or TOCTOU proof.
6. G replacement owner has no accepted report. Existing LP route contracts retained. Actual valuation/economic receipt/copy plan joins, exact fractional LP units and runtime/live protocol adapters remain blocked; H UI does not invent them.
7. Browser/Next/native/runtime/live acceptance is not established. Component source joins/static checks are not browser evidence. Mounted UI keys are not cross-restart durable client identity; server exact-intent replay and uncertainty fence remain canonical.

## Literal offline manifest / import safety (not executed)

Requested config `/root/SWAT/threats/project-completion-20261117/w3-h.config.ts` selects exactly 13 existing literal files, no globs/filters:

1. `/root/SWAT/apps/api/src/routes/me.withdrawal.sequential.test.ts`
2. `/root/SWAT/apps/api/src/routes/me.grants.sequential.test.ts`
3. `/root/SWAT/apps/api/src/routes/me.authority.sequential.test.ts`
4. `/root/SWAT/apps/api/src/routes/me.portfolio.sequential.test.ts`
5. `/root/SWAT/apps/api/src/routes/package23-perps-close.sequential.test.ts`
6. `/root/SWAT/apps/api/src/routes/me.withdrawal.injected.sequential.test.ts`
7. `/root/SWAT/apps/api/src/routes/me.reducing.injected.sequential.test.ts`
8. `/root/SWAT/apps/api/src/routes/me.custody.injected.sequential.test.ts`
9. `/root/SWAT/apps/web/lib/portfolio-model.sequential.test.ts`
10. `/root/SWAT/apps/web/lib/transport.sequential.test.ts`
11. `/root/SWAT/apps/web/lib/api-error-message.test.ts`
12. `/root/SWAT/apps/web/lib/wallets.sequential.test.ts`
13. `/root/SWAT/apps/web/lib/domain-transport.sequential.test.ts`

Static import review:

- Retained route suites hoist db/shared/viem boundary mocks; pure validation imports only. Actual Fastify handlers use `inject` without listen/service startup and are closed after tests. New F route suites use actual factories, stateless SQL repository and F serialized rollback transcript fixture; no PG/RLS/trigger/runtime evidence claimed. OTP is deterministic inert test data, not API Map authority or real OTP/credential generation.
- Reducing test drives actual registered `registerMeRoutes`, actual F admission, actual F durable financial runner with inert authorize/submit/reconcile/verify/account ports, and status observations after uncertain/partial/final admitted fixture receipts. No SDK, keys, signing or external effects; F runner imports are replaced by restricted pure domain exports. Approved exact aliases map only named keyless domain modules, before the inherited broad DB alias.
- Custody suite uses actual E `createCustodyEnrollment` and inert wrap/store under injected consent callback; wrap returns constructed inert bytes, not encryption/keygen. Tests cover linked context tenant/account/consent/revision/network/deployment/expiry/policy denial, keyless secret-free behavior, default refusal, no public key material, zeroing and sanitized provider failure. No execution unwrap/credentials/shared wrapper module imported.
- Web tests call actual `api` with stubbed global fetch/Response; cannot reach real network. Pure model/error/target/access tests use no DOM/server startup. Transport suite reads/imports Next config only to inspect rewrite/header values, not run Next. Wallet test stubs Solana PublicKey. Static page tests read existing local TSX as text; do not import AppKit wallet runtime or render browser.
- Harness `/root/SWAT/threats/sequential-fixes/package12-29-harness.ts`, setup `/root/SWAT/threats/sequential-fixes/test-safety.ts`, and node guard `/root/SWAT/threats/sequential-fixes/offline-guard.cjs` unchanged. CPU0 shared `/tmp/swat-package11-checks.lock`, tests512MB/onefork and compiler640MB remain coordinator-run only after global freeze/import review/hash registration.

Planned assertions cover actual handlers: no providerless OTP/credential work, authenticated tenant scope, exact raw/fee/network/unit/price, immutable replay substitutions, fresh cooling/balance/ownership/mode/expiry, one-use consume/reserve/outbox same-client rollback, wrong OTP/authorization, no false close, uncertain runner retry/reconciliation-only, partial/full receipt status and truthful web capability/state/economics. No assertion counts collected or claimed.

## Actual actions / retained failures

**No tests, compiler, emit, Next/browser, service, network, migrations, credential operations, signing/keygen, installs, commit/push or publication executed.** Actual inspection used Read/find/ls/wc/grep/git status/scoped diff/scoped diff --check/sha256sum and dedicated Edit/Write. Earlier prep `rg` command was unavailable; fallback grep used. One attempted missing `/root/SWAT/apps/trade-executor/src/withdrawal-execution.ts` read returned absent; actual F module is `reducing-orchestration.ts`. A few Edit calls failed exact-match/uniqueness checks and made no changes; supported replacements applied subsequently. Final scoped diff --check emitted no whitespace findings; not compile/test acceptance. Full git diff contains inherited changes outside H actions.

Freeze → coordinator global source freeze → literal import/hash approval → bounded checks → independent route/web read-only review → supported repairs/reruns → coordinator raw evidence acceptance. No self-approval or runtime advancement.

## H-changed source/config SHA256

```text
4eae050d13003d3a8ef79a219289ae567449f7e0c49cfce5e7625f27c10e2d8a  /root/SWAT/apps/api/src/routes/me.ts
e9239f7e60c972c7c751c6eb15e6a01a5357c83e7aa13b704d3bb8a3c20db5a0  /root/SWAT/apps/api/src/routes/me-financial.ts
0aaaa42bed0a9bc4ab5a2094e51a8b347493f9b2dbe8fe4c922c481fd30fa932  /root/SWAT/apps/api/src/routes/me-custody.ts
96b235f15c80594747a89baf1390a53f07a5cff0626a99f85335b6553211578b  /root/SWAT/apps/api/src/routes/me.authority.sequential.test.ts
5e4cf7e346b80002e77c8a4945e1709494b9f338cd6bf8ef5db090215c93b1d8  /root/SWAT/apps/api/src/routes/me.withdrawal.injected.sequential.test.ts
d79614705db83489b89d8e79af7fd661f124c17c9bd2f1939bbf5b49057bb9fd  /root/SWAT/apps/api/src/routes/me.reducing.injected.sequential.test.ts
5f7f51944367603017c2c3fb9ef5c6c6c1771fcadb87926bb106c890c90cb52e  /root/SWAT/apps/api/src/routes/me.custody.injected.sequential.test.ts
18095a8dd47679bfb843effa50ccdcbbbc0f4fc715148ea875553f8f1cc62c18  /root/SWAT/apps/web/lib/domain-transport.ts
4cb22ad592e3dbe453a21e4b213ce1cbc7b59a19864fa0b4c4bd9ba7d24551db  /root/SWAT/apps/web/lib/domain-transport.sequential.test.ts
2b3123c06f799f98fafdb897cf7c2af17cd3f39361c00177458d9b4313d33eb3  /root/SWAT/apps/web/lib/portfolio-model.ts
138e59085420ab22516391593c60b5deb7e572c20b0bc434017fa9dd2ba46dfc  /root/SWAT/apps/web/components/FinancialRequestPanel.tsx
b2b709048c14221925c86b7ac88b84629512997287c7040172567a404d94e8f4  /root/SWAT/apps/web/components/LpCopyPanel.tsx
bedeeb9976928c5e66449eb011ac72d566562837127c15a5bcef07c55971ec63  /root/SWAT/apps/web/app/positions/page.tsx
942f2f58e8780ba9687b39c1d577141288f3136d7cfa645a0809e9aa3094e799  /root/SWAT/apps/web/app/vault/page.tsx
fa0c4ef56d06e8b48e1e10277eb3695a63cb42e3342b1c46c122d3bfbfa66eea  /root/SWAT/apps/web/app/lp/builder/page.tsx
e896d2b3cc58ed465c62cc2a155effeaf81032ad54f0ad590bdfcbd4c3adc839  /root/SWAT/apps/web/app/lp/positions/page.tsx
a0c72ba073e1ce07248822867a54a5bab59653ea8280585614dead7d45026259  /root/SWAT/apps/web/app/lp/copy/page.tsx
02eee00b3057302f06a2ea224f49c058e27a16b4b922fcf29536e06e3cd935d3  /root/SWAT/apps/web/app/lp/whales/page.tsx
04430e563046f6a18ffaedb1c945c9ef87aa60e9b9054cb13b498662018c966a  /root/SWAT/apps/web/app/lp/discover/page.tsx
63d8aa042e3e06955e2626b29d7a56264cd4987aa2565cfa17401af00772e084  /root/SWAT/apps/web/app/workspace/views/LpView.tsx
41ffa463b4d9ad806749c8f90cde46dd1ad9c97702dd396661ac535ec10e5c79  /root/SWAT/threats/project-completion-20261117/w3-h.config.ts
```

## Read-only dependent source fingerprints at H freeze

```text
36ac59461ffebffc0aee5d1cc2306bf6bf41b21ed10025b91084ee9fe0caa64b  /root/SWAT/packages/db/src/custody-enrollment.ts
1b8a8520e42c90d6b3e7b65329b37f40ce0bc8de736bacf96f8c4ec55dbbf619  /root/SWAT/packages/db/src/custody-contract.ts
89c1c1f2092e003d745ca31c306334ad78a35469db88580f3deeba7b3db092e0  /root/SWAT/packages/db/src/withdrawal-contract.ts
c3f9ac7856cd44cf721f71d1a92da1f887f7314db81301e14853ba3b6ec6d547  /root/SWAT/packages/db/src/withdrawal-service.ts
4ec56a306d108a5e0ce8d3166957ae0c3732cecad688f8110291c829de19a684  /root/SWAT/packages/db/src/withdrawal-store.ts
8b4c7ba7aee699a92364eb9fd813f222db54e83fe0a3eaab0dc2c96ca761c936  /root/SWAT/packages/db/src/withdrawal-test-fixture.ts
9cabaca8469e9455966bdc296ebc620c3df246843cdf1c2a3ae33b7427c03667  /root/SWAT/packages/db/src/reducing-contract.ts
0d3981be791f8ece924450df0379466ec8cb72055341bf82b294690b4bfdbe85  /root/SWAT/packages/db/src/reducing-service.ts
1673ac1dbcffd77cd4d3bdd0d12ca9965bac7424c35f07d6ec701654b2ea2274  /root/SWAT/apps/trade-executor/src/reducing-orchestration.ts
```

Any later dependency repair invalidates affected integration evidence. This explicitly requested report is an additional H-created path; its hash is sent separately rather than embedded self-referentially.
