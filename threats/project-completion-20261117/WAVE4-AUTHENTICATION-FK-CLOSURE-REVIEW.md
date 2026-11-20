# Protected authentication foreign-key closure independent review — 2026-11-20

## Verdict: ACCEPT

**Bounded P3 source acceptance only.** Independent reviewer: `agent_e2bdd961-4513-48e9-9c51-9624641b646a`. The remaining incoming-FK finding A is closed in source scope. Original findings 1–6 and repair findings A/B/C are resolved within the prior bounded dispositions. The reviewer found no concrete new evidence warranting reopening them; no source repair is required by this disposition.

The reviewed freeze is identified by coordinator-reconciled manifest `738c69d08ce17fdd2cda58f9eb5fa75bd5dc95854495fbb8eaa4adb7a024dcf6`. The reviewer did not independently authenticate that manifest or reproduce the reported 948/36 main, 46/1 load or five noEmit passes. Coordinator raw artifact reconciliation is separate from independent source review.

## Independent inventory and enforcement findings

- Canonical SQL001–087 excluding084 was searched independently, rather than treating production pins or fixture rows as the expected baseline. The complete inventory is 42 external-child `users(id)` FKs (13 CASCADE and 29 RESTRICT), plus five auth-child FKs: **47 constraints and 188 enforcement paths**. There are45 FKs targeting users, one targeting auth wallets and one targeting audit log.
- Names, child/target columns and actions match canonical declarations; external implicit names fit PostgreSQL's identifier limit. SQL050 dynamic drops select the old application-to-position FK, position PK and execution UNIQUE, not the four incoming user FKs. Other ALTER/drop/dynamic DDL searches found no removal, rename or additional canonical touching FK. Source: `packages/db/sql/050_copy_tenancy.sql:101–150,192–194,242–255,283–307,352–353`.
- Production expected rows are independently transcribed, not candidate/fixture-derived: `deploy/postgres/auth-catalog-dependencies.ts:104–151`.
- The global FK query covers either protected side without child-schema or ACL filtering. Exact inventory and per-constraint checks pin identity, columns/types, actions, match/update behavior, validation/locality/deferrability, backing index, ownership/inheritance and admitted dependencies: `auth-catalog-dependencies.ts:155–202`.
- Each accepted constraint requires exactly four AFTER ROW paths: child INSERT/UPDATE checks and parent DELETE/UPDATE enforcement. Validation covers relation association, applicable RI builtin identity/options, enabled state, deferrability, arguments/qualification/transition-table absence and dependency association: `auth-catalog-dependencies.ts:203–233`.
- The final scan rejects extra, orphaned or spoofed paths touching either relation side or an accepted constraint: `auth-catalog-dependencies.ts:235–240`. The former ANY-FK exemption is gone.

The previously admitted private external `wallet_id REFERENCES user_auth_wallets(id) ON DELETE RESTRICT` unlink blocker cannot pass the inventory gate merely because it has no PUBLIC/auth grants. Same-size substitutions and disabled/substituted enforcement paths also refuse.

## Gate and contract evidence

The closure validator runs before handoff and through committed inert/disabled/active validation: `deploy/postgres/auth-provisioning.ts:245–256,301,328`.

Source contracts separately anchor the canonical inventory and exercise the private blocker, metadata substitutions, enforcement mutations and additional touching triggers across those phases: `deploy/postgres/auth-provisioning.offline.test.ts:146–309`. `deploy/postgres/auth-catalog-fixture.ts:39–84` remains separate from production pins; its synthetic predicate results are not PostgreSQL evidence.

## Preserved boundaries and prior dispositions

Forced RLS, exact helper/relation/ACL closure, checked direct-auth injection and no app fallback remain preserved. B's inspected/connected target binding remains intact at `tests/integration/helpers/schema-guard.ts:149–199,219–245`; C's clean runtime lease/backend settlement checks remain intact at `tests/qualification/wave4/authentication.ts:32–73`.

Pre-COMMIT poison fences and postattempt uncertainty remain explicit at `packages/db/src/auth-owned.ts:104–134`. No new membership, LOGIN/password shortcut, broker transfer or broader qualification authority is introduced.

The [original review](WAVE4-AUTHENTICATION-REVIEW.md), [first repair review](WAVE4-AUTHENTICATION-REPAIR-REVIEW.md) and [second repair review](WAVE4-AUTHENTICATION-SECOND-REPAIR-REVIEW.md) remain unchanged historical evidence. This verdict supersedes their P3 rejection only within the bounded source scope.

## Limitations

Review was read-only: no edits/report files, tests, compilers, SQL/services, network, credentials, signing or nested agents. This file records the returned verdict; the reviewer did not author or authenticate coordinator evidence.

**This is not runtime acceptance.** Actual PostgreSQL16 catalog/deparser, builtin metadata/dependencies, RLS/ACL, locking and COMMIT behavior remain runtime-unqualified. P4–P8 implementation and P9 final audit remain outstanding. Wave4 `sourceComplete`, `runtimeAccepted`, `liveCapabilityAccepted` and `productionReady` remain false; only bounded `authenticationSourceAccepted` may be true after coordinator reconciliation.
