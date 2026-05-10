# SWAT: Solana Wallet Analysis & Tracking

Monorepo scaffold for the SWAT design in `swat.md`, covering the MVP foundation:

- `apps/api` – Fastify REST API
- `apps/indexer` – wallet ingestion + backfill queue scaffold
- `apps/signal-engine` – pattern detection + signal generation scaffold
- `apps/trade-executor` – paper/live trade execution worker scaffold
- `apps/alert-service` – Telegram alert worker scaffold
- `apps/web` – Next.js dashboard scaffold
- `packages/db` – PostgreSQL SQL schema + DB helpers
- `packages/shared` – domain types, Solana validators, scoring utilities

## Prerequisites

- Node.js 20+
- pnpm
- Docker

## Quick start

```bash
cp .env.example .env
docker-compose up -d postgres redis
pnpm install
pnpm db:migrate
```

Run services individually:

```bash
pnpm dev:api
pnpm dev:indexer
pnpm dev:signals
pnpm dev:trade
pnpm dev:alerts
pnpm dev:web
```

## Useful scripts

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```
