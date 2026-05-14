# SWAT — Deployment Guide

> **Solana Wallet Analysis & Tracking** | Intelligence + Execution Layer

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | `nvm install 20` |
| pnpm | 9+ | `npm install -g pnpm` |
| Docker | any | [docker.com](https://docs.docker.com/get-docker/) |

---

## Step 1 — Clone & Configure

```bash
git clone <your-repo-url>
cd SWAT
cp .env.example .env
```

Open `.env` and fill in at minimum:

```bash
HELIUS_API_KEY=          # Required — get from helius.dev
TELEGRAM_BOT_TOKEN=      # Required — get from @BotFather
TELEGRAM_CHAT_ID=        # Required — your Telegram chat/group ID
API_KEY=some-secret-key  # Change from default
```

Everything else can stay at defaults for local dev.

---

## Step 2 — Start Infrastructure

```bash
sudo docker-compose up -d postgres redis
```

Verify both containers are running:

```bash
sudo docker-compose ps
```

---

## Step 3 — Install & Migrate

```bash
pnpm install
pnpm db:migrate
```

This runs all SQL migrations in order:
- `001_init.sql` — base schema
- `002_schema_alignment.sql` — enrichment fields
- `003_fix_clustering.sql` — unique indexes + config alignment

---

## Step 4 — Seed Initial Wallets

Option A — via environment variable (indexer starts and backfills automatically):

```bash
# In .env:
WALLET_ADDRESSES=wallet1address,wallet2address,wallet3address
```

Option B — via API after services are running:

```bash
curl -X POST http://localhost:3001/v1/discovery/from-token \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{"tokenMint": "YOUR_SEED_TOKEN_MINT"}'
```

---

## Step 5 — Start All Services

### Local development (all services in parallel):

```bash
turbo run dev
```

### Or start individually in separate terminals:

```bash
pnpm dev:api        # REST API         → http://localhost:3001
pnpm dev:indexer    # Backfill + Webhook listener → port 3002
pnpm dev:signals    # Pattern detection (runs every 15s)
pnpm dev:alerts     # Telegram delivery worker
pnpm dev:scorer     # Nightly scoring (02:00 UTC) — runs on startup if RUN_ON_STARTUP=true
pnpm dev:discovery  # Nightly discovery (02:30 UTC) — same flag
pnpm dev:web        # Next.js dashboard → http://localhost:3000
```

---

## Step 6 — Register Helius Webhook (Real-Time Mode)

To get < 3-second signal latency, register your server URL with Helius:

1. Go to [helius.dev](https://helius.dev) → Dashboard → Webhooks
2. Click **Add Webhook**
3. Set URL to: `https://your-domain.com/webhook/helius`
4. Type: **Enhanced Transactions**
5. Set Secret: copy your `HELIUS_WEBHOOK_SECRET` from `.env`
6. Add tracked wallet addresses

> **Local testing:** Use `ngrok http 3002` to expose your local webhook port.

---

## Step 7 — Verify Everything Works

```bash
# Health check
curl http://localhost:3001/v1/health

# Stats (should reflect real DB counts after seeding)
curl -H "x-api-key: your-api-key" http://localhost:3001/v1/stats

# Recent signals
curl -H "x-api-key: your-api-key" http://localhost:3001/v1/signals

# Dashboard
open http://localhost:3000
```

---

## Production Deployment (VPS — Hetzner CX21, ~$6/mo)

### 1. Server setup

```bash
# On your VPS (Ubuntu 22.04)
apt update && apt install -y docker.io docker-compose git curl

# Install Node + pnpm
curl -fsSL https://get.pnpm.io/install.sh | sh
source ~/.bashrc
pnpm env use --global 20
```

### 2. Clone, configure, and start

```bash
git clone <your-repo>
cd SWAT
cp .env.example .env
nano .env   # Fill in real keys

docker-compose up -d
pnpm install && pnpm db:migrate

# Run as background processes (use PM2 or systemd)
npm install -g pm2
pm2 start "pnpm dev:api"       --name swat-api
pm2 start "pnpm dev:indexer"   --name swat-indexer
pm2 start "pnpm dev:signals"   --name swat-signals
pm2 start "pnpm dev:alerts"    --name swat-alerts
pm2 start "pnpm dev:scorer"    --name swat-scorer
pm2 start "pnpm dev:discovery" --name swat-discovery
pm2 startup && pm2 save
```

### 3. Reverse proxy (Caddy — auto HTTPS)

```bash
apt install -y caddy
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
systemctl reload caddy
```

---

## Key Variables Reference

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `HELIUS_API_KEY` | — | ✅ Yes | RPC + backfill |
| `HELIUS_WEBHOOK_SECRET` | — | For live mode | Webhook HMAC verification |
| `TELEGRAM_BOT_TOKEN` | — | ✅ Yes | Alert delivery |
| `TELEGRAM_CHAT_ID` | — | ✅ Yes | Alert target |
| `API_KEY` | `swat-dev-key` | ✅ Change it | API auth |
| `TROJAN_WEBHOOK_URL` | — | Live trading | Auto-execution |
| `TROJAN_API_KEY` | — | Live trading | Trojan auth |
| `TRADING_MODE` | `paper` | — | `paper` or `live` |
| `AUTO_EXECUTE` | `false` | — | Enable auto-trades |
| `AUTO_EXECUTE_MIN_SCORE` | `90` | — | Min score for auto-trade |
| `BASE_POSITION_SOL` | `0.5` | — | Base trade size |
| `RUN_ON_STARTUP` | `false` | — | Run scorer/discovery immediately |

---

## Live Trading Checklist

> **Do not enable `AUTO_EXECUTE=true` until all of these are confirmed:**

- [ ] Paper trading running for **2+ weeks**
- [ ] Signal win rate **> 55%**
- [ ] Safety checker blocking rate **< 30%**
- [ ] Fewer than **3 rugs** slipped through safety checks
- [ ] Alert-to-operator latency **< 5 seconds**
- [ ] `TROJAN_WEBHOOK_URL` tested in paper mode first
- [ ] Daily spend cap configured in Trojan bot

---

## Useful Commands

```bash
# Run scoring batch immediately (without waiting for 02:00 UTC)
RUN_ON_STARTUP=true pnpm dev:scorer

# Backfill USD values for existing transactions
npx tsx apps/indexer/src/backfill-usd.ts

# Trigger discovery manually
curl -X POST http://localhost:3001/v1/discovery/run \
  -H "x-api-key: your-api-key"

# View recent logs (PM2)
pm2 logs swat-signals --lines 50

# Check all service status
pm2 status
```
