# Wave4 source-completion implementation map — 2026-11-18

## Requested milestone

Finish every remaining coding package so the build can be classified **source-complete, pending separately authorized runtime qualification**. That classification requires implemented and wired executable scenarios, strict missing-capability refusals, affected passing tests/typechecks, independent source review and reconciled evidence. It does not grant runtime/live/production acceptance.

Baseline is 422 offline tests/15 files, qualification typecheck21. Existing source is incomplete, not execution-only blocked. Preserve sealed Waves1–3, accepted queue/load source except supported affected changes, SQL083 and SQL084 refusal, unrelated working tree and Package28/public positive-pipeline refusal until their own supported qualification.

## Execution policy

One active implementation or review subagent at a time; exclusive files, sequential verification. The latest user request removes test wall-clock limits. Runner gains `--timeout-seconds 0`; use CPU0 shared flock, one test fork/512MB heap, compiler640MB, synthetic/offline guard and immutable evidence. No runtime services, migrations, credentials, signing, funds or publication. Test-run allowance does not remove application transaction/operation/cancellation/shutdown or load drain safety deadlines.

## Exclusive packages and deliverables

### P0 — coordinator: map, runner and literal verification integration

- Implement no-time-cap check option, retain default for historical callers, record configured limit in command evidence, add unit regressions.
- Reserve migration suffixes after inspection. 085 reserved for protected LP admissions; later schema allocation is coordinator-only.
- Maintain hash-bound literal inventory, raw failures, commands/logs/results/input manifests and source-review reports.
- Never run verification while a source-changing owner is active; freeze consumed source first.

Done means no-time-cap option tested, current source manifests clean and every authored test included exactly once in appropriate affected inventory.

### P1 — LP admission owner: protected SQL and store boundary

Exclusive: new085 proposal, admission contract/store leaf, LP SQL store/service if required, offline fixture if required, new protected-admission contracts. Preserve083/084.

- Append-only tenant-composite quote/settlement admission sidecars; protected full payload/context, uniqueness and database-controlled timestamps.
- Restricted direct authenticated LP admission writer, app SELECT only, FORCE RLS/strict policies; no role membership/ownership/bypass expansion.
- Owned transaction lookup/writer adapters, no pool or label-to-authority fallback.
- Mandatory production SQL store checks before acquisition/operation/receipt/completion writes.
- Additional SQL guards join independent quote/settlement admissions on acquisition, operations, receipt materialization, completion and position accounting, including historical receipts.
- Full tenant/network/provider/action/context/revision/inventory/price/fees/costs/economic and chronology checks; strict JSON/null-safe comparisons.
- Hostile direct-store and static SQL contracts; no implicit admission from existing runtime records.

External remaining: approval/provisioning of writer/provider identities, actual PG/ACL/RLS/trigger proof. Source absence must not be called an external prerequisite.

### P2 — migration/roles owner, coordinator schema decision

Exclusive: migration-discovery/safe proposal mechanism, dedicated provisioning modules/config source, new tests; deploy roles and PgBouncer reserved to this owner. Additional canonical suffix centrally allocated.

- Resolve discover-all versus unconditionally refused084. Do not skip/forge journal silently or remove refusal; author explicit reviewed proposal/canonical separation with exact selection manifest and canonical checksums.
- Define least-privilege login/provisioning lifecycle consistent with direct current_user/session_user; no SET ROLE membership shortcut.
- Narrow system-identity observation and reviewed base LP DML prerequisites after P1 boundary.
- Source capability matrix for runtime, migrator, custody, financial, capture, worker, observer and LP admission writer.
- Make reference/candidate replay and load baseline consume the same reviewed canonical migration selection.

Done means a pristine replay plan has no unconditional proposal selected for execution and no fabricated migration record; role composition is executable only with explicit deployment inputs.

### P3 — auth owner

Exclusive: DB pre-session resolver leaf/users and API auth integration; new authentication qualification scenarios/tests. No shared me.ts edits without reservation.

- Protected pre-session principal/session lookup, no unscoped access to forced-RLS tenant tables.
- Restricted auth identity and narrow route-global reads; approved identity externally supplied, adapter implementation exists.
- Exact successful/failed/adverse pooled transaction reset, tenant/cross-tenant refusal and authenticated identity scenarios.
- PgBouncer inspected target/login/transaction/client-server limits integration.

### P4 — pipeline owner

Exclusive: pipeline source/new scenario/observer leaves, supported source/fanout/worker import-safety leaves reserved before edits; coordinator shared CLI only.

- Owned import-safe intake/verification/obligation/admission/fanout/delivery/worker/receipt/accounting composition.
- Protected obligation scope on every transaction, not queue.userId.
- Positive synthetic buy/sell/reversal/immutable valuation/fee-correction/replay driver.
- Durable SQL journal observer and independent exact arithmetic connected to executed scenario, not a clone fixture.
- Generic existing adapters reused; missing backing adapter implemented, absent provider identity explicitly external.

### P5 — financial domains owner, sequential subdomains

- Custody: wrap/unwrap/enrollment/delegation owned composition with independent secret admission and synthetic lifecycle/revocation/expiry/ABA scenarios.
- Withdrawal: protected OTP capture/digest/delivery, owned eligibility/funding/outbox and uncertain receipt reconciliation.
- Reducing: concrete spot-lot accounting/perps collateral mapping and independent receipt/admission/accounting adapters; restricted settler distinct from app, no impersonation.
- LP-copy: protected initialization/master/risk composition and complete operation/receipt/history/economic observer preserving one-close accepted observer scope.
- Shared domains integration owned exclusively by final financial integrator.
- Correctly privileged SQL guards/refusal scenarios, no ACL42501-as-trigger shortcut.

### P6 — schedules/fault owner

Exclusive: new canonical race/fault schedules/tests and fault integration. Accepted queue code touched only for supported findings.

- Canonical competing claims/admissions, duplicate retry, tenant/account interference, post-lock expiry/cancel, cross-account fee and fee-only completion.
- Actual blocking/isolation/wait relations and joined transaction outcomes, exact journals/rollback conservation.
- Owned Redis-loss/source/outbox/canonical-worker faults at pre/postcommit/enqueue/ack boundaries.
- Missing locks and ordinary BullMQ stall recovery retained, no arbitrary backend/PID kill authority.

### P7 — load owner

Exclusive: affected load baseline guards, durable completion/economic adapter, qualified fixture consumer source/tests.

- Run-scoped synthetic fixture consumers with bounded admitted functions and no live provider edges.
- HTTP attempts → admission → job completion → durable results/economics, plus no-unexpected-effect reconciliation.
- Preserve100000 seed/random10000 pool, peak9000 and accepted weighted schedule; update baseline only for supported migration decision.
- Integrate slow/server logs/resource evidence into final bundle, separate long load lifecycle/drain.

### P8 — coordinator/containment owner

- Private execution capability/config composition, every I1–I8 source gate adapter and nonsecret raw output.
- Cancellation and ambiguous COMMIT fences; owned-work settlement and supported lifetime repairs.
- Failure/partial/cleanup evidence persisted on every exit; client/child/queue drains and exact disposable-resource/operator handoff.
- Independent long-load evidence chain without silently widening core deadlines.
- Runtime execution remains refused until exact environment/credentials/targets/tools/permissions supplied and source independently accepted.

### P9 — read-only reviewers and coordinator final audit

- Freeze each package, independent affected source review, repair supported findings, affected checks under shared lock, compare hashes/results/source.
- Final audit enumerates every requirement, executable path and missing capability; any missing implementation keeps sourceComplete=false.
- Update ledger to source-complete-pending-runtime ONLY if all P0–P8 code and affected review pass. Runtime/live/production flags remain false.
- Runtime-only blocker inventory: exact disposable env/images/tools/targets/permissions, approved identities/credentials/provider evidence, actual provision/migrate/execute/fault/load/resource/cleanup observations and independent runtime acceptance.

## Dependency/dispatch order

P0 starts alongside unrelated sole P1 implementation. Thereafter P2 → P3 → P4 → P5 custody → P5 withdrawal/reducing → P5 LP/shared integration → P6 → P7 → P8 → P9. Reviews and checks are sequential between owners; no background token multiplication. A genuinely missing approved identity does not prevent authoring a strict adapter contract, but invented authority or unsafe schema approval is not allowed.

## Current disposition

P1 initial implementation completed; typecheck24 and offline25 passed481 tests/17 files before later edits. Independent protected-boundary review found three blockers (writer-login contradiction, acquisition admission aliasing, canonical position projection) and additional null/commitment/legacy projection hardening. Sole P1 owner is repairing them; source acceptance remains pending. P0 no-time-cap runner passed12 unit tests. Coordinator has authored joined private partial/failure/cleanup evidence-session source and byte-hash output, now included in the expanded literal inventory; this addition is unverified/unreviewed. P2 also must resolve historical ownership transfers that ordinary membership-free migrator cannot perform, without altering sealed SQL or inventing journal records. Other packages remain pending. This map is not completion evidence. Do not advance Wave5 or equate green contracts/refusals with accepted runtime.
