# Agent instructions

## Read first

- Read [`CLAUDE.md`](./CLAUDE.md) for repository invariants and service details.
- Read [`docs/agents/continue-build.md`](./docs/agents/continue-build.md) before substantial work; it is the current handoff, checkpoint, and build-loop authority. Preserve existing local changes.
- Read [`README.md`](./README.md) for the current WAKE product state. Under ADR-0005, cluster detectors are for discovery/alerting; copy trades originate from a single master's activity.
- Use [`AUDIT-FIX-CHECKLIST.md`](./AUDIT-FIX-CHECKLIST.md) as the execution tracker: choose the next open numbered item, read its `Done when` and linked plan docs, and tick it only after the build loop's required evidence. Use [`docs/plans/BUILDER-GUIDE.md`](./docs/plans/BUILDER-GUIDE.md) when sequencing conflicts.

## Repository shape

- This is a pnpm 10.2 + Turborepo monorepo using Node.js 22+, strict TypeScript, ESM, and NodeNext resolution. Node.js 24+ is additionally required by `@polymarket/client` for Polymarket live execution. Workspace packages are `apps/*` (services) and `packages/*` (libraries); `@swat/shared` and `@swat/db` are consumed by nearly every service.
- Runtime flow is `indexer` → Redis/BullMQ → `signal-engine` → alert/trade consumers. `api` is the Fastify control plane; `scorer` and `discovery` are scheduled workers; `web` is the Next.js operator console. `indexer` has separate webhook and worker processes; run only one with `pnpm --filter @swat/indexer dev:webhook` or `dev:worker`.
- `pattern-ml/` is a separate Python 3.11+ pipeline using DuckDB/Parquet. It never reads or writes the main SWAT Postgres database.

## Commands and verification

```bash
pnpm install
pnpm check:secrets
pnpm check:env
pnpm typecheck
pnpm test
pnpm build
```

- CI order is `pnpm db:migrate` → secret/env checks → `pnpm typecheck` → integration-test typecheck → `pnpm test` → `pnpm build` → `pnpm test:integration`. `pnpm lint` is TypeScript/Next lint; there is no configured formatter.
- Focus a workspace with `pnpm --filter @swat/<package> typecheck` or `pnpm --filter @swat/<package> test`; focus one file with `pnpm --filter @swat/db exec vitest run src/<file>.test.ts`.
- `pnpm typecheck` also checks `discover-starter-pack.ts` and `tsconfig.integration.json`. Integration tests are serial and require `INTEGRATION_DATABASE_URL` (or `DATABASE_URL`) naming a database ending in `_integration` or `_test`; the runner forces paper mode and disables auto-execution.
- In the current working environment, the build handoff prohibits `pnpm build`, `pnpm dev`, `docker-compose up`, `pnpm db:migrate`, and `pnpm test:integration`. Use focused per-package typechecks and Vitest suites; a filtered `@swat/shared` or `@swat/db` build is allowed only after changing that package when a consumer needs fresh `dist/`.
- For the normal local setup, use `cp .env.example .env`, `docker-compose up -d postgres redis`, and `pnpm db:migrate`. Services load the single root `.env` via their `tsx --env-file=../../.env` scripts; do not create per-service env files.

## Invariants that affect changes

- Every stored wallet, transaction, and token address is chain-prefixed: `solana:…`, `polygon:0x…`, or `robinhood-chain:0x…`. Use `resolveChainAddress`/`prefixChainValue` from `@swat/shared`; raw EVM values require an explicit chain. API inputs that may be unprefixed should use the async DB resolver.
- Redis pub/sub is for fire-and-forget control/events; BullMQ is for durable work. Use `REDIS_CHANNELS`, `QUEUES`, and `TRADE_QUEUES_BY_CHAIN` from `packages/shared/src/constants.ts`, never inline names. Derive both producer and worker routing with `chainFromTokenMint()` and `tradeQueueForTokenMint()`/`tradeQueueForChain()`; the old `QUEUES.trades` queue is drain-only.
- Keep database migrations in `packages/db/sql/` idempotent. `packages/db/src/migrate.ts` replays every `.sql` file in sorted order under an advisory lock; there is no applied-migrations table.
- Keep `TRADING_MODE=paper` and `AUTO_EXECUTE=false`. Live mode requires both `LIVE_ENABLED_CHAINS` and an active reviewed `chain_certifications` row with valid evidence; DB execution config and chain-specific env settings take precedence over the global mode. Never bypass these gates.
- Package manifests point `@swat/shared` and `@swat/db` at `dist/`, so stale build output can hide source changes. After changing a package export, rebuild that package before trusting a consumer; do not “fix” this with a full workspace build in the current environment.
- Use `.js` extensions on relative TypeScript imports. Register static Fastify routes before parameterized routes (for example, `/v1/signals/stats` before `/v1/signals/:id`). Keep `API_KEY` server-only; do not add it to a `NEXT_PUBLIC_*` variable.

## Python pipeline

- Set up with `cd pattern-ml && ./scripts/setup-server.sh`; test with `source .venv/bin/activate && pytest`.
- Run `pattern-ml solana-probe` before Solana choice-set assembly. Start choice-set experiments with `--max-decisions 50` and inspect screen coverage before a full run.

## Git discipline

- Inspect `git status` before editing, preserve unrelated work, use Conventional Commits, and never push unless explicitly asked. Report exactly which verification commands ran and which were skipped.
