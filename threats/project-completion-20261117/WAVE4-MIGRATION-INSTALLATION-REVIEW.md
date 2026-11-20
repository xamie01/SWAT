# Wave4 migration installation review — 2026-11-18

## Verdict

Independent read-only review did **not** accept the initial P2 installation source. No PostgreSQL, roles, broker, SQL, credentials, or services were executed. The repair owner is assigned the four supported source findings below. Runtime and full Wave4 source completion remain false.

## Supported findings

1. `installation-plan.ts:64–65,81` compares source `timestamptz` spelling against PostgreSQL's `timestamp with time zone` result deparser, rejecting the intended first079 handoff. Pin canonical type metadata rather than source alias spelling.
2. Broker invocation/retirement predicates establish only partial catalog identity. Add checksum-bound read-only exact bootstrap validation covering both routines, full signature/options/ACL, namespace, privileged owner, restricted targets and extra objects. Return validated OIDs; pristine callers may exempt only these validated objects, never names alone.
3. `086_wave4_restricted_composition.sql:107–164` leaves protected admission table/column ACL drift untouched. Unexpected runtime TRUNCATE is outside RLS and row-trigger protection. Restore/reject exact canonical admission and SELECT-only context privileges, including third-party and grant-option drift.
4. `086:44–98` establishes required trigger presence rather than complete trigger inventory and omits full function argument/options metadata. Reject added noninternal triggers and pin the legitimate historical inventory.

## Reviewed mechanism and limitations

The externally provisioned NOLOGIN superuser broker, not the restricted migrator, owns transfer authority. Pre-transfer grants on the two public settlement entrypoints followed by ownership transfer preserve target-owner application EXECUTE while temporary migrator EXECUTE WITH GRANT OPTION supports sealed trailing statements. Retirement CASCADE must be verified in actual PostgreSQL; offline string assertions do not establish its result.

Selection hashes and audit references are consistency/review records, not authenticated runtime approval. LOGIN VALID UNTIL bounds password validity, not every authentication mechanism or existing sessions; scheduled NOLOGIN and external session drainage remain necessary.

## Coordinator wiring scope

Production migration, independent schema reference/candidate comparison, Wave4 pristine apply/catalog, and remote load baseline consumers are being changed to explicit reviewed selection and actual installed-SQL checksums/audit identities. Original SQL001–085 bytes remain unchanged. Default discovery continues to refuse unreviewed forward proposals. No apply or publication is authorized by this report.
