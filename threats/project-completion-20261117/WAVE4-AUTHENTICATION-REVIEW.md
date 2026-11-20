# Protected authentication independent source review — 2026-11-19

## Verdict: REJECT

Independent reviewer: agent_4019e1cf-893b-40a5-8b79-784f9abe199a. Read-only review of the frozen P3 package; no edits, checks/emits, SQL, services, network, credentials, nested agents or publication. Shared migration-selection and installation-plan changes were excluded. This is a source verdict, not PostgreSQL evidence.

## Required repairs

1. **High: security-policy dependency closure is unpinned.** `deploy/postgres/auth-provisioning.ts` validates the 17 auth routines and policy text, not `is_rls_bypassed()` / `current_app_user_id()` owners, bodies, options and ACLs. A replaced bypass helper returning true retains the checked expressions and can grant app global access. Validate exact helper identities and dependency closure; hostile substituted-helper contract required. Baseline: SQL070. Do not extend the seven-transfer079/082 broker.
2. **High: auth relation structure is unvalidated.** Columns/types/nullability/defaults, constraints, indexes, rewrite rules and their executable dependencies are omitted. Removing `uq_auth_wallet` passes the old gate but breaks the real ON CONFLICT wallet admission; users email/session-token uniqueness can likewise disappear unnoticed. Pin the complete reviewed inventory and reject missing unique constraints, changed defaults and unexpected rules before handoff and committed validation.
3. **Medium: PUBLIC column-only ACLs escape the global gate.** Table ACLs outside auth-local relations are scanned, but PUBLIC column grants outside them are not. Scan every noncatalog relation column ACL; hostile column-only grant contract required.
4. **Medium: late escaped/nested capability violation can precede COMMIT.** The owned wrapper checks poison once, then awaits raw cleanup and identity before committing. An escaped callback may poison during those awaits without another check. Recheck after each cleanup await and immediately before COMMIT; discard detected pre-COMMIT violation and never publish admission. Include deferred-cleanup escaped/nested tests; post-attempt uncertainty must remain explicit.
5. **High: existing LP consumer still uses unscoped session resolution.** `apps/lp/src/auth.ts` consumes the retained barrel `users.resolveSession`, but087 revokes its app session UPDATE privilege. Migrate LP to explicit checked direct-auth injection without app fallback or broader ACLs; retire/deprecate incompatible legacy auth exports.
6. **Medium: wallet/race qualification lacks integrated execution.** Qualification directly admits an address into the store without actual nonce/signature/origin/GETDEL route composition. Promise.all alone does not establish overlap; the offline fixture serializes all auth leases. Join actual routes/verifier and owned store with synthetic signatures, replay/origin/session-intent hostility and independently acquired deterministic overlap schedules for ownership/idempotence/unlink/login/password/revoke. Keep offline protocol results distinct from PostgreSQL proof.

No deparser-format defect was asserted: exact PostgreSQL formatting remains runtime-unqualified. Coordinator compiler/dist/loader failures were not independently reproduced by the reviewer.

## Coordinator checks and supported repairs after freeze

- Initial expanded main01:705 passed,4 failed,709 total/35 files. Obsolete session-cache assumptions failed. Rewritten compatibility tests now require authoritative touch/reselect on every request and zero authorization cache.
- Initial DB/qualification typecheck01: failed generic query forwarding at auth-owned.ts76. Preserve generic T through the adapter; no query-policy widening.
- Initial API typecheck01: missing fresh auth-owned dist. Locked DB emit01 followed by API typecheck02 passes; no source-path workaround for production package builds.
- Initial load01/02/03: real MJS preflight failed source extension resolution, then a CJS/ESM cycle. Canonical source inspection was extracted unchanged into the import-safe DB ESM leaf, re-exported by schema-guard. Load04 passes46/1 including the real child loader with database constructors forbidden. No database connection or load traffic occurred.
- Main02 passes709/35; DB typecheck02 and qualification typecheck02 pass. Shared manifest for these four checks:7450b2f4888072777866bc63a73276ac0bf48b337d726c2d4705cd341b2b44c7. Later generated artifacts have their own recorded manifests; never conflate epochs.
- API-tests typecheck01 failed a generic Vitest mock in the custody fixture. The fixture has been repaired with a generic typed facade plus separate call recorder; this post-check edit is not yet verified.

All raw failed and passing artifacts are retained under their original exclusive labels. Tests512MB/onefork, compiler640MB, CPU0 shared flock, synthetic network/credential guard, timeoutSeconds:null. Green existing contracts do not override this REJECT or prove coverage of its six findings.

Authentication shared reference/candidate/Wave4 provisioning integration remains unfinished. P3 acceptance is false. P4–P8 coding and P9 final audit remain incomplete. Wave4 source-complete/runtime/live/production flags remain false; Wave5 is blocked. No infrastructure, SQL application, credential use, live effects, commit, push or publication occurred.
