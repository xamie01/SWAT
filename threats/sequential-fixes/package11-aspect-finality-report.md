# Package 11 — confirmation and historical safeguards aspect

Coordinator record of the finality owner's returned full final report, 2026-11-13. Baseline/HEAD: `8905505595802c21053118b5fab3fd53a8a1654c`. Source-only feasible safeguards were delivered; confirmation and copying remain deliberately unavailable. **Package 11 is in-progress; no historical repair or runtime finality certification is claimed.** The owner returned this report directly, without writing Markdown.

## Owned files

- `packages/db/src/copy-trade-lifecycle.ts`
- `packages/db/src/copy-trade-lifecycle.sequential.test.ts`

No peer-owned source, executor, SQL, configuration, ledger or harness was changed by this owner. Line citations below are the owner's read-time checkpoints and can move during integration.

## Findings and corrections

### Unauthenticated source confirmation/application — High, Verified source and mocked regression

Caller-labelled applied states and evidence text were not a legitimate verifier. `recordSourceTradeEvent` now accepts observed intake only; non-observed intake rejects before persistence. `advanceSourceTradeConfirmation` rejects every request before storage access, including same-state and observed requests. No certificate parser, trusted prefix, environment switch or caller override was introduced. `getSourceConfirmationReadiness()` returns `{ready:false, reason:'source-confirmation-verifier-unavailable'}`.

Citations: `copy-trade-lifecycle.ts:284–296,440–450,566–575`.

This is safe containment, not a verifier or production promotion/reversal implementation.

### Observation replay reapplied historical confirmation — High, Verified source and mocked regression

Corrected intake inserts using the canonical identity key, locks/selects the existing row, checks immutable payload, rejects collisions, and appends idempotent observed provenance. It preserves the historical stored event state and economics, returns `position:null` and `eligibleForCopy:false`, and does not activate/rebuild source positions. Obsolete private source confirmation/application/rebuild helpers were removed.

Citations: `copy-trade-lifecycle.ts:548–562`; repeated replay matrix at `copy-trade-lifecycle.sequential.test.ts:155–205` covers observed/confirmed/finalized/reversed states, insertion, historical reads and collision rejection. Mocked writes are not PostgreSQL transaction/trigger acceptance.

### Historical labels independently enabled fresh copying — High, Verified source and mocked regression

Candidate enumeration returns no candidates without querying or mutating history. Source-signal insertion and direct copy requests refuse despite historical applied state. Fresh execution claims return null execution, false created/claimed and explicit unavailable-verifier reason. This global fence covers all namespaces, including legacy hashes and the new ambiguous Data API group.

Citations: `copy-trade-lifecycle.ts:642–658,806,1244,1611–1623`.

### Immutable comparison omitted fee — Medium, Verified generated SQL; server unrun

Added `AND fee_usd IS NOT DISTINCT FROM $13::numeric`, preserving null versus zero. Citations: `copy-trade-lifecycle.ts:518`; test `copy-trade-lifecycle.sequential.test.ts:145–153`. This verifies generated SQL/binding, not actual server enforcement. Condition/outcome/title are not part of the persisted immutable tuple.

## Actual verification

All checks used CPU 0, shared flock and offline guarded runner, with no infrastructure suites. Evidence resides in this directory; test labels have log/JSON files.

| Label(s) | Actual result |
|---|---|
| package11-finality-history-replay-red / green | 1 failed, then 1 passed |
| package11-finality-intake-authority-red / green | 3 failed, 1 passed; then 4 passed |
| package11-finality-transition-authority-red / green | 4 failed, 4 passed; then 8 passed |
| package11-finality-candidates-red / green | 1 failed, 8 passed; then 9 passed |
| package11-finality-downstream-red-complete / downstream-green-rerun | 6 failed, 9 passed; then 15 passed |
| package11-finality-fee-collision-red / green | 1 failed, 15 passed; then 16 passed |
| package11-finality-readiness-red / green | 1 failed, 16 passed; then 17 passed |
| package11-finality-replay-neighbors | 46 passed / 3 files |
| package11-finality-reviewed-neighbors | 69 passed / 5 files |
| package11-finality-final-neighbors | 69 passed / 5 files, zero failures/skips |
| package11-finality-typecheck-640 | Focused source exit 0, before helper cleanup |
| package11-finality-reviewed-typecheck-640 | Final source plus owned test noEmit exit 0, 640 MB |

Final neighbors comprise 24 owned DB, 17 adapter, 5 identity sequential, 14 Solana and 9 Robinhood tests. Scoped whitespace check passed. Counts are checkpoints, not additive totals.

Imperfect attempts remain preserved: initial `package11-finality-downstream-red` lacked copy-position fixture responses and did not prove successful execution creation. Complete red supplied them. Initial `package11-finality-downstream-green` had two failures from a test detector treating `SELECT FOR UPDATE` as a write; the distinct green-rerun anchored actual statement starts and passed.

Bounded self-review reported zero remaining hard standards findings or feasible-scope defects after helper cleanup. Independent Standards/Spec review was deferred to stable integration; no independent approval is claimed here.

## Integration and remaining gates

The return type is `position:PositionRecord|null`, `eligibleForCopy:false`, preserved canonical event and unchanged inserted semantics. Production adapters do not consume the position. No export patch is needed: `packages/db/src/index.ts:20` already wildcard-exports the lifecycle module/getter.

The integration fixture that immediately derives candidates after observed persistence is deliberately incompatible with containment. It was **not run**. Do not invent trusted confirmation to restore its prior expectations.

`packages/db/sql/028_copy_execution_lifecycle.sql:196–234` enforces enum transitions and evidence text, not legitimate verifier authority, payload binding or replay consistency. Application fences do not secure raw SQL authority. No production verifier/promotion caller or transactional publication outbox was found. Future restoration needs reviewed authority bound to chain, identity, economics and state, atomic application/reversal/publication, and independent fill identity. Robinhood finality remains unverified (`docs/adr/0006-robinhood-sequencer-trust.md:230–237`).

Historical source rows, rounded payloads, applications, positions, signals and executions remain untouched/readable. Future authorized audit should inventory these and propose corrections, not automatically demote/delete/rewrite/reverse history. Fee schema remains `NUMERIC(16,6)` (`062_source_trade_fees.sql:3–4`), and the older immutability trigger omits fee (`028_copy_execution_lifecycle.sql:170–194`). No schema or historical precision repair occurred.

**High, verified source bypass, later package:** existing-execution replay still returns before the fresh fence (`copy-trade-lifecycle.ts:1604–1608`); the executor consumes that returned execution (`apps/trade-executor/src/index.ts:1219–1234`). Retry/submission behavior was intentionally untouched and not exercised or certified.

No live calls, credentials, DB/Redis operations, services, applied migrations, signing, orders, deployment, commits or pushes occurred.
