# SWAT Multi-Venue Expansion: Polymarket + Robinhood Chain

**Scope:** What it takes to add wallet-tracking, signal generation, and (optionally) execution for Polymarket and Robinhood Chain alongside SWAT's existing Solana pipeline.

**Researched:** July 2026. Robinhood Chain is 12 days old at time of writing (mainnet: July 1, 2026) — treat any numbers in this doc as a snapshot, not a constant. Re-verify before building.

---

## 0. How SWAT is built today (baseline, so the deltas below make sense)

SWAT is a pnpm/Turborepo monorepo of seven services (`indexer`, `scorer`, `signal-engine`, `trade-executor`, `alert-service`, `api`, `web`) sharing two packages (`db`, `shared`). The pipeline is Solana-specific at the schema level, not just the RPC level:

| Piece | Current implementation | Why it's Solana-specific |
|---|---|---|
| `wallets.address` | `VARCHAR(44)` | Solana base58 pubkey length |
| `transactions.signature` | `VARCHAR(88)` | Solana base58 tx signature length |
| `transactions.token_in/token_out` | FK to `tokens.mint` | SPL token model (swap pairs) |
| `transactions.program_id`, `.slot`, `.block_time` | Solana runtime concepts | No EVM equivalent (contract address / block number / block timestamp instead) |
| Indexer data source | Helius RPC (enhanced tx API + webhooks) | Solana-only provider |
| `signal-engine/safety.ts` | Queries Helius `getAccountInfo` for `mintAuthority` / `freezeAuthority` | SPL-token-specific fields — **do not exist on ERC-20 or CTF conditional tokens** |
| `trade-executor` | Trojan bot webhook (Solana Telegram sniper bot) | Solana-only execution channel |
| Redis channels (`REDIS_CHANNELS`, `packages/shared/src/constants.ts`) | `swat:wallet:swap`, `swat:signal:detected`, etc. | Chain-agnostic *names*, but payloads currently assume Solana shapes |
| Pattern detection (snipe/accumulation/rotation/exit) | Generic time-windowed cluster-trade logic | **This part is chain-agnostic already** — the real asset here |

**The one part of SWAT that's genuinely reusable with zero conceptual change:** the pattern-detection and scoring philosophy (composite score, tier, cluster confidence, snipe/accumulation/rotation/exit definitions). Everything else in the table above needs a new adapter, a schema extension, or both, for each new venue.

**Design decision to make once, before touching either venue:** add a `chain` (or `venue`) discriminator column to `wallets`, `transactions`, and `tokens`/`markets` now, rather than bolting it on per-venue later. Suggested values: `solana`, `polygon` (Polymarket), `robinhood-chain`. Do this as the first migration regardless of which venue you build first — both integrations below depend on it.

---

## Part A — Polymarket

### A1. What it is, architecturally

Polymarket is a prediction-market exchange on **Polygon** (chain ID 137). Markets are Yes/No (or multi-outcome) conditional tokens built on Gnosis's Conditional Token Framework (CTF). Shares trade continuously between $0.00 and $1.00 and are worth exactly **$1.00 or $0.00** at resolution — this is the single biggest architectural difference from Solana meme coins, and it changes your P&L math, not just your data source.

### A2. Data sources (all free, no API key for reads)

| API | Base URL | Auth | What it gives you |
|---|---|---|---|
| **Gamma API** | `gamma-api.polymarket.com` | None | Market/event metadata: title, resolution rules, end date, `clobTokenIds`, volume, liquidity |
| **Data API** | `data-api.polymarket.com` | None | Per-wallet **positions**, **trades**, **activity**, holder data, open interest, leaderboard rankings by profit/volume |
| **CLOB API** | `clob.polymarket.com` | None for reads; EIP-712 + HMAC for orders | Order book, midpoint, spread, price history; order placement/cancellation |
| **Subgraph** (The Graph) | via Goldsky | None | Alternative on-chain query path for trades/positions/market state |

The Data API is the direct equivalent of your `discover-starter-pack.ts` + Helius combo: it's keyed by wallet (proxy) address and returns positions with unrealized P&L plus full trade history — Polymarket has effectively already built the "find profitable wallets" discovery layer for you via its public leaderboard endpoint. A functioning whale-tracking/copy-trading ecosystem already exists around this API, so the approach is proven, not speculative.

**2026 API changes worth knowing before you build:**
- **CLOB V2 hard cutover (April 28, 2026):** new Exchange contracts, new order struct, V1 SDKs/signed orders no longer work.
- **Collateral migrated from USDC.e to pUSD** (an ERC-20 1:1 backed by USDC) — API-only traders wrap via a Collateral Onramp.
- **Trading uses a proxy-wallet architecture:** your EOA authorizes a proxy (Gnosis Safe–style or Magic-link), and the proxy executes trades. Four signature types exist (EOA, POLY_PROXY, GNOSIS_SAFE, POLY_1271); POLY_1271 deposit wallets are now recommended for new API users.
- **No testnet/sandbox** — all API calls hit production. Start with $1–5 test positions.
- Rate limits: CLOB ~9,000/10s (auth), Gamma ~4,000/10s (public), Data ~1,000/10s (public).

### A3. Schema changes

- Add `chain = 'polygon'` to the new discriminator column (see §0).
- Polygon addresses are `0x` + 40 hex = 42 chars — fits inside your existing `VARCHAR(44)` without a width migration.
- **Replace the token/mint model with a markets/outcomes model.** You need a new table roughly shaped like:
  ```
  polymarket_markets (
    condition_id, question, slug, end_date, resolution_source,
    outcome_count, clob_token_ids JSONB, status, resolved_outcome
  )
  ```
  A "trade" becomes a buy/sell of a specific outcome token at a price between 0–1, not a `token_in`/`token_out` swap pair.

### A4. Scorer — new P&L model required

Solana ROI is continuous (token price drifts). Polymarket P&L is **binary at resolution**: a share is worth $1 or $0, full stop, once the market resolves. Your win-rate/ROI/early-entry formulas need a resolution-aware variant:
- **Realized P&L** only exists after resolution (or after selling before resolution at market price — still meaningful, but a different calculation path than "resolution payout").
- "Early entry" for Polymarket means entering a market at a favorable price *before* the crowd converges toward 0 or 1, not "early after token launch."
- Positions in **unresolved** markets are unrealized by definition and carry **resolution risk** (see §A6) that your existing unrealized-ROI math has no concept of.

### A5. Signal-engine — pattern translation

Good news: your four patterns map onto Polymarket reasonably directly, since "cluster of wallets acting on the same asset within a time window" is venue-agnostic:

| Solana pattern | Polymarket analogue |
|---|---|
| Snipe (3+ buys, 5 min) | 3+ cluster wallets buy the same outcome within N minutes of a market being created or a news event |
| Accumulation | Cluster steadily buys the same outcome across days with rising size |
| Rotation | Cluster exits market A, enters market B within an hour (thematically related markets, e.g. election-adjacent) |
| Exit | 50%+ of cluster sells >50% of position within an hour — often a leading indicator ahead of resolution |

### A6. Safety checks — completely different risk model

Your `safety.ts` currently checks `mintAuthority`/`freezeAuthority` via Helius. **Neither concept exists in Polymarket's CTF.** The real risk here is **resolution risk**, and it's substantial enough that it should gate signal confidence the same way mint-authority checks do today:

- Polymarket resolution runs through **UMA's Optimistic Oracle**: a proposer posts a $750 USDC bond with a proposed outcome; if undisputed, it finalizes after a **2-hour challenge window**. If disputed, it escalates to a **token-weighted vote by UMA holders**, taking **4–7 days**.
- This is not a theoretical risk. In March 2025, a single actor controlling 25% of UMA voting power pushed a $7M market to an incorrect resolution — the mechanism is bonded and permissionless, not infallible. A May 2026 WSJ investigation found that in most disputed markets, more than half of UMA votes came from the ten largest wallets, and Polymarket logged 1,150+ disputed markets in just the first five months of 2026.
- **Practical safety checks to build:** days-to-resolution (closer = lower resolution-timing risk but higher "priced-in" risk), whether the market has ever been disputed before, orderbook depth/liquidity at the current price, and whether the market is in an active dispute window (Data/Gamma API flags this — don't treat an unresolved market as settled even if the real-world outcome looks obvious).

### A7. Trade-executor — new module required

- Auth: EIP-712 wallet signature (L1, once) to derive an API key/secret/passphrase, then HMAC-SHA256 over every request (L2). Different from Trojan's simple webhook model — this is a real auth module, not a config swap.
- Execution: place orders via CLOB V2, funded with pUSD on Polygon.
- You'll manage a Polygon private key with the same operational risk profile as your existing `TROJAN_API_KEY` — same category of secret, new signing code.

### A8. Effort estimate

Moderate-to-large. New indexer adapter + new markets schema + new P&L model + new safety-check module (resolution-risk based) + new CLOB executor. The pattern-detection brain reuses conceptually but every layer under it is new code. Realistic scope: several weeks for a read-only tracking/alerting MVP (indexer + Data API polling + Telegram alerts, no execution); add 1–2 more weeks for CLOB execution.

---

## Part B — Robinhood Chain

### B1. What it is (correction to earlier assumption: this is NOT the closed Robinhood brokerage)

Robinhood Chain is a **public, permissionless, EVM-compatible Layer 2** built on Arbitrum Orbit, settling to Ethereum via blob data availability. It is a completely different product from the Robinhood trading app — the app's real equities/options remain a closed, off-chain ledger with no public API. Robinhood Chain, by contrast, is exactly as trackable as any other EVM chain.

- **Mainnet:** live July 1, 2026. Chain ID `4663`. Testnet chain ID `46630`.
- Gas token: ETH. ~100ms block times. Single sequencer, currently operated by Robinhood (a centralization/censorship consideration for your risk scoring, unlike Solana's validator set).
- **Official explorer:** Blockscout, at `robinhoodchain.blockscout.com`, live from block one, with a Pro API that returns **pre-decoded** logs, token metadata, and internal transactions — this saves you from writing your own ABI/log decoder.
- **RPC:** Alchemy is the officially recommended provider; QuickNode, Blockdaemon, dRPC, and Validation Cloud also support it. A free public endpoint exists (`rpc.mainnet.chain.robinhood.com`) but is explicitly rate-limited and not meant for production.
- Oracles: Chainlink price feeds. DEX layer: Uniswap (V3 pools observed in practice, e.g. `CASHCAT/WETH`).

### B2. The activity you actually want to track

The chain's stated purpose is tokenized real-world assets (Stock Tokens for NVDA, AAPL, GOOG, etc.), but **meme-coin trading has overwhelmingly dominated actual usage** since launch:

- Daily DEX volume has run **$500M–$877M** in the chain's first two weeks, versus a tokenized-RWA market of roughly $12–13M — memes are ~40–70x the volume of the chain's official purpose.
- **CASHCAT**, a token referencing Robinhood's pre-launch "CashCat" internal branding, became the flagship: market cap ran as high as ~$188M, with documented cases of wallets turning $85–$838 into $687K–$1M+ in days. It is **not officially affiliated with Robinhood** despite the name lore, and Robinhood's CEO publicly acknowledged the chain "works great for memes too," which accelerated the trend.
- 11,000–16,000+ new tokens are being launched *per day* on the chain during this early period.
- **DexScreener already indexes Robinhood Chain** — CASHCAT, HOODIE, and others show up there with live price/liquidity/volume, same as any Solana or Ethereum pair. This means your existing `discover-starter-pack.ts` discovery pattern (query DexScreener for high-volume newly-launched tokens) can point at Robinhood Chain with a config/chain-ID change to that script, not a rewrite of its core logic.
- **This chain already has an active scam problem.** A cross-chain bridge provider (Relay Protocol) publicly warned of honeypot tokens draining wallets on Robinhood Chain within its first two weeks, citing the permissionless launch environment as the cause. This is directly relevant to your safety-check design below — it's not a hypothetical risk, it's already happening at meaningful scale.

### B3. Indexer

Two viable approaches, not mutually exclusive:
1. **Raw RPC via Alchemy** — subscribe to/poll `Swap` and `Transfer` events from Uniswap V3 pools, decode logs yourself (token0/token1 ordering, decimals, price).
2. **Blockscout Pro API** — returns decoded logs and token metadata directly, which removes most of the ABI-decoding work. Given the chain is brand-new and event shapes may still be settling, starting here is likely faster than hand-rolling a decoder.

Either way, this replaces Helius entirely — there is no Helius equivalent needed or available for an EVM chain; standard EVM tooling (viem/ethers, Foundry) works unmodified, which the Robinhood Chain docs confirm explicitly.

### B4. Schema changes

- Add `chain = 'robinhood-chain'` to the discriminator column.
- Address (42 chars) and tx hash (`0x` + 64 hex = 66 chars) both fit inside your existing `VARCHAR(44)`/`VARCHAR(88)` columns without a width change — same lucky fit as Polymarket.
- **Tokens map cleanly onto your existing `tokens` table** — ERC-20s with continuous price movement are structurally the same shape as SPL meme coins. This is the one venue of the two where you *don't* need a new asset-class table; you're extending, not replacing.

### B5. Scorer / signal-engine

Because Robinhood Chain meme tokens behave like Solana meme tokens (continuous price, snipe/accumulate/rotate/exit dynamics), **your existing win-rate/ROI/composite-score formulas and pattern definitions should port with only moderate changes** — this is the genuinely good news for "no changes." The work is in the layer below, not the pattern logic itself.

### B6. Safety checks — new module, same *shape* as Solana's, different fields

Since SPL's `mintAuthority`/`freezeAuthority` don't exist for ERC-20s, replace with EVM-native equivalents (this tooling landscape is mature — GoPlus, TokenSniffer, and Honeypot.is are the standard references, though **none has confirmed Robinhood Chain (4663) coverage yet given how new the chain is — verify before relying on any of them**):

- **Honeypot / sell-simulation check:** simulate a buy followed immediately by a sell against current chain state; if the sell reverts or the effective price is drastically worse than expected, flag it. This is the single most important check given the confirmed scam activity noted in §B2 — sniper-bot research shows this "trial trade" approach is the standard countermeasure across the industry.
- **Ownership renounced** — check whether the contract retains an owner/admin address with mint, blacklist, or max-transaction-limit powers.
- **LP lock status** — verify liquidity is locked (and for how long) in a known locker contract, not sitting in a wallet the deployer can drain.
- **Contract verification** — confirmed on Blockscout (source + ABI available) vs. unverified bytecode.
- **Top-holder concentration** — same spirit as your existing `getTop10HolderPct`, just against an EVM holder list instead of Solana's.
- **Sequencer/censorship note** (chain-level, not token-level): Robinhood Chain's single-sequencer design is worth surfacing as a standing risk flag in your dashboard, separate from per-token checks.

### B7. Trade-executor

- Trojan is Solana/Telegram-specific and has no Robinhood Chain support — unsurprising, the chain is under two weeks old. Cross-chain sniper bots like Banana Gun and Maestro currently cover Ethereum/Solana/BSC/Base/MegaETH; **Robinhood Chain isn't in their published chain lists yet** as of this writing, though that could change quickly given the volume it's already doing.
- Practical near-term path: **write your own executor** against Uniswap's router on Robinhood Chain using a signer (viem/ethers), rather than waiting on third-party bot support. This is more upfront work but keeps you independent of a still-forming bot ecosystem, and gives you direct control over slippage and the honeypot pre-trade simulation from §B6.
- Trading was gas-free for the first 90 days post-launch as a promotional period (covers trading only, not contract deployment); after that, gas is sub-cent regardless given the chain's design.

### B8. Effort estimate

Smaller than Polymarket, precisely because the token/price model already matches what SWAT does for Solana. Realistic scope: new indexer adapter (Alchemy or Blockscout Pro) + chain-discriminator migration + EVM safety-check module (this is the part that can't be shortcut, given confirmed active scam activity on the chain) + a from-scratch Uniswap executor if you want auto-execution. A read-only tracking/alerting MVP is plausibly the faster of the two builds here.

---

## Part C — Suggested build order

Given the effort deltas above:

1. **Schema migration first** (§0) — the chain discriminator column, done once, unblocks both venues and avoids a rework later.
2. **Robinhood Chain indexer + DexScreener discovery config change** — smallest lift, and the token/price model needs the least new logic. This gets you a working end-to-end pipeline fastest, on the venue with the most immediate trading volume.
3. **Robinhood Chain safety-check module** — do this *before* wiring up any auto-execution, given the confirmed active honeypot activity on the chain.
4. **Polymarket indexer + Data API discovery** — read-only tracking (positions/trades/leaderboard) is low-risk and high-value on its own, even before you build the resolution-risk-aware P&L model or CLOB executor.
5. **Execution layers last, on both venues** — highest-risk code, and both need dedicated signer/auth work (EIP-712+HMAC for Polymarket, raw Uniswap router calls for Robinhood Chain) that's worth getting right without time pressure.

---

## Open questions to resolve before writing code

- [ ] Does GoPlus/TokenSniffer/Honeypot.is support chain ID 4663 yet? (Check at build time — this doc will be stale within days given the chain's pace of change.)
- [ ] Does DexScreener's API expose a stable chain-ID parameter for Robinhood Chain that `discover-starter-pack.ts` can target?
- [ ] What's your actual risk tolerance for the Polymarket UMA dispute window — do you want signals to fire on unresolved-but-likely-obvious markets, or only fully resolved ones?
- [ ] Jurisdictional check: confirm your own eligibility to trade on both venues from Nigeria (Polymarket geo-blocks several countries for order placement; Robinhood Chain's Stock Tokens — not relevant here since you're tracking memes, not Stock Tokens — are excluded in the US but available in 120+ other countries).
