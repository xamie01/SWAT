# Package 11 — integrated source remediation report

Date: 2026-11-13. Status: **IN-PROGRESS**. Six concurrent aspect owners completed feasible source safeguards; a separate integration owner connected the public polling and health callers. This coordinator report records their final delivered findings and evidence. Independent integrated Standards/Spec review is pending at this checkpoint.

## Outcome

The final permitted offline selection passed **444 tests / 42 result files, zero failures/skips**, and focused source-and-test noEmit passed at 640 MB. This is not repository-wide build/test, installed DB acceptance, venue certification or production readiness. Current source observations, fresh copying and economic settlement remain deliberately unavailable without legitimate confirmation authority.

## Integrated behavior

- Polymarket identity is an explicitly ambiguous transaction/wallet observation group, not an invented independent fill ID. Contradictory/malformed wallet/transaction aliases reject. Exact wire decimals and BigInt economics remain authoritative.
- The DB lifecycle refuses applied/reversed intake and all confirmation advancement without a legitimate verifier. Observation replay preserves historical event state, appends observed provenance and never reapplies/rebuilds positions. Position is null and eligibility false. Fresh candidate/signal/request/claim paths remain fenced. Fee is added to immutable SQL comparison, including null semantics.
- Metadata ignores historical complete-cache trust. It retrieves each backfill and reuses only operation-local validated per-asset snapshots; validates post-write context, explicit CLOB condition evidence, unique mappings and scalar tick shape. Owned DB awaits are checked before/after deadline but not cancelled or abandoned.
- Whole polling now uses bounded finite-keyset durable lease/cursor storage, shared network budget and pessimistic pre-network attempt reservations, avoiding poisoned-prefix starvation. Missing schema fails closed; no unbounded/in-memory fallback. Economic application is no-op. The public wrapper rejects partial coverage or economic blockage even when metadata enumeration completes. Price >= .99 no longer produces a winner.
- Health reports observed/quarantined/accepted processing counts, scoped coverage and withheld/unknown confirmation. Recent observations are unready, not ready based on lag. Missing optional evidence schema yields unknown/null. Source-specific evidence prevents one source hiding another. Fatal results are partial. Alert display says UNREADY and prints unknown rather than invented zero counters.

Integration-owner citations: `apps/indexer/src/polymarket.ts:714–732`, `packages/db/src/index.ts:15`, `apps/alert-service/src/ingestion-health.ts:50–77`. Poll startup/interval logging remains at `apps/indexer/src/index.ts:671–677`; alert delivery integration at `apps/alert-service/src/index.ts:90–106`; API already uses shared snapshot at `apps/api/src/index.ts:353–359`. Line citations are read-time checkpoints.

## Aspect reports

- [Identity](package11-aspect-identity-report.md)
- [Confirmation/history](package11-aspect-finality-report.md)
- [Metadata](package11-aspect-metadata-report.md)
- [Polling](package11-aspect-polling-report.md)
- [Health/readiness](package11-aspect-health-report.md)
- [Acceptance and unverifiable gates](package11-aspect-acceptance-report.md)

These record owner self-reviews and actual checks, not independent reviewer approval. Earlier moving neighbor reds were retained; later aggregate evidence is separate, never the sum of owner checkpoints.

## Integration changes

Public polling/store export and alert display implementation; Polymarket/identity/alert tests and minimal return-contract mocks; guarded Vitest safe-neighbor selection; focused typecheck source/test roots; package11 JSON ledger status/evidence. No old aspect guards weakened. No SQL proposal/migration was applied or created by the integration owner.

## Actual integration verification

All test/compiler workloads used CPU 0, shared flock and the credential/network-guarded synthetic runner; one Vitest worker, no file parallelism. Source aliases avoid stale dist but do not attest runtime artifacts.

| Label | Actual result |
|---|---|
| package11-integration-poll-schema-red | Exit 1; 1 failed, 63 filtered skips |
| package11-integration-poll-schema-green | Exit 0; 1 passed, 63 filtered skips |
| package11-integration-alert-evidence-red | Exit 1; 1 failed, 3 passed |
| package11-integration-alert-evidence-green | Exit 0; 4 passed / 1 file |
| package11-integration-focused-green | Exit 0; 104 passed / 6 files |
| package11-integration-source-tests-typecheck-640 | Exit 2; eight test-fixture diagnostics |
| package11-integration-type-fixtures-green | Exit 0; 77 passed / 3 files, including final five alert tests |
| package11-integration-source-tests-typecheck-green-640 | Exit 0; focused source/test noEmit |
| package11-integration-final-guarded | Exit 0; 444 passed / 42 files, zero failures/skips |
| Integration ledger validation labels | Exit 0; evidence paths exist, qualified/pending statuses preserved |

Combined run finished `2026-11-13T22:36:51.890603Z`. Original typecheck/red tests and historical malformed command line 11 were not rewritten. The eight compiler diagnostics were missing mock return fields/undefined mock returns/fetch fixture cast, corrected minimally without changing production policy.

Primary evidence: [test JSON](package11-integration-final-guarded.json), [test log](package11-integration-final-guarded.log), [focused compiler log](package11-integration-source-tests-typecheck-green-640.log), [authority/ledger validation](package11-integration-authority-ledger-validation.log).

## Why package 11 remains open

1. Legitimate native fill identity and trusted confirmation verifier/promotion/reversal/republication/outbox are not implemented or certified. Containment is not financial functionality.
2. Historical source/context/rounded legacy rows, positions, signals and already-issued executions were not audited/repaired/reconciled. No automatic demotion/deletion/reversal occurred.
3. Poll progress/evidence schema proposals and SQL070 remain UNAPPLIED. Global least-privilege indexer capabilities, real PostgreSQL constraints/concurrency/rollback, installed baseline and pool/session topology remain unverified; SQL070 alone does not grant required global capabilities.
4. Hard DB connection/transport cancellation and end-to-end wall-time are unproven. Already-issued writes can finish late. Local HTTP/body budget checks do not attest real infrastructure behavior.
5. Legacy accepted keys/scale18 decimals/Number projections and fee precision/rawSQL authority remain blocked restoration boundaries.
6. Runtime artifacts, full safe build/dependencies/deployed Node/provider compatibility and venue/legal/funded custody gates remain unperformed. Existing infrastructure fixture immediately deriving candidates from observed persistence is unrun and intentionally mismatched. Solana/Robinhood certification files absent; Polymarket NOT CERTIFIED.
7. Generic Polygon financial classifier remains unavailable. Existing-execution early-return retry bypass belongs to a later execution package and was intentionally not rewritten.

Packages01–10 remain source-qualified/runtime-blocked; packages12–29 remain pending.

## External shared-checkout drift

Authority baseline was `8905505595802c21053118b5fab3fd53a8a1654c`. During final verification another process created:

- `5d0558d5530ae7af3ecea2edfb3bda43d0cbccec` at `22:34:22Z`;
- `99c0e16469934b235372df342de8abc8a2c1a155` at `22:35:11Z` (observed current HEAD).

The integration owner verified its integrated source/config matched that HEAD byte-for-byte. The external commit tracked temporary Vitest SSR files subsequently removed by normal cleanup; no manual restore/delete/reset occurred. Therefore do not claim the entire checkout stayed uncommitted or that these commits were this session's release action. This session's agents performed no commits/pushes/reset/clean, installs, live services/provider/DB/Redis operations, credential reads, signing/orders/funds, applied migrations or deployment. Baseline and drift are retained in ledger evidence.
