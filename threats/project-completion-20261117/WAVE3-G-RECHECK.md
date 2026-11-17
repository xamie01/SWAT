# Wave 3 G-1 independent affected-source recheck

Date: 2026-11-17. Repository: `/root/SWAT`. HEAD: `b64854e3d2e81b16b3c11018729940a9351bc0ce`. This recheck covers the current working-tree repair, including uncommitted source, not merely HEAD.

## Verdict

**Clean affected-source recheck: the supported G-1 completed-INSERT bypass is closed in the inspected proposal083.** No remaining blocker was found within this narrow repair scope. This is not PostgreSQL/runtime acceptance, a claim of passing tests, or a renewed certification of all G invariants. Proposal083 remains proposal-only; no SQL was applied.

## Repair and normal-path compatibility

- **Completed INSERT is now rejected.** In `/root/SWAT/threats/project-completion-20261117/083-lp-schema.proposal.sql:89-112`, `trg_lp_exact_operation_guard` now runs **BEFORE INSERT OR UPDATE OR DELETE**. Its INSERT branch requires `status='pending'`, SQL-null `completed_at`, and an explicit JSON-null `data.receipt`, then returns. A completed INSERT cannot reach the former receiptless state, even if it supplies a matching embedded receipt/key and completion timestamp. `IS DISTINCT FROM 'null'::jsonb` also rejects a missing receipt field rather than treating it as an admitted JSON null. DELETE remains rejected.
- **Completion still requires the exact durable receipt.** The UPDATE branch retains immutable operation identity/intent and permits only a not-already-completed operation to become completed with a matching durable receipt row by operation ID, user ID, receipt key, and full JSON receipt equality. The receipt table's composite foreign key additionally binds that row to the same operation/user/position. The status/data and completion-timestamp table constraints remain in place. The INSERT early return does not bypass the UPDATE fence.
- **Position settlement now independently requires the same durable receipt.** In `/root/SWAT/threats/project-completion-20261117/083-lp-schema.proposal.sql:113-147`, the position guard first selects a completed operation for the same position/user and the new position's last receipt key, then explicitly requires a durable receipt matching that operation ID, user ID, position ID, receipt key, and embedded receipt data. Existing prior-revision/inventory, next-revision, resulting inventory/scale, cumulative fees/costs, and close/rebalance result checks remain. A receiptless completed-operation record therefore cannot authorize this update through the old embedded-receipt-only path.
- **Normal pending admission remains source-compatible.** `/root/SWAT/packages/db/src/lp-paper-store.ts:125-134` inserts an operation with SQL and JSON status `pending`, JSON receipt `null`, and no `completed_at` value (the nullable column defaults to SQL null). Those values satisfy the new INSERT branch; no durable receipt is required at admission.
- **Receipt → completion → position ordering remains source-compatible.** `/root/SWAT/packages/db/src/lp-paper-store.ts:136-152` inserts the durable receipt first, updates the pending operation to completed with that same serialized receipt and a completion timestamp second, and updates the resulting exact position third. Receipt parameters bind the same operation/user/current position/key. The added position receipt lookup is therefore supplied by the preceding receipt write; it does not impose a reversed or circular write dependency. The inspected transaction factory at lines 158-166 passes these actions the same checked-out tenant client under its owner lock. This is source ordering evidence only, not proof of transaction behavior or atomicity in an executed database.

## Test-source inspection

`/root/SWAT/packages/db/src/lp-lifecycle.sequential.test.ts:27-42` now checks for the pending-without-receipt admission guard, INSERT/UPDATE/DELETE trigger attachment, explicit JSON-null predicate, same-position durable receipt binding, exact receipt-data equality, and existing completion/position fences. These are source-string assertions, explicitly labeled not SQL execution. They support repair-presence coverage but do not execute or prove completed-INSERT rejection or successful receipt-backed settlement. The file's legacy receiptless-path assertions were read, not run.

## Current hashes

SHA-256 of the current inspected inputs (the store was inspected only at the affected admission/settlement and transaction-factory excerpts; its hash covers the entire file):

```text
38451d40938191e91a27029f77d696fb845a4c43e458cf084fcd5aefd13c2f19  /root/SWAT/threats/project-completion-20261117/WAVE3-G-REVIEW.md
be0a956dce9b23f94c0453f84eaf00647c8abdf9b0e4250f46cf0faa07feda15  /root/SWAT/threats/project-completion-20261117/083-lp-schema.proposal.sql
afa8f568988f03dc42c71c65351ff2edd2c749ff27b7bbb65f9909b2aee41117  /root/SWAT/packages/db/src/lp-lifecycle.sequential.test.ts
df7df09935d1c25a216f9578300445efd4616402d0ceb444517b66b086f361e9  /root/SWAT/packages/db/src/lp-paper-store.ts
```

## Boundary

This report supersedes only the prior review's G-1 blocker for the hashed affected source snapshot. It does not expand the prior review into a whole-repository or transitive-source certification. PostgreSQL syntax/trigger execution, RLS/privileges, concurrency/crash atomicity, and runtime/live qualification remain separate and unverified. No agents, background work, tests, compilers, emits, network, secrets, services, or SQL execution were used. No implementation edits were made; only this requested report was created. Later affected-source changes require another recheck.
