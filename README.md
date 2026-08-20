# WAKE

**Multi-chain copy trading, without custody.** A user picks a trader's wallet — one they already follow, or one WAKE suggests — and from that point on, when that wallet buys they buy, and when it sells they sell. Position sizes scale to the user's own balance and risk settings, never one-for-one.

Supported venues: **Solana** (Jupiter + Jito), **Polymarket** (CLOB V2 on Polygon), **Robinhood Chain** (Uniswap V3).

> *The repository is named `SWAT` because the codebase predates the product name. `WAKE` is the product; they are the same thing.*

We call a followed wallet a **master**, and a user's replicated trade a **mirror**.

---

## Current direction and state

**Read this before assuming what works.** Detail lives in [`docs/PRD.md`](./docs/PRD.md) §0.

WAKE used to trade on *cluster consensus* — group correlated wallets, wait for several to buy the same token, then copy. That model was retired in [ADR-0005](./docs/adr/0005-single-master-mirroring.md): the clustering criterion and the trade signal were the same predicate at two time scales, so the signal largely restated its own grouping rule, and co-movement among wallets grouped *for* co-moving is evidence of shared control rather than a shared fact. The four cluster detectors still run, but for **discovery and alerting only** — they no longer trigger trades.

| Area | State |
|------|-------|
| Ingestion across three chains | Working |
| Per-master signal, proportional exits, position ledger | Working |
| Auth, sessions, multi-tenant schema | Built and tested |
| Fan-out to multiple users | Not yet — blocked on the per-chain queue split |
| Frontend for end users | **Not built.** `apps/web` is a single-operator mockup |
| Withdrawal | Not built |

**Two things that will trip you up.** Solana execution still defaults to the third-party **Trojan** bot, because the better Jupiter+Jito path is built but not yet certified. And the compiled `packages/*/dist` may lag `src` — run `pnpm build` if an import does not resolve.

**Safety defaults are deliberate:** `TRADING_MODE=paper` and `AUTO_EXECUTE=false`. A chain only executes live when it is both listed in `LIVE_ENABLED_CHAINS` *and* has a current reviewed row in `chain_certifications`. Failing either silently downgrades to paper. Do not work around this.

## Documentation map

| Document | What it is for |
|----------|----------------|
| [`docs/PRD.md`](./docs/PRD.md) | What we are building and for whom, with a status marker on every requirement |
| [`docs/adr/`](./docs/adr/) | Why the big decisions were made, and what was rejected |
| [`AUDIT-FIX-CHECKLIST.md`](./AUDIT-FIX-CHECKLIST.md) | The item-by-item work list. The project's memory — every fix and finding is recorded here |
| [`docs/agents/continue-build.md`](./docs/agents/continue-build.md) | Handoff brief: constraints, decisions already made, and the build loop every contributor follows |
| [`CLAUDE.md`](./CLAUDE.md) | Repo conventions and the invariants that bite |

---

## Architecture

SWAT is a **monorepo of microservices** that work together to form a multi-chain intelligence → execution pipeline:

```
┌─────────────┐
│   Indexer   │  Ingests wallet transactions from Helius RPC (Solana),
│             │  viem RPC logs (EVM/Robinhood), and Data API (Polymarket)
│             │  - Backfills tx history (swaps + native transfers)
│             │  - Enrich with USD prices (DexScreener/Jupiter/CoinGecko)
│             │  - Publishes swap events to Redis (standardized schema)
└──────┬──────┘
       │
       ├──────────────────────────────────────────────┐
       │                                              │
       ▼                                              ▼
┌─────────────┐                              ┌──────────────┐
│   Scorer    │  Nightly batch jobs          │ Signal Engine│
│             │  - Compute wallet metrics    │              │
│             │  - Assign scores + tiers     │ Listens to Redis,
│             │  - Generate clusters         │ detects patterns:
│             │  - Mark-to-market P&L        │ - Snipe (3+ buys in 5m)
└─────────────┘                              │ - Accumulation
                                             │ - Rotation
                                             │ - Exit
                                             └──────┬───────┘
                                                    │
                        ┌───────────────────────────┴───────────────┐
                        │                                           │
                        ▼                                           ▼
                 ┌──────────────┐                          ┌───────────────┐
                 │ Alert Service│                          │Trade Executor │
                 │              │                          │               │
                 │ Sends rich   │                          │ Paper / Live  │
                 │ Telegram     │                          │ - Solana: Trojan
                 │ alerts with  │                          │ - Polymarket: CLOB
                 │ chain-spec   │                          │ - Robinhood: UniV3
                 │ details      │                          └───────────────┘
                 └──────────────┘
```

### Services

| Service | Purpose | Key Features |
|---------|---------|--------------|
| **`apps/indexer`** | Transaction ingestion | Multi-chain polling + webhooks, Polymarket Data API parser, EVM L2 logs filter, USD/metadata enrichment |
| **`apps/scorer`** | Wallet performance scoring | Composite score (win rate, ROI, early-entry, consistency), clustering (funding + behavioral), mark-to-market P&L |
| **`apps/signal-engine`** | Pattern detection | 4 patterns (snipe/accumulation/rotation/exit), safety checks (mint/freeze/EVM ownership/liquidity), deduplication |
| **`apps/trade-executor`** | Trade execution | Paper-trade logging, Trojan integration, Robinhood Uniswap V3 swapper (viem), Polymarket CLOB V2 order placer, circuit breaker |
| **`apps/alert-service`** | Telegram notifications | Rich execution-ready alerts with chain-specific details, token safety, cluster ROI, suggested entry |
| **`apps/api`** | REST API | Wallet CRUD (chain-aware), signal/cluster/trade endpoints, discovery triggers, stats |
| **`apps/web`** | Web Dashboard | Interactive UI for wallet management (network selection), cluster exploration, discovery triggers, and signal monitoring |
| **`packages/db`** | Database layer | PostgreSQL schema (14 migrations, auto-prefixed addresses/mints) + query helpers |
| **`packages/shared`** | Shared utilities | Types, scoring, validation, multi-chain price fetchers |

---

## Prerequisites

- **Node.js 22+** for the monorepo; **Node.js 24+** is required for Polymarket live execution
  by `@polymarket/client` (run `node -v`)
- **pnpm 9+** (`npm install -g pnpm`)
- **Docker** (for PostgreSQL + Redis)

---

## Quick Start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start infrastructure

```bash
docker-compose up -d postgres redis
```

### 3. Configure environment

```bash
cp .env.example .env
```

**Edit `.env` and set at minimum:**

| Variable | Required? | Purpose |
|----------|-----------|---------|
| `HELIUS_API_KEY` | ✅ **Required** | Transaction data (get free tier at [helius.dev](https://helius.dev)) |
| `TELEGRAM_BOT_TOKEN` | Required for alerts | Alert delivery (get from [@BotFather](https://t.me/BotFather)) |
| `TELEGRAM_CHAT_ID` | Required for alerts | Your chat ID (message [@userinfobot](https://t.me/userinfobot)) |
| `API_KEY` | Required in production | Auth for API routes; replace the local `swat-dev-key` value |
| `TRADING_MODE` | Optional | Exact `off`, `paper`, `live`, or `live+shadow`; defaults to `paper` |
| `AUTO_EXECUTE` | Optional | `false` (default) — keep disabled until validated |

See [`.env.example`](./.env.example) for the full reference.

### 4. Run migrations

```bash
pnpm db:migrate
```

This creates the PostgreSQL schema (wallets, transactions, signals, clusters, etc.).

### 5. Start services

**Run all services in parallel** (separate terminals or tmux): 

```bash
pnpm dev              #Start all services at once
pnpm dev:api          # REST API on :3001
pnpm dev:indexer      # Backfill worker + webhook server
pnpm dev:scorer       # Nightly scoring + clustering (runs at 02:00 UTC, or set RUN_ON_STARTUP=true)
pnpm dev:signals      # Pattern detection (polls every 15s)
pnpm dev:alerts       # Telegram alert sender
pnpm dev:trade        # Trade executor (paper mode by default)
pnpm dev:web          # Dashboard on :3000
```

**Or use a process manager** like [PM2](https://pm2.keymetrics.io/) or [concurrently](https://www.npmjs.com/package/concurrently).

---

## Web Interface

Once the services are running, access the **web dashboard** at [http://localhost:3000](http://localhost:3000).

### Available Pages

| Page | URL | Features |
|------|-----|----------|
| **Dashboard** | `/` | Live stats (wallets, clusters, signals), recent signal feed |
| **Signals** | `/signals` | All detected signals with pattern type, confidence, score |
| **Wallets** | `/wallets` | Add wallets (single or bulk), view tracked wallets with tiers/scores |
| **Clusters** | `/clusters` | View all clusters, expand to see members |
| **Setup** | `/setup` | Trigger discovery, bootstrap checklist |

The web UI covers the **entire bootstrap workflow** — no terminal commands required. API endpoints are still available for automation/scripting.

> **These pages are the operator console, not the product.** They have no login and authenticate with a single shared key. They are being moved behind an admin-only route group; the end-user application is built separately (see `AUDIT-FIX-CHECKLIST.md` §9). `/clusters` will not exist in the user-facing app at all, since cluster detection is discovery-only under ADR-0005.

---

## Bootstrapping: finding candidate masters

A fresh install has no wallets, so there is nothing to copy and nothing to suggest. This guide seeds it.

Note what changed under ADR-0005: this workflow is now **discovery** — it populates the pool of candidate master wallets and scores them. The clustering in Step 2 still runs, but its output feeds suggestions and an "this wallet may not be an independent actor" warning, **not** trade signals. Copy trades come from a single master's own trade.

### Step 1: Bootstrap a "Starter Pack" of profitable wallets

SWAT comes with a standalone tool to automatically mine profitable wallets from recent on-chain activity. This script queries DexScreener to locate high-volume, newly-launched tokens and uses Helius RPC to isolate snipers, multi-wallet parent operators, and graduates.

**1. Generate the wallet starter pack:**
```bash
node --env-file=.env --import tsx discover-starter-pack.ts
```
This scans Solana targets back to a verified launch boundary and outputs matched wallets to `wallet-starter-pack.json`. Signature caps are configurable in `.env`; a token is skipped rather than analyzed from a false newest-only "launch" window.

**2. Ingest and enqueue the wallets:**
```bash
node --env-file=.env --import tsx apps/scorer/_ingest_wallets.ts
```
This validates every entry, preserves explicit chain identity, loads the wallets into PostgreSQL, and enqueues normalized backfill jobs. `STARTER_PACK_PATH` can override the root file location.

---

### Step 2: Run the scoring batch


Clustering requires scored wallets. The scorer runs **nightly at 02:00 UTC**, or you can trigger it manually:

**Via Web UI:**
1. Visit [http://localhost:3000/setup](http://localhost:3000/setup)
2. Follow the **"Step 2: Run Scorer Batch"** instructions
3. Set `RUN_ON_STARTUP=true` in `.env` and restart `pnpm dev:scorer`

<details>
<summary><strong>What the scorer does</strong></summary>

1. Compute metrics (win rate, ROI, early-entry, consistency) per wallet
2. Assign composite scores + tiers (elite/pro/promising/speculative)
3. **Generate funding clusters** — wallets funded by the same source get grouped
4. **Generate behavioral clusters** — wallets that buy the same tokens within 5min get grouped
</details>

**Verify clusters were created:**
- **Web UI:** Visit [http://localhost:3000/clusters](http://localhost:3000/clusters)
- **API:** `curl -H "X-Api-Key: swat-dev-key" http://localhost:3001/v1/clusters`

If you see no clusters, your seed wallets either:
- Haven't traded recently enough for behavioral clustering
- Don't have common funders for funding clustering
- **Solution:** Add more wallets or use discovery (Step 3)

### Step 3: Expand via discovery

Auto-discover wallets from a profitable token's early buyers (top 50 within 10 min of launch, >0.5 SOL invested).

**Via Web UI:**
1. Visit [http://localhost:3000/setup](http://localhost:3000/setup)
2. Scroll to **"Step 3: Discover Wallets from Token"**
3. Paste a token mint address and click **"Discover Wallets"**
4. Wait for confirmation — discovered wallets are backfilled automatically

<details>
<summary><strong>Via API (click to expand)</strong></summary>

```bash
curl -X POST http://localhost:3001/v1/discovery/from-token \
  -H "X-Api-Key: swat-dev-key" \
  -H "Content-Type: application/json" \
  -d '{"tokenMint": "TokenMintAddress111111111111111111111111111"}'
```
</details>

After discovery completes, **re-run the scorer** (Step 2) to cluster the new wallets.

### Step 4: Monitor for signals

The signal-engine polls every **15 seconds** and detects 4 patterns:

- **Snipe:** 3+ cluster wallets buy the same token within 5 minutes
- **Accumulation:** Cluster buys the same token across 3+ days with $50k+ volume
- **Rotation:** Cluster sells token A and buys token B within 1 hour
- **Exit:** 50%+ of cluster sells >50% of position within 1 hour

**View signals:**
- **Web UI:** [http://localhost:3000](http://localhost:3000) (Dashboard) or [http://localhost:3000/signals](http://localhost:3000/signals)
- **API:** `curl -H "X-Api-Key: swat-dev-key" http://localhost:3001/v1/signals`
- **Telegram:** Signals with score ≥ 70 auto-send to your configured chat

**When a pattern fires:**
1. Safety checks run (mint authority, freeze authority, top-holder %, liquidity)
2. Signal inserted into DB with score + confidence
3. Alert queued to Telegram (if score ≥ `MIN_SIGNAL_SCORE`, default 70)
4. Trade queued (if `AUTO_EXECUTE=true`, score ≥ `AUTO_EXECUTE_MIN_SCORE` (default 85), and safety passes)

---

## Verification Checklist

| Check | How to Verify | Expected Output |
|-------|---------------|-----------------|
| **PostgreSQL up** | `docker ps \| grep postgres` | Container running |
| **Redis up** | `docker ps \| grep redis` | Container running |
| **Migrations ran** | `docker exec -it swat-postgres-1 psql -U swat -d swat -c '\dt'` | Lists ~10 tables |
| **Web UI accessible** | Visit [http://localhost:3000](http://localhost:3000) | Dashboard loads |
| **Wallets ingested** | [/wallets](http://localhost:3000/wallets) or `curl -H "X-Api-Key: swat-dev-key" localhost:3001/v1/wallets` | Wallet list visible |
| **Clusters exist** | [/clusters](http://localhost:3000/clusters) or `curl -H "X-Api-Key: swat-dev-key" localhost:3001/v1/clusters` | At least 1 cluster |
| **Scorer ran** | Check scorer logs | `"Scored N wallets"`, `"Batch complete"` |
| **Signal-engine listening** | Check signal-engine logs | `[signal-engine] service running` |
| **Telegram configured** | Check alert-service logs | No auth errors |

---

## Troubleshooting

### No signals firing

**Symptom:** Signal-engine runs but no signals appear on the dashboard or `/v1/signals` returns empty.

**Causes & fixes:**

1. **No clusters exist** → Run the scorer batch, verify [/clusters](http://localhost:3000/clusters) shows at least 1 cluster
2. **Cluster wallets not trading** → Wait for live activity or backfill more active wallets
3. **`MIN_SIGNAL_SCORE` too high** → Lower it in `.env` (default 70)
4. **Clock skew** → Patterns use `NOW() - INTERVAL` — ensure system time is correct

### Indexer backfill fails

**Symptom:** `HELIUS_API_KEY is not set` or `RPC failed: 401`.

**Fix:** Set valid `HELIUS_API_KEY` in `.env` (get free tier at [helius.dev](https://helius.dev)).

### Telegram alerts not sending

**Symptom:** Signals in DB but no messages.

**Fix:** 
1. Verify `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are correct
2. Check alert-service logs for HTTP 401/404 errors
3. Test bot manually: `curl https://api.telegram.org/bot<TOKEN>/getMe`

### Scorer says "No wallets to score"

**Symptom:** Scorer runs but scores 0 wallets.

**Fix:** Ensure wallets have `status = 'active'` (check `SELECT * FROM wallets;` in psql). Paused/blacklisted wallets are skipped.

---

## Development

### Run tests

```bash
pnpm test              # All tests (865+ across db, shared, trade-executor, signal-engine)
pnpm typecheck         # TypeScript validation
pnpm build             # Compile all packages
```

### Database access

```bash
# Connect to PostgreSQL
docker exec -it swat-postgres-1 psql -U swat -d swat

# Useful queries
SELECT COUNT(*) FROM wallets;
SELECT COUNT(*) FROM transactions;
SELECT COUNT(*) FROM cluster_memberships;
SELECT * FROM signals ORDER BY created_at DESC LIMIT 5;
```

### Reset database

```bash
docker-compose down -v      # Deletes volumes
docker-compose up -d        # Recreates
pnpm db:migrate             # Re-run migrations
```

---

## Production Deployment

There is no deployment runbook in this repository yet. Deploying means: install
Node (see Prerequisites), bring up PostgreSQL and Redis (`docker-compose.yml`),
run `pnpm db:migrate`, supervise each service under your process manager of
choice, and register the Helius webhook against the indexer's `WEBHOOK_PORT`.
Copy `.env.example` to `.env` first — it is the authoritative variable list.

---

## Environment Variables Reference

The versioned [`.env.example`](./.env.example) is the authoritative list of runtime names, defaults, service ownership, and optional provider credentials. Copy it to `.env`; do not maintain a second variable list.

Execution mode precedence is database `execution_config`, then `TRADING_MODE_SOLANA`, `TRADING_MODE_POLYGON`, or `TRADING_MODE_ROBINHOOD_CHAIN`, then global `TRADING_MODE`, then `paper`. Values are exact and case-sensitive. A requested `live` or `live+shadow` mode remains effectively `paper` until the chain is in `LIVE_ENABLED_CHAINS` and has a current reviewed record in `chain_certifications`. `AUTO_EXECUTE` is a separate queueing switch and does not bypass either gate.

---

## Tech Stack

- **Runtime:** Node.js 22 (ESM)
- **Language:** TypeScript 5 (strict mode)
- **Monorepo:** pnpm workspaces + Turborepo
- **Database:** PostgreSQL 16
- **Cache/Queue:** Redis 7 + BullMQ
- **API:** Fastify
- **Frontend:** Next.js 15 + React 19
- **Testing:** Vitest
- **RPC:** Helius (Solana)
- **Prices:** DexScreener, Jupiter, CoinGecko

---

## Contributing

1. Branch from `main`
2. Run `pnpm typecheck` + `pnpm test` before committing
3. Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
4. Co-author with Claude: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
5. **Follow the build loop** in [`docs/agents/continue-build.md`](./docs/agents/continue-build.md) §10: one checklist item at a time, a test where a test is meaningful, `tsc --noEmit` plus the relevant suite, then tick the box with the commit hash. Never batch items, and never tick one on a typecheck alone.

---

## License

Proprietary — not licensed for redistribution.
