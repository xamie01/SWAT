# Build completion work map — 2026-11-15

> Historical coordination plan, not completion sign-off. Sequential remediation from commit `564818d` is tracked in `../build-completion-20261116-sequential/PLAN.md` and its fingerprinted evidence/report files. The original owner roster and baseline below remain historical. Source/test fixes and unavailable capabilities are not full build, runtime or deployment acceptance.

## Objective and acceptance

User requested a complete build/deployment-readiness map and parallel implementation with report review. Baseline HEAD `08c822d`; the checkout contains substantial inherited uncommitted work. Preserve it. Baseline file fingerprints are recorded in `baseline-fingerprints.json`.

A source fix, mock test or intentional refusal is not feature/runtime acceptance. Track four separate states: implemented and tested; integrated but runtime-unverified; blocked on external capability; intentionally unavailable. No live trading, real signing/key generation, credentials, production services, applied production migrations, publication, commits or pushes. Missing legal, venue, custody, artifact approval and native toolchain evidence must stay explicit.

## Coordination and verification

- Exclusive ownership below includes matching local tests; DB barrel `packages/db/src/index.ts`, shared barrel `packages/shared/src/index.ts`, root package/turbo scripts and final evidence are coordinator-owned unless reassigned explicitly.
- All tests, compilers, emitted package builds and Python checks are serialized under `taskset -c 0 flock -x /tmp/swat-package11-checks.lock`. Node tests use 512 MB and one fork; compilers/package builds use 640 MB. Never root `pnpm build`, full Next build, `pnpm dev` or container startup on this host.
- Use existing reviewed literal-file offline runner/harness for safe Node tests after reviewing imports; unique `build-<owner>-...` labels preserve prior evidence. No broad suite imports with key generation or live side effects. Record real diagnostics and raw manifests, not labels pretending failures passed.
- Tests use the existing sequential ledger's public seams; each owner records the actual seam, red regression (or honest prior/source evidence), minimal correction, green/neighbor/typecheck results, changed paths and SHA256 fingerprints in its report.
- Reports: `threats/build-completion-20261115/<owner>-report.md` plus JSON/log evidence as needed. Owners finish and return, not park waiting for another owner.

## Exclusive workstreams

| Owner | Scope | Main files | Completion evidence |
|---|---|---|---|
| build | Typecheck/artifact drift; bounded build and whole-workspace verification inventory | new scripts/build-completion*, integration lifecycle test; no root script edits without coordinator | Nullable tests corrected semantically, reproducible bounded emit/check plan, actual package diagnostics |
| source | Source confirmation/provenance, quarantine, metrics/control capability | indexer source lifecycle/adapters and DB copy-trade-lifecycle/lot allocation; scorer metrics excluded | Genuine validation and history/retry gates, no fabricated readiness |
| worker | Canonical exit/tenant/mode/current-policy and settlement caller integration | trade-executor index.ts plus new keyless worker modules/tests | Exact owned exit checks, no queued-boolean authority, scoped evidence and identity |
| risk | Same-client risk/capacity, durable epoch/control APIs | DB risk-policy/master-capacity/trading-control and matching tests | Atomic admission/receipt composition; unknown liabilities retained |
| fanout | Durable recipient snapshot and delivery integration | signal-engine index/fanout/eligibility; DB package13-fanout-delivery | Commit-before-queue, retries/outcomes and tenant isolation |
| scorer | Stop-loss/close-all canonical claims and wind-down caller | scorer index/stop-loss/close-all and DB close-all/stop-loss/pnl queries | Real startup wiring; exact lot snapshots; no legacy fallback |
| jito | Typed submit, durable pending/receipt adapter and reconciliation seam | executor solana-dispatch/jupiter-jito-runtime/config plus new receipt modules | Identity, exact bytes/prewrite, commit-before-ack, ambiguity retained; no enabling signer |
| schema | Forward migrations, roles and safe integration infrastructure | new DB SQL migrations; integration helpers/config/scripts | Honest migration/profile/catalog/reference gates; no shared DB destruction |
| lp | Trusted USD/acquisition mode, same-client reservations and paper lifecycle | apps/lp; DB lp-*; SQL-lp additions coordinated with schema | Mixed assets never raw USD, truthful confirmed lifecycle, live unavailable if unsupported |
| program | Complete Solana swap policy/governance resource checks | programs/wake-vault; keyless static tests | Defined contexts/account policy, budget/floor/owner checks; compile/ABI blocked if no tools |
| ml | Native artifact format/parity and storage/CLI trust | pattern-ml except setup-server script assigned ops | Safe loading/path/input behavior and dependency parity evidence; no pretend native pass |
| ops | Least-privilege packaging, CI/services/build artifacts and readiness | deploy, .woodpecker*, DEPLOYMENT, ML setup-server script | Credential-free reviewed acquisition, manifest validation, paper deployment readiness checks |
| api | Auth/custody/perps capability contracts and notification/discovery durable delivery | API routes/me and related auth; alert/discovery; DB notification/discovery/perps helpers | Safe public responses, durable ownership/recovery; no fake financial closure or custody |
| web | Frontend build/typecheck/QA and unfinished product surface inventory | apps/web only | Honest unavailable states, real API wiring, package check evidence; no local full Next build |
| inventory | Read-only full checklist/product gap sweep | all docs/source read-only; own report only | Every open build gate mapped to owner/external/deferred, no stale completion counts |

## Dependency joins owned by coordinator

1. Export stable owner APIs from DB/shared barrels after receiving contracts.
2. Join worker with same-client risk/capacity, Jito receipt settlement and canonical source/exit APIs.
3. Join forward schema with fanout, notification/discovery, risk and LP changes without editing old migration history.
4. Refresh shared then DB emitted artifacts with bounded per-package builds, then check consumers sequentially.
5. Run independent Standards and Spec review on current fingerprinted changes. Repair supported findings with exclusive follow-up scopes and recheck.
6. Run final safe deduplicated regression manifests, all standard package noEmit checks, integration compilation, secret/env/deployment readiness checks; document unexecuted emitted web/native/runtime gates separately.

## External gates that code cannot truthfully close

Approved artifact/image/runtime inventories; canonical disposable DB/Redis/schema and roles proven in real infrastructure; Rust/Anchor/Solana compile and regenerated deployed ABI; native ML dependencies/parity; separately authorized custody wrapping/unwrapping service and domain persistence; venue receipt/provider samples and capped canaries; TLS/ingress/service provisioning/backups/restart proof; legal/jurisdiction and signed certification. These are not authorization to publish, provision or move money.
