# WAKE LP Dashboard (`@swat/lp`)

Liquidity-provider operations for WAKE: discover pools on **Meteora DLMM (Solana)** and **Uniswap v3/v4 (Robinhood Chain)**, score them for risk, deploy laddered positions from named strategy presets, monitor them against price drift, rebalance only when the economics justify it, and enforce per-user risk guardrails — all under the same paper-mode and execution-certification gates as the rest of WAKE.

Built from the 40-task plan in [`WAKE LP Dashboard — Coding Build Plan (GLM 5.3 Flash).md`](./WAKE%20LP%20Dashboard%20—%20Coding%20Build%20Plan%20(GLM%205.3%20Flash).md), Tracks A through H, one tested checkpoint per track.

---

## What the product does, end to end

```
 pool scan (B) ──▶ risk filter (C) ──▶ Discover feed (H1)
                                        │
 LP wallet indexer (D) ──▶ leaderboard ──┤
                                        ▼
                       Deploy Ladder button (H5)
                                │  guardrails (G1: exposure cap)
                                ▼
                    buildPosition() entrypoint (E6)
                                │  template or custom ladder (E5, E2/E4)
                                ▼
                 position row (state: building) + execution plan
                                │
                    monitor pass (F1/F2, scheduled)
                                │  state: active / near_edge / out_of_range
                                ▼
              rebalance economic check (F3) ── only positive ──▶
              LP execution queue ──▶ rebalance executor (F4/F5)
                                │
              position close ──▶ profit banking (G2) ──▶ reserve sub-vault (G3)
```

- **Users** browse risk-assessed pools, deploy a ladder from a preset
  (`tight-spot-scalp`, `deep-bidask-accumulation`, `wide-range-dump-capture`,
  `passive-majors-auto-compound`) or custom parameters, and watch positions
  from the position manager.
- **The system** rescans pools, re-scores risk, monitors every open position
  against the current price, and queues rebalances only when the projected
  fee uplift clears impermanent loss + gas + repositioning cost.
- **Nothing broadcasts in paper mode.** The deploy returns a *plan*; the
  monitor records intent; the execution workers refuse to sign. The live path
  exists end to end behind the same `resolveChainMode` clamp the trade
  executor uses (`off` → refuse, `paper` → plan, `live` → sign-ready, plus
  `live+shadow` → treated as paper for LP).

## Repository layout

```
apps/lp/                        the service (this package)
  src/
    index.ts                    service entry: Fastify API + 4 cron passes + BullMQ workers
    auth.ts                     session-cookie + CSRF + service-key auth (mirrors apps/api)
    routes.ts                   the five Track H endpoints
    domain/
      net-lp-result.ts          THE PnL ledger function — reused by D3 and F3
    scanner/                    Track B
      types.ts                  NormalizedPool, PoolFetcher (the chain seam)
      meteora-pools.ts          Meteora DLMM REST fetcher (+ injectable binSource)
      robinhood-pools.ts        Uniswap v3/v4 fetcher (viem reader, env-configured pool list)
      active-tvl.ts             bins-near-active-bin / ticks-near-current-tick, one interface
      fee-apr.ts                realized fee APR (trailing fees ÷ TVL)
      ranking.ts                volume-to-active-liquidity sort
      scan-job.ts               wires 1–5 into one scheduled pass
    risk/                       Track C
      types.ts                  finding shapes + stable flag codes
      score.ts                  weighted combiner + gate (weights live ONLY here)
      solana-checks.ts          holder concentration, SPL mint parsing, liquidity lock
      solana-rpc.ts             raw JSON-RPC adapter (indexer's heliusRpc pattern)
      evm-checks.ts             Robinhood Chain best-effort checks
      bundled-wallets.ts        common-funding-source heuristic (pure core)
      risk-pass.ts              scores every scanned pool (wired after the scan job)
    wallets/                    Track D
      types.ts                  ObservedPosition, LpPositionReader
      solana-positions.ts       DLMM position reader (SDK behind a port)
      evm-positions.ts          Uniswap v3 position-NFT reader (port)
      pnl.ts                    series → per-position net result (reuses netLpResult)
      wallet-indexer.ts         scheduled sweep: read → snapshot → close the books
    builder/                    Track E
      ladder-plan.ts            pure rung math: bounds, weights, bin/tick snapping
      templates.ts              the four named presets → concrete ladder params
      meteora-ladder.ts         per-rung addLiquidityByStrategy steps (port)
      evm-ladder.ts             swap-then-mint steps in tick space (port)
      plan-ports.ts             plan-only ports (paper mode's "bundle")
      build-position.ts         THE entrypoint: gates → plan → persist → steps
    monitor/                    Track F
      classifier.ts             active / near_edge / out_of_range (pure)
      economic-check.ts         rebalance only if it pays for itself (pure)
      monitor-job.ts            the scheduled monitor pass
      meteora-rebalance.ts      remove → re-add step plans (port)
      evm-rebalance.ts          close → re-center → remint step plans (port)
    guardrails/                 Track G
      exposure-cap.ts           per-pool % of deployed capital (pure algebra)
      profit-bank.ts            sweep % of realized gain (pure core + port)
      reserve-vault.ts          reserve pointer validation, fail-closed
      deploy-guard.ts           implements the builder's DeployGuardPort
  WAKE LP Dashboard — …md        the build plan this code implements

packages/shared/src/
  lp-lifecycle.ts               LP_POSITION_STATES / TRANSITIONS / canTransitionLpPosition
  types.ts                      LpChain ('solana' | 'robinhood-chain')
  constants.ts                  LP_EXECUTION_QUEUES_BY_CHAIN, lpExecutionQueueForChain,
                                chainFromPoolAddress

packages/db/
  sql/059_lp_dashboard.sql      the schema (replay-safe, see below)
  src/lp-pools.ts               pool cache: upsert, discover feed, risk attach, prune
  src/lp-positions.ts           position CRUD + transitionLpPosition + exposure sums
  src/lp-guardrails.ts          per-user guardrail config (plan defaults 50/50)
  src/lp-tracked-wallets.ts     tracked wallets, snapshots, results, leaderboard query
```

## The data model (migration `059_lp_dashboard.sql`)

| Table | Role | Precedent followed |
|---|---|---|
| `lp_pools` | scanner cache; `risk_score IS NULL` = not yet assessed; partial index keeps unassessed rows out of the feed | `user_balances` (cache of an on-chain fact) |
| `lp_guardrail_configs` | per-user caps: `max_pool_allocation_pct` (default 50), `profit_bank_pct` (default 50), reserve sub-vault pointer (unprefixed, per the `047` convention) | preferences → CASCADE on user delete |
| `lp_positions` | one user ladder: strategy type, range bounds, rung JSONB, deposit, state | fund-touching → RESTRICT from users |
| `lp_position_state_history` | every transition journaled with a reason | `copy_execution_state_history` |
| `lp_tracked_wallets` | external wallets the indexer watches (chain-prefixed) | `source_trades.wallet_address` shape |
| `lp_wallet_snapshots` | raw per-position value series (the PnL input) | — |
| `lp_wallet_position_results` | closed books per position; the leaderboard aggregates ONLY this | — |

Chains are deliberately narrower than the platform: every LP `chain` CHECK
allows `('solana', 'robinhood-chain')` only — polygon is a copy-trading chain.
Pool, position, and mint columns are chain-prefixed
(`solana:…`, `robinhood-chain:0x…`); the reserve sub-vault pointer is a
user-owned account and follows the `user_*` unprefixed convention.

## The position state machine

```
building ──▶ active ⇄ near_edge ⇄ out_of_range ──▶ rebalancing ──▶ … ──▶ closed
```

Enforced **twice, on purpose**:

1. **Code** — `canTransitionLpPosition` in `@swat/shared`
   (`LP_POSITION_TRANSITIONS` is the readable source of truth).
2. **SQL** — the `enforce_lp_position_state_transition` trigger on
   `lp_positions` (cloned from the `copy_executions` trigger in `028`).

Every transition (including the initial `building`) is journaled to
`lp_position_state_history` with the reason. `transitionLpPosition` in
`packages/db/src/lp-positions.ts` is the only writer; it locks the row
`FOR UPDATE` (ownership filter rides in the locked SELECT — one round trip, no
check-then-lock race) and refuses invalid transitions *without writing*.

## How the pieces work

### Scanner (Tracks B1–B6)
`runPoolScan` iterates the configured fetchers. Each fetcher normalizes its
chain into `NormalizedPool` (chain-prefixed addresses, USD money fields,
`activeTvlUsd` + `activeTvlExact`). Active TVL comes from the shared
calculator — bins within ±10 of the active bin on Meteora, sqrt-band tick
math on Uniswap. When bin/tick context or prices are missing, the fetcher
degrades to `activeTvlUsd = tvl` with `activeTvlExact: false` (a ceiling,
never an underestimate). Fee APR is `fees ÷ TVL` per window, deliberately NOT
annualized — a two-day-old pool would print a made-up ×365 number. One
fetcher failing loses nothing: the summary reports
`failedFetchers: ['solana:meteora-dlmm']` and the other chain still lands.

### Risk filter (Tracks C1–C6)
Checks return *findings* (stable flag codes + human detail); the combiner in
`score.ts` owns all weights (mint authority 50, liquidity unlocked 40, holder
concentration 35, bundled launch 25, freeze 25, blacklist 20, pause 10;
deduplicated by flag, capped at 100). The pass runs after the scan, scores
every `risk_score IS NULL` pool, and attaches score + flags. A pool whose
checks throw stays unassessed — and therefore unlisted — until the next pass;
"we have not looked yet" is the honest state.

### Wallet indexer (Tracks D1–D5)
Each scheduled pass reads every tracked wallet through its chain's reader,
writes the observation into `lp_wallet_snapshots`, and — for positions whose
series has ≥ 2 points — closes the books into `lp_wallet_position_results`
via `netLpResult`. The series method is honest about its limits: it sees
uncollected-fee growth and inventory drift; it cannot see mid-series fee
claims or gas, so its output is a *floor* on the true net result. The
leaderboard (`GET /v1/lp/wallets/leaderboard`) aggregates the results table in
SQL — realized PnL, win rate over closed positions only, modal strategy.

### Ladder builder (Tracks E1–E6)
`buildLadderPlan` divides the range into geometric bands (equal log-widths, so
rung exposure is comparable at both ends of a wide range), weights them by
distribution, and snaps to chain granularity — bin ids on Meteora
(`id = ln(price)/ln(1+binStep)`), spaced ticks on Uniswap
(`tick = ln(price)/ln(1.0001)`, floored to spacing). Per-rung allocation =
weight × deposit. On Meteora a rung is one position (`addLiquidityByStrategy`
per rung — the SDK has no batched multi-position call); on Uniswap it is one
NFT mint, preceded by a swap step when the rung needs base tokens.

`buildPosition` runs, in order: execution-mode gate (off refuses before
anything else runs) → deploy guard (G1 exposure cap) → pool lookup in the scan
cache (a pool without a scan or price cannot anchor a ladder) → template or
custom params (both at once is an error) → plan → persist as `building` →
execution steps. Guardrail refusals return `rejectionReasons` with an empty
bundle (HTTP 403 with reasons, not a generic 500).

### Monitor + rebalancer (Tracks F1–F6)
Every `LP_POSITION_MONITOR_CRON`, the monitor prices each open position and
classifies it. The state transition happens only on change — but the
**economic gate runs every pass** for near_edge/out_of_range positions,
because fee projections move even when the label does not. A rebalance is
queued only when `evaluateRebalanceEconomics` is strictly positive, through
the chain's concurrency-1 execution queue. A refused transition (racing a
close) logs and moves on.

### Guardrails (Tracks G1–G4)
- **Exposure cap (G1)**: `(poolExposure + request) / (deployed + request) ≤
  cap%`, with the cap equation inverted to return the largest allowed top-up
  when blocked. The first deposit always passes (nothing is deployed to be a
  share of).
- **Profit banking (G2)**: on close/harvest, `bankAmount = gain × pct` —
  losses sweep nothing; 0% banking is an explicit disabled state. The sweep
  port returns a receipt; a sweep that silently no-ops is the failure mode it
  exists to prevent.
- **Reserve sub-vault (G3)**: the pointer in `lp_guardrail_configs` is
  validated against an active vault-kind execution grant. Fail-closed: an
  unvalidated address refuses the sweep loudly.
- **State machine fold-in (G4)**: guardrails are checks *inside* the deploy
  and close flows — there is no parallel lifecycle.

## Running it

Preconditions (same as the rest of WAKE): Postgres and Redis up, `.env` from
`.env.example`, Node 22+.

```bash
pnpm install
pnpm db:migrate          # applies 059_lp_dashboard.sql (replay-safe; every statement idempotent)
pnpm dev:lp              # API on :3010 + cron passes + execution workers
```

Config (all optional unless noted — see `.env.example` "LP Dashboard" block):

| Var | Default | Purpose |
|---|---|---|
| `LP_PORT` | `3010` | Fastify API port |
| `METEORA_API_URL` | `https://dlmm-api.meteora.ag` | pool scan source |
| `LP_POOL_SCAN_CRON` | `*/30 * * * *` | pool scan |
| `LP_POSITION_MONITOR_CRON` | `*/5 * * * *` | monitor pass |
| `LP_RISK_PASS_CRON` | `*/10 * * * *` | risk attach |
| `LP_WALLET_INDEX_CRON` | `*/15 * * * *` | wallet indexer |
| `LP_SCAN_MAX_PAIRS` | `200` | pairs per scan |
| `ROBINHOOD_LP_POOL_ADDRESSES` | *(empty)* | comma-separated v3/v4 pool list (operator-configured) |
| `LP_SERVICE_USER_ADDRESS` | *(empty)* | recipient used in paper plans |
| `API_KEY` | — | enables service-key auth (required in production) |
| `SOLANA_RPC_URL` / `HELIUS_API_KEY` | — | chain reads (existing WAKE vars) |
| `ROBINHOOD_RPC_URL` | — | EVM reads (existing WAKE var) |

## API (Track H)

All routes require a principal: a WAKE session cookie (browser, with CSRF
double-submit on POST) or `X-Api-Key: $API_KEY` (service; no tenant, so
`/positions` and `/deploy` reject it). Static routes register before
parameterized ones; limits are clamped server-side.

| Route | Auth | Notes |
|---|---|---|
| `GET /v1/health` | public | |
| `GET /v1/lp/discover?chain=&sort=volume\|activeTvl\|feeApr24h\|ratio&limit=&offset=` | any | `sort=ratio` applies the volume-to-active-TVL ranking post-query; unassessed pools never appear (SQL-level) |
| `GET /v1/lp/wallets/leaderboard?chain=&sort=pnl\|winRate&limit=` | any | aggregates closed-position results |
| `GET /v1/lp/positions?includeClosed=` | **user only** | each open position carries `rebalanceRecommended` (true in `near_edge`/`out_of_range`) |
| `GET /v1/lp/strategy-templates` | any | the four presets with widths/rung counts |
| `POST /v1/lp/positions/deploy` | **user only** | body: `{ chain, poolAddress, template? , custom?, depositAmount, depositAsset }`; guardrail refusals → `403 { reasons }`; validation → `400`; success → `{ positionId, mode, rungs, steps }` |

Deploy example:

```bash
curl -X POST localhost:3010/v1/lp/positions/deploy \
  -H "X-Api-Key: $API_KEY" -H "content-type: application/json" \
  -d '{"chain":"solana","poolAddress":"solana:3ucNos4…","template":"tight-spot-scalp","depositAmount":1000,"depositAsset":"solana:EPjFWd…"}'
```

(Service-key calls satisfy the auth layer, but `/deploy` and `/positions`
require a *user* session — the service principal intentionally carries no
tenant. For curl-level exploration of those routes, use a session cookie pair
from `apps/api` login: `swat_session` + `swat_csrf` with `x-csrf-token`.)

## How to test

```bash
pnpm --filter @swat/lp test          # 133 unit tests (vitest, colocated)
pnpm --filter @swat/lp typecheck     # tsc --noEmit
pnpm --filter @swat/lp build         # emit to dist/ (NodeNext ESM)
pnpm --filter @swat/db test          # 841 tests (incl. 059 migration ledger contract)
pnpm --filter @swat/shared test      # 444 tests
node scripts/check-env-coverage.mjs  # governed env vars documented
node scripts/check-public-secrets.mjs
```

What the suites cover, by design:

- **Pure cores are exhaustively tested**: net LP result (sign conventions,
  cost validation), ladder math (weight shapes, geometric bounds, bin/tick
  snapping, contiguity), classifier (edge bands, both crossings), economic
  check (approve/decline/no-uplift), exposure cap (block, cap sizing, first
  deposit), profit bank, bundled-wallet heuristic, SPL mint parsing
  (byte-exact authority layout), active TVL (below/above/straddling bands,
  unpriced → null).
- **DB modules are tested through the statement log**: `withTransaction` is
  real, so tests assert BEGIN/COMMIT, that a refused transition issues no
  UPDATE and rolls back, that history rows carry `(positionId, from, to,
  reason)`, that the ledger test contract holds for 059.
- **HTTP layer is tested with fastify `inject()`**: public vs authenticated,
  service-key constant-time check, tenant rejection of the service principal,
  chain/sort validation, limit clamping, deploy gating order (off → guard →
  validation), guardrail refusals surfaced as 403 with reasons.
- **Every fetcher/checker/reader is tested through injected ports** with
  fixtures — no test touches a real chain, database, or Redis.

Runtime smoke that already ran against compiled output (not just vitest):
every pure dist module imports under Node ESM; compiled behavior matches the
units; all 26 LP exports resolve at runtime from the `@swat/db` dist.

### Runtime-unproven (honest list)

These are implemented and typed but cannot execute in the build environment
(no Postgres, no chain RPC keys, no live-certified runtime):

- **Migration 059 has never been applied.** First `pnpm db:migrate` against a
  real database is the moment to watch.
- **Live chain reads**: the Meteora SDK bin source seam is defined but the
  SDK is intentionally not wired — `@meteora-ag/dlmm@1.9.14` cannot be
  imported at all (its ESM build re-exports anchor paths only CJS resolution
  accepts; its CJS build does not export the `DLMM` class — verified by
  probe). The REST scanner path works without it (`activeTvlExact: false`).
  The Uniswap tick-band walker is likewise a documented seam (in-range
  liquidity only for now).
- **Live execution**: the workers record paper plans and throw a explicit
  error on live jobs; the SDK-backed signing ports land behind the same
  interfaces (`MeteoraLiquidityPort`, `EvmPositionPort`, rebalance ports) at
  live certification.
- **Integration tests**: written against a migrated `INTEGRATION_DATABASE_URL`
  database; unrun here per the build handoff. `schema-guard.ts` already lists
  the lp_* tables.

## Conventions this code follows (repo invariants)

- Every stored wallet/pool/mint address is chain-prefixed
  (`resolveChainAddress`/`prefixChainValue`); user-owned account columns are
  unprefixed with a `*_chain` discriminator.
- Queue names come from `packages/shared/src/constants.ts`
  (`LP_EXECUTION_QUEUES_BY_CHAIN`, `lpExecutionQueueForChain`,
  `chainFromPoolAddress`) — never inline strings.
- `user_id` comes from the session (`forUser(request.principal.user.id)`),
  never from a payload; cross-tenant sweeps must pass `crossTenantScope(reason)`.
- Migrations replay: every statement in 059 is `IF NOT EXISTS` /
  `DROP TRIGGER IF EXISTS`-guarded; no transaction control (the runner owns it).
- `TRADING_MODE=paper`, `AUTO_EXECUTE=false`: LP execution resolves the chain
  mode through the existing `resolveChainMode` clamp and fails closed; no new
  gating logic was invented.
- Relative imports use `.js` extensions; static routes register before
  parameterized ones; `API_KEY` never reaches a `NEXT_PUBLIC_*` variable.
