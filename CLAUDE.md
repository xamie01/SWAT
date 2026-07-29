# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

SWAT is a multi-chain (Solana, Polygon/Polymarket, Robinhood Chain) wallet-tracking intelligence pipeline. It ingests wallet transactions, scores wallets, detects coordinated trading patterns across wallet clusters, emits signals, and optionally auto-executes trades. It's a pnpm + Turborepo monorepo of independent Node services communicating over Redis and Postgres.

## Commands

```bash
pnpm install                # install workspace deps
docker-compose up -d postgres redis   # start infra
pnpm db:migrate             # run SQL migrations (idempotent)

pnpm dev                    # run ALL services in parallel (turbo)
pnpm dev:api                # single service (also :indexer :scorer :signals :alerts :trade :web :discovery :mcp)

pnpm test                   # all vitest suites via turbo
pnpm typecheck              # tsc --noEmit across workspace
pnpm build                  # compile all packages
```

Run one package's tests/build directly with a filter, e.g. `pnpm --filter @swat/indexer test`. Run a single test file: `pnpm --filter @swat/db exec vitest run src/pnl-math.test.ts`. Only `@swat/db`, `@swat/shared`, and `@swat/indexer` have real tests; other services stub `test` with a no-op.

Services are ESM and load env via `tsx --env-file=../../.env`. There is one root `.env` shared by all services — not per-package.

## Architecture

**Data flow:** `indexer` ingests txns (Helius for Solana, viem RPC logs for EVM, Data API for Polymarket) → publishes standardized swap events to Redis → `signal-engine` (polls every 15s) detects patterns among cluster wallets → inserts signals + publishes to alert/trade channels → `alert-service` (Telegram) and `trade-executor` (paper/live) consume. `scorer` runs nightly (node-cron, 02:00 UTC) to compute wallet metrics, tiers, and regenerate clusters. `api` (Fastify) is the control plane; `web` (Next.js) is the dashboard.

**Two messaging mechanisms — don't conflate them:**
- **Redis pub/sub** for fire-and-forget control signals. Channel names live in `packages/shared/src/constants.ts` `REDIS_CHANNELS` — always reference the constant on both producer and consumer so names can't drift.
- **BullMQ queues** for durable work (backfill, trades, token discovery). Queue names are partly in `constants.ts` `QUEUES`, but some predate it and are inlined (e.g. `swat-backfill-wallet`, `swat-trades`). Grep before assuming a queue name is centralized.

**Multi-chain address model — critical invariant:** every wallet/transaction address is stored **chain-prefixed** as `${chain}:${rawAddress}` (e.g. `solana:ABC...`, `polygon:0x...`, `robinhood-chain:0x...`). `Chain` = `'solana' | 'polygon' | 'robinhood-chain'`. When accepting a raw address from an API caller, normalize with `resolvePrefixedAddress()` in `packages/db/src/wallets.ts` (it probes all prefixes and defaults to `solana:`). Never write a bare address into a prefixed column.

**Packages:**
- `packages/shared` — `Chain` and record types (`types.ts`), scoring math (`scoring.ts`), price fetchers (`prices.ts`, `jupiter.ts`), Redis/queue constants, risk config. Consumed by all services via `workspace:*`. Built output (`dist/`) is what services import, so run `pnpm --filter @swat/shared build` if a service can't resolve a new export.
- `packages/db` — all SQL lives here. Query helpers are split by domain (`wallets.ts`, `signals.ts`, `clustering-queries.ts`, `pnl-queries.ts`, etc.). Migrations are plain `.sql` files in `packages/db/sql/`, applied in filename sort order by `src/migrate.ts`. **Migrations must be idempotent** (`IF NOT EXISTS`, additive columns) because `migrate.ts` re-runs every file on every invocation — there is no applied-migrations tracking table.

## Conventions & gotchas

- **Fastify route order matters:** static paths must be registered before parameterized ones. See `api/src/index.ts` — `/v1/signals/stats` is registered before `/v1/signals/:id` or Fastify matches `stats` as an `:id`.
- API auth is a single `X-Api-Key` header checked against `API_KEY` env (default `swat-dev-key`).
- Ports: API `3001`, indexer webhook `3002`, web `3000`.
- `discover-starter-pack.ts` (repo root) is a standalone bootstrap tool to mine seed wallets; not part of the service graph.
- Node 22+ required (ESM, `--env-file`).
- Commits follow Conventional Commits.

## Agent skills

### Issue tracker

Issues live as GitHub issues on `xamie01/SWAT`, driven by the `gh` CLI (not yet installed — run `gh auth login` after installing). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, used verbatim: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` and one `docs/adr/` at the repo root. See `docs/agents/domain.md`.
