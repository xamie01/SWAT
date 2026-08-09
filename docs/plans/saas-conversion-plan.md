# SWAT → Multi-Tenant SaaS Conversion Plan

Convert the single-operator SWAT pipeline into a SaaS platform: signup/login, EVM+Solana wallet connection, per-user tracked wallets & token backfill, per-user signal feeds, platform-managed trading wallets with risk-proportional autonomous execution, tiered subscriptions (Stripe + USDC), and Ultra-tier dynamic chain tracking (Chainlist / DeFi Llama / CoinGecko).

> **CORRECTED 2026-08-09** by `docs/adr/0003-delegated-execution-authority.md`.
> "Platform-managed custodial trading wallets" below is **no longer the direction.**
> WAKE does not hold, wrap, or decrypt user root keys; users grant scoped, revocable,
> expiring authority over wallets they keep. §"Key management" and the `packages/custody`
> section are superseded — see the ADR, and `AUDIT-FIX-CHECKLIST.md` §2 for the four
> corrections that already override this document.

**Decisions locked in:** ~~platform-managed custodial trading wallets~~ **scoped delegated authority per chain (ADR-0003)** · email/password auth + wallet linking (SIWE/SIWS) · Stripe AND USDC billing · full vision planned now, built in 6 phases.

**Current state (verified):** zero users/tenancy anywhere — one shared `API_KEY` (browser-exposed via `NEXT_PUBLIC_API_KEY`), one global `wallets` table, one `EVM_PRIVATE_KEY` + Trojan wallet for all execution, global `config` singletons, fake hardcoded login in `apps/web/app/page.tsx`, chains hard-coded as a 3-value union in ~15 places.

---

## Phase 1 — Identity & tenancy foundation

### DB (new migrations `029+`, idempotent per `migrate.ts` convention)
- `users` — id UUID PK, email (unique, citext), password_hash (argon2id), display_name, role (`user`/`admin`), tier (`free`/`operator`/`ultra`), tier_expires_at, status, created_at.
- `user_sessions` — id, user_id FK, token_hash, expires_at, ip, user_agent (opaque session tokens in httpOnly cookies; revocable).
- `user_auth_wallets` — linked sign-in/identity wallets: user_id FK, chain_kind (`evm`/`solana`), address, verified_at; UNIQUE(chain_kind, address). Proven by SIWE (EIP-4361, `viem` verify) / SIWS (ed25519 verify via `@solana/web3.js` + tweetnacl).
- `user_api_keys` — per-user programmatic keys (prefix + SHA-256 hash), replacing the global key for user-facing routes.

### API (`apps/api`)
- New `apps/api/src/auth/` module: `POST /v1/auth/signup`, `/login`, `/logout`, `GET /v1/auth/me`, `POST /v1/auth/wallet/nonce`, `POST /v1/auth/wallet/verify` (SIWE+SIWS link + wallet-only login for linked wallets).
- Replace the global `onRequest` API-key hook with a layered auth plugin: session cookie OR per-user API key → attaches `request.user` (id, tier, role). The old `API_KEY` remains valid only for internal service→API calls and admin routes, never shipped to the browser. Delete `NEXT_PUBLIC_API_KEY` usage.
- Tier/role guard helper: `requireTier('operator')`, `requireRole('admin')` per route.
- Rate limiting (`@fastify/rate-limit`) on auth + write routes; argon2 for hashing; keep the existing SSE ticket flow but mint tickets per session.

## Phase 2 — Per-user tracking, backfill, signal feed

### Model: global dedup + per-user subscription
`wallets`, `transactions`, clusters, scoring stay **global** (one wallet indexed once serves all subscribers). Add:
- `user_wallet_subscriptions` — user_id FK, wallet_address FK wallets, label, source (`manual`/`platform-signal`/`discovered`), created_at; PK (user_id, wallet_address). Wallet rows are created on first subscription; garbage-collect/pause wallets with zero subscribers and no platform interest (scorer lifecycle rule).
- `user_token_watches` — per-user token-contract backfills: user_id, chain, token_mint, status; feeds the existing `swat-token-discovery` queue; discovered early/big buyers are auto-subscribed for that user (source `discovered`).
- Per-tier quotas enforced in API: tracked wallets (free 3 / operator 25 / ultra unlimited), token backfills/day, backfill depth.

### API routes (user-scoped, mounted under `/v1/me/`)
- `GET/POST/DELETE /v1/me/wallets` — subscribe/unsubscribe (POST upserts global wallet + enqueues `swat-backfill-wallet` if new, else just links). `GET /v1/me/wallets/:address/history|holdings` reuse existing queries, gated on subscription.
- `POST /v1/me/tokens/backfill` — token-contract discovery per user.
- `GET /v1/me/signals` — signals whose cluster/wallet intersects the user's subscriptions: SQL join `signals → cluster_memberships → user_wallet_subscriptions`, plus platform-curated signals for `operator+` tiers. `GET /v1/me/feed` — activity of subscribed wallets from `source_trades`/`transactions`.
- Existing global routes (`/v1/wallets`, `/v1/config`, trading mode, reindex, logs) become **admin-only**.
- `signal-engine` unchanged (patterns are wallet-set-global); alert-service extended later for per-user Telegram/email routing keyed off subscriptions.

## Phase 3 — Custodial trading wallets & per-user autonomous execution

### Key management (new package `packages/custody`)
- Per user, generate one Solana keypair + one EVM keypair. Envelope encryption: per-key random data key (AES-256-GCM via libsodium) wrapped by a master key from env `CUSTODY_MASTER_KEY` (KMS-ready interface for later). Private keys decrypt only inside trade-executor at signing time; never leave the process, never appear in logs/API.
- `user_trading_wallets` — user_id, chain_kind, address (public), encrypted_key, key_version, created_at.
- `user_balances` — cached balances (chain, asset, amount, usd, fetched_at); refreshed by a balance poller in trade-executor (reuses `balances.ts` per-chain logic) and on demand.
- Deposit = user sends funds to their address (shown in UI with QR). Withdraw = `POST /v1/me/trading/withdraw` → signed transfer to a **verified linked auth wallet only** (anti-theft), with email confirmation and per-day limit.

### Per-user risk & execution config
- `user_execution_settings` — per user: auto_execute bool, per-chain mode (`off`/`paper`/`live`), min_signal_score, max_position_pct (of *their* balance), max_daily_exposure_pct, stop_loss_pct, rebuy_cooldown. Defaults from `DEFAULT_RISK_CONFIG`; API `GET/PUT /v1/me/execution/settings` with tier gating (live execution = `operator+`).
- Sizing: reuse `policy.ts calculateBalanceAwareSize` but parameterized by the user's balance and risk %, so exposure is always proportional to what the user deposited and agreed to.

### Executor fan-out
- signal-engine, on a trade-eligible signal, publishes once; a new **fan-out step** (in trade-executor) enumerates eligible users: subscribed to the signal's cluster ∩ auto_execute on ∩ chain enabled ∩ tier allows ∩ balance ≥ min. One BullMQ job per (signal, user) on `swat-trades`, idempotent via UNIQUE(signal_id, user_id).
- Extend `trades` and `copy_executions` with `user_id` FK (nullable = legacy operator trades). **Correction (ADR-0001, 2026-08-04):** an earlier version of this line claimed `target_account` "already exists in 028 and maps to user id". It does not — `target_account` holds a **chain-prefixed wallet address** (`apps/trade-executor/src/index.ts:904`), so the `(source_trade_id, target_account, execution_mode)` uniqueness is keyed on a wallet, not a tenant. Reusing it as the tenancy key would collide every paper-mode user on a chain onto one key and fork a user's history on custodial key rotation. `user_id` is the tenancy key; `target_account` stays the settlement address. See `docs/adr/0001-tenancy-key.md`. Per-user circuit breaker keys (`swat:cb:<user>:<chain>`), per-user daily exposure caps, per-user paper bankroll.
- Solana live execution moves from the Trojan webhook to direct Jupiter swap (quote client already exists in `jupiter.ts`; add swap-transaction build + sign with the user's custodial key), submitted as **Jito bundles** with a tip instruction for front-running/MEV protection — never public RPC broadcast. Full executor spec in `BUILDER-GUIDE.md` Stage 3 (DG-1 resolved). Polygon/Polymarket per-user = derive CLOB L2 creds from each user's EVM key. Robinhood Chain reuses `robinhood.ts` with per-user signer.
- Global `chain_certifications` + `LIVE_ENABLED_CHAINS` gates still apply platform-wide on top of user settings.

## Phase 4 — Billing (Stripe + USDC)

- `subscriptions` — user_id, tier, provider (`stripe`/`usdc`), status, current_period_end, stripe_subscription_id. `payments` — provider, amount, currency, tx_hash/invoice_id, status.
- **Stripe:** Checkout + Billing portal; webhook `POST /v1/billing/stripe/webhook` (signature-verified) drives tier grants/downgrades.
- **USDC:** per-user deposit reference — user pays USDC (Solana or Polygon) to the treasury address with a memo/reference; a billing watcher (in indexer, reusing existing Helius/viem infra) confirms the transfer and grants tier. `99 USDC lifetime` = tier with `tier_expires_at = NULL`.
- Nightly job downgrades expired tiers; grace period 3 days. Tier matrix lives in `packages/shared/src/tiers.ts` (quotas, features, chain access) — single source of truth for API guards and frontend gating.

## Phase 5 — Ultra tier: dynamic chains (Chainlist / DeFi Llama / CoinGecko)

- **Chain registry refactor** (the big one): new `chains` table (id slug PK, kind `evm`/`solana`/`polymarket`, evm_chain_id, name, rpc_urls JSONB, native_symbol, coingecko_platform, dexscreener_id, status `builtin`/`custom`, added_by_user_id). Seed the 3 built-ins. Change `Chain` in `packages/shared/src/types.ts` from a 3-value union to `string` validated against the registry; replace the ~15 hard-coded literal enumerations (`address.ts`, `validation.ts`, `execution.ts`, `prices.ts` map, `db/wallets.ts` SQL, `trading-control.ts`, SQL CHECKs → FK) with registry lookups. This touches everything, so it's isolated in its own phase with the full test suite as the gate.
- **Ultra chain onboarding:** `POST /v1/me/chains` (ultra only) with an EVM chain id → resolve metadata + public RPCs from **Chainlist** (`chainid.network/chains.json`), verify RPC liveness, resolve **DeFi Llama** (`api.llama.fi/overview/dexs/<chain>`) for the 5 most liquid DEXes, map the **CoinGecko** platform id for pricing. Persist to `chains`.
- Generic EVM tracking already exists (`evm.ts` viem log scanner) — parameterize base-token sets and RPC by registry row; per-user tracked wallets on custom chains flow through the same backfill queue.
- Execution on custom chains: **paper mode by default**; live only where a supported router (Uniswap v3-compatible, from the DeFi Llama DEX list) is configured and the platform certifies the chain (`chain_certifications` unchanged). Prices via DexScreener → CoinGecko cascade already in `prices.ts`.

## Phase 6 — Frontend (apps/web)

- **Foundation:** proper build-time Tailwind (drop the CDN script), shared `lib/api.ts` client (cookie-based, no API key in browser), `middleware.ts` route protection, react-query for polling.
- **Auth pages:** real signup/login/forgot-password replacing the fake modal in `app/page.tsx`; onboarding flow.
- **Wallet connect:** wagmi + RainbowKit (EVM) and `@solana/wallet-adapter` — used for (a) linking auth wallets via SIWE/SIWS, (b) one-click "track my own wallet", (c) USDC payment flows.
- **User dashboard (evolve the existing WAKE workspace):** My Wallets (subscribe, backfill status, activity feed), My Signals (per-user feed, existing SignalsView safety drawer carries over), **Risk & Health dashboard** (existing `HealthView`/`RiskExecutionView` rebuilt user-scoped: their balances, exposure vs. agreed risk %, per-chain mode toggles, personal kill switch), Trading wallet page (deposit QR / balances / withdraw / paper-live toggle), Token backfill page, Billing page (Stripe portal + USDC pay), Ultra chain manager (add chain via Chainlist dropdown).
- **Admin area:** current global pages (`/wallets`, `/logs`, `/setup`, trading control, user management, manual tier assignment) behind `role=admin`.

---

## Cross-cutting

- **Security:** argon2id, httpOnly SameSite cookies + CSRF on mutations, per-user rate limits, encrypted custody keys with key rotation support, withdraw-to-linked-wallet-only, audit log table for auth/custody/billing events, secrets never in `NEXT_PUBLIC_*`.
- **Testing:** vitest per phase — auth flows, quota enforcement, fan-out idempotency, sizing math (extend `pnl-math`/policy tests), chain-registry migration regression suite; existing `pnpm test` + `pnpm typecheck` as the gate for every phase.
- **Migration safety:** all new SQL idempotent; existing operator data untouched — legacy trades keep `user_id NULL`, existing tracked wallets get subscribed to a seeded admin user.

## Build order & rough effort

| Phase | Delivers | Size |
|---|---|---|
| 1 | Auth, sessions, tiers, wallet linking | M |
| 2 | Per-user tracking/backfill/signals + quotas | M |
| 3 | Custody, balances, per-user autonomous execution | L (highest risk) |
| 4 | Stripe + USDC billing | M |
| 5 | Dynamic chain registry + Ultra onboarding | L (widest refactor) |
| 6 | Frontend rebuild (runs partly in parallel from Phase 2) | L |

Each phase lands independently deployable behind tier/feature flags; Phases 1→2→3 are strictly sequential, 4 and 6 can overlap, 5 last because the chain-registry refactor touches everything.
