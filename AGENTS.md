# Repository Guidelines

## Project Structure & Module Organization

SWAT is a pnpm/Turborepo TypeScript monorepo. Deployable services live in `apps/`: `api`, `indexer`, `scorer`, `signal-engine`, `alert-service`, `trade-executor`, `discovery`, `mcp-server`, and the Next.js dashboard in `web`. Shared types, validation, pricing, and scoring logic belong in `packages/shared`; PostgreSQL queries and migrations belong in `packages/db`. Keep tests beside their source as `*.test.ts`. Database migrations are ordered SQL files under `packages/db/sql/` and must be idempotent because every migration is replayed on each run.

## Build, Test, and Development Commands

- `pnpm install`: install all workspace dependencies (Node.js 22+; the repository pins pnpm 10.2.0).
- `docker-compose up -d postgres redis`: start required local infrastructure.
- `pnpm db:migrate`: apply the PostgreSQL schema after configuring `.env`.
- `pnpm dev`: run all services concurrently; use `pnpm dev:web`, `pnpm dev:api`, or another `dev:*` script for one service.
- `pnpm build`: compile all packages and build the Next.js app.
- `pnpm typecheck`: run strict TypeScript checks across the workspace.
- `pnpm test`: run all package test scripts through Turbo.
- `pnpm --filter @swat/indexer test`: test one workspace package.

## Coding Style & Naming Conventions

Use strict TypeScript, ES modules, two-space indentation, single quotes, and semicolons, matching existing files. Use `camelCase` for variables/functions, `PascalCase` for types and React components, and kebab-case filenames such as `pnl-math.ts`. Include `.js` extensions in relative TypeScript imports for NodeNext compatibility. Prefer shared domain types and helpers over duplicating contracts between services. The current `lint` scripts primarily perform TypeScript validation; no repository-wide formatter is configured.

## Testing Guidelines

Vitest is used in `@swat/shared`, `@swat/db`, and `@swat/indexer`; several other packages currently expose placeholder test scripts. Add focused `*.test.ts` coverage for changed parsing, scoring, P&L, or query behavior. Run `pnpm test` and `pnpm typecheck` before submitting. There is no documented coverage threshold.

## Commit & Pull Request Guidelines

History follows Conventional Commits, for example `feat: implement dynamic position sizing` and `fix: align package.json scripts`. Keep commits scoped and imperative. Pull requests should explain behavior and operational impact, link relevant issues, list verification commands, call out migrations or environment changes, and include screenshots for dashboard changes.

## Security & Configuration

Copy `.env.example` to `.env`; never commit secrets, API keys, private keys, or generated wallet data. Keep `TRADING_MODE=paper` and `AUTO_EXECUTE=false` unless live execution has been explicitly reviewed.
