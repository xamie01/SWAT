# Package 11 — independent integrated review

Date: 2026-11-13. Coordinator record of returned independent read-only Standards and Spec reports and limited corrected-source rechecks. Reviewers did not edit or run tests/compiler/live calls. **Four original Medium residual findings were corrected and both independent rechecks report zero remaining supported findings at those boundaries.** The final 489/42 gate and focused source/test noEmit640 evidence were inspected, not rerun by reviewers. This is bounded source approval of the corrections, not full-HEAD/runtime or financial acceptance; package11 remains in-progress.

## Standards findings

1. **Medium, high source confidence: timer-only trade-page deadline can accept late completion.** `apps/indexer/src/polymarket.ts:125–135,158–179,255–257` uses a timer race without monotonic checks after reads, synchronous JSON parsing or return. Delayed event-loop scheduling can permit completed rows after deadline and clear an overdue timer. Add captured monotonic deadline/checks before requests, after fetch/read/parse and before return, preserving disposal/abort. Not a runtime failure or economic bypass proof; introduced attribution was not established because this reviewer could not use git/diff.
2. **Medium, high source confidence: missing market state becomes affirmative metadata.** `polymarket-helpers.ts:218–225` defaults absent/malformed closed to false and acceptingOrders to active-and-not-closed; missing resolution to unresolved. `polymarket.ts:468–501` can persist/compare those synthesized defaults. Require explicit supported boolean state evidence/alias validation before persistence and retain unknown resolution when absent. Not a newly demonstrated finality bypass.

Standards reviewer reported no supported blocker of existing quarantine/no-economic-settlement. It reviewed a bounded source snapshot, not all audit modules or runtime deployment.

## Spec findings

1. **Medium, high source confidence: ordinary failures retain unknown completeness.** `polymarket.ts:546,562–565,661–675,678–711` increments failed for malformed trades/context conflicts but constructs unknown evidence; tracker `ingestion-health.ts:90–99` forwards unchanged. Known processing failure must qualify partial. Add direct and tracked tests, preserving counters/scope.
2. **Medium, high source confidence: metadata priority silently discards conflicting safety/provenance aliases.** `polymarket.ts:336–348,368–377,423,443–452`; `polymarket-helpers.ts:194–215`. For example negRisk false plus neg_risk true, a scalar tick with malformed/conflicting secondary tick alias, or matching conditionId with contradictory condition_id. Validate every explicitly supplied supported alias before projection; normalize/check agreement and reject malformed/conflicting values across Gamma/CLOB/fallback. Post-write comparison cannot detect discarded evidence.

## Snapshot drift and disposition

Review began at `99c0e16469934b235372df342de8abc8a2c1a155` and observed another external HEAD change to `08c822d470554ef1f05e701b1abbed7dcb3dbc54`. Spec's read-only comparison found no reviewed source/config changes between commits or scoped working-tree differences. Standards saw earlier full-scope fingerprints agree and five key hashes unchanged at drift detection, then stopped without recovery/repinning. **This is not final-current-HEAD approval.** No git recovery/mutation performed.

All four findings were relayed to the integration owner and corrected with failing regressions, minimal roots and actual final checks. Historical initial reviews remain above; final limited rechecks follow.

## Final limited corrected-source rechecks

**Standards: zero remaining supported findings.** Monotonic reader checks at `polymarket.ts:129–134,161–204,271–276` close timer-only late-success; cancellation/disposal retained. Four before-timer-dispatch tests at `polymarket.test.ts:889–930`. Explicit lifecycle evidence/unknown resolution at `polymarket-helpers.ts:185–187,267–272` closes affirmative defaults. Alias validation at :192–235 and provider :337–419 has no supported introduced defect; validation errors cannot trigger alternate-provider fallback.

**Spec: both original findings resolved, no supported introduced root defect at touched boundaries.** Direct partial evidence at `polymarket.ts:535–537,669–702` and tracked returned/recorded qualification at `ingestion-health.ts:90–105` preserve counters/scope and do not mutate caller evidence. All supplied supported aliases are validated at `polymarket-helpers.ts:190–235`; Gamma/CLOB/tick boundaries `polymarket.ts:353–419,438–441` reject contradictions terminally. Explicit lifecycle and unknown resolution :263–272 are retained.

Both reviewers inspected, not reran, final `package11-review-final-guarded.json`: **489 passed/42files/zero failures/skips**, plus retained red/green and source/test noEmit exit0 evidence. HEAD stayed `08c822d470554ef1f05e701b1abbed7dcb3dbc54` throughout rechecks. All three supplied source SHA256 hashes matched at start/finish; inspected test hashes stable. No edits, test/compiler/live execution or recovery by reviewers.

This closes only the four findings and directly touched neighbors. It does not certify all current HEAD content, independent financial functionality or runtime readiness.

Native identity/verifier/promotion, historical repair, schema/runtime acceptance, legacy precision and known existing-execution retry bypass remain qualified/deferred, not counted as introduced review findings. Original review results and earlier red/green artifacts remain preserved.
