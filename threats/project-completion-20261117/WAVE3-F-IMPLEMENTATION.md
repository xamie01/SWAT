# Wave3 F implementation submission — frozen source, not accepted

Owner F, 2026-11-17. Read WORK-MAP.md, STAGE-LEDGER.json, AGENT-ROSTER.md, BASELINE.json, WAVE3-CONTRACTS.md and WAVE2-ACCEPTANCE.md before editing. Wave1 remains sealed; Wave2 source/injected acceptance is not expanded. Existing unrelated changes preserved. No self-approval.

## Scope and implementation

- Exact immutable withdrawal intent binds principal-derived tenant, chain AND network identity, asset/scale, source custody wallet, canonical destination, raw amount, raw fee ceiling, mode, request key and server expiry. Canonical hash key sorting survives PostgreSQL jsonb ordering; persisted projections recheck hash/tenant/kind binding.
- One-use keyed OTP port issues digest, never stores code. Intent/authorization commit before delivery. Pending/failed/unknown delivery never permits consumption. Retry never reissues/resends code; use a new request key after delivery uncertainty. Five wrong-code failures commit durably rather than rollback with thrown error. Successful consume, exact asset budget reservation and outbox are one same-client transaction. Exact consumed retry returns prior operation without second consume/reservation/outbox.
- Trusted same-client eligibility ports must lock custody ownership, linked destination verification, current mode and authoritative balance/exposure. Default cooling-off is 24 hours and cannot be configured lower. Eligibility runs on admission and immediately before effect; database statement time is refreshed after lock waits. Outstanding reservations include withdrawal fee ceiling. Cache balance rows alone are explicitly not authority.
- Durable outbox, one immutable attempt and fixed clientOrderId/fence precede effect. Write-ahead uncertain fence commits before submission. Every existing attempt, including crash-left prepared, is reconciliation-only; no expiry/lease authorizes a second submit. This intentionally sacrifices automatic recovery of an unsent prepared attempt rather than risking duplicates. Independent final absent/rejected receipt ends an attempt; a new exact intent is required for a further user request.
- Spot and perps reducing intents derive SELL for LONG, BUY for SHORT. Spot short refused. Exact integer math rejects increasing direction, insufficient exposure and cross-zero; account/asset budget shared across requests. Provider adapter requires atomic venue reduceOnly and fresh scoped exposure, uses fixed clientOrderId and IOC, no opening-margin veto/TP/SL/leverage path.
- Authenticated cumulative receipts validate intent/attempt/clientOrderId, nonregression, amount and fee ceilings. Independent receipt-writer admission is reselected by receipt hash before accounting. Partial and final quantity/fee deltas are applied once; terminal partial remains partial, not fully settled. Unknown submission never marks closed. Canonical accounting failure rolls back ledger/application and leaves uncertainty.
- Perps accounting adapter invokes a restricted SQL receipt function joining the actual tenant-owned position, preserving side and decrementing exact size. Zero-size closure follows actual admitted receipt accounting, never admission. Deferred constraints require position journal and receipt application in the same commit. Fee/realized-PnL accounting with nonzero fee delta remains unavailable rather than invented.
- Legacy closePerpsPosition still returns false for nonowned/nonopen and throws PerpsCloseUnavailableError for unwired financial close. Legacy decideManualExit remains a pure catalogue/race decision with its previous fail-closed behavior. New durable functions are explicit injected paths; they return operations, not closure booleans.

## Exact public route contract for H (sole me.ts integrator)

Production exports required from coordinator-owned DB barrel: withdrawal-contract.ts, withdrawal-store.ts, withdrawal-service.ts, reducing-contract.ts, reducing-service.ts. Existing perps export must include new functions. No test fixture public barrel export.

`createWithdrawalService(WithdrawalServicePorts)` returns:

- `requestOtp(userId: string, request: WithdrawalRequest): Promise<WithdrawalAuthorizationProjection>`
- `submit(userId: string, input: SubmitWithdrawal): Promise<FinancialRecord<WithdrawalIntent>>`
- `status(userId: string, intentId: string): Promise<FinancialRecord<WithdrawalIntent> | null>`
- `capability`, plus trusted internal `revalidate(client, record, now, reserve)`.

WithdrawalRequest exact body fields: `requestKey, chain, network, assetId, assetScale, sourceWalletId, destination, amountRaw, maxFeeRaw, mode`. Raw amount and fee are canonical unsigned integer strings, never Number/USD floats. EVM destination is canonical lowercase; Solana retains case. Server derives tenant and expiry; public schemas must be strict and reject userId, expiry and unknown substitutions.

SubmitWithdrawal contains only `intentId, authorizationId, otp`; no amount/destination/chain/mode substitution fields. AuthorizationProjection contains `intent, authorizationId, authorizationExpiresAt, delivery: sent|failed|unknown, replay`; no code, secret or digest. Admission can return HTTP202, never transfer/close success. Status queries remain principal-scoped.

`createReducingService(ReducingServicePorts)` returns `request(userId, ReducingRequest)`, `status(userId,intentId)`, `capability`, internal `revalidate`. ReducingRequest exact fields: `requestKey, chain, network, venue: spot|polymarket-perps, positionId, accountId, assetId, assetScale, mode, positionSide, quantityRaw, maxFeeRaw, limitPriceExact, expectedRevision`. Side and expiry are derived; no body supplied `side`/`userId`/`expiresAt`. Existing compatibility admission helpers: requestDurableManualExit, requestDurablePerpsReduction, requestPerpsPositionReduction.

FinancialRecord contains `id,userId,intent,intentHash,status,completedRaw,terminal,createdAt`. Status is `awaiting-authorization|queued|prepared|uncertain|partial|settled|failed`. `terminal:true` with `partial` does NOT mean position closed/full requested quantity filled. Report zero-size actual exposure separately, after canonical receipt accounting.

Typed denial: WithdrawalProtocolError `{name:'WithdrawalProtocolError',code:string}`. Not-found/ownership should not reveal another tenant (404); malformed exact fields 400; cooling, stale mode/ownership/balance/revision, expiry, request-key substitution, OTP mismatch/lockout and unavailable receipt/accounting ports must map to explicit denial/conflict/unavailable, not success. Missing injected service remains503 and sends no OTP/effect. Perps legacy unavailable shape retained.

Required injected ports: tenant non-bypass transaction resolving only after COMMIT; same-client locked authoritative eligibility/exposure; keyed CSPRNG OTP issue/digest and server-resolved principal email delivery; scoped current execution authorization; effect submit/reconcile and independent authenticated receipt verification/admission; canonical same-client accounting. No runtime default auto-creates any provider.

Capabilities are conservative `supported:false, sourceImplemented:true, injectedVerified:false, runtimeAccepted:false, liveAccepted:false, state:'blocked-on-external-capability'`. Presence of an injected service can expose durable-admission availability separately, not certify runtime/live. Only coordinator accepted raw evidence may advance injectedVerified externally.

## Schema082 source-only protocol

Only proposal path `/root/SWAT/threats/project-completion-20261117/082-withdrawal-reducing-schema.proposal.sql`; never integrated/applied by F. New tenant ledgers FORCE RLS. No app bypass policy, receipt INSERT or freely self-certifying settled/snapshot UPDATE. Exact intents immutable, tenant/request key unique, OTP failures monotonic, consumption deferred-checked against atomic outbox, attempts immutable/fenced, app updates limited columns with state guards. Runtime reselects independent receipt admission. Restricted settler owns receipt-derived accounting functions; dedicated independently provisioned receipt writer supplies immutable admissions. No role creation/seed/credential. Historical arbitrary app perps UPDATE privilege is revoked, initial app inserts cannot claim closed exposure. Schema role/grant/trigger/function semantics require independent PostgreSQL runtime acceptance; static source tests are not that acceptance.

Spot canonical lifecycle/lot evidence settlement is deliberately a required injected adapter; no sealed lifecycle edit or aggregate-only decrement pretending to account source lots. Withdrawal and spot accounting admission registry remains unseeded until coordinator joins an independently trusted canonical journal adapter. No accounting join => no receipt application/settled/closed result.

## Verification status and import safety

**No tests or compilers executed by F.** E/G implementation and coordinator global check freeze respected. Thus no pass/assertion count or artifact/runtime acceptance claimed. Only inspection/hashing and scoped `git diff --check` ran (exit0, no whitespace findings); not acceptance.

Literal `/root/SWAT/threats/project-completion-20261117/w3-f.config.ts` selects eight exact files. Coordinator approved config-only expansion for six exact compiler-safe `@swat/db/dist/...js` aliases to current keyless DB source before inherited barrel alias. Config retains createPackageConfig literal manifest, inherited CLI/safety guard, single fork/resource settings. Config requires coordinator import review/hash registration, global source freeze and guarded runner before execution.

- withdrawal-service/store/reducing-service tests drive actual service methods with transactional SQL transcript fixture; tests include exact substitution, tenant denial, commit-before-delivery, delivery uncertainty, atomic consume/outbox rollback, OTP lockout, cooling/stale mode/balance, budgets and jsonb hash persistence.
- reducing-orchestration test drives actual service -> SQL outbox/reservation -> durable attempt/fence -> injected effect/reconcile -> independent receipt -> same-client accounting/application; includes crash/restart, uncertain retry, partial/final deltas, overfill/regression/fee/scope/admission denial, canonical accounting rollback and concurrent injected workers. This fixture is NOT PG/RLS/trigger/concurrency acceptance.
- withdrawal-store tests assert SQL parameters/protocol and proposal source obligations, explicitly not SQL execution.
- perps reducing tests mock client/tenancy before import and exercise actual receipt adapter SQL function contract; package23 unchanged compatibility tests mock client/transaction while retaining tenant constructor.
- manual tests mock @swat/db with only keyless contract module; actual injected service uses exact source aliases. Pure bullmq UnrecoverableError/race/representation imports; no Queue/Worker instance or service startup.
- perps executor tests hoist @swat/db mock and @polymarket/client literal enum mock, so provider SDK signing/network transitive modules never load. Legacy opening tests are preserved as compatibility injection tests, not accepted live opening.
- New DB production modules only import each other and node:crypto hashing/constant-time comparison. No pool, environment, provider SDK, signing/keygen, startup or external calls at import. Test fixture is SQL-transcript-only and is emitted for compiler-safe test subpath typing, never exported publicly.
- DB production emit must precede executor emit to supply declaration subpaths and new barrel exports; executor tsconfig includes tests/rootDir src, so direct foreign source imports were replaced with typed emitted subpaths. Source alias override keeps tests on current source, not stale artifacts.

Proposed commands (NOT executed, NOT self-approved): guarded runner `build-w3-f-tests-01 test threats/project-completion-20261117/w3-f.config.ts`; coordinator DB emit then executor emit. Only after global freeze, literal imports and hashes approved; CPU0/shared flock `/tmp/swat-package11-checks.lock`, tests512MB/onefork, compilers640MB. Coordinator retains command/input/log/raw assertion/artifact evidence and independent review before acceptance.

## Capability blockers / root joins

- PostgreSQL schema integration/provisioned least-privilege settler and independent writer, actual role/RLS/transaction/deferred trigger/SQL/concurrency/crash acceptance not available; proposal not applied.
- E-owned deployed custody/delegation unwrap/authority adapter and trusted current wallet ownership, network identity/balance/exposure proofs not connected.
- Keyed OTP issuer/digest secret service and server-resolved verified email delivery not configured; no credential read or code sent.
- Authorized transfer, atomic reduceOnly provider, signing and authenticated provider receipt verifier/reconciliation/admission not configured or called.
- Spot accepted canonical lot/evidence settlement adapter and withdrawal journal/fee accounting not joined; perps nonzero fee/realized-PnL/account-margin settlement requires trusted port. Do not label unknown economics as zero.
- Coordinator barrel exports, DB/executor emits, worker/outbox dispatcher/reconciliation scheduling and H actual registered route/web joins pending. F did not edit API/web/index/shared/lifecycle/client/transaction/worker-policy/barrels/migration integration.

No services/providers/credentials/signing/keygen/migration apply/install/download/funds/commit/push/publish. Source frozen on submission pending independent read-only review; supported repairs must reopen scoped freeze and invalidate hashes/checks.

## Changed paths and SHA256 (source submission)

| Absolute path | SHA256 |
| --- | --- |
| /root/SWAT/apps/trade-executor/src/manual-exit.test.ts | d53877d58f5da3d2fdfeac959539f37533162724487ebaead2b8b234f921e43a |
| /root/SWAT/apps/trade-executor/src/manual-exit.ts | 8a87114139afc8639a256ff213c491cf1eba00dcf75e13dbc6ca1e0093f38daa |
| /root/SWAT/apps/trade-executor/src/polymarket-perps.test.ts | 631ad6184d963b32d6aad452305afb0cc51fef751fc36eb0506ec3e8e528505c |
| /root/SWAT/apps/trade-executor/src/polymarket-perps.ts | 70fd3306a6b9fb7727ac1ab6c17b47b593973e683eb3364bcef18422af66ca53 |
| /root/SWAT/apps/trade-executor/src/reducing-orchestration.test.ts | df300dada83b696aea1798f61359ae7e700d26ac8120ff8bd24a4e2016dc32d8 |
| /root/SWAT/apps/trade-executor/src/reducing-orchestration.ts | 1673ac1dbcffd77cd4d3bdd0d12ca9965bac7424c35f07d6ec701654b2ea2274 |
| /root/SWAT/apps/trade-executor/src/reducing-provider.ts | ce00710d1bd816536ab73c409db15505728fd62117831390e024ccb4f0def34d |
| /root/SWAT/packages/db/src/polymarket-perps.reducing.test.ts | c46e5b5eb6262d412cba1212b141aa13458b9d1d54da85167180032ac2bf8afe |
| /root/SWAT/packages/db/src/polymarket-perps.ts | a6fb361260980d2b33cda32e1e2200004b8d9bf3f8ff2449d6f0c51fe8bad9a3 |
| /root/SWAT/packages/db/src/reducing-contract.ts | 9cabaca8469e9455966bdc296ebc620c3df246843cdf1c2a3ae33b7427c03667 |
| /root/SWAT/packages/db/src/reducing-service.test.ts | df29c94d1074a2c7d4f56c4b5b60ec7be0fcf3dd57146f65fdcc3955200b5d04 |
| /root/SWAT/packages/db/src/reducing-service.ts | 0d3981be791f8ece924450df0379466ec8cb72055341bf82b294690b4bfdbe85 |
| /root/SWAT/packages/db/src/withdrawal-contract.ts | 89c1c1f2092e003d745ca31c306334ad78a35469db88580f3deeba7b3db092e0 |
| /root/SWAT/packages/db/src/withdrawal-service.test.ts | a20ce7b7c7acef7d7f20a1feca625ba5d20a7493fa5c1773e291219cda7f52e4 |
| /root/SWAT/packages/db/src/withdrawal-service.ts | c3f9ac7856cd44cf721f71d1a92da1f887f7314db81301e14853ba3b6ec6d547 |
| /root/SWAT/packages/db/src/withdrawal-store.test.ts | 4da7492fcbbd0bea0f8e729ea869eb6130feea65b5055bbadfd7526bbbea4a6f |
| /root/SWAT/packages/db/src/withdrawal-store.ts | 4ec56a306d108a5e0ce8d3166957ae0c3732cecad688f8110291c829de19a684 |
| /root/SWAT/packages/db/src/withdrawal-test-fixture.ts | 8b4c7ba7aee699a92364eb9fd813f222db54e83fe0a3eaab0dc2c96ca761c936 |
| /root/SWAT/threats/project-completion-20261117/082-withdrawal-reducing-schema.proposal.sql | 18745935ef7a8fcfb48f4beb2afc538252150ac40bf0de1500c06b387f3749b1 |
| /root/SWAT/threats/project-completion-20261117/w3-f.config.ts | 52baa5cc1b322412cd7488c91830c80d9234699448e8661c5923801e483f7b6e |

Unchanged selected compatibility test `/root/SWAT/packages/db/src/package23-perps.sequential.test.ts` SHA256 `8cdeefc1d1ee40ce6635f1caa5ad7ac682ebbec6b708fa9409421ce61476e33e`. Report hash supplied separately to coordinator, not recursively embedded.
