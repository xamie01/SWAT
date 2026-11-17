# F repair independent recheck — follow-up required

Read-only; no edits/tests/compiler/SQL/services/provider/network/credentials/signing. Refrozen report SHA256628cca1d915c603fc42cf975f17853db0def233c2f981416632e2840e30f74ae and all F entries matched/stable. Initial report/review retained. No full F/injected/runtime/live acceptance.

Source closure F1 exact fee denomination/funding+sorted budgets; F2 typed attempt-bound deadline/postwait exposure/provider atomicexpiry contract; F4 narrow helper EXECUTE; F6 cumulative paidfee reservations; F7 allowed test names/no guard weakening. Normal F3 queued-noattempt cancel and F5 everyfill economics mechanisms implemented but follow-ups below remain.

## F8 P2 fee-only after zero exposure

reducing-orchestration.ts:68-77; polymarket-perps.ts:352-367; SQL082:323-341: full nonterminal100 fill closes local exposure; final samequantity largerfee asks quantity0/fee3 accounting but perps function requires open/closing, refuses closed position. Add exact prior-journal closed-position fee-only path no reopening/quantity change; coherent fullnonterminal->closed->feefinal regression with deltaonce/zeroexposure/release.

## F9 P2 cancel/attempt SQL boundary

SQL082:236-245 parent read in direct attemptINSERT guard unlocked; cancellation:442-459 locksparent/checksabsence; appINSERT granted:517-518. Direct insertion can validate oldqueued preexpiry then FK wait while cancel sees no committedattempt and releases; FK later succeeds against cancelled parent. Lockparent in INSERT guard before current status/expiry check (consistent order) or restricted preparation function, no directINSERT. Add role-boundary prepare/cancel invariant source test, actual SQL concurrency remains separate qualified gate.

## F10 P2 collateral versus fee

reducing-contract.ts:6-12,40-46; SQL082:475-481: economics collateral asserted equal to public fee asset/scale with no independent collateral mapping. Nativefee+USDC collateral truthful journal denied or mislabeled. Bind collateral denomination/account from trusted venue/account mapping independently. Alternatively beforeadmission/effect explicitly verify restricted fee-equals-collateral domain and refuse others; never infer from caller fee labels.

## Economics fixture obligation

Test reducing-orchestration.test.ts:161-165 titled actual coherentposition/economics rollback only returns fabricated economics reference, no fixture journal state. Persist injected sameclient economics journal and assert rollback with quantity/fee/application. Do not claim stringreference proves journal rollback.

Tombstone late submit source repair supported: exact permanent nofutureacceptance binding, provider independent verification, SQL structure, real injected paused-placement->tombstone->released->lateproviderrejection test. External atomic tombstone/provider guarantees NOT established. Coherent100->0/partialfee/clockadvance/mutatedcooling/deferredcommit source fixtures now present, still globallyserialized/directadmission noPG/RLS/ACL/trigger proof.

Coordinator barrel/DBemit, final H fee/cancelled strict schemas/transport/forms/tests and production scheduling remain pending. Account/network/mode/scale/collateral mapping, independent economics/canonical journals, OTP/custody/provider remain unavailable. Reopen F8..F10+fixture only, refreeze/hash, independent affected recheck before final H join/guarded verification.
