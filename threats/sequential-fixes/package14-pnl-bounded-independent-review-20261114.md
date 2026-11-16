# PNL snapshot bounded independent review — 2026-11-14

Scope: reported current `pnl-queries.ts`/tests projection correction. Fixed baseline8905505595802c21053118b5fab3fd53a8a1654c; observedHEAD08c822d470554ef1f05e701b1abbed7dcb3dbc54. No full-HEAD/runtime acceptance.

## Standards

Separate read-only Standards reviewer returned0documentedviolations/0actionableheuristics. Exact SQL text transport, null-safe tenant/account distinction and unchanged numeric diagnostic PNL conform within the assigned projection. Both changed hashes matched; installed RLS/session scoping remains an external/integration obligation.

## Spec

The original bounded projection review returned0findings, but a supported acquisition-proof follow-up revised that conclusion to **one High/high source-confidence finding**. `pnl-queries.ts:205–215,335–342` emits exact lot ownership from positive quantity plus acquisition/source joins without binding `lot.acquisition_evidence_id` to that acquisition's evidence or requiring current active applied confirmation. SQL058:17–18 has independent FKs; its parent trigger checks position scope, not evidence/acquisition equality. SQL028:402–417,451–458 and SQL050:193–213 provide actual evidence/application state and scope. Lifecycle reversal deactivates application (`copy-trade-lifecycle.ts:2344–2369`) while lot synchronization returns on non-applied evidence (`:2019`), leaving a positive retained lot possible.

The original PNL owner completed the correction in `pnl-queries.ts:217–226`: actual matching acquisition evidence, confirmed/finalized state and active application with evidence/execution/position/account/chain/token/null-safe tenant scope. Disqualified lots do not emit exact ownership fields; `:328–353` retains diagnostic-only fallback. Fresh independent corrected Spec review resolves the prior High with zero new findings or scope creep, high source confidence. The corrected Standards predecessor encountered provider rate limits twice without a verdict. A fresh narrow independent reviewer completed zero documented violations and zero actionable smells on the actual corrected source/test ranges. Both corrected review axes are now complete within this producer scope. This is distinct from the separately assigned lot claim proof defect; source owners do not overlap. No historical repair, source verifier enablement or deployed-invalid-data claim.

## Verified evidence and limits

Main validated40current source/evidence/related hashes, raw literal manifests and recorded runner exits. Original missing-fields regression remained unchanged: fresh17pass1fail/2 then final21/2; safe70/5 includes lot32/exits6/allocator4/math13/stoploss15 and does not supersede historical65pass1fail4manifest. Focused source+test ESNext/Bundler noEmit512exit0, structural/mock checks only. No PostgreSQL arithmetic/RLS/concurrency, current policy/scorer startup claimExit/worker/signing/settlement/history certification. 

## Acquisition-proof evidence validation

The independent read-only evidence validator checked the full final report `package14-acquisition-proof-20261114.report.json` against SHA256 `44676d0c9fa5afdd3257e224e2880f0e302bb7e328f74df29c15f4ac6b1445f2`:78 recursive comparisons across47unique paths plus12baseline-content validations and the report pin,91logicalhash checks total,0missing/mismatches/byte discrepancies. Embedded diffs exactly match baseline-to-current source. Owned PNL/test hashes remained stable; later lot-owner changes to compiler-transitive lifecycle/allocator files must be qualified as temporal drift, not evidence corruption.

Actual raw results and unique runner records agree: red-a21pass12fail/2; green-b and green-c33pass/2 each; safe neighbors-d38pass/4; source-test-noemit-e-640exit0/0diagnostics/25projectfiles/311total listed files. The final retained green manifests deduplicate to65passed/5distinct files; this is a union of overlapping green manifests, not a new combined execution. Exact counts use individual assertionResults, not numTotalTestSuites. Historical malformed commands.jsonl line11 remains untouched.

The12 negative fixtures in `pnl-queries.test.ts:364–406` use generated-SQL predicate checks at an inert mocked DB boundary; they do not execute PostgreSQL or certify semantic transitions. Strict ESNext/Bundler noEmit uses real-source aliases, not stubs, and does not certify emitted NodeNext/dist or deployed schema/RLS. ClaimExit startup wiring, current authority, locked reservation, financial settlement and history remain open. Independent review and source/mock checks resolve only this producer finding, not package14.
