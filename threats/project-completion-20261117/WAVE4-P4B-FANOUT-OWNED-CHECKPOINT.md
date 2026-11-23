# P4b owned fanout composition — bounded verification checkpoint

**Verification passed and independent bounded source review returned ACCEPT.** The [review](WAVE4-P4B-FANOUT-OWNED-REVIEW.md) found no introduced blocker and records nonblocking guard-coverage gaps and preserved behavioral qualifications. This checkpoint covers shared candidate enumeration and current-recipient admission/cohort composition only. It does not complete all P4b, P4, Wave4 source work or any runtime gate. All118 retained raw records are reconciled, including97 preceding and21 P4b records.

## Implemented bounded source

- Canonical candidate SQL/mapping lives in `packages/db/src/fanout-candidates-owned.ts`. The ambient facade delegates the prepared operation, and both candidate/balance reads use one caller transaction. Exact master/chain, cloned time and finite nonnegative balance window are captured before acquisition.
- Balance/default/projection helpers are shared outside ambient modules. Unknown/stale/unpriced balances remain unknown; incomplete capacity coverage cannot establish availability. Balance projection is not exact follower order sizing.
- `apps/signal-engine/src/fanout-policy-owned.ts` exposes mandatory-port current admission/cohort composition; production boot delegates to it. Protected accepted-source lookup, exact source/job/recipient binding, current blacklist/policy/mode, reducing owned-inventory scope, stable/retryable refusal distinction and the 1000-member cohort bound are retained. Descriptors and source inputs are detached before awaits/acquisition.
- Existing durable admission-before-claim, immutable replay, position-first locking, persisted obligation authority and checked COMMIT-before-queue protocols remain outside the factory's authority. A supplied client, callback or factory grants no database authorization.
- Fresh-child containment invokes actual owned candidate/cohort/admission bodies across 16 source modules with `pg.Pool`/`pg.Client` constructors trapped. Owned constructors remain zero; a real ambient candidate facade triggers the positive control. This is source import containment, not PostgreSQL/server containment.

## Final immutable verification epoch

| Check | Result |
| --- | --- |
| `build-w4-p4b-fanout-offline-04` | 757 tests passed; 28 literal files |
| `build-w4-p4b-main-offline-04` | 948 tests passed; 36 literal files |
| `build-w4-p4b-load-offline-04` | 46 contracts passed; 1 literal file; no actual load |
| `build-w4-p4b-db-typecheck-04` | noEmit/incremental:false; exit0 |
| `build-w4-p4b-qualification-typecheck-04` | noEmit/incremental:false; exit0 |
| `build-w4-p4b-signal-engine-typecheck-04` | noEmit/incremental:false; exit0 |
| `build-w4-p4b-trade-executor-typecheck-04` | noEmit/incremental:false; exit0 |
| `build-w4-p4b-api-typecheck-04` | noEmit/incremental:false; exit0 |
| `build-w4-p4b-api-tests-typecheck-04` | noEmit/incremental:false; exit0 |
| `build-w4-p4b-lp-typecheck-04` | noEmit/incremental:false; exit0 |

All ten test/noEmit commands share unchanged complete consumed-input manifest `770ccc9feb5dd1cce3800f97fc159bd24eecda9a9f7d118290361c2915ab8edf`. Fresh DB emit `build-w4-p4b-db-emit-04` is separate; complete emit-input equality and current output hashes were verified. The affected config has 28 exact unique literals and reviewed hash `5444170ba5ed4b875ba392b6dac5ed01ce7a059fc657ed80a83b7e810343b90e`.

CPU0/shared flock, one test fork/512MB heap, compiler640MB and synthetic offline network/credential guard retained. Runner caps are disabled (`timeoutSeconds:null`); application transaction/operation/cancellation/shutdown/load-drain and containment-child safety deadlines are unchanged. Scopes overlap and are not summed into runtime coverage.

## Retained failures and repairs

1. `build-w4-p4b-db-emit-01` failed because `BalanceSource` was reexported but missing as a local type binding. A type-only shared-leaf import repaired it.
2. `build-w4-p4b-fanout-offline-02` retained 742 passed/15 failed/757 total across 28 files. Fourteen settings fixtures lacked the checked COMMIT command tag; one capacity fixture expected admission from partial-unpriced coverage. Fixtures now model checked COMMIT and the existing conservative capacity refusal; production checks were not weakened.
3. `build-w4-p4b-signal-engine-typecheck-03` caught Vitest generic-mock erasure. The fixture now uses a genuinely generic transaction function and a separate acquisition spy, preserving result typing without a cast to the production generic port.

Earlier passing partial epochs remain historical. The accepted [P4a checkpoint](WAVE4-P4A-OWNED-CHECKPOINT.md), [initial REJECT](WAVE4-P4A-OWNED-REVIEW.md) and [repair ACCEPT](WAVE4-P4A-OWNED-REPAIR-REVIEW.md) are retained for their exact source state; their full manifest does not cover later P4b inputs.

## Independent review qualifications

The accepted [review](WAVE4-P4B-FANOUT-OWNED-REVIEW.md) distinguishes normalized chain-prefixed candidate scope from full address validity, which the production policy source capture validates. Missing blacklist rows retain the predecessor's empty-list behavior; malformed present values refuse. Explicit capacity skip decisions, including incomplete price coverage, retain their inherited classification rather than every unassessable condition being called retryable. Float balance projection is not an exact or always-conservative monetary ceiling.

Nonblocking preparation-guard coverage gaps remain for invalid factory limits, malformed source UUID/address/time variants, every source/job chain-direction mismatch, descriptor serialization/root-shape refusal variants and a separate valid1000-member unique-tenant case. No introduced executable blocker was established by these gaps. Source inspection and coordinator raw-artifact validation are separate.

## Outstanding scope and authority

Protected cross-tenant `swat_fanout` provisioning/current capability validation, exact approved follower buy sizing, provider/intake/capability/risk/receipt/valuation/correction backing and full P4b provisioning remain incomplete. P4c executed buy/sell/reversal/correction/replay and independent durable observation remain coding work. No schema/grant or broker changes were made for this slice.

SQL083/084/087 and installation-plan pins remain preserved; canonical001–087 excludes refused084 (86 migrations), and the079/082 broker remains exactly seven transfers. No SQL was applied. No infrastructure/services/credentials/live signing/funds/load/commit/push/publication occurred. Public positive-pipeline/qualification and Package28 refusals remain.

Full `p4bSourceAccepted`, `p4SourceAccepted`, `sourceComplete`, `runtimeAccepted`, `liveCapabilityAccepted` and `productionReady` remain false. Dependent Wave5 runtime requires genuine separately authorized I1–I8 acceptance. Broader source work is enumerated in the [remaining-work map](WAVE4-REMAINING-WORK.md).
