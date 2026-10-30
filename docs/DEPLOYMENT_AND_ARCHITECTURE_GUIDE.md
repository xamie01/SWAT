# Wake Protocol (SWAT) — Master Architecture & Production Deployment Guide

```
═══════════════════════════════════════════════════════════════════════════════════════
  WAKE PROTOCOL — OPERATIONAL CROSS-CHAIN INTELLIGENCE & COPY-TRADING ENGINE
  Stage 1 through Stage 6 Comprehensive System Architecture & Deployment Runbook
═══════════════════════════════════════════════════════════════════════════════════════
```

---

## Table of Contents

1. [Executive Summary & System Vision](#1-executive-summary--system-vision)
2. [Stage-by-Stage Build Architecture (Stages 1–6)](#2-stage-by-stage-build-architecture-stages-16)
   - [Stage 1: Foundation & High-Frequency Ingestion Engine](#stage-1-foundation--high-frequency-ingestion-engine)
   - [Stage 2: Algorithmic Intelligence, Scoring & Clustering](#stage-2-algorithmic-intelligence-scoring--clustering)
   - [Stage 3: Multi-Chain Trade Execution & Circuit Breakers](#stage-3-multi-chain-trade-execution--circuit-breakers)
   - [Stage 4: Multi-Tenant Copy-Trading & Attribution Matrix](#stage-4-multi-tenant-copy-trading--attribution-matrix)
   - [Stage 5: SaaS Monetization, Crypto Billing & Security Rails](#stage-5-saas-monetization-crypto-billing--security-rails)
   - [Stage 6: Unified Console, 1-Click Web3 Wallets & Mobile Hardening](#stage-6-unified-console-1-click-web3-wallets--mobile-hardening)
3. [Deep-Dive Microservice & Monorepo Breakdown](#3-deep-dive-microservice--monorepo-breakdown)
4. [Database Architecture & 63 SQL Migrations](#4-database-architecture--63-sql-migrations)
5. [Cryptographic Security & Non-Custodial Custody Rails](#5-cryptographic-security--non-custodial-custody-rails)
   - [Solana Keyless Anchor Program Derived Address (PDA)](#solana-keyless-anchor-program-derived-address-pda)
   - [Robinhood Chain ERC-4337 & EIP-7702 Session Delegation](#robinhood-chain-erc-4337--eip-7702-session-delegation)
   - [Polymarket ERC-7739 Safe Deposit Proxy](#polymarket-erc-7739-safe-deposit-proxy)
   - [Dynamic SIWE & SIWS Authentication Flow](#dynamic-siwe--siws-authentication-flow)
6. [Hardware Sizing & Infrastructure Topology](#6-hardware-sizing--infrastructure-topology)
7. [Environment Configuration Reference (`.env`)](#7-environment-configuration-reference-env)
8. [Step-by-Step Production Deployment Runbook](#8-step-by-step-production-deployment-runbook)
   - [1. System Provisioning & Dependencies](#1-system-provisioning--dependencies)
   - [2. Database & Cache Initialization](#2-database--cache-initialization)
   - [3. Building the Monorepo Safely](#3-building-the-monorepo-safely)
   - [4. Process Management: Systemd & PM2 Configurations](#4-process-management-systemd--pm2-configurations)
   - [5. Reverse Proxy, SSL & WebSockets (Nginx / Caddy)](#5-reverse-proxy-ssl--websockets-nginx--caddy)
9. [Operational Runbooks & Incident Response](#9-operational-runbooks--incident-response)
   - [Global Emergency Off (Kill Switch)](#global-emergency-off-kill-switch)
   - [Database Backup & Cold Restore](#database-backup--cold-restore)
   - [RPC Failover & Re-indexing](#rpc-failover--re-indexing)
10. [Verification Checklists & Smoke Tests](#10-verification-checklists--smoke-tests)

---

## 1. Executive Summary & System Vision

**Wake Protocol** is an institutional-grade, multi-tenant cross-chain intelligence and autonomous copy-trading engine spanning **Solana**, **Robinhood Chain (Arbitrum EVM L2)**, and **Polymarket (Polygon)**.

Unlike typical analytics platforms that merely send delayed Telegram alerts, Wake Protocol bridges the gap between **signal detection and automated capital execution**. It ingests mempool and on-chain transactions at line speed, clusters coordinated wallet behavior (funding links, timing correlation, volume concentration), evaluates copy-trading profitability, and executes mirrored fills with sub-second latency while keeping capital in self-custodial or venue-isolated vaults.

```mermaid
flowchart LR
    subgraph Ingestion ["Ingestion Layer"]
        SOL["Solana Helius / RPC"] --> IDX["apps/indexer"]
        EVM["Robinhood EVM RPC"] --> IDX
        POLY["Polygon / Polymarket CLOB"] --> IDX
    end

    subgraph Intelligence ["Intelligence Layer"]
        IDX --> REDIS[("Redis 7.4 Streams")]
        REDIS --> SE["apps/signal-engine"]
        REDIS --> SC["apps/scorer"]
        REDIS --> DISC["apps/discovery"]
        SE --> DB[("PostgreSQL 17.4")]
        SC --> DB
    end

    subgraph Execution ["Execution Layer"]
        DB --> TE["apps/trade-executor"]
        TE --> JITO["Solana (Jito MEV Bundles)"]
        TE --> AA["Robinhood (EIP-7702 Paymaster)"]
        TE --> CLOB["Polymarket (CLOB Proxy)"]
    end

    subgraph Surfaces ["Client & Gateway"]
        API["apps/api (Fastify 5)"] --- DB
        WEB["apps/web (Next.js 15)"] --- API
    end
```

---

## 2. Stage-by-Stage Build Architecture (Stages 1–6)

### Stage 1: Foundation & High-Frequency Ingestion Engine
- **Core Objective:** Robust raw transaction ingestion without dropping blocks, database deadlock prevention, and idempotency across high-throughput chains.
- **Key Deliverables:**
  - Fast transaction deduplication in Redis (`swat:tx:dedup:<hash>`) with 24-hour expiration.
  - Multi-chain schema unification in PostgreSQL using `citext` and widened hex/base58 address columns (`character varying(128)`).
  - PostgreSQL BRIN (Block Range Indexing) on `transactions.block_time` (`036_transactions_brin.sql`) ensuring queries over hundreds of millions of rows execute in milliseconds with minimal storage overhead.
  - BullMQ resilient pipeline with exponential backoff retries for RPC rate-limit resilience.

### Stage 2: Algorithmic Intelligence, Scoring & Clustering
- **Core Objective:** Transform noisy mempool transactions into high-confidence trading intelligence.
- **Key Deliverables:**
  - **Behavioral Clustering Engine (`apps/scorer` & `packages/db/sql/003_fix_clustering.sql`):** Discovers wallet clusters sharing funding origins, simultaneous trade submissions (within 3 seconds), and identical liquidity pool routing.
  - **Wallet Composite Scoring:** Evaluates win rate, realized ROI, drawdown, and trading frequency to assign ranks: `elite`, `pro`, `tracked`.
  - **Early Buyer Discovery (`apps/discovery`):** Scans new Raydium, Pump.fun, and Uniswap pool creation blocks to identify insiders buying within the first 10 minutes with >0.5 SOL.
  - **Token Metadata & Blacklist Engine:** Automatically resolves token symbols, names, and decimals via DexScreener/RPC while ignoring stables, wrapped gas, and blacklisted spam tokens.

### Stage 3: Multi-Chain Trade Execution & Circuit Breakers
- **Core Objective:** Low-latency execution across heterogeneous architectures with hard capital protection.
- **Key Deliverables:**
  - **Solana Execution:** Direct Jito MEV block engine bundle submission with dynamic priority fees and tip auctioning to eliminate front-running and toxic sandwich attacks.
  - **Robinhood Chain Execution:** ERC-4337 Account Abstraction bundling with Paymaster 100% gas sponsorship.
  - **Polymarket Execution:** CLOB API order placement with EIP-712 order signatures and automatic token redemption on market resolution.
  - **Safety Boundaries:**
    - Per-trade max slippage caps (default 100 bps / 1.0%).
    - Per-trade size caps relative to pool liquidity (max 2% pool impact).
    - Global Emergency Kill Switch (`POST /v1/trading/emergency-off`) that immediately cancels all in-flight orders and halts execution.

### Stage 4: Multi-Tenant Copy-Trading & Attribution Matrix
- **Core Objective:** Multi-user follower execution with complete tenancy isolation and fair position sizing.
- **Key Deliverables:**
  - **Copy Trade Lifecycle (`023_copy_trade_lifecycle.sql` & `028_copy_execution_lifecycle.sql`):** Deterministic state machine (`pending` &rarr; `submitted` &rarr; `confirmed` &rarr; `failed` &rarr; `skipped`).
  - **Position Lot Attribution (`058_copy_position_lots.sql` & `061_copy_position_lot_exits.sql`):** When a master wallet sells 50% of their holdings, follower positions are proportionally reduced lot-by-lot without stranded dust.
  - **Master Follower Capacity Caps (`053_master_capacity.sql`):** Strict 50-copier limit per master wallet to prevent follower slippage and pool depletion.
  - **Stop-Loss Auto-Liquidation Engine (`034_stop_loss_triggers.sql` & `059_stop_loss_lot_identity.sql`):** Independent off-chain monitor that triggers market exits if an asset drops below user-configured drawdown thresholds.

### Stage 5: SaaS Monetization, Crypto Billing & Security Rails
- **Core Objective:** Multi-tier commercialization, non-custodial billing, and anti-theft withdrawal rails.
- **Key Deliverables:**
  - **Subscription Tier System (`063_crypto_billing.sql`):**
    - **Free:** View-only signals and telemetry.
    - **Operator ($99/mo):** 5 active copy slots, 10 concurrent positions, 50 sponsored ops/day.
    - **Ultra ($499/mo):** 50 copy slots, 100 concurrent positions, unlimited sponsored ops, private low-latency RPC lanes.
    - **Lifetime ($4,999):** Permanent Ultra tier access.
  - **USDC Crypto Invoicing:** Automatic on-chain payment intent generation and confirmation with zero chargeback risk.
  - **Secure 2FA Withdrawal Rail (`/v1/me/trading/withdraw`):** Capital withdrawals are strictly restricted to verified linked wallets and require email OTP confirmation with a 24-hour anti-theft cooldown on newly linked addresses.

### Stage 6: Unified Console, 1-Click Web3 Wallets & Mobile Hardening
- **Core Objective:** Production-ready Web3 frontend with modern UX, zero-error type safety, and real-time execution telemetry.
- **Key Deliverables:**
  - **Permanent Vector Branding:** High-resolution SVG `WakeLogo` component across all surfaces with "Wake Protocol" identity.
  - **Role-Aware Console Navigation:** Distinct operator management (`AdminNav.tsx`) and subscriber copy-trading interfaces (`SaaSNav.tsx`).
  - **1-Click Web3 Wallet Connectors (`apps/web/lib/wallets.ts`):** Direct browser extension integration (Phantom, Solflare, MetaMask, Rabby) replacing fragile manual address pasting.
  - **Dynamic SIWE / SIWS Nonces:** Solves MetaMask/Phantom "Domain Mismatch" alerts by dynamically binding challenges to the host header.
  - **Mobile Layout Optimization:** Responsive grid breakpoints (`grid-cols-1 md:grid-cols-2`), horizontal scroll viewports on data tables, and mobile hamburger navigation drawers.

---

## 3. Deep-Dive Microservice & Monorepo Breakdown

The codebase is structured as a high-performance **pnpm + Turborepo** monorepo:

```
SWAT/
├── apps/
│   ├── api/             # Fastify 5 REST API, Auth, SIWE/SIWS, Billing, Telemetry
│   ├── web/             # Next.js 15 App Router Web Console & Web3 Wallet Hub
│   ├── indexer/         # Real-time multi-chain transaction ingestion (Solana, EVM, Poly)
│   ├── signal-engine/   # Algorithmic signal generator & cluster trade correlation
│   ├── trade-executor/  # Non-custodial execution engine (Jito, EIP-7702, CLOB)
│   ├── scorer/          # Daily wallet metrics, win rates, clustering, tiering
│   ├── discovery/       # New token LP early buyer discovery daemon
│   ├── alert-service/   # Telegram, Webhook, and SSE log streaming service
│   ├── mcp-server/      # Model Context Protocol server for autonomous agents
│   └── lp/              # Liquidity pool telemetry and AMM reserves tracker
├── packages/
│   ├── db/              # Postgres client, 63 migrations, tenancy, audit logs
│   └── shared/          # Shared interfaces, math, token standards, chain constants
└── scripts/             # Health verifications, seed scripts, acceptance tests
```

---

## 4. Database Architecture & 63 SQL Migrations

The database is powered by **PostgreSQL 17.4** with `citext` and `uuid-ossp` extensions enabled.

### Key Schema Entities & Relationships

```mermaid
erDiagram
    USERS ||--o{ USER_AUTH_WALLETS : owns
    USERS ||--o{ USER_SESSIONS : establishes
    USERS ||--o{ USER_BALANCES : holds
    USERS ||--o{ USER_EXECUTION_SETTINGS : configures
    USERS ||--o{ USER_WALLET_SUBSCRIPTIONS : follows
    USERS ||--o{ COPY_POSITIONS : owns
    USERS ||--o{ CRYPTO_PAYMENTS : pays

    WALLETS ||--o{ SIGNALS : generates
    WALLETS ||--o{ WALLET_CLUSTERS : belongs_to
    SIGNALS ||--o{ TRADES : triggers
    TRADES ||--o{ COPY_EXECUTIONS : mirrors
    COPY_POSITIONS ||--o{ COPY_POSITION_LOTS : splits_into
```

### Essential Table Specifications

1. `users` (`039_users.sql`):
   - Primary identifier: UUID (`gen_random_uuid()`).
   - Fields: `email` (`citext` UNIQUE), `password_hash` (Argon2id), `role` (`user` | `admin`), `tier` (`free` | `operator` | `ultra`), `status` (`active` | `suspended` | `deleted`).
2. `user_auth_wallets` (`041_user_auth_wallets.sql`):
   - Stores cryptographically verified linked wallets for SIWE/SIWS login and withdrawal whitelisting.
   - Enforces unique binding: `UNIQUE(chain_kind, address)`.
3. `user_execution_settings` (`049_user_execution_settings.sql`):
   - Multi-tenant risk parameters: `max_position_pct`, `max_slippage_bps`, `auto_execute`, `concurrent_position_cap`, `kill_switch_active`.
4. `copy_positions` & `copy_position_lots` (`050_copy_tenancy.sql`, `058_copy_position_lots.sql`):
   - Tracks individual token allocations per user with distinct purchase cost basis, realized P&L, and token quantity.
5. `crypto_payments` (`063_crypto_billing.sql`):
   - Manages USDC subscription invoices, payment intents, detected on-chain tx hashes, and subscription tier extensions.

---

## 5. Cryptographic Security & Non-Custodial Custody Rails

Wake Protocol enforces **zero-server-custody** for primary funds:

### Solana Keyless Anchor Program Derived Address (PDA)
- **Program ID:** `6t6dRetG3Hns4vCfZaj392e9bZ6uTEEmvL37KnDWErfS`
- **Seeds:** `[b"wake_vault", user_public_key]`
- **Properties:**
  - PDA has no corresponding private key; funds can only be moved according to the Anchor program's authorized instructions.
  - Users retain sole closing authority: invoking the `close` instruction returns all rent lamports and assets directly to their signer wallet.

### Robinhood Chain ERC-4337 & EIP-7702 Session Delegation
- **Mechanism:** EIP-7702 enables an EOA (Externally Owned Account) to temporarily delegate code execution to an ERC-4337 smart contract account without migrating funds.
- **Session Scoping:**
  - Execution grant is valid for exactly 30 days.
  - Restricted strictly to trading pair swap calls with maximum slippage limits.
  - Gas fees are 100% sponsored by the Wake Protocol Paymaster (up to 50 operations/day for Operator tier; unlimited for Ultra).

### Polymarket ERC-7739 Safe Deposit Proxy
- **Mechanism:** Polymarket CLOB orders settle on Polygon. Users deposit funds into an isolated, venue-scoped Safe proxy address.
- **Safety Guarantee:** Withdrawal instructions can only deliver capital back to the verified linked wallet stored in `user_auth_wallets`.

### Dynamic SIWE & SIWS Authentication Flow

```mermaid
sequenceDiagram
    autonumber
    actor User as Trader (Browser Extension)
    participant Web as apps/web (Next.js 15)
    participant API as apps/api (Fastify 5)
    participant Redis as Redis 7.4 (Atomic Nonce)
    participant DB as PostgreSQL 17.4

    User->>Web: Clicks "Connect Phantom / MetaMask"
    Web->>User: Prompts extension approval (accounts[0] / publicKey)
    User-->>Web: Grants public address
    Web->>API: POST /v1/auth/wallet/nonce { chainKind, address } (with Origin header)
    API->>API: Derives dynamic domain & URI from Host/Origin
    API->>Redis: SET swat:siwe:<nonce> { chainKind, address, domain, uri } EX 300
    API-->>Web: Returns { nonce, message }
    Web->>User: Prompts signature popup (personal_sign / signMessage)
    User-->>Web: Confirms signature
    Web->>API: POST /v1/auth/wallet/verify { chainKind, address, message, signature }
    API->>Redis: GETDEL swat:siwe:<nonce> (Atomic replay defense)
    API->>API: Cryptographically verifies ed25519 (Solana) or secp256k1 (EVM)
    API->>DB: Links wallet in user_auth_wallets (or establishes session)
    API-->>Web: 200 OK + Sets HTTP-only swat_session cookie
    Web-->>User: Displays verified wallet & derived execution authority
```

---

## 6. Hardware Sizing & Infrastructure Topology

### Minimum Production Hardware Sizing

| Component | Minimum Specification | Recommended Production |
| :--- | :--- | :--- |
| **CPU** | 4 Cores (x86_64 or ARM64) | 8 Cores (High single-thread clock) |
| **RAM** | 8 GB ECC RAM | 16 GB - 32 GB RAM |
| **Disk** | 100 GB NVMe SSD | 500 GB Enterprise NVMe (High IOPS) |
| **Network** | 1 Gbps unmetered | 10 Gbps low-latency interface |
| **Operating System** | Ubuntu 22.04 LTS / 24.04 LTS | Debian 12 / Ubuntu 24.04 LTS |

> [!CAUTION]
> The trade executor and signal engine require high-frequency Redis polling. Do NOT run heavy Turborepo monorepo builds concurrently with live trading on a 4-core machine to prevent CPU starvation.

---

## 7. Environment Configuration Reference (`.env`)

A fully populated `.env` file must be located in `/root/SWAT/.env`:

```bash
# ==============================================================================
# ENVIRONMENT & GENERAL SETTINGS
# ==============================================================================
NODE_ENV=production
LOG_LEVEL=info
PORT=3001
API_URL=http://127.0.0.1:3001
NEXT_PUBLIC_API_URL=http://75.119.151.184:3001

# ==============================================================================
# DATABASE (PostgreSQL 17) & CACHE (Redis 7)
# ==============================================================================
DATABASE_URL=postgres://swat:swat@127.0.0.1:5432/swat
DATABASE_POOL_MIN=4
DATABASE_POOL_MAX=20
REDIS_URL=redis://127.0.0.1:6379

# ==============================================================================
# AUTHENTICATION & SECURITY
# ==============================================================================
# If running behind plain HTTP without TLS proxy, set COOKIE_SECURE=false
COOKIE_SECURE=false
SESSION_TTL_HOURS=720
AUTH_DOMAIN=75.119.151.184:3000
AUTH_URI=http://75.119.151.184:3000
ADMIN_EMAIL=admin@swat.internal
ADMIN_INITIAL_PASSWORD=Operator2026!Wake

# ==============================================================================
# MULTI-CHAIN RPC ENDPOINTS
# ==============================================================================
# Solana (Mainnet-Beta / Helius)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WSS_URL=wss://api.mainnet-beta.solana.com
JITO_BLOCK_ENGINE_URL=https://amsterdam.mainnet.block-engine.jito.wtf

# Robinhood EVM Chain (Arbitrum L2)
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com
ROBINHOOD_CHAIN_ID=4663
ROBINHOOD_PAYMASTER_URL=https://paymaster.mainnet.chain.robinhood.com

# Polygon / Polymarket
POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com
POLYGON_CHAIN_ID=137
POLYMARKET_CLOB_API=https://clob.polymarket.com

# ==============================================================================
# TRADING RISK & EXECUTION BOUNDARIES
# ==============================================================================
MAX_SLIPPAGE_BPS=100
MAX_POSITION_PCT=10
DEFAULT_MIN_ORDER_USD=15
SOLANA_MIN_GAS_RESERVE_SOL=0.05
CIRCUIT_BREAKER_MAX_DRAWDOWN_PCT=15
```

---

## 8. Step-by-Step Production Deployment Runbook

### 1. System Provisioning & Dependencies

```bash
# Update system packages
apt update && apt upgrade -y
apt install -y curl git build-essential htop ufw fail2ban

# Install Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Enable pnpm
corepack enable
corepack prepare pnpm@10.2.0 --activate

# Verify versions
node -v   # Must be v22.x
pnpm -v   # Must be v10.x
```

### 2. Database & Cache Initialization

```bash
# Run PostgreSQL 17 and Redis 7 via Docker
docker run -d --name sp-postgres --restart always \
  -e POSTGRES_USER=swat \
  -e POSTGRES_PASSWORD=swat \
  -e POSTGRES_DB=swat \
  -p 127.0.0.1:5432:5432 \
  -v /var/lib/postgresql/data:/var/lib/postgresql/data \
  postgres:17.4-alpine

docker run -d --name sp-redis --restart always \
  -p 127.0.0.1:6379:6379 \
  -v /var/lib/redis/data:/data \
  redis:7.4-alpine redis-server --appendonly yes

# Apply all 63 database migrations
cd /root/SWAT
pnpm db:migrate

# Seed the initial admin account
pnpm seed:admin
```

### 3. Building the Monorepo Safely

> [!IMPORTANT]
> To prevent memory exhaustion on hardware with &le;8GB RAM, build packages individually rather than running global concurrent builds.

```bash
cd /root/SWAT

# 1. Install workspace dependencies
pnpm install --frozen-lockfile

# 2. Compile shared and db packages
pnpm --filter @swat/shared build
pnpm --filter @swat/db build

# 3. Typecheck API & Web
./node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit
./node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit

# 4. Build Next.js 15 production bundle
cd /root/SWAT/apps/web
./node_modules/.bin/next build
```

### 4. Process Management: Systemd & PM2 Configurations

We provide production service definitions using **systemd** for automated failure recovery:

#### Fastify API Service (`/etc/systemd/system/swat-api.service`)
```ini
[Unit]
Description=Wake Protocol API Gateway
After=network.target docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/root/SWAT
ExecStart=/root/SWAT/node_modules/.bin/tsx --env-file=/root/SWAT/.env apps/api/src/index.ts
Restart=always
RestartSec=3
Environment=NODE_ENV=production
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

#### Next.js Web Console (`/etc/systemd/system/swat-web.service`)
```ini
[Unit]
Description=Wake Protocol Web Console
After=network.target swat-api.service

[Service]
Type=simple
User=root
WorkingDirectory=/root/SWAT/apps/web
ExecStart=/root/SWAT/apps/web/node_modules/.bin/next start -H 0.0.0.0 -p 3000
Restart=always
RestartSec=3
Environment=NODE_ENV=production
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

#### Trade Executor Daemon (`/etc/systemd/system/swat-executor.service`)
```ini
[Unit]
Description=Wake Protocol Cross-Chain Trade Executor
After=network.target swat-api.service

[Service]
Type=simple
User=root
WorkingDirectory=/root/SWAT
ExecStart=/root/SWAT/node_modules/.bin/tsx --env-file=/root/SWAT/.env apps/trade-executor/src/index.ts
Restart=always
RestartSec=2
Environment=NODE_ENV=production
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

#### Ingestion & Signal Engine (`/etc/systemd/system/swat-signal-engine.service`)
```ini
[Unit]
Description=Wake Protocol Ingestion & Signal Engine
After=network.target swat-api.service

[Service]
Type=simple
User=root
WorkingDirectory=/root/SWAT
ExecStart=/root/SWAT/node_modules/.bin/tsx --env-file=/root/SWAT/.env apps/signal-engine/src/index.ts
Restart=always
RestartSec=3
Environment=NODE_ENV=production
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

Enable and start all services:
```bash
systemctl daemon-reload
systemctl enable --now swat-api swat-web swat-executor swat-signal-engine
```

### 5. Reverse Proxy, SSL & WebSockets (Nginx / Caddy)

Production deployment requires TLS termination with WebSocket and SSE header forwarding:

#### Nginx Configuration (`/etc/nginx/sites-available/wake.conf`)
```nginx
server {
    listen 80;
    server_name 75.119.151.184 wakeprotocol.io;

    client_max_body_size 20M;

    # Frontend Next.js Web Application
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Backend Fastify API Gateway
    location /v1/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Disable buffering for Server-Sent Events (SSE) live logs
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
}
```

---

## 9. Operational Runbooks & Incident Response

### Global Emergency Off (Kill Switch)
In the event of market turbulence, stale oracle prices, or abnormal RPC latency:
1. **Via UI:** Click the red **"EMERGENCY OFF"** button in the top navigation bar of `AdminNav`.
2. **Via Command Line:**
   ```bash
   curl -X POST http://127.0.0.1:3001/v1/trading/emergency-off \
     -H "Content-Type: application/json" \
     -d '{"reason": "Manual operator intervention via CLI"}'
   ```
3. **Effect:** Fastify broadcasts an immediate kill event across Redis pub/sub. The Trade Executor cancels all active Jito and EVM pending bundles, ceases follower order submissions, and enters halt mode.

### Database Backup & Cold Restore
```bash
# Trigger hot snapshot backup
docker exec sp-postgres pg_dump -U swat -d swat -F c -b -v -f /tmp/swat_backup_$(date +%F).dump
docker cp sp-postgres:/tmp/swat_backup_$(date +%F).dump /root/backups/

# Restore from snapshot
docker exec -i sp-postgres pg_restore -U swat -d swat --clean --if-exists -v < /root/backups/swat_backup.dump
```

---

## 10. Verification Checklists & Smoke Tests

Execute these verification checks following any deploy:

- [ ] **Database Connectivity:** `docker exec sp-postgres pg_isready -U swat` returns accepting connections.
- [ ] **Redis Latency:** `redis-cli ping` returns `PONG` in &lt;1ms.
- [ ] **API Health Endpoint:** `curl http://127.0.0.1:3001/v1/health` reports status `ok` and healthy database, redis, and RPCs.
- [ ] **Dynamic SIWE Domain:** `curl -X POST http://127.0.0.1:3001/v1/auth/wallet/nonce -H "Origin: http://75.119.151.184:3000" -d '{"chainKind":"evm","address":"0x4337d11111111111111111111111111111114337"}'` returns matching challenge domain.
- [ ] **Web Console 200 OK:** `curl -I http://127.0.0.1:3000/` returns `HTTP/1.1 200 OK`.
- [ ] **Logo Vector Asset:** `curl -I http://127.0.0.1:3000/logo.svg` returns `image/svg+xml`.
- [ ] **Operator Login Test:** Sign in to `/login` with `admin@swat.internal` / `Operator2026!Wake` and verify clean redirect to `/admin/portfolio`.
- [ ] **Trader Vault Test:** Sign in with `trader@swat.internal` / `Trader2026!Wake` and verify `/vault` loads without errors and offers 1-click Web3 extension connection for Solana, Robinhood, and Polymarket.
