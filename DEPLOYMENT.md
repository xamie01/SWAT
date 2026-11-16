# Wake Protocol — Production Deployment & Operations Guide

```
════════════════════════════════════════════════════════════════════════════════════════════════════
  WAKE PROTOCOL — CROSS-CHAIN INTELLIGENCE, COPY-TRADING & LP LIQUIDITY PLATFORM
  Production Deployment Runbook, Process Management, Architecture & Operations Manual
════════════════════════════════════════════════════════════════════════════════════════════════════
```

---

## Table of Contents

1. [System Overview & Architecture](#1-system-overview--architecture)
2. [Hardware Sizing & Resource Containment](#2-hardware-sizing--resource-containment)
3. [Prerequisites & System Provisioning](#3-prerequisites--system-provisioning)
4. [Environment Configuration Reference (`.env`)](#4-environment-configuration-reference-env)
5. [Database Migrations & Initial Seeding](#5-database-migrations--initial-seeding)
6. [Building the Monorepo Safely](#6-building-the-monorepo-safely)
7. [Process Management](#7-process-management)
   - [Method A: Systemd Services (Recommended for Bare-Metal/VPS)](#method-a-systemd-services-recommended)
   - [Method B: PM2 Process Manager](#method-b-pm2-process-manager)
8. [Reverse Proxy, SSL & WebSockets (Nginx)](#8-reverse-proxy-ssl--websockets-nginx)
9. [Non-Custodial Architecture & Security Model](#9-non-custodial-architecture--security-model)
10. [Operational Runbooks & Incident Response](#10-operational-runbooks--incident-response)
11. [Smoke Testing & Health Verification](#11-smoke-testing--health-verification)
12. [Self-Hosted CI/CD (Woodpecker CI)](#12-self-hosted-cicd-woodpecker-ci)

---

## 1. System Overview & Architecture

**Wake Protocol** is an institutional-grade, multi-tenant cross-chain intelligence and autonomous copy-trading engine spanning **Solana**, **Robinhood Chain (Arbitrum EVM L2)**, **Polymarket (Polygon)**, **Base**, **Arbitrum**, **Ethereum**, and **BSC**.

The platform also features a dedicated **Liquidity Pool (LP) Intelligence Engine** supporting concentrated liquidity (Meteora DLMM, Raydium CLMM, Uniswap v3), forward-only LP copy trading, auto-rebalancing, and rug shields.

```mermaid
flowchart TD
    subgraph Ingestion ["Ingestion Layer"]
        SOL["Solana Helius / RPC"] --> IDX["apps/indexer (Webhook/Worker)"]
        EVM["Robinhood / EVM RPCs"] --> IDX
        POLY["Polygon / Polymarket CLOB"] --> IDX
    end

    subgraph Intelligence ["Signal & LP Intelligence"]
        IDX --> REDIS[("Redis 7.4 Streams & BullMQ")]
        REDIS --> SIG["apps/signal-engine"]
        REDIS --> LP["apps/lp (Pool Scanner / Rebalancer)"]
        SIG --> SCORER["apps/scorer (Daily Metrics)"]
        SCORER --> DISC["apps/discovery (Early-Buyer Miners)"]
    end

    subgraph Execution ["Execution Engine"]
        SIG --> TRADE["apps/trade-executor"]
        LP --> TRADE
        TRADE --> JITO["Solana (Jupiter + Jito MEV Bundles)"]
        TRADE --> RH["Robinhood Chain (Uniswap v3 Router)"]
        TRADE --> CLOB["Polymarket CLOB (ERC-7739 Safe Proxy)"]
    end

    subgraph ControlPlane ["Control Plane & User Interface"]
        API["apps/api (Fastify REST, SIWE/SIWS, CSRF)"]
        WEB["apps/web (Next.js 15 Console — 27 Routes)"]
        DB[("PostgreSQL 16/17 (69 Migrations)")]
        API <--> DB
        API <--> REDIS
        WEB <--> API
    end
```

### Microservice & Monorepo Layout

| Directory | Package / Service | Role | Port / Target |
| :--- | :--- | :--- | :--- |
| `apps/web` | `@swat/web` | Next.js 15 production console (admin portal, dashboard, LP views, wallets, billing) | Port `3000` |
| `apps/api` | `@swat/api` | Fastify REST API, SIWE/SIWS auth, CSRF, admin endpoints, metrics | Port `3001` |
| `apps/lp` | `@swat/lp` | Liquidity pool scanner, ladder plan builder, auto-rebalancer, rug shield | Background Worker |
| `apps/trade-executor` | `@swat/trade-executor` | Multi-tenant trade execution, balance verification, slippage guards | Background Worker |
| `apps/signal-engine` | `@swat/signal-engine` | High-frequency signal generator, per-master fan-out, filter gates | Background Worker |
| `apps/indexer` | `@swat/indexer` | Transaction ingestors for Solana, EVM, and Polymarket CLOB orderbook | Port `3002` (webhooks) |
| `apps/scorer` | `@swat/scorer` | 24h rolling metrics, master wallet rankings, close-all position sweeps | Cron / Scheduled |
| `apps/alert-service` | `@swat/alert-service` | Webhook alert dispatch (Discord/Telegram), pUSD peg health monitor | Background Worker |
| `apps/discovery` | `@swat/discovery` | Early-buyer wallet mining and starter-pack generator | Scheduled Worker |
| `apps/mcp-server` | `@swat/mcp-server` | Model Context Protocol bridge for autonomous AI trading agents | Port `3005` |
| `packages/db` | `@swat/db` | Unified Postgres database client & 69 canonical SQL migrations | Shared Library |
| `packages/shared` | `@swat/shared` | Core types, multi-chain address parsers, state machines, tier models | Shared Library |

---

## 2. Hardware Sizing & Resource Containment

### Recommended Specifications

| Role | Minimum (Staging / Light) | Recommended (Full Production) |
| :--- | :--- | :--- |
| **CPU** | 4 vCPUs | 8+ vCPUs |
| **RAM** | 8 GB | 16 GB+ |
| **Storage** | 50 GB NVMe SSD | 150 GB+ NVMe SSD |
| **OS** | Ubuntu 22.04 LTS / 24.04 LTS | Ubuntu 24.04 LTS |

### Critical: Memory & CPU Containment

> [!CAUTION]
> On memory-constrained servers (4 vCPUs, 8GB RAM without swap), running parallel TypeScript compilations or Turborepo across 12 packages simultaneously will cause memory spikes leading to an Out-Of-Memory (OOM) kernel crash.

Always apply the following two rules on constrained nodes:

1. **Configure a 4GB Swap File**:
   ```bash
   sudo fallocate -l 4G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```
2. **Constrain Monorepo Commands to 2 Cores**:
   Prepend commands with `taskset -c 0,1` and limit Turborepo concurrency to 2:
   ```bash
   taskset -c 0,1 pnpm build
   # or
   taskset -c 0,1 turbo run build --concurrency=2
   ```

---

## 3. Prerequisites & System Provisioning

### 1. Install Base Packages
```bash
sudo apt-get update && sudo apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  build-essential \
  git \
  jq \
  nginx \
  certbot \
  python3-certbot-nginx
```

### 2. Install Node.js 22 LTS
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v # Should report v22.x.x
```

### 3. Install pnpm 10.2
```bash
sudo corepack enable
sudo corepack prepare pnpm@10.2.0 --activate
pnpm -v # Should report 10.2.0
```

### 4. Install Docker & Docker Compose
```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

---

## 4. Environment Configuration Reference (`.env`)

Copy the master template to initialize your production environment:
```bash
cp .env.example .env
chmod 600 .env
```

### Key Production Variables

```bash
# ─── Database & Cache ────────────────────────────────────────────────────────
POSTGRES_USER=swat
POSTGRES_PASSWORD=YOUR_STRONG_DB_PASSWORD
POSTGRES_DB=swat
DATABASE_URL=postgresql://swat:YOUR_STRONG_DB_PASSWORD@127.0.0.1:5432/swat
REDIS_URL=redis://127.0.0.1:6379

# ─── Network & Ports ──────────────────────────────────────────────────────────
PORT=3001
WEB_PORT=3000
WEB_BIND_HOST=0.0.0.0
WEBHOOK_PORT=3002
MCP_PORT=3005

# ─── Authentication, Domains & CORS ───────────────────────────────────────────
# In production, set these to your public domains
AUTH_DOMAIN=app.wakeprotocol.io
AUTH_URI=https://app.wakeprotocol.io
CORS_ORIGIN=https://app.wakeprotocol.io,http://localhost:3000
COOKIE_SECURE=true
NODE_ENV=production

# ─── Initial Admin Seed ───────────────────────────────────────────────────────
ADMIN_EMAIL=admin@wakeprotocol.io
ADMIN_INITIAL_PASSWORD=YOUR_ADMIN_PASSWORD_MIN_12_CHARS

# ─── Safety Gates (Fail-Closed) ──────────────────────────────────────────────
# Default is paper trading with automated execution OFF
TRADING_MODE=paper
AUTO_EXECUTE=false
LIVE_ENABLED_CHAINS=

# ─── Blockchain RPC Endpoints ─────────────────────────────────────────────────
# Solana (Helius / Triton / Jito)
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
SOLANA_RPC_URLS=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY,https://api.mainnet-beta.solana.com
JITO_BLOCK_ENGINE_URL=https://mainnet.block-engine.jito.wtf
JITO_MAX_TIP_LAMPORTS=5000000
JITO_FALLBACK_TIP_LAMPORTS=100000

# Polygon & Polymarket (Alchemy / Public RPC)
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
POLYGON_RPC_URLS=https://polygon-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY,https://1rpc.io/matic
POLYMARKET_CLOB_API_URL=https://clob.polymarket.com
POLYMARKET_RELAYER_URL=https://relayer.polymarket.com

# Robinhood Chain (EVM L2)
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com
ROBINHOOD_CHAIN_ID=4653

# EVM Extended (Base, Arbitrum, Ethereum, BSC)
BASE_RPC_URL=https://mainnet.base.org
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
ETHEREUM_RPC_URL=https://eth.llamarpc.com
BSC_RPC_URL=https://binance.llamarpc.com

# ─── Email & Notifications (Resend) ──────────────────────────────────────────
RESEND_API_KEY=re_YOUR_RESEND_API_KEY
RESEND_FROM_EMAIL=alerts@wakeprotocol.io
```

---

## 5. Database Migrations & Initial Seeding

Wake Protocol uses an idempotent, sequential SQL migration pipeline containing **69 unified migrations** from `001_init.sql` to `069_lp_copy_trading.sql`.

### 1. Launch PostgreSQL and Redis
```bash
docker compose up -d postgres redis
```

Verify containers are listening on localhost:
```bash
docker compose ps
# postgres: 127.0.0.1:5432
# redis:    127.0.0.1:6379
```

### 2. Apply All 69 Migrations
```bash
pnpm db:migrate
```
*Output will log sequential confirmation of all 69 migrations applied successfully.*

### 3. Seed Initial Administrator Account
```bash
pnpm seed:admin
```
*Creates the admin user with credentials defined by `ADMIN_EMAIL` and `ADMIN_INITIAL_PASSWORD` with `role: 'admin'` and `tier: 'ultra'`.*

---

## 6. Building the Monorepo Safely

Build all shared packages, backend microservices, and the Next.js frontend bundle with core containment:

```bash
# 1. Install dependencies
pnpm install --frozen-lockfile

# 2. Build libraries & microservices (pinned to 2 cores)
taskset -c 0,1 pnpm build

# 3. Verify TypeScript type safety
taskset -c 0,1 pnpm typecheck

# 4. Run automated test suites (2,780+ tests)
taskset -c 0,1 pnpm test
```

---

## 7. Process Management

### Method A: Systemd Services (Recommended)

The canonical definitions are the source templates under `deploy/systemd/`:

| Service | Template | Scoped environment reference | Writable state |
| --- | --- | --- | --- |
| Backend API | `swat-api.service` | `/etc/swat/api.env` | `/var/lib/swat-api` |
| Web console | `swat-web.service` | `/etc/swat/web.env` | `/var/lib/swat-web` |
| LP intelligence | `swat-lp.service` | `/etc/swat/lp.env` | `/var/lib/swat-lp` |
| Trade executor | `swat-trade-executor.service` | `/etc/swat/trade-executor.env` | `/var/lib/swat-trade-executor` |
| Billing sweep | `swat-billing-sweep.service` + `swat-billing-sweep.timer` | `/etc/swat/billing-sweep.env` | `/var/lib/swat-billing-sweep` |

Use the template names as service names, not the historical `wake-*` aliases.
Do not copy an inline root unit or disable `ProtectHome` to make a home-directory
checkout accessible. The templates run as the dedicated, non-login `swat:swat`
principal and use `/opt/swat/current`, outside `/root` and `/home`.

**Operator provisioning prerequisites (not performed or accepted by source checks):**

- Provision a reviewed immutable release under `/opt/swat/releases/<release-id>`;
  `/opt/swat/current` points to that release. Every ancestor and code/dependency
  file must be root-owned, readable/traversable by `swat`, and not writable by
  `swat`. Include the compiled entrypoints and complete reviewed runtime dependencies;
  do not install packages, build, or mutate source on service startup.
- Provision `/etc/swat` as root-owned and traversable by `swat` (for example
  `root:swat`, mode `0750`). Each service environment file is `root:swat`, mode
  `0640`, contains only that service's approved settings/least-privilege credentials,
  and stays outside the release. `EnvironmentFile` is parsed by systemd; never
  source these files as executable shell. Do not reuse a developer `.env`.
- `StateDirectory` and `RuntimeDirectory` create each service's state and runtime
  directories with mode `0700`. `ProtectSystem=strict`, `ProtectHome=true`,
  `NoNewPrivileges=true`, `PrivateTmp=true`, and `UMask=0077` remain enabled.
  Application writes must use these locations, not the immutable release.
  Logging uses journald. For Next.js only, provision `.next/cache` in the release
  as a symlink to `/var/lib/swat-web/cache` and provision that cache for `swat`;
  do not make `.next`, executable code, or the whole release writable.
- An authorized operator must separately review/install the units and prove
  code readability, scoped environment access, state/cache writes and restart
  behavior under the actual service principal. Source assertions do not prove
  installed permissions, service usability, host privilege, or operational safety.
  Do not enable trading/LP execution until its separate authority/certification
  gates are satisfied. Do not run both cron and the billing timer.

### Method B: PM2 Process Manager

The unversioned global PM2 installation and root-based ecosystem recipe are
removed. Use the canonical systemd templates above; PM2 is not an approved
alternative here. A future operator tool requires its own complete reviewed
immutable dependency/runtime inventory and credential-free acquisition. A
pnpm pin does not make global npm or Python tooling reproducible.

For Vercel, both Woodpecker definitions separate credential-free **offline**
acquisition from a minimal credential-bearing prebuilt publish step. The reviewed
producer must supply `.package27-approved/{tool,artifact}` matching
`deploy/tools/package27-deploy-artifacts.lock.json`: exact CLI `65.11.0`, complete
Node/tool dependencies and prebuilt `.vercel/output` files, SHA256 per file, and a
reviewed immutable OCI runtime digest. The checked-in lock is deliberately
`pending`; publishing fails closed until those inputs and matching CI image
pins are reviewed. No registry install, project pull or build runs with publish
credentials. Token lifetime/scope, CI isolation, tool provenance and actual
supply-chain runtime behavior remain external review gates.

Python operator installation likewise requires a complete reviewed wheel/hash
inventory and exact preprovisioned Python/pip runtime; see
`deploy/tools/package27-deploy-python-install.py`. The pending lock is not a
resolved dependency set, and no installation or offline reproducibility has
been accepted. Do not use an unversioned pip upgrade or editable server install.

---

## 8. Reverse Proxy, SSL & WebSockets (Nginx)

Configure Nginx to route traffic to the Next.js frontend (port `3000`) and the API backend (port `3001`), supporting Server-Sent Events (SSE) and WebSockets.

Create `/etc/nginx/sites-available/wakeprotocol.conf`:

```nginx
server {
    listen 80;
    server_name app.wakeprotocol.io api.wakeprotocol.io 75.119.151.184;

    # Redirect HTTP to HTTPS in production once SSL is configured
    # return 301 https://$host$request_uri;

    # Frontend Console (Next.js)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # Backend REST API
    location /v1/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Support Server-Sent Events (SSE) log streaming
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
    }
}
```

Enable the configuration and reload Nginx:
```bash
sudo ln -sf /etc/nginx/sites-available/wakeprotocol.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Obtain free SSL certificates via Let's Encrypt:
```bash
sudo certbot --nginx -d app.wakeprotocol.io -d api.wakeprotocol.io
```

---

## 9. Non-Custodial Architecture & Security Model

Wake Protocol enforces strict cryptographic non-custodial boundaries:

### 1. Solana: Keyless Anchor Program Derived Addresses (PDA)
- User deposits USDC/SOL into a dedicated PDA vault (`[b"vault", user_pubkey]`).
- The smart contract authorizes trade executions only when matched against signed risk parameters.
- **The backend server holds zero withdrawal keys.** Only the user's connected wallet can withdraw funds.

### 2. Robinhood Chain: ERC-4337 & EIP-7702 Delegation
- Users delegate limited trade authorization to a transient session key.
- Session keys have explicit spending limits, authorized router allowlists, and expiry timestamps.

### 3. Polymarket: ERC-7739 Safe Proxy
- Users sign EIP-712 orders client-side via their web3 wallet.
- Wake Protocol forwards orders to Polymarket CLOB via gasless relayer infrastructure.

---

## 10. Operational Runbooks & Incident Response

### 1. Global Emergency Kill Switch
To immediately halt all autonomous trade executions across all chains without stopping data indexing:
```bash
# Method 1: Environment variable change
sed -i 's/AUTO_EXECUTE=true/AUTO_EXECUTE=false/' .env
sudo systemctl restart wake-executor wake-lp

# Method 2: API Admin Kill Switch
curl -X POST http://127.0.0.1:3001/v1/admin/emergency-kill \
  -H "Content-Type: application/json" \
  -H "Cookie: swat_session=ADMIN_SESSION_TOKEN" \
  -d '{"reason": "Manual operator intervention"}'
```

### 2. Live SSE Activity Log Stream
Inspect real-time execution events, order fills, and ingestion health directly in terminal:
```bash
curl -N http://127.0.0.1:3001/v1/logs/stream
```

### 3. Database Cold Backup & Restore
```bash
# Backup
docker exec sp-postgres pg_dump -U swat -d swat -Fc > /root/backups/swat_$(date +%F_%T).dump

# Restore
docker exec -i sp-postgres pg_restore -U swat -d swat --clean /root/backups/swat_latest.dump
```

---

## 11. Smoke Testing & Health Verification

Once services are running, verify system health using standard probes:

```bash
# 1. API Health Probe
curl -s http://127.0.0.1:3001/v1/health | jq .
# Expected output:
# {
#   "status": "ok",
#   "service": "api",
#   "dependencies": {
#     "database": { "healthy": true },
#     "redis": { "healthy": true }
#   }
# }

# 2. Frontend HTTP Probe
curl -I http://127.0.0.1:3000/
# Expected: HTTP/1.1 200 OK

# 3. Authenticated Route Guard Probe
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/dashboard
# Expected: 307 (Redirect to /login when unauthenticated)

# 4. Admin Portfolio Route Guard Probe
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/admin/portfolio
# Expected: 307 (Redirect to /login when unauthenticated)
```

For full regression testing across the entire monorepo:
```bash
taskset -c 0,1 pnpm test
```
All 174 test files and 2,780+ unit and integration tests must pass cleanly.

---

## 12. Self-Hosted CI/CD (Woodpecker CI)

Wake Protocol uses **Woodpecker CI** for lightweight, self-hosted, container-native continuous integration directly on the server, replacing GitHub Actions with zero cloud minute limits.

### Architecture & Resource Usage
- **Server**: `woodpecker-server` (~18 MB RAM at idle) provides the Web UI and GitHub webhook listener.
- **Agent**: `woodpecker-agent` (~7 MB RAM at idle) executes pipeline steps inside isolated Docker containers.
- **Total Footprint**: Under 25 MB RAM idle.
- **Access URL**: [http://75.119.151.184:8000](http://75.119.151.184:8000)

### Configuration & Service Management
Configuration lives in `/opt/woodpecker/docker-compose.yml` and `/opt/woodpecker/.env`.

```bash
# Check status
docker compose -f /opt/woodpecker/docker-compose.yml ps

# View logs
docker compose -f /opt/woodpecker/docker-compose.yml logs -f

# Restart CI services
docker compose -f /opt/woodpecker/docker-compose.yml restart
```

### Pipeline Specification
Pipelines are defined in [`.woodpecker.yaml`](./.woodpecker.yaml). On every push or pull request to `main`, Woodpecker spins up dedicated `postgres:17-alpine` and `redis:7-alpine` service containers, executes database migrations, runs typecheck, and executes the unit and integration test suites.

