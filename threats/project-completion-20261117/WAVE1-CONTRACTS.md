# Wave 1 shared contracts — proposed implementation join

Source owner exports `SourceSignalCopyClaimInput`, `SourceSignalCopyClaimResult` and `claimSourceSignalForCopyExecutionWithClient(client,input)`. Result execution|null/created/claimed/reason; old wrapper delegates sameclient. No nested/global tx/query authority. Claims require persisted exact accepted verifier evidence, preserve tenant/target/acquisition/replay/quantity/master history gates. Global readiness/callerlabels do not grant trust.

Fanout owner composes admitted recipient→sameclientclaim→capturedpolicy→complete immutable CanonicalWorkerJob persisted as descriptor before queue. Skipped/excluded recipients must not acquire inventory reservations. Replays use committed descriptor/claim identity. Risk reservation remains worker preeffect trustedquote boundary.

Coordinator migration allocation:077_source_verified_evidence.sql,078_canonical_fanout_obligations.sql. Content submitted by exclusiveowners; coordinator reviews/writes actualfiles. No old migration edit or appliedSQL on host.

Verification: new evidence-dir runner option fixed whitelist, configs parenthashapproved; A/B finishsourcefreeze before alltests/emits. Current sourceowner lifecycle no overlap fanoutmodule. Exact file contracts and new raw evidence reviewed, then independentreview and coordinatorstagegate. This document is coordination, not source acceptance.
