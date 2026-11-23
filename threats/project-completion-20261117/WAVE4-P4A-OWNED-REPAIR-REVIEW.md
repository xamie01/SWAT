# P4a owned pipeline foundations — independent repair re-review

## Verdict: ACCEPT

**Bounded P4a source only**, after R1/R2 repairs. Reviewer: `agent_ab26c315-4c83-420c-924a-4210bb0d11ab`. Read-only source inspection, recorded by the coordinator on 2026-11-23. The [original REJECT](WAVE4-P4A-OWNED-REVIEW.md) remains valid for its earlier source state.

## R1 closed — immutable signal trigger capture

`packages/db/src/copy-trade-lifecycle-owned.ts:2925–2935` synchronously serializes/parses the spread trigger payload before returning a prepared operation. Nested caller references are removed; Date and toJSON results are captured before acquisition; serialization failures propagate synchronously. Null, array and primitive serialized roots are refused. The ambient facade still prepares before withTransaction (`copy-trade-lifecycle.ts:38–39`); authoritative source fields still overwrite caller fields afterward (`copy-trade-lifecycle-owned.ts:945–956`) using the detached snapshot.

Regression source (`tests/qualification/wave4/pipeline-owned.offline.test.ts:120–150`) covers nested-array/Date mutation, mutable serialization-hook backing data, a single hook invocation, canonical identity overwrite and cycle/BigInt/throwing-hook refusal before acquisition or querying.

## R2 closed — detached trade timestamps

`packages/db/src/trades-owned.ts:182–183` clones both non-null timestamps by milliseconds; null/undefined still become SQL null. Prepared operations retain detached Dates and `trades.ts:7–10` still prepares before acquisition. Regression source (`packages/db/src/trades.test.ts:39–58`) mutates both originals before querying and verifies retained values/distinct identities and null/undefined semantics. SQL, parameter order and ownership predicates are unchanged.

## Preserved findings and limits

No remaining concrete blocker was found in the exact repairs. The original bounded review's parity/import/authority/accounting/lock/obligation observations remain applicable. No ambient imports, transaction ownership or SQL changes were introduced. Checked SQL083/084/087 and installation-plan boundaries have no working-tree diff against HEAD.

One nonblocking coverage gap remains: root toJSON returning null, array or primitive is not directly tested. The guard refuses those results synchronously; this is not a supported acceptance blocker.

The reviewer executed no tests, compilers, loaders, services, SQL or network; made no edits; spawned no agents; and did not authenticate the repair freeze, command results, DB emit or counts. Coordinator artifact validation is separate. This ACCEPT covers shared extraction and owned P4a foundations, not protected P4b/P4c backing/composition, actual PostgreSQL/RLS/concurrency behavior or full pipeline/runtime acceptance.
