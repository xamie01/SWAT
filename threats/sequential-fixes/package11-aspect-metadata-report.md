# Package 11 — metadata freshness and persistence aspect

Coordinator record of the metadata owner's returned final report, 2026-11-13. Backfill containment is implemented and locally verified; **package 11 remains in-progress, not runtime-certified**. The owner returned report text directly. Read-time line citations can move during integration.

## Owned changes and corrected findings

Only `apps/indexer/src/polymarket.ts` and `polymarket.test.ts` were changed. The old resolution polling function and its describe block were deliberately untouched for the integration owner.

| Finding | Severity / confidence | Correction |
|---|---|---|
| Historical contextComplete bypassed retrieval without provenance | High / Verified source and mocked tests | Remove historical-cache trust. Retrieve provider metadata each backfill; reuse only operation-local validated per-asset snapshots. Source :420–446,549–550; tests :129–145,250. |
| Persisted context could conflict with retrieved safety/mapping evidence | High / Verified source and mocked tests | Compare completeness, token, condition, outcome/index, risk, tick, end-date and market state before wallet/source continuation. Source :478–499; eleven tests :225–248. |
| Duplicate mappings and fabricated CLOB condition provenance | High / Verified source and mocked tests | Reject duplicate tokens/case-insensitive outcome labels and require explicit matching CLOB condition_id. Source :389–400,447–457; tests :148–177. |
| Nonscalar tick coercion allowed true/arrays | High / Verified source and mocked tests | Effective Gamma/CLOB/fallback tick must be a number or decimal string before parsing/upsert; refuse boolean/array/object evidence before writes. Source :440–446; tests :110–118. |
| Late DB completion continued after operation deadline | Medium / Verified source and mocked tests | Await ownership, then check monotonic deadline before/after context, wallet and source boundaries. Source :459–480,565–589; four tests :179–222. |
| Quarantine lacked explicit health evidence | Medium / Verified source and mocked tests | Count observed/quarantined/accepted separately; keep quarantine within skipped and acceptance independent of legacy inserted. Source :534–540,581–589,657–659,672–678. |

Exact numeric wire tokens, decimal normalization, BigInt multiplication, atomic conversion, subatomic refusal, observation quarantine and shared HTTP request/time/byte limits remain intact. Health helper evidence is attached to success, empty and fatal results, with unknown provider-pagination completeness and withheld confirmation.

## Actual checks

CPU 0, shared flock, offline guarded synthetic runner. Evidence lives in this directory. Passed/failed/skipped are separate checkpoint counts.

| Label | Passed / failed / skipped |
|---|---|
| package11-metadata2-historical-cache-red | 0 / 1 / 40 |
| package11-metadata2-historical-cache-green | 1 / 0 / 40 |
| package11-metadata2-local-reuse-red | 0 / 1 / 40 |
| package11-metadata2-local-reuse-green | 1 / 0 / 40 |
| package11-metadata2-persisted-validation-red | 0 / 11 / 41 |
| package11-metadata2-persisted-validation-green | 11 / 0 / 41 |
| package11-metadata2-db-refusal-red | 0 / 4 / 52 |
| package11-metadata2-db-refusal-green | 4 / 0 / 52 |
| package11-metadata2-clob-provenance-red | 0 / 1 / 56 |
| package11-metadata2-neighbors-green (4 files) | 138 / 0 / 0 |
| package11-metadata2-ambiguous-mapping-red | 0 / 2 / 57 |
| package11-metadata2-health-bridge-red | 0 / 1 / 60 |
| package11-metadata2-reviewed-neighbors-green (5 files) | 147 / 0 / 0 |
| package11-metadata2-tick-shape-review-red | 1 / 2 / 62 |
| package11-metadata2-tick-shape-review-red-complete | 1 / 2 / 62 |
| package11-metadata2-tick-shape-review-green | 3 / 0 / 62 |
| package11-metadata2-final-neighbors-green (5 files) | 150 / 0 / 0 |

`package11-metadata2-reviewed-typecheck-640` and final `package11-metadata2-final-typecheck-640` both exited 0. Final neighbors contain 65 Polymarket, 15 paging, 49 helper, 17 lifecycle and 4 health tests. Owned whitespace check passed. No full suite was run.

The initial tick fixture flattened an array; the distinct red-complete genuinely reproduced coercion. The historical-cache red also encountered a transient peer lifecycle reference error; its fetch-count assertion established cache bypass, not successful observation persistence. CLOB/mapping/health corrections passed subsequent neighbors. Earlier moving identity/polling neighbor reds remain historical evidence, not overwritten.

Bounded self-review found and corrected nonscalar tick coercion. No independent review-agent pass is claimed.

## Provenance and DB deadline limits

Provider retrieval is current-operation endpoint evidence, **not** venue-origin freshness, trade-time historical correctness, cryptographic provenance or finality. No invented TTL/timestamp was added. The actual adapter `packages/db/src/polymarket.ts:72–86,216–259` exposes no retrieval evidence; upserts :128–213 set completeness/mutation timestamps. It was not edited. Shared rows remain mutable; the operation-local snapshot is not a global certificate. Other consumers and historical rows were not repaired.

There is no detached DB `Promise.race` and no DB cancellation claim. Stalled awaits can exceed the deadline indefinitely; once complete, downstream continuation refuses. Already-issued context/wallet/source writes can finish late and cannot be cancelled/undone here. Successful late observation writes are counted before refusal. Initial collateral-token upsert precedes paging and the metadata deadline. The dormant accepted legacy continuation remains uncertified. `packages/db/src/client.ts:17–77` offers no operation cancellation seam.

## Integration contract

Exported bridge from `polymarket.ts:34–68,314` supplies FetchImplementation, budget/error types, createMetadataBudget, fetchGammaMarket and isPolymarketMetadataBudgetError. Inject these into the standalone polling scheduler without duplicate HTTP policy or circular import.

Integrator must replace inherited `pollPolymarketResolutions` at the owner's :715 checkpoint and its old tests with the bounded durable store/scheduler and `interpretMetadata:withholdUnverifiedResolution`. `settleCovered(null)` records finite metadata enumeration only, never winner/economic finality. Passing old closed-plus-price winner tests is compatibility, not safety acceptance. Health counter wiring is already implemented.

No DB adapter/schema/config/ledger/harness edits by this owner. No live provider/DB/Redis calls, credentials, services, applied migrations, deployment, signing, orders, commits or pushes occurred.
