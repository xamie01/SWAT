# Wave4 migration installation repair acceptance — 2026-11-18

## Outcome and scope

Independent reviewer `agent_5ef4df85-ebaf-4029-9a7a-732f95ca1d37` returned **ACCEPT — repaired narrow P2 source** after the supported repair loop. This accepts the reviewed source boundaries only. It is not PostgreSQL execution, broker provisioning, installed catalog/ACL/trigger proof, authenticated external approval, whole-Wave4 source completion or runtime acceptance.

## Supported repair history

The original review rejected incomplete bootstrap/ACL/metadata/trigger checks and password-expiry lifecycle assumptions. The four-file repair was then rejected for constructing nonexistent qualified SQL aliases: `pg_catalog.integer`, `pg_catalog.boolean`, and `pg_catalog.timestamp with time zone`. The coordinator replaced those with canonical catalog identities `int4`, `bool`, and `timestamptz`, retaining OID comparisons. A finite map initially omitted the sealed082 `trigger` return type; independent review and offline29 caught that deterministic plan-construction failure. The map and generated-gate regression now include `trigger` and continue to reject unknown types.

## Accepted bounded conclusions

- Locally generated installation plans retain provenance checks; reviewed callers recreate plans and allow only validator-returned namespace/function OIDs in pristine checks.
- Seven exact source-pinned owner substitutions preserve historical source checksums and separately record actual installed-SQL checksums/audit identities.
- Pretransfer app grants, temporary migrator grant option, and retirement CASCADE ordering are source-consistent with retaining target-owner app grants.
- Bounded pre086 trigger inventory includes nine085 and seven sealed066/076/083 triggers, rejects extras and checks detailed metadata.
- Protected admission ACL restoration excludes TRUNCATE and column backdoors; admitter context access is SELECT-only.
- Password VALID UNTIL is distinguished from externally enforced NOLOGIN and session draining.

## Verification, reconciled separately by coordinator

Frozen offline30 passes602 tests across24 literal files. Load offline10 passes45 tests in its separate subgate. Qualification typecheck29 and DB typecheck04 pass noEmit/incremental:false. All four share consumed-input manifest `1dbab95686948e5024e9da3afef30239f7c4f437fe692a3d3c1f7f1432f3391a`, CPU0 shared flock, synthetic/offline guard and unlimited test wall-clock option. Tests remain512MB/onefork and compiler640MB; these are heap rather than RSS limits. Failed offline29 and earlier evidence are retained, not overwritten or summed.

The reviewer did not run verification. The initial type-resolution findings were checked against PostgreSQL16 upstream parser/catalog source, not a running server. Final delta reviews used three then two short Reads only. No SQL, service, credentials, signing, commit or publication occurred. Historical001–085 and refused084 remain preserved. Subsequent087 authentication work requires explicit selection extension and new affected verification; this acceptance does not cover that future source.
