# P4b owned candidate/current-admission/cohort composition — independent source review

## Verdict: ACCEPT

**Bounded P4b fanout source slice only.** Reviewer: `agent_aae19d76-12bc-4191-8a1d-7d3391676cdb`; read-only inspection against HEAD `c78fa16521414a849fe0d2c7cbaf55a010e19912`, recorded by the coordinator on2026-11-23. No concrete blocking defect introduced by the slice was found. Historical bounded P4a acceptance remains intact. Full P4b, P4, Wave4 source completion, runtime/live acceptance and production readiness remain false.

## Canonical candidate SQL and preparation

`packages/db/src/fanout-candidates-owned.ts:172–210` preserves both predecessor SELECT statements, parameter/result order, exact master-wallet equality, non-ended subscriptions including winding_down, active accounts, left-joined settings, positive confirmed-position counts across chains, and balance reads scoped to the requested chain/enumerated users. Mapping at224–252 preserves tier fallback, subscription state, missing-row defaults, false/zero nullish semantics, unreadable-count refusal and all-or-unknown balance aggregation.

Both SELECTs now use one mandatory caller client rather than separate ambient queries. The compatibility facade preserves the cross-tenant scope marker and delegates through existing transaction ownership. A marker/client is not database authorization. Preparation at148–168 captures exact normalized master/chain, cloned Date and nonnegative finite balance window before acquisition and refuses mismatch/wildcard/invalid time. **It uses resolveChainValue, not resolveChainAddress: it establishes normalized exact chain-prefixed scope, not full address validity. Production policy source capture performs the stronger address validation.**

## Shared helpers and owned import boundary

`user-balance-state.ts:62–79,84–118` preserves finite numeric handling, unknown NUMERIC-text fallback rather than unsafe Number coercion, separate exact amount text, and all-or-unknown totals for empty/stale/future/unpriced/negative/nonfinite observations. Maximum-age equality stays valid. `user-execution-defaults.ts` preserves frozen missing-row defaults and canonical risk/position constants. Persistence/validation bodies in the compatibility modules are unchanged. Enumeration defaults are not promoted to current persisted-policy authority.

`fanout-policy-owned.ts:1–14,30–43` uses a genuinely generic transaction and mandatory mode/safety/capacity ports with owned/pool-free DB runtime leaves. Type-only capacity-inputs references do not enter its runtime graph. No ambient Pool fallback or boot is introduced. Shared network-capable exports do not themselves invoke the lazy Redis constructor in `packages/shared/src/logger.ts:59–66`. This is a static source conclusion, not an executed containment verdict by the reviewer.

## Current admission and exact binding

`fanout-policy-owned.ts:50–69,167–168` captures dates and JSON-detaches descriptor fields before asynchronous reads, validating source/signal/tenant identities and canonical target/token chain scope. `fanout-canonical.ts:110–119` requires accepted protected verification first; `source-verification-store.ts:30–58` binds source, immutable binding/head/evidence, enabled provider authority and active position application. Labels alone are not sufficient.

Current admission at87–129 uses the supplied client to bind signal/source, compare chain/token/direction, require confirmed/finalized finite nonfuture fresh source, check blacklist, operator opt-in, current mode/recipient scope, immutable mode/target, buy safety and score. This matches the predecessor policy with explicit ports and added capture rather than relaxed rules. **A missing blacklist row retains the predecessor's empty-list behavior; a malformed present value refuses. Acceptance does not assert every absent configuration value is unknown-policy refusal.**

## Cohort and reducing sells

`fanout-policy-owned.ts:173–215` captures source/eligibility and JSON-detaches job plans before acquisition, checking source/job ID/token/direction/chain agreement. Accepted verification precedes candidate/mode/capacity/scope reads. Candidate/balance SQL shares a client; enumeration failure is not successful operator-only fallback. The1000-follower-outcome bound precedes scope transactions; stable exclusions are checked before/after scope, and explicit operator/follower tenant/mode/target identity is retained.

`fanout-canonical.ts:89–104` retains an explicit stable whitelist and retryable default. Null balance/mode/capacity outcomes and reader failures refuse; unknown strings do not become stable merely by wording. **The inherited capacity resolver's explicit skip decisions, including partial-unpriced coverage, remain unchanged; not every unassessable capacity condition is claimed retryable.**

Reducing sells bypass buy-only balance/score/position/capacity/safety gates but retain blacklist/opt-in/account/persisted-policy/subscription/mode stops. `package13-fanout-delivery.ts:245–321` derives one attributable acquisition-lot target/mode; `lot-allocation.ts:92–236` retains exact owned/held/unreserved availability and provenance. Missing/mixed/unreadable inventory does not authorize an exit.

## Production delegation and durable protocol

`apps/signal-engine/src/index.ts:234–264` actually delegates production composition with existing transaction/mode/safety/capacity/opt-in/paper-target/clock/log adapters. This is not a qualification-only duplicate.

`fanout-enqueue.ts:401–508` retains separately committed seeds, deterministic whole-cohort position-first locks, current admission before preparation on the same client, atomic obligation completion and persisted replay rather than current subscribers. At520–536 durable preparation is awaited before queue publication. `transaction.ts:35–58` checks COMMIT command/session errors before returning results. `package13-fanout-delivery.ts:339–451` retains immutable delivery comparison and uncertainty reconciliation. The factory introduces no claim/capability registration/queue publication/role membership/SET ROLE/broker expansion.

## Projection, fixture repairs and nonblocking gaps

`capacity-projection.ts:69–103` preserves the provisional-admit whole-known-balance summation as a loose float64 estimate, **not exact follower sizing or proven spend authority**. The inherited invalid-balance skip branch at85–89 does not itself guarantee an over-estimate after hypothetical reordering despite its comment. Current canonical candidates are finite/nonnegative or unknown excluded before buy capacity; no new executable blocker was established. Floating summation/cache do not prove an exact always-conservative monetary ceiling.

Fixture repairs match unchanged production checks: settings transaction command tags at`user-execution-settings.test.ts:113–120`; partial-unpriced skip expectation at`capacity-inputs.test.ts:671–691`, matching `master-capacity.ts:784–822`; genuinely generic transaction plus separate acquisition spy at`fanout-policy-owned.test.ts:58–68`.

Nonblocking guard-coverage gaps remain: invalid factory limits; malformed source UUID/address/time variants; every source/job chain-direction mismatch; descriptor serialization/root-shape refusal variants; and a distinct valid1000-member unique-tenant boundary case. The1001-row test is not exhaustive boundary proof. These are coverage gaps, not established source defects.

## Evidence and completion limits

The reviewer inspected `pipeline-fanout-owned.offline.test.ts:10–117`: actual fresh-source loading, PG constructor traps, required/forbidden modules, actual owned-body invocation with inert replies and real ambient positive control. It was not executed by the reviewer. Its runtimeAccepted:false is appropriate. Inert replies do not prove PostgreSQL typing/RLS/grants/concurrency/provider authenticity/deployed resolution. The28 literal config and SHA `5444170ba5ed4b875ba392b6dac5ed01ce7a059fc657ed80a83b7e810343b90e` were independently inspected against reviewed-configs; that proves config consistency only, not epoch counts/manifest/noEmit/fresh emit.

Protected cross-tenant `swat_fanout` backing/provisioning remains absent. Exact follower buys remain unavailable: index.ts:258–259 injects provider:null and `exact-follower-sizing.ts:44–47` refuses without cache/master-fill fallback. Provider/intake/capability/risk/receipt/valuation/correction backing, full provisioning and P4c executed/durably observed scenarios are outside this ACCEPT. SQL083/084/087 and installation-plan have no changed bytes relative to HEAD; this is not broader installation acceptance.

Review actions were read-only source/git/hash inspection. No edits, nested agents, tests, compilers, loaders, services, SQL execution, network, installation, commits, pushes or publication were performed. Coordinator raw-artifact validation and [bounded checkpoint](WAVE4-P4B-FANOUT-OWNED-CHECKPOINT.md) are separate. The [P4a repair ACCEPT](WAVE4-P4A-OWNED-REPAIR-REVIEW.md) and [remaining-work map](WAVE4-REMAINING-WORK.md) retain their scope boundaries.
