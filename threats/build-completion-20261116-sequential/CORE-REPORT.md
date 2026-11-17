# Core phase 3–5 local completion — 2026-11-16

## Scope and status

Canonical worker policy and same-client accounting foundations are implemented and wired into the actual `handleJob` entrypoint. This is **local scoped completion**, not live execution, infrastructure/isolation, source verification, custody or deployment readiness. No Jito runtime/config/dispatch, LP/API/web/Solana/ML/deploy, root scripts, credentials, service startup, real database/Redis, dependency install, production migration, signing or commits were performed by this phase.

The source confirmation readiness remains `ready: false`. The final-message signer remains unavailable in its unchanged module. Default canonical quote/receipt adapters explicitly return unavailable; no environment flag restores them. This capability block is intentional and load-bearing rather than a simulated claim of production completion.

## Actual changed paths

All paths below are absolute. Coordinator-owned barrel changes are listed separately.

- `/root/SWAT/apps/trade-executor/src/index.ts` — actual canonical worker delegation; queue-boolean exits without canonical claim, uncanonical tenant obligations, source-without-obligation and uncanonical live entrypoints refuse. Existing operator diagnostic paper body remains. Missing USD valuation no longer writes fabricated zero/default SOL/ETH rate.
- `/root/SWAT/apps/trade-executor/src/worker-policy.ts` — keyless canonical orchestration; DB immutable identity comparison, scorer deterministic lot-claim rejoin, current/captured pure policy intersection, terminal/pending fencing, current-policy recheck after quote, durable pre-effect attempt and buy risk epoch, committed settlement before acknowledgement.
- `/root/SWAT/apps/trade-executor/src/worker-paper-quote.ts` — exact-decimal paper exit quote from an injected scoped, timestamped market observation; stale/future/missing observation refuses. Default production capability unavailable because existing naked cached prices lack reviewed provenance/time.
- `/root/SWAT/apps/trade-executor/src/worker-policy.sequential.test.ts`
- `/root/SWAT/apps/trade-executor/src/worker-entrypoint.sequential.test.ts`
- `/root/SWAT/packages/db/src/worker-policy.ts` — same-client fresh locked persisted platform/user/chain/subscription reads; explicit missing-row refusal; immutable policy capture at actual canonical lot/source claim sites, scoped captured-policy read.
- `/root/SWAT/packages/db/src/worker-execution.ts` — position-first advisory lock, exact source/lot acquisition/evidence/application/policy scope join, durable non-reclaimable attempt fence and pre-effect dispatch marker.
- `/root/SWAT/packages/db/src/worker-settlement.ts` — same-client evidence/position/lot application, cumulative capacity delta/unknown coverage, fee-inclusive durable risk update, exact cumulative trade persistence and attempt completion. Accounting failure propagates, not catch-and-warn followed by ack.
- `/root/SWAT/packages/db/src/copy-trade-lifecycle.ts` — policy capture on actual new canonical claim; caller-client transition/get; evidence fee input/collision check; explicit lot fill bound sums all prior execution reductions rather than only current evidence.
- `/root/SWAT/packages/db/src/master-capacity.ts` — optional caller-client accrual; window coverage includes durable unassessed fill count.
- `/root/SWAT/packages/db/src/risk-policy.ts` — fee-inclusive canonical cumulative debit, unknown fees prevent terminal confirmation, monotonic reversal refusal remains independent of canonical equality.
- `/root/SWAT/packages/db/src/trades.ts` — same-client insertion; exact decimal quantity/money fields accepted without Number coercion, exact fee validation.
- `/root/SWAT/packages/db/sql/074_canonical_worker_foundation.sql` — forward-only, **unapplied** policy snapshot/worker attempt schema and immutable identity guards; evidence fee and capacity unknown count. No ready/enabled seed, global runtime grant, RLS bypass or migrator-for-runtime path.
- `/root/SWAT/packages/db/src/worker-policy.sequential.test.ts`
- `/root/SWAT/packages/db/src/worker-settlement.sequential.test.ts`
- `/root/SWAT/packages/db/src/package15-lot-claim-recovery.sequential.test.ts` — inject capture port in preexisting claim mock tests; real policy/capture seam tested separately.
- `/root/SWAT/packages/db/src/master-capacity.test.ts` — strengthen three stale fail-open expectations to current fail-closed unknown/partial refusal; no source control weakened.
- `/root/SWAT/packages/db/src/trades.test.ts` — mocked COMMIT returns real protocol command, preserving transaction did-commit assertion.
- `/root/SWAT/threats/build-completion-20261116-sequential/core.config.ts`
- `/root/SWAT/threats/build-completion-20261116-sequential/core-neighbors.config.ts`

Coordinator added `/root/SWAT/packages/db/src/index.ts` exports. `/root/SWAT/packages/db/src/reference-driver.ts` and other prior-phase files were preexisting and not owned/changed here.

## Joined seams and limits

1. `handleJob(copyExecutionId)` calls `runCanonicalWorkerJob` using `withTransaction`, authority resolver, current startup/platform-mode intersection and quote capability. Tests invoke this actual entrypoint seam; no source probe substitutes for it.
2. Queue identity is an exact comparison target only. Tenant, target account, signal, token, master, acquisition mode, source/lot identity and requested quantity are matched to DB records. Queue stopLoss/closeAll/manual/sellTokenAmount cannot provide inventory or policy authority.
3. Close-all and stop-loss rejoin the scorer's deterministic `claimLotExitExecutionWithClient` identity; a foreign existing claim cannot be substituted. Current subscription winding-down is sells-only, stopped/ended/missing policy refuses. Sell score is not an entry authority; live acquisition cannot be relabeled paper.
4. Captured policy is persisted in the actual new canonical claim transaction. Existing executions lacking captured/acquisition policy are **not backfilled from present preferences** and refuse. Source readiness remains unavailable; aggregate source sells are not faked as an exact owned lot exit.
5. Pre-effect recheck reads fresh DB control on the same client; buy reservation uses durable risk epoch and `reserveRiskSpend`; a durable attempt/dispatch marker commits before invoking the adapter. Existing/prepared/dispatched/terminal attempts never automatically resend.
6. The financial final transaction composes canonical evidence/lot state, fee-inclusive cumulative risk, source capacity accrual/coverage, cumulative trade, and attempt completion. Exceptions propagate before ack. Unknown price/fees/submission retain liabilities rather than releasing on stop/TTL.

## Actual guarded verification

All tests/compilers used `/root/SWAT/scripts/build-completion-runner.py`, locked CPU0 guard, synthetic offline environment and unique evidence labels. Tests 512MB/one fork, compilers 640MB. No broad workspace run. Exact command, inputs-before/after manifest, report/log/emitted-artifact hashes are retained in this evidence directory. Config review approval was coordinator-owned.

| Evidence label | Actual result |
| --- | --- |
| `build-core-typecheck-db-01` | exit0; workspaceInputsUnchanged=true |
| `build-core-emit-db-01` | exit0; workspaceInputsUnchanged=true |
| `build-core-typecheck-executor-01` | exit2; inferred return union and unavailable direct pg type import diagnostics |
| `build-core-typecheck-executor-02` | exit2; nullable signalId diagnostic |
| `build-core-green-02` | exit1; 256 tests / 252 passed / 4 failed, nine selected files collected; three stale fail-open neighbor expectations and risk reversal reason ordering |
| `build-core-green-03` | exit0; 256 passed, nine files |
| `build-core-typecheck-db-02` | exit0; final DB source, workspaceInputsUnchanged=true |
| `build-core-emit-db-02` | exit0; final DB emits, workspaceInputsUnchanged=true |
| `build-core-typecheck-executor-03` | **exit125**, childExitCode=0, workspaceInputsUnchanged=false during config inventory approval; NOT acceptance |
| `build-core-neighbors-01` | exit1; 163 tests / 158 passed / 5 failed; mocked COMMIT lacked command field |
| `build-core-neighbors-02` | exit0; **163 passed**, five files; workspaceInputsUnchanged=true |
| `build-core-green-04` | exit0; **256 passed**, nine files; final canonical code, workspaceInputsUnchanged=true |
| `build-core-typecheck-executor-04` | exit0; final executor source, workspaceInputsUnchanged=true |

Final deduplicated focused tests: **419 passed across 14 files**. Final entrypoint+orchestration new tests: 29; real DB policy-reader/capture 4; same-client settlement orchestration 5, plus existing pure policy/exact quantity/durable risk/transaction/claim/valuation/trade neighbors. Mocked port tests are not PostgreSQL concurrency/isolation or live receipt verification.

Two earlier test runner invocations (`build-core-tests-01`, `build-core-green-01`) were denied before a child process or evidence record because approved config hash did not match the final file. No bypass or false pass. Final config SHA256: core `4853f8d1d061bac67c056289f015a8845e851222c5617f7fde900019b483a776`; neighbors `93d7983bb3c56510b77bb604569b18eaea76037532cebdfad865f18c888ad468`.

`git diff --check` exited0. Earlier baseline executor noEmit exit0 is recorded in `/root/SWAT/threats/build-completion-20261116-sequential/build-baseline-typecheck-trade-executor-01.command.json` and was not rerun broadly.

## Exact reusable phase6/export handoff

The DB barrel coordinator has added these modules; **no exports remain outstanding**:

- worker-policy: `readCurrentWorkerPolicyWithClient`, `captureWorkerPolicyWithClient`, `readCapturedWorkerPolicyWithClient`; types `WorkerPolicyScope`, `WorkerPolicySnapshot`, `CurrentWorkerPolicy`, `WorkerPolicyIdentity`.
- worker-execution: `readWorkerExecutionContextWithClient`, `prepareWorkerAttemptWithClient`, `markWorkerAttemptDispatchedWithClient`, `assertWorkerAttemptWithClient`, `finishWorkerAttemptWithClient`, `assertWorkerBaseQuantity`; types `WorkerExecutionContext`, `WorkerAttempt`.
- worker-settlement: `settleWorkerFillWithClient`, `retainWorkerUncertaintyWithClient`; type `WorkerFillSettlement`.
- existing lifecycle export*: `getCopyExecutionByIdWithClient`, `transitionCopyExecutionWithClient`; type `TransitionCopyExecutionInput`.
- existing trades export*: `insertTradeWithClient`.

Phase6 external adapter seam is `/root/SWAT/apps/trade-executor/src/worker-policy.ts`: `CanonicalWorkerPorts.quote(execution, maxSlippageBps)` returns `CanonicalWorkerQuote | null`; quote includes conservative exact fee-inclusive `requestedDebitUsd` and `execute(intent)`. Intent carries immutable canonical execution, durable WorkerAttempt fence/revision/riskEpoch and risk scope. Outcome is an independently validated cumulative/effect receipt fill with `RecordCopyExecutionEvidenceInput` or explicit unknown. `ExecutorJobPorts.canonicalQuote` is wired into actual handleJob; process boot uses default unavailable until a reviewed adapter is supplied. Reconciliation adapters must compose the same DB settlement contract with their own durable receipt ownership; a sweep must not promote naked venue status to trade filled.

## Remaining gates / honest limitations

- SQL074 and existing role/risk migrations **not applied**. Runtime receipt/history/source/trading-control/capacity grants after 070 require separately approved least-privilege capabilities; scoped runtime must not use migrator credentials or app flags to bypass them. No real database or lock/SQL concurrency proof here.
- Default canonical quote/live receipt adapter **unavailable**; native cached prices lack reviewed provenance/time. The injected exact paper quote is locally tested, not an installed live market-data provider. Existing operator diagnostic paper branches remain and are not live risk-accounting acceptance.
- Source confirmation verifier false; intake quarantine unaffected. No source/fanout production readiness from these tests.
- Final-message signing/independent Jito intent/raw-byte outbox and receipt durability remain phase6, unchanged here. Live authorization/effect recheck and irreversible receipt validation must be supplied there; this seam alone is not signing authority.
- Unknown/partial attempts stay non-reclaimable and require receipt reconciliation. Reconciliation of old lifecycle paths and capability wiring is not inferred from helper correctness.
- Canonical close-all/stop-loss claims now require persisted current policy and acquisition policy. Legacy rows without it refuse rather than reconstruct opt-in. SQL snapshot guards are source-reviewed/unapplied, not installed DB enforcement proof.
- Legacy suites asserting uncanonical live execution or queue-boolean exit success are outside these focused acceptance runs and have obsolete success expectations; they must not be used to restore the bypass. Selected neighbors and new seam tests are the only asserted pass counts.
- Independent review remains pending. No overall live/build/deploy readiness claim.
