# Wave 3 independent final coordinator reconciliation

Date: 2026-11-17. Repository: `/root/SWAT`. Scope: current working-tree source and already-recorded, injected/offline evidence; not merely committed HEAD.

## Gate decision

**ACCEPTED for narrowly reviewed source plus recorded local/offline injected contracts. No supported remaining blocker was found in this final integration scope.** The actual aggregate is **742 passed assertions across 48 file runs / 48 distinct files**, with **0 failed, skipped, pending or todo**. This is independent reconciliation of existing evidence, not a new test run and not whole-project, PostgreSQL, provider, browser, deployment or live acceptance.

The coordinator may use this report for a scope-limited acceptance and ledger entry. `runtimeAccepted=false`, `liveCapabilityAccepted=false`, and `sqlApplied=false` must remain unchanged. H does not confer unsupported capability.

All inspection was sequential and foreground, using local reads, local Git inspection and a separately authored inline Python hash/count reconciler. No agents, background work, tests, compilers, emits, migration execution, services, network, browser, signing or credential-file reads were performed. The only intentional repository write is this explicitly requested report. The requested call budget was exceeded by one call to write this deliverable; no extra implementation work was undertaken.

## Evidence reconciliation

Read `/root/SWAT/threats/project-completion-20261117/WAVE3-INTEGRATION-REPAIRS.md`, E/F/G/H rechecks, H final source review/join, and `/root/SWAT/threats/project-completion-20261117/WAVE3-FINAL-EVIDENCE.json`. The coordinator's reconciliation helper was inspected but **not executed**; independent Python computed SHA-256 from disk.

For all nine final checks, verified the final evidence's command JSON and input-manifest hashes; command-record label/kind/exit/timing links; recorded log hashes; every direct input hash; every workspace-manifest entry; and every recorded emitted-artifact hash against disk. There were **zero mismatches and zero manifest drift**, including the pre-emit manifests. All recorded parent/child exit codes are 0, no timeouts occurred, and all records declare inputs unchanged. DB/executor records respectively inventory **400 / 440 emitted artifacts**; those entries were individually hashed, not accepted by count alone.

Four result JSON files were independently parsed down to `testResults[*].assertionResults[*]`. Raw statuses, empty failure messages, top-level test summaries and success flags agree. Each result's file names agree exactly with its evidence `selectedFiles` and the corresponding config's literal `.test.ts` inventory, including equal cardinality and absence of duplicates. Current E/F/G/H config hashes also agree with `/root/SWAT/threats/project-completion-20261117/reviewed-configs.json`.

| Final domain | Raw passed assertions | Literal/result files | Failed / skipped / pending / todo |
|---|---:|---:|---|
| E | 249 | 10 | 0 / 0 / 0 / 0 |
| F | 165 | 8 | 0 / 0 / 0 / 0 |
| G | 160 | 14 | 0 / 0 / 0 / 0 |
| H | 168 | 16 | 0 / 0 / 0 / 0 |
| **Unique final aggregate** | **742** | **48** | **0 / 0 / 0 / 0** |

No earlier failures or repeated passing runs contribute to this aggregate. The five preserved failed attempts retain matching logs and expected exit codes: E/G/H tests exit1, executor emit exit2, web typecheck exit2; their available result hashes also match disk. Final records support DB/executor emits and API/web/LP typechecks. CPU affinity is recorded as `[0]`, compiler heap640MB and test heap512MB, with the offline guard. Historical run metadata is evidence, not an independently observed native sandbox or proof of the original outer shell invocation.

## Narrow source closure

- **Inherited runner lock.** `/root/SWAT/scripts/build-completion-runner.py:152-164,188-190` identifies an inherited descriptor by device/inode, duplicates its open-file description, otherwise opens normally, and still acquires `LOCK_EX`. The new unit regression at `/root/SWAT/scripts/build-completion-runner.test.py:60-73` holds an outer lock, obtains an inner duplicate, and uses `LOCK_EX | LOCK_NB` with distinct-descriptor/same-inode assertions. Source inspected only; that regression was not run here and is not part of the 742 Vitest assertions. Label-before-kind-before-target grammar, CPU0 and guard/heap controls remain.
- **Mutable reducing fixture.** `/root/SWAT/apps/trade-executor/src/reducing-orchestration.test.ts:19` applies `{-readonly [K in keyof ReducingRequest]: ReducingRequest[K]}` to a local fixture. This is not a production contract relaxation.
- **Valid EVM fixture.** `/root/SWAT/packages/db/src/execution-grants.test.ts:49` has exactly40 hexadecimal digits after `0x`, independently checked by Python against the full EVM-address pattern. Production validation is not weakened.
- **SQL-leading UPDATE matcher.** `/root/SWAT/packages/db/src/lp-positions.test.ts:24,29` uses `/^\s*UPDATE\b/`, so locking `SELECT ... FOR UPDATE` no longer masquerades as financial mutation. The forbidden financial transition assertion and actual update inspection remain.
- **Structured OTP assertion.** `/root/SWAT/apps/api/src/routes/me.withdrawal.injected.sequential.test.ts:45-56` recursively examines scalar values for exact OTP equality and retains forbidden `otp`, `code`, `digest`, `balanceProof` and tenant-field assertions. It still asserts the exact canonical request, including the amount containing those digits, and commit-before-delivery ordering. This fixes a substring false positive without deleting secrecy assertions.
- **Type-only web DB declaration boundary.** `/root/SWAT/apps/web/lib/domain-transport.ts:2-3` uses `import type` / `export type` from `../../../packages/db/dist/lp-exact.js`. `/root/SWAT/apps/web/package.json` has no `@swat/db` dependency; `/root/SWAT/packages/db/package.json` retains `dist/index.js` / `dist/index.d.ts`. The checked declarations exist and are included in the final hashed evidence. No new runtime DB dependency is inferred.
- **Production barrel.** `/root/SWAT/packages/db/src/index.ts:1-12` exports reviewed custody contract/enrollment/execution/store, withdrawal contract/store/service, reducing contract/service, exact LP and LP paper service/store modules. These additions do not export the custody/withdrawal/LP fixtures or test modules; emitting test/fixture artifacts does not make them barrel exports. This is not a claim that the entire DB barrel is client-safe or side-effect-free.
- **F9 closed in source.** `/root/SWAT/packages/db/sql/082_withdrawal_reducing_intent.sql:252-263,470-487` takes the owned parent `FOR UPDATE` before both decisions, uses `expires_at<=clock_timestamp()` for attempt INSERT and `expires_at>clock_timestamp()` for cancellation, checks committed attempt absence, and preserves audit/reservation updates. `/root/SWAT/threats/project-completion-20261117/WAVE3-F-RECHECK2.md:39-55` independently confirms this correction. Remaining `statement_timestamp()` assignments are audit timestamps, not these expiry decisions. No real lock-wait/isolation behavior is accepted.
- **G-1 closed in source.** `/root/SWAT/packages/db/sql/083_lp_exact_paper_operations.sql:89-147` guards INSERT as well as UPDATE/DELETE. INSERT requires pending status, SQL-null completion time and explicit JSON-null receipt; UPDATE completion requires the durable operation/user/key/full-receipt match. Position settlement independently joins operation/user/position/key/receipt data and preserves revision/inventory/economic checks. `/root/SWAT/threats/project-completion-20261117/WAVE3-G-RECHECK.md` matches current proposal hashes and closes the earlier completed-INSERT bypass. The historical G-1 blocker in H's earlier final review is superseded only by this affected-source repair/recheck, not by H's own submission.
- **H capability boundary retained.** `/root/SWAT/packages/db/src/lp-exact.ts:201-209` fixes runtime/live capability flags to false. `/root/SWAT/apps/lp/src/routes.ts:242-254` defaults to unavailable ports and paper/broadcast-false responses. `/root/SWAT/apps/web/lib/domain-transport.ts:81-83` uses configured protocol ports only for fresh paper admission, not master/risk availability or provider qualification. The API admission test likewise expects runtime/live false. Unknown economics is not promoted to authority; unsupported Raydium remains unavailable rather than a supported protocol alias.

### Historical reviewer hashes are not silently treated as current

E's recorded test-file hash predates the EVM-fixture correction. H review/join hashes predate the type-only import, structured OTP/test typing repairs and G-1 schema repair. Those differences are covered by the narrow source inspection above and the current final input hashes, not retroactively attributed to earlier reviewers.

Both H documents also contain a noncurrent hash for `/root/SWAT/apps/web/next.config.ts`. The actual file is byte-identical to `HEAD`, has current SHA-256 `19b8e291ce179a590a26a8baceccb7eb627dc6f469655003c5818d82b706d934`, and matches final input evidence. Its current source was inspected: LP rewrites precede generic API rewrites; source alone does not establish effective browser headers/proxy behavior. This historical hash discrepancy is disclosed, not an unexplained final-source drift or a browser acceptance claim.

## SHA-256 anchors

All paths below are absolute; full per-input/artifact hashes remain in the verified command/input records.

| File | SHA-256 |
|---|---|
| `/root/SWAT/threats/project-completion-20261117/WAVE3-FINAL-EVIDENCE.json` | `208bc9574a618c7ec400c243c829fcb40e8fb2cd7e8867e74511da0d94266ad5` |
| `/root/SWAT/threats/project-completion-20261117/WAVE3-INTEGRATION-REPAIRS.md` | `db42d59d475083bf6e966f35683cc460012bcc740277daff8b9e602f2b65c6bf` |
| `/root/SWAT/threats/project-completion-20261117/WAVE3-E-RECHECK.md` | `d7b43b8933ecf768284052a2b585335cd5690dc6ad9ff7c7bb1ee02db38e1b5e` |
| `/root/SWAT/threats/project-completion-20261117/WAVE3-F-RECHECK2.md` | `b487bbf94a1c540c85ea5a30f9600bc4a86d0dcbbc4004ade5421ddc90d12ea5` |
| `/root/SWAT/threats/project-completion-20261117/WAVE3-G-RECHECK.md` | `a07d30efe42348b789d4af1d912ef7f1d61eb54fec8164f309a052a69f083cb3` |
| `/root/SWAT/threats/project-completion-20261117/WAVE3-H-FINAL-REVIEW.md` | `80d6692800496606f09bfe4a4a86067f6348b0458e229c7e15f892c770d3a7ea` |
| `/root/SWAT/scripts/build-completion-runner.py` | `1a75f8c88264fafd674f0247915a85dfb755a513fc346239216667662fd249db` |
| `/root/SWAT/scripts/build-completion-runner.test.py` | `513c94d383c64bab6c7d01f3312619382234ce33fc2e07bb1472dc680ce7a4d2` |
| `/root/SWAT/apps/trade-executor/src/reducing-orchestration.test.ts` | `6668232b70b6b1e34cd603d4d611d3a2cf12e2b9add78dea58c3208e403c1171` |
| `/root/SWAT/packages/db/src/execution-grants.test.ts` | `22b78fa6d999d0360f0170eda2680983061df7b72eb2130fdcae731714e465e4` |
| `/root/SWAT/packages/db/src/lp-positions.test.ts` | `7cb409040b0d2311a41d0133d491c85be5c5b5c542e01f90f4a461f1a735b412` |
| `/root/SWAT/apps/api/src/routes/me.withdrawal.injected.sequential.test.ts` | `d20464a571aadf2890258d0dd4021a7796e49613e67ca43edf443fefe5e85028` |
| `/root/SWAT/apps/web/lib/domain-transport.ts` | `46a9aaa4969cf80dba98b9d1de4d8d1e535e536ab80c82fa67b6ec45db8e52ab` |
| `/root/SWAT/packages/db/src/index.ts` | `ef74728d7d62099b914c2ef5f4ebe55a2e539b7624ae30853ff09338149fe7d7` |

Final result files, independently hashed:

- `/root/SWAT/threats/project-completion-20261117/build-w3-final-e-tests-01.json`: `ba9e2eb54c9993ac54a3af54f1eddf90658b0c6f987559fb5544380693d603d2`.
- `/root/SWAT/threats/project-completion-20261117/build-w3-final-f-tests-01.json`: `22736bb9ad613fe7b0cb38b23269c4ad498dc41369d8d1880a18cbb90032de0f`.
- `/root/SWAT/threats/project-completion-20261117/build-w3-final-g-tests-01.json`: `3fbebdfade921e4f83012f7bfaffa4c800910e5d9539532f1f102c618c71c32e`.
- `/root/SWAT/threats/project-completion-20261117/build-w3-final-h-tests-01.json`: `0e8b8854c7dc6f3538960ba7f6d37b877f2b9562834a89b7f95d7448c7c87228`.

Input-manifest anchors: DB final emit `57059a3e0c9382cb909db7d3f87e9436c090fd6424542ddc24a1059bd761b857` (2271 entries); executor final emit `314faba0f6100768448657dc0c52c1273c3c156de60f1989a97e8ef0ba166ac0` (2251 entries); all seven final test/typecheck manifests `2275a5a019d9d62585f31b6ec5c7c6b7157bb3ca6c14d6d0ba1e1561ce1965de` (2471 entries each). These are the corresponding `/root/SWAT/threats/project-completion-20261117/build-w3-final-*.inputs.json` files.

## Schema identity and unapplied boundary

Each proposal was compared byte-for-byte with its migration source and both hashes checked against final evidence:

| Proposal → migration source | Shared SHA-256 |
|---|---|
| `/root/SWAT/threats/project-completion-20261117/081-custody-schema.proposal.sql` → `/root/SWAT/packages/db/sql/081_custody_grants_delegation.sql` | `66e9aa8fd68edd9f51cbc1b086fec942e7a6125bce8105630535935b4c4b7e51` |
| `/root/SWAT/threats/project-completion-20261117/082-withdrawal-reducing-schema.proposal.sql` → `/root/SWAT/packages/db/sql/082_withdrawal_reducing_intent.sql` | `4d186f7d932545c467b869285693e23d6e06d282a3b7a8a21b2ae22517c3aa53` |
| `/root/SWAT/threats/project-completion-20261117/083-lp-schema.proposal.sql` → `/root/SWAT/packages/db/sql/083_lp_exact_paper_operations.sql` | `be0a956dce9b23f94c0453f84eaf00647c8abdf9b0e4250f46cf0faa07feda15` |

The integration note and final evidence explicitly record all three as **unapplied**. This review executed no SQL and did not connect to a database to inspect migration history; disk identity and declared unapplied status are not deployment-state attestation. Copying files into the migration directory does not provision roles or establish database qualification.

## Limitations retained for coordinator acceptance

No acceptance of PostgreSQL16/Redis, trigger/RLS/privilege/isolation behavior, real concurrent lock waits or crash recovery, durable deployed queues, independently trusted quotes/receipts/master/risk/funding/collateral mappings, cryptographic deployment/AAD verification, signing/broadcast/settlement, browser rendering or effective headers, cross-tab/multi-device/account-switch recovery, native sandboxing, production or live capability. Pure/injected fixture passing evidence and typechecks do not close those external gates. Existing source-review limitations remain; this final gate closes only the specifically inspected integration source and current offline evidence reconciliation.
