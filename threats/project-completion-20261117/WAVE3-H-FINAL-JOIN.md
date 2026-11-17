# Wave 3 H final DTO join — source submission only

Date: 2026-11-17. Workspace: `/root/SWAT`. **H implementation submission, not independent review, test acceptance, browser acceptance or live capability.** Read `/root/SWAT/threats/project-completion-20261117/WAVE3-RESUME.md`, the G DTO handoff at lines21–32 in `/root/SWAT/threats/project-completion-20261117/WAVE3-G-IMPLEMENTATION.md`, current F contracts/services/fixture and the narrow F recheck2. G still describes its submission as independently unreviewed. Joining the current source is not accepting F/G or overriding coordinator gates.

## Work and safety boundary

Work was sequential, with no agents/background tasks. Only H-owned API/web implementation/test files, H literal config and this requested report were changed. Initial E/F/G/SQL/config/evidence dirtiness was preserved. No DB/shared/LP implementation, barrel, migration proposal, coordinator/global runner, existing reports, production schema or package metadata was edited.

No tests, typechecks, compiler/emits, network, services, browser, SQL, installs, secrets/credential access, signing, key generation, provider activation or git writes were performed. Read-only git status/diff/whitespace inspection, source searches and SHA-256 calculations are the only verification here. Scoped whitespace inspection returned no diagnostics; that is not correctness or execution evidence. No pass counts are claimed.

## Final financial join

- `/root/SWAT/apps/api/src/routes/me-financial.ts` now requires `feeAssetId`, `feeAssetScale`, `feeFundingAccountId` with `maxFeeRaw` in both strict request schemas, including zero-fee intents. Fee scale is independently bounded0..36; amount/quantity/fee remain canonical raw strings. Public tenant/provider/receipt/economic/collateral fields remain excluded. Independent collateral mapping belongs to F trusted ports, never this body.
- Allowlisted financial projection preserves distinct fee identity/scale/funding, validates owned immutable digest and the projected request shape, bounds completed quantity against exact maximum, exposes `cancelled` and nullable `cancellationReason`, and refuses contradictory cancellation/progress. Cancellation requires terminal zero effect plus a nonempty audited reason, not elapsed time alone. Storage/provider/private fields are not serialized.
- `/root/SWAT/apps/api/src/routes/me.ts` retains existing spot/perps request seams and default unavailable behavior; documents injected admission/status-only ownership. It imports no new runner/signing/receipt-admission port. Close-all remains blocked.
- `/root/SWAT/apps/web/lib/domain-transport.ts` and `/root/SWAT/apps/web/components/FinancialRequestPanel.tsx` join fee fields, explicit fee metadata display and audited cancellation notice. `/root/SWAT/apps/web/lib/financial-request-state.ts` rejects unbound/contradictory cancellation instead of releasing its fence.
- Existing account-partitioned localStorage intent/key fence remains write-before-dispatch. Unknown admission/confirmation cannot be replaced; retry uses the original stored JSON/key. A later schema400 cannot erase earlier ambiguity. Old persisted intents missing new fee fields are deliberately **not repaired, relabelled or rekeyed**; they may remain refused/unresolved and need independent reconciliation. Same-mounted-panel dispatch locks prevent duplicate clicks from changing the local operation. Capability refresh is not a prerequisite for retry/reconciliation of an already pinned request; the server still independently refuses unavailable authority. OTP is not persisted.

## Exact LP join

The existing `/root/SWAT/apps/web/next.config.ts` LP-first `/v1/lp/:path*` rewrite already routes all exact paths to the LP tenant-auth boundary; ordering is retained and its transport-only scope documented. No G route implementation was changed, and no provider is configured by a rewrite.

`/root/SWAT/apps/web/lib/domain-transport.ts` uses **type-only** explicit `@swat/db/dist/lp-exact.js` imports/re-exports; no LP service/store/DB runtime import enters the web client. Its LP client uses the same session/CSRF transport with these exact paths:

| Method | Path | Public input |
| --- | --- | --- |
| POST | `/v1/lp/positions/deploy-exact` | `operationKey,chain,poolAddress,depositAsset,deposit:{raw,scale},strategy:{distribution,rangeLower,rangeUpper,rungCount},autoRebalance?` |
| GET | `/v1/lp/positions/:positionId/exact` | Encoded position identifier; current state, not acquisition replay |
| POST | `/v1/lp/positions/:positionId/rebalance` or `/close` | Exactly `{operationKey}` |
| GET | `/v1/lp/operations/:operationId` | Encoded operation identifier |
| POST | `/v1/lp/copy/mint-exact` | Exactly `{subscriptionId,eventId,assetScale}` |
| GET | `/v1/lp/capabilities` | No economic/authority input |

Acquisition/nested strategy/rawscale, operation and copy inputs reject unexpected fields locally; server strict validation remains authoritative. No public receipt submission, quote, provider, risk approval, copy origin, tenant or economics input is introduced. Unknown economics is not filled with zero. Raw quantities, revisions and microdollars never pass through Number/parseFloat. Exact formatting uses strings; negative signed realized/net-style values are supported without negative-zero/exponent aliases. Scale, rung count and geometric price controls remain numeric metadata, not monetary authority.

`/root/SWAT/apps/web/lib/lp-request-state.ts` is a new pure injected-storage state machine, necessary to persist acquisition, operation and copy ambiguity across reloads. It validates fresh drafts before persistence, snapshots immutable input before dispatch, reloads dispatch as unknown, and refuses fresh/replacement commands until a bound observed resolution. Every request failure/denial after persistence conservatively retains the same payload/key; copy identity is the immutable subscription/event/scale tuple. It binds response tenant/action/key/position/quantity and observes pending versus completed operations with receipt identity/rawscale/quote-pool bindings. This is response consistency checking, **not cryptographic receipt verification or provider authentication**.

`FinancialRequestPanel` now dispatches to the financial or exact-LP controls without conditional hooks in the same component. Exact controls:

- Builder: canonical deposit raw string, explicit asset and scale, resolved strategy, opt-in autoRebalance false by default. No legacy numeric acquisition/custom-union request or fingerprint-triggered replacement key remains. Changed builder drafts never replace a persisted unresolved request.
- Positions: separate exact current-position lookup, explicit rebalance/close admission, durable operation observation and current read. Initial immutable acquisition responses are not presented as current state; the UI separately fetches current exact state. Pending close never means zero/closed inventory. Failed current reads clear their observation instead of falling back to acquisition snapshots.
- Copy: shared `/root/SWAT/apps/web/components/LpCopyPanel.tsx` includes exact mint identifiers/scale and the same persistent fence, shared by inherited copy/whales/workspace views. Existing subscription create/pause/close controls remain local record controls; safe-whole legacy USD budget creation is not falsely upgraded to fractional exact budgeting.
- `/root/SWAT/apps/web/lib/portfolio-model.ts` now universally denies mutations from `LpPositionView`, including historical paper labels. `/root/SWAT/apps/web/app/lp/positions/page.tsx` explicitly labels the numeric list observation-only and submits no post/patch from it. No raw quantity is synthesized from numeric list amounts.

Capability language retains source implemented versus ports present versus runtime/live accepted distinctions. Protocol-port presence only gates fresh paper admission UI; it is not full copy master/risk availability, deployed authority or runtime acceptance. Current defaults remain unavailable. Unsupported Raydium is labelled unavailable rather than a Meteora alias. Exact operations cannot activate live mode.

## Authored regressions, not executed

Updated inherited H tests for finalized required funding ports, separately named fee metadata, receipt fee binding, immutable fee replay conflicts and cancellation projection. Reducing route fixture now explicitly supplies inert independent mapping/funding/authorization evidence and same-transaction fixture journal required by final F; no real provider/mapping/journal qualification follows. Added actual registered status observation of audited no-attempt cancellation without exposure change. Preserved inherited grant/sealed-private exclusions and no-default-port tests without weakening them.

New focused `/root/SWAT/apps/web/lib/lp-request-state.sequential.test.ts` covers actual session LP client JSON/paths with stubbed fetch, unexpected public authority inputs, large fractional rawscale/signed microdollar formatting, persisted unknown acquisition/operation/copy retries across reload, storage-write/draft refusal, mutable-draft separation, initial-vs-current acquisition binding, pending close refusal and completed bound zero inventory observation. Existing financial state tests cover fee substitution, invalid cancellation and legacy unknown-then-schema400 behavior. Existing portfolio source assertions now expect exact builder controls and deny legacy action capability. Source assertions are not rendered UI tests.

## Literal selection and import inventory

`/root/SWAT/threats/project-completion-20261117/w3-h.config.ts` selects **16 literal existing test files**, retaining all15 inherited selections and adding the focused LP test. No broad glob/service/integration filename selection. Existing exact F/E subpath aliases precede inherited broad DB/shared aliases. LP types are erased at runtime, so no LP runtime alias/import was introduced. The config was not loaded; its inherited runner-environment/manifest guard, one fork/one worker/no file parallelism and blocking setup remain unchanged.

| Selected absolute path | Source-bounded import/isolation inventory |
| --- | --- |
| `/root/SWAT/apps/api/src/routes/me.withdrawal.sequential.test.ts` | Hoisted DB/shared mocks; me/auth/financial/custody route modules; Fastify inject/ready/close within tests, no listen. No default withdrawal service activation. |
| `/root/SWAT/apps/api/src/routes/me.grants.sequential.test.ts` | DB/shared and viem/chains mocks; direct shared billing constants; me route. Historical grant/public projection only. |
| `/root/SWAT/apps/api/src/routes/me.authority.sequential.test.ts` | Same mocked route boundary; private-marker and unsupported-authority regressions retained. |
| `/root/SWAT/apps/api/src/routes/me.portfolio.sequential.test.ts` | Hoisted DB/shared mocks; me/auth/financial/custody route graph; scopedQuery fake results. Not PG/RLS evidence. |
| `/root/SWAT/apps/api/src/routes/package23-perps-close.sequential.test.ts` | Hoisted DB/shared mocks; me route; no live perps client startup. Injected Fastify only. |
| `/root/SWAT/apps/api/src/routes/me.withdrawal.injected.sequential.test.ts` | Mocked DB auth barrel; explicit withdrawal contract/store/service/test-fixture subpaths. Keyless node:crypto and in-memory fake SQL client/transaction; OTP literal fixture, no secret generation or mail provider. |
| `/root/SWAT/apps/api/src/routes/me.reducing.injected.sequential.test.ts` | Mocked DB/shared me imports; explicit reducing/withdrawal modules + direct executor reducing-orchestration library. Inert F fixture mapping/funding/authorization/receipt/journal only; no executor index/queue/worker import. |
| `/root/SWAT/apps/api/src/routes/me.custody.injected.sequential.test.ts` | Mocked DB auth barrel; me-custody + pure contract/enrollment library, type-only execution-grants/tenancy imports; injected memory record/sealer behavior. No KMS or credential acquisition. |
| `/root/SWAT/apps/web/lib/portfolio-model.sequential.test.ts` | API/backend target, presentation/guard functions, node:fs source reads; no React/page import/startup. |
| `/root/SWAT/apps/web/lib/transport.sequential.test.ts` | Pure API/backend-target/route-access; imports Next config only in test for rewrite comparison. Config resolves/validates internal URLs but does not contact them. No fetch/listen/network activation. |
| `/root/SWAT/apps/web/lib/api-error-message.test.ts` | API/backend target and error formatting only; no dispatch at module import. |
| `/root/SWAT/apps/web/lib/wallets.sequential.test.ts` | Wallet helper/API; hoisted PublicKey mock; unsupported delegation rejects before signing/request. Wallet module is not blanket-certified safe for arbitrary other functions. |
| `/root/SWAT/apps/web/lib/domain-transport.sequential.test.ts` | API/backend target/domain transport + presentation model; fetch explicitly stubbed, node:fs source checks. LP types erased, no DB runtime. |
| `/root/SWAT/apps/web/lib/financial-request-state.sequential.test.ts` | Pure storage-injected state machine, API error class; financial response imports type-only. No browser/localStorage access by module. |
| `/root/SWAT/apps/web/lib/lp-observation.sequential.test.ts` | Pure observation/link/geometry/presentation functions, injected async observations. No scanners/providers. |
| `/root/SWAT/apps/web/lib/lp-request-state.sequential.test.ts` | Pure LP state/domain/API libraries, type-only LP DTO import; stubbed fetch and injected storage; node:fs reads actual UI/proxy source without importing React/pages. No LP service/store/client import. |

Import caveats: me/auth runtime DB barrel imports are **mocked, not inherently safe**. Shared/third-party Fastify, cookie, zod, viem and Solana package resolution remain coordinator import-review obligations. The inherited safety setup blocks pg query/connect and Redis construction but is not a complete network sandbox. Application `index.ts` entrypoints, DB barrel unmocked imports, LP service entry/store tenancy graph, wallet signers/providers and middleware role fetch are not selected/imported by the new test. No all-transitive import execution certification is claimed. New web type subpath declarations/exports must be qualified by the coordinator without changing barrels here.

## Limitations and next gate

- No tests, typecheck or UI/browser execution: current compilation/test correctness is unverified. Requested offline validation awaits independent affected review, final source freeze, import/hash registration and coordinator guarded runner. Existing Wave1/2 acceptance does not cover these sources.
- Default financial/LP trusted domain ports are absent. No durable provider identity, external custody/mapping/master/risk/quote/receipt source, signing/broadcast, external settlement, live mode or service was activated.
- Schemas081/082/083 remain unapplied/unintegrated by this task. Real PG/RLS/privilege/concurrency/crash atomicity, queue recovery and durable receipt settlement remain unqualified.
- Exact aggregate position list and exact fractional subscription-budget creation remain unavailable in G. Exact current positions require an identifier; legacy enumeration does not become exact. Legacy leaderboard/budgets/history stay numeric observations only.
- Current autoRebalance consent is observed but mutation from exact UI remains unavailable: the inherited G toggle is a legacy record route, not a finalized exact consent/revision DTO. Initial consent is part of immutable exact acquisition.
- Browser localStorage is a client accident-prevention fence, not trusted execution authority. Browser/cross-tab/multi-device/account-switch races and durable recovery beyond that store are not qualified. Deleting/tampering with client storage cannot be declared harmless; server immutable-key/receipt invariants still require independent runtime validation. Same-mounted-panel click locks do not solve cross-tab coordination.
- An unknown pre-final-fee financial request or unavailable current exact read may remain blocked indefinitely; no new key, synthetic zero, success toast or fabricated provider authority is used to escape it. Reconciliation/recovery requires the independent domain boundary.
- Receipt observations are server response consistency checks; no public receipt/economic submission or external-verifier authentication is implemented here. Queued/pending status is not financial completion or closed exposure; paper receipt/accounting status is not live acceptance. Fees/net forecasts do not establish realized profit or custody/withdrawal settlement.
- G independent review is still pending; this report neither impersonates that review nor claims full-H/Wave3 acceptance.

## SHA-256 manifest

Hashes cover current H source/config, all literal selected tests and read-only contextual/import dependencies at final source inspection. This report's own hash is returned separately to avoid self-reference. Dependency changes invalidate the associated review assumptions. Not an emitted-artifact/runtime manifest.

### H implementation/config

```text
9210b7ed2c844d8aaffc0a21cf71ca4f6f6e05887b74643abd8e2c526d082dfd  /root/SWAT/apps/api/src/routes/me-financial.ts
5edcdb2f21a105aa3d876cc3e4e87277277f22eae83101e98b6ade3daf43e72c  /root/SWAT/apps/api/src/routes/me.ts
c9c2a603da9e2e00bd05b23556063a0e463a0c4fc8e1b55d39ea8bf08fc804ad  /root/SWAT/apps/web/lib/domain-transport.ts
fe4a8b9cf6cf02dff5ceae555faa61dd3332c785ff0c242f41c053cb23f2c686  /root/SWAT/apps/web/lib/financial-request-state.ts
2abba1609a36efe494bbe39dcb0604085403f9f8d7caf65425b66eb4bace9bf9  /root/SWAT/apps/web/lib/lp-request-state.ts
e99710695fc2a9278e985a2e6bdb5ceb2c61897f89f1f9bce312cb9fb10e80b6  /root/SWAT/apps/web/lib/portfolio-model.ts
e478e3d3e5fca1024e9fa45d7f79422afd731687b79d05972bb4500746925a32  /root/SWAT/apps/web/components/FinancialRequestPanel.tsx
4f7a6d1573be37067fc4a621a28e3fdc5a5f098401959608827f5980a67bbeb7  /root/SWAT/apps/web/components/LpCopyPanel.tsx
6bfdd3ce35cfad90468fa7f385bf2e68684498791746b8c83f5243a46fe3c435  /root/SWAT/apps/web/app/lp/builder/page.tsx
883b6ae36c9305f3d6f3a1e6956648870548d03fe11c527312c046f0f611aa38  /root/SWAT/apps/web/app/lp/positions/page.tsx
eb811a6bdc2c242329d4f17e1d0dec72ec7a31e4f1089e95bf8e1e517a8705f1  /root/SWAT/apps/web/next.config.ts
1caf7fa58be55bf4923b3ca4e50219b331af240fec6caea0c6f134b1017313a1  /root/SWAT/threats/project-completion-20261117/w3-h.config.ts
```

### Literal tests (in config order)

```text
17ee67e94f3d2682f12f8d8b6bf552d024199742c0879781980320f394858e0d  /root/SWAT/apps/api/src/routes/me.withdrawal.sequential.test.ts
abee34303c583886b6a6d5adc25e3fdc24c8600fa4f715e78337a9031f812328  /root/SWAT/apps/api/src/routes/me.grants.sequential.test.ts
07f7b96be39cf03375cee24de791a03054082dfdda351505f38907f75057d1d1  /root/SWAT/apps/api/src/routes/me.authority.sequential.test.ts
56e52bf48109091e786b7fad8885374905bdc87cfbb09c2bd21420e7cea2234a  /root/SWAT/apps/api/src/routes/me.portfolio.sequential.test.ts
da12f964aaf19fed0be8a7ddf9e05203088ee9d6871ada78f1bbdf1cb6de5f59  /root/SWAT/apps/api/src/routes/package23-perps-close.sequential.test.ts
bcc4909680e7a9d8957262a21c561029509b53fa7fa79ef96d477a44a2dd236e  /root/SWAT/apps/api/src/routes/me.withdrawal.injected.sequential.test.ts
1b25830fcfc6dc2893e26cb09f83dd1ff718e1dd136b57d040bd084c1953ec79  /root/SWAT/apps/api/src/routes/me.reducing.injected.sequential.test.ts
5f7f51944367603017c2c3fb9ef5c6c6c1771fcadb87926bb106c890c90cb52e  /root/SWAT/apps/api/src/routes/me.custody.injected.sequential.test.ts
3940e20e6479a1a5b57c22d40d1237ad0df82cf07756befe9663f610e174a970  /root/SWAT/apps/web/lib/portfolio-model.sequential.test.ts
cd69444e9a60c30cd44d596cf4c3703f8d4a9c96d6686f0fde66fb69022b7edd  /root/SWAT/apps/web/lib/transport.sequential.test.ts
c98c707d66b06f99426b1db2f2d9de15377360ec9f167c485cd773cdadc4c38b  /root/SWAT/apps/web/lib/api-error-message.test.ts
b3e61301addfe6cc3a9f0ef80b20ad6ee9147145a059211304ab7c5c9b5e11e1  /root/SWAT/apps/web/lib/wallets.sequential.test.ts
41ef13b131d681d498bc63c7ae75a65188d04dc35319d93149ab110f320b7688  /root/SWAT/apps/web/lib/domain-transport.sequential.test.ts
0fa9b53ecb0bf4f97446db2458deb03e26a49e7db0802e8ba04f68de31869bb7  /root/SWAT/apps/web/lib/financial-request-state.sequential.test.ts
cf1658e41e8449b18baaa7b3dcfef5dd64ed4dfec507f3a637d8a06bb1511e9f  /root/SWAT/apps/web/lib/lp-observation.sequential.test.ts
ab2577539f926d9afcc2d505ec0cd09630ae490eff106f11f60fcdc39998024f  /root/SWAT/apps/web/lib/lp-request-state.sequential.test.ts
```

### Read-only dependency/context pins

```text
d74d2a8636f397386ee16a4eb3962a2e2071bc491a4264c865787aec6bf5f7c7  /root/SWAT/packages/db/src/withdrawal-contract.ts
6fdfcf19aa4499960f6c2c409784a0ad63901db64affee937c94e605533156b0  /root/SWAT/packages/db/src/withdrawal-store.ts
3e0b0ca150f5e465b3650d78b21b17f306ec5ccf4fab7035fe9fbc24832d70f1  /root/SWAT/packages/db/src/withdrawal-service.ts
762d1de6f301bca6d659c4d5369680b3af7b2680294d0f1b73264cf382b9b2c6  /root/SWAT/packages/db/src/withdrawal-test-fixture.ts
56ce23e7630e05c0389333210037838f89229592071724f25906e243851f4bd2  /root/SWAT/packages/db/src/reducing-contract.ts
475e590bfe0a14e03eba8c0405de633988a8c0d8bfabd045f738baaf4ad9c796  /root/SWAT/packages/db/src/reducing-service.ts
65505092e02f1202eed458c8216814cc61df4ede4e0ad57c6ec22f79e2519cd4  /root/SWAT/packages/db/src/lp-exact.ts
267db517d2e03a3e4e9270a82497766cfbc5318bea445b2e2e943b412c4670f3  /root/SWAT/packages/db/src/lp-paper-service.ts
124aed2e2ddb013948530a7f4c930019b29d4efb05aac8922fa26ecfdec3a35a  /root/SWAT/packages/db/src/custody-contract.ts
36ac59461ffebffc0aee5d1cc2306bf6bf41b21ed10025b91084ee9fe0caa64b  /root/SWAT/packages/db/src/custody-enrollment.ts
0aaaa42bed0a9bc4ab5a2094e51a8b347493f9b2dbe8fe4c922c481fd30fa932  /root/SWAT/apps/api/src/routes/me-custody.ts
45a4bc18420d66f6215a60720d08c99fbd8eac05997723ed1c2b049a8ef72c25  /root/SWAT/apps/api/src/auth/plugin.ts
29d9e9dfcc032d7927217d8542b963860cccd8b8f3e1b613d9dbb2fd60623c1b  /root/SWAT/apps/trade-executor/src/reducing-orchestration.ts
31364e1c8e4fd2f878be2333e52a28dc9b17648cb24e690c0a06b00b28050cb3  /root/SWAT/apps/web/lib/api.ts
f4eef9fad0c6d8bfa4f66fcb95386cb15070f9b8fc90332c8d0b88aa099ec341  /root/SWAT/apps/web/lib/backend-target.ts
3fbd032892766a169293ee3da69c5e1cb05ddb980c5883f30c85bbd0e0401c2d  /root/SWAT/threats/sequential-fixes/package12-29-harness.ts
8d50902d887ac313a06ebde73d5a39b977fc4067303e5b5fd654b5077e873930  /root/SWAT/threats/sequential-fixes/test-safety.ts
dbfeb0f24521aa42932647b157eda3e55544ebbe878c2ef7cb317aa45af807b0  /root/SWAT/threats/project-completion-20261117/WAVE3-RESUME.md
3cb324f975321c1bbfb927559e03b5d061aefa9f7d98548f4b596c10415ea1a8  /root/SWAT/threats/project-completion-20261117/WAVE3-G-IMPLEMENTATION.md
b487bbf94a1c540c85ea5a30f9600bc4a86d0dcbbc4004ade5421ddc90d12ea5  /root/SWAT/threats/project-completion-20261117/WAVE3-F-RECHECK2.md
```
