# Initial explicit harness independent review

Two independent axes dispatched read-only against saved initial harness and CSV test/config. Baseline8905505595802c21053118b5fab3fd53a8a1654c, currentHEAD08c822d470554ef1f05e701b1abbed7dcb3dbc54. Committed three-dot diff425paths excludes these NEWworkingtreefiles; reviewers scoped actual newfiles directly, nofullHEADapproval. Initialhashes harness a9a8d14e6df7ce0f47103be141bbef351774a7d05eb08d1e70dec01b37109c03, CSVconfig2bcd8c2715fcfd6cc395b9e2de335e865059478d99bb14f7572dc356aed42bd0, CSVtesta13368f8dc90d20a02864324027f8f12f41253e2a92d757b56226224eb750ced. CPU0reads only, no tests/compiler/network/mutations.

## Standards

Returned ONE Medium severity/high-confidence finding: literal-path safety lost after canonicalization. Initial harness.ts:20–37,53,81 checks selected glob characters only on supplied path, then returns canonical filename unescaped as Vitest include. Innocuous workspace symlink to existing export*.test.ts can pass input check and become glob selecting additional unreviewed suites; direct @(name).test.ts bypasses incomplete syntax check. Installed Tinyglobby extglob behavior statically read, NOT executed reproduction. Assignment requires literal reviewed selection. Recovery owner must reject all dynamic-pattern syntax on BOTH raw and canonical relative paths or escape for actual engine. Add own inert symlink/path tests, not execute unintended suites. CSV config/test zero findings; zero additional heuristic baseline smells. Initial hashes stable through Standards completion, HEAD unchanged. Recovery correction/recheck pending.

## Spec

Returned ONE Medium severity/high-confidence finding: actual collection/manifest gate unimplemented. Assignment requires actualJSONtestResults match selectedfiles and noCLItestfilters. Initial harness.ts:62–92 only validates requested paths and emits include/default+JSONreporters; run-check.py:43–65 propagateschildexit without actualcollectionvalidation. Viteststatics permit positionalandtestnamefilterreduction, so partialmanifestcouldappeargreen. This is supported missing requirement, NOT observedtestfailure. Recoveryowner5567efd1 assigned minimal correction+selftests/typecheck; corrected-source recheck pending.

No other wrongimplementation/scopecreep found in bounded CSVconfig/test. Literalexistingpaths, workspace/symlinkescape/duplicate/integration-servicesuiterefusal, sourcealiases/emptyenv/setupguard/oneforkworker/maxconcurrency1 supported statically. CSV actualroute/mockDB/injectedprincipal asserts formula anchoredprefixes and escaping, unauthorizedzeroDB; no genericwhitespace/spreadsheetcertification. RetainedCSVJSON17passed/1actualfile/0failed/skipped provisional, compilerNOTRUN. SuppliedhashesstablethroughSpecfinalcheck, historicalconfig/runner/guard matchedHEAD.

## Corrected-source limited independent rechecks (2026-11-14)

Replacement owner retained fresh red (27 passed / 47 failed / 1 actual file, exit1), an intervening pre-collection reporter-import failure, then green (87 passed / 0 failed / 1 actual file, exit0) and focused strict source+test noEmit640 exit0. Exact commands, paths and fingerprints: `package12-29-harness-recovery-final-report.json`. Historical runner/config/guards and earlier evidence unchanged.

### Standards recheck

Fresh independent read-only Standards reviewer found **zero new supported violations or actionable baseline smells**. Original Medium/high-confidence canonical-path glob finding resolved, high confidence. Actual harness lines15–65 reject glob/extglob parentheses/backslashes both before lookup and after canonicalization; unsafe service/integration aliases, escapes and duplicates are rejected. Inert path/symlink selftest fixtures were never executed as suites and left no fixture directory. Direct-neighbor controls supported; no broader Spec approval inferred.

### Spec recheck

Fresh independent read-only Spec reviewer found **zero supported missing/partial requirements, scope creep or directly introduced wrong implementation** in bounded files. Original Medium finding's actual-file and CLI gates resolved. Lines87–159 validate exact absolute nonempty manifests, missing/duplicate/unselected identities and assertion counts/statuses. Lines68–77,185–188 enforce only unfiltered `run --config/-c`. Installed Vitest reporter lifecycle traced: JSON writing awaited before validation/rejection, error exit propagated. Selftests exercise real reporter with inert context/tasks, **not independent child-process negative-path proof**.

Both checked actual JSON/command records, not suite counts. Reviewer reads CPU0, no tests/compiler/network/mutations. HEAD remained08c822d470554ef1f05e701b1abbed7dcb3dbc54. Both fingerprints matched/stayed stable:

- Harness: `89f60f74d9ac0994ac92688ebee6a88b5bf64d3dfc18d841f228652d2e74459e`
- Selftest: `46c0f575eb261603b74ed849412b558e93c4d07461f9d74c2a28b0522e79d4a2`

**Qualified disposition:** initial supported findings resolved, limited Standards0 / Spec0. Factory may now serve independently import-reviewed bounded owner checks under CPU0/shared-flock/heap/unique-label restrictions. No retroactive acceptance of provisional runs, full-HEAD/product/financial-runtime/schema/custody/deployment/venue approval.

## Disposition (initial checkpoint retained)

InitialSpec1finding; Standards1finding, both Medium/highconfidence in different harness boundaries. CSV config/test zero findings on both axes; no full harness pass. No harnessacceptance yet. Factoryselfchecks/actualresultgate/CLIguard/compiler and limitedindependentrecheck still needed. This record does not accept otherpackageprovisionalruns, builds/schema/financialruntime/custody/venues. Allsource/globalauthority gates retained.
