# Package 11 — ingestion evidence and readiness aspect

Coordinator record of the health owner's returned final report, 2026-11-13. Baseline/HEAD: `8905505595802c21053118b5fab3fd53a8a1654c`. Source implementation delivered; **runtime readiness remains withheld and package 11 in-progress**. Owner returned report directly, without Markdown creation.

## Root correction

**Medium severity; verified source and mocked regressions.** Recent events/error-free batches previously implied health while quarantine appeared only as skipped, hiding the deliberate acceptance outage.

Implemented optional typed batch evidence with observed/quarantined/accepted counters, scoped completeness unknown/partial/complete, confirmation unknown/withheld, readiness unknown/blocked. No verified/ready shortcut exists. Snapshots distinguish eventFreshness; recent observations are unready, not lag-only healthy. Fatal IngestionBatchError.result is partial at direct/tracked seams without changing numeric counts. Optional JSONB persistence preserves legacy recording when schema absent and projects unknown/null, not invented zero/verified. Latest evidence is independently selected per source so one batch cannot hide another source's withheld evidence.

## Owned source and tests

Read-time citations, which can move during integration:

- `apps/indexer/src/ingestion-health.ts:4–24,35–37,43–100`: helper, error qualification and recorder forwarding.
- `apps/indexer/src/index.ts:238–254,495–602`: optional outcome callback preserves existing result string/quarantine-before-enrichment; backfill evidence.
- `apps/indexer/src/evm.ts:169,308–314,546–547`: Polygon first-step refusal preserved; lifecycle counting.
- `apps/indexer/src/webhook.ts:79–83,115–116`: webhook evidence.
- `packages/shared/src/ingestion-health.ts:26–57,61–94,130–162`: runtime validation, projection and truthful freshness/readiness.
- `packages/db/src/ingestion-health.ts:48–80,126–191`: schema-compatible record and per-source projection.

Corresponding health/lifecycle tests updated, including new indexer/shared/DB ingestion-health.sequential.test.ts files. Old owned shared/DB tests were adapted to transaction mocks and no lag-only health, but guarded selection did not automatically include those old filenames.

## Counter semantics

Existing inserted/skipped/failed, wallet/webhook counts and insert ratio keep their meanings. Quarantine is a subset of skipped. Evidence is per processing observation/attempt, not distinct DB rows; replay can count again. Accepted means explicit lifecycle eligibility, independent of legacy insertion success; current observations never become accepted.

Null Solana bodies, fetch/process failures and signature-limit saturation yield partial. Otherwise successful bounded fetching stays unknown absent explicit coverage contract. Complete paging never establishes confirmation. Legacy lastSuccessAt remains historical error-free-batch time, not health authority. Evidence aggregates are null when any batch is missing/invalid or numeric totals unsafe.

## Actual verification

All tests/compiler used CPU 0, mandatory flock and guarded synthetic mocked dependencies. Evidence lives in this directory; separate checkpoints are not additive.

| Label(s) | Actual result |
|---|---|
| package11-health-evidence-red / green | Missing forwarded evidence reproduced; then 1 passed |
| package11-health-lag-only-red / green | Recent events falsely healthy reproduced; then 1 passed |
| package11-health-db-evidence-red | Incomplete inherited COMMIT fixture; not root proof |
| package11-health-db-evidence-red-complete / green | Completed fixture lost persisted evidence; then 1 passed |
| package11-health-db-projection-red / green | Missing source/counter projection; then 2 passed |
| package11-health-callers-red / green | 2 failed, 18 passed; then 20 passed |
| package11-health-neighbors | 39 passed / 7 files, no skips |
| package11-health-direct-error-red | Complete vs partial direct error; 1 failed, 2 passed |
| package11-health-reviewed-neighbors | 40 passed / 7 files, zero failures/skips |
| package11-health-reviewed-typecheck-640 | Focused source noEmit exit 0, zero diagnostics |

Compiler roots included all six modified source modules/current shared/DB aliases. Owned whitespace check passed. No full suite/runtime SQL acceptance. Bounded self-review found/corrected direct-error completeness; no independent two-agent approval claimed.

## Integration handoff

Polymarket peer already wired observedIngestionEvidence and counters into success/empty/fatal results. The health owner did not edit that file or independently certify its provider tests. Preserve static source verifier-unavailable fence; never infer confirmation from historical state, labels, receipt success, heights, slots or counts. Shared/DB existing wildcard exports already expose health.

### Optional UNAPPLIED schema

Current table: `packages/db/sql/015_audit_schema_repairs.sql:71–82`. Proposed new forward migration, **not applied or created by owner**:

```sql
ALTER TABLE ingestion_health_batches
  ADD COLUMN IF NOT EXISTS evidence JSONB;
```

Absent column/type means truthful unknown. DDL does not establish runtime grants/topology or DB readiness.

### Alert-service caller adaptation reserved for integrator

`apps/alert-service/src/ingestion-health.ts:49–53,65–68,83–85` needs display state HEALTHY only on legitimate recovery, NO DATA for empty, UNREADY for unready, otherwise STALE. Preserve existing nonhealthy DB reservation target stale for compatibility. Render readiness/completeness/confirmation and observed/quarantined/accepted; null evidence is unknown, not zero. Adapt old lag-only recovery tests and explicit snapshot fields (`ingestion-health.test.ts:68–108,112–126`). Owner left these files untouched.

API `apps/api/src/index.ts:353–359` already invokes the shared snapshot builder, so additive fields/unready propagate without implementation change.

Trusted promotion/reversal/republication, historical repair, durable schema/grants/topology, production/provider compatibility, query/resource acceptance and later existing-execution retry bypass remain unresolved. Polygon refusal, Robinhood net quantity and Solana quarantine-before-enrichment remain intact.

No production changes, live provider/DB/Redis calls, credentials, services, applied migrations, signing, orders, deployment, commits or pushes occurred.
