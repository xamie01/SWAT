# SWAT — Deployment Guide

> **Solana Wallet Analysis & Tracking** | Intelligence + Execution Layer

---

## Prerequisites

| Tool | Min Version | Install |
|------|-------------|---------|
| Node.js | **22+** | See below |
| pnpm | **9+** | `sudo npm install -g pnpm` |
| Docker | any | [docs.docker.com/get-docker](https://docs.docker.com/get-docker/) |

### Installing Node.js 22 (Ubuntu/Debian)

The pnpm workspace requires Node.js 22. The default Ubuntu apt repository ships v18 which is too old.

```bash
# Download the NodeSource setup script for Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x -o setup_node22.sh
sudo bash setup_node22.sh
sudo apt-get install -y nodejs

# Verify
node -v   # should print v22.x.x

# Install pnpm
sudo npm install -g pnpm
pnpm -v   # should print 9.x.x or higher
```

### Installing Docker (Ubuntu)

```bash
# Official Docker install script (recommended over apt)
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add your user to the docker group (avoids needing sudo every time)
sudo usermod -aG docker $USER
newgrp docker

# Install docker-compose
sudo apt install -y docker-compose

# Verify
docker --version
docker-compose --version
```

---

## Step 1 — Clone & Configure

```bash
git clone <your-repo-url>
cd SWAT
cp .env.example .env
```

Open `.env` and fill in the **minimum required** values:

```bash
HELIUS_API_KEY=          # Required — get from helius.dev (free tier works)
TELEGRAM_BOT_TOKEN=      # Required — get from @BotFather on Telegram
TELEGRAM_CHAT_ID=        # Required — your personal chat ID or group ID
API_KEY=some-secret-key  # Required — change from the default 'swat-dev-key'
```

> Everything else has safe defaults for local development.

---

## Step 2 — Start Infrastructure

```bash
docker-compose up -d postgres redis
```

Verify both containers are healthy:

```bash
docker-compose ps
```

You should see `postgres` and `redis` with status `Up`.

---

## Step 3 — Install & Migrate

```bash
pnpm install
pnpm db:migrate
```

This runs all SQL migrations in order:
- `001_init.sql` — base schema (wallets, tokens, transactions, signals, trades)
- `002_schema_alignment.sql` — adds enrichment columns (execution_mode, amount_sol, safety_flags)
- `003_fix_clustering.sql` — UNIQUE index on cluster names + aligns config thresholds to spec

---

## Step 4 — Wallet Seeding (How It Works)

You do **not** need to fill `WALLET_ADDRESSES` to get started. The system has three ways to bring wallets in — you only need one:

### Option A — Seed token CA (Recommended for first run)

You give SWAT a token contract address. It scans on-chain history, finds wallets that bought it **within the first 10 minutes** with 0.5+ SOL, and auto-adds them as tracked wallets.

```bash
# Run this after services are started (Step 5)
curl -X POST http://localhost:3001/v1/discovery/from-token \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{"tokenMint": "b77PRZ39rF5tWL89aARgsaCsC84K5M4Bq41mq7xpump"}'
```

### Option B — Add known wallet addresses directly


```bash
curl -X POST http://localhost:3001/v1/wallets \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{"wallets": [{"address": "WALLET_ADDRESS_HERE", "source": "manual"}]}'
```

### Option C — Pre-seed via .env (startup only)

```bash
# In .env — comma-separated, no spaces
WALLET_ADDRESSES=wallet1,wallet2,wallet3
```

The indexer reads this on startup and queues a backfill for each address automatically.

### Auto-discovery (runs nightly — no action required)

Once you have any elite/pro-tier wallets tracked, the system expands itself:
- **02:00 UTC** — scorer re-ranks all wallets, assigns tiers
- **02:30 UTC** — discovery finds wallets funded by your elites + frequent co-buyers
- Newly discovered wallets are ingested and scored on the next cycle

---

## Step 5 — Start All Services

### All services in parallel (recommended):

```bash
pnpm dev
```

### Or individually in separate terminals:

```bash
pnpm dev:api        # REST API              → http://localhost:3001
pnpm dev:indexer    # Backfill + Webhook    → port 3002
pnpm dev:signals    # Pattern detection       (polls every 15s)
pnpm dev:alerts     # Telegram delivery       (BullMQ worker)
pnpm dev:scorer     # Nightly scoring         (02:00 UTC cron)
pnpm dev:discovery  # Nightly wallet discovery (02:30 UTC cron)
pnpm dev:web        # Next.js dashboard     → http://localhost:3000
```

---

## Step 6 — Verify Everything Works

```bash
# Health check (no auth required)
curl http://localhost:3001/v1/health

# Live stats from DB
curl -H "x-api-key: your-api-key" http://localhost:3001/v1/stats

# Tracked wallets
curl -H "x-api-key: your-api-key" http://localhost:3001/v1/wallets

# Recent signals
curl -H "x-api-key: your-api-key" http://localhost:3001/v1/signals

# Dashboard
open http://localhost:3000
```

---

## Step 7 — Register Helius Webhook (Real-Time Mode)

Without this step, the system polls every 15 seconds. With it, signals fire in **< 3 seconds**.

1. Go to [helius.dev](https://helius.dev) → Dashboard → Webhooks
2. Click **Add Webhook**
3. **URL:** `https://your-domain.com/webhook/helius`
4. **Type:** Enhanced Transactions
5. **Secret:** paste your `HELIUS_WEBHOOK_SECRET` value
6. **Addresses:** add the wallet addresses you're tracking

> **Local testing:** Use `ngrok http 3002` to get a public URL pointing to your local webhook server.

---

## Production Deployment (VPS)

Recommended: Hetzner CX21 (~$6/mo) or any Ubuntu 22.04 VPS.

### 1. Server setup

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x -o setup_node22.sh
sudo bash setup_node22.sh
sudo apt-get install -y nodejs

# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
sudo apt install -y docker-compose

# pnpm
sudo npm install -g pnpm pm2
```

### 2. Clone, configure, build

```bash
git clone <your-repo>
cd SWAT
cp .env.example .env
nano .env          # Fill in all required keys

docker-compose up -d
pnpm install
pnpm db:migrate
```

### 3. Run services with PM2

```bash
pm2 start "pnpm dev:api"       --name swat-api
pm2 start "pnpm dev:indexer"   --name swat-indexer
pm2 start "pnpm dev:signals"   --name swat-signals
pm2 start "pnpm dev:alerts"    --name swat-alerts
pm2 start "pnpm dev:scorer"    --name swat-scorer
pm2 start "pnpm dev:discovery" --name swat-discovery

# Auto-restart on server reboot
pm2 startup
pm2 save
```

### 4. Reverse proxy with Caddy (auto HTTPS)

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
api.yourdomain.com {
    reverse_proxy localhost:3001
}

app.yourdomain.com {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl reload caddy
```

---

## Environment Variables Reference

| Variable | Default | Required | Used By |
|---|---|---|---|
| `DATABASE_URL` | `postgresql://swat:swat@...` | ✅ Always | All services |
| `REDIS_URL` | `redis://localhost:6379` | ✅ Always | 5 services |
| `HELIUS_API_KEY` | — | ✅ Always | Indexer backfill, Safety checks |
| `TELEGRAM_BOT_TOKEN` | — | ✅ For alerts | alert-service |
| `TELEGRAM_CHAT_ID` | — | ✅ For alerts | alert-service |
| `API_KEY` | `swat-dev-key` | ✅ Change it | API auth header |
| `HELIUS_WEBHOOK_SECRET` | — | Real-time mode | Webhook HMAC verification |
| `TROJAN_WEBHOOK_URL` | — | Live trading | trade-executor |
| `TROJAN_API_KEY` | — | Live trading | trade-executor |
| `PORT` | `3001` | Optional | api |
| `WEBHOOK_PORT` | `3002` | Optional | indexer webhook |
| `TRADING_MODE` | `paper` | Optional | trade-executor |
| `AUTO_EXECUTE` | `false` | Optional | trade-executor |
| `AUTO_EXECUTE_MIN_SCORE` | `90` | Optional | trade-executor |
| `BASE_POSITION_SOL` | `0.5` | Optional | trade-executor, alert-service |
| `MIN_SIGNAL_SCORE` | `70` | Optional | signal-engine |
| `RUN_ON_STARTUP` | `false` | Optional | scorer, discovery |
| `WALLET_ADDRESSES` | — | Optional | indexer (startup seed only) |

---

## Live Trading Checklist

> Do not enable `AUTO_EXECUTE=true` until all boxes are checked:

- [ ] Paper trading running for **2+ weeks**
- [ ] Signal win rate **> 55%**
- [ ] Safety checker blocking rate **< 30%**
- [ ] Fewer than **3 rug slippage events** in 2 weeks
- [ ] Alert-to-operator latency **< 5 seconds**
- [ ] `TROJAN_WEBHOOK_URL` tested end-to-end in paper mode
- [ ] Daily spend cap configured inside your Trojan bot settings

---

## Useful Commands

```bash
# Force scoring batch to run now (skip the 02:00 UTC wait)
RUN_ON_STARTUP=true pnpm dev:scorer

# Force discovery batch now
RUN_ON_STARTUP=true pnpm dev:discovery

# Backfill USD values for existing un-priced transactions
npx tsx apps/indexer/src/backfill-usd.ts

# Manually trigger discovery from the API
curl -X POST http://localhost:3001/v1/discovery/run \
  -H "x-api-key: your-api-key"

# PM2: tail logs for a specific service
pm2 logs swat-signals --lines 50

# PM2: check all service health
pm2 status

# PM2: restart a single service
pm2 restart swat-indexer
```
