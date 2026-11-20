# Protected authentication independent repair re-review — 2026-11-19

## Verdict: REJECT

Independent reviewer: `agent_e7557d7d-ea77-4685-8673-8f5c8362f38a`. Read-only bounded source review of the frozen repair checkpoint on consumed-input manifest `3e0126e15f7c8c87db5001c404e7b5163351e0961f1035d037a2c30f42fa50dd`. No edits, tests, compilers/emits, SQL, services, network, credentials, signing, nested agents or publication. Recorded 748/36 main, 46/1 load and five noEmit passes were not independently reproduced and are not correctness proof.

## Original finding disposition

1. Policy-helper dependency closure: resolved in bounded source scope. Exact helper bodies, owners, languages, options, return types, ACLs and admitted dependencies are pinned; noncatalog policy substitutions refuse.
2. Relation/default/constraint/index/rule closure: substantially repaired but **not fully resolved**. Internal foreign-key enforcement triggers are excluded from validation; see A.
3. Global PUBLIC column ACL scan: resolved in bounded source scope. Noncatalog relation and column ACL scans reject PUBLIC grants.
4. Late escaped/nested poison and COMMIT uncertainty: resolved in bounded source scope. Cleanup/identity poison fences precede COMMIT without another await; postattempt uncertainty withholds admission without claiming rollback.
5. Actual LP authoritative consumer: resolved in bounded source scope. Explicit checked direct-auth injection is loaded before runtime construction and passed to the actual LP hook; no legacy/app resolver fallback.
6. Integrated wallet and overlap qualification: resolved for source/injected contracts. Actual routes, nonce consumption, verifier and owned store are joined; separate clients/backends park a leader before COMMIT and require an overlap edge. Actual PostgreSQL locking remains unqualified; runtime lease custody has a separate defect below.

## Supported actionable findings

### A — Medium: internal foreign-key enforcement triggers are not validated

Locations: `deploy/postgres/auth-provisioning.ts:190`, `deploy/postgres/auth-catalog-dependencies.ts:193–204`, `packages/db/sql/087_wave4_protected_authentication.sql:35–40,220–222,226–234`.

The gate examines only noninternal triggers and FK constraint metadata. A catalog can retain the expected FK definition and validated constraint while disabling the internal DELETE cascade trigger. Unlink then leaves a wallet proof behind. Relinking inserts a new wallet ID but conflicts with the retained chain/address unique proof; `ON CONFLICT(wallet_id)` cannot repair it. All auth phases can accept this catalog.

Required repair: validate required internal FK trigger inventory, constraint association, builtin routine identity, event/deferrability and enabled state. Add disabled/missing/substituted enforcement contracts before handoff and committed validation.

### B — High: shared reference/candidate auth staging is not bound to inspected infrastructure

Locations: `tests/integration/helpers/schema-guard.ts:138–146,179–186,202–229`, `deploy/postgres/auth-installation.ts:29–53`.

`generateCanonicalReference` inspects and migrates R but does not bind `authentication.target` to R. Following R's COMMIT it can perform privileged handoff on supplied X, validated against its own supplied identity, then return R's catalog. `compareCanonicalCandidate` can likewise validate X while comparing candidate C. Matching inert R/C catalogs and separate suitable auth targets can pass without protected-auth handoff on either compared database; privileged changes may occur outside the inspected disposable infrastructure. The I1 check in `cli.ts:66–68` does not protect these exported shared helpers.

Required repair: bind each auth installation target to its inspected container and connected migration/candidate identity before privileged acquisition. Reject mismatched or shared targets in the shared helpers themselves.

### C — Medium: qualification runtime lease can settle a borrowed transaction

Location: `tests/qualification/wave4/authentication.ts:32–46,61–68,129–134`.

The wrapper checks target but not cleanliness. Runtime BEGIN occurs before identity inspection, with no clean-lease check or final backend recheck. A direct app lease already in a transaction can pass; nested BEGIN does not establish new ownership. Negative operations can roll back unrelated work, and successful tenant reads can commit borrowed pending work.

Required repair: check clean direct identity/backend before target observation and BEGIN, pin/recheck backend through settlement, and reject/discard borrowed transactions without COMMIT or ROLLBACK. Add hostile open-transaction acquisition contracts.

## Preserved review boundaries

The fixtures do not import the production relation inventory, and production validators substantively reject missing/extra/replaced objects. Synthetic `exact:true`, `fk_equalities:true` and `audit_matches:true` rows do not independently prove the SQL predicates; false fixture results are not actual catalog substitution evidence.

Forced RLS, explicit auth injection, no app auth fallback, the existing seven-transfer broker, SQL083/084/public-entrypoint refusals and no new membership/LOGIN/password shortcut remain preserved. Actual PostgreSQL catalog/deparser, ACL/RLS, locking and COMMIT behavior is unqualified. P3 is not accepted, and P4–P8 remain incomplete.
