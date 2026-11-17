# Wave 3 H independent final source review

Date: 2026-11-17. Repository: `/root/SWAT`. HEAD: `b64854e3d2e81b16b3c11018729940a9351bc0ce`; this review covers the hashed working-tree source, not a clean commit.

## Verdict and sequencing

**Clean H source review within the compact inspected scope: no additional supported H implementation blocker found. Final combined integration is not accepted: G-1 remains blocking.** `/root/SWAT/threats/project-completion-20261117/WAVE3-G-REVIEW.md` was completed and written before reading the H submission or reviewing H source. G-1 is the receiptless completed-operation INSERT bypass in unapplied083, not an H-owned repair and not proof of a deployed exploit. H's submission still describes G review as pending; this review supersedes that historical status, without rewriting the submission.

This is independent source inspection of implementation, not agreement based solely on submission prose. Neither tests nor application code were executed. No compilation, test, browser, SQL, provider or runtime success is claimed.

## Supported H source invariants

### Strict F fee/cancellation projection; no public financial authority

- `/root/SWAT/apps/api/src/routes/me-financial.ts:20-29` requires `maxFeeRaw`, separately named `feeAssetId`, independent `feeAssetScale` (0..36), and `feeFundingAccountId`, including zero-fee intents. Amount/quantity/fee remain bounded canonical integer strings. Strict withdrawal/reducing/confirmation schemas exclude public tenant, provider, receipt, collateral and economic authority.
- Lines 31-65 check tenant ownership and the immutable intent digest, validate the allowlisted projected request, bound completed quantity using BigInt, require settled full/terminal progress, and require cancelled terminal zero effect plus a nonempty reason. Non-cancelled records cannot carry cancellation reasons. Output is built explicitly, not an arbitrary provider/storage-row spread. Separate fee metadata and nullable cancellation reason reach the public DTO.
- `/root/SWAT/packages/db/src/withdrawal-contract.ts:12,19-22,53-61,130-139` and `/root/SWAT/packages/db/src/reducing-contract.ts:7-15` support the joined fee/status/record contract. This review does not independently certify the provenance of a cancellation reason: the audited decision belongs to the trusted F service/store, not elapsed time or a browser label.
- `/root/SWAT/apps/api/src/routes/me.ts:125,314-316,976-977` wires only injected admission/status routes; spot and perps reducing paths use the strict helper and close-all remains unavailable. `/root/SWAT/apps/api/src/routes/me-financial.ts:9-18,73-142` introduces no signer/execution/receipt-admission port and withholds runtime/live acceptance; absent withdrawal/reducing ports fail unavailable.

### Persisted financial ambiguity and immutable retries

- `/root/SWAT/apps/web/lib/financial-request-state.ts:25-60,62-90` copies state/input, persists before dispatch, reloads dispatching as unknown, retries the pinned JSON/key, and prevents replacement of unresolved admission/confirmation. A later schema400 cannot erase an earlier admission ambiguity. Bound observed intent/progress/cancellation is required before resolution. OTP is absent from persisted state.
- `/root/SWAT/apps/web/components/FinancialRequestPanel.tsx:30-81,83-100` partitions storage by account/kind/venue/position, disables dispatch when storage/account initialization fails, uses a same-mounted-panel ref lock, retries original payload rather than changed fields, and allows pinned retry/status reconciliation without a fresh capability grant. Fee metadata and audited cancellation notices are explicit. Only fresh admission is capability gated.
- Old pinned pre-fee payloads are not repaired or rekeyed. They may stay unresolved/refused; that is an honest reconciliation limitation rather than a fabricated successful upgrade.

### Exact LP DTOs and response/current-state separation

- `/root/SWAT/apps/web/lib/domain-transport.ts:2-3,77-118` imports/re-exports LP DTOs **type-only**, not a DB/service/store runtime client. Its acquisition, operation, copy, current-position and operation-status paths match the inspected G routes in `/root/SWAT/apps/lp/src/routes.ts:225-283,294-343`.
- Acquisition/rawscale/strategy, operation and copy inputs locally reject unexpected fields. Public payloads introduce no quote, provider, receipt, risk approval, tenant, copy origin, economics or collateral authority. Server schemas remain authoritative. LP raw values, revisions and microdollars stay strings; formatting is string-based, supports canonical signed values, and renders null economics as Unknown. Number conversions in these controls are scale/rung/geometry metadata, not monetary valuation.
- `/root/SWAT/apps/web/lib/lp-request-state.ts:24-55,57-101` validates fresh drafts, snapshots and persists commands before dispatch, reloads dispatching as unknown, retries the same acquisition/operation key or subscription/event/scale tuple, and permits fresh commands only after bound resolution. Request failures preserve the unresolved fence. Responses bind tenant/action/key/position/quantity; completed operation observations require paper receipt identity/revision/rawscale/quote-pool bindings and zero inventory for close. These are consistency checks, not cryptographic quote/receipt/provider authentication; trusted verification remains G's responsibility.
- `/root/SWAT/apps/web/components/FinancialRequestPanel.tsx:104-181` uses account-partitioned injected storage, a same-panel lock, pinned retry/status paths, and separate current-position lookup. Initial acquisition results are explicitly labelled immutable historical outputs, not current observations. Current reads clear prior observations before fetching and do not fall back to the acquisition snapshot on failure. Pending close is not displayed as closed inventory or realized completion.
- `/root/SWAT/apps/web/app/lp/builder/page.tsx:11-21,179-180` sends canonical deposit raw with explicit scale/asset/resolved strategy and initial autoRebalance false. Mutable drafts do not replace the pinned command. `/root/SWAT/apps/web/app/lp/positions/page.tsx:19-43,99-100,122` labels numeric enumeration observation-only, makes its legacy actions inert, and mounts a separate exact control. `/root/SWAT/apps/web/lib/portfolio-model.ts:92-99` universally denies actions from the legacy numeric position DTO. No exact quantity is reconstructed from that list.
- `/root/SWAT/apps/web/components/LpCopyPanel.tsx:41-42` mounts the persistent exact copy control while explicitly retaining legacy numeric subscription budgets/history and unavailable fractional budget creation. `/root/SWAT/apps/web/next.config.ts:27-34` preserves LP-first rewriting; it grants transport routing, not provider authority. `/root/SWAT/apps/web/lib/api.ts:98-114,260-268` supplies session credentials and mutating CSRF handling through the shared transport.

### Honest capabilities/providerless states

`/root/SWAT/apps/web/lib/domain-transport.ts:29-31,81-83` and `/root/SWAT/apps/web/components/FinancialRequestPanel.tsx:86-88,170-177` distinguish source implementation/port presence from verification/runtime/live acceptance. Protocol presence alone is not master/risk availability. Fresh LP admission remains unavailable with absent ports; retries retain their immutable identity and the server independently refuses missing authority. G's `/root/SWAT/apps/lp/src/index.ts:160` still constructs a providerless exact domain. Exact aggregate lists, fractional subscription-budget creation and current exact consent mutation are not falsely advertised as joined capabilities.

## SHA-256 pins

Hashes were calculated from current source; the inspected G core hashes were also unchanged at the final pinning pass. This report has no self-referential hash.

```text
9f64d35bf46898e501ffe476e56acd323145b1acb5369fa0ccf07a2405fcf67d  /root/SWAT/threats/project-completion-20261117/WAVE3-H-FINAL-JOIN.md
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
31364e1c8e4fd2f878be2333e52a28dc9b17648cb24e690c0a06b00b28050cb3  /root/SWAT/apps/web/lib/api.ts
d74d2a8636f397386ee16a4eb3962a2e2071bc491a4264c865787aec6bf5f7c7  /root/SWAT/packages/db/src/withdrawal-contract.ts
56ce23e7630e05c0389333210037838f89229592071724f25906e243851f4bd2  /root/SWAT/packages/db/src/reducing-contract.ts
65505092e02f1202eed458c8216814cc61df4ede4e0ad57c6ec22f79e2519cd4  /root/SWAT/packages/db/src/lp-exact.ts
267db517d2e03a3e4e9270a82497766cfbc5318bea445b2e2e943b412c4670f3  /root/SWAT/packages/db/src/lp-paper-service.ts
cc9e94407070678ef24f8debfcd1fa95b70776865627267e3e946e1ad316b1d1  /root/SWAT/apps/lp/src/routes.ts
24cb7ba1cb4065fb163671d6922611622b12cb1560d8923aeeda785d4c88de61  /root/SWAT/threats/project-completion-20261117/083-lp-schema.proposal.sql
```

## Limitations and next gate

Exactly 20 sequential tool calls were used across G then H; no subagents/background, tests, compilers/emits, services, network, secrets, browser, SQL application or implementation edits. Only the two explicitly requested review files were created; neither existed at the initial check. Source excerpts were bounded, and overlarge tool results were not treated as fully inspected evidence: final findings rely on subsequently visible compact excerpts. Selected test files/configs and all transitive imports were not independently audited or executed. This is not an exhaustive repository, frontend rendering or provider trust certification.

Unqualified: compilation/package exports/type subpaths, PostgreSQL/trigger/RLS/privilege/concurrency/crash behavior, durable queues, cancellation audit provenance inside F, external mapping/funding/master/risk/quote/receipt sources, signing/broadcast, live settlement, cross-tab/multi-device/account-switch races and client-storage tampering/recovery. LocalStorage is an accident-prevention fence, not trusted authority. Unknown old financial intents or unavailable current LP reads may remain blocked; no synthetic zero/new-key escape is accepted. Schemas081/082/083 remain unapplied. Repair and re-review G-1, freeze the joined source and register hashes/import boundaries before separate coordinator-guarded offline/runtime qualification. These source findings do not extend earlier Wave1/2 acceptance.
