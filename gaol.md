# SWAT — Standard Goal & Execution Build Plan

**Status:** Standing reference for the build phase. Supersedes ad-hoc priorities.
**Date:** 2026-07-16
**Prime directive:** Convert observable on-chain behavior of proven wallets into positive-expectancy trade signals, per chain, faster than the market prices that behavior in — and prove it with attributed P&L.

**Revision to prior plan:** Robinhood Chain and Polymarket live execution are **no longer deferred indefinitely**. They are built in this phase, behind per-chain acceptance gates. Every chain must be able to run **paper and live simultaneously** — both across chains (Solana live while Polymarket papers) and within a chain (live fills shadowed by a paper simulation for execution-quality measurement).

---

## Table of contents

1. [Mission and per-chain edge](#1-mission-and-per-chain-edge)
2. [The execution-mode matrix](#2-the-execution-mode-matrix)
3. [Phase 0 — Prerequisites](#3-phase-0--prerequisites-close-the-open-wounds-first)
4. [Phase 1 — Per-chain execution config refactor](#4-phase-1--per-chain-execution-config-refactor)
5. [Phase 2 — Robinhood Chain live executor](#5-phase-2--robinhood-chain-live-executor-uniswap-v3)
6. [Phase 3 — Polymarket live executor](#6-phase-3--polymarket-live-executor-clob-v2)
7. [Phase 4 — Shadow-paper engine](#7-phase-4--shadow-paper-engine-paper--live-simultaneously)
8. [Phase 5 — Risk enforcement](#8-phase-5--risk-enforcement)
9. [Phase 6 — Attribution loop](#9-phase-6--attribution-loop-the-part-that-proves-the-mission)
10. [Phase 7 — Testing & acceptance gates](#10-phase-7--testing--acceptance-gates)
11. [Rollout sequence](#11-rollout-sequence)
12. [Non-goals](#12-non-goals)
13. [Definition of done](#13-definition-of-done)

---

## 1. Mission and per-chain edge

The three chains are not three instances of the same game. Each has a distinct information edge, latency requirement, and monetization path. The system milks all three only if each is built to its own role:

### Solana — the speed game (primary P&L engine)
- **Edge:** elite memecoin wallets telegraph entries minutes before retail. Decay window: **minutes**.
- **Role:** detect AND execute live (Trojan webhook). This chain pays the bills.
- **Standard:** snipe signal → Telegram in < 60s from the third distinct buy; webhook real-time path healthy (backfill-only means trading the corpse of the move); safety gate blocks rugs without blocking fast movers.
- **Success metrics:** median detection→alert latency < 60s · snipe 1h-forward return > 0 net of slippage · ≥ 1 executed signal/day from a healthy cluster set.

### Polymarket — the information game (conviction oracle + live venue)
- **Edge:** prediction-market positioning by sharp wallets is *forward-looking information about real-world events* — a signal class no DEX flow provides. Resolution outcomes are the truest skill measure in the entire system.
- **Role:** signal intelligence first; **live CLOB execution built in Phase 3** so accumulation signals on high-conviction markets become executable, not just readable.
- **Standard:** every polygon signal carries market question + outcome + end date; wallet win-rate on Polymarket computed from REDEEM/resolution events, not mark-to-market; ingestion lag < 5 min (this chain fails silently more than any other — health metrics are mandatory).
- **Success metrics:** 100% signal context coverage · resolution-based wallet scoring live · ingestion lag alarm < 5 min.

### Robinhood Chain — the frontier game (early-territory scanner + live venue)
- **Edge:** new, thin, low-competition venue. Being early with surveillance builds a proprietary map of who's good before anyone else has it.
- **Role:** wide-net discovery + scoring; **live Uniswap V3 execution built in Phase 2** with on-chain verification at every step (this is the chain where unverified assumptions burned us before — router address, chain id, and receipt verification are all gated).
- **Standard:** ingestion completeness (inserted vs skipped > 90%); direction-classification accuracy > 95% on sampled txs; growing roster of scored wallets with ≥ 20 classified trades each.
- **Success metrics:** completeness ratio visible · scored-wallet roster growing · first verified live fill with receipt-decoded amounts.

### Cross-chain multiplier
The same operator often runs a Solana degen wallet and a Polymarket book. Funding-graph + behavioral clustering across the shared prefixed address space is the moat: clusters are cross-chain-capable and a wallet's composite score inherits evidence from any chain it acts on.

---

## 2. The execution-mode matrix

Replace the single global `TRADING_MODE` with a **per-chain mode**, each independently one of:

| Mode | Meaning |
|---|---|
| `off` | Signals fire, alerts send, **no** trades of any kind for this chain |
| `paper` | Simulated fills only (Jupiter sim / spot-price sim / CLOB book sim) |
| `live` | Real execution only |
| `live+shadow` | Real execution **and** a paper simulation of the same order, persisted side-by-side, for slippage/execution-quality measurement |

**"All chains can paper and live trade at the same time" is satisfied two ways:**
1. **Across chains:** each chain's mode is independent. Solana `live+shadow` while Polymarket runs `paper` and Robinhood runs `live` is a legal, normal configuration — one executor process, concurrently.
2. **Within a chain:** `live+shadow` runs paper and live *for the same signal simultaneously*, producing a continuous paper-vs-live benchmark (the only honest way to measure execution cost).

Configuration source of truth (priority order):
1. `config` DB table, key `execution` → `{"solana":"live+shadow","polygon":"paper","robinhood-chain":"paper"}` — hot-changeable at runtime via the existing `PUT /v1/config`, re-read by the executor per job (cached 30 s).
2. Env fallbacks: `TRADING_MODE_SOLANA`, `TRADING_MODE_POLYGON`, `TRADING_MODE_ROBINHOOD` (each `off|paper|live|live+shadow`).
3. Legacy `TRADING_MODE` maps to all three chains for backward compat, **but** `live` maps to live only for chains in the certification allowlist (§4 step 4) and `paper` for the rest.
4. Absolute default: `paper` everywhere. Unknown strings **throw at startup** — never silently default (the old bug where any typo meant live must stay dead).

---

## 3. Phase 0 — Prerequisites (close the open wounds first)

Nothing below is worth building on missing data. In order:

### 0.1 Discovery → backfill auto-enqueue (the acknowledged open gap)
- **File:** `apps/discovery/src/index.ts` (`ingestDiscoveredWallets`).
- After each `upsertWallet`, add a job to `swat-backfill-wallet` exactly the way `apps/indexer/src/index.ts` `ingestWallets` does: `jobId: backfill-${chain}-${rawAddress}` (jobId dedupe makes re-enqueue a no-op); payload carries the **raw** (unprefixed) address + chain.
- Strip any existing prefix before enqueueing (counterparties come back prefixed from `transactions.wallet_address`) and route the chain from the prefix — do not default everything to solana (the old double-prefix bug).
- **Acceptance:** insert a discovered wallet in a dev run → observe a backfill job → observe transactions rows.

### 0.2 Ingestion health metrics (all three chains)
- Each indexer path writes a heartbeat (`ingestion_health` table or `config` key): `{chain, last_event_at, inserted_24h, skipped_24h, failed_24h}` per batch.
- API: `GET /v1/health/ingestion` returns per-chain lag + insert/skip ratio.
- Alert-service: if any chain's `last_event_at` exceeds its threshold (solana 5 min, polygon 10 min, robinhood 15 min), send a Telegram **ops alert** (formatted distinctly from trade alerts).
- **Why first:** every historical polygon/EVM failure was silent. The build phase must never again discover a dead chain via an empty dashboard.

### 0.3 Verify remediation claims against source
Spot-checked ✔ already: quote-aware sell direction, safety prefix strip, `updateClusterPerformance` wired into scorer, `COUNT(DISTINCT …)` in snipe, `parseTradingMode` fail-closed, live clamp for non-solana. Complete the diff against the remaining AUDIT-REPORT.md §1–2 items and tick them off there before Phase 1. Anything still open that touches money or data direction blocks its dependent phase.

---

## 4. Phase 1 — Per-chain execution config refactor

**Files:** `apps/trade-executor/src/index.ts`, `packages/shared/src/validation.ts` + `types.ts`, one new migration. (~1 day)

1. **Shared type + parser** in `@swat/shared`:
   ```ts
   export type ExecutionMode = 'off' | 'paper' | 'live' | 'live+shadow';
   export type ExecutionConfig = Record<Chain, ExecutionMode>;
   export function parseExecutionConfig(raw: unknown): ExecutionConfig; // throws on any unknown value
   ```
2. **Migration `015_execution_config.sql`** — idempotent, **seed-once** (do NOT repeat the migration-003 clobber bug):
   ```sql
   INSERT INTO config (key, value)
   VALUES ('execution', '{"solana":"paper","polygon":"paper","robinhood-chain":"paper"}')
   ON CONFLICT (key) DO NOTHING;
   ```
3. **Executor resolves mode per job:** `resolveChainMode(chain)` = DB config (30 s TTL cache) → env override map → legacy `TRADING_MODE` mapping → `'paper'`. Replace the current global checks (`mode === 'paper'` at `index.ts:429`, the `chain !== 'solana'` live throw at `:402`) with a switch:
   - `off` → skip with reason; do **not** claim the signal (leaves it `pending` for a mode change).
   - `paper` → existing paper path (Jupiter sim on solana, spot/book sim elsewhere).
   - `live` → the chain's live executor (Phases 2–3 make polygon/robinhood real).
   - `live+shadow` → live executor; on success also run the paper simulator and persist the shadow row (Phase 4).
4. **Certification allowlist:** until a chain passes its live acceptance gate (§11), `resolveChainMode` clamps its `live`/`live+shadow` to `paper`, logging a WARNING with the reason — visible, not silent. Controlled by `LIVE_ENABLED_CHAINS` env (initially `solana`), so enabling a newly-certified chain is an explicit deploy action, not a config typo.
5. **`GET /v1/trading/status`** returns the resolved per-chain matrix + clamp reasons; the web dashboard renders exactly what will happen to the next signal on each chain.

**Acceptance:** unit tests for `parseExecutionConfig` (typos throw; legacy mapping correct; clamp logic). Manual: set solana `live+shadow` / polygon `paper` in one config → the same executor process handles both correctly, concurrently.

---

## 5. Phase 2 — Robinhood Chain live executor (Uniswap V3)

The old implementation sent ETH with **empty calldata** to an unverified mainnet-copied router address. The rebuild treats every assumption as unverified until proven on-chain. **New file:** `apps/trade-executor/src/executors/robinhood.ts`. (~3–4 days)

### 5.1 Startup verification (once per process; failure ⇒ clamp chain to paper + ops alert; never crash the worker)
1. `client.getChainId()` must equal `ROBINHOOD_CHAIN_ID` env — no hardcoded 4663 assumption.
2. `getBytecode()` must be non-empty for `ROBINHOOD_SWAP_ROUTER`, `ROBINHOOD_QUOTER`, `ROBINHOOD_WETH9` (all from env — the addresses are deployment facts, not constants).
3. Sanity-quote: `quoter.quoteExactInputSingle(WETH9 → known-liquid token, 0.0001 ETH)`; revert ⇒ wrong addresses or no liquidity ⇒ clamp + alert.
4. Log the verified tuple (chainId, router, quoter, weth9) at startup so certification is auditable from logs.

### 5.2 Per-trade flow (buy)
1. **Resolve pool + quote first.** Try fee tiers `[3000, 10000, 500]` via the Quoter; first tier returning a non-reverting quote wins. No quote on any tier ⇒ skip trade with reason `no-liquidity` (do not claim the signal as executed).
2. **Slippage bound from the quote, not a blind constant:** `minOut = quotedOut * (1 - SLIPPAGE_BPS/10_000)`, `ROBINHOOD_SLIPPAGE_BPS` default 300.
3. **Build the real calldata** with viem's typed ABI:
   ```ts
   const calldata = encodeFunctionData({
     abi: swapRouterAbi,               // canonical ISwapRouter.exactInputSingle
     functionName: 'exactInputSingle',
     args: [{ tokenIn: WETH9, tokenOut: token, fee, recipient: account.address,
              deadline: nowSec + 120, amountIn, amountOutMinimum: minOut,
              sqrtPriceLimitX96: 0n }]
   });
   ```
   Send as `{ to: router, data: calldata, value: amountIn }` **plus** `msg.value` path via the router's `multicall` with `refundETH` if the router requires wrapped input — verify which pattern the deployed router supports during certification (SwapRouter02 differs from SwapRouter01: no deadline field, `exactInputSingle` is payable with automatic wrap). **The certification test on a real tiny trade decides which ABI variant ships.**
4. **Simulate before sending:** `client.simulateContract(...)` (or `eth_call` the calldata). Simulation revert ⇒ skip with the revert reason persisted — never send a tx that simulation already rejected.
5. **Send, then verify:** `sendTransaction` → `waitForTransactionReceipt({ hash, timeout: 60_000, confirmations: 1 })`.
   - `receipt.status === 'reverted'` ⇒ trade **failed**: release the signal claim to `pending`, persist a `status='failed'` trade row with the hash, count toward the circuit breaker.
   - Success ⇒ **decode actual fill from logs**, never trust the quote: parse the pool's `Swap` event (or the Transfer to `recipient`) for the true `amountOut`. Persist `token_amount` from the receipt, `price_usd` from `amountIn`/`amountOut`, `slippage_bps` as quoted-vs-actual.
6. **Sells (exit signals, future):** same flow inverted, preceded by an idempotent ERC-20 `approve(router, amountIn)` — check current allowance first; use exact-amount approvals, not infinite.
7. **Nonce/gas:** viem's account nonce management is fine at concurrency 1 (the worker is concurrency-1 by design — keep it). Set `maxFeePerGas` from `estimateFeesPerGas` with a 2× cap.

### 5.3 Failure taxonomy (each path must be handled distinctly)
| Failure | Handling |
|---|---|
| No pool/liquidity | Skip, reason persisted, no breaker count |
| Simulation revert | Skip, revert reason persisted, no breaker count |
| Tx send error (RPC down) | Release claim → `pending`, breaker count, retryable |
| Receipt timeout | **Ambiguous:** persist `status='pending_confirmation'` with hash; a sweeper job re-checks the hash every 60 s for 10 min, then resolves to filled/failed. Never double-send while a hash is pending. |
| Receipt reverted | Release claim, `status='failed'` row with hash, breaker count |

**Acceptance gate (certification):** on the live chain with a throwaway wallet: (1) startup verification passes; (2) one tiny live buy (~$1) confirms, receipt decoded, trade row shows receipt-derived amounts; (3) a forced-failure test (impossible `minOut`) produces a clean `failed` row and a released claim; (4) kill the process mid-confirmation and verify the sweeper resolves the orphan. Then add `robinhood-chain` to `LIVE_ENABLED_CHAINS`.

---

## 6. Phase 3 — Polymarket live executor (CLOB v2)

The old "live" path fabricated `pm-sig-<timestamp>` signatures. The rebuild does real signed orders. **New file:** `apps/trade-executor/src/executors/polymarket.ts`. (~3–4 days)

### 6.1 Foundations
1. **Dependency:** pinned `@polymarket/clob-client-v2` (official). It handles CLOB V2 EIP-712 order signing, L1/L2 auth headers, builder-code attribution, and tick-size rules; do not hand-roll signing.
2. **Auth model:** L1 = the EVM key signs once to derive L2 API creds (`createOrDeriveApiKey()` at startup; persist creds in `config` under `polymarket_api_creds`, encrypted at rest is out of scope for now but the key never logs). All subsequent order calls use L2 headers.
3. **Collateral:** USDC.e (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`) — **not** native USDC (the old wrong-contract bug). Balance + allowance check against the CTF Exchange contract at startup; missing allowance ⇒ one exact-amount `approve` per session cap, logged.
4. **Startup verification (mirrors §5.1):** `getChainId()===137`, CLOB `/ok` health endpoint reachable, API creds valid (`getApiKeys()` round-trip), USDC.e balance > 0. Any failure ⇒ clamp polygon to paper + ops alert.

### 6.2 Per-trade flow (buy an outcome token)
1. **Resolve the token:** signal's `tokenMint` is `polygon:<clobTokenId>`; strip prefix → `tokenID`. Look up the market via `getPolymarketMarket(conditionId)` for tick size, `active`/`closed` state, and `end_date`. Market closed/resolving ⇒ skip with reason.
2. **Read the book:** `client.getOrderBook(tokenID)`. Compute the ask-side depth needed to fill `size` USDC. If the top-of-book ask > `MAX_ENTRY_PRICE` (default 0.97 — never buy near-resolved certainty) or the book can't fill within `POLYMARKET_SLIPPAGE_BPS` (default 200) of mid ⇒ skip, reason `book-too-thin`.
3. **Order type — marketable limit, not market:** price = min(ask-walk price for full size, mid × (1 + slippage)), rounded to the market's tick size; side BUY; size = USDC amount / price, rounded to the market's minimum size increment.
4. **Idempotency:** the CLOB client supports a client order id — set it to `signalId`. Before posting, `getOrders({market})` and abort if an order with that client id already exists (protects against the retry-after-timeout double-buy class).
5. **Post + poll:** `client.postOrder(...)` (returns orderID) → poll `getOrder(orderID)` every 2 s up to 30 s:
   - `matched`/`filled` ⇒ persist with actual filled size + avg price from the fill data; `order_id` in the trade row (the tx settles on-chain via the operator — store `orderID` as the signature field, prefixed `clob:`).
   - Partially filled at timeout ⇒ cancel the remainder (`cancelOrder`), persist the partial fill honestly (`size` = filled portion), release nothing.
   - Unfilled at timeout ⇒ `cancelOrder`, release claim → `pending`, reason `unfilled`.
6. **Sells / redeems (future):** exit signals map to SELL orders; REDEEM stays an indexer-side observation (resolution P&L), not an executor action, until a redemption flow is certified.

### 6.3 Failure taxonomy
| Failure | Handling |
|---|---|
| Market closed / near-resolved / thin book | Skip with reason, no breaker count |
| Auth/creds error | Clamp polygon to paper + ops alert (systemic, not per-trade) |
| Post rejected (tick/size violation) | Skip, log the violation — indicates a rounding bug, alert |
| Poll timeout with order live | Cancel; if cancel also fails, `pending_confirmation` + sweeper (§5.3) |
| Duplicate client order id detected | Skip — an execution already happened; do NOT release the claim |

**Acceptance gate (certification):** with a small-balance wallet: (1) startup verification passes; (2) one tiny live BUY on a liquid market fills and the trade row shows actual fill price/size; (3) an unfillable limit (price far below bid) posts, times out, cancels cleanly, claim released; (4) re-posting the same `signalId` is refused by the idempotency check. Then add `polygon` to `LIVE_ENABLED_CHAINS`.

---

## 7. Phase 4 — Shadow-paper engine (paper + live simultaneously)

The piece that makes `live+shadow` real. (~1–2 days)

1. **Migration `016_shadow_trades.sql`:** add `execution_mode` values allow `'shadow'`, plus column `shadow_of UUID REFERENCES trades(id)` (idempotent `ADD COLUMN IF NOT EXISTS`).
2. **Flow:** in `live+shadow`, after the live executor returns a fill, run the chain's paper simulator with the **same inputs** (same size, same timestamp): Jupiter quote sim on solana; the §6.2 book-walk priced at observation time for polygon; the §5.2 quoter quote for robinhood. Persist as a second trade row: `execution_mode='shadow'`, `shadow_of=<live trade id>`, `signal_id` same.
3. **Never block the live path:** shadow simulation failures log and drop — a Jupiter API blip must not fail a filled live trade's job. Shadow runs after the live persist, fire-and-forget with error logging.
4. **Execution-quality report:** extend the attribution job (§9) with per-chain `avg(live fill price / shadow fill price − 1)` — the true, continuously-measured cost of going live. This number is the go/no-go input for scaling position sizes.
5. **P&L hygiene:** shadow rows are **excluded** from portfolio, exposure, and cooldown queries (`WHERE execution_mode != 'shadow'` — audit `hasRecentBuy`, `pnl-queries.ts`, `/v1/trading/portfolio`). They exist only for benchmarking.

---

## 8. Phase 5 — Risk enforcement

Declared-but-unenforced limits become enforced. All read from the `risk` config key (hot-changeable), enforced in the executor **before** claiming, per chain. (~2 days)

1. **Per-trade cap:** `maxPositionPct` of the chain's wallet balance (live) or virtual bankroll (paper; `PAPER_BANKROLL_USD` env, default 10,000 — paper must obey the same constraints live will, or paper stats are fantasy).
2. **Daily exposure cap:** `SUM(amount_usd) FROM trades WHERE chain=$1 AND execution_mode IN ('paper','live') AND executed_at > now()-interval '24 hours'` vs `maxDailyExposurePct × bankroll`. Breach ⇒ skip with reason `daily-cap`, alert once per day per chain.
3. **Circuit breaker v2 (persisted):** move state to the `config` key `breaker:{chain}` — `{consecutiveFailures, trippedAt}`. Per-chain, not global (a robinhood RPC outage must not halt solana). Trip at the moment of the Nth failure (not on the next job — the old stale-trip bug). While tripped: jobs are **delayed** (BullMQ `moveToDelayed`, +5 min), not dropped. Reset on first success. Survives restart.
4. **Kill switch:** config key `execution` set to `{"*": "off"}` shape is honored within one cache TTL (30 s) — the documented emergency stop, testable from the dashboard.
5. **Balance floor:** live trade sizing must leave `MIN_GAS_RESERVE` (chain-native units) untouched; sizing that would breach it sizes down or skips — never `Math.max`-floors upward (the old inverted-sizing bug class).

---

## 9. Phase 6 — Attribution loop (the part that proves the mission)

Open-loop pipelines trade; closed-loop pipelines learn. (~2–3 days)

1. **Nightly job (scorer, after clustering):** join `signals → trades (live + paper, shadow excluded) → pnl` into a `signal_outcomes` table: `{signal_id, pattern, chain, cluster_id, tier, mode, entry_usd, pnl_1h, pnl_24h, pnl_realized, hit}` — `pnl_1h/24h` computed from the price snapshots the 5-minute mark-to-market job already produces.
2. **Expectancy report:** per `(pattern × tier × chain × mode)`: count, hit-rate, avg win, avg loss, expectancy. Persist to `config` key `expectancy_report` + a daily Telegram digest ("snipe/elite/solana: 62% hit, +0.8% expectancy, n=41").
3. **Consume the numbers:** `MIN_SIGNAL_SCORE` and the auto-execute threshold stay manual, but the report is the *stated basis* for changing them — the dashboard shows expectancy next to each threshold. (Automated threshold adjustment is a non-goal this phase; measurement first.)
4. **Polymarket-specific truth:** when the indexer observes a market's resolution (REDEEM flow / Gamma `resolved` state), backfill `pnl_realized` for every trade in that market and recompute the involved wallets' Polymarket win-rate from resolutions. This is the highest-integrity skill signal in the system — wire it into composite scoring with its own weight.
5. **Latency attribution:** stamp `detected_at` (signal insert), `alerted_at`, `executed_at`; report p50/p95 detection→execution per chain. The Solana < 60 s standard is verified here, continuously, not claimed.

---

## 10. Phase 7 — Testing & acceptance gates

1. **Unit:** `parseExecutionConfig`; robinhood calldata encoding (golden-vector test against a known-good `exactInputSingle` encoding); polymarket price/size rounding to tick; risk-cap math; breaker trip/reset transitions.
2. **Integration (docker-compose, per chain):** seed wallet → fixture backfill → transactions rows assert → signal fires → paper trade persists → attribution row appears. This one test per chain would have caught the majority of the audit's criticals. Wire into CI (`pnpm test:integration`).
3. **Live certification checklists** (§5.3, §6.3 gates) executed manually with throwaway wallets, results pasted into `docs/certification/<chain>.md`, and only then the chain enters `LIVE_ENABLED_CHAINS`.
4. **Chaos checks:** kill the executor mid-live-trade (sweeper resolves); Redis restart (workers reconnect, no unhandled `'error'` crash); DB restart (pool error handler holds).
5. **Shadow validation:** one week of solana `live+shadow` → execution-quality report sanity (live within expected bps of shadow) before scaling any position sizes.

---

## 11. Rollout sequence

| Step | State after step |
|---|---|
| Phase 0 complete | Discovery feeds backfill; ingestion health visible; audit claims verified |
| Phase 1 complete | Per-chain modes live; all chains `paper`; solana certifiable to `live` |
| Solana → `live+shadow` | Real P&L flowing + execution-quality benchmark accumulating |
| Phase 2 + robinhood certification | Robinhood `live` behind tiny-size cap (`maxPositionPct` low) |
| Phase 3 + polymarket certification | Polymarket `live` on liquid markets only |
| Phase 5 + 6 complete | All three chains live-capable, risk-enforced, expectancy-measured |
| Steady state | Modes tuned per chain from the expectancy report — e.g. `{"solana":"live+shadow","polygon":"live","robinhood-chain":"live+shadow"}` |

At every step, **paper keeps running wherever live isn't certified** — the pipeline is never idle on any chain, and the paper track keeps generating the statistics that justify (or veto) each chain's promotion.

---

## 12. Non-goals

- General Polygon DEX indexing (Polymarket-proxy scope is correct; don't creep).
- New signal patterns before the existing 4 have measured expectancy.
- New chains before all 3 loops close.
- Automated threshold self-tuning (measure first; automate later).
- Hand-rolled order signing for Polymarket (official client only).
- Infinite ERC-20 approvals anywhere.

---

## 13. Definition of done

| Gate | Solana | Polymarket | Robinhood |
|---|---|---|---|
| Ingestion health metric + lag alarm | ✅ | ✅ | ✅ |
| End-to-end integration test in CI | ✅ | ✅ | ✅ |
| Signals carry chain-native context | token safety | market question/outcome/date | contract owner |
| Paper execution | Jupiter sim | book-walk sim | quoter sim |
| Live execution certified (checklist on file) | Trojan ✅ | CLOB v2 (Phase 3 gate) | UniV3 (Phase 2 gate) |
| `live+shadow` operational | ✅ | ✅ | ✅ |
| Risk caps enforced per chain | ✅ | ✅ | ✅ |
| Attribution rows + expectancy report include chain | ✅ | ✅ + resolution P&L | ✅ |
| Detection→execution latency measured | < 60 s target | reported | reported |

**The build is done when:** any of the three chains can be flipped between `off / paper / live / live+shadow` from the dashboard, takes effect within 30 s, every live fill is receipt-or-fill-verified, every trade lands in the attribution loop, and the nightly digest tells you — per pattern, per tier, per chain — whether the system is actually making money. That is the standard.
