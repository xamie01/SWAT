# Core independent-review repairs — 2026-11-16

This report supersedes the affected completion claims in CORE-REPORT.md. It records **local keyless corrective seams**, not runtime/SQL isolation/live/deployment verification.

## Repaired high blockers

1. **Canonical exit trade origin.** `/root/SWAT/packages/db/src/trades.ts` now carries `TradeInsert.exitLotId` through the actual INSERT column/bind contract. Conflict UPDATE requires immutable tenant/signal/source/exit/token/chain/direction/mode equality. `/root/SWAT/packages/db/src/worker-settlement.ts` supplies canonical `execution.exitLotId`. The actual SQL-contract fixture in `/root/SWAT/packages/db/src/worker-trade-contract.sequential.test.ts` parses real INSERT columns/binds and enforces migration061 source XOR lot origin; it is not a real PostgreSQL engine or production migration acceptance.
2. **Truthful economic completion.** Settlement returns `{tradeId, execution, accountingComplete}`. Partial or unknown fee/value does not mark the worker attempt settled. Inventory-confirmed but incompletely valued executions move to `reconciliation_required`, trade remains partial, risk retains unknown liability, and actual worker returns submitted/pending—not paper-filled/live-executed. A confirmed replay also checks canonical valued terminal evidence before reporting already-executed. `/root/SWAT/apps/trade-executor/src/worker-policy.sequential.test.ts` and `/root/SWAT/packages/db/src/worker-settlement.sequential.test.ts` exercise those returned outcomes.
3. **Fresh authority boundary.** `/root/SWAT/apps/trade-executor/src/worker-policy.ts` binds chain/principal/adapter/settlement/signing identity/capabilities/expiry terms from the grant; checks current grant again after quote in pre-effect transaction and immediately before execute. A revoked/changed/expired grant refuses; if it changes after durable prepare, uncertainty is durably retained and no effect is invoked. No key/signing or live authority is fabricated. The existing grant type has no separately authenticated policy version; adapter/identity/expiry terms and fresh resolver decision are the available binding, not a claim of stronger authorization infrastructure.
4. **Actual transaction scope.** `/root/SWAT/apps/trade-executor/src/index.ts` no longer routes canonical jobs through unscoped `withTransaction`. `ExecutorJobPorts.canonicalTransaction(job)` must supply an approved durable-job/tenant-bound transaction or return null; default explicitly reports `approved-worker-tenant-scope-unavailable`. It does not derive an authenticated UserScope from queue userId and does not create RLS bypass/privileged grants. Actual entrypoint refusal/injected transaction seam is tested.

## Additional narrowly supported fixes

- `/root/SWAT/packages/db/src/worker-settlement.ts` locks the cohort ledger in a separate statement **before** evidence insertion and the cumulative unknown recount. The order seam test verifies lock before evidence. This avoids the identified READ COMMITTED UPDATE snapshot overwriting earlier unknown coverage; no real SQL concurrency proof is asserted.
- `/root/SWAT/packages/db/sql/074_canonical_worker_foundation.sql` extends evidence immutability to all payload fields including fee, allowing only confirmation state/timestamp changes. It removes ordinary app snapshot INSERT privilege and denies unapproved capture writers; JSON scope columns must agree. The approved runtime capture capability remains **unavailable**, not implemented by a migrator-at-runtime bypass. SQL074 remains forward/unapplied. The static SQL guard assertions are reported as source checks only.
- Added exact same-client fenced durable receipt reconciliation without illegal `unknown -> dispatched` transitions. `reconcileWorkerFillWithClient(client, input: WorkerFillSettlement, assertReceiptOwnership: WorkerReceiptOwnership)` first invokes independently owned receipt assertion on the same client, locks matching worker tenant/fence/revision/riskEpoch in dispatched/unknown/settled, then composes financial settlement. It leaves terminal unknown worker fences unchanged/nonresubmittable; the receipt owner maintains its own durable settlement marker. Unowned receipt refuses before economic mutation. Quote contract remains unchanged.

## Exact phase6 handoff

`/root/SWAT/packages/db/src/worker-settlement.ts` now exports:

- `reconcileWorkerFillWithClient(client, input, assertReceiptOwnership)`
- `WorkerReceiptOwnership = (client, attempt: WorkerAttempt, evidence: RecordCopyExecutionEvidenceInput) => Promise<void>`
- Both immediate and reconciled settlement return `{ tradeId, execution, accountingComplete }`.

Existing barrel export* covers them; no extra barrel edit is required. The Jito owner was informed through coordinator because this subagent has no direct SendMessage tool.

`/root/SWAT/apps/trade-executor/src/index.ts` has `ExecutorJobPorts.canonicalTransaction?: (job: unknown) => CanonicalWorkerPorts['transaction'] | null`. This is an approved-boundary injection seam, **not authentication derived from queue fields**. Default unavailable is deliberate under forced RLS. Parent will perform separate phase6 boot joins after core freeze; no Jito-owned files/SQL075 were edited in this repair.

## Immutable revaluation limitation

The receipt reconciliation seam idempotently replays the same immutable priced cumulative fill. It does **not** modify unknown fee/quote payload in place, add a duplicate same-quantity fill to fake revaluation, or release unknown liability. An independent owned valuation-correction evidence/schema contract is absent; unknown pricing remains discoverable `reconciliation_required` and nonresubmittable. This requested revaluation capability remains a genuine external/schema gate, not complete.

## Actual changed corrective paths

- `/root/SWAT/packages/db/src/trades.ts`
- `/root/SWAT/packages/db/src/worker-settlement.ts`
- `/root/SWAT/packages/db/sql/074_canonical_worker_foundation.sql`
- `/root/SWAT/apps/trade-executor/src/worker-policy.ts`
- `/root/SWAT/apps/trade-executor/src/index.ts`
- `/root/SWAT/packages/db/src/worker-settlement.sequential.test.ts`
- `/root/SWAT/packages/db/src/worker-trade-contract.sequential.test.ts`
- `/root/SWAT/apps/trade-executor/src/worker-policy.sequential.test.ts`
- `/root/SWAT/apps/trade-executor/src/worker-entrypoint.sequential.test.ts`
- `/root/SWAT/threats/build-completion-20261116-sequential/core-review-repairs.config.ts`

No Jito new module/runtime/config/SQL075 edits, parent core edits, services, real DB/Redis, credentials, keys/signing, installs, network, production migration or commits.

## Verification and evidence

All execution used `/root/SWAT/scripts/build-completion-runner.py`, locked CPU0 guard, 512MB single-fork tests / 640MB compilers, approved literal config. Config hash `ac632433686209b06d18e413150d1a9e26f05a3a75446cdfe14e7ce948a64c31`. New fixture imports only actual trades leaf with lazy DB client mocked and inert SQL-contract/source guards; neighboring seams remain keyless/mock-port/pure.

- `build-core-review-red-01`: actual **exit0, 70/70 tests passed, six files**, workspaceInputsUnchanged=true. The label says red but the actual result is green; no pre-fix red execution was captured in this repair. Independent source findings supply the prior defect proof; do not claim a failing regression run that did not happen.
- `build-core-review-typecheck-db-01`: **exit0**, workspaceInputsUnchanged=true.
- `build-core-review-emit-db-01`: **exit0**, workspaceInputsUnchanged=true; emitted hashes retained.
- `build-core-review-typecheck-executor-01`: **exit2**, workspaceInputsUnchanged=true. Diagnostics are exclusively Jito-owned fixtures (`jito-durable.sequential.test.ts`, `jupiter-jito-runtime.test.ts`, `package17-solana-durability.sequential.test.ts`) incompatible with newly required quote contextSlot/independent intent/receipt fields. No corrective worker-policy/index diagnostic. This is a dependent package failure, **not a passing typecheck**; Jito owner must repair and rerun after core return. No cross-ownership fix or weakened type assertion performed here.
- `git diff --check`: exit0.

Raw logs, command records, inputs-before/after manifests and report/emitted hashes reside in `/root/SWAT/threats/build-completion-20261116-sequential/`. Earlier 419-test result is historical pre-review evidence, not a claim that every prior assertion was re-executed against this repair. This corrective phase's verified focused count is **70**.

## Remaining gates

Approved scoped worker transaction and policy-capture writer capability unavailable; unscoped runtime must not silently appear to work. Immutable revaluation ownership contract unavailable. SQL074 and roles uninstalled and SQL concurrency unverified. Source readiness=false and final signer unavailable preserved. Jito package-wide compiler failures are handed off, and live receipt/effect acceptance is phase6 work—not inferred from these core tests. Core repairs frozen for independent review/parent phase6 boot join.
