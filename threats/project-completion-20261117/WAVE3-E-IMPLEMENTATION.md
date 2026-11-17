# Wave3 E implementation submission — 2026-11-17

**Owner E source frozen for independent review. Not accepted or self-approved.**

Scope: custody/enrollment/execution-secret isolation and deployed delegation, within E's exclusive allocation. Wave1 untouched/sealed, Wave2 accepted source/injected evidence preserved. No barrels, worker-policy, canonical lifecycle, API/web/shared source, entrypoints or installed migrations edited. Schema081 is a proposal only.

## Implemented behavior

- `custody-enrollment.ts` drives actual injected wrap and committed storage ports, not an unavailable-only wrapper. Copies principal, policy, expiry and inert secret before async work; binds preallocated same-row UUID, tenant, chain/network, account, grant kind, key version, policy digest, scope version, expiry and deployment. Keyless vaults never acquire placeholder secrets. Owned byte copies are zeroed on success/refusal. Explicit public projection excludes ciphertext/plaintext/binding. Provider/storage errors are sanitized.
- `custody-contract.ts` validates canonical complete v2 context, positive safe versions, exact policy JSON and envelope layout; rejects cross-row/tenant/account/policy/expiry/network/kind/version substitution. Binding is integrity metadata, not execution permission.
- `custody-envelope-context.ts` maps the entire canonical binding into existing resource-v2 envelope AAD: `purpose=execution-grant:scope-v1:<sha256(full-binding)>`. This includes scope version, policy digest and expiry without modifying shared envelope source or importing wrappers into API enrollment. Approved wrap/open services must both use this mapping and authenticate the context. It performs no encryption/key generation.
- `custody-execution.ts` is a separate execution-only unwrap/session interface. Current scoped snapshot is checked before opening and again after opening; single-use sessions refuse stale/revoked/replaced grants, and owned/provider buffers are zeroed. Consumer must not retain secret bytes. Real remote-service isolation is not established by this in-process interface.
- `custody-store.ts` uses only an injected same-client tenant transaction. It exposes distinct enrollment-write and execution-read factories; enrollment receives no secret loader. Conflicting row IDs refuse rather than silently overwriting resource-bound ciphertext.
- `execution-grants.ts` keeps public secret-free reads and inherited atomic replacement behavior, but new keyed writes require v2 binding and trusted preallocated ID. Same-account replacements compare bound row ID before changing authority; policy/expiry/binding are snapshotted. Historical loader remains migration/incident compatibility only, never execution authority. Legacy keyed v1 writes now intentionally refuse.
- `delegation-authority.ts` verifies authenticated current grants and actual injected deployed scope. Exact tenant/network/deployment/account/delegate/mechanism/finality/revision, proof freshness/expiry/revocation and capabilities are checked. Caller scopePolicy, legacy enabled/program ID and unconstrained signers do not authorize. Exact integer base-unit effect binds target, selector, recipient, spend asset, direction and instrument to deployed argument rules. Built signing payload is decoded, requires exactly the authorized effect (no extra batch), and grant/deployment are rechecked after decoding. Single-use signing capability drives injected `signScoped`, which MUST atomically recheck at the actual effect boundary. No generic venue-managed bypass is granted.
- `execution-authority.ts` adds exact `DelegatedExecutionEffect`, stable denial codes and provenance projection. Owned adapter factories can explicitly opt into verified ports; defaults and legacy Solana options still deny without reading signer/accessors. Polymarket remains delegation-unsupported; no custody exception is enabled. Operator adapters preserved.
- `credentials.ts` lazily loads native password hashing only upon password operations. Custody-adjacent import/digest parsing invokes no native hashing or credential generation; inherited password/token functions remain available.

## Exact exports/integration for coordinator and H

API-safe module `/root/SWAT/packages/db/src/custody-enrollment.ts`:

- `createCustodyEnrollment({ deploymentId, chainIds, allocateGrantId, store, wrap?, now })`
- `CustodyEnrollment` exposes `enroll(scope, input): Promise<ExecutionGrant>` and `readiness()`.
- Input types: `CustodyEnrollmentInput`, `CustodyEnrollmentRecord`, `CustodyEnrollmentStore`, `CustodyEnrollmentWrapPort`.
- Wrap exposes only `{ wrapperId, keyVersion, seal({ plaintext: Uint8Array, binding }) }`, no unwrap/sign/keygen.
- H derives tenant from principal, verifies linked account/ownership/consent and deployed mechanism via approved independent route ports, and only then calls enrollment. Enrollment persists a local custody record; it is NOT verified delegation permission. Default keyed route must stay blocked absent these ports/identities. No CLOB challenge or signing enabled by this submission.

Storage module `/root/SWAT/packages/db/src/custody-store.ts`:

- `createCustodyEnrollmentStore(transaction)` returns only `record`.
- `createCustodyExecutionStore(transaction)` returns only `load`.
- `CustodyTenantTransaction` must pin authenticated role, exact tenant RLS and real COMMIT on the same client. No implementation connects/provisions a database here.

Pure integrity exports `/root/SWAT/packages/db/src/custody-contract.ts`: `CustodySecretBinding`, `CustodyGrantSnapshot`, `CustodyReadiness`, `CustodyContractError`, `buildCustodySecretBinding`, `assertCustodyBindingMatches`, `custodyBindingAad`, `custodyPolicyDigest`, `custodyPolicySnapshot`, `assertCustodyEnvelope`, `assertCustodyActive`, `canonicalCustodyAccount`, identifiers/chain validators and `custodyReadiness`. `/root/SWAT/packages/db/src/custody-envelope-context.ts`: `CustodyEnvelopeContext`, `custodyEnvelopeContext`.

Executor-only `/root/SWAT/packages/db/src/custody-execution.ts`: `createCustodyExecutionAccess`, `CustodyExecutionUnwrapPort`, `CustodyExecutionStore`, `CustodyExecutionSession`. **Do not import executor unwrap through an API barrel.**

Executor `/root/SWAT/apps/trade-executor/src/delegation-authority.ts`: `createDeployedDelegationAuthority`, `DeployedDelegationPorts`, `DelegationGrant`, `VerifiedDeployedDelegation`, `DeployedDelegationRule`.

- Ports: `loadGrant(userId,chain)`, `inspect(grant)`, `decode(payload,deployment)`, `signScoped({grant,deployment,expectedRevision,effect,request})`.
- `inspect` must read actual deployed policy/code/finality/revocation from approved verifier identity, not synthesize authority from DB labels. `decode` must enumerate all actual payload effects including nested/batched effects. `signScoped` must recheck atomically at its signing/submission boundary; local repeated reads are not TOCTOU/concurrency proof.
- `createUserSolanaAuthority(legacyOptions?, verifiedSecondArg?)`; `createUserRobinhoodAuthority(legacyGrantOptions?, verifiedSecondArg?)`; `createExecutionAuthorityAdapters(operatorDeps, legacySolanaOptions?, { solana?, robinhoodChain? })`. `VerifiedDelegationAuthorityOptions` is exported in owned adapters.
- No shared worker changes requested now. Existing worker requests lacking exact `effect` intentionally deny in the verified adapter. Actual worker/runtime wiring remains coordinator-owned and blocked until approved runtime scope integration.

Readiness: `sourceImplemented=true`, `injectedPortsConfigured=Boolean(wrap)`, **`runtimeAccepted=false`, `liveCapabilityAccepted=false` always**. Configuration is not injected-test acceptance or deployment verification. Blockers include approved wrap identity, execution unwrap identity, schema081 isolated qualification and verified deployed delegation.

## Schema081 restrictions and blockers

`/root/SWAT/threats/project-completion-20261117/081-custody-schema.proposal.sql` only; not integrated/applied. Requires pre-existing independently approved least-privilege `swat_custody_writer`, but does not create/provision/grant membership to that role. Immutable admission binds grant UUID, tenant/account/chain/kind, version, exact ciphertext, exact policy/binding and expiry; app cannot insert admissions. Writer trigger requires both current/session identity; accepted_at assigned at statement time. Forced exact tenant RLS and restrictive grant policy prevent wildcard bypass. Grant trigger requires exact independent admission for keyed writes and preserves old immutable admissions on rotation; identity immutable, compromised terminal, deletion refused, keyless secret/binding absent. Legacy unbound rows may retire/revoke but do not become usable. Envelope/digest labels never authenticate themselves.

Writer admission is intentionally not an app-seeded factory: approved wrapping service must commit its authenticated admission before application grant registration. Existing generic `swat_app` role checks and current service graph cannot assert separate writer/execution-reader identity. Real cryptographic envelope authentication, live linked-account/delegation verification, RLS/concurrency/history trigger behavior and role grants require independent approved isolated qualification. PostgreSQL source assertions are not SQL execution evidence.

## Literal test manifest and import safety

Literal `/root/SWAT/threats/project-completion-20261117/w3-e.config.ts`, ten selected files:

1. `/root/SWAT/packages/db/src/custody-contract.test.ts`
2. `/root/SWAT/packages/db/src/custody-enrollment.test.ts`
3. `/root/SWAT/packages/db/src/custody-execution.test.ts`
4. `/root/SWAT/packages/db/src/custody-store.test.ts`
5. `/root/SWAT/packages/db/src/custody-credentials.test.ts`
6. `/root/SWAT/packages/db/src/execution-grants.test.ts`
7. `/root/SWAT/packages/db/src/execution-grants.sequential.test.ts`
8. `/root/SWAT/apps/trade-executor/src/delegation-authority.test.ts`
9. `/root/SWAT/apps/trade-executor/src/execution-authority.test.ts`
10. `/root/SWAT/apps/trade-executor/src/execution-authority-adapters.test.ts`

Import review (static inspection only; coordinator approval required):

- New custody modules import only node:crypto hashing plus pure local contract at runtime; shared chain/db/tenant/execution types are type-only. Enrollment does not import credentials, DB client, shared envelope/key wrappers, execution unwrap or entrypoints.
- New delegation and authority modules use pure local authority vocabulary and type-only shared imports. Test injected sign/decode/wrap/unwrap return inert bytes/results; no actual signing, keys or providers.
- Credentials fixture calls only hashToken/tokenMatches/prefix parsing; native argon2 mock hoisted, no generateToken/generateApiKey/password/keygen invoked.
- Existing grant tests hoist client, transaction/tenancy boundary mocks so real client/role/environment initialization is not loaded. Sequential replacement test supplies fake pool transaction with rollback snapshots; neither has network/service calls. Public projection fixture test reads existing047 source only. custody-store test reads081 proposal source only.
- Authority-adapters regression imports PaymasterBudgetTracker; its environment defaults are consulted only upon constructor, tests provide explicit inert caps, no provider/service activity. No executor index/wiring suite selected.
- Config imports existing bounded package harness, with literal file list and its existing guarded setup; no service/test globs. Do not execute config outside approved serialized runner.

Inherited stale tests previously asserted audited Solana authority from only an injected signer/program identifier; corrected to truthful refusals while preserving independent operator/grant lifecycle cases. Inherited grant test used wrong chain for a session grant and a 38-hex-character EVM fixture; corrected to Robinhood chain and a valid40-hex address so it actually reaches the asserted validation. Static final inspection also found shared Chain includes other LP networks; custody chainIds accepts a partial map and requires the supported keyed domain explicitly instead of falsely requiring unused networks. Existing v1 fixtures updated to explicit inert v2 bindings; old v1 refusal covered directly. These are source repairs, not claims of previously run success.

## Actual commands and results

**No tests, compiler, emits, native hashing, services, migration apply, installs/downloads, credentials, signing/keygen or external calls were run. No assertion counts/results invented.**

Inspection commands actually used: `pwd`, `ls -la`, `find`, `grep`, `cut`, `git -C /root/SWAT status --short`, scoped `git diff --stat`, `git diff`, scoped `git diff --check`, and `sha256sum`; dedicated Read/Edit/Write tools used for source/governance. `rg` was unavailable (`command not found`), fallback grep/find used. Several no-op Edit attempts returned no changes; no source altered by those errors. Final scoped `git diff --check` emitted no whitespace diagnostics; this is not compile/test acceptance. Source hashes below from actual sha256sum. Source frozen after hashes/report; coordinator must globally freeze, approve manifest import/hash registry, run bounded CPU0 serialized tests512MB/onefork and compilers640MB, and independently review. Suggested future runner command is not recorded as executed here.

## Changed paths and SHA256 (frozen implementation)

```text
30ac5b9bc9d30387e35fb3786177103c1bfc131cca4771d58fd74b5deb1ae17e  /root/SWAT/packages/db/src/execution-grants.ts
9c7cf58475cec7324067e13010a1e569c4a95df54c72aefc9fa67f834659b537  /root/SWAT/packages/db/src/credentials.ts
1898a2b017ed474bd6a398893e24b8dff588f75f536afffbce804fc1c78bd6ad  /root/SWAT/packages/db/src/execution-grants.test.ts
6530c9af81b3e666178b5f75770e9274f5a7775e6dc89e59c31274fcb8799d57  /root/SWAT/packages/db/src/execution-grants.sequential.test.ts
74cc5e48c22623f275c5763851215be8c802402cc6b289c4681ab9bdadbd922a  /root/SWAT/packages/db/src/custody-contract.test.ts
1b8a8520e42c90d6b3e7b65329b37f40ce0bc8de736bacf96f8c4ec55dbbf619  /root/SWAT/packages/db/src/custody-contract.ts
c44dfc1d3306276f42556dff6de7bc3067c6dbfae7be2f214cb1076893e901b0  /root/SWAT/packages/db/src/custody-credentials.test.ts
aa9e90369e9fe37e8e099cde6ee2f7bcbada459dfdaab68b739f29fa4faeb3a4  /root/SWAT/packages/db/src/custody-enrollment.test.ts
36ac59461ffebffc0aee5d1cc2306bf6bf41b21ed10025b91084ee9fe0caa64b  /root/SWAT/packages/db/src/custody-enrollment.ts
a725ad9094ea29070b4944e00afb9441122f621ee5b706ea8084131fcc7e0ecd  /root/SWAT/packages/db/src/custody-envelope-context.ts
a84ce5229c75d295a954c6ad68978ce9c20df61d18cc5379af631c9436af9d6b  /root/SWAT/packages/db/src/custody-execution.test.ts
d6469fab531371d58f556a693f2dfb2e541c2114427d833db5d9b2bbc76697ed  /root/SWAT/packages/db/src/custody-execution.ts
1d3cde3528aa2ba6e9299c9d2ba49c9025ff36399ba044d3055aeb9f35b7c00b  /root/SWAT/packages/db/src/custody-store.test.ts
36def2cca71fb43ede3e3419c1d247fcc69cb8322a010497a3a658bfc1473c3f  /root/SWAT/packages/db/src/custody-store.ts
77e2ca9871707e4c196ee85d39c6fd42bccfc1a3e0c5a18529418e78a4ec11ea  /root/SWAT/apps/trade-executor/src/execution-authority.ts
6835649ce635890ad2e73b985aa6b43819abb0860f2527bcf04b847573b1c657  /root/SWAT/apps/trade-executor/src/execution-authority-adapters.ts
201260c02a9d5561e8a494f77215c4ddaade518abad2d71532f42d9a5b647d95  /root/SWAT/apps/trade-executor/src/execution-authority-adapters.test.ts
6915dc505097b8465e5fac1332f241b42dafafc399c639c3e3162ada6cc02234  /root/SWAT/apps/trade-executor/src/delegation-authority.test.ts
7cb828baf882b0e90b2e174a28a7e63b4a9afa474d90a2911e0f6c975796bb4d  /root/SWAT/apps/trade-executor/src/delegation-authority.ts
ea1a8405a0f76b85bf187c917871585974e222d190958c18b9dd827e0e57eb59  /root/SWAT/threats/project-completion-20261117/081-custody-schema.proposal.sql
ee43afe15be66e306999950a296a5050a44e004358c0b4a66425695fc63a1436  /root/SWAT/threats/project-completion-20261117/w3-e.config.ts
```

This requested submission report is an additional created path; its hash is sent separately to avoid a self-referential digest. Independent review and coordinator acceptance remain pending. Source/injected implementation does not authorize Wave4/runtime/live acceptance.
