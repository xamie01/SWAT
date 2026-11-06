# Phase 0 — repository map

## Scope and inventory method

This map describes the local checkout, not the deployed service. Deployment reachability, real credentials, mainnet behavior and audit sign-off are **NOT VERIFIED**. Workspace ownership is `apps/*` and `packages/*` (`pnpm-workspace.yaml:1-3`); CLI service commands are declared in `package.json:16-25`. Root `CLAUDE.md` is absent. The inherited FHEVM-specific guidance has no activation trigger in this review.

## Two-level directory tree

```text
SWAT/
├── .env.example
├── .gitignore
├── .mcp.json
├── .vscode/
│   ├── mcp.json
├── .woodpecker/
│   ├── ci.yaml
├── .woodpecker.yaml
├── .zcodeignore
├── AUDIT-FIX-CHECKLIST.md
├── DEPLOYMENT.md
├── LP-BUILD-RECORD.md
├── README.md
├── agent/
│   ├── skills/
├── apps/
│   ├── alert-service/
│   ├── api/
│   ├── discovery/
│   ├── indexer/
│   ├── lp/
│   ├── mcp-server/
│   ├── scorer/
│   ├── signal-engine/
│   ├── trade-executor/
│   ├── web/
├── deploy/
│   ├── crontab.example
│   ├── pgbouncer/
│   ├── systemd/
├── docker-compose.yml
├── docs/
│   ├── BLOCKERS-STAGE-1-TO-4.md
│   ├── DEPLOYMENT_AND_ARCHITECTURE_GUIDE.md
│   ├── PRD.md
│   ├── WAKE_PROTOCOL_X_CAMPAIGN.docx
│   ├── X_CONTENT_CAMPAIGN.md
│   ├── adr/
│   ├── agents/
│   ├── certification/
│   ├── dg-8/
│   ├── plans/
│   ├── runbooks/
│   ├── stale-dist-hazards.md
│   ├── testing-aspects.md
├── package.json
├── packages/
│   ├── db/
│   ├── shared/
├── pattern-ml/
│   ├── .env.example
│   ├── .gitignore
│   ├── README.md
│   ├── config/
│   ├── data/
│   ├── pyproject.toml
│   ├── scripts/
│   ├── src/
│   ├── tests/
├── pda-test-ui/
│   ├── .gitignore
│   ├── public/
│   ├── server.mjs
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── programs/
│   ├── pda-vault-minimal/
│   ├── wake-vault/
├── scripts/
│   ├── check-env-coverage.mjs
│   ├── check-public-secrets.mjs
│   ├── discover-starter-pack.ts
│   ├── g0-d11-acceptance.ts
│   ├── generate_campaign_docx.py
│   ├── polymarket-book-acceptance.ts
│   ├── polymarket-context-acceptance.ts
│   ├── run-web-dev.mjs
│   ├── seed-alpha-masters.ts
│   ├── start.sh
│   ├── test-integration.sh
│   ├── update-threshold.sh
│   ├── verify-acceptance.ts
├── skills-lock.json
├── tests/
│   ├── integration/
├── tsconfig.base.json
├── tsconfig.integration.json
├── tsconfig.tools.json
├── turbo.json
├── vitest.integration.config.ts
```

Tree entries are filesystem observations only, not claims that each file was reviewed. File/LOC counts are reproducible from `evidence/source-inventory.json`. Installed dependencies, generated build output, lockfiles (except module 11), skill packs, real `.env`, and report files are excluded from the general source inventory.

## Services and external boundaries

| Service/module | Declared responsibility | Initial source evidence |
|---|---|---|
| API | Fastify auth, user/admin control plane | `README.md:53`; reviewed route evidence in module 01 |
| Web | Next.js user/admin application | `README.md:54`; module 10 validates implementation |
| Indexer | Helius/Solana, EVM, Polymarket ingestion | `README.md:59`; module 05 |
| Signal engine / scorer | Source signal fan-out, scoring and exit sweeps | `README.md:58-60`; module 06 |
| Trade executor | Multi-chain execution and reconciliation | `README.md:57`; module 07 |
| LP / alerts / discovery | Secondary execution planning and external alert/discovery surfaces | `README.md:56,61-62`; module 08 |
| MCP | Agent-facing bridge | `README.md:63`; module 09 |
| Anchor programs | Vault authority/account validation | `README.md:69`; module 04 inspects both discovered programs |
| Python pattern-ml / standalone PDA UI | Outside pnpm workspace patterns; purpose/security coverage checked separately | `pnpm-workspace.yaml:1-3`; module 08/10 inventories |

These responsibility labels are README assertions, not proof of implemented financial behavior. In particular the blanket non-custody/completion claims (`README.md:27-32,150`) require code-path and deployment evidence.

## Datastores

- PostgreSQL is configured in Compose with persistent volume, loopback-default exposed port, and a default `swat` login/password (`docker-compose.yml:1-24`). Application connection variable is `DATABASE_URL` (`.env.example:18-19`). Default settings are development conveniences, not production-safe credentials.
- Redis is configured with a persistent volume and loopback-default exposed port; Compose declares no password (`docker-compose.yml:26-37`). Service consumption is documented at `.env.example:47-48`.
- PgBouncer uses transaction pooling and defaults to the same database login (`docker-compose.yml:39-57`). Transaction-scoped tenancy and advisory locks must be checked against this boundary (module 02).
- Additional local data files/dumps and database tables are enumerated by module 11/02; remote storage and backups are **NOT VERIFIED**.

## Secret inventory (names only; real values not read)

| Capability | Example-config evidence |
|---|---|
| DB credential / Redis connection | `.env.example:12-19,47-48` |
| Internal API key | `.env.example:77-89` |
| Admin bootstrap | `.env.example:94-111` |
| Helius API and webhook authorization | `.env.example:113-123` |
| Telegram delivery credential | `.env.example:125-132` |
| Email delivery credential | `.env.example:138-161` |
| Solana operator signer / Jito authentication | `.env.example:200-217` |
| EVM operator signer / CLOB L2 credential tuple | `.env.example:544-558` |
| Builder credential tuple | `.env.example:564-569` |
| Vercel deploy credentials | `.woodpecker.yaml:67-78` |

Crypto master-wrapper configuration/actual access is documented from source in module 03. Presence in the example does not prove a secret is configured. Historical secret findings are redacted locations/fingerprints only.

## Initial trust-boundary graph

```text
browser / agent / internal caller
  -> API or LP/MCP boundary
  -> session/service identity -> tenant-scoped database authority
  -> subscriptions + source identity + execution intent
chain/provider data -> webhook/parser -> canonical source ledger
  -> signals/capacity -> Redis/BullMQ jobs
  -> worker revalidation -> signing authority -> venue/contract submission
  -> independently verified fills -> tenant/lot/accounting ledger
payment evidence -> invoice ownership + finality -> atomic entitlement ledger
CI/untrusted checkout -> install/build/test -> separately privileged deployment
```

Each arrow is a boundary requiring validation, not an assurance that validation exists. Module reports supply exact entrypoint/route/queue/cron/on-chain instruction evidence and missing checks.

## Build, CI and safe-test constraints

- Build/test/typecheck run through Turbo (`package.json:5-10`); the test task depends on upstream builds (`turbo.json:25-29`). Running root tests can create build output outside the authorized write directory.
- CI runs prepare/install on push, pull request and manual events (`.woodpecker.yaml:1-24`); deployment has a push/main step condition (`.woodpecker.yaml:67-89`). Server-side fork/secret policy is **NOT VERIFIED**.
- Integration configuration imports `dotenv/config` and accepts `DATABASE_URL` fallback (`vitest.integration.config.ts:1-4`), validates a test-looking database name but not loopback host (`vitest.integration.config.ts:11-17`), then forces paper mode (`vitest.integration.config.ts:19-22`).
- Chaos tests terminate database backends and kill normal Redis clients (`tests/integration/chaos.integration.test.ts:53-61,343-345,418`). They must not be run on shared or non-local infrastructure. This review will use static verification and local-only test descriptions unless a completely isolated execution is explicitly recorded.

## Entry-point register

This is the discovered source wiring, not installed service state. Full path/tool lists and reviewed ranges are in the linked module reports.

| Surface | Verified entrypoints and schedules | Evidence |
|---|---|---|
| API | Auth/session/wallet endpoints; me/grants/withdrawal; billing; settings; admin portfolio; operator control and SSE. Fastify binds all interfaces. | `apps/api/src/index.ts:124-177,227-230,972-976`; [01 API](security-review/01-api.md) |
| Indexer HTTP/workers | `/webhook/helius`, `/webhook/health`; backfill/token discovery, 15-minute resolution poll and five-minute subscription refresh. | `apps/indexer/src/webhook.ts:39,121-129`; `apps/indexer/src/index.ts:621-670,704-745`; [05 ingestion](security-review/05-indexer-parsers.md) |
| Signal/scorer/discovery | Immediate/pubsub plus 15-second signal tick; scorer 02:00 UTC and five-minute exits; discovery 02:30 UTC/pubsub/startup option. | `apps/signal-engine/src/index.ts:670-724`; `apps/scorer/src/index.ts:195-264,300-344`; `apps/discovery/src/index.ts:24-87` |
| Trade queues | `swat-trades-{solana,polygon,robinhood,base,ethereum,bsc}` plus default-on legacy `swat-trades`; per-chain workers and one-minute reconciliation/PM polling. | `packages/shared/src/constants.ts:32,48-54`; `apps/trade-executor/src/trade-workers.ts:76-103`; `apps/trade-executor/src/index.ts:2916-2924` |
| LP | Fastify 3010; health/discover/positions/plans/wallets/copy routes; five `swat-lp-exec-*` workers; scan/monitor/index/risk crons. Live workers explicitly refuse submission. | `apps/lp/src/routes.ts:92-544`; `apps/lp/src/index.ts:66-69,361-424`; [08 secondary](security-review/08-secondary-services.md) |
| Alerts | `swat-alerts` and Redis alert bridge; fixed Telegram delivery, no discovered HTTP listener in reviewed entrypoint. | `apps/alert-service/src/index.ts:415-448`; `apps/alert-service/src/alert-bridge.ts:33-66` |
| MCP | Independent `GET /sse`, `POST /messages`; seven read/admin tools, default all-interface 3005. | `apps/mcp-server/src/index.ts:33-124,264-350,365-405`; [09 MCP](security-review/09-agent-mcp.md) |
| Web/testbed | Next middleware/rewrite/SSR/browser boundaries; separate PDA HTTP 3333/optional HTTPS 3334 with status/vault/withdrawal API. | `apps/web/middleware.ts:37-86`; `apps/web/next.config.ts:24-35`; `pda-test-ui/server.mjs:64-90,202-329,372-394` |
| Contracts | Wake config init/update, vault init/prefund, revoke/restore, owner native/SPL withdrawal, executor swap. Minimal program tag 0 owner-native withdrawal, tag 1 rejecting demo. | `programs/wake-vault/src/lib.rs:41-333`; `programs/pda-vault-minimal/src/lib.rs:12-116`; [04 contracts](security-review/04-on-chain-programs.md) |
| Python/CLI | Local pull/scoring/model/file operations; startup/migration/build/acceptance wrappers; not a discovered public Python HTTP service. | `pattern-ml/src/pattern_ml/cli.py:178-219,615-634`; `scripts/start.sh:47-48,106,133-146`; [08 secondary](security-review/08-secondary-services.md) |
| CI/ops | Two Woodpecker pipelines, frozen workspace preparation/test/build and push-main Vercel deploy; systemd/cron/billing CLI and session-lock migrations. | `.woodpecker.yaml:20-90`; `packages/db/src/migrate.ts:10-46`; [11 infrastructure](security-review/11-infrastructure-supply-chain.md) |

No additional external agent bridges, installed cron/units, remote APIs, deployed IDLs/bytecode or production network topology were verified. Discovery and search coverage must not be read as an exhaustive audit of every route body.

## Coverage

See `coverage-ledger.md`, each module appendix, and `evidence/source-inventory.json`. A completed module workflow can still have explicit unread files; no full-repository audit claim is made.
