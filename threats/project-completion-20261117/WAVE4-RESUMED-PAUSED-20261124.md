# Wave 4 resumed batch — paused 2026-11-24

## Outcome and preserved baseline

The resumed batch started from committed `1232c9e3cc8a16008daa5ab980de8036cba0f324` with a clean working tree. Local changes are preserved and uncommitted. The executed-pipeline provider request failed for insufficient credit ($0.859640 available versus $1.141248 required); the pipeline-schema writer also failed ($1.486030 versus $1.491672). These are the provider's per-request reports, not a current balance estimate.

All remaining authoring/review was stopped. No tests, parsing, compilation, emits, verification hashes, services, SQL/provisioning, credentials, signing, funds, actual fault/load work, installation, commit, push or publication ran. This is a paused partial-source checkpoint, not a complete or verified global freeze. SourceComplete, runtimeAccepted, liveCapabilityAccepted and productionReady remain false. Historical accepted work and raw evidence remain historical; changed inputs do not match their manifests.

## Owner disposition

- Runner: owner FROZEN. Changed `scripts/build-completion-runner.py` and `.test.py`; input-policy JSON unchanged. Authored direct-regular-file evidence exclusion and waitid/WNOWAIT leader-preserving shutdown/reap ordering. Tests unrun. Independent reviewer was stopped without a completed verdict; P0 remains independently REJECTED pending complete re-review.
- Worker: stopped before final freeze report. Partial changes in capability/risk/valuation/receipt leaves are preserved. Planned additive TS cancellation and persisted recovery reconstruction are not established as complete. App worker composition and existing test have not received a completed resumed integration/freeze report. TEN purposes, seven scalar JSONB signatures and sole canonical obligation lookup remain required contracts.
- SQL088: owner PAUSED, only SQL changed. Provisioning module and offline test absent. **Known broken draft hazards:** broad `<>` replacement changed embedded pinned SQL080 predecessor bodies, and enrollment trigger references `public.pipeline_follower_authorities` before creation. Repair these before any validation/use; original SQL001–087 files were not edited. Follower validation, nullable-original receipts, replay/current-control locks, forward074 capture, scoped ACL/settlement closure, catalog/FK pins and separate two-lookup DBA handoff remain incomplete.
- SQL089: owner PAUSED. SQL and `wave4-financial-backing-owned.ts` changed; provisioning module and offline test absent. Partial external-only identity checks, explicit unavailable database-backend approval, invoker custody audit refusal, independently persisted LP initialization, and stronger spot checks preserved. NULL-safe nested payload/chronology/concurrency/ACL/FK/source-pin closure and canonical adapter alignment remain unfinished.
- SQL090: stopped before final freeze report. SQL changed; `wave4-load-capture-owned.ts`, provisioning module and offline test absent. No authenticated public route/contained-consumer integration established.
- Executed pipeline: provider failed. Partial `pipeline-economics.ts`, `pipeline-executed.ts` and `pipeline-sql-observer.ts` changes preserved. Both newly assigned offline test files absent. No final alignment, completion or freeze report; independent observer authorization remains source-refused.
- Runner review: stopped; no new ACCEPT or complete review established.

## Coordinator authored/frozen source

Eight source/test files are frozen by coordinator, authored but unverified:

- `packages/db/src/execution-grant-projection.ts` (new)
- `packages/db/src/execution-grant-projection.test.ts` (new)
- `packages/db/src/custody-store.ts`
- `packages/db/src/custody-store.test.ts`
- `packages/db/src/execution-grants.ts`
- `packages/db/src/execution-grants.test.ts`
- `packages/db/src/copy-trade-lifecycle-owned.ts`
- `packages/db/src/source-claim.sequential.test.ts`

Public presence metadata now uses `key_version IS NOT NULL`, relying on unchanged SQL047 paired-presence constraint, and both facades delegate one pool-free projection. No ciphertext grants were added. Five projection cases are authored; existing expectations updated.

Canonical claim snapshots the supplied date as milliseconds and advances it by monotonic elapsed time. Accepted-source authority is reread after execution-lock waits and before admission; signal/position-evidence expiry is checked again after sell-inventory work. Claimed timestamp uses admission time. Ten injected regressions cover advisory/signal/source/execution waits, provider expiry before replay, signal/evidence/provider expiry during inventory, input date mutation and invalid date. These are authored scenarios, not actual database blocking/isolation proof. Full race/fault/cancellation/transaction-expiry closure remains unfinished.

## Confirmed absent companion files

- `deploy/postgres/wave4-pipeline-provisioning.ts`
- `deploy/postgres/wave4-financial-provisioning.ts`
- `deploy/postgres/wave4-load-provisioning.ts`
- `packages/db/src/wave4-load-capture-owned.ts`
- `tests/qualification/wave4/pipeline-provisioning.offline.test.ts`
- `tests/qualification/wave4/financial-backing.offline.test.ts`
- `tests/qualification/wave4/load-capture-backing.offline.test.ts`
- `tests/qualification/wave4/pipeline-executed.offline.test.ts`
- `tests/qualification/wave4/pipeline-sql-observer.offline.test.ts`

## Genuine source blockers and restart gate

Still source work, not merely credentials: exact observer enrollment/RLS/ACL; restricted cross-role backend observation; custody SQL081 invoker full-admission read/lifecycle sharing/scoped audit; canonical withdrawal account journal and zero-base fee-only evidence; full source/fanout/control/capacity/worker settlement lock and privilege closure; authenticated public load correlation/import containment; canonical race/child/Redis/ACK faults; private callable I1–I8 and owned cleanup/partial evidence; exact migration/install/catalog/incoming-FK integration.

088–090 remain unreviewed, unselected and unapplied. Preserve SQL083/refused084/087 pins, prior47-constraint/188-enforcement-path baseline and exactly seven existing079082 broker transfers. No broad grants, memberships, SET ROLE, stats authority or migrator/runtime substitution.

Restart development only after provider access/credit supports the requests and continuation is requested. Inspect these preserved partial files, prioritize known SQL088 draft hazards, allocate at most six exclusive owners, and finish supported source. Independent runner acceptance and complete consumed-source freeze precede new additive command bindings and guarded sequential verification. Preserve all historical artifacts and failed attempts. Runtime acceptance still requires separately authorized disposable infrastructure and actual I1–I8 proof; Wave5 dependent runtime remains blocked.
