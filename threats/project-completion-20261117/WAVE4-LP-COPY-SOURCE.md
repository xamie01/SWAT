# Wave4 LP-copy source checkpoint — 2026-11-18

Status: source implemented; 32 lifecycle and 30 observer injected contracts pass in the current 422-test/15-file run (`build-w4-main-offline-23`), with qualification no-emit typecheck21 passing. The repaired ONE-CLOSE observer received narrow independent source acceptance; whole affected source acceptance remains withheld due the SQL privilege/receipt boundary. Not real SQL, infrastructure, capability or full Wave4 acceptance.

The sequential S6 assignment was attempted twice across the continuation boundary; the provider refused both attempts with a token rate limit. No subagent created files. The coordinator implemented the bounded source task without parallel fallback or model switching.

## Implemented

- `tests/qualification/wave4/lp-copy-scenarios.ts` invokes the production `createLpPaperService` copy/acquisition/close/process/replay seams. It accepts caller-owned service ports and an independent observer; there is no service startup or public CLI activation.
- `lpCopySqlService` requires a transaction callback before constructing the production SQL store. It has no ambient transaction fallback. Protected master/risk inputs and existing subscription initialization remain caller prerequisites, not labels or grants.
- Independent BigInt sizing computes the minimum remaining budget, per-position cap and master deposit. It checks raw amount, exact value, acquisition intent, immutable subscription/event/risk provenance, inventory, one stored operation receipt/hash, complete closed position economics and unchanged replay after close.
- `lp-copy.offline.test.ts` uses the existing keyless in-memory LP fixture and actual service logic. It exercises missing capability/mode refusals, foreign tenant, master/risk substitutions, cumulative budget, assessment-time subscription/budget changes, unassessed exposure, absent receipt, observer hash substitution, rollback and restart. Fixtures model transactions; they do not establish PostgreSQL behavior.

- `lp-copy-observer.ts` implements a bounded ONE-CLOSE SQL export using a mandatory caller-owned transaction, captured primitive tenant, exact role/RLS/tenant observations, owner lock, exact/base position agreement and receipt identity/hash checks. Thirty inert SQL-transcript contracts cover refusals, caller mutation, noncoercible IDs, transaction completion/failure and snapshots. See `WAVE4-LP-COPY-OBSERVER-REVIEW.md` for narrow repaired acceptance and limitations.

## Imports

Runtime leaf imports only: `lp-paper-service.ts`, `lp-paper-store.ts`, `lp-exact.ts`. `UserScope` and `LpTenantTransaction` are type-only. Offline tests additionally import the existing `lp-paper-fixture.ts` and Vitest. No runtime `@swat/db` barrel, connection construction, queue construction, secrets, signing, transport or network is used.

## Remaining requirements

- Safe protected subscription/guardrail initialization and authenticated production tenant composition. The source-only 084 proposal deliberately does not add harness-only subscription/guardrail creation authority; existing `seedOwners` remains blocked.
- Independently reviewed deployed master-event and copy-risk capability provenance. Injected test providers do not establish this.
- Authenticated deployment and lifetime-contained composition of the implemented observer. Its supplied transaction must commit before resolving and own pending work; the interface does not provide credentials, actual ownership proof or cancellation of noncooperating ports.
- Actual PG16 ACL/RLS/trigger/transaction/concurrency proof and durable close/replay journals. In-memory tests cannot establish it.
- Protected independent receipt/quote/economic SQL admission and whole affected source acceptance. Narrow observer acceptance and hash consistency do not repair the HIGH SQL083 finding.

No SQL was applied, services started, credentials consumed, providers contacted, load/fault execution performed, commit created or publication attempted. Runtime/pipeline/Package28 refusals remain unchanged. `runtimeAccepted=false`, `liveCapabilityAccepted=false`, `productionReady=false`. Wave4 remains incomplete and Wave5 remains blocked.
