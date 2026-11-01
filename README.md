# WAKE PROTOCOL

**Institutional-grade multi-chain copy trading and concentrated liquidity intelligence, without custody.**

A trader selects a master wallet — one they discover through on-chain performance metrics, early-buyer clusters, or a curated starter pack — and Wake Protocol automatically mirrors trades to their self-custodial vault with proportional sizing, slippage bounds, autonomous stop-losses, and multi-tenant risk controls.

Wake Protocol also provides an autonomous **Liquidity Pool (LP) Engine** across Solana (Meteora DLMM, Raydium CLMM) and EVM (Uniswap v3 on Robinhood Chain, Base, Arbitrum) with active TVL tracking, ladder plan generation, fee APR estimation, auto-rebalancing, and rug shields.

> *The repository was originally titled `SWAT`; `WAKE` is the production product.*

---

## Supported Venues & Chains

| Venue / Protocol | Chain | Technology | Mode |
| :--- | :--- | :--- | :--- |
| **Jupiter + Jito MEV** | Solana | Sub-second line-speed swaps via MEV bundles & Anchor PDA | Spot Copy |
| **Polymarket CLOB V2** | Polygon (PoS) | ERC-7739 Safe deposit proxy, EIP-712 gasless relay | Prediction Markets |
| **Uniswap V3** | Robinhood Chain (Arbitrum L2) | EIP-7702 & ERC-4337 delegated session execution | EVM L2 Spot Copy |
| **Meteora DLMM** | Solana | Dynamic bin liquidity ladders, fee APR scanner, auto-rebalance | Concentrated LP |
| **Raydium CLMM** | Solana | Concentrated liquidity pool scanning & series tracking | Concentrated LP |
| **Uniswap V3 CLMM** | Robinhood / Base / Arbitrum | Concentrated range orders & fee capture | Multi-chain LP |

---

## Current Platform State

Wake Protocol is fully functional across Stages 1 through 6, featuring:
- **Unified Sequential Database Pipeline**: 69 canonical PostgreSQL migrations (`001_init.sql` through `069_lp_copy_trading.sql`) applied seamlessly without segregation or profile branching.
- **Multi-Tenant User Application**: Complete Next.js 15 App Router console (27 static and dynamic routes) including user signup, login, dashboard, wallet connection, PDA vault, USDC billing, and LP execution terminal.
- **Admin Control Plane**: Protected admin portal for fund allocation monitoring (`/admin/portfolio`) and platform fee sweeps (`/admin/revenue`).
- **Cryptographic Non-Custody**: Solana Anchor PDA vault (zero server-held private withdrawal keys), Robinhood EIP-7702 session delegation, and Polymarket ERC-7739 Safe deposit proxy.
- **Rigorous Test Coverage**: **174 test files and 2,780+ passing unit & integration tests** across all 11 packages and microservices.

---

## Documentation Map

| Document | Purpose |
| :--- | :--- |
| [`DEPLOYMENT.md`](./DEPLOYMENT.md) | **Production Deployment Runbook**: VPS provisioning, resource containment, systemd units, PM2 config, Nginx SSL reverse proxy, and operational runbooks |
| [`AUDIT-FIX-CHECKLIST.md`](./AUDIT-FIX-CHECKLIST.md) | **Master Build Authority & Audit Tracker**: Historical checkpoint of all architectural fixes, invariants, and test evidence |
| [`docs/PRD.md`](./docs/PRD.md) | Product Requirements Document detailing functional specifications |
| [`docs/adr/`](./docs/adr/) | Architecture Decision Records (e.g., ADR-0005 Single-Master Mirroring, ADR-0007 Master-Attributed Inventory) |
| [`.env.example`](./.env.example) | Authoritative reference for all environment variables across all services |

---

## Repository Architecture

A pnpm workspaces + Turborepo monorepo with strict TypeScript and NodeNext ESM resolution:

```
├── apps/
│   ├── api/             # Fastify REST control plane, SIWE/SIWS wallet signatures, sessions, CSRF, admin routes
│   ├── web/             # Next.js 15 production console (27 routes: dashboard, LP views, wallets, billing)
│   ├── lp/              # LP pool scanner, ladder plan builder, auto-rebalancing monitor, rug shield
│   ├── trade-executor/  # Multi-tenant execution engine, balance checks, slippage guards, paper/live router
│   ├── signal-engine/   # High-frequency signal generator, per-master fan-out, filter gates
│   ├── indexer/         # Ingestion workers for Solana (Helius), Robinhood RPC, and Polymarket CLOB
│   ├── scorer/          # 24h rolling metrics, master wallet rankings, close-all position sweeps
│   ├── alert-service/   # Webhook alert dispatch (Discord/Telegram), pUSD peg health monitor
│   ├── discovery/       # Early-buyer wallet mining and starter-pack generator
│   └── mcp-server/      # Model Context Protocol bridge for autonomous AI trading agents
├── packages/
│   ├── db/              # Postgres client, 69 canonical SQL migrations, user credentials, query modules
│   └── shared/          # Core domain models, multi-chain address parsers, state machines, tier constants
├── deploy/              # Systemd unit templates, pgbouncer, and crontab configuration examples
├── scripts/             # Operational utilities, secret scanners, env coverage checkers
├── programs/            # Solana Anchor PDA vault smart contract
└── tests/               # Integration suites and end-to-end lifecycle fixtures
```

---

## Quickstart & Local Development

### 1. Prerequisites
- **Node.js**: v22.x LTS or v24.x LTS
- **pnpm**: v10.2+ (`corepack enable && corepack prepare pnpm@10.2.0 --activate`)
- **Docker & Docker Compose**: v2+

### 2. Setup Environment
```bash
cp .env.example .env
# Edit .env with your PostgreSQL, Redis, and RPC URLs
```

### 3. Launch PostgreSQL & Redis
```bash
docker compose up -d postgres redis
```

### 4. Run Migrations & Seed Admin
```bash
# Applies all 69 SQL migrations sequentially
pnpm db:migrate

# Seeds initial administrator account (configured in .env)
pnpm seed:admin
```

### 5. Build Packages
On low-memory servers (<= 8GB RAM), contain builds to 2 CPU cores to prevent memory exhaustion:
```bash
taskset -c 0,1 pnpm build
```

### 6. Start Services
```bash
# Start backend API (port 3001)
pnpm dev:api

# Start Next.js frontend (port 3000)
pnpm dev:web

# Or start all services in parallel
pnpm dev
```

Visit **http://localhost:3000** to view the application console.

---

## Testing & Quality Assurance

```bash
# Run all unit tests across all 11 packages (2,780+ tests)
taskset -c 0,1 pnpm test

# Run database-backed integration test suite
pnpm test:integration

# Validate TypeScript type consistency across all apps & tools
pnpm typecheck

# Check for accidental browser bundle secret exposure
pnpm check:secrets

# Validate environment variable coverage against .env.example
pnpm check:env
```

---

## Safety & Fail-Closed Defaults

Wake Protocol is built with deliberate fail-closed safety mechanisms:
- **`TRADING_MODE=paper`**: Default mode for all executions. Live trading requires explicit chain configuration in `LIVE_ENABLED_CHAINS` and an active reviewed record in `chain_certifications`.
- **`AUTO_EXECUTE=false`**: Automated execution is disabled by default until explicitly enabled by an operator.
- **Zero Custody**: Backend services never store or handle user withdrawal private keys. All funds remain in user-owned PDA vaults or smart contracts.

---

## Production Deployment

For complete instructions on deploying to Ubuntu VPS, systemd service units, PM2 ecosystems, Nginx reverse proxy with SSL, and operational runbooks, refer to **[`DEPLOYMENT.md`](./DEPLOYMENT.md)**.

---

## License

Proprietary — All rights reserved.
