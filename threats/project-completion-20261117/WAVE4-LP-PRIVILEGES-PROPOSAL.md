# Wave4 base-LP privilege proposal — application refused

**The source proposal is contained, not accepted as a usable migration.** SQL084 unconditionally raises before any proposed privilege change. All eleven proposed grants are inside that same anonymous block, so a SQL client that continues after an error cannot execute them as separate statements. No SQL application or runtime qualification occurred. runtimeAccepted=false, liveCapabilityAccepted=false, productionReady=false.

## Supported review findings and disposition

Independent reviewer `agent_2c9a653b-3ab4-41b1-a6c5-57e942cf5018` withheld affected-scope acceptance on 2026-11-18.

1. **Incomplete installed trigger/function checks.** Identifying metadata alone admitted a financial trigger with `WHEN(false)`, an unexpected `UPDATE OF` restriction or an altered function body. The proposed checks now require absent trigger qualification, exact column coverage, no arguments/transition tables/constraint timing, canonical function signature/language/attributes/configuration and literal SHA256 source-body pins. The canonical legacy transition is `UPDATE OF state`; it is not an unrestricted UPDATE trigger. Pins are derived independently in offline tests from sealed SQL066/083. These checks remain unreachable behind the unconditional refusal and have not been parsed or exercised by PostgreSQL16. They are not full installed catalog acceptance or dependency/search-path attestation.
2. **Tenant-writable paper receipt provenance/economics.** SQL083 permits `swat_app` to insert paper receipts and reconcile matching operation/position updates. Consistency with self-supplied labels is not independent provider admission. SQL083 remains unchanged within its sealed source scope. SQL084 now explicitly refuses application while a separately protected admitted receipt/quote/economic boundary is unavailable. This is containment of the new proposal, **not a repair of SQL083**, not revocation of an existing installation and not a substitute for completing I2/I4.
3. **URL-encoded catalog credentials.** The separate `infrastructure.ts` repair decodes username/password exactly once before command admission; the password remains in PGPASSWORD, never argv. Catalog contracts cover reserved characters, literal percent/plus and malformed escapes. See current main evidence for verification and targeted review disposition.

## Proposed grant matrix, currently unreachable

The preserved design uses eleven narrow grants to `swat_app`: guardrail SELECT(user_id,max_pool_allocation_pct) and timestamp UPDATE for locking; exact-store base position identity/exposure SELECT, acquisition INSERT and compatibility settlement UPDATE; append-only history INSERT and named sequence USAGE; subscription SELECT and timestamp UPDATE; copy-execution SELECT/INSERT. All table grants are column-level. No DELETE, TRUNCATE, REFERENCES, TRIGGER, grant option, broad schema/default grant, function EXECUTE, role enablement or authority-registry mutation is proposed.

The offline contracts compare every base INSERT and compatibility UPDATE column to actual `lp-paper-store.ts`. The grant design does not authorize arbitrary financial SQL or prove real row-lock/RLS behavior. SQL083's existing exact-table DML grants are not expanded or duplicated here.

## Preserved role/catalog prerequisites

The unreachable draft retains direct `current_user=session_user=swat_migrator`, row_security on, isolated nonprivileged roles, no memberships, runtime ownership or object CREATE, `swat_app` NOLOGIN, migrator-owned forced tenant RLS, exactly one canonical policy per table, stale base ACL refusal, exact trigger/body prerequisites and named history sequence ownership. Policy deparse and installed function/catalog semantics require actual PostgreSQL16 acceptance.

**seedOwners remains blocked.** Its table-level `has_table_privilege(...,'INSERT')` checks do not accept narrow column grants, and its guardrail initialization has no independently justified protected capability. A later design must use actual column prerequisites such as `has_column_privilege` and a justified canonical initialization path; no harness-only grant is added.

## Verification scope

The static suite contains ten source contracts. It reads source text; it does not run a SQL parser, database, queue, provider, signer or child process. Nine earlier contracts passed in the historical 360-test checkpoint. Current verification, command hashes and targeted review are recorded in `WAVE4-MAIN-EVIDENCE.json` and `WAVE4-REVIEW-REPAIRS.md`, rather than inferred from authored tests.

No tests, emits, typechecks, migration application or runtime activity were performed by the original S2 author. Later coordinator offline verification is separate and does not change the source-only scope. No role/login enablement, deployed provider/custody identity or public execution capability follows from this proposal. Public CLI and positive joined pipeline remain unconditionally refused.

## Unresolved functional requirements

- Independently protected receipt admission, with admitted quote identity, provider/network/action, canonical hash representation and exact economic terms enforced by SQL; hostile same-tenant direct SQL must be covered in isolated PostgreSQL.
- Correct protected receipt writer/store transaction composition without widening runtime credentials or inventing authority.
- Full installed trigger/function/dependency and policy/catalog proof, actual RLS/COMMIT/locking negatives and reviewed migration baseline.
- Pre-session application authentication, exact authenticated NOLOGIN/runtime role decision, system identity observation and PgBouncer transaction pooling.
- Protected initialization, remaining domain/pipeline/race/fault/load composition and actual I1–I8 runtime evidence.

Wave4 remains incomplete; Wave5 remains blocked. Refusing unsafe application is not closing either gate.
