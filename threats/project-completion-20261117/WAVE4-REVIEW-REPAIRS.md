# Wave4 supported review repairs — 2026-11-18

## Disposition

**Credential repair and SQL084 unconditional proposal containment received narrow independent source acceptance. Whole-Wave4 source/runtime acceptance remains withheld.** No SQL, infrastructure, credentials, providers, signing or load execution occurred. SQL083 was not changed. Refusal is containment, not a functional receipt-boundary repair or gate completion.

## Original supported findings

Expanded read-only reviewer `agent_2c9a653b-3ab4-41b1-a6c5-57e942cf5018` withheld acceptance and identified:

- HIGH: SQL084 checked trigger identity/events/owner but not conditional qualification, column coverage or installed function body.
- HIGH: SQL083 allows tenant-writable paper receipt labels/economics reconciled against matching self-supplied operation/position data, without independently admitted provider/quote/economic SQL binding.
- MEDIUM: catalog passed URL-percent-encoded credentials directly to pg_dump.

## Implemented and verified

- `infrastructure.ts` decodes username/password exactly once before command admission; password remains only in PGPASSWORD. Nine catalog contracts include reserved characters, literal percent/plus, malformed escapes refused before commands and exact returned migration rows.
- SQL084 first executable statement unconditionally raises. All eleven proposed grants stay within that DO block; no statements follow it. This contains the new proposal even for SQL clients that continue after errors. It does not revoke existing SQL083 privileges or repair an installed database.
- The unreachable proposed trigger checks include tgqual, exact tgattr (canonical legacy UPDATE OF state), trigger arguments/constraint/transition metadata, function signature/language/attributes/configuration and six literal SHA256 body pins. Ten static privilege contracts independently derive pins from sealed SQL066/083. No SQL parser or PostgreSQL executed these predicates.
- Current `faults.ts` wording correctly names the accepted same-job BullMQ source as unexecuted, separate from missing Redis-loss/source/outbox/canonical faults.

## Actual checks

Sequential CPU0 shared-flock runner, synthetic environment/offline network and credential guard, one fork/512MB test heap and 640MB compiler heap:

- `build-w4-main-offline-18`: 366 passed, zero failed/skipped/todo, 13 literal files, exit0.
- `build-w4-main-typecheck-16`: qualification noEmit/incremental false, exit0.
- Shared input manifest SHA256: `9137bbd1b613dfb552cea6d9f1e894f53f96e54cbbf6d54a27bde71c5f0f5369`.

These are local/injected/static checks, not actual SQL/driver/lifetime/financial acceptance. Heap limits are not whole-process RSS bounds. Earlier expanded failures and superseded successes remain locally retained; totals are not summed.

## Targeted independent recheck

Reviewer `agent_4f7b29ea-0748-4d30-9ba6-63ebb0adf334` performed exactly six focused Read calls and no edits, commands, tests or runtime activity. Verdict:

> Acceptable for the narrow credential repair and unconditional containment of the SQL084 source proposal. No supported introduced defect was identified in the six permitted excerpts. This does not accept SQL084 as a usable migration, establish installed ACL repair, or resolve the HIGH SQL083 receipt-integrity finding. Whole-Wave4 remains incomplete; Wave5 remains blocked.

The reviewer accepted exactly-once decoding/password separation and same-block refusal including continue-on-error clients. Proposed trigger/body pins remain unexecuted and are not installed dependency/search-path/catalog attestation. The 366-test result is coordinator evidence, not reviewer rerun.

## Unresolved required work

HIGH SQL083 paper accounting integrity remains unresolved. Completing it requires a supported additive source proposal for independently protected receipt admission, admitted quote/provider/network/action/hash/economic SQL binding and correct writer/store transaction composition, without inventing capability or widening runtime authority. Actual hostile same-tenant SQL and installed constraint/trigger behavior require separately authorized isolated PostgreSQL16 qualification.

Remaining protected auth/pipeline/custody/withdrawal/reducing/LP composition, I5 races, I6 faults, I7 durable load/economic joins and all I1–I8 runtime evidence are unchanged requirements. The current migration suffix and refusal must be reflected in any future independently reviewed load/reference baseline; the accepted load source still pins SQL083 and was not altered here.

`sourceComplete=false`, `runtimeAccepted=false`, `liveCapabilityAccepted=false`, `productionReady=false`. No commit or push.
