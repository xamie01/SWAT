# Sequential threat remediation ledger

**Implementation branch:** `fix/sequential-threat-remediation`. Authority baseline HEAD `8905505`. Original audit reports are retained unchanged. During package11 integration another process advanced observed HEAD to `99c0e16469934b235372df342de8abc8a2c1a155`; this session performed no commits or git recovery. See the recorded external checkout drift in `sequential-fixes/package11-integration-report.md`.

## Execution policy

One numbered package at a time. Every package uses its public seam below, a failing regression or previously established red evidence, a minimal root correction, then focused and neighboring tests. These seams follow the user-authorized audit fixes; no extra confirmation gate is required. All local workloads are sequential on CPU 0. No real credentials, financial transactions, production changes, commits or pushes. Deployment/key/venue properties are never marked fixed by source edits alone.

Statuses: pending, in-progress, fixed-tested, source-fixed-runtime-blocked, blocked, superseded-by-shared-fix. A safe refusal/containment is identified as such, not passed off as a completed financial feature.

| Order | Fix package | Current audit findings | Prior IDs | Status | Verification seam |
|---|---|---|---|---|---|
| 01 | Enforce proof before Robinhood enrollment and remove false delegation success | PF-WEB-01, PF-WEB-04, PF-WEB-05, PF-WEB-06 | API-07 | source-fixed-runtime-blocked | Authenticated enrollment/challenge endpoints; no mutation or authorization success without verified usable authority |
| 02 | Bind and atomically consume payment credit; strictly decode transfer evidence | PF-WEB-02, PF-WEB-03, PF-WEB-20, PF-WEB-16 | API-01, API-02, API-04 | source-fixed-runtime-blocked | Billing verification/intent endpoints and transactional payment writer |
| 03 | Make grant replacement and scoped revocation atomic and truthful | PF-WEB-07, PF-WEB-08, PF-WEB-09, PF-SEC-02, PF-SEC-03 | API-03, CHAIN-02, CHAIN-06 | source-fixed-runtime-blocked | Grant registration/replacement/revocation and vault rendering |
| 04 | Bind durable exact withdrawal intents and enforce settings authorization | PF-WEB-10 | API-06, API-08 | source-fixed-runtime-blocked | Withdrawal intent issue/confirm and user settings API; no unsupported financial side effect |
| 05 | Centralize secure server targets and browser trust headers | PF-WEB-15, PF-SEC-15 | LEAK-02, INF-04, WEB-05, WEB-06 | source-fixed-runtime-blocked | SSR/middleware/rewrite URL resolution, cookies, navigation and response headers |
| 06 | Redact sensitive diagnostics and minimize API/log/browser disclosures | PF-WEB-18, PF-WEB-19, PF-WEB-21, PF-WEB-22, PF-WEB-23, PF-DATA-20 | LEAK-01, LEAK-03, LEAK-04, LEAK-05, LEAK-06, LEAK-07 | source-fixed-runtime-blocked | RPC/error/log serialization, sensitive response projection, SSE and health |
| 07 | Repair testbed syntax, persistent signing isolation, replay and DOM sinks | PF-WEB-11, PF-WEB-12, PF-WEB-13, PF-WEB-14 | WEB-01, WEB-02, WEB-03, OWA-02, OWA-05, OWA-07 | source-fixed-runtime-blocked | Standalone server parser, canonical signed intent and safe text rendering |
| 08 | Make session revocation authoritative across caches | PF-DATA-11 | DB-03 | source-fixed-runtime-blocked | Session resolve/revoke/password-change with fake DB/time and isolated concurrency |
| 09 | Constrain database roles, lock topology and migration replay | PF-DATA-09, PF-DATA-10, PF-DATA-12, PF-DATA-13 | DB-01, DB-02, DB-05, DB-06, INF-03, RUN-01, RUN-02 | source-fixed-runtime-blocked | Pool policy, transactional scope, direct advisory-lock connection and migration discovery |
| 10 | Require attributable successful Solana swaps and correct decimal/fee attribution | PF-DATA-01, PF-DATA-02, PF-DATA-03 | IDX-01, IDX-02, IDX-03 | source-fixed-runtime-blocked | Pure parser and actual ingestion adapters with deterministic fixtures |
| 11 | Bound market ingestion and preserve net quantities, finality and unknown metadata | PF-DATA-04, PF-DATA-05, PF-DATA-06, PF-DATA-07, PF-DATA-08 | IDX-04, IDX-05, IDX-06, IDX-07, IDX-08, RUN-03 | in-progress | Source event construction, provider pagination and canonical evidence |
| 12 | Align scorer evidence and independent-control policy | PF-DATA-14, PF-DATA-15 | SIG-06, SIG-07 | pending | Metric eligibility and cluster/hub admission with explicit unknowns |
| 13 | Separate shared source state from per-tenant execution | PF-EXE-07 | EXE-02 | pending | Canonical source claim and sequential operator/two-tenant fan-out |
| 14 | Preserve exit ownership, acquisition mode and lot identity end to end | PF-EXE-04, PF-EXE-05, PF-EXE-09 | SIG-03, SIG-04 | pending | Close-all/stop-loss producer to canonical execution/evidence/trade persistence |
| 15 | Reserve only the selling masters available lots atomically | PF-EXE-06 | SIG-02 | pending | Source/explicit lot exit reservations and concurrent fill allocation |
| 16 | Apply reducing-exit policy through enqueue and worker | PF-EXE-08, PF-EXE-11 | SIG-05, EXE-03 | pending | Owned exits bypass entry-only checks but respect explicit stops/current policy |
| 17 | Make Jito submit and receipt recovery durable with typed identities | PF-EXE-01, PF-EXE-03 | EXE-06, EXE-07 | pending | Runtime pending store, transport and durable canonical settlement |
| 18 | Authorize exact final signing bytes and bounded economic policy | PF-EXE-02, PF-SEC-01 | EXE-05, CHAIN-01 | pending | Signer intent validation and owner-approved contract policy |
| 19 | Reserve exposure/capacity and fence emergency state | PF-EXE-10, PF-EXE-12, PF-EXE-13 | EXE-04, DB-04, SIG-08 | pending | Atomic spend/capacity reservation and current stop/policy checks |
| 20 | Retain durable per-user signal and exit delivery obligations | PF-EXE-14 | SIG-09 | pending | Fan-out outbox/recovery and clean-skip outcomes |
| 21 | Bind encrypted resources and signature/permission helper semantics | PF-EXE-15, PF-EXE-16, PF-EXE-17, PF-DATA-19 | CRY-02, CRY-03, CRY-04, CRY-05 | pending | Envelope context/version, single-use exact intents and semantic ABI policies |
| 22 | Protect LP registry, value risk in USD and complete rebalance lifecycle | PF-SEC-04, PF-SEC-05, PF-SEC-06 | SEC-03, SEC-04, SEC-05 | pending | User LP API to registry/build/risk/worker state |
| 23 | Correct perps close and bound dormant execution inputs | PF-SEC-07, PF-SEC-11 | SEC-06, SEC-07 | pending | Owned financial closure and isolated order helper fail-closed capability |
| 24 | Make alert/discovery delivery ownership and retries durable | PF-SEC-08, PF-SEC-09 | SEC-08, SEC-09 | pending | Notification lease/outbox and persisted wallet backfill intent |
| 25 | Constrain ML artifact and path trust boundaries | PF-SEC-10 | SEC-10 | pending | Local artifact loading and storage-root containment |
| 26 | Harden contract governance/resource checks and add executable invariants | PF-SEC-16, PF-SEC-17, PF-SEC-18 | CHAIN-03, CHAIN-04, CHAIN-05, CHAIN-07 | pending | Owner/config authorization, account/program constraints and local program test fixtures |
| 27 | Make deployment sources least-privileged and acquisition isolated | PF-SEC-12, PF-SEC-13, PF-SEC-14 | INF-01, INF-02, INF-06 | pending | CI artifact/tool boundaries, systemd working paths and install policy |
| 28 | Fix limiter configuration and safe integration-test isolation | PF-WEB-17, PF-DATA-16, PF-DATA-17, PF-DATA-18 | API-05, TEST-01, TEST-02, TEST-03 | pending | Bounded early-IP/parsed-account limiter, disposable infrastructure guard and unique fixtures |
| 29 | Revalidate existing closures and build/dependency/runtime gates | Acceptance and retained closures | EXE-01, EXE-08, SEC-01, SEC-02, MCP-01, MCP-02, MCP-03, INF-05, OWA-01, OWA-03, OWA-04, OWA-06, OWA-08, RUN-04, RUN-05, RUN-06 | pending | Final focused/full-safe regressions, source closure and explicit operational blockers |

## Package notes and evidence

### 01 — Enforce proof before Robinhood enrollment and remove false delegation success
- Seams established from the authorized audit: authenticated route rejection with zero state change; no fabricated account or usable authority claims.
- 4 enrollment regressions red then green; 7 focused tests pass (package01-complete.json). Unsupported 501, no signing or writes; historical auto-links require SIWE/SIWS audit provenance; EOA only. No deployed EIP-7702 account or executor; no runtime certification.
### 02 — Bind and atomically consume payment credit; strictly decode transfer evidence
- Payment route: 6 red assertions then green; writer: 10 red assertions then green. 26 focused tests pass (package02-complete.json). Strict finalized Transfer decode, Solana debited owner not fee payer, mandatory linked payer, canonical writer hashes, locked one-time intent and same-client audit. UI uses intent.referenceMemo without fallback. Exchange attribution is unsupported/manual review; no provider or production DB certification.
### 03 — Make grant replacement and scoped revocation atomic and truthful
- Interrupted red evidence retained; resumed route/writer/PDA regressions 11/11 pass in package03-resumed.json. Exact chain/grant pair, owner conflicts rejected before revocation, transaction audit, true local-only scoped revoke, derived PDA with no fallback or pretend deployed authority. Actual deployed vault/account proof remains unsupported.
### 04 — Bind durable exact withdrawal intents and enforce settings authorization
- Withdrawal issue/confirm now authenticated 501 with no email, OTP mutation or queued-action claim; UI explicitly unavailable pending durable exact-intent executor. Settings ceiling compares locked row, admin-only increases, transaction-client strict audit rollback. All sequential regressions passed in package04-confirm.json; actual withdrawal execution remains unavailable.
### 05 — Centralize secure server targets and browser trust headers
- 6/6 focused tests pass (package05-complete.json). Shared parsed backend target rejects production remote HTTP and credentials/query/fragments, exact loopback only; SSR ignores public config and rejects redirects; middleware shares resolver; Secure production cookies cannot be disabled; same-origin decoded login routing and baseline CSP/anti-framing/nosniff/referrer headers. Deployment TLS/HSTS/full script-nonce CSP and trusted ingress validation remain operational/final-gate work (proxy source in28).
### 06 — Redact sensitive diagnostics and minimize API/log/browser disclosures
- 71 sequential regressions pass (package06-final.json); selected backend source noEmit passes at640MB (package06-backend-final-640). Redacted console/Redis objects+credential text and provider URL paths; RPC diagnostics hostname-only, malformed heights unhealthy, timeout includes body. Generic API/LP exceptions, no-store request hooks, query SSE tickets removed/admin session stream, credential-status-only CLOB projection/UI. Real log stores/ingress and LP/PDA runtime tests remain final-gate limits; standalone parse repair belongs07.
### 07 — Repair testbed syntax, persistent signing isolation, replay and DOM sinks
- Syntax red then green; 7 read-only handler/hostile DOM fixtures pass (package07-confirm). Genuine keyless PDA preview only: interactive custody, funding, signing, simulation and monetary routes removed/refused even with secret/opt-in. No replay acceptance remains. No provider calls/listener; headers/generic errors. Standalone dependency resolution requires deployment packaging (fixtures alias installed web3). Future actions require persistent recovery, verified devnet opt-in and durable random intents; old HMAC custody recovery unverified.
### 08 — Make session revocation authoritative across caches
- 7 session regressions and7 testbed regressions pass in package08-green.json. Session cache removed; authoritative write-pool touch then fresh DB snapshot with revoked/expiry/active checks; no stale cache resurrection across process or password changes. A revoke can overlap requests authorized before its commit; downstream financial atomicity remains own transaction responsibility. Real production replica/role topology unverified.
### 09 — Constrain database roles, lock topology and migration replay
- PF-DATA-09/10/12/13: role/query 15 red, direct-lock 12 red, migration 19 red, policy 4 red, transaction 2 red plus legacy-provisioning 1 and review 2 red, then final guarded source run package09-final.json: 185 passed/0 failed/23 files (56 package09 sequential,44 safe neighbors incl2 new transaction cases,85 retained01-08). package09-focused-final-typecheck-640.log exit0 for10 modules/source dependencies; full backend source check OOM640 and package-local stale shared declaration errors retained, not passes. Transaction-pinned swat_app validation/reset and poisoned-client refusal; dedicated DIRECT_DATABASE_URL pg.Client with checked lock/unlock/backend identity and guaranteed end; separated credential-free DBA roles and forward SQL070; checksummed prefix journal, key1 concurrent-run exclusion, atomic pending suffix and explicit audit-only baseline adoption, no066 replay. SQL064 changed narrowly only for fresh provisioning; deployed compatibility uses audited installed/source hashes. package09-notes.md records exact evidence and availability/DB-operation gate: unscoped auth/admin/global flows fail closed pending reviewed capabilities; roles, credentials, ownership, schema, PgBouncer topology, baseline and migrations NOT applied or runtime-certified. No DB/Redis/network/services/installs/commits; stop09.
### 10 — Require attributable successful Solana swaps and correct decimal/fee attribution
- Source-stage complete with constrained route coverage; 220/220 selected assertions and focused parser/adapter typecheck passed. See threats/sequential-fixes/package10-notes.md and package10-reviewed-bounded-final.json. Nested/setup/closure/wrap routes, provider deployed ABI, finality and production acceptance remain qualified gates.
### 11 — Bound market ingestion and preserve net quantities, finality and unknown metadata
- **Latest integrated checkpoint (2026-11-13):** concurrent aspect source safeguards plus public bounded durable polling/UNREADY display are integrated. Explicit ambiguous tx/wallet identity, global unavailable-verifier fresh-path fence/history nonreapplication, operation-local metadata/post-write validation/scalar tick refusal, finite-keyset lease/cursor fair attempt continuation and truthful quarantine evidence preserve unavailable copying/economic settlement. Final permitted guarded selection **444 passed/42files/0failed/0skipped**, focused source-and-test noEmit640 **exit0**. Not fullrepo/build/runtime acceptance. Independent integrated Standards/Spec review pending. Native identity/verifier/promotion/history repair/schema/grants/transport/artifacts/venue and later execution retry gates keep11 in-progress,12–29pending. External checkout commits appeared during gate; this session did not commit/reset/recover. See `sequential-fixes/package11-integration-report.md` and six aspect reports. Earlier bullets below are historical checkpoints, never added together.
- Proceeding in the existing order: bounded provider pagination first, then truthful finality, stable identity, wallet-net quantities and unknown market context. No runtime/provider certification implied.
- 2026-11-13 checkpoint: bounded paging/individual metadata requests, exact Robinhood wallet-net canonical quantities, and observation quarantine in Solana/Polymarket/Robinhood callers. Current guarded selection 255 passed/30 files/0 failed/0 skipped; selected current source typecheck640 passed. Narrow static containment review found no introduced bugs; original broad Standards/Spec reviews provider-blocked. See package11-notes.md for all red/green evidence. Confirmation promotion/reversal, historical confirmed rows, stable fill identity/exact Polymarket quantities, metadata provenance/global operation bounds, generic Polygon and health readiness remain unresolved. Containment withholds copying; no runtime certification or package closure.
- 2026-11-13 exact-decimal checkpoint: bounded authoritative size/price text, exact atomic conversion and BigInt notional, original JSON numeric lexemes, equivalent-spelling observation identity. Four preserved red/green regressions; reviewed permitted selection304passed/31files/0failed/0skipped and focused source typecheck640exit0. Bounded Standards0hard violations/1duplication smell addressed; bounded Spec0findings including cleanup. Quarantine unchanged; native fill identity/finality/historical data/metadata global budget and freshness/generic Polygon/health/runtime gates remain open. No live operations, commits or pushes; package11 in-progress.
- 2026-11-13 metadata checkpoint: shared backfill request/monotonic-time/streamed-byte limits, terminal budget errors, late-success refusal and cancellation. Resolution caller compiler regression and review-stage prefix starvation reproduced/corrected; polling retains fresh per-market budgets, whole-scan bounds/continuation explicitly open. Final permitted selection 320 passed/31 files/0 failed/0 skipped; focused source typecheck640 exit0. Final bounded Standards 0 hard violations/0 new smells/1 inherited low heuristic; Spec 0 remaining findings after resolving 2 polling findings. DB waits not actively cancelled; provenance/freshness/native identity/finality/history/generic Polygon/health/runtime remain open. Quarantine unchanged; no live operations, commits or pushes. Package11 in-progress.
- 2026-11-13 generic Polygon checkpoint: public EVM backfill explicitly unavailable before invocation-level RPC/DB/pricing/legacy publication, containing unsupported transfer classification; separate Polymarket and reviewed Robinhood routes preserved. Initial incomplete-fixture red retained; complete-fixture red inserted1, guard green19/3files. Current permitted selection321passed/31files/0failed/0skipped; focused source typecheck640exit0. Bounded Standards0hard violations/0new smells; Spec0findings and callers traced. Module-level Redis initialization is outside invocation guarantee. Functional Polygon classifier/history repair/native identity/finality/metadata freshness and DB/poll bounds/health/runtime remain open; package11 in-progress. No live operations, commits or pushes.
- Evidence: threats/sequential-fixes/package11-notes.md
- Evidence: threats/sequential-fixes/package11-terminal-full-guarded.json
- Evidence: threats/sequential-fixes/package11-terminal-typecheck-640.log
- Evidence: threats/sequential-fixes/package11-polymarket-observation-red.json
- Evidence: threats/sequential-fixes/package11-polymarket-observation-green.json
- Evidence: threats/sequential-fixes/package11-solana-observation-red.json
- Evidence: threats/sequential-fixes/package11-solana-observation-green.json
- Evidence: threats/sequential-fixes/package11-null-terminal-red.json
- Evidence: threats/sequential-fixes/package11-null-terminal-green.json
- Evidence: threats/sequential-fixes/package11-exact-decimal-red.json
- Evidence: threats/sequential-fixes/package11-exact-decimal-green.json
- Evidence: threats/sequential-fixes/package11-decimal-identity-red.json
- Evidence: threats/sequential-fixes/package11-decimal-identity-green.json
- Evidence: threats/sequential-fixes/package11-wire-decimal-red.json
- Evidence: threats/sequential-fixes/package11-wire-decimal-green.json
- Evidence: threats/sequential-fixes/package11-product-scale-red.json
- Evidence: threats/sequential-fixes/package11-product-scale-green.json
- Evidence: threats/sequential-fixes/package11-json-source-capability.log
- Evidence: threats/sequential-fixes/package11-decimal-reviewed-full.json
- Evidence: threats/sequential-fixes/package11-decimal-reviewed-typecheck-640.log
- Evidence: threats/sequential-fixes/package11-metadata-request-budget-red.json
- Evidence: threats/sequential-fixes/package11-metadata-request-budget-green.json
- Evidence: threats/sequential-fixes/package11-metadata-deadline-red.json
- Evidence: threats/sequential-fixes/package11-metadata-deadline-green.json
- Evidence: threats/sequential-fixes/package11-metadata-bytes-red.json
- Evidence: threats/sequential-fixes/package11-metadata-bytes-red-complete.json
- Evidence: threats/sequential-fixes/package11-metadata-bytes-green.json
- Evidence: threats/sequential-fixes/package11-metadata-late-success-red.json
- Evidence: threats/sequential-fixes/package11-metadata-late-success-green.json
- Evidence: threats/sequential-fixes/package11-metadata-typecheck-red-640.log
- Evidence: threats/sequential-fixes/package11-metadata-resolution-red.json
- Evidence: threats/sequential-fixes/package11-metadata-resolution-green.json
- Evidence: threats/sequential-fixes/package11-metadata-poll-coverage-red.json
- Evidence: threats/sequential-fixes/package11-metadata-poll-coverage-green.json
- Evidence: threats/sequential-fixes/package11-metadata-reviewed-full.json
- Evidence: threats/sequential-fixes/package11-metadata-reviewed-typecheck-640.log
- Evidence: threats/sequential-fixes/package11-polygon-attribution-red.json
- Evidence: threats/sequential-fixes/package11-polygon-attribution-red-complete.json
- Evidence: threats/sequential-fixes/package11-polygon-attribution-green.json
- Evidence: threats/sequential-fixes/package11-polygon-full-guarded.json
- Evidence: threats/sequential-fixes/package11-polygon-typecheck-640.log
