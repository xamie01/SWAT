# SWAT Deep Audit Report

**Date:** 2026-07-15
**Scope:** Full codebase — all 9 services (`apps/`), both packages (`packages/db`, `packages/shared`), SQL migrations, root scripts, and infra config.
**Method:** 6 parallel audit slices (indexer / signal-engine + scorer / trade-executor + alert-service / API + web / db + shared / discovery + MCP + scripts), each reading every file in its slice, with findings verified against surrounding source. Top findings independently re-verified.

**Baseline:** `pnpm typecheck` clean (11/11 packages). All 31 unit tests pass (`@swat/shared` 8, `@swat/db` 8, `@swat/indexer` 15). Everything below is a runtime or logic defect invisible to the compiler and the current test suite.

---

## Executive summary

~70 verified findings. Three systemic root causes explain the majority of the criticals:

1. **Raw vs chain-prefixed address chaos.** The `${chain}:${rawAddress}` storage invariant is enforced inconsistently at every boundary. This single class breaks: API backfill enqueues, wallet history/holdings endpoints, token safety checks, the token blacklist, funding-graph discovery, funding clusters, the `backfill-usd` script, MCP wallet lookups, and DexScreener links in the UI.
2. **Non-Solana ingestion was never end-to-end tested.** The Polymarket, EVM, and Helius-webhook ingestion paths all crash or silently drop essentially everything.
3. **Live-trading paths contain stubs and placeholder code** that record fictitious fills as real trades.

Severity counts: **10 critical · 22 high · ~25 medium · ~25 low.**

---

## 1. CRITICAL

### 1.1 Trading — money at risk

#### C-T1. Robinhood live swap sends ETH with empty calldata — funds lost or guaranteed failure
`apps/trade-executor/src/index.ts:321-325`

```ts
client.sendTransaction({ to: ROBINHOOD_UNISWAP_V3_ROUTER, data: '0x', value: ... })
```

The comment claims "raw exactInputSingle transaction bytecode" but `data` is literally `'0x'`. The router constant (line 46, `0xE592427A...`) is the **Ethereum-mainnet** SwapRouter address copied verbatim and never verified on chain id 4663. Two scenarios:

- **(a)** If no contract exists at that address on Robinhood Chain, this is a plain value transfer — every live trade **permanently burns `size` ETH into a dead address**, and the tx hash is persisted as a *filled* trade and the signal marked executed.
- **(b)** If the router does exist, its `receive()` rejects non-WETH9 ETH, so gas estimation reverts and every robinhood live trade throws — executor useless, circuit breaker trips.

There is also no `waitForTransactionReceipt`, so even a mined-but-reverted tx is recorded as filled.

#### C-T2. Polymarket "live" execution is a stub that fabricates fills
`apps/trade-executor/src/index.ts:283-297`

`executePolymarketClob` never contacts the CLOB. With `EVM_PRIVATE_KEY` set and `TRADING_MODE=live`, it logs and returns `{ signature: 'pm-sig-<timestamp>' }`. `handleJob` (lines 461-469) then persists a **live, status='filled'** trade with the fake signature and calls `markSignalExecuted`. Consequences: operators see live polygon positions that don't exist; PnL/portfolio are corrupt; the rebuy cooldown then *blocks* any real execution of that token for 60 minutes. No order signing, side, or price logic exists at all in this "live" path.

#### C-T3. Live mode is the default for any TRADING_MODE typo
`apps/trade-executor/src/index.ts:14, 383`

`mode = process.env.TRADING_MODE ?? 'paper'` and the only check is `if (mode === 'paper')`. Any value other than exactly `paper` (`Paper`, `paper-trade`, `test`, trailing whitespace) routes to the **live-execution** block. The paper/live boundary should require exact `'live'` opt-in and throw on unknown values.

### 1.2 Ingestion — pipeline dead

#### C-I1. Polymarket persistence is 100% dead — `updated_at` column does not exist
`packages/db/sql/012_polymarket_markets.sql` + `packages/db/src/polymarket.ts:27,44`

Migration 012 creates `polymarket_markets` with only `created_at`, but `getPolymarketMarket` SELECTs `updated_at` and `upsertPolymarketMarket`'s `ON CONFLICT ... DO UPDATE` writes `updated_at = NOW()`. Every call throws `42703 column "updated_at" does not exist`. The indexer calls `getPolymarketMarket` for **every activity row** (`apps/indexer/src/polymarket.ts:62`) with no try/catch — the error propagates to the catch at `polymarket.ts:228` which rethrows, failing the BullMQ job. **100% of `chain: 'polygon'` backfills fail; zero Polymarket data is ever ingested.**

#### C-I2. Helius webhook ingestion is doubly non-functional
`apps/indexer/src/webhook.ts:31-45, 83`

- **Auth can never succeed:** Helius sends the configured `authHeader` string *verbatim* in `Authorization` — it does not compute an HMAC of the body. The code compares that static header against `HMAC-SHA256(secret, rawBody)`, which changes per request. No configurable secret can ever satisfy this → every genuine Helius webhook gets 401 → Helius retries → gives up. No real-time data, ever.
- **Payload shape mismatch:** even if auth passed, the handler reads `event.feePayer` / `event.accountData` (Helius **enhanced** webhook fields) but hands the event to `processTransaction`, which expects the **raw `getTransaction` jsonParsed** shape (`tx.meta.preTokenBalances`, `tx.transaction.signatures[0]`, `tx.blockTime` — all absent in enhanced payloads → every event returns `'skipped'`). Conversely, raw-format webhooks have no `feePayer` → `continue`. Either format silently processes 0 events.

#### C-I3. Wallets added via the API/web UI never backfill
`apps/api/src/index.ts:176, 184`

`enqueueBackfill(w.address, w.chain)` uses the row returned from `upsertWallet`/`listWallets`, where `address` is already chain-prefixed (`solana:ABC...`). The indexer worker passes that string straight to Helius `getSignaturesForAddress(["solana:ABC..."])` → invalid-pubkey RPC error → job fails. Same for `robinhood-chain:0x...` into viem `getLogs`. Only polygon survives (its handler strips the prefix). **Every wallet added via the web UI "Add Wallet" flow, and every "reindex", fails to backfill solana/robinhood wallets.**

#### C-I4. Polymarket token↔market linking can never succeed
`packages/db/src/polymarket.ts:66-75`

`linkTokenToPolymarketMarket` writes `polygon:${conditionId}` (8 + 66 = 74 chars) into `tokens.polymarket_condition_id VARCHAR(66)` → "value too long for type character varying(66)". Even if widened, `polymarket_markets.condition_id` is stored **bare** by the upsert functions, so the FK `REFERENCES polymarket_markets(condition_id)` rejects the prefixed value anyway. `getTokensByPolymarketCondition` also queries with the prefixed form. Condition IDs are market identifiers, not addresses — they should not be chain-prefixed at all. Triggered live at `apps/indexer/src/polymarket.ts:98,126`.

### 1.3 Signals — auto-trades on bad data

#### C-S1. Token safety checks are inert — prefix never stripped
`apps/signal-engine/src/safety.ts:64, 94, 116, 223`

`tokenMint` arrives chain-prefixed (`solana:ABC...`) from the detection queries and is passed **unmodified** to:

- Helius `getAccountInfo` → invalid pubkey → `null` → silently falls back to DB columns.
- Helius `getTokenLargestAccounts` → `null` → **top-10 concentration check never runs** (no flag, no warning).
- DexScreener `latest/dex/tokens/solana:ABC` → no pairs → `null` → only the soft `LIQUIDITY_UNVERIFIED` warning; the hard `LOW_LIQUIDITY_*` flag **can never fire**, so sub-$25k-liquidity rugs pass `isSafe` and get auto-traded (score ≥ 80).
- viem `readContract` with address `polygon:0x...` → throws → caught → `null` → EVM owner check degraded; `OWNER_ACTIVE` never fires.

(Contrast: `packages/shared/src/prices.ts` correctly does `tokenMint.split(':')[1]` everywhere.)

#### C-S2. Snipe pattern fires from ONE wallet
`apps/signal-engine/src/index.ts:185, 194`

The comment says "3+ wallets buy within 5 minutes" but the SQL is `HAVING COUNT(*) >= 3` — one wallet making 3 buys (or one buy split into 3 swap legs by the indexer) satisfies it. Base score 82 ⇒ always ≥ `MIN_SIGNAL_SCORE` (70) and ≥ the auto-trade threshold (80) ⇒ **auto-trade triggered by a single wallet's activity**. The other three patterns correctly use `COUNT(DISTINCT wallet_address)`.

#### C-S3. Accumulation re-buys the same token every hour for up to 7 days
`apps/signal-engine/src/index.ts:235, 251`

Detection window is 7 days but `dedupeMinutes: 60`. Once a cluster crosses $50k/3 sessions, the same rows keep matching every 15s tick; after each 60-minute dedupe expiry a *new* signal inserts, re-alerts, and — since score = 75 + round(confidence×10) ≥ 80 whenever confidence ≥ 0.5 — **re-queues a new buy of the same token every hour, up to ~168 duplicate buys** over the window.

---

## 2. HIGH

### 2.1 Trade executor & money handling

#### H1. Dynamic balance sizing floored at the static base — inverts risk sizing, can exceed wallet balance
`apps/trade-executor/src/index.ts:227, 238`

`Math.max(baseUsdc, Math.min(computedSize, maxUsdc))`. Wallet holds 20 USDC, risk 2% → computed 0.4, but `Math.max(100, 0.4)` sizes **100 USDC — 5× the wallet balance**. Balance-proportional sizing can never size *down*, only up — the feature does the opposite of its purpose exactly when it matters (small balances). Same for ETH (0.001 ETH balance → sizes 0.05 ETH).

#### H2. Paper Jupiter fills assume 9 output decimals — 1000× P&L error for 6-decimal tokens
`apps/trade-executor/src/index.ts:387-396` + `packages/shared/src/jupiter.ts:187`

`outputDecimals` is passed as `undefined` and defaults to 9. Most current Solana memecoins (all pump.fun mints) use 6 decimals. `tokenAmount = outRaw / 1e9` records 1/1000 of the real amount into `trades.token_amount`, so mark-to-market `pnl = token_amount * price - amount_usd` is off ~1000×. `getTokenDecimals()` exists in `packages/db/src/transactions.ts:71` and is never used here.

#### H3. ETH price lookup uses an invalid hex address — every robinhood trade persists `amount_usd = 0`
`apps/trade-executor/src/index.ts:100`

`fetchTokenPriceUsd('0x82aF49447D8a07e3bd95BD0d56f352415231Cl11')` — contains letter `l` (not hex) and is the wrong address anyway (that's a mangled Arbitrum WETH). Also unprefixed, so the price helper treats it as chain `'solana'`. All three price sources fail every time (3 wasted HTTP calls per trade), `getCachedEthPrice` returns null, and `persistTrade` writes `amount_usd = 0`, `token_amount = null` for every robinhood-chain trade — cost basis destroyed.

#### H4. Trojan live path: no timeout, no idempotency key, no retry — timeout-after-fill enables double-buy
`apps/trade-executor/src/index.ts:262-281`

The `fetch` has no AbortController (contrast `prices.ts`/`jupiter.ts`); a hung Trojan webhook stalls the concurrency-1 worker indefinitely. The body carries no `signalId`/client-order-id, so if Trojan fills the buy but the response times out/5xxs, the executor throws, `releaseSignalClaim` reverts the claim, no trade row exists (no cooldown record) — a re-signal or manual execute then re-claims and **buys again**. Note trade jobs are enqueued with no `attempts` (api:447, signal-engine:156) → BullMQ default 1: transient failures are never retried, so the released claim exists purely to enable the double-trade path, never a controlled retry.

#### H5. `releaseSignalClaim` reverts to invalid status `'active'`
`packages/db/src/trades.ts:130`

Signal lifecycle is `pending → executing → executed`; `'active'` is not a valid status (`SignalRecord.status` has no such member). After a failed execution: (a) nothing selects `'active'`, so the signal is never retried; (b) it leaves the partial dedupe index (`WHERE status = 'pending'`, migration 009), so a duplicate pending signal for the same token+pattern can be inserted → **potential double trade**. Should be `SET status = 'pending'`.

### 2.2 Ingestion & data correctness

#### H6. Token→USDC (and token→token) sells recorded as BUYs
`apps/indexer/src/parse.ts:190-192`

`direction` is `'sell'` only when `tokenOut === SOL_MINT`. Selling a memecoin for USDC yields `direction: 'buy'`, `targetToken = USDC`. Wallet sells $50k of BONK into USDC → DB records a *buy* of USDC; P&L exit legs are lost; signal-engine sees coordinated "buys" of USDC. The USD enricher explicitly handles USDC pairs, so this path is exercised in practice.

#### H7. Polymarket timestamps parsed as milliseconds — all trades dated January 1970
`apps/indexer/src/polymarket.ts:171`

`new Date(act.timestamp)` where the Data API returns Unix **seconds**. `new Date(1719397500)` = 1970-01-20. Once C-I1 is fixed, every Polymarket trade lands with a 1970 timestamp → recency windows in signal detection never match; `last_active` is garbage. Must be `new Date(Number(act.timestamp) * 1000)`. (If the API returns a digit-string, `new Date("1719397500")` is `Invalid Date` → insert throws → job crash.)

#### H8. Funding edges stored with BARE addresses — funding clusters and funding discovery permanently empty
`apps/indexer/src/index.ts:308` → `packages/db/src/relationships.ts:19`; consumed by `packages/db/src/clustering-queries.ts:36` and `discovery-queries.ts:29-42`

`extractFundingTransfers` yields raw pubkeys; `recordFundingEdge` inserts them unprefixed into `wallet_relationships`. Everything downstream joins against prefixed `wallets.address`: funding-based clusters are always empty; `findFundedUnknownWallets` always returns 0 rows (discovery logs "No new wallets found from funding graph" forever); `deleteWalletCascade` misses relationship rows.

#### H9. SOL never upserted on sells → FK violation aborts the whole backfill job
`apps/indexer/src/index.ts:238-247, 504`

`processTransaction` upserts `tokenIn` and `targetToken`; for a sell, `targetToken === tokenIn`, so `tokenOut` (SOL) is never upserted. On a fresh DB, `insertParsedTransaction` violates `token_out REFERENCES tokens(mint)` and throws. The backfill loop has no per-tx try/catch → the exception **fails the entire BullMQ job**, dropping all remaining transactions for that wallet.

#### H10. EVM zero-address pseudo-token never upserted → all native-ETH swaps silently dropped
`apps/indexer/src/evm.ts:264, 272, 311`

The received-only / sent-only branches use `0x0000...0000` as `tokenIn`/`tokenOut`, but nothing ever inserts `polygon:0x0000...` into `tokens`. FK violation → caught at `evm.ts:381` → counted as `skipped`. Every native-currency swap (a real trade) is silently lost.

#### H11. `transactions.amount_in/amount_out BIGINT` overflow on 18-decimal EVM amounts
`packages/db/sql/001_init.sql:44-45`; triggered by `apps/indexer/src/evm.ts:339-355`

Raw wei-scale strings: any value > 9.22e18 (i.e. **> 9.22 whole tokens** at 18 decimals) exceeds BIGINT → "value out of range for type bigint" → insert throws → skipped. Migrations 011/013 widened only varchar columns. Also poisons `findEarlyBuyers`' lamports threshold, meaningless in wei. Combined with H10, EVM backfill inserts almost nothing and reports only `skipped` counts. (Polymarket amounts are 6-decimal and stay in range.)

#### H12. `backfill-usd.ts` is a complete no-op
`apps/indexer/src/backfill-usd.ts:37-51`

`transactions.token_in/token_out` are stored chain-prefixed, but the script compares them to **bare** SOL/USDC mints. No row ever matches → every row falls into `skippedUnsupported`, `updated = 0`, exits claiming "Complete". USD-null rows are never healed.

#### H13. Cluster performance is never written — every auto-trade sizes at the 0.5× multiplier
`packages/db/src/clustering-queries.ts:121` (dead code); consumers at `apps/signal-engine/src/index.ts:15-22, 187, 200`

`updateClusterPerformance` has **zero callers** repo-wide. `wallet_clusters.avg_composite_score` / `total_realized_roi` are perpetually NULL → `getClusterTier` always returns the `'promising'` fallback → every auto-trade is sized at 0.5× — the exact bug the comment at `index.ts:9-14` claims was fixed. Snipe's ROI bonus (`COALESCE(total_realized_roi, 0)`) is always 0. Fix: call `updateClusterPerformance` per cluster at the end of the scorer batch.

#### H14. Token blacklist is a complete no-op
`apps/signal-engine/src/index.ts:74`

`opts.tokenMint` is prefixed (`solana:ABC...`); the web UI stores whatever the user pastes — a bare mint. `blacklist.includes(opts.tokenMint)` never matches. All the multi-format JSON parsing at lines 48-72 is wasted effort around a broken comparison.

#### H15. Migration 003 clobbers runtime config on every deploy/restart
`packages/db/sql/003_fix_clustering.sql:5-25`

Migrations re-run on every invocation (no tracking table). 003 uses `ON CONFLICT (key) DO UPDATE` for `signals`/`discovery`/`pruning` and **unconditional `UPDATE config`** for `risk` and `trading`. Any operator config change (enabling trading, tuning stop-loss, raising `min_signal_score`) is silently reset to hardcoded defaults every time migrate runs. The `trading` UPDATE also drops the `max_position_pct`/`max_daily_exposure_pct`/`min_liquidity_usd` keys that 001 seeded.

### 2.3 API & web

#### H16. Logs page SSE always fails → infinite reconnect + console.error spam every 3s
`apps/web/app/logs/page.tsx:66, 89` + `apps/api/src/index.ts:550`

Two independent causes (this is the most likely source of the reported console errors):

- `new EventSource(...)` **cannot send headers**, so no `X-Api-Key`. The auth hook exempts only `OPTIONS` and `/v1/health` → `/v1/logs/stream` returns **401**. Web reacts with `console.error('SSE Error:', err)` and reconnects every 3s, forever.
- Even with auth bypassed, `reply.sent = true` — in Fastify v5 `sent` is **getter-only** (verified in `node_modules/fastify/lib/reply.js:98-104`); the assignment throws `TypeError` right after `writeHead(200)`, killing the stream. Correct API is `reply.hijack()`.

Fix: query-param token (or cookie) for SSE auth, validated in-handler, plus `reply.hijack()`.

#### H17. `/v1/wallets/:address/history` and `/holdings` always return empty
`apps/api/src/index.ts:208-217, 233-250`

Both query `WHERE wallet_address = $1` with the **raw** address (a prefixed address fails `isValidAddressForChain` at line 206, so callers must pass raw), but `transactions.wallet_address` is stored prefixed. Raw never matches prefixed → `items: []` for every wallet, permanently.

#### H18. `DELETE /v1/wallets/:address` 500s for any wallet with history
`apps/api/src/index.ts:195`

Calls `deleteWallet` (plain `DELETE FROM wallets`). `transactions` and `cluster_memberships` FK-reference `wallets(address)` → FK violation → 500. `deleteWalletCascade` exists (`wallets.ts:86`) and is unused by the API.

#### H19. `/v1/discovery/from-token` inline early-buyer extraction always yields 0
`apps/api/src/index.ts:269-283`

`WHERE target_token = $1` with the raw mint vs prefixed `target_token` column → always 0 rows → `ingested` always 0; the discovery_log row records 0. (The queued on-chain scan path uses the raw mint correctly.)

#### H20. Performance page crashes on null `token_mint`
`apps/web/app/performance/page.tsx:148`

`trade.token_mint.slice(0, 8)` with no null guard; `trades.token_mint` is nullable and the `/execute` path can enqueue null. One such row → `TypeError: Cannot read properties of null (reading 'slice')` → server-component render failure → error digest in browser console.

### 2.4 MCP server — 3 of 7 tools can never succeed

Written against an imagined schema; every one of these fails on first call:

#### H21. `get_wallet_score` — nonexistent columns + raw-vs-prefixed lookup
`apps/mcp-server/src/index.ts:149, 162, 151, 165`

- Selects `w.confidence`, `w.avg_realized_roi` from `wallets` — neither exists (checked 001 + every ALTER in 002–014).
- Second query selects `c.avg_win_rate` from `wallet_clusters` — doesn't exist (only `avg_composite_score`).
- Queries `WHERE w.address = $1` with the raw pubkey against prefixed storage, never calling `resolvePrefixedAddress()` — even after fixing the columns, every lookup returns "not indexed yet".

#### H22. `get_performance` — three independent schema errors
`apps/mcp-server/src/index.ts:202-215`

- Open-positions query selects `direction`, `entry_price_usd`, `cost_basis_usd` on `signals` — those names exist only as computed aliases inside `pnl-queries.ts`.
- Fill query does `ORDER BY created_at DESC` on `trades` — the table has `executed_at`/`confirmed_at`, no `created_at`.

### 2.5 Other high

#### H23. Telegram HTML never escaped — Polymarket alerts crash and are permanently lost
`apps/alert-service/src/index.ts:26, 139-166`

`parse_mode: 'HTML'` with raw interpolation of `token.symbol`, `token.name`, `polymarketDetails.question`, `payload.warnings`. Polymarket questions routinely contain `<` (e.g. "Will ETH be <$3k?"); scam tokens put `<` in symbols. Telegram returns 400 "can't parse entities" → `sendTelegram` throws → all 4 retries fail identically → alert permanently lost. Also an HTML-injection vector (attacker-named token can inject markup into your alert channel).

#### H24. `discover-starter-pack.ts` "launch window" is not the launch
`discover-starter-pack.ts:215-219`

`getSignaturesForAddress` with `{limit: 1000}` and no `before` pagination returns the **newest** 1000 signatures; sorting ascending and taking the first 50 gives the oldest of the *most recent* 1000 txs — for the high-24h-volume tokens this tool selects, that's hours old, not launch. "Early buyers"/snipers are actually random recent traders. (The indexer's `discoverFromToken` pages back correctly.)

---

## 3. MEDIUM

### 3.1 Web dashboard

- **M1. Wallets page reads three fields the API never returns** (`apps/web/app/wallets/page.tsx:376, 384, 385` vs `packages/db/src/wallets.ts:16`): `wallet.wallet_score` → API returns `composite_score`; `wallet.total_roi` → API returns `realized_roi`/`unrealized_roi`; `wallet.last_active` → not in the SELECT list. Score badge, ROI, and last-active render blank for every wallet.
- **M2. Performance page renders "NaN%" with zero signal data** (`performance/page.tsx:35`): `/v1/trading/performance` returns `{win_rate: null}` when no `pnl_usd` rows exist (aggregate row of NULLs is truthy, so the `??` fallback never triggers); `parseFloat(null)` → NaN. Same for `pos.total_sol`/`total_usd` with legacy null rows.
- **M3. Three different API-key sources across the web app** — server pages use `process.env.API_KEY`; client pages use `process.env.NEXT_PUBLIC_API_KEY` (build-time inlined); logs page hardcodes `'swat-dev-key'`. Set a real `API_KEY` without `NEXT_PUBLIC_API_KEY` → all client pages show "Failed to fetch"; logs history 401s silently.
- **M4. Chain-prefixed `token_mint` leaks into UI and external links** — dexscreener hrefs like `dexscreener.com/solana/solana:ABC...` are dead links (`performance/page.tsx:95,147`); home page shows `solana:A...` as the token (`app/page.tsx:78`); signals page shows the full prefixed CA.

### 3.2 API

- **M5. 500 responses leak internal pg errors** — no custom error handler; non-UUID `:id` on cluster/signal routes leaks `invalid input syntax for type uuid`; unvalidated `before` on history leaks timestamp cast errors.
- **M6. `/v1/tokens/:mint` always 404s** — raw mint vs prefixed `tokens.mint`. (Unused by web; dead endpoint.)
- **M7. Manual execute can throw TypeError and feed the circuit breaker** (`api:439-451` + `trade-executor:346`): `token_mint` is nullable; `payload.tokenMint.includes(':')` throws on null → job fails → `consecutiveFailures++`; three bad manual executes trip the breaker and block real trades. The API payload also omits `clusterTier`, so every manual trade sizes at the 0.5× multiplier.

### 3.3 Trade executor & alerts

- **M8. `persistTrade` swallows all errors** (`trade-executor:156-158`): if `insertTrade` throws after a real live fill, the job still returns success — no trade row, signal stuck `'executing'` forever, and `hasRecentBuy` is blind to the position so another signal can immediately re-buy.
- **M9. Wrong USDC contract for Polymarket sizing** (`trade-executor:49, 216-222`): uses Circle-native USDC (`0x3c499c...`); Polymarket CLOB collateral is USDC.e (`0x2791Bca1...`). Balance reads 0 → combined with H1's `Math.max`, silently substitutes the full static base.
- **M10. Circuit breaker: stale trips + blocked jobs dropped forever** (`trade-executor:487-496`): `circuitBreakerTrippedAt` is set on the first job *after* the threshold, so 3 failures at 09:00 plus a job at 15:00 rejects trades until 15:05 despite 6 quiet hours. Jobs failed while tripped have attempts=1 → those signals are permanently dropped. State is in-memory, cleared on restart.
- **M11. Unknown-chain live path records a fictitious filled trade** (`trade-executor:431-469`): if `chain` matches no branch, `signature=null`, `executor='unknown'`, yet a live `status='filled'` row is written and the signal marked executed. No guard for unrouted chains.
- **M12. Alert links dead and always Solana-flavored** (`alert-service:247-253`): links use the **prefixed** mint (404s even for Solana), and DexScreener/Solscan/Birdeye links render for polygon and robinhood-chain signals too — wrong chain, wrong explorer, meaningless for Polymarket token IDs.
- **M13. No `'error'` listeners on BullMQ Workers** (`trade-executor:484-510`, `alert-service:260-291`): Workers emit `'error'` on connection problems; an unhandled EventEmitter `'error'` kills the process.
- **M14. Polygon/robinhood paper trades unpriceable** (`trade-executor:386-397`): Jupiter simulation is Solana-only; the fallback can't price Polymarket outcome tokens (decimal ERC-1155 IDs) → `price_usd=null`, `token_amount=null` — no share count, no 0-1 share-price semantics, PnL untrackable.

### 3.4 Signal engine & scorer

- **M15. Top-10 concentration divides by top-20 sum, not total supply** (`safety.ts:102-105`): `getTokenLargestAccounts` returns only ~20 accounts; top-10/top-20 is almost always > 60%, so once C-S1's prefix bug is fixed this would hard-flag virtually **every** token and block nearly all trades. Also counts LP/pool accounts as holders. Use `getTokenSupply` for the denominator.
- **M16. Scorer prune cascade-deletes wallets holding open positions** (`scoring-queries.ts:92-97, 160-166`): `getWalletMetrics` maps NULL win_rate/ROI to `0` and persists it; a `token-big` wallet with ≥5 trades but only **open** positions has `realized_roi = 0`, fails `realized_roi > 0`, and is cascade-deleted — destroying history for wallets that simply haven't sold yet (the code comment claims NULL protects them; it doesn't after scoring).
- **M17. Any post-scoring step failure aborts the rest of the nightly batch** (`scorer/src/index.ts:52-67`): pause/promote/reactivate/prune/cluster-generation are awaited bare; one rejection silently skips clustering + mark-to-market for the night.
- **M18. `tick()` guard released while detectors still running; only first error surfaced** (`signal-engine:396-406`): `Promise.all` rejects fast; `finally` clears `tickRunning` while the other three detectors are in flight → next tick overlaps them. Use `Promise.allSettled`.
- **M19. An error in `enqueueSignal` aborts remaining detections for that pattern that tick** (`signal-engine:197-211`, same shape in all four loops).

### 3.5 Discovery

- **M20. `discoverySeedToken` payload ignored — token-seeded discovery never happens; triple processing** (`discovery/src/index.ts:94-98`): the handler discards `{tokenMint}` and runs the full generic batch. `findEarlyBuyers` is dead code. Net effect of one `POST /v1/discovery/from-token`: API inline extraction (always 0 — H19) + indexer deep scan + an unrelated full funding/counterparty batch.
- **M21. Discovered wallets never enqueued for backfill** (`discovery:11-24`): only upserted — zero transactions, never scored, inert rows.
- **M22. Double-prefix corruption for non-Solana counterparties** (`discovery:41` + `discovery-queries.ts:67`): `findFrequentCounterparties` returns prefixed addresses; `upsertWallet` defaults chain to solana and writes `solana:polygon:0x...`.
- **M23. Nightly cron bypasses the in-flight guard** (`discovery:55-56`): calls `runNightlyDiscovery()` directly instead of the guarded wrapper → can overlap a manual/API-triggered run.

### 3.6 Infrastructure & shared

- **M24. `pool` has no `'error'` handler** (`db/src/client.ts:9`): an idle client emitting `'error'` (DB restart, network blip) crashes the Node process. No max/timeout config either.
- **M25. Logger crashes callers on circular objects** (`shared/src/logger.ts:59-72`): `JSON.stringify` in the console override is outside try/catch; logging an Axios error or pg client throws in the *caller's* stack.
- **M26. DexScreener price lookup has no chainId filter — cross-chain price bleed** (`shared/src/prices.ts:15-33`): takes the highest-liquidity pair regardless of chain; same 0x address on Ethereum/BSC/Polygon can be a different token. This is the *first* price source tried for every chain.
- **M27. CoinGecko routes robinhood-chain to the solana platform** (`prices.ts:37`): `chain === 'polygon' ? 'polygon-pos' : 'solana'` — combined with M26, robinhood-chain has no correct price source.
- **M28. No EVM address case normalization anywhere in the write path**: `polygon:0xAbC...` and `polygon:0xabc...` become distinct wallet rows — duplicate wallets, split stats, broken funding joins.
- **M29. Systemic double-prefix hazard** — `upsertWallet`, `getWallet`, `upsertToken`, `getTokenDecimals`, `updateTokenLaunchTimestamp`, `insertParsedTransaction` all check `startsWith(\`${chain}:\`)` instead of `includes(':')`: an already-prefixed address with a mismatched chain param produces `polygon:solana:abc` garbage. `resolvePrefixedAddress` uses the safe pattern; the others don't.
- **M30. `insertTrade` doesn't enforce the chain-prefix on `token_mint`/`wallet_address`** (`trades.ts:47`): a bare-mint caller stores a bare row → `hasRecentBuy(prefixedMint)` misses it (cooldown bypass → duplicate buys) and mark-to-market splits the position.
- **M31. `pnl-queries.ts` sell-exclusion has no status filter** (`pnl-queries.ts:44-49`): a single **failed/rejected** sell attempt permanently removes the position from mark-to-market.
- **M32. `claimSignalForExecution` guard too loose** (`trades.ts:108`): `status NOT IN ('executing','executed')` allows claiming `expired`/`rejected`/`ignored` signals. Should be `status = 'pending'`.
- **M33. EVM ingestion quality** (`evm.ts`): `getLogs` over a default 100k-block window exceeds public-RPC caps (~1k-3.5k) → backfill throws with zero rows (needs chunking); token metadata DB lookup uses bare mint vs prefixed column (DB-first path dead; 3 RPC reads per token per restart); every EVM token upserted with **fabricated** `mintAuthorityDisabled: true, freezeAuthorityDisabled: true` safety flags consumed by signal safety checks; `fetchTokenPriceUsd(targetToken)` called unprefixed → wrong-chain pricing.
- **M34. Webhook upsert flips `discovered` wallets to `manual`** (`webhook.ts:80` + `wallets.ts:49-52`): first webhook event reclassifies the wallet, breaking discovery-cohort pruning. (Moot until C-I2 fixed.)
- **M35. Migration 010 drops/recreates the tx dedupe index on every run** (`sql/010:64-67`): full rebuild + ACCESS EXCLUSIVE lock at every startup; a failure between DROP and CREATE loses dedupe protection.
- **M36. MCP: single global SSE transport** (`mcp-server:343-357`): a second `/sse` client overwrites `transport`; the first client's POSTs route to the wrong session. Any reconnect silently kills the previous session.
- **M37. MCP: unhandled rejections in async Express handlers** (`mcp-server:345-358`): Express 4 doesn't catch async throws; a rejection in `server.connect()`/`handlePostMessage()` crashes the process on Node 22.
- **M38. Starter pack: `getFunderAddress` looks at only the last 10 signatures** (`discover-starter-pack.ts:104-108`): finds an arbitrary recent counterparty, not the funding tx — the "Stealth Multi-Wallet Parent" pattern is computed from noise.
- **M39. Starter pack: win rate is always 100%** (`discover-starter-pack.ts:190-207`): `trackPatternMatch` is never called with `isWin=false`; `score` counts pattern-match invocations, not trades.

---

## 4. LOW

- **L1.** `trade-executor:354` — missing/undefined `score` passes the auto-execute gate (`undefined < 85` → false); garbage `AUTO_EXECUTE_MIN_SCORE` env → NaN comparison always false → auto-executes.
- **L2.** `alert-service:20-29` — no Telegram 429 `retry_after` handling (a 30s retry_after exhausts the 2s-exponential ×4 attempts); no 4096-char truncation.
- **L3.** Alert worker sets `alerted_at` but never `status='alerted'` → `/v1/signals/stats` "alerted" count is permanently 0.
- **L4.** `persistTrade` records `slippage_bps=1500` for every non-Jupiter trade (meaningless for CLOB fills); live 1500 vs paper 150 makes paper P&L systematically rosier.
- **L5.** `robinhoodChain.id = 4663` + router address are unverified assumptions in live money paths — no startup sanity check (e.g. `getBytecode`).
- **L6.** `signal-engine:174-195, 217-240` — snipe/accumulation lack `t.target_token IS NOT NULL`; a NULL group can emit a `tokenMint: null` signal → junk "Unknown" alert (trade blocked by safety).
- **L7.** Exit pattern comment claims "sells >50% of position"; SQL only checks seller-fraction ≥ 0.5 + $10k volume — a cluster trimming 5% fires a full exit signal.
- **L8.** `safety.ts:151-152` — chain detection reads the `tokens` row (defaults solana) instead of the mint prefix; a polygon token missing from `tokens` runs the Solana flow (fail-safe today).
- **L9.** No `setTypeParser` anywhere — pg NUMERIC/BIGINT arrive as **strings**; `triggerData`/queue payloads carry strings; engine arithmetic survives via `*`/`Math.*` coercion but any downstream `+` or formatting misbehaves. `getWalletStats` COUNTs typed as `number` are actually strings.
- **L10.** Clusters never shrink — both generators only INSERT/UPDATE; stale memberships persist forever, keeping dead wallets eligible for pattern detection.
- **L11.** `scoring-queries.ts:52-61` — early-entry denominator is all buys but numerator only buys on tokens with `launch_timestamp` → wallets trading unlabeled tokens structurally penalized toward 0.
- **L12.** `scoring-queries.ts` closed_positions — any partial sell marks the position fully closed: partial proceeds vs full cost basis → profitable-but-partially-exited positions counted as losses in win_rate/realized_roi.
- **L13.** `types.ts:32` — `SignalRecord.status` missing `'executing'` (written by claim) and `'active'` (written by H5) — type/DB drift.
- **L14.** All timestamps are `TIMESTAMP` without time zone; JS Date params serialize in process-local TZ vs `NOW()` in server TZ — interval predicates drift by the offset if they differ.
- **L15.** `wallets.ts:70` — `resolvePrefixedAddress` defaults unknown bare addresses to `solana:` even for obvious `0x...` — `deleteWallet('0xabc')` silently no-ops.
- **L16.** `jupiter.ts:191` — `outputDecimals ?? 9` (most SPL tokens are 6); `otherAmountThreshold` is max-input in ExactOut mode, not min-output — not distinguished.
- **L17.** `constants.ts` `DEFAULT_RISK_CONFIG.stopLossPct = 20` vs migration 003 seeding 25 — code/DB drift.
- **L18.** `migrate.ts` — no advisory lock (concurrent migrators race, e.g. both running 010's DROP/CREATE); no per-file transaction wrapping beyond pg's implicit one.
- **L19.** `signals.ts:44` — dedupe pre-check matches signals of *any* status, so a just-rejected signal suppresses a legitimate new one for the window.
- **L20.** `indexer/src/index.ts:384` — signatures with missing `blockTime` sort to position 0 (`?? 0`) → launch-window skew; launch timestamp silently not recorded.
- **L21.** `evm.ts:156` — self-transfers appear in both sent and received logs → classified as a token-for-itself "swap". `evm.ts:207` — ERC-721 Transfers share topic0; non-strict decode yields `0n` amount rows polluting stats.
- **L22.** `polymarket.ts:114` — outcome matched on 10-char truncated symbol; outcomes > 10 chars never match → duplicate fallback token splits one position across two mints.
- **L23.** `indexer/src/index.ts:561-565` — `WALLET_ADDRESSES` env seed can only add Solana wallets (no chain field; base58 validation silently rejects 0x). `index.ts:466` — `BACKFILL_SIGNATURE_LIMIT` > 1000 breaks the RPC call (max 1000, no clamp).
- **L24.** Web: array-index React keys on filterable lists (`clusters:156`, `logs:276` — stale row rendering); `logs:301` `log.service.substring` unguarded (one malformed Redis entry crashes the page); `wallets:27-56` error state never cleared + `setTimeout` retries without cleanup.
- **L25.** API: `POST /v1/signals/:id/ignore` returns `{ignored: true}` for nonexistent ids; `/v1/logs` `JSON.parse` per entry with no try/catch (one corrupt entry 500s the endpoint); `/v1/tokens/trending` registered after `/v1/tokens/:mint` (works — find-my-way prefers static — but violates the repo's stated convention).
- **L26.** MCP: `limit` unvalidated (`Number("abc")` → NaN → pg error; no upper clamp); blacklist read-modify-write race loses concurrent updates.
- **L27.** Starter pack: AMM pools/bonding-curve PDAs counted as "early buyers" (only System Program excluded); pairs missing `pairCreatedAt` bypass the 30-day age filter.
- **L28.** `_ingest_wallets.ts:23` — path resolved from `process.cwd()`, only works when invoked from `apps/scorer`; no validation the JSON is a string array; `WALLET_CHAIN=polygon` would mis-tag Solana wallets.
- **L29.** Env-var doc drift: `DEX_CHAIN_ID`, `WALLET_CHAIN`, `TOKEN_DISCOVERY_WINDOW`, `TOKEN_DISCOVERY_MAX_TOTAL_SIGNATURES`, `EARLY_BUYER_SLOTS`, `BIG_BUYER_SLOTS` read but undocumented; `REDIS_URL` doc omits discovery/scorer/mcp.
- **L30.** `start.sh` — hardcoded `pg_isready -U swat -d swat` (breaks if creds overridden); no `.env` existence check before migrate; `--stop` claims to stop app processes but only runs `compose down`. `docker-compose.yml` — obsolete `version:` key; no `restart:` policy on postgres/redis.
- **L31.** `prices.ts:1` — `SOL_MINT` constant is dead code.

---

## 5. Verified OK (checked, no issue found)

- **Migrations 001, 002, 004–009, 011, 013, 014** — fully idempotent (IF NOT EXISTS, ON CONFLICT seeds, DO-block guards); zero-padded filename ordering correct.
- **No SQL injection anywhere** — all user data through `$n` parameters; the only interpolations are typed constants.
- **`pnl-math.ts`** — division-by-zero, NaN, Infinity, negative-price all guarded; tests genuinely cover the edges. **`scoring.ts`** — clamping, weights, tier boundaries correct and covered.
- **`insertParsedTransaction` ON CONFLICT target** exactly matches the 010 dedupe index incl. NULL targets.
- **Queue/channel name alignment** — `swat-trades`, `swat-alerts`, `swat-backfill-wallet`, `swat-token-discovery`, and all `REDIS_CHANNELS` referenced consistently on producer and consumer ends; job payload field names match consumers.
- **Alert idempotency claim** (`alerted_at IS NULL` atomic UPDATE + release-on-error) correct.
- **Cross-chain contamination in detection queries** — not possible: `wallet_address` and `target_token` are both prefixed at insert, so grouping inherently separates chains. `(cluster_id, wallet_address)` uniqueness prevents join multiplication within a cluster.
- **`getWalletTokenDeltas`** — fee handling, dust threshold, wrapped-SOL folding correct. **`extractFundingTransfers`** — CPI dedupe + threshold correct (only the *storage* is broken, H8). **`baseUnitsToFloat`** — BigInt-safe.
- **Helius retry/backoff**, AbortController timeouts, per-signature error isolation in backfill/discovery batches; `discoverFromToken` pagination correct.
- **Webhook** fail-closed on missing secret; `timingSafeEqual` length handling correct (the *scheme* is wrong — C-I2 — but the crypto hygiene is fine).
- **`deleteWalletCascade`** — proper single-client transaction with release. **`insertSignalWithDedupe`** — partial-index ON CONFLICT inference valid.
- **Web**: no `.toFixed()`-on-string crashes (parseFloat/`*100` coercion first); no hydration-mismatch risks; all fetches try/caught; SSE client-side cleanup correct; auth hook covers all mutating routes with constant-time compare.
- **ioredis resubscribe-on-`ready`** pattern in signal-engine and discovery; run-guards sound for single-process use; `reactivateDormantWallets` avoids pause/reactivate oscillation.
- **MCP** parameterized SQL throughout; zod on string args; no `express.json()` conflict with SDK raw-body parsing. **Starter pack** Helius client 429/backoff/parsing sound.

---

## 6. Recommended fix order

1. **Kill the live-money hazards** (C-T1..T3, H4, H5, M11): require exact `TRADING_MODE === 'live'`, throw on unrouted chains, disable robinhood/polymarket live paths until real implementations exist, fix `releaseSignalClaim` → `'pending'`, add AbortController + `signalId` idempotency to the Trojan call.
2. **Centralize prefix handling** — one `prefixAddress()`/`stripPrefix()` pair in `@swat/shared`, applied at every boundary (API routes, safety.ts, backfill enqueue, funding edges, blacklist, MCP, backfill-usd). This single refactor fixes ~15 findings: C-I3, C-S1, H8, H12, H14, H17, H19, M6, M22, M28, M29, M33, and several lows.
3. **Schema fixes** (one new idempotent migration): add `polymarket_markets.updated_at`; widen `transactions.amount_in/out` to NUMERIC; stop prefixing condition IDs (C-I4); guard migration 003's config UPDATEs (seed-once sentinel).
4. **Signal correctness**: `COUNT(DISTINCT wallet_address)` in snipe (C-S2); accumulation dedupe ≥ detection window (C-S3); call `updateClusterPerformance` from the scorer (H13); fix top-10 denominator (M15) *together with* the safety prefix fix so trades aren't all blocked.
5. **Ingestion**: webhook auth → plain shared-secret compare + enhanced-payload parser (C-I2); Polymarket timestamp ×1000 (H7); upsert SOL/zero-address pseudo-tokens (H9, H10); sell-direction fix in `parse.ts` (H6); chunk EVM `getLogs` (M33).
6. **Web/UX cleanup**: SSE auth via query token + `reply.hijack()` (H16); field-name fixes (M1); null guards (H20, L24); unified API-key source (M3); `deleteWalletCascade` in the API (H18); Telegram HTML escaping (H23).
7. **MCP rewrite of the three broken tools** against the real schema (H21, H22).

---

*Full per-slice transcripts available in the session task outputs. Each finding above was verified against installed source, not inferred.*
