# Package 11 — bounded, fair resolution polling aspect

Coordinator record of the polling owner's returned final report, 2026-11-13. Standalone source implementation is verified in mocked seams; **not yet wired at this aspect's handoff**. Package 11 remains in-progress, with economic resolution deliberately unavailable. The owner returned this report directly.

## New files

- `apps/indexer/src/polymarket-resolution-polling.ts`
- `apps/indexer/src/polymarket-resolution-polling.sequential.test.ts`
- `packages/db/src/polymarket-resolution-polling.ts`
- `packages/db/src/polymarket-resolution-polling.sequential.test.ts`

Existing Polymarket entrypoint/tests, DB barrel, health/config/ledger and quarantine were not edited by this owner.

## Implemented guarantees

The injected scheduler uses bounded keyset pages ordered with SQL `COLLATE "C"`, a durable finite cycle upper key, and lease/cursor/count fencing. A market attempt is reserved and the cursor advanced **before** provider work, pessimistically recording failure. A validated observation settles that failure in a fenced transaction. A crash or poisoned first market cannot indefinitely trap later invocations at the same prefix. Expired/replaced lease owners cannot apply or release replacement ownership. Ordinary provider failures preserve failed coverage but permit later attempts; storage failures reject with structured `ResolutionPollError.result`. No production in-memory fallback exists.

The guarantee is eventual **attempts**, not eventual successful reads, conditional on continuing invocations, working storage, usable budgets and a finite eligible population. Crash-abandoned attempts remain failed for that cycle and can retry in a later cycle.

Defaults: 25 market attempts, page size 25, four page fetches. Caps: 1,000 attempts, page size 100, 100 fetches. Queries return capacity plus one lookahead; tick is in-page, with no per-market cache SELECT. Existing metadata reader remains the sole shared request/time/stream-byte policy. Scan deadline starts before claim; checks occur before/after DB/provider/reservation/settlement/finish/release. At defaults, the store uses at most 57 transactions, including claim, pages, reservations, settlements, finish/release; enumeration queries at most five including upper key. Transaction-local SQL statement/lock timeout is 1,000 ms.

Hard end-to-end wall time remains unproven: connection acquisition, bootstrap, commit/rollback and transport waits are owned/awaited, not actively cancelled. No detached DB promise race was introduced.

`withholdUnverifiedResolution` requires matching condition provenance and explicit boolean closed, returns null, and makes no economic inference. Result `economicResolution:'blocked-unverified-evidence'` is explicit. Complete coverage means successful finite metadata enumeration only, not winner/settlement/finality/snapshot completeness under concurrent mutation or confirmation readiness.

## Required integration

Export the new store from `packages/db/src/index.ts`. Replace the old unbounded polling body, never fall back to it. Inject existing createMetadataBudget/fetchGammaMarket/isPolymarketMetadataBudgetError, safe handler, fetch and randomUUID into pollPolymarketResolutionsBounded. Store uses `withTransaction` and an economic no-op applyObservation callback. Public wrapper must throw structured ResolutionPollError for partial enumeration **or economic blockage**, even when metadata coverage completes. Any explicit health consumer must preserve both qualifiers.

Replace old tests asserting a winner from closed and price >= .99 with public-seam safe refusal/no-fallback/continuation coverage. Standalone scheduler does not runtime-import polymarket.ts; no cycle or reader duplication is needed.

## UNAPPLIED schema proposal

No migration file was created/applied by this owner. Missing storage fails closed; the following is a proposal only, not installed-schema evidence:

```sql
CREATE TABLE polymarket_resolution_poll_progress (
  poll_key TEXT PRIMARY KEY CHECK (poll_key = 'gamma-resolution-v1'),
  owner_token TEXT,
  lease_until TIMESTAMPTZ,
  after_id TEXT COLLATE "C",
  upper_id TEXT COLLATE "C",
  cycle_attempted BIGINT NOT NULL DEFAULT 0,
  cycle_failed BIGINT NOT NULL DEFAULT 0,
  cycle_open BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK (cycle_attempted >= 0),
  CHECK (cycle_failed >= 0 AND cycle_failed <= cycle_attempted),
  CHECK (after_id IS NULL OR after_id ~ '^0x[0-9a-f]{64}$'),
  CHECK (upper_id IS NULL OR upper_id ~ '^0x[0-9a-f]{64}$'),
  CHECK (after_id IS NULL OR (upper_id IS NOT NULL AND after_id <= upper_id)),
  CHECK ((owner_token IS NULL) = (lease_until IS NULL)),
  CHECK (owner_token IS NULL OR length(owner_token) BETWEEN 1 AND 200)
);
CREATE INDEX polymarket_resolution_poll_eligible_key
  ON polymarket_markets (condition_id COLLATE "C")
  WHERE status = 'active' AND context_complete = TRUE;
```

Review/application, least-privilege global polling capability under current role/RLS architecture, real PostgreSQL concurrency/rollback, transport timeout policy, provider compatibility and certified economic resolution remain gates. No bypass grant assumed.

## Actual verification

All checks used CPU 0, shared flock, offline guard and mocked dependencies.

- Initial missing-module reds were implementation absence checks, not behavioral baseline reproduction.
- Behavioral reds reproduced three attempts with one-request allowance, late metadata acceptance, swallowed storage failure, invalid limits/unordered pages, provider work after late reservation, and late finish/release falsely successful.
- Final `package11-polling-release-deadline-green`: **29 passed / two files, zero failures/skips** (21 scheduler, 8 SQL seam cases).
- Final `package11-polling-final-typecheck-640`: strict focused noEmit exit 0.
- `package11-polling-neighbors`: **157 passed, two failed / five files**. Failures were moving metadata nonscalar-tick tests, relayed and subsequently corrected by the metadata owner. The original red remains; only integrated gate establishes final aggregate.
- Scoped changes were reviewed. Whole-checkout whitespace inspection found inherited unrelated billing trailing whitespace at `apps/web/app/billing/page.tsx:210`, left untouched.

Historical unique `package11-polling-*` red/green logs/JSON remain. No full suite or live acceptance run.

At handoff, old `polymarket.ts:709–740` still scanned unbounded, swallowed failures and synthesized winner from closed plus .99 price; integrator replacement is required. New DB module :40–49 identifies schema/runtime/hard transport gates; new scheduler :19–23 withholds economic resolution. These are owner's read-time citations, not final integration line numbers.

Self-review covered standards and assignment behavior; no independent approval claimed. No live provider/DB/Redis calls, credentials, services, applied migrations, signing, orders, deployment, commits or pushes occurred.
