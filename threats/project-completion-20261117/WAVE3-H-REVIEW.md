# Wave 3 independent H review — required repairs

Read-only source review; no edits/tests/compiler/SQL/browser/services/providers/network/files written. All 21 listed H source/config hashes match frozen submission. E/F are repair-required dependencies; F changed during review, invalidating H dependent snapshot. G unsubmitted, not assumed accepted.

## Supported H findings

- **H-R1 High** — FinancialRequestPanel.tsx:20-38,51-56: lost reducing-admission/withdrawal-confirm response only sets error, allows editing and generating replacement requestKey while original may have committed. Persist immutable submitted key/request and outcome-unknown fence BEFORE dispatch; retry same operation/reconcile, no replacement key until verified terminal/no-effect/cancellation. Separate definite pre-admission refusal from transport ambiguity; lost-response state-machine tests.
- **H-R2 Medium** — FinancialRequestPanel.tsx:22-23,30,51-54: terminal partial sets pending from status alone, locks panel forever. Model terminal separately, allow explicit new freshly authorized request after terminal partial, retain nonterminal partial/uncertain fence.
- **H-R3 Medium retained tenancy regression** — me.ts:143-154,229-260,327-339,402-413: query() resets session tenant on BEGIN, WHERE userId doesn't establish RLS tenant. Public account/position/grant reads can become empty; local revoke zero rows falsely says disabled. Use scopedQuery/withTenantTransaction, no bypass. Mock rows not proof.
- **H-R4 Medium fabricated price** — lp/discover/page.tsx:218,301; lp/builder/page.tsx:24-35: null price substitutes price=1 and creates invented0.9-1.1 range. Omit unknown price, derive from explicit valid observation or manual user bounds clearly labeled.
- **H-R5 Medium DTO mismatch** — LpCopyPanel.tsx:7,43-45; lp-tracked-wallets.ts:220-230,279-283,314-321: route returns closedPositionCount and winRate ratio, UI uses totalPositions and displays0.75%. Consume actual count, finite[0,1]ratio*100, null unassessed.
- **H-R6 Medium observation/readiness** — lp/discover/page.tsx:38-57,125-140,169-177,288-296: failed fetch clears data and displays error plus No Pools; recorded risk score renders PASSED/AUDIT despite no accepted protection. Exclusive loading/unavailable/observed-empty states, unverified recorded score badges, observation-loading language not onchain scan/computation.

## Required interface and manifest synchronization

Final F repairs add mandatory feeAssetId/feeAssetScale/feeFundingAccountId even zero fee. Current H me-financial strict schemas, immutable projections, domain-transport/form/test fixtures reject/omit them. Join after F refreeze/affected independent recheck, no invented denomination/funding authority. New cancelled progress must be exposed as audited resolved outcome rather than unavailable; never cancel uncertain attempts on expiry.

E/F dist contracts absent during review. Coordinator DB emit/artifact join required; source aliases aren't production emit proof. H E custody facade independent linked ownership/single-use consent/deployed mechanism/commit-time checks remain injected-service obligations, not proven by immediate fake callback. No executor unwrap introduced. Default CLOB refuses before challenge/acquisition. Admission/capability/local-record reports never runtime/live.

H literal13-file config no prohibited service filenames and selected handlers use actual F/E factories; globally serialized fixed-clock transcript is not PG/RLS/ACL/trigger/concurrency/accounting qualification. Held exposure100 versus inventory1000 means delta settlement not actual zero closure; update affected fixtures. No mounted component/state-machine tests cover H-R1/R2; substring assertions insufficient.

Reviewer frozen report SHA25623c92d1f8bdd3463db3dcff2b79ee0cf59221bffce110350fefc8aab5497745f and all21 manifest entries matched. Include seven additional inherited/contextual H inputs in final check manifest: me.portfolio.sequential.test.ts, API tsconfig and test tsconfig, web portfolio-model.sequential/transport.sequential/wallets.ts/WalletConnectModalButton.tsx. Separate inherited versus owner changes; don't omit checks' dependencies.

**Disposition: H not accepted.** Repair H local findings, synchronize reviewed final domain interfaces, full manifest/refreeze, coordinator guarded verification, independent affected rereview. No injected/runtime/live/production certification.
