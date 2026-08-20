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
pnpm test:integration       # DB-backed suites in tests/integration/ (see guard below)
pnpm typecheck              # tsc --noEmit across workspace + tsconfig.tools.json
pnpm build                  # compile all packages
pnpm lint                   # NOTE: just `tsc --noEmit` (+ `next lint` for web) — no formatter configured
```

Run one package's tests directly with a filter: `pnpm --filter @swat/indexer test`. Run a single test file: `pnpm --filter @swat/db exec vitest run src/pnl-math.test.ts`. Tests live beside their source as `*.test.ts`; every workspace package has real suites.

`pnpm test:integration` uses the root `vitest.integration.config.ts`, which **refuses to run** unless the database name ends in `_integration` or `_test` (reads `INTEGRATION_DATABASE_URL`, falling back to `DATABASE_URL`). It forces `TRADING_MODE=paper` / `AUTO_EXECUTE=false` and runs files serially.

End-to-end acceptance harnesses (hit real infra, not part of `pnpm test`): `pnpm acceptance:g0-d11`, `pnpm acceptance:polymarket-context` — sources in `scripts/`.

Services are ESM and load env via `tsx --env-file=../../.env`. There is one root `.env` shared by all services — not per-package. Node 22+ required; **Node 24+** for Polymarket live execution (`@polymarket/client`).

CI (`.github/workflows/ci.yml`) runs, in order: `db:migrate` → `typecheck` → `test` → `build` → `test:integration`, against ephemeral Postgres 16 + Redis 7. Match that order locally before pushing.

## Architecture

**Data flow:** `indexer` ingests txns (Helius for Solana, viem RPC logs for EVM, Data API for Polymarket) → publishes standardized swap events to Redis → `signal-engine` (`setInterval` every 15s) detects patterns among cluster wallets → inserts signals + enqueues to `swat-alerts` / the per-chain `swat-trades-*` queues → `alert-service` (Telegram) and `trade-executor` (paper/live) consume. `scorer` runs nightly via node-cron (02:00 UTC) for metrics/tiers/clusters plus mark-to-market every 5 min; `discovery` runs nightly at 02:30 UTC. `api` (Fastify) is the control plane; `web` (Next.js) is the dashboard.

**Two messaging mechanisms — don't conflate them:**
- **Redis pub/sub** for fire-and-forget control signals. Channel names live in `packages/shared/src/constants.ts` `REDIS_CHANNELS` — always reference the constant on both producer and consumer so names can't drift. Cron-driven services (`scorer`, `discovery`) also subscribe here so API endpoints like `POST /v1/clusters/:id/refresh` aren't silent no-ops.
- **BullMQ queues** for durable work. All queue names are centralized in `packages/shared/src/constants.ts` — `QUEUES` (`walletBackfill`, `tokenDiscovery`, `alerts`) and `TRADE_QUEUES_BY_CHAIN`. Reference the constant on both producer and consumer; never inline the string. Trades are **split per chain** (`swat-trades-{solana,polygon,robinhood}`) with one concurrency-1 worker each — resolve the queue with `tradeQueueForChain(chain)` or `tradeQueueForTokenMint(mint)`, never by hand. `chainFromTokenMint()` is the single definition of a job's chain and both ends use it; a producer and the executor disagreeing would put a job on a queue whose worker serves a different venue. `QUEUES.trades` (`swat-trades`) is the pre-split queue, retained only so the executor's drain worker can empty it — nothing writes there. Backfill job construction (including the dedupe `jobId`) belongs in `packages/shared/src/queues.ts` `createWalletBackfillJob` — don't hand-roll it.

**Multi-chain address model — critical invariant:** every wallet/transaction address is stored **chain-prefixed** as `${chain}:${rawAddress}` (e.g. `solana:ABC...`, `polygon:0x...`, `robinhood-chain:0x...`). `Chain` = `'solana' | 'polygon' | 'robinhood-chain'`. Never write a bare address into a prefixed column. Two helpers, different jobs:
- `resolveChainAddress()` / `prefixChainValue()` in `packages/shared/src/address.ts` — pure, synchronous. EVM-shaped values **require** an explicit chain (a bare `0x...` throws rather than defaulting); EVM addresses are lowercased, Solana addresses are case-preserved.
- `resolvePrefixedAddress()` in `packages/db/src/wallets.ts` — async; probes the `wallets` table across all prefixes for an unprefixed input, then falls back to `solana:`. Use this when accepting a raw address from an API caller.

**Live-execution gating is multi-layered** — understand all of it before touching `trade-executor` (`packages/db/src/execution-config.ts` `resolveChainMode`). A chain only executes live when **both** hold: it's listed in `LIVE_ENABLED_CHAINS` (operator intent), **and** it has an active reviewed row in `chain_certifications` pointing at evidence under `docs/certification/` with a valid sha256 (`packages/db/src/chain-certifications.ts`). Failing either silently downgrades to `paper`. Precedence for requested mode: DB `execution_config` → `TRADING_MODE_<CHAIN>` env (e.g. `TRADING_MODE_ROBINHOOD_CHAIN`) → `TRADING_MODE`. A DB row of `'*' = 'off'` is a global kill switch overriding everything. Separately, `AUTO_EXECUTE` + `AUTO_EXECUTE_MIN_SCORE` gate non-manual signals in `trade-executor`.

**Packages:**
- `packages/shared` — `Chain` and record types (`types.ts`), address/prefix helpers (`address.ts`, `validation.ts`), scoring math (`scoring.ts`), price fetchers (`prices.ts`, `jupiter.ts`), Redis/queue constants, risk config. Consumed by all services via `workspace:*`. Built output (`dist/`) is what services import, so run `pnpm --filter @swat/shared build` if a service can't resolve a new export.
- `packages/db` — all SQL lives here. Query helpers are split by domain (`wallets.ts`, `signals.ts`, `clustering-queries.ts`, `pnl-queries.ts`, `execution-config.ts`, etc.). Migrations are plain `.sql` files in `packages/db/sql/`, applied in filename sort order by `src/migrate.ts` under a Postgres advisory lock, one transaction per file. **Migrations must be idempotent** (`IF NOT EXISTS`, additive columns) because `migrate.ts` re-runs every file on every invocation — there is no applied-migrations tracking table.

## Conventions & gotchas

- **NodeNext module resolution:** relative TypeScript imports must carry a `.js` extension (`./client.js`), even from `.ts` sources.
- **Fastify route order matters:** static paths must be registered before parameterized ones. See `apps/api/src/index.ts` — `/v1/signals/stats` is registered before `/v1/signals/:id` or Fastify matches `stats` as an `:id`.
- API auth is a single `X-Api-Key` header compared against `API_KEY` with `timingSafeEqual`. Defaults to `swat-dev-key` in dev; the API throws at boot if `API_KEY` is unset when `NODE_ENV=production`.
- Ports (all env-overridable): API `3001` (`PORT`), indexer webhook `3002` (`WEBHOOK_PORT`), MCP server `3005` (`MCP_PORT`), web `3000` (`WEB_PORT`). `pnpm dev:web` goes through `scripts/run-web-dev.mjs` rather than `next dev` directly, so port/host come from env.
- `discover-starter-pack.ts` (repo root) is a standalone bootstrap tool to mine seed wallets; not part of the service graph. It's typechecked separately via `tsconfig.tools.json`.
- **`indexer` runs two processes.** `pnpm dev:indexer` starts both the webhook server (`src/webhook.ts`, `WEBHOOK_PORT` 3002) and the poller/worker (`src/index.ts`) concurrently. Use `pnpm --filter @swat/indexer dev:webhook` or `dev:worker` to run just one half when debugging. No other service is split this way.
- Commits follow Conventional Commits.
- Keep `TRADING_MODE=paper` and `AUTO_EXECUTE=false` unless live execution has been explicitly reviewed.

## Agent skills

### Issue tracker

Issues live as GitHub issues on `xamie01/SWAT`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, used verbatim: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` and one `docs/adr/` at the repo root. Neither exists yet; per `docs/agents/domain.md`, proceed silently rather than flagging or pre-creating them.
