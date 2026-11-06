# WAKE LP Dashboard — Complete Build Record

**Workspace:** `/home/xahmie/Documents/SWAT` · **Package:** `@swat/lp` (`apps/lp`)
**Branch with all work:** `feat/lp-dashboard` · **Record date:** 2026-11-01

---

## 0. READ THIS FIRST — where everything lives right now

**Nothing was actually lost.** Every file, test, and live-verified change survives in git on the
**`feat/lp-dashboard`** branch. What happened:

- All LP development happened on `feat/lp-dashboard` (67 files under `apps/lp`).
- The working tree was later switched to `feat/multi-tenant-foundation`, which never tracked the
  `apps/lp` sources — so checking it out **removed the LP source files from disk** (only untracked
  `dist/` and `node_modules/` remain in `apps/lp/` on this branch).
- The newest work (Meteora repair, EVM tick bands, decimal normalization, stable-quote pricing,
  README status) is all inside commit **`2b9831b`** ("feat(s4-m3,lp): land master-attributed
  inventory and LP scanner work") on `feat/lp-dashboard`.

**Recovery — pick one:**

```bash
# Work on the LP branch again (restores everything):
git checkout feat/lp-dashboard

# Or pull just the LP directory into the current branch without switching:
git checkout feat/lp-dashboard -- apps/lp
```

---

## 1. Outcome summary

The LP microservice went from a fresh scaffold to a **live-verified, read-only discovery +
paper-mode operations service** across both chains:

| Capability | Solana / Meteora | Robinhood Chain (EVM) |
|---|---|---|
| Pool discovery | ✅ Live-verified (Meteora Data API `/pools`) | ✅ Live-verified (3 configured v3 pools) |
| Pool state decode | ✅ LbPair + BinArrays via raw RPC | ✅ slot0/liquidity/fee/tickSpacing via viem |
| Liquidity topology | ✅ DLMM bins (Q64.64 prices) | ✅ tick bitmap + signed liquidityNet walk |
| Exact active TVL | ✅ (API token prices + RPC bins) | ✅ (decimal-normalized bands + USDG $1 anchor) |
| Live ladder preview | ✅ End-to-end verified | ✅ Same code path (context from tick bands) |
| Volume / fee metrics | ✅ from API (`24h` window) | ❌ deferred (needs swap-log indexing) |
| Position ownership / execution | ❌ deferred (paper plans only) | ❌ deferred (paper plans only) |

**Final test counts:** `@swat/lp` 21 files / **180 tests** green; `tsc --noEmit` clean.
Earlier in the effort `@swat/db` stood at 847 tests and `@swat/shared` at 451 (both green).

---

## 2. Environment, credentials, and configuration used

| Item | Value / status |
|---|---|
| Helius Solana RPC key | Present in root `.env` (`HELIUS_API_KEY`); RPC `https://mainnet.helius-rpc.com/?api-key=<key>` |
| Fallback Solana RPC | `https://api.mainnet-beta.solana.com` (used successfully for the live-preview E2E run) |
| Meteora Data API | `https://dlmm.datapi.meteora.ag` (new; old host `dlmm-api.meteora.ag` returns 404) |
| Robinhood RPC (original) | `https://rpc.mainnet.chain.robinhood.com` — works for a few calls, then Cloudflare 403-challenges burst traffic |
| Robinhood RPC (final) | Alchemy: `https://robinhood-mainnet.g.alchemy.com/v2/<key>` in `.env` as `ROBINHOOD_RPC_URL` — handles the full tick walk |
| `ROBINHOOD_LP_POOL_ADDRESSES` | User added the three verified WETH/USDG v3 pools: `0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca` (1 bps), `0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a` (5 bps), `0xa9188730fe85be88ad499d7d52b099e800fb0334` (30 bps) |
| `ROBINHOOD_SANITY_TOKEN` | **Not** present in `.env`; code now defaults to the verified USDG address `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| `METEORA_API_URL` | Updated in `.env.example` and code default to `https://dlmm.datapi.meteora.ag` |
| Chain ID | Robinhood Chain `4663` (`0x1237`), verified live via `eth_chainId` |
| Token facts (live-verified) | WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (18 dp), USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dp) |
| Test pool (Solana) | `solana:5hbf9JP8k5zdrZp9pokPypFQoBse5mGCmW6nqodurGcd` (MET/USDC, both 6 dp) |

Build-handoff constraints stayed in force the whole time: no `pnpm build`/`dev`/`docker-compose up`/
`db:migrate`/`test:integration`; per-package `tsc --noEmit` and focused Vitest only; `TRADING_MODE=paper`,
`AUTO_EXECUTE=false`; never push without asking.

---

## 3. MCP servers and documentation sources

| MCP server | URL | Location | Role in this build |
|---|---|---|---|
| `pmdocs` (Polymarket docs) | `https://docs.polymarket.com/mcp` | `/home/xahmie/Documents/SWAT/.mcp.json` | Pre-existing; not needed for LP work |
| **Meteora docs MCP** | `https://docs.meteora.ag/mcp` | user-level ZCode config (`~/.zcode/cli/config.json`) — **added by the user this session** | Prompted the docs-driven repair of the Solana scanner |

Documentation pages actually consumed (via the Meteora docs site the MCP points at):

- `https://docs.meteora.ag/llms.txt` — index; pointed at the DLMM Data API pages
- `https://docs.meteora.ag/developer-guides/dlmm/api-reference/overview.md` — production base URL `https://dlmm.datapi.meteora.ag`, dev `https://dlmm.dev.metdev.io`, metric windows `5m/30m/1h/2h/4h/12h/24h`
- `https://docs.meteora.ag/api-reference/dlmm/pools/pools.md` — full `GET /pools` contract: params (`page`, `page_size` ≤ 1000, `query`, `sort_by`, `filter_by`), envelope `{ total, pages, current_page, page_size, data }`, nested `token_x`/`token_y` (with `price`), `pool_config.bin_step`, `pool_config.base_fee_pct`, windowed `volume`/`fees`/`protocol_fees`/`fee_tvl_ratio`

The old endpoint `https://dlmm-api.meteora.ag/pair/all` was probed directly (curl): DNS resolves,
TLS completes, but the path returns **HTTP 404** — retired, not blocked.

---

## 4. Skills installed (Uniswap)

```
npx skills add Uniswap/uniswap-ai --agent '*' -y
```

- First attempt without flags stopped at the interactive skill-picker (no TTY); rerun with
  `--agent '*' -y` installed all **18 skills**.
- Installed to `/home/xahmie/Documents/SWAT/agent/skills/` and recorded in `skills-lock.json`
  (source `Uniswap/uniswap-ai`, per-skill hashes).
- Skills: `configurator`, `copy-trade`, `dca-bot`, `deployer`, `index-bot`, `liquidity-planner`,
  `lp-integration`, `pay-with-any-token`, `pay-with-app`, `permissioned-pools-configurator`,
  `permissioned-pools-deployer`, `permissioned-pools-issuer`, `swap-integration`, `swap-planner`,
  `v4-hook-generator`, `v4-sdk-integration`, `v4-security-foundations`, `viem-integration`.
- **`lp-integration` was loaded and used** for the EVM work. Key guidance taken from it: keep the
  integration read-only until execution is deliberately certified; the hosted Uniswap LP API
  (`https://liquidity.api.uniswap.org`) is one option but not required for on-chain pool reads;
  chain ID `4663` is in the LP API's supported set. The EVM repair was implemented as direct viem
  contract reads instead of the hosted API, per the repo's no-new-dependency convention.

---

## 5. Phase-by-phase: what was built and how

### Phase 1 — Audit of `apps/lp` (prior session, committed)

A full vet of the package produced **12 findings**, severity-ordered: unreachable code paths,
double-priced wallet valuation, unanchored curve weights, `building` positions invisible to the
monitor, unknown-risk treated as clean, missing service wiring (worker start order, CORS, job IDs),
missing user routes (close, wallet on-ramp), dependency issues (fastify caret regression, unused
`@solana/web3.js`), and DB-layer hardening gaps.

### Phase 2 — Fix pass (9 conventional commits, all on `feat/lp-dashboard`)

| Commit | Content |
|---|---|
| `243b7bd` fix(db) | `getLpPositionAnyOwner` (cross-tenant, throws without `crossTenantScope`), observation validation, tracked-wallet poolAddress validation + `toSafeNumber` float64 guard |
| `df12db0` fix(lp) | Paper builds transition `building → active` so the monitor can see them |
| `7be20c1` fix(lp) | Curve weights anchored at the current price (`RungWeightAnchor`), bidask made symmetric |
| `9ea6d4c` fix(lp) | Wallet positions price each leg once (removed `× currentPrice` double-count) |
| `05af95b` fix(lp) | Unmeasured risk/liquidity treated as *unknown*, not clean (`skippedNoChecks`, `activeTvl <= 0 → null`) |
| `65d9bb7` fix(lp) | Service wiring: workers start before cron, monitor job IDs unique, 7-day stale-pool prune, CORS allowlist, cache-honest `anchor: null` |
| `59a364b` feat(lp) | `POST /v1/lp/positions/:id/close`, `POST/DELETE /v1/lp/wallets` (service-only), more deploy errors mapped to 400 |
| `c3109c8` chore(lp) | `fastify` pinned exact `5.8.5`, removed unused `@solana/web3.js` |
| `4227b57` docs(lp) | README audit-fix documentation + wired-but-inert boundary |

### Phase 3 — Live verification of the Solana path (read-only scripts)

Scripts in `/tmp` (tsx, absolute imports into `apps/lp/src`):

1. **`live-bins.mjs`** — Helius RPC → `createRpcSolanaBinSource` on MET/USDC
   `5hbf9JP8…`: 21 bins, activeBinId −618, binStep 20; decoded price `0.29090292878111695`
   vs theoretical `(1+20/10000)^-618 = 0.2909029287811166` → ratio `1.000000000000001` **PASS**;
   active TVL (±10 bins) **$35,163.99**.
2. **`live-meteora-api.mjs` / `-v2.mjs`** — Meteora REST fetcher → **FAIL: `fetch failed`**;
   curl confirmed `dlmm-api.meteora.ag/pair/all` → HTTP 404. Diagnosed as endpoint retirement.
3. **`live-preview-e2e-v3.mjs`** — `createLiveContextSource` → `buildLivePreview`
   (`tight-spot-scalp`, $1,000) on the same pool (now activeBinId −414, price `0.43728…`):
   5 rungs, weights sum exactly 1, allocations sum exactly $1,000, all `liveLiquidityShare`
   non-null (Σ = 0.4771), zero warnings → **PASS**.

### Phase 4 — Meteora API repair (docs-driven)

Rewrote `apps/lp/src/scanner/meteora-pools.ts` against the documented Data API:

- Base `https://dlmm.datapi.meteora.ag`, path `/pools`, params `page`/`page_size`/`query`/`sort_by=volume_24h:desc`.
- Paginated envelope with shape validation (`isApiResponse`); malformed rows skipped, not fatal.
- Bounded pagination so `maxPairs` works past the 1,000-row page cap and never over-fetches.
- Field mapping: `token_x.address`/`token_y.address`, `pool_config.bin_step`,
  `pool_config.base_fee_pct`, `volume['24h']`, `fees['24h']`; `fees7d: null` (no 7d window exists).
- **Fee-unit correction:** `base_fee_pct` is a *percent* (`0.04` = 0.04 %) → bps = `× 100`.
  The old fraction math (`× 10 000`) would have printed 400 bps.
- API token prices (`token_x.price`, `token_y.price`) become the default active-TVL price source;
  explicit injected `tokenPrices` still win.
- Runtime default + `.env.example` + README updated to the new host.

Live rerun (`live-meteora-repaired.mjs`): two real SOL-USDC pools — feeBps 4 and 1, TVL
$4.73 M / $734 K, **exact** active TVL $17.14 M / $1.84 M, fees24h $10 498 / $2 276,
feeApr24h 0.22 % / 0.31 % → **PASS**. Suite grew 167 → **171** tests.

### Phase 5 — Robinhood Chain: pool-state verification

- `.env` gained the three WETH/USDG pool addresses (user action).
- `live-robinhood-check.mjs`: all three pools read successfully — feeBps 1/5/30, tickSpacing
  1/10/60, ticks ≈ −197 800, decimals 18/6, price ≈ $2 570-2 572, chain-prefixed normalized
  output correct. `liquidityBands` still returned `[]` (stub) → active TVL inexact.
- Raw `eth_call` probes (token0/token1/slot0) proved the contracts fine when viem hit a transient
  `fetch failed`; later bursts met Cloudflare **403 challenge pages** on the public RPC.

### Phase 6 — Uniswap v3 tick-band reconstruction (the core EVM build)

`apps/lp/src/scanner/robinhood-pools.ts` gained:

- ABI: `tickBitmap(int16) → uint256`, `ticks(int24) → (liquidityGross, liquidityNet int128, …, initialized)`.
- Pure helpers (exported, unit-tested): `compressedTick` (floor division so negative ticks
  compress correctly), `bitmapPosition` (word/bit, negatives into word −1 bit 255…),
  `initializedTicksFromBitmap` (isolates lowest set bits, sorted output).
- `reconstructTickBands`: anchors the current band at the pool's live in-range `liquidity()`,
  walks **up** adding signed `liquidityNet` at each boundary and **down** subtracting it,
  generates *every* tick-spacing boundary in the window (not just initialized ticks), filters
  empty bands, clips to the requested range.
- `liquidityBands()` in the viem reader: reads the bitmap words covering ±range, enumerates
  initialized ticks, then reads `ticks()` **serially** (reduce-chain) — the parallel version
  tripped RPC timeouts.

Three test failures were caught and fixed during development (bitmap sort order; missing
intermediate spacing boundaries; downward-walk direction). Suite grew 171 → **176**.

First live run on the public RPC died on Cloudflare 403 mid-walk. After the user supplied the
Alchemy RPC, `live-robinhood-bands.mjs` returned **2 400 bands (1 bps pool), 240 (5 bps),
41 (30 bps)** → walk verified live.

### Phase 7 — Decimal normalization (the 1e24 bug)

The same live run printed active TVL ≈ **5.75e24 USD** — raw Uniswap liquidity units were being
priced as whole tokens. Fix in `apps/lp/src/scanner/active-tvl.ts`:

- `UniswapActiveTvlContext` gained optional `baseTokenDecimals`/`quoteTokenDecimals`
  (default 0 keeps existing fixtures human-scale); band amounts are divided by `10^decimals`
  before USD pricing; decimals validated to 0..80. (A stray non-ASCII typo in the range guard
  was caught and corrected.)
- `createRobinhoodPoolFetcher` passes the pool's live `token0Decimals`/`token1Decimals` through.
- Regression test models WETH-18/USDG-6 raw units vs human units and asserts equality.

`live-robinhood-one-pool.mjs` (1 bps pool, 2 400 bands): active TVL **$16 972 701.36**, exact →
**PASS**. Suite grew 176 → **177**.

### Phase 8 — Stable-quote pricing (production USD path without an oracle)

`RobinhoodPoolFetcherOptions.stableQuoteToken`: when the pool's quote token is the configured
stable (USDG), quote = $1 and base USD = `currentPrice × 1`; explicit `priceSource` always wins;
unknown pairs stay unpriced (`activeTvlExact: false`) rather than inventing numbers. Runtime
wiring in `index.ts` uses `ROBINHOOD_SANITY_TOKEN ?? '0x5fc5360…d168'` (the verified USDG).

Two live runs failed with `activeTvlUsd: 0` because the *script* passed the unset env var through
(bypassing the new code default) — rerun with the USDG address explicit:
**$13 685 637.21 exact → PASS**. Suite grew 177 → **180**.

### Phase 9 — README capability boundary

`apps/lp/README.md` gained a **"Current capability boundary"** section (working-now vs
intentionally-deferred) and the "Runtime-unproven" list was corrected: both chains' live reads are
now verified; volume/fee metrics remain the honest gap.

---

## 6. File-by-file index

### `apps/lp` source (all on `feat/lp-dashboard`, newest work in `2b9831b`)

| File | Change |
|---|---|
| `src/scanner/meteora-pools.ts` | Rewritten for Data API `/pools`: envelope types + validation, pagination, nested-field mapping, percent→bps, API token prices, `fees7d: null` |
| `src/scanner/meteora-pools.test.ts` | 8 tests: envelope mapping, fee units, API-price TVL, override precedence, query/pagination, `maxPairs: 0`, malformed rows, 503, invalid payload |
| `src/scanner/robinhood-pools.ts` | `tickBitmap`/`ticks` ABI; `compressedTick`, `bitmapPosition`, `initializedTicksFromBitmap`, `reconstructTickBands`; serial tick reads; decimals passed to TVL; `stableQuoteToken` fallback |
| `src/scanner/robinhood-pools.test.ts` | 13 tests: compression, bitmap positions/enumeration, up/down walks, normalization, fallback precedence, unknown-pair refusal, v3 conventions, volume passthrough, v4 tag |
| `src/scanner/active-tvl.ts` | `UniswapActiveTvlContext` decimals + normalization + validation |
| `src/scanner/active-tvl.test.ts` | WETH/USDG decimal regression |
| `src/index.ts` | `METEORA_API_URL` default → `dlmm.datapi.meteora.ag`; `stableQuoteToken` wired with USDG default |
| `README.md` | Capability-boundary section, corrected runtime-status, `METEORA_API_URL` row |
| (earlier fix-pass files) | `builder/build-position.ts`, `builder/ladder-plan.ts`, `builder/live-preview.ts`, `builder/live-context.ts`, `wallets/solana-positions.ts`, `risk/risk-pass.ts`, `risk/solana-checks.ts`, `risk/evm-checks.ts`, `scanner/ranking.ts`, `monitor/evm-rebalance.ts`, `monitor/monitor-job.ts`, `routes.ts`, `package.json`, plus their tests |

### Repo-level

| File | Change |
|---|---|
| `.env.example` | `METEORA_API_URL=https://dlmm.datapi.meteora.ag`; earlier: `LP_CORS_ORIGIN=` |
| `skills-lock.json` | 18 Uniswap skill entries (installer-generated) |
| `agent/skills/*` | 18 new skill directories with `references/` (installer-generated) |
| `packages/db/src/lp-positions.ts`, `lp-tracked-wallets.ts` | Audit-fix hardening (`getLpPositionAnyOwner`, validation, `toSafeNumber`) |

### Live-test scripts (`/tmp`, throwaway, not committed)

`live-bins.mjs`, `live-meteora-api.mjs`, `live-meteora-api-v2.mjs`, `live-preview-e2e.mjs`,
`live-preview-e2e-v2.mjs`, `live-preview-e2e-v3.mjs`, `live-meteora-repaired.mjs`,
`live-robinhood-reader.mjs`, `live-robinhood-check.mjs`, `live-robinhood-bands.mjs`,
`live-robinhood-one-pool.mjs`, `live-robinhood-one-pool-fallback.mjs`.

---

## 7. Live test matrix

| # | Script | Target | Result |
|---|---|---|---|
| 1 | `live-bins.mjs` | Helius RPC, MET/USDC bins | **PASS** — price ratio 1.000000000000001; TVL $35 163.99 |
| 2 | `live-meteora-api*.mjs` | old REST API | **FAIL** — `/pair/all` 404 (endpoint retired) |
| 3 | `live-preview-e2e-v3.mjs` | full preview chain | **PASS** — 5 rungs, Σweights 1, Σalloc $1 000, Σshare 0.4771 |
| 4 | `live-meteora-repaired.mjs` | new Data API + RPC bins | **PASS** — 2 pools, feeBps 4/1, exact TVL $17.1 M/$1.84 M |
| 5 | `live-robinhood-check.mjs` | 3 v3 pools state | **PASS** 3/3 — bands still stubbed |
| 6 | raw `eth_call` probes | pool contracts | **PASS** — token0/token1/slot0 verified |
| 7 | `live-robinhood-bands.mjs` (public RPC) | tick walk | **FAIL** — Cloudflare 403 after burst |
| 8 | `live-robinhood-bands.mjs` (Alchemy) | tick walk | **PASS** — 2 400/240/41 bands; exposed 1e24 bug |
| 9 | `live-robinhood-one-pool.mjs` | decimal fix | **PASS** — TVL $16 972 701.36 |
| 10 | `live-robinhood-one-pool-fallback.mjs` | USDG $1 anchor | **PASS** (3rd run) — TVL $13 685 637.21; first two runs failed on unset env passthrough |

---

## 8. Verification progression

| Checkpoint | Command | Result |
|---|---|---|
| After Meteora repair | `pnpm --filter @swat/lp test` | 21 files / **171** tests ✅ |
| After tick bands | same + `tsc --noEmit` | **176** tests ✅, types clean |
| After decimal fix | focused suites | **177** tests ✅ |
| Final | full suite + typecheck | **180** tests ✅, `tsc --noEmit` clean |

Earlier baseline (prior session): lp 167 · db 847 · shared 451 — all green.

## 9. Commit map (branch `feat/lp-dashboard`)

```
fe020ac test(integration): repair runtime fixture drift          ← branch tip
7f3efaa docs: consolidate the three build trackers
2b9831b feat(s4-m3,lp): land master-attributed inventory and LP scanner work
         ↑ contains ALL of this session's work: Meteora /pools repair,
           tick bitmap + bands, decimal normalization, stable-quote pricing, README
b67469d feat(copy-trade): read-only lot enumeration (S4-M3)
4227b57 docs(lp): audit-fix documentation                         ← 9 audit-fix commits
c3109c8 chore(lp): pin fastify exact, drop @solana/web3.js          (243b7bd … 4227b57)
59a364b feat(lp): close endpoint + wallet on-ramp
65d9bb7 fix(lp): service wiring hardening
05af95b fix(lp): unknown ≠ clean
9ea6d4c fix(lp): price each leg once
7be20c1 fix(lp): anchored curve weights, symmetric bidask
df12db0 fix(lp): paper builds leave `building`
243b7bd fix(db): LP read/observation hardening
```

On the current checkout (`feat/multi-tenant-foundation`), the Uniswap skills and the LP plan file
were committed separately (`9f08a80 massive changes`, `8471f0c recent changes`); the LP *sources*
belong to `feat/lp-dashboard` only.

---

## 10. What remains (deliberately deferred)

1. **Robinhood volume/fee metrics** — swap-log indexing or an indexed provider; `volume24h`/`fees24h` are 0 until then.
2. **Production price oracle** for arbitrary EVM pairs (USDG-$1 anchor covers WETH/USDG only).
3. **Position ownership**: Meteora position-account reader; Uniswap v3 position-NFT reader (wallet indexer Track D against live wallets).
4. **Live execution**: Meteora SDK/tx-builder replacement; v3 NFPM mint/increase/decrease/collect calldata; approvals/Permit2; simulation; receipt recovery — all behind `resolveChainMode` + certification.
5. **Uniswap v4** on Robinhood Chain — label only today; needs PoolManager address, pool IDs, state-view ABI.
6. **Full-stack integration run** — Postgres migrations (059/060 never applied), Redis/BullMQ workers, end-to-end API flows in a real environment.
7. **RPC hygiene** — batching/multicall for the tick walk; backoff for provider limits.

*Guardrails unchanged throughout: paper mode everywhere, no keys added, no execution paths touched.*
