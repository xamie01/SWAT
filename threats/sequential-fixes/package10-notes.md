# Package 10 — successful, attributable Solana ingestion

Status: **source-fixed-runtime-blocked**, with explicitly limited route coverage. No deployed-provider, venue, signing, database or custody acceptance is implied. Findings PF-DATA-01/02/03; prior IDX-01/02/03.

## Implemented source invariants

- Canonical parsing requires explicit successful execution (`meta.err === null`), identity/time, a supported swap discriminator/opcode and indexed wallet-owned accounts participating in the invocation.
- SPL transfers under the selected top-level invocation must reconcile with each owned token account's exact transaction-boundary change. Program IDs take precedence over fallback program labels; contradictory IDs cannot supply token provenance.
- Wallet and owned-account native custody changes, with the actual payer's fee removed, must reconcile with evidenced System/native-token transfers under the same invocation. Unrelated SOL spending cannot inflate a swap leg.
- Exactly two nonzero economic mint deltas, one debit and one credit, are required. Raw cross-mint integer ranking is removed; units remain integer strings. Same-mint decimals must agree. Missing/unsafe native data and malformed amounts/times refuse ingestion rather than inventing zero.
- Enhanced conversion preserves actual fee-payer ordering, execution result, indexed accounts, instruction data and invocation grouping. Raw System Transfer, SPL Transfer and TransferChecked CPI layouts are decoded with bounded base58 data, exact layout checks and exact u64 amounts. SWAP labels alone do not create evidence.
- Actual ingestion rejects unsupported observations before canonical writes/publication. Valid raw/enhanced deterministic observations preserve their literal expected quantities.

Code: `apps/indexer/src/parse.ts`, `webhook-helpers.ts`, `index.ts`; public-seam tests in `parse.sequential.test.ts`, `webhook-helpers.sequential.test.ts`, retained parity and source-lifecycle suites.

## Evidence (original files retained)

- Established reds: success/legs/enhanced/native/review/missing-native/flow checkpoints; most recent `package10-native-flow-red`, `package10-program-identity-red`, `package10-raw-cpi-red` reproduce unrelated native spending, contradictory token IDs and raw enhanced CPI rejection respectively.
- `package10-raw-cpi-setup-bounded.json`: **79 passed**, 8 indexer files.
- `package10-reviewed-bounded-final.json`: **220 passed**, 26 selected sequential/neighbor files, zero failures/skips; not the full monorepo suite.
- `package10-reviewed-typecheck-640.log`: focused parser/adapter source typecheck passed at 640 MB. This excludes full indexer/backend compilation.
- Targeted `git diff --check -- apps/indexer/src` passed.
- All executions CPU 0, one worker, synthetic/offline guard. No real DB/Redis/provider connection, credential reads, signing, orders, services, migrations, deployment, commit or push.
- Earlier 10-second budgets produced webhook setup timeouts (and later one billing cold-import test timeout). Those failed JSON/log files remain; successful bounded reruns used **30-second hook/test budgets** without changing assertions, workers, CPU affinity or application behavior.

## Review and remaining acceptance gates

Standards-axis read-only worker found no established documented-standard breach, a repeated-validation heuristic, contradictory token identity and enhanced raw-CPI incompatibility. The latter two were reproduced and corrected. Spec-axis worker failed provider token rate limits; no independent spec pass is claimed. Coordinator checked the package against PF-DATA-01/02/03 and strengthened the third-asset regression so it contains otherwise valid indexed/flow/native evidence rather than being rejected incidentally for missing indexes.

**Capability limitations / NOT VERIFIED:**

- Nested supported programs fail closed without a decoded invocation boundary. Setup/closure/wrap-and-swap transaction-boundary changes may not match only swap CPIs and are refused. This is containment, not complete ordinary WSOL-route support.
- Native custody accounting accepts the constrained evidenced transfer shapes only. Account creation/close layouts, rent ownership graphs, transfer-fee extensions and provider completeness require further independently accepted fixtures/decoders; ambiguous effects are not certified.
- Provider instruction fields and allowlisted deployed program identities/full ABIs were not checked against live receipts. Synthetic raw CPI fixtures prove the supported layouts, not provider certification or full economic route semantics.
- Source finality/advancement/reversal is package 11, not established by successful transaction execution.
- Trust remains in authenticated provider receipt evidence; opcode recognition and simulation are not an owner-approved economic signing policy.

Do not enable production copying merely because this bounded source stage is recorded complete. Preserve these limitations in final per-ID dispositions.
