# Wave 3 acceptance — core feature domains

**ACCEPTED: local source and injected offline contracts only.** Independent final gate: [WAVE3-FINAL-RECHECK.md](WAVE3-FINAL-RECHECK.md). Raw evidence: [WAVE3-FINAL-EVIDENCE.json](WAVE3-FINAL-EVIDENCE.json). Runtime, live capability and production readiness remain false.

## Final verification

| Domain | Raw assertions passed | Distinct literal files | Failures |
| --- | ---: | ---: | ---: |
| E — custody/delegation | 249 | 10 | 0 |
| F — withdrawal/venue reducing | 165 | 8 | 0 |
| G — exact LP paper operations | 160 | 14 | 0 |
| H — API/web contracts | 168 | 16 | 0 |
| **Total** | **742** | **48** | **0** |

Zero skipped, pending or TODO assertions. Counts are from final `assertionResults`, not suite totals; repeated runs are not added. All four final suites exited0 with unchanged inputs and no timeout. Final test/typecheck input manifests share SHA256 `2275a5a019d9d62585f31b6ec5c7c6b7157bb3ca6c14d6d0ba1e1561ce1965de`.

Final DB and trade-executor emits exited0, with 400 and 440 hash-verified emitted artifacts respectively. API, web and LP typechecks exited0. The separate bounded runner unit check passed; its Python tests are not counted among the742 Vitest assertions. Every test/emit/typecheck ran foreground and sequential under CPU0 `flock /tmp/swat-package11-checks.lock`; tests used512MB/one fork, compilers640MB. No root turbo or full Next production build ran.

Actual runner grammar includes a required immutable evidence label:

```bash
taskset -c 0 flock /tmp/swat-package11-checks.lock python3 -I /root/SWAT/scripts/build-completion-runner.py build-w3-final-e-tests-01 test threats/project-completion-20261117/w3-e.config.ts --evidence-dir threats/project-completion-20261117
```

Labels above already exist and must not be reused. Full commands, elapsed times, source/tool/config/log/result/artifact hashes and preserved failed attempts are recorded in the evidence directory. Five earlier failed attempts were repaired and retained; this acceptance does not claim the first runs were green.

## Source completion and independent review

- E: wrap-only enrollment separated from execution unwrap, sealed-private projection, finite scoped deployed policy, full signed scope, revocation lifecycle/session deadline and writer governance; review WAVE3-E-RECHECK plus final affected fixture reconciliation.
- F: exact fee denomination/funding, OTP atomic durable outbox, receipt-backed reducing, same-intent fee-only settlement after zero exposure, post-lock wall-clock expiry/cancel checks and independent collateral mapping; review WAVE3-F-RECHECK2.
- G: canonical microdollar/rawscale arithmetic, immutable acquisition retry snapshot, receipt-backed close/rebalance, trusted copy mint/risk/budget, completed-INSERT schema bypass repaired; review WAVE3-G-REVIEW plus WAVE3-G-RECHECK.
- H: final fee/cancelled DTO join, exact LP transport and controls, persisted ambiguous retry fence and honest capability states; review WAVE3-H-FINAL-REVIEW plus final compilation/fixture integration reconciliation.

Coordinator changes and verification repairs: [WAVE3-INTEGRATION-REPAIRS.md](WAVE3-INTEGRATION-REPAIRS.md). Historical reviewer hashes are historical snapshots; supported final changes are explicitly reviewed in WAVE3-FINAL-RECHECK, not silently attributed to old reports. Waves1/2 were not rerun or reclassified.

## Integrated migration sources — NOT applied

- `packages/db/sql/081_custody_grants_delegation.sql`
- `packages/db/sql/082_withdrawal_reducing_intent.sql`
- `packages/db/sql/083_lp_exact_paper_operations.sql`

All three are byte-identical to reviewed proposal sources. No SQL migration, role provisioning, database connection, live wallet/trading, external provider activation, signing, broadcast, commit or push was performed. Isolated PostgreSQL16/Redis qualification remains Wave4; native/release gates remain Wave5.

## Explicit retained limitations

Acceptance does not certify PostgreSQL triggers/RLS/privileges/concurrency/crash atomicity, deployed Redis queues, external trusted funding/collateral/quote/receipt/master/risk evidence, cryptographic remote signer boundaries, browser rendering, multi-tab/multi-device recovery, native builds or live execution. Providerless defaults remain unavailable. Legacy numeric LP lists remain observation-only; exact aggregate lists, fractional subscription-budget creation, exact auto-rebalance consent mutation and aggregate close-all capability remain uncompleted/unavailable rather than fabricated. Unsupported copy effects and live financial execution remain refused.

Final evidence SHA256: `208bc9574a618c7ec400c243c829fcb40e8fb2cd7e8867e74511da0d94266ad5`.
