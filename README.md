# SWAT: Smart Wallet Analysis & Tracking

**Autonomous intelligence layer for multi-chain wallet tracking (Solana, Polymarket/Polygon, Robinhood Chain)** — tracks elite wallets, detects coordinated activity patterns, generates execution-ready signals, and (optionally) auto-executes trades via integrated executors (Trojan for Solana, Uniswap V3 for Robinhood Chain, CLOB V2 for Polymarket).

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

- **Node.js 22+** (run `node -v` — if < 22, see [`DEPLOYMENT.md`](./DEPLOYMENT.md))
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
| `TELEGRAM_BOT_TOKEN` | ✅ **Required** | Alert delivery (get from [@BotFather](https://t.me/BotFather)) |
| `TELEGRAM_CHAT_ID` | ✅ **Required** | Your chat ID (message [@userinfobot](https://t.me/userinfobot)) |
| `API_KEY` | Optional | Auth for API routes (default: `swat-dev-key`) |
| `TRADING_MODE` | Optional | `paper` (default) or `live` |
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

---

## Getting Your First Signal

Signals only fire when **cluster wallets trade together**. A fresh install starts with no wallets and no clusters, so no signals will fire. Follow this guide to bootstrap your setup with high-performance wallets:

### Step 1: Bootstrap a "Starter Pack" of profitable wallets

SWAT comes with a standalone tool to automatically mine profitable wallets from recent on-chain activity. This script queries DexScreener to locate high-volume, newly-launched tokens and uses Helius RPC to isolate snipers, multi-wallet parent operators, and graduates.

**1. Generate the wallet starter pack:**
```bash
npx tsx --env-file=.env discover-starter-pack.ts
```
This scans active targets and outputs a list of profitable wallets to `wallet-starter-pack.json`. You can edit the search terms and target limits inside the script's `CONFIG` section.

**2. Ingest and enqueue the wallets:**
```bash
cd apps/scorer
npx tsx --env-file=../../.env _ingest_wallets.ts
```
This loads all wallets from the generated starter pack into your PostgreSQL database and enqueues them for on-chain indexing.

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
4. Trade queued (if `AUTO_EXECUTE=true` and score ≥ 90 and safety passes)

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
pnpm test              # All tests (27 unit tests)
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

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for:
- Node.js 22 installation
- Docker setup
- Systemd service configuration
- Helius webhook registration
- Rate limits & scaling

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://swat:swat@localhost:5432/swat` | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `HELIUS_API_KEY` | *(required)* | Helius RPC API key |
| `HELIUS_WEBHOOK_SECRET` | *(optional)* | HMAC secret for webhook verification |
| `TELEGRAM_BOT_TOKEN` | *(required)* | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | *(required)* | Your Telegram chat/group ID |
| `API_KEY` | `swat-dev-key` | API auth key (sent as `X-Api-Key` header) |
| `PORT` | `3001` | API server port |
| `WEBHOOK_PORT` | `3002` | Indexer webhook port |
| `TRADING_MODE` | `paper` | `paper` or `live` |
| `AUTO_EXECUTE` | `false` | Enable auto-trade on high-score signals |
| `AUTO_EXECUTE_MIN_SCORE` | `90` | Minimum score for auto-execution |
| `BASE_POSITION_SOL` | `0.5` | Base trade size before tier/score multipliers |
| `MIN_SIGNAL_SCORE` | `70` | Signals below this are logged but not alerted |
| `RUN_ON_STARTUP` | `false` | Run scorer/discovery batch on service start (for testing) |
| `WALLET_ADDRESSES` | *(optional)* | Comma-separated wallets to ingest on indexer start |
| `TROJAN_WEBHOOK_URL` | *(optional)* | Trojan execution bot webhook URL |
| `TROJAN_API_KEY` | *(optional)* | Trojan API auth key |

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
4. Co-author with Claude: `Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>`

---

## License

Proprietary — not licensed for redistribution.
