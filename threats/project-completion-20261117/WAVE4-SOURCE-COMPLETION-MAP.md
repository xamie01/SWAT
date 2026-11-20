# Wave4 source-completion implementation map — 2026-11-20

## Requested milestone

Finish every remaining coding package so the build can be classified **source-complete, pending separately authorized runtime qualification**. That classification requires implemented and wired executable scenarios, strict missing-capability refusals, affected passing tests/typechecks, independent source review and reconciled evidence. It does not grant runtime/live/production acceptance.

The original checkpoint was 422 offline tests/15 files and qualification typecheck21; it is historical. P2 frozen checkpoint was602/24 and load45/1. Authentication checkpoints709/35,748/36 and781/36 are also historical. The current frozen incoming-FK closure checkpoint passes948 main tests/36 literal files,46 separate load contracts and DB/qualification/API/API-tests/LP noEmit checks. All seven share manifest `738c69d08ce17fdd2cda58f9eb5fa75bd5dc95854495fbb8eaa4adb7a024dcf6`; earlier epochs remain separate. The latest completed independent review accepted bounded P3 source after resolving original findings1–6 and repair findings A/B/C. The independently verified baseline pins47 constraints/188 enforcement paths. Test/artifact reconciliation is separate from independent source review, and actual PostgreSQL behavior remains unqualified. P4–P8 implementation and P9 audit remain unfinished, not execution-only blocked. Preserve sealed Waves1–3, accepted queue/load source except supported affected changes, SQL083 and SQL084 refusal, unrelated working tree and Package28/public positive-pipeline refusal until their own supported qualification.

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

Concrete next-owner scope, inspected on 2026-11-19:

1. `fanout-enqueue.ts` must import the already pool-free `package13-fanout-delivery.ts` and explicit type leaves, not the runtime DB barrel. `worker-policy.ts` must use explicit pool-free lifecycle, worker, risk, settlement and descriptor leaves. Supplying a transaction does not prevent ambient module evaluation.
2. Extract the canonical implementation from `copy-trade-lifecycle.ts` into a mandatory-client/mandatory-owned-transaction leaf without copying divergent SQL. Add actual owned observation intake and signal insertion seams; those currently exist only behind `inTransaction` and ambient `withTransaction`. Retain public confirmation refusal, exact binding checks, accepted-provider lookup, position-first locking, policy capture, sell-lot allocation and terminal replay semantics. Keep compatibility wrappers outside the qualification import graph.
3. Extract `insertTradeWithClient` and exact risk reservation/settlement code into shared pool-free leaves; legacy ambient wrappers import the same implementation. `worker-execution.ts`, `worker-settlement.ts` and the canonical worker must consume those leaves. `fanout-eligibility.ts` must not pull its pure mirror-state helper through ambient `subscriptions.ts`. Source/valuation/policy/lot leaves that are already import-safe remain unchanged unless an affected defect is supported.
4. Supply concrete owned source/provider intake, follower sizing/current-recipient admission, fanout cohort, worker obligation lookup, risk control, independent paper receipt, valuation/correction writer and durable observer composition. SQL077 leaves provider/application access ungranted, SQL079 leaves worker lookup EXECUTE ungranted, and the matrix currently has no source-provider/capability/valuation writer capabilities. These require reviewed executable provisioning/validation source rather than being reclassified as missing passwords. Existing `swat_fanout` and its canonical cohort privileges must be explicitly represented. Coordinate any new schema suffix before allocation; never extend the seven-transfer broker or grant app authority minting.
5. The scenario must call production intake/verification, canonical fanout and worker functions for buy, source sell, verified source reversal, immutable value/fee correction and replay. External callback completion or queue acceptance is not a fill; observe durable rows only after checked COMMIT, then independently compare full source/obligation/execution/attempt/receipt/accounting/position/lot/risk/capacity identities and exact arithmetic. Refusal/rollback/uncertain-COMMIT paths must suppress success and retain recoverable durable obligations.
6. Add an actual child-process import containment regression with ambient pool constructors forbidden, joined injected execution contracts distinct from inert-journal tests, and focused affected lifecycle/fanout/worker/risk/trade/source/correction regressions. Coordinator owns the hash-approved literal inventory and verification. A source-only callback factory is not runtime acceptance, but an unconditional positive-entrypoint throw is not source completion either.

### P4a — canonical owned pipeline foundations (implementation started 2026-11-20)

The sole active owner is extracting shared lifecycle/intake/signal, trade and risk implementations into mandatory-client leaves; correcting fanout/canonical worker/settlement/paper quote import graphs; sharing pure mirror state; and reconciling production obligation adapters with the existing `obligation-runtime-owned.ts`. Compatibility facades must delegate shared implementations. New actual fresh-source import-containment and joined injected production contracts are required before accepting this slice. No SQL/grants/broker/public activation is part of P4a.

### P4b — protected backing composition and provisioning

Supply actual owned provider/intake/current-recipient/cohort/sizing/capability/risk/receipt/valuation/correction adapters. Ambient `listFanoutCandidates` and boot-private current admission remain work until concrete owned composition is reserved. The matrix's missing source-provider/capability/valuation entries and `swat_fanout` require reviewed executable provisioning/validation source, not merely passwords.

### P4c — executed scenario and durable observer

Join production intake/verification/fanout/worker for buy, source sell, verified reversal, immutable value/fee correction and replay. Observe durable rows after checked COMMIT; independently reconcile exact source/obligation/execution/attempt/receipt/position/lot/risk/capacity identities and economics. Keep uncertainty/refusal/rollback paths recoverable without claiming success.

Only one P4 implementation or review owner is active; no checks run while consumed source changes. [Remaining-work and Wave5 transition map](WAVE4-REMAINING-WORK.md) records all P0/P4–P9 source and I1–I8 runtime gates. P4a does not complete P4.

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

P1 repaired SQL085/protected admission/store source received narrow independent acceptance; this is not PostgreSQL/privilege/trigger or provider qualification. P0 no-time-cap runner passed12 unit tests, but independent review remains pending.

P2 repaired installation-plan,SQL086,provisioning and migration contracts received narrow independent source ACCEPT after exact bootstrap/ACL/function/trigger/lifecycle repairs and canonical catalog-type corrections. Failed offline29 caught an omitted trigger return type; it is retained. See WAVE4-MIGRATION-REPAIR-ACCEPTANCE.md. Production migrate, independent reference/candidate replay, Wave4 migration/catalog and remote-load baseline consume explicit reviewed selection and exact source/installed-SQL/audit identities. Only validator-returned broker routine OIDs receive pristine exemptions. Load source preflight precedes connections. The later real MJS source-loader regression passes with database constructors forbidden; no PostgreSQL replay or actual load is established.

Historical P2 frozen checks: main offline30 passes602 tests/24 unique literal files; load offline10 passes45/1; qualification typecheck29 and DB typecheck04 pass noEmit/incremental:false. All consume manifest1dbab95686948e5024e9da3afef30239f7c4f437fe692a3d3c1f7f1432f3391a. Its historical main config hash is a7933d4964784d2e78a57bdbedfcb4619a4a5f4951ca47df4285ba71b002b124. These and earlier422/481/540/601 checkpoints are superseded, not summed. The current authentication repair checkpoint is recorded below; the pre-repair 709/35 checkpoint remains historical.

P3 SQL087, owned auth store, API/LP wiring, exact catalog dependency inventory, external provisioner/installation and qualification composition are frozen. Explicit inventory is001–087 excluding pinned084 (86 selected migrations); the seven-transfer079/082 broker is unchanged. Final `build-w4-auth-fkclosure-main-offline-01` passes948/36, `build-w4-auth-fkclosure-load-offline-01` passes46/1 including the real source-loader child, and DB/qualification/API/API-tests/LP noEmit checks all pass. All seven share manifest `738c69d08ce17fdd2cda58f9eb5fa75bd5dc95854495fbb8eaa4adb7a024dcf6`; current complete consumed inputs match. Report-only updates are excluded by runner policy. All59 preceding recorded checks were also reconciled against historical artifacts, not current source bytes. Fresh DB emit and earlier failures/success epochs remain separate. See [WAVE4-AUTHENTICATION-FK-CLOSURE-CHECKPOINT.md](WAVE4-AUTHENTICATION-FK-CLOSURE-CHECKPOINT.md).

The [second independent repair review](WAVE4-AUTHENTICATION-SECOND-REPAIR-REVIEW.md) resolved shared reference/candidate target binding B and runtime lease custody C, but retained REJECT for incoming FKs whose child was outside the auth inventory. Original findings1/3/4/5/6 remain resolved. The latest four-file repair removes the ANY-FK exemption and independently pins42 legitimate external-child plus five auth-child constraints, with188 enforcement paths. Contracts reject extra/private unlink blockers, substituted constraints, enforcement drift and orphaned/spoofed touching paths. [Independent read-only incoming-FK closure re-review](WAVE4-AUTHENTICATION-FK-CLOSURE-REVIEW.md) returned ACCEPT for bounded P3 source, closing original findings1–6 and A/B/C. It independently confirmed the canonical47-constraint/188-path inventory and refusal predicates. The reviewer did not reproduce tests or authenticate the manifest; coordinator artifact reconciliation is separate. The original [six-finding review](WAVE4-AUTHENTICATION-REVIEW.md), [first repair review](WAVE4-AUTHENTICATION-REPAIR-REVIEW.md), [748/36](WAVE4-AUTHENTICATION-REPAIR-CHECKPOINT.md) and [781/36](WAVE4-AUTHENTICATION-SECOND-REPAIR-CHECKPOINT.md) checkpoints remain historical. Actual PostgreSQL catalog/ACL/RLS/locking/COMMIT behavior remains unqualified.

P3 bounded source acceptance is reconciled. P4a implementation started2026-11-20 with one exclusive owner; verification waits for source freeze. The preceding948/36 manifest is historical once consumed source changes, not evidence for new bytes. Evidence/lifetime/owned obligation independent review remains pending. P4b/P4c positive owned pipeline backing/scenarios,P5 shared financial adapters,P6 races/faults,P7 durable load correctness and P8 executable composition remain coding work; P9 final audit remains pending. No services/SQL application/real credentials/live signing/funds/load/commit/push/publication is authorized by this source work. Bounded authenticationSourceAccepted=true; Wave4 sourceComplete/runtimeAccepted/liveCapabilityAccepted/productionReady remain false. Wave5 dependent runtime requires genuine I1–I8 acceptance, not merely source completion.
