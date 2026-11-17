# Wave3 F repair submission — source refrozen, not accepted

F-only repair slot reopened by coordinator/user after independent `/root/SWAT/threats/project-completion-20261117/WAVE3-F-REVIEW.md`. Addressed supported F1–F7 and late-submit/absent-final/fixture gaps. Initial `/root/SWAT/threats/project-completion-20261117/WAVE3-F-IMPLEMENTATION.md` preserved byte-for-byte SHA256 `7262c4e60a893a5223f931168a445d256239000d1c2ad891f7ec137e0289a11d`; prior assertions/results are not rewritten. No tests/compilers ran during E/F repair slots; schema remains source-only. No self-approval.

## Supported repairs

| Finding | Source repair | New/updated test obligation (authored, not executed) |
| --- | --- | --- |
| F1 fee denomination/funding | Required `feeAssetId`, `feeAssetScale`, `feeFundingAccountId` bind exact withdrawal/reducing intent and receipt, retaining `maxFeeRaw`. Authoritative `lockFunding` port required. Distinct denomination/account budgets reserved atomically with deterministic sorted locks. Combine amount/fee ONLY identical funding chain/network/account/asset/scale/mode. Exposure budgets never combine with fee cash. SQL records exact denomination and amount/fee components, validates canonical budget key and OTP/outbox required fee budget. | unlike USDC/native fee separate raw/scale budgets, missing native fee funds denial, substituted fee denomination/funding rejected, combined exact same budget retains110 reservation. |
| F2 actual effect deadline/freshness | Typed `FinancialAuthorization` binds tenant/intentHash/attempt/clientOrderId/chain/network/mode/provider/deadline/scope proof. Deadline cannot exceed intent expiry. Runner checks after revalidation; provider checks clock AFTER async scope/exposure and passes exact enforceable deadline/scope/freshness to actual place. Atomic provider deadline support mandatory. Full fresh provider exposure binds owner/chain/network/venue/position/account/asset/scale/mode/side, not caller labels. | async acquisition advances clock through expiry => no place; acquired wrong owner/network/scale/position or stale proof => no place; exact place payload asserts fixed attempt/deadline/fee and reduceOnly IOC. |
| F3 queued-noattempt expiry | Restricted SQL cancellation locks exact tenant intent, verifies queued+expired+nonterminal+NO attempt, locks all budget keys, permanently sets `cancelled`/terminal/reason, releases every budget and writes immutable cancellation audit. Runner auto-cancels expired queued jobs before prepare; `cancelExpired(userId,intentId)` gives trusted dispatcher explicit same-client path. Prepared/uncertain expiry never releases. | queued expiry returns cancelled not uncertain/no submit; repeated run cannot prepare; prepared/uncertain expiry retains reservation/reconcile-only. |
| F4 SQL helper EXECUTE | Minimal exact `current_app_user_id()`/`is_rls_bypassed()` grants to financial settler and independent writer, needed by FORCE tenant RLS/security-definer/existing065 policy. No broad EXECUTE or memberships. | explicit exact helper grant source regression; no GRANT EXECUTE ON ALL FUNCTIONS. Actual ACL execution still blocked. |
| F5 every-fill economics | Removed zero-fee shortcut. Perps adapter and restricted SQL function require independent `reducing_perps_economics_admissions` for EVERY nonzero fill and fee-only delta. Canonical journal includes realized PnL, collateral denomination/delta, before/after initial+maintenance margin, entry/execution price and position/account journal references; null/invalid exact economic fields refused. Position quantity and receipt application share transaction/deferred constraint; no economics => no position decrement/application/settled. Reducing accounting output requires economicsReference. | zero fee and nonzero fee each deny missing economics; actual injected accounting has coherent full100 -> zero inventory; partial40 leaves60; deferred commit failure rolls back quantity/economics/application. |
| F6 cumulative paid fee | Receipt trigger updates EVERY outstanding budget: amount maximum minus cumulative fill in amount component, fee maximum minus cumulative paid fee in fee component, zero on terminal. No caller-side amount-only reservation mutation. Same-denomination combined budget subtracts both; unlike asset fee budget subtracts only fee. | fee-only2 keeps held100/feeHeld998/outstanding fee8; then partial40/fee5 leaves held60/feeHeld995/fee reserve5/exposure reserve60; only delta fee3 charged. |
| F7 forbidden filenames | Renamed `withdrawal-service.test.ts` -> `withdrawal-protocol.test.ts`, `reducing-service.test.ts` -> `reducing-protocol.test.ts`; updated literal config. Harness/runner/guards unchanged. | read-only filename regex inspection found no forbidden selected file; actual collection pending guarded runner. |

### Late submit / absence-final contract

A terminal zero-fill receipt (including rejection or absence) MUST include independently authenticated `FinancialNoFutureAcceptance` binding exact intentHash/attempt/clientOrderId/provider and permanent tombstone id/proof/effective time. Provider adapter independently verifies that exact tombstone and requires permanent tombstone support; plain404, local lease expiry or caller guarantee does not authorize release. Restricted receipt writer SQL validates structural binding and effective time; runtime app cannot insert admissions. Provider must atomically reject ANY future acceptance of the fixed order after tombstone, including original paused submitter.

Authored interleaving test drives actual service/runner/provider adapter: original submitter pauses at actual place after durable uncertain fence; competing reconcile provider atomically installs permanent tombstone before returning absent-final; receipt releases budget; original resumes and actual provider acceptance rejects tombstone, inventory unchanged/no accounting. Separate plain absence test retains uncertain/reservation without tombstone. Provider evidence authentication/atomic semantics are injected contracts, not verified external capability.

### Fixture corrections

Transcript fixture now has advancing clock and coherent reducing inventory100 matching authoritative heldRaw100; full receipt100 reaches actual zero, partial40 leaves60. Fee balance separate from inventory (unlike raw units not added). Cancellation audit and receipt-derived paid fee budgets simulated explicitly. Deferred commit failure injects rollback after accounting/application and authorization/outbox to test transaction contract; fixture discloses it is NOT PostgreSQL/RLS/trigger/ACL/concurrency acceptance. Cooling-before-effect scenario actually mutates destinationVerifiedAt during authorization, then pre-fence refuses cooling/no submit. Initial named test that did not mutate cooling was renamed to truthful accounting-only description.

## Exact revised H contract (H sole frozen/repair API integrator)

H was notified early and at checkpoint. Existing route service method signatures remain:

- `createWithdrawalService(WithdrawalServicePorts)` -> `requestOtp(userId, WithdrawalRequest)`, `submit(userId,{intentId,authorizationId,otp})`, `status(userId,intentId)`, conservative capability, trusted `revalidate`.
- `createReducingService(ReducingServicePorts)` -> `request(userId,ReducingRequest)`, `status`, capability, trusted `revalidate`.

**Required flat DTO addition on BOTH exact public request types**: `feeAssetId: string`, `feeAssetScale: number (0..36)`, `feeFundingAccountId: string`; retain canonical unsigned `maxFeeRaw: string`. Same fields on authenticated FinancialReceipt. They are part of intent hash, one-use authorization and request-key substitution checks. No defaults inferred from amount asset/scale/account. Tenant/network/account authority remains locked trusted server ports, not body labels.

WithdrawalRequest complete fields: `requestKey,chain,network,assetId,assetScale,sourceWalletId,destination,amountRaw,maxFeeRaw,feeAssetId,feeAssetScale,feeFundingAccountId,mode`. ReducingRequest complete fields: `requestKey,chain,network,venue,positionId,accountId,assetId,assetScale,mode,positionSide,quantityRaw,maxFeeRaw,feeAssetId,feeAssetScale,feeFundingAccountId,limitPriceExact,expectedRevision`. Server derives userId/expiry/side; strict schemas deny unknown substitution fields. Submit unchanged, no free body intent mutation.

FinancialStatus adds **`cancelled`**. FinancialRecord optional `cancellationReason` (projection always null or reason), terminal true on audited expired-before-attempt cancellation; completedRaw remains0. This is dispatch-disabled/no-funds-moved, not financial settled. Prepared/uncertain never cancellation-release. Existing partial/terminal distinction preserved, no admission close. Typed errors remain WithdrawalProtocolError code:string; new examples `financial-fee-funding-scope-mismatch`, `financial-fee-funding-stale`, `financial-authorization-expired`, `financial-authorization-scope-mismatch`, `financial-no-future-acceptance-unavailable`, `perps-every-fill-economics-unavailable`.

Trusted service ports now REQUIRE `lockFunding(client,userId,budget)` returning exact authoritative user/chain/network/mode/account/asset/scale/availableRaw/observedAt/validUntil/proof. This port runs after deterministic budget locks, on same client. Provider effect authorization now returns typed `FinancialAuthorization`, submit takes it. Provider atomicDeadline support/actual acceptance deadline and authenticated permanent tombstone verification are mandatory; not route booleans.

New production names are in existing coordinator-exported modules: FinancialFee/Budget/FundingEvidence/FundingPort/Authorization/NoFutureAcceptance, financialFee/financialBudgetKey/combineFinancialBudgets/validateFinancialFunding/validateFinancialAuthorization/validateNoFutureAcceptance, withdrawalBudgets/reducingBudgets. Coordinator barrel/DB emit regeneration required; no F barrel edit. Test-only helpers financialAuthorizationFixture/financialFundingFixture use exact fixture subpath, never public barrel.

## Manifest/import safety/check status

Revised literal `/root/SWAT/threats/project-completion-20261117/w3-f.config.ts` selects:

1. packages/db/src/withdrawal-protocol.test.ts
2. packages/db/src/withdrawal-store.test.ts
3. packages/db/src/reducing-protocol.test.ts
4. packages/db/src/polymarket-perps.reducing.test.ts
5. packages/db/src/package23-perps.sequential.test.ts (unchanged)
6. apps/trade-executor/src/reducing-orchestration.test.ts
7. apps/trade-executor/src/manual-exit.test.ts
8. apps/trade-executor/src/polymarket-perps.test.ts

Six coordinator-authorized exact subpath source aliases unchanged, inherited literal manifest/CLI/safety/onefork preserved. Newly renamed filenames inspected against harness prohibition, none forbidden. No harness/root/runner edit. DB source modules remain keyless dependency-light node:crypto+local modules; executor runtime imports @swat/db, test mocks replace barrel with current keyless aliased source; SDK enum-only mock retained, no provider SDK import/startup/signing/network execution. PG client/transaction mocks retain package23 compatibility test. DB emit must precede executor emit to refresh declarations and compiler-safe subpath types; cannot count stale emitted module artifacts as current source evidence.

**No tests, compilers, PG, providers or services executed by F in repair slot.** Only Read/Edit/Write/file rename/hash/source inspection/scoped git diff --check (exit0) occurred. No collected/passing assertion count or runtime/live approval. Proposed later command, NOT run/self-approved: guarded runner `build-w3-f-repair-tests-01 test threats/project-completion-20261117/w3-f.config.ts`; coordinator DB/executor emit after global freeze and hash-bound literal/import approval. CPU0/shared flock/tests512MB onefork/compilers640 preserved. Source changes invalidate affected prior config/source hashes. Independent rereview then coordinator raw checks required.

## Remaining capability blockers

-082 proposal NOT applied; actual role provisioning/helper ACL/RLS/function ownership/locking/deferred constraints/SQL journal/concurrency/crash acceptance not available.
- Provider atomicdeadline/reduceOnly/tombstone authentication and exact network/account/mode/scale deployed mapping not accepted; injected interface is not credential authority. No real provider/call/key/signature/funds.
- Every-fill independent perps economics writer and canonical journal/account settlement not provisioned/admitted; quantity-only evidence cannot claim financially settled. Spot and withdrawal independent canonical accounting adapters/registry likewise unjoined/unseeded.
- E custody/current trusted funding/ownership/verification/mode proofs, OTP keyed issuer/server-resolved email delivery remain unavailable. No credential read, external code sent or transfer queued in runtime.
- Coordinator dispatcher/noattempt expiry sweep/uncertain reconciliation scheduling and exports/emits, H API/web changed fee/cancelled joins and actual registered-route tests pending respective ownership. F did not edit API/web/barrels/shared/client/transaction/lifecycle/worker-policy/root runner.
- Immutable one-attempt safety means prepared unsent jobs reconcile only; permanent tombstone/final refusal needed for terminal nofill release, not auto replay/lease. Separate user request needed for remainder/new effect.

Source refrozen on this submission. Initial report/review retained. No tests/compilers before coordinator global freeze, no self-approval; supported rereview repairs must explicitly reopen affected F paths.

## Revised path hashes

| Absolute path | SHA256 |
| --- | --- |
| /root/SWAT/apps/trade-executor/src/manual-exit.test.ts | 791b01fe2ee5781dd04b4502be3c63b608d6fb739b80f049ea4fc386d524479d |
| /root/SWAT/apps/trade-executor/src/manual-exit.ts | 8a87114139afc8639a256ff213c491cf1eba00dcf75e13dbc6ca1e0093f38daa |
| /root/SWAT/apps/trade-executor/src/polymarket-perps.test.ts | a43fd23a74f996ef0e217b9dffe45e6caa2372dec0d227fa94cd2a0764ea091e |
| /root/SWAT/apps/trade-executor/src/polymarket-perps.ts | 70fd3306a6b9fb7727ac1ab6c17b47b593973e683eb3364bcef18422af66ca53 |
| /root/SWAT/apps/trade-executor/src/reducing-orchestration.test.ts | 8394d1c18553390673e85f433522e647356f86f6a9a402c130508d40da6f05ee |
| /root/SWAT/apps/trade-executor/src/reducing-orchestration.ts | 29d9e9dfcc032d7927217d8542b963860cccd8b8f3e1b613d9dbb2fd60623c1b |
| /root/SWAT/apps/trade-executor/src/reducing-provider.ts | 821fef984e0b1fa7cf40ab81f2487bf6d2c7d87c94cc8fe831b8a0df6cd07ada |
| /root/SWAT/packages/db/src/polymarket-perps.reducing.test.ts | de29d97e9cad132c050ee55537b07aead25f0818caad9f45ff14565653bbb24d |
| /root/SWAT/packages/db/src/polymarket-perps.ts | f6ade98aa6ba8d34c1441823da3675a17114b1b618273e182725903463a36c2d |
| /root/SWAT/packages/db/src/reducing-contract.ts | 111c15d0785ea75e788e9213b1d6acfa8f22b53c221715a1e5077bd1ce86e30c |
| /root/SWAT/packages/db/src/reducing-protocol.test.ts | d6934f1ee00361f1fd722315b4898680680c09a1db318c004447bb2a8b50125f |
| /root/SWAT/packages/db/src/reducing-service.ts | 3450c098355e132ee4beaa0ca13b251712728d5a4df5e2abe60da9895d6a1a36 |
| /root/SWAT/packages/db/src/withdrawal-contract.ts | d74d2a8636f397386ee16a4eb3962a2e2071bc491a4264c865787aec6bf5f7c7 |
| /root/SWAT/packages/db/src/withdrawal-protocol.test.ts | dafe04d18b39ba056234c6da22f0a5ca3d3edf4ee5368b2703b2e256f39110e5 |
| /root/SWAT/packages/db/src/withdrawal-service.ts | 3e0b0ca150f5e465b3650d78b21b17f306ec5ccf4fab7035fe9fbc24832d70f1 |
| /root/SWAT/packages/db/src/withdrawal-store.test.ts | 1877b3cdd726639123dea49af7480271c87c903d75e6371629dc942ff94ea6a5 |
| /root/SWAT/packages/db/src/withdrawal-store.ts | 6fdfcf19aa4499960f6c2c409784a0ad63901db64affee937c94e605533156b0 |
| /root/SWAT/packages/db/src/withdrawal-test-fixture.ts | a8a8effd46978119a7661f6768242acbb11d3b85a3949c9e6ed63d1a3cc61a3f |
| /root/SWAT/threats/project-completion-20261117/082-withdrawal-reducing-schema.proposal.sql | e8a7b80ae7890b3a31a64060de14c33334ac17048a15f704fa624a6d8ba24e96 |
| /root/SWAT/threats/project-completion-20261117/w3-f.config.ts | d013ec61b07c20daba8f63ee7543c0e36a2cbfcbc215c6107c6149f09942721b |

Old paths `/root/SWAT/packages/db/src/withdrawal-service.test.ts` and `/root/SWAT/packages/db/src/reducing-service.test.ts` renamed/absent. Unchanged selected compatibility test `/root/SWAT/packages/db/src/package23-perps.sequential.test.ts` SHA256 `8cdeefc1d1ee40ce6635f1caa5ad7ac682ebbec6b708fa9409421ce61476e33e`. This report hash supplied separately; revised rows reconciled before submission.
