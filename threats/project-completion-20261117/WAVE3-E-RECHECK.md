# Wave3 E independent narrow recheck — 2026-11-17

**Accepted, source-only, within this narrow E review. No supported remaining source blocker found.** This does not grant test, database, runtime, live-capability or whole-project acceptance.

Implementation was read only; this explicitly requested report is the sole intentional repository write. Reviewed the original E-R1–E-R7 findings, E submission, compact affected sources/proposal and relevant test source. No subagents, tests, compilers, emits, migration/SQL execution, network, credential access, cryptographic signing or key generation were performed. Test assertions below were inspected, not executed. One initial filesystem discovery command automatically exceeded its foreground deadline and was immediately stopped; no background work was intentionally launched or continued.

## Coordinator corrections verified in source

- `/root/SWAT/packages/db/src/custody-store.test.ts:62`: three parent traversals correctly resolve to `/root/SWAT/threats/project-completion-20261117/081-custody-schema.proposal.sql` from the test directory.
- `/root/SWAT/packages/db/src/custody-contract.test.ts:46-48`: binding substitutions are checked against independently supplied fixture deployment/network, not a domain inferred from the substituted binding.
- `/root/SWAT/packages/db/src/execution-grants.ts:98-116,365-386`: finder blanket kind exclusion removed. Exact tenant/chain/kind/active/expiry predicates remain, and both SQL projection and explicit mapper exclude ciphertext and secret binding. Returned public metadata is not execution authority.
- `/root/SWAT/packages/db/src/execution-grants.test.ts:288-295`: public finder regressions cover Solana vault, EIP7702 and 4337 session metadata, secret/binding omission, absence of blanket exclusion and retained expiry predicate. No passing-test claim.

## Original mechanisms and critical invariants

- **E-R1:** `/root/SWAT/apps/trade-executor/src/delegation-authority.ts:100-103,127-145,178-209,259-263` rejects overflow/unlimited quantities, applies finite local loss/lifetime policy, independently approved spenders and authenticated settlement recipients to deployed rules and requested/decoded effects.
- **E-R2:** same source `:199-216,294-316` and `/root/SWAT/apps/trade-executor/src/execution-authority.ts:108-139` bind network/deployment, owner/delegate, nonce, signature domain and finite permission/signature deadlines; require exactly one equal decoded effect and complete equal scope; independently check actual typed-data domain. The scoped port contract requires atomic lifecycle/revision/nonce/deadline/payload recheck and consumption at the effect boundary.
- **E-R3:** `/root/SWAT/threats/project-completion-20261117/081-custody-schema.proposal.sql:153-218` generates monotonically advancing revisions, preserves tombstones through retired staging, requires newer independent post-revocation keyed admission, refuses local keyless resurrection, retains identity/history and makes compromise terminal. `/root/SWAT/packages/db/src/execution-grants.ts:274-323` preserves same-row binding and guarded replacement. Custody/delegation fingerprints and boundary inputs carry lifecycle revision/tombstone; inspected ABA regressions cover restored-value sessions.
- **E-R4:** delegation source `:275-315` pins the initially issued deadline, checks it across asynchronous verification/decoding, and makes authorization single-use. Renewed proof cannot extend that deadline.
- **E-R5:** proposal `:7-45,80-98,230-245` rejects writer elevated attributes, either-direction membership, ownership/effective CREATE and unexpected preexisting domain catalog; retains migrator ownership, immutable independent admissions and exact forced tenant RLS. Writer identity is checked as both current and session user.
- **E-R6:** public grant operations use `scopedQuery`/`withTenantTransaction`; `/root/SWAT/packages/db/src/tenancy.ts:73-96` sets checked tenant context on the transaction client before operations. Cross-tenant grant sweeps remain refused rather than using wildcard bypass.
- **E-R7:** proposal contains no inner transaction-control statements; suffix/journal transaction ownership is left to the migration runner.

Custody contract/envelope bridge bind full row, tenant, network/deployment, account, kind, key/scope versions, policy digest and expiry. Enrollment is wrap-only and returns an explicit public projection; execution unwrap is separate, checks current snapshots before/after open, is single-use and clears owned/transferred buffers. Keyless grants refuse secret placeholders. Legacy labels/unconstrained signer options cannot establish verified delegated authority; no generic venue-managed bypass is added.

## Acceptance limits

Schema081 remains an unapplied proposal. Real writer/reader roles, cryptographic AAD authentication, trusted deployment inspection/complete decoding, atomic effect-boundary behavior, concurrency/RLS/migration qualification and worker/runtime wiring remain external qualification gates. Source contracts and inert fixture assertions do not prove those gates. Only narrow source acceptance is granted here; runtime/live flags remain false.

## SHA256 of reviewed affected files

Computed sequentially with local Python standard-library byte reads; no project code imported. Context-only source files were reviewed in compact excerpts, not reaudited in full. Historical submission hashes are not asserted to match this repaired snapshot.

```text
9917290116acbf14e86c5a4472b83fd54fcfbff0b4ac3d3ca76bf5cc90043799  /root/SWAT/apps/trade-executor/src/delegation-authority.ts
41d9b6b63a5f4d7eca0395924de8bb5d1b1d71d1792f8bd1aeada565422ca369  /root/SWAT/apps/trade-executor/src/delegation-authority.test.ts
c3dcae9725564688b1f92f3166d265198c22300939813569ce336d696564e4e6  /root/SWAT/apps/trade-executor/src/execution-authority.ts
518e52fdc8064d7043e188df649bd2a29a8d7f87efa982fcd0e220a0c4365da1  /root/SWAT/apps/trade-executor/src/execution-authority-adapters.ts
124aed2e2ddb013948530a7f4c930019b29d4efb05aac8922fa26ecfdec3a35a  /root/SWAT/packages/db/src/custody-contract.ts
5b736ee5d9a60625ea7457f49a19e37f8d86c0dec433cba57077c3e1d96d2e3b  /root/SWAT/packages/db/src/custody-contract.test.ts
a725ad9094ea29070b4944e00afb9441122f621ee5b706ea8084131fcc7e0ecd  /root/SWAT/packages/db/src/custody-envelope-context.ts
36ac59461ffebffc0aee5d1cc2306bf6bf41b21ed10025b91084ee9fe0caa64b  /root/SWAT/packages/db/src/custody-enrollment.ts
c725def8afbc038c9ed5c602e9da71016c14d00ad6a80e6564401eab808e6dea  /root/SWAT/packages/db/src/custody-execution.ts
ecb4643cefe235adc0a9b04e5786f95fb028a56941b197b00e28e07d56bc7474  /root/SWAT/packages/db/src/custody-execution.test.ts
8ed49148a23e7e8c7c756d1fe2e4adb32d40ef295effb1ef7ee124e468ae2683  /root/SWAT/packages/db/src/custody-store.ts
f3103657b90bc2750f8d6dba17b592fc01eda846b6d590a32a8d94a5d6fe9b4b  /root/SWAT/packages/db/src/custody-store.test.ts
9cfa1828c7ef74c987dab78658510dcca8070f4c66d7173aa276594fa69f9684  /root/SWAT/packages/db/src/execution-grants.ts
7b4a8e9a5722a138f492fbfd7cd3d3dfb75361e0fc881e1fee82209521baadba  /root/SWAT/packages/db/src/execution-grants.test.ts
9224d3207d0a9f49751079b26f74e61a0f70fe63971e51ddc7342a93759727db  /root/SWAT/packages/db/src/tenancy.ts
66e9aa8fd68edd9f51cbc1b086fec942e7a6125bce8105630535935b4c4b7e51  /root/SWAT/threats/project-completion-20261117/081-custody-schema.proposal.sql
```
