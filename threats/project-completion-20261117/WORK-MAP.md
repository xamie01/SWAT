# Project technical completion work map — 2026-11-17

## Objective

Finish remaining technical implementation and acceptance, excluding legal requirements, using exclusive subagent ownership and mandatory independent-review/report gates. Baseline captured in BASELINE.json; inherited commit564818d and84 changed-source fingerprints are not a clean checkout. Preserve previous evidence and all unrelated work.

## Readiness levels and authority

Track separately: source implemented; injected integration verified; real runtime accepted; live capability accepted. A passing mock, static source test, unavailable response or inventory exit0 cannot advance a runtime gate. No production readiness certification without actual evidence.

Approved now: local source changes, reviewed keyless offline literal tests, bounded emits/typechecks and source/security checks. CPU0 shared flock `/tmp/swat-package11-checks.lock`, tests512MB/onefork, compilers640MB. No rootTurbo build/test, fullNext build, dev/container startup, install/download, credential use, real signing/keygen, provision/apply production migrations, publish/commit/push/live funds. At external execution boundary request exact environment/tool/provider identity and authorization. No flag/digest grants permission.

## Mandatory stage protocol

Implementation owner defines exact scope/test seams and returns changed paths, capabilities and blocked inputs. Freeze source; run affected guarded checks and independent read-only review sequentially; repair supported findings and rerun; coordinator reconciles raw report/source/manifest/hash consistency and records acceptance or rejection. Only after the gate start a dependent package. One implementation or review subagent is active at a time with exclusive files; all checks are serialized and wait for consumed source freeze. Runtime-dependent waves cannot advance on source acceptance alone.

## Ownership

Coordinator owns root runner, barrels, migration integration/final shared joins/reports. Core source/ledger owner alone edits canonical lifecycle; fanout owner submits required claim extraction and does not edit that file. One API integrator owns me.ts. Domain new modules exclusive. Schema suffixes allocated centrally after checking highest; no old migration rewrite.

## Waves

1. **Source and obligations:** A source/indexer evidence/history new modules + canonical lifecycle same-client verifier/claim; B signal-engine durable fanout identity/descriptor; coordinator joins exports/schema. Immutable evidence network/tx/event/wallet/asset/direction/rawscale/finality/provenance, reversal/replay/recovery. Certificate labels never verifier authority. Ambiguous DataAPI not unique fill. Source claim/captured policy and immutable CanonicalWorkerJob persisted beforequeue; pre-effect risk stays worker trustedquote boundary.
2. **Runtime and corrections:** C obligation-derived scoped transaction + provenance-bearing paperbuy/sell quotes/startup ports; D append-only quote/fee corrections referencing immutable fills, idempotent same-client accounting no inventory duplication. Restricted operator/capture capability no wildcardbypass. Actual signer/provider trust remains unavailable until valid inputs.
3. **Feature domains:** E separate wraponly custody/enrollment/executionunwrap + deployed delegation scope; F exact durable withdrawal/one-use authorization/cooling/outbox/reconciliation + spot/perps reducing intent/receipts; G actual LPvaluation/economics/paper/copy/live protocol ports; H sole API/frontend joins accepted contracts and capability states. Per-domain independent review/report gate.
4. **Real paper integration:** I qualification orchestrator actual independentPG16reference/candidate+Redis identities/resources/journal/catalog/roles/RLS/concurrency/crash/restart/queueack proofs. Existing isolation refusal remains until separately reviewed/authenticated execution. No container/service work current host. Synthetic data fixturepaper not provider verification. Added load/resource subgate uses `deploy/loadtest/wave4/run.sh`: 100000 synthetic users, random10000 identity SharedArray, gradual2000+7000 peak9000, weighted app endpoints and PostgreSQL/PgBouncer/Redis/BullMQ memory/wait observations. Full original and added gates: [WAVE4-QUALIFICATION.md](WAVE4-QUALIFICATION.md); load observations never replace concurrency/crash/queueack/domain proofs.
5. **Native and release:** J freshNext/browser/RustAnchorIDL/CPIrollback/nativeMLparity separatecapableapproved environment; K immutable images/deps/artifacts consistentdisabledCI + servicegraph/TLS/state/monitoring/restart/encryptedbackup/actualrestore proof. Never selfapprove locks/enablepublish. Controlled canary no funds/signing by default; external/live separately authorized.

## Wave4 main implementation checkpoint

P1 protected LP admission, P2 migration installation and P3 authentication have bounded independent source acceptance. The last reconciled freeze passed948 main tests/36 files,46 separate load contracts and five DB/qualification/API/API-tests/LP noEmit checks. Earlier422/15 and load44 descriptions are historical, not current. SQL083 remains preserved, SQL084 refused, and085–087 unapplied. P4a owned production pipeline foundations started2026-11-20; new checks wait for source freeze. P4b/P4c backing/scenarios, P5 financial composition, P6 races/faults, P7 durable load correctness, P8 executable coordinator/cleanup and P9 final audit remain. See [remaining-work map](WAVE4-REMAINING-WORK.md), [source-completion map](WAVE4-SOURCE-COMPLETION-MAP.md) and current checkpoint/evidence. Protected receipt source is repaired and narrowly accepted, but actual PostgreSQL/ACL/RLS/locking/runtime behavior remains unqualified. Public qualification/positive pipeline/Package28 refusals and sealed Waves1–3 remain. Full Wave4 and dependent Wave5 runtime acceptance are still blocked.

## Completion requirements

Wave1 tests real descriptor→worker seam, wrong evidence/scale/network/tenant/reorg/replay and commitbeforequeue. Wave2 exactscope/staleauthority/unknowncorrection/rollbackinventory tests. Wave3 real injected domain/route tests, no falseclose/credential authority. Wave4 real isolated infrastructure acceptance or explicitblocked. Wave5 native/browser/service evidence or explicitblocked. Final dedupmanifest allrequiredassertions zero fail/skip/todo, source/tool/config/lock/artifact hashes stable, resource/timeout/cleanup evidence retained. Changes invalidate affectedchecks. Reevaluate supported source findings and repair; broad security certification not inferred from reviews.
