# Wave3 F repair2 — F8/F9/F10 and journal fixture, refrozen

Read independent `/root/SWAT/threats/project-completion-20261117/WAVE3-F-RECHECK.md`; reopened only supported F8–F10/economics fixture. F1/F2/F4/F6/F7 source closures preserved; no widening to injected/runtime/live acceptance. Initial implementation report and repair1 report remain unchanged. Repair1 `/root/SWAT/threats/project-completion-20261117/WAVE3-F-REPAIR.md` SHA256 `628cca1d915c603fc42cf975f17853db0def233c2f981416632e2840e30f74ae`; initial report `7262c4e60a893a5223f931168a445d256239000d1c2ad891f7ec137e0289a11d`.

## F8 exact fee-only accounting after nonterminal zero-exposure close

Restricted `swat_apply_perps_reducing_receipt` now locks owned position irrespective of open/closed status, but closed position is eligible ONLY for exact delta0/size0 and an existing SAME intent/user/attempt applied receipt journal whose after_raw=0 and cumulative matches current accounted quantity. Liquidated/other status still refused. Closed branch performs NO quantity/status update and never reopens exposure. Every fee delta still needs independent economics admission and a new immutable position journal/application in same commit. Receipt progress then releases remaining paid-fee budget; idempotent exact receipt replay does not charge again.

Authored tests:
- actual injected service/runner receipt100 nonterminal closes coherent position100 ->0, remains nonterminal; final samequantity100/fee5 applies delta quantity0/fee3 once, inventory stays0/status closed, economics journals2, funding release0; repeated run no additional account call;
- actual perps adapter fee-only delta0/fee3 returns before0/after0 with independent economics, invokes restricted function rather than arbitrary update;
- SQL source regression exact prior applied journal required/no reopening. These are NOT PostgreSQL execution proofs.

## F9 direct attempt INSERT versus cancellation

The direct runtime-app INSERT guard now SELECTs parent `FOR UPDATE` **before** validating current queued status, terminal/cancelled_at and `statement_timestamp()` expiry. Cancellation already locks same parent before committed-attempt absence proof. Parent/attempt lock order preserved. A blocked direct INSERT rechecks updated parent/current statement time after cancel, so cannot pass old queued/preexpiry state then succeed FK after reservation release. Direct app INSERT remains narrow/granted; RLS and state guards remain enforced; no bypass/service role widening.

Authored source boundary assertion inspects guard lock-before-status, terminal/cancelled rejection/current expiry and exact direct-app INSERT grant. Transcript prepare simulator rejects expired/cancelled parent. Real PG current-role/RLS/FK lock-wait/directINSERT/cancel concurrency remains a separately authenticated qualified gate, not a claimed source SQL engine test.

## F10 independent collateral mapping (no public DTO additions)

Added trusted `ReducingVenueMapping`/`ReducingVenueMappingPort`/`validateReducingVenueMapping` in owned reducing-contract module. Mapping binds tenant/venue/position/account/chain/network/mode/instrument/scale and independent collateralAssetId/collateralAssetScale/collateralAccountId, immutable mapping id/revision/proof and observed/valid time. Perps service requires `lockVenueMapping(client, record)` on admission and immediately before effect, fresh full scope evidence and independently admitted mapping hash lookup. Missing/unadmitted/wrong/stale mapping refuses durable outbox/effect. Spot does not need perps collateral mapping.

Source082 `reducing_perps_venue_mappings` is restricted independent-writer/tenant RLS, immutable/no app INSERT. Deployed mappings keyed by mapping_id+owned position (NOT an uncommitted runtime intent FK), so independent writer can persist account/position mapping before route request. Guard checks actual owned position/instrument and exact mapping JSON/column binding; provider writer responsible for authentic deployed account/network/mode/collateral resolution. Writer gets only scoped position SELECT/helper ACL, not runtime collateral authority.

Economics admissions select trusted mapping by journal venueMappingId plus exact tenant/position/account/chain/network/mode/instrument/scale. Collateral JSON binds mapping denomination/account rather than public feeAssetId/Scale. Outbox requires live matching mapping. Native MATIC fee18 with independently mapped USDC collateral6 is allowed truthfully, not relabeled. No inferred fee-equals-collateral policy and no caller-controlled collateral inputs.

Authored tests nativefee+USDC collateral in actual persisted journal, missing mapping admission denial, SQL independent mapping binding/no fee-label comparison and no intent FK. Positive mapping ports/fixture admissions are injected evidence, not real provider proof.

## Economics fixture repair

Transactional fixture state now contains `economics` journal rows and positionStatus, rather than a fabricated return string. Actual injected accounting writes `fixture:economics` JSON on same client before quantity/fee accounting/application, including receipt/intent references, deployed collateral mapping, raw quantity and fee balance before/after, PnL/margin/price/position/account journal fields. Fixture receipt application requires persisted journal for perps nonzero quantity/fee delta. All fixture state is cloned/rolled back on transaction/deferred commit failure.

Deferred rollback test now uses full100+fee5: asserts quantity100, statusopen, feeHeld1000, economics0, applications0, uncertain after failure; retry persists economics1 with exact quantity100/fee5 and fee balances1000 ->995, quantity0/statusclosed. Partial/final tests assert journal rows and same-client economics/account/application groups. Fixture remains globally serialized and manually independent-admitted; no PG role/RLS/trigger/constraint/SQL runtime claim.

## Final H/public DTO and coordinator joins

**No public request/response DTO addition in repair2.** H repair1 exact required fee fields and cancelled/reason contract remain unchanged. Collateral comes only from trusted evidence `lockVenueMapping`, never body fields/default labels. Perps port must be supplied or admission/effect is unavailable. New production type/function names within already coordinator-exported reducing-contract module: `ReducingVenueMapping`, `ReducingVenueMappingPort`, `validateReducingVenueMapping`. Fixture-only reducingMappingFixture stays exact test subpath, not public barrel. Coordinator regenerates DB declarations/artifacts before executor, not F edits.

Service method signatures remain request/requestOtp/submit/status/revalidate; source capabilities still supportedfalse/injectedVerifiedfalse/runtimeAcceptedfalse/liveAcceptedfalse. Terminal partial not closed; zero exposure alone not financial settled until complete independently admitted economics/application. F8 may finish fee accounting after zero exposure without reopening.

## Verification/import safety/status

**No tests or compilers run in repair2.** G concurrently implementing; E/H stopped; checks held until global freeze/coordinator hash review. Only read/edit/write/hash/source inspection and scoped git diff --check exit0. No provider/credential/signing/keygen/install/download/service/SQL/migration apply/funds/commit/publish. Schema only at allowed proposal path.

`w3-f.config.ts` unchanged SHA256 `d013ec61b07c20daba8f63ee7543c0e36a2cbfcbc215c6107c6149f09942721b`:8 literal suites, allowed withdrawal-protocol/reducing-protocol names, six exact subpath aliases to current keyless DB source, inherited CLI/safety/onefork guards preserved. No root harness/runner changes. DB local modules/node:crypto only; executor production @swat/db, test barrel mocks/current source alias and provider enum mock retained. Fixture new reducing import is type-only, no external module or service at import. No new provider SDK/network entrypoints.

Affected tests: withdrawal-store.test.ts, reducing-protocol.test.ts, polymarket-perps.reducing.test.ts, reducing-orchestration.test.ts, executor polymarket-perps.test.ts. All manifest tests require fresh affected rereview+guarded run after global source freeze. Passing counts absent/unclaimed. SourceSQL obligations are static assertions only; SQL parser/runtime not invoked.

Remaining blockers: actual schema082/RLS/helper ACL/function ownership/directINSERT cancellation concurrency/deferred runtime qualification; authenticated provider deadline/reduceOnly/tombstone guarantees and deployed independent account/network/mode/instrument/collateral mapping; perps every-fill economics canonical journal writer/account settlement; spot/withdrawal accepted canonical accounting adapters; custody/OTP/current authoritative funding; coordinator dispatcher/cancel sweep/reconcile scheduling/barrels/emits and final H fee/cancelled API/frontend joins. None auto-authorized by source flags/hashes. Source refrozen on submission pending independent affected recheck, no selfapproval.

## Final F source/proposal/config hashes

Full20-path final manifest (includes unchanged F entries for coherence):

| Absolute path | SHA256 |
| --- | --- |
| /root/SWAT/apps/trade-executor/src/manual-exit.test.ts | 791b01fe2ee5781dd04b4502be3c63b608d6fb739b80f049ea4fc386d524479d |
| /root/SWAT/apps/trade-executor/src/manual-exit.ts | 8a87114139afc8639a256ff213c491cf1eba00dcf75e13dbc6ca1e0093f38daa |
| /root/SWAT/apps/trade-executor/src/polymarket-perps.test.ts | 8719e88eeaa32c64bc03cc8de4e0ba9524b04450b5eb614d019a655bed1b2de3 |
| /root/SWAT/apps/trade-executor/src/polymarket-perps.ts | 70fd3306a6b9fb7727ac1ab6c17b47b593973e683eb3364bcef18422af66ca53 |
| /root/SWAT/apps/trade-executor/src/reducing-orchestration.test.ts | 9afd228d6977f341e37b07ad4828ef88aef01d0e395c203ddd942014c64f6674 |
| /root/SWAT/apps/trade-executor/src/reducing-orchestration.ts | 29d9e9dfcc032d7927217d8542b963860cccd8b8f3e1b613d9dbb2fd60623c1b |
| /root/SWAT/apps/trade-executor/src/reducing-provider.ts | 821fef984e0b1fa7cf40ab81f2487bf6d2c7d87c94cc8fe831b8a0df6cd07ada |
| /root/SWAT/packages/db/src/polymarket-perps.reducing.test.ts | 10eeb6f93a4e72132a8d0c85ea4e7970bcb95b381e57019c8e65edb119762e89 |
| /root/SWAT/packages/db/src/polymarket-perps.ts | f6ade98aa6ba8d34c1441823da3675a17114b1b618273e182725903463a36c2d |
| /root/SWAT/packages/db/src/reducing-contract.ts | 56ce23e7630e05c0389333210037838f89229592071724f25906e243851f4bd2 |
| /root/SWAT/packages/db/src/reducing-protocol.test.ts | 92b70169c9c648f85582e690fbc5af99a9bff51b8c5d8731bdb8232bf483c039 |
| /root/SWAT/packages/db/src/reducing-service.ts | 475e590bfe0a14e03eba8c0405de633988a8c0d8bfabd045f738baaf4ad9c796 |
| /root/SWAT/packages/db/src/withdrawal-contract.ts | d74d2a8636f397386ee16a4eb3962a2e2071bc491a4264c865787aec6bf5f7c7 |
| /root/SWAT/packages/db/src/withdrawal-protocol.test.ts | dafe04d18b39ba056234c6da22f0a5ca3d3edf4ee5368b2703b2e256f39110e5 |
| /root/SWAT/packages/db/src/withdrawal-service.ts | 3e0b0ca150f5e465b3650d78b21b17f306ec5ccf4fab7035fe9fbc24832d70f1 |
| /root/SWAT/packages/db/src/withdrawal-store.test.ts | 746a624a4b6edc5e2a97764820e44eb0399e562d54ba1b962f189bc5f29a7461 |
| /root/SWAT/packages/db/src/withdrawal-store.ts | 6fdfcf19aa4499960f6c2c409784a0ad63901db64affee937c94e605533156b0 |
| /root/SWAT/packages/db/src/withdrawal-test-fixture.ts | 762d1de6f301bca6d659c4d5369680b3af7b2680294d0f1b73264cf382b9b2c6 |
| /root/SWAT/threats/project-completion-20261117/082-withdrawal-reducing-schema.proposal.sql | a268505e351b1c91589137811fa402287f86ce1eb6b2af33f1494d7df4ee4050 |
| /root/SWAT/threats/project-completion-20261117/w3-f.config.ts | d013ec61b07c20daba8f63ee7543c0e36a2cbfcbc215c6107c6149f09942721b |

Unchanged selected `/root/SWAT/packages/db/src/package23-perps.sequential.test.ts` SHA256 `8cdeefc1d1ee40ce6635f1caa5ad7ac682ebbec6b708fa9409421ce61476e33e`. Report fingerprint supplied separately. Initial renamed forbidden service.test paths remain absent.
