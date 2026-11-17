# Wave 3 exclusive ownership and execution contracts

Authority: WORK-MAP.md; no production migrations, services, install/download, credentials, real keygen/signing, or external execution. Wave 2 coordinator acceptance must exist before implementation starts. At most three implementation owners concurrently; all verification via the bounded offline runner under CPU0 `/tmp/swat-package11-checks.lock`, 512MB/one fork tests, 640MB compiler. Global source freeze before verification. Owners submit literal test configs for coordinator import review/hash registration, not self-approval.

## Ownership

- E — custody/delegation: `packages/db/src/execution-grants.ts`, `credentials.ts`, their domain tests/new custody modules, `apps/trade-executor/src/execution-authority.ts`, `execution-authority-adapters.ts`, their tests/new custody/delegation adapters. No application entrypoints, barrels, API/web files, canonical lifecycle, or prior sealed Wave 1 modules.
- F — withdrawal/reducing domain: new `packages/db/src/withdrawal-*` and `reducing-*` modules/tests; `packages/db/src/polymarket-perps.ts` and its tests; `apps/trade-executor/src/manual-exit.ts`, `polymarket-perps.ts`, their tests/new reducing orchestration modules. F submits route contract and injected ports to H; F never edits `apps/api/src/routes/me.ts`.
- G — LP: `apps/lp/src/` implementation/tests and `packages/db/src/lp-*` implementation/tests. No shared barrels, web/API, canonical lifecycle or other db domain files.
- H — sole API/web integrator (starts when a slot is free): `apps/api/src/routes/me.ts`, API route tests/new route modules, custody enrollment route joins if needed, and `apps/web/` source/tests. Consume E/F/G accepted contracts; preserve tenant scope derived from principal, exact quantities, and truthful capability states. No E/F/G source edits.
- Coordinator — root runner/config hash registry, package barrels, migration numbering/integration, shared final joins, governance/ledger/reports, global source freeze and acceptance. Schema proposals: E 081, F 082, G 083; proposals in this evidence directory only until coordinator integration. Existing 077/078 sealed; existing 079/080 accepted source-only, never applied.

## Required seams and reports

E: separate wrap-only enrollment port from execution unwrap port; no plaintext secret through public grant projection; sealed envelope scope/version binding; keyless grants stay keyless; execution uses verified deployed delegation scope, not caller labels or opaque arbitrary policy. Actual provider/key services remain explicitly blocked.

F: durable exact intent binds tenant/chain/asset/destination/amount/expiry; OTP single-use authorization atomically consumed with request, cooling-off/ownership/balance/mode rechecked; attempt/outbox persistence before external effect; uncertainty and reconciliation prevent duplicate submission/false completion. Spot and perps closure cannot increase exposure or cross zero; persist exact requests and receipt-based partial/final closure, never mark closed on admission alone.

G: valued paper acquisition using trustworthy injected valuation/protocol context; unknown economics stay unknown; rebalance and close plans/receipts recover from durable operation records; follower copy plans actually feed acquisition, with tenant/mode/risk constraints and provenance. Live protocol ports remain unavailable unless actual inputs accepted.

H: unified `/me` domain routes invoke durable contracts with injected seams, not Map-only OTP authority or unconditional capability booleans. Web transports expose exact amounts and honest source/injected/runtime/live readiness. Route tests must drive actual registered handlers, including tenant denial, stale authority, substituted intent, retry, cooling-off and no false close.

Each owner: scope report, changed paths/hashes, test seam/import safety inventory, capability limitations and blocked inputs. Freeze -> independent read-only review -> repair supported findings -> affected reruns -> coordinator verifies raw assertion results, command/resource/timeouts, source/input/artifact hashes -> per-domain acceptance or explicit rejection. Wave 4 cannot start from implementation or mocks alone.
