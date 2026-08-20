# SWAT Unified Builder Guide

**The single build order for taking SWAT from its current state to the final product.** This guide merges three sources into one sequence and resolves their conflicts:

1. `AUDIT-FIX-CHECKLIST.md` — current codebase status: ~120 supported completion marks, ~114 open items after the 2026-07-24 validation review.
2. `docs/plans/saas-conversion-plan.md` — the destination: multi-tenant SaaS (auth, per-user tracking, custody, billing, dynamic chains, frontend).
3. `docs/plans/production-decisions.md` — the 18 decided infrastructure/scaling/security/database decisions (D1–D18).

Where this guide and an older doc disagree, **this guide wins** (it exists to supersede their sequencing). Where this guide is silent on a detail, the source doc is authoritative. Audit item IDs (F-CORE1, G5-R3, …) and decision IDs (D1–D18) are kept for traceability.

---

## 1. Destination

A SaaS platform where users sign up (email/password + linked EVM/Solana wallets), track any wallet or token contract with backfilled history, receive signal feeds scoped to what they track, and opt into autonomous execution from a **platform-managed custodial trading wallet**, sized proportionally to the balance and risk % they agreed to. Tiers: Free / Operator / Ultra (billed via Stripe **and** USDC). Ultra unlocks dynamic any-EVM-chain tracking (Chainlist metadata, DeFi Llama top-5 DEXes, CoinGecko pricing). Runs on one hardened US VPS with staging, CI-gated deploys, and the D1–D18 posture.

## 2. Where the codebase is today

- **Solid (verified closed):** all of audit Phase 0 (data-corruption, ingestion, safety, API/web/alert repairs), ingestion health end-to-end, execution-mode matrix parsing/gating (G1-M1–M4, M6, M7), Polymarket canonical market data (F-PM1/PM2, G3-P1/P2), balance-capped sizing (H1), timestamp/chain-resolution correctness (L14/L15), shadow schema (G4-S1/S4).
- **Open — engine gaps:** canonical copy-trade lifecycle has schema but no runtime callers (F-CORE1–7); risk enforcement is env-based, not DB-policy-based (G5); mode dispatch incomplete (G1-M5/M8/M9); **`pnpm test` fails, no CI exists, a literal test key sits in the worktree** (G7 area).
- **Open — venue executors:** Robinhood live (F-RH, G2-R) and Polymarket live (F-PM3–8, G3-P3–12) are unbuilt/uncertified; Solana live is Trojan-based and uncertified (F-SOL).
- **Absent entirely:** users, sessions, tenancy, custody, billing, dynamic chains — the whole SaaS layer.

## 3. Standing rules (apply to every stage)

These never expire; several come from the audit's Working Rules and carry forward:

1. **Green gate:** `pnpm typecheck`, `pnpm test`, `pnpm build` pass at every stage exit. No stage is "done" with a red suite. (After Stage 0, CI enforces this.)
2. **Account-parameterization rule:** any execution/risk code touched from now on takes an account/scope parameter with `'operator'` as today's only value. Migration 028's schema already supports this (`target_account`, UNIQUE `(source_trade_id, target_account, execution_mode)` and `(chain, target_account, client_order_id)`). Concretely:
   - Idempotency/client order IDs keyed `(signalId, target_account)` — never `signalId` alone (affects F-CORE5, G3-P6, G3-P7).
   - Risk policy resolver signature `resolveRiskPolicy({account, chain})` (G5-R1/R2); exposure caps and daily-cap alerts keyed the same way.
   - Circuit breaker state keyed `(account, chain)` (G5-R3).
   - Mode dispatch resolves `(account, chain)` (G1-M5).
   - Balance readers take a wallet address argument; env wallets become the operator default (`balances.ts`).
   - Executors accept a signer/credentials parameter; `EVM_PRIVATE_KEY` is passed in at the call site, not read deep inside (`robinhood.ts`, `polymarket.ts`, F-PM3/G3-P3).
3. **Idempotency:** source events and executions are idempotent; never infer or fabricate a fill. Deterministic BullMQ job IDs everywhere.
4. **Migrations:** idempotent files, replay model kept (D16); dedicated deploy step, CI double-replay + staging-copy replay; expand-and-contract for breaking changes; destructive statements never ship in the same release as dependent code.
5. **Tenancy (once Stage 2 lands):** `user_id` comes from the session, never the request payload; all per-user SQL goes through the `forUser(userId)` helper layer (D12).
6. **Money safety:** live modes stay clamped by `LIVE_ENABLED_CHAINS` + `chain_certifications`; staging never holds a custody master key or certifications (D2); least-privilege bounded token approvals, never infinite allowances.
7. **Secrets:** SOPS-encrypted env files, never git; nothing secret in `NEXT_PUBLIC_*` (D10/D12).

## 4. The build order

Seven stages. Each lists what it pulls from the audit checklist, the SaaS plan, and the production decisions, plus its exit gate. Stages 1–2 and 6 can overlap with their predecessors; everything else is sequential.

### Stage 0 — Engine hardening + infra baseline
*The shared substrate. Everything else stands on this.*

**Audit items (close these):**
- Canonical lifecycle: F-CORE1–F-CORE7, G1-C1, G1-C2 — immutable source events with runtime callers, transactional position updates, full execution state machine (requested→…→confirmed/failed/cancelled/reconciliation_required), startup + periodic reconciliation. Built account-parameterized per Standing Rule 2. This goes from important to existential once one signal fans out to N users' funds.
- Mode matrix completion: G1-M5 (off/paper/live/live+shadow dispatch), G1-M8 (real API-backed dashboard controls — the workspace toggles are currently hard-coded local state), G1-M9 (mode tests).
- Risk enforcement: G5-R1, G5-R2, G5-R3, G5-R5, G5-R6, G5-R7, L17 — one DB-resolved validated risk policy enforced **before claim** in every mode; persisted per-`(account, chain)` breaker; atomic kill switch honored within one cache TTL; gas reserves sized down not floored up. Migrate existing operator config explicitly, don't overwrite.
- Test/CI hygiene: green `pnpm test`; G7-T3 (`pnpm test:integration` + CI with Postgres/Redis services); G7-T4 unit tests (execution config, risk math, breaker state, reconciliation idempotency); remove generated artifacts and the literal test private key from the worktree (Final Repository Gate items); L16 (Jupiter decimal/threshold correctness — paper quotes depend on it).

**Production decisions activated:** D1 (provision the box), D2 (staging, paper-clamped), D3 (CI/CD pipeline — same CI as G7-T3), D7+D10 (Caddy + Cloudflare + full hardening bundle), D15 (backups + nightly staging restore), D17-now items (`pg_stat_statements`, BRIN on transaction timestamps, `readPool`/`writePool` split in `packages/db`).

**Exit gate:** audit Phase 1 lifecycle exit gate met; risk policy DB-resolved and pre-claim-enforced; CI green on every merge; staging receiving auto-deploys; backups restoring nightly.

### Stage 1 — Auth & tenancy (SaaS Phase 1)
*Orthogonal to Stage 0 — may start in parallel once CI is green.*

- Migrations 029+: `users`, `user_sessions`, `user_auth_wallets`, `user_api_keys` (argon2id, opaque session tokens, SIWE/SIWS wallet linking).
- `apps/api/src/auth/` module: signup/login/logout/me, wallet nonce+verify; layered auth plugin attaching `request.user` (session cookie or per-user API key); `requireTier()`/`requireRole()` guards; rate limits on auth routes.
- The global `API_KEY` becomes internal service→API only and is rotated; `NEXT_PUBLIC_API_KEY` is deleted (D12).
- **Audit-log table** for auth/custody/billing/admin events — built now per D10/D13 (cheap early, impossible to retrofit); alerts ride the existing Telegram alert-service.

**Exit gate:** signup→login→wallet-link→`/v1/auth/me` works end-to-end; cross-tenant test suite scaffolded; browser holds no shared secrets.

### Stage 2 — Per-user tracking, backfill, feeds (SaaS Phase 2)

- `user_wallet_subscriptions`, `user_token_watches`; global-dedup model preserved (wallet indexed once, many subscribers); zero-subscriber wallets paused via scorer lifecycle (D9).
- Tier matrix in `packages/shared/src/tiers.ts` — single source of truth for quotas/features; API-enforced quotas (free 3 / operator 25 / ultra unlimited wallets; token backfills/day).
- `/v1/me/*` routes (wallets, tokens/backfill, signals, feed) via the `forUser()` helper layer; existing global routes become admin-only.
- Backfill scaling: BullMQ tier priority, 429-aware concurrency within the Helius plan budget (D9).
- Real-time: generalize SSE+ticket to `/v1/me/stream` fed by existing Redis channels, filtered per subscription; retire dashboard polling (D8).
- **Attribution (parallel, non-blocking):** G6-A2–A10 — outcomes keyed by (signal, mode), all latency stamps written at their real transitions, expectancy persisted and dashboard-exposed. Feeds the per-user dashboards and justifies platform-curated signals.

**Exit gate:** two users track different wallets and see disjoint feeds; quotas enforced; cross-tenant attack tests pass in CI; SSE feed live.

### Stage 3 — Venue executors & certification (audit Phases 2–3, on demand)
*Pull-based: certify a venue when (and only when) you want live money on it. Paper mode ships everywhere without this stage.*

- **Solana path (DG-1 — RESOLVED 2026-07-27): direct Jupiter signing with Jito bundle submission.** The Trojan webhook path is retired; F-SOL2/F-SOL3 are retargeted to certify the new path. Executor spec:
  - **Build:** Jupiter Swap API — the quote client already exists (`packages/shared/src/jupiter.ts`); add the `/swap` transaction-build step. Sign locally with the operator wallet now, per-user custodial keys in Stage 4 (the signer is a parameter per Standing Rule 2).
  - **Submit:** Jito block engine `sendBundle` with a tip instruction appended — **never broadcast via public RPC**, that's the front-running protection. Bundles are atomic (all-or-nothing), so there is no partial-execution state to reconcile.
  - **Tip sizing:** dynamic from the Jito tip-floor percentile endpoints, bounded by a `JITO_MAX_TIP_LAMPORTS` cap; tip counts against the user's position cost in sizing/P&L.
  - **Confirmation:** poll bundle status + on-chain signature status; on timeout mark `pending_confirmation` and hand to the reconciliation sweeper (same pattern as G2-R9). Resubmission is safe only under the `(signalId, target_account)` idempotency key with the same blockhash-expiry semantics — an expired blockhash means a fresh quote+build, never a blind retry.
  - **Fallback policy:** if the Jito block engine is unavailable, fail the job honestly (breaker counts it) rather than silently downgrading to public RPC broadcast — a silent downgrade would reintroduce the exact exposure the decision removed. A config flag may later allow explicit RPC fallback per account.
  - **Retirements:** `TROJAN_WEBHOOK_URL`/`TROJAN_API_KEY` env and the Trojan client path are deleted once the new path is certified; `TROJAN_WALLET_ADDRESS` balance reads become the operator signing wallet passed into the parameterized `balances.ts`. The already-closed H4 (Trojan timeout/idempotency) work is superseded with the path.
  - **Certification (retargeted F-SOL2/F-SOL3):** stable idempotency key, returned bundle/signature identity, chain-confirmed fill amounts from the transaction meta, truthful failure/timeout states, then a deliberately capped live canary recorded under `docs/certification/solana.md`. F-SOL1 (canonical event parity) and G1-S1 (latency measurement) are unchanged.
- **Robinhood:** F-RH1–F-RH6, G2-R1–G2-R13 as specified in the checklist (configured chain tuple, receipt decoding, golden calldata vectors, restart reconciliation, tiny canary, certification doc review) — with the signer passed as a parameter (Standing Rule 2).
- **Polymarket:** F-PM3–F-PM8, G3-P3–G3-P12 — credential derivation implemented as a *function of an EVM signer* (per-user-ready), client order ID = `(signalId, target_account)`, book-walking/rounding/fill-polling/reconciliation as specified, canaries + certification doc review.
- Per-chain queue split lands here or at first paying cohort, whichever first: `swat-trades-{solana,polygon,robinhood}`, concurrency 1 each (D6, satisfies F-ACC2 isolation).

**Exit gate (per venue):** the checklist's own certification gate — `docs/certification/<chain>.md` reviewed, canary evidence recorded, then and only then the chain enters `LIVE_ENABLED_CHAINS`.

### Stage 4 — Custody & per-user autonomous execution (SaaS Phase 3)
*Hard prerequisites: Stage 0 complete, Stage 2 complete, DG-1 decided, and the legal gate below.*

- **Decision gate (DG-2, non-negotiable):** legal counsel opinion on custodial funds + autonomous trading in the operating jurisdiction; ToS/risk disclosures; Cloudflare geo-blocks live; Polymarket per-user geo-gate (D13). Custody does not launch without this.
- `packages/custody`: per-user Solana + EVM keypairs, envelope encryption (per-key AES-256-GCM data keys, master key only in trade-executor env on the hardened host), `KeyWrapper` interface for the later KMS swap (D11). API can request keygen, never decryption.
- `user_trading_wallets`, `user_balances` (poller reuses parameterized `balances.ts`), `user_execution_settings` (per-chain mode, auto-execute, min score, max position %, daily exposure %, stop loss — defaults from `DEFAULT_RISK_CONFIG`, live execution tier-gated).
- Deposit (address + QR) and withdraw (**only to SIWE/SIWS-verified linked wallets**, email confirm, daily cap — D11's anti-theft core).
- **Fan-out:** on a trade-eligible signal, enumerate eligible users (subscribed ∩ auto-execute ∩ chain enabled ∩ tier ∩ balance) → one job per `(signal, user)` on the per-chain queue, idempotent via the Stage-0 `(signalId, target_account)` keys; `trades.user_id` added; per-user breaker/exposure/paper-bankroll ride the account-parameterized Stage-0 machinery unchanged.
- Executor network isolation: no inbound connections to the trade-executor container; consider the dedicated custody host split (D5 step 2) at this point.
- Platform-wide gates (`chain_certifications` + `LIVE_ENABLED_CHAINS`) still clamp on top of user settings.

**Exit gate:** paper-mode fan-out proven for multiple users on one signal with disjoint sizing; withdraw controls tested adversarially; custody keys never observed outside trade-executor (log/API scan); KMS migration path demonstrated on staging.

### Stage 5 — Billing (SaaS Phase 4)
*Can overlap Stage 4.*

- `subscriptions` + `payments`; Stripe Checkout + signature-verified webhook; USDC treasury watcher (Solana + Polygon) reusing indexer infra, reference/memo-matched; lifetime tier = `tier_expires_at NULL`; nightly downgrade job with 3-day grace.
- Tier changes write the audit log; billing events alert via Telegram.

**Exit gate:** end-to-end tier grant from both rails on staging (Stripe test mode; USDC on a devnet/testnet or small mainnet canary); downgrade path proven.

### Stage 6 — Frontend rebuild (SaaS Phase 6)
*Runs progressively from Stage 1 onward; each backend stage gets its UI as it lands.*

- Foundation first: build-time Tailwind (drop the CDN script), shared `lib/api.ts` (cookie auth, no API key), `middleware.ts` route protection, react-query.
- Stage-1 UI: real signup/login replacing the fake `admin@wake.com` modal; wallet linking via wagmi + RainbowKit + `@solana/wallet-adapter`.
- Stage-2 UI: My Wallets / My Signals / activity feed on the SSE stream; existing `HealthView` + `SignalsView` safety drawer carry over user-scoped.
- Stage-4 UI: trading wallet page (deposit QR, balances, withdraw), risk settings (`RiskExecutionView` rebuilt per-user: their exposure vs agreed risk %, personal kill switch), G1-M8's real API-backed admin mode matrix.
- Stage-5 UI: billing page (Stripe portal + USDC pay). Stage-7 UI: Ultra chain manager.
- Admin area: current global pages behind `role=admin` + IP allowlist.

**Exit gate per slice:** the corresponding backend stage's flows are drivable end-to-end in the browser with no shared secrets and no hard-coded data (this also retires the workspace's remaining mocked copy).

### Stage 7 — Ultra dynamic chains (SaaS Phase 5)
*Strictly last: the chain-registry refactor touches audit-hardened code everywhere, and the audit's "no new chains" scope rule expires only when the checklist's engine work is closed. The green suite from Stage 0 is the safety net.*

- `chains` registry table (seed the 3 built-ins); `Chain` union → registry-validated string across the ~15 hard-coded sites (`types.ts`, `address.ts`, `validation.ts`, `execution.ts`, `prices.ts`, `db/wallets.ts` SQL, `trading-control.ts`, SQL CHECKs → FK). Full regression suite is the gate.
- Ultra onboarding: `POST /v1/me/chains` → Chainlist metadata + RPC liveness probe → DeFi Llama top-5 DEXes → CoinGecko platform mapping.
- Custom chains: tracking via parameterized `evm.ts`; **paper-only by default** — live requires a supported router config + platform certification, same `chain_certifications` gate as everything else.

**Exit gate:** an Ultra user adds an uncatalogued EVM chain, backfills a wallet on it, and receives feed events — with all built-in-chain regression tests green.

## 5. Decision gates

| ID | Decision | Blocks | Status |
|---|---|---|---|
| DG-1 | Solana live path: Trojan (operator-only) vs direct Jupiter signing (per-user-ready) | Stage 3 Solana certification, Stage 4 Solana live | **RESOLVED 2026-07-27: direct Jupiter signing + Jito bundles (spec in Stage 3). Trojan path retired after new-path certification** |
| DG-2 | Legal counsel on custody + autonomous trading; ToS; geo-gates | Stage 4 launch | **Open — non-negotiable** |
| DG-3 | Custody build-vs-buy: envelope+KMS in-house (decided default) vs Turnkey/Privy vendor | Stage 4 design freeze | Default decided (D11); vendor pricing check still worthwhile — verify raw-signing support for Polymarket L2 creds |
| DG-4 | Per-venue go-live: which venues get certified, in what order | Stage 3 scope | Open — pull-based on product need |

## 6. Audit-item dispositions (the alignment)

Every open checklist group, mapped to this guide:

| Checklist group | Disposition |
|---|---|
| Working rules | Absorbed into Standing Rules §3 — permanent |
| G1-M5, G1-M8, G1-M9 (mode matrix) | **Stage 0** (M8's UI lands in Stage 6) |
| F-CORE1–7, G1-C1/C2 (lifecycle) | **Stage 0**, account-parameterized |
| G5-R1–R3, R5–R7, L17 (risk) | **Stage 0**, account-parameterized |
| G7-T3/T4, green suite, artifact/key cleanup | **Stage 0** |
| L16 (Jupiter thresholds) | **Stage 0** (paper quotes depend on it) |
| F-SOL1–3, G1-S1/S2 (Solana gate) | **Stage 3** — DG-1 resolved: F-SOL2/F-SOL3 retargeted to the Jupiter+Jito path (spec in Stage 3); Trojan-specific work retired; F-SOL1/G1-S1 unchanged |
| F-RH1–6, G2-R1–13 (Robinhood live) | **Stage 3**, on demand, signer-parameterized |
| F-PM3–8, G3-P3–12 (Polymarket live) | **Stage 3**, on demand; credentials as a function of a signer; order IDs `(signalId, target_account)` |
| M14, G4-S2/S3/S5–S7 (shadow) | **Deprioritized** — internal benchmarking tool, not on the SaaS critical path; pick up opportunistically |
| G6-A2–A10 (attribution) | **Stage 2 parallel track** — non-blocking, feeds dashboards |
| G7-T1/T2/T5, F-ACC1–3 (integration/chaos/acceptance) | Distributed: core fixtures in Stage 0 CI; chaos + multi-chain acceptance before first live cohort (Stage 3/4 boundary) |
| G7-A1–A6 (quality acceptance) | Stage 0/2 as their subjects land |
| G7-A7–A9, F-ACC4 (operator KPI certification) | **Deprioritized** — single-operator goals; retained as optional platform-health metrics |
| Final Repository Gate / Definition of Done | Re-scoped: apply per **stage exit** rather than one big-bang release; the artifact/secret hygiene items land in Stage 0 |
| Scope boundary "no new chains" | Expires at Stage 0 exit; Stage 7 is where that work legitimately begins |

## 7. Verification cadence

- **Every merge:** CI — typecheck, unit tests, migration double-replay on scratch Postgres, cross-tenant attack suite (from Stage 2), lint for `NEXT_PUBLIC_` secrets.
- **Every stage exit:** integration suite against staging; the stage's exit gate demonstrated (not inferred); diff review for secrets/artifacts/unrelated changes (audit Working Rules, kept verbatim).
- **Before any live-money change:** venue certification evidence under `docs/certification/`, reviewed; canary with capped size; reconciliation-after-restart demonstrated.
- **Continuously:** nightly staging restore proves backups (D15); ingestion-health alerts prove the pipeline (already shipped, G0-H).

## 8. Document map

| Doc | Role after this guide |
|---|---|
| `docs/plans/BUILDER-GUIDE.md` (this) | **The build order.** Start here. |
| `AUDIT-FIX-CHECKLIST.md` | **The execution tracker.** Rewritten 2026-08-04 as stage-ordered numbered tasks (`S0-1`, `S1-2`, …) covering Stages 0–7. Check items off there. |
| `docs/plans/audit-history.md` | Archived item-level spec + evidence log for every audit ID referenced here (`F-CORE7`, `G5-R3`, …). Read-only. |
| `docs/plans/saas-conversion-plan.md` | Detailed design of the SaaS phases (schemas, routes, packages) |
| `docs/plans/production-decisions.md` | D1–D18 rationale + revisit triggers |
