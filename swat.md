# SWAT: Solana Wallet Analysis & Tracking
## Comprehensive Project Specification

**Version:** 1.0  
**Date:** May 2026  
**Chain:** Solana  
**Status:** Side Project / MVP  
**Core Thesis:** Identify profitable wallet clusters, detect their buying patterns, and execute copy-trades with minimal latency.

---

## Table of Contents
1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Data Layer](#3-data-layer)
4. [Wallet Intelligence Engine](#4-wallet-intelligence-engine)
5. [Clustering & Affiliation Detection](#5-clustering--affiliation-detection)
6. [Pattern Recognition System](#6-pattern-recognition-system)
7. [Trading Execution Layer](#7-trading-execution-layer)
8. [Alerting & Notifications](#8-alerting--notifications)
9. [Database Schema](#9-database-schema)
10. [API Specification](#10-api-specification)
11. [Frontend Requirements](#11-frontend-requirements)
12. [Security & Risk Management](#12-security--risk-management)
13. [Deployment & Infrastructure](#13-deployment--infrastructure)
14. [Development Roadmap](#14-development-roadmap)
15. [Cost Estimates](#15-cost-estimates)
16. [Appendix](#16-appendix)

---

## 1. Executive Summary

### 1.1 What We're Building
SWAT is a Solana-native wallet intelligence platform that:
1. Ingests wallet addresses from a curated "shiller" feed
2. Analyzes each wallet's historical performance (ROI, win rate, speed)
3. Clusters wallets by funding sources and behavioral similarity
4. Detects real-time buying patterns across clusters
5. Executes copy-trades or sends alerts when high-confidence patterns emerge

### 1.2 Key Differentiators
- **Self-built clustering:** No dependency on Bubblemaps API. Custom graph analysis using Helius + on-chain data.
- **Speed-first:** Sub-5-second signal-to-trade latency target.
- **Pattern specificity:** Not just "wallet bought token" — detect accumulation, rotation, sniping, and exit patterns.
- **Risk-aware:** Position sizing based on cluster confidence, not all-in.

### 1.3 Success Metrics (MVP)
- Track 500+ wallets across 50+ clusters
- <5s latency from on-chain buy to alert generation
- 60%+ win rate on copy-traded signals (paper trade first)
- Process 10,000+ transactions/hour

---

## 2. System Architecture

### 2.1 High-Level Diagram

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Shiller Feed  │────▶│  Wallet Ingestor │────▶│   PostgreSQL    │
│  (Manual/CSV/   │     │   (Node.js)      │     │  (Wallet/Token  │
│   Telegram)     │     └──────────────────┘     │     Data)       │
└─────────────────┘              │                └─────────────────┘
                                 │                         │
                                 ▼                         ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Jupiter Swap  │◀────│  Trade Executor  │◀────│  Signal Engine  │
│      API        │     │   (Node.js)      │     │   (Node.js)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                 ▲                         ▲
                                 │                         │
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Telegram/     │◀────│  Alert Service   │◀────│  Pattern Matcher│
│   Discord Bot   │     │   (BullMQ)       │     │   (Redis)       │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                          ▲
                                                          │
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Helius RPC    │────▶│  Tx Parser /     │────▶│  Cluster Engine │
│  + Webhooks     │     │  Indexer         │     │  (Graph Analysis)│
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  Redis Cache     │
                        │  (Hot wallets,   │
                        │   token prices)  │
                        └──────────────────┘
```

### 2.2 Service Breakdown

| Service | Language | Purpose | Scaling |
|---------|----------|---------|---------|
| **Ingestor** | Node.js/TS | Receives wallet lists, validates, enqueues for backfill | Single instance |
| **Indexer** | Node.js/TS | Polls/hears transactions, parses swaps, writes to DB | Horizontal (by wallet shard) |
| **Cluster Engine** | Node.js/TS + Python | Builds funding graphs, runs clustering algorithms | Single (batch job) |
| **Signal Engine** | Node.js/TS | Real-time pattern detection on incoming txs | Horizontal |
| **Trade Executor** | Node.js/TS | Executes swaps via Jupiter, manages slippage/gas | Single (with failover) |
| **Alert Service** | Node.js/TS | Sends Telegram/Discord notifications | Single |
| **API Server** | Node.js/TS (Fastify) | REST API for frontend | Horizontal |
| **Frontend** | Next.js 15 | Dashboard, wallet explorer, cluster viz | Static/Vercel |

### 2.3 Communication Patterns
- **Async Jobs:** BullMQ (Redis-backed) for backfills, clustering runs, and alert dispatch
- **Real-time:** Helius webhooks → Indexer → Redis Pub/Sub → Signal Engine
- **Sync:** REST API for frontend queries

---

## 3. Data Layer

### 3.1 Data Sources

#### A. Helius (Primary Infrastructure)
- **Enhanced RPC:** `getSignaturesForAddress`, `getParsedTransactions`
- **Webhooks:** Account-level webhooks for tracked wallets (real-time tx notifications)
- **Priority Fees:** Dynamic fee estimation for trade execution
- **Cost:** Free tier (10M credits/mo) → $49/mo (Growth) → $199/mo (Business)
- **Usage:** All on-chain data ingestion, webhook delivery, transaction simulation

#### B. DexScreener (Trending & Price Data)
- **Endpoint:** `https://api.dexscreener.com/latest/dex/search?q=...`
- **Data:** Token prices, volume, liquidity, pair addresses
- **Cost:** Free (rate limited)
- **Usage:** Identify trending tokens, calculate unrealized P&L, validate liquidity before trading

#### C. Jupiter (Execution & Routing)
- **Quote API:** `https://quote-api.jup.ag/v6/quote`
- **Swap API:** `https://quote-api.jup.ag/v6/swap`
- **Token List:** Verified token metadata
- **Cost:** Free
- **Usage:** Trade execution, price discovery, token validation

#### D. Birdeye (Optional Enhancement)
- **API:** Historical OHLCV, wallet P&L, token metadata
- **Cost:** $99–$299/mo
- **Usage:** Fallback for price data, advanced analytics (add in Phase 2)

### 3.2 Data Flow

```
Helius Webhook (Account Update)
    │
    ▼
[Indexer Service]
    │
    ├──▶ Parse Instruction (Raydium/Pump.fun/Jupiter swap)
    │
    ├──▶ Enrich with Token Metadata (Jupiter Token List)
    │
    ├──▶ Calculate USD Value (DexScreener price at tx timestamp)
    │
    ├──▶ Write to PostgreSQL (transactions table)
    │
    └──▶ Publish to Redis Channel ("wallet:{address}:swap")
              │
              ▼
        [Signal Engine] ──▶ Pattern Match ──▶ Alert/Trade
```

### 3.3 Caching Strategy (Redis)

| Key Pattern | TTL | Purpose |
|-------------|-----|---------|
| `token:price:{mint}` | 30s | Current USD price |
| `token:metadata:{mint}` | 1h | Name, symbol, decimals |
| `wallet:performance:{address}` | 5m | Cached scorecard |
| `cluster:members:{clusterId}` | 15m | Wallet list per cluster |
| `signal:active:{patternId}` | 10m | Deduplicate signals |

---

## 4. Wallet Intelligence Engine

### 4.1 Wallet Ingestion Pipeline

**Input:** List of wallet addresses (from shiller feed)  
**Process:**
1. Validate base58 Solana addresses
2. Check against known CEX/contract addresses (filter out)
3. Enqueue `backfill-wallet` job (BullMQ)
4. Backfill last 1,000 transactions via Helius
5. Parse all swap instructions to build trade history
6. Calculate performance metrics
7. Mark wallet as `active` in DB

### 4.2 Performance Metrics (Per Wallet)

| Metric | Formula | Update Frequency |
|--------|---------|------------------|
| **Total Trades** | Count of swap transactions | Real-time |
| **Win Rate** | Profitable sells / Total sells | Daily batch |
| **Realized ROI** | Σ(Sell USD - Buy USD) / Σ(Buy USD) | Daily batch |
| **Unrealized ROI** | Σ(Current Value - Cost Basis) / Σ(Cost Basis) | Every 5 min |
| **Avg Hold Time** | Mean(sell_time - buy_time) | Daily batch |
| **Early Entry Score** | How many tokens bought within 1h of launch / Total tokens | Weekly |
| **Consistency Score** | Std dev of monthly ROI (lower = more consistent) | Weekly |
| **Risk Score** | Max drawdown % from peak portfolio value | Daily |

### 4.3 Wallet Scoring Algorithm (v1)

```typescript
interface WalletScore {
  address: string;
  totalTrades: number;
  winRate: number;           // 0-1
  realizedRoi: number;       // multiplier (1.5 = 150%)
  earlyEntryScore: number;   // 0-1
  consistencyScore: number;  // 0-1 (higher = more consistent)
  compositeScore: number;    // 0-100
}

function calculateCompositeScore(wallet: WalletScore): number {
  // Weights (tune based on paper trading results)
  const weights = {
    winRate: 0.25,
    realizedRoi: 0.30,
    earlyEntryScore: 0.25,
    consistencyScore: 0.20
  };

  // Normalize ROI to 0-1 scale (cap at 10x = 1.0)
  const normalizedRoi = Math.min(wallet.realizedRoi / 10, 1);

  return (
    wallet.winRate * weights.winRate * 100 +
    normalizedRoi * weights.realizedRoi * 100 +
    wallet.earlyEntryScore * weights.earlyEntryScore * 100 +
    wallet.consistencyScore * weights.consistencyScore * 100
  );
}
```

**Tier Classification:**
- **Elite (90–100):** Copy with full position size
- **Pro (75–89):** Copy with 75% position size
- **Promising (60–74):** Copy with 50% position size, monitor closely
- **Speculative (<60):** Track only, no auto-trade

### 4.4 Trade History Parser

**Supported Programs:**
- Raydium AMM (routePlan in Jupiter swaps)
- Pump.fun bonding curve
- Jupiter Aggregator v6
- Meteora DLMM
- Orca Whirlpool

**Parsed Fields per Swap:**
```typescript
interface ParsedSwap {
  signature: string;
  walletAddress: string;
  timestamp: Date;
  tokenIn: string;      // mint address
  tokenOut: string;     // mint address
  amountIn: bigint;     // raw amount
  amountOut: bigint;    // raw amount
  amountInUsd: number;  // at tx time
  amountOutUsd: number; // at tx time
  programId: string;    // DEX program
  slot: number;
}
```

**Cost Basis Tracking:**
- Use FIFO (First In, First Out) for realized P&L
- Track remaining holdings for unrealized P&L
- Handle partial sells (pro-rata cost basis reduction)

---

## 5. Clustering & Affiliation Detection

### 5.1 Problem Statement
Given N wallets, identify which wallets are controlled by the same entity (sybil detection) without relying on Bubblemaps.

### 5.2 Graph Model

```
Nodes: Wallets (and optionally: Tokens, CEX addresses)
Edges: Relationships with weights

Edge Types:
1. FUNDING: Wallet A → Wallet B (initial SOL transfer)
2. INTERACTION: Wallet A ↔ Wallet B (mutual token transfers)
3. TIMING: Wallet A & Wallet B bought Token X within Δt
4. COUNTERPARTY: Both trade with same obscure wallet/contract
```

### 5.3 Clustering Heuristics (v1)

#### Heuristic 1: Funding Source Analysis
```sql
-- Find wallets funded by the same source within 24h
SELECT 
  from_address as funder,
  array_agg(to_address) as funded_wallets,
  count(*) as wallet_count
FROM transfers
WHERE token = 'SOL' 
  AND amount < 0.5  -- small initial funding
  AND timestamp > now() - interval '30 days'
GROUP BY from_address
HAVING count(*) >= 3;
```
**Confidence:** High (direct evidence of control)

#### Heuristic 2: Temporal Correlation
```typescript
function calculateTimingCorrelation(
  walletA: string, 
  walletB: string, 
  windowMinutes: number = 15
): number {
  // Get all tokens bought by both wallets
  const commonTokens = intersection(
    getTokensBought(walletA),
    getTokensBought(walletB)
  );

  let correlatedBuys = 0;
  for (const token of commonTokens) {
    const timeA = getFirstBuyTime(walletA, token);
    const timeB = getFirstBuyTime(walletB, token);
    if (Math.abs(timeA - timeB) < windowMinutes * 60 * 1000) {
      correlatedBuys++;
    }
  }

  return correlatedBuys / commonTokens.length; // 0-1
}
```
**Confidence:** Medium (could be coincidence or same alpha source)

#### Heuristic 3: Behavioral Fingerprinting
Compare:
- Average position size (USD)
- Preferred DEX programs
- Holding duration distribution
- Time-of-day trading patterns
- Slippage tolerance (inferred from tx logs)

Use **Jaccard Similarity** on categorical features + **Euclidean distance** on numerical features.

#### Heuristic 4: Token Portfolio Overlap
```typescript
function portfolioOverlap(walletA: string, walletB: string): number {
  const holdingsA = getCurrentHoldings(walletA);
  const holdingsB = getCurrentHoldings(walletB);

  const intersection = holdingsA.filter(t => holdingsB.includes(t));
  const union = [...new Set([...holdingsA, ...holdingsB])];

  return intersection.length / union.length;
}
```
**Confidence:** Low-Medium (could follow same influencer)

### 5.4 Cluster Scoring & Confidence

Each cluster gets a confidence score based on evidence strength:

| Evidence Type | Weight | Example |
|--------------|--------|---------|
| Direct funding | 0.40 | Same wallet funded 5 wallets |
| Timing correlation >0.7 | 0.25 | Bought 8/10 same tokens within 10 min |
| Behavioral similarity >0.8 | 0.20 | Same DEX, same position sizes |
| Portfolio overlap >0.6 | 0.15 | 60% same current holdings |

**Cluster Confidence Tiers:**
- **Confirmed (>0.85):** Treat as single entity
- **Likely (0.70–0.85):** Flag for review
- **Possible (0.55–0.70):** Weak signal, monitor
- **Unrelated (<0.55):** Discard

### 5.5 Implementation: Graph Database

**Choice:** PostgreSQL with recursive CTEs (v1) → Neo4j (v2 if >10k wallets)

**Schema:**
```sql
-- Wallets table (see Section 9)

-- Wallet relationships
CREATE TABLE wallet_relationships (
  id SERIAL PRIMARY KEY,
  wallet_a VARCHAR(44) NOT NULL,
  wallet_b VARCHAR(44) NOT NULL,
  relationship_type VARCHAR(20) NOT NULL, -- 'funding', 'timing', 'behavioral'
  confidence DECIMAL(3,2) NOT NULL,       -- 0.00 to 1.00
  evidence JSONB,                         -- tx signatures, timestamps, etc.
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(wallet_a, wallet_b, relationship_type)
);

-- Clusters
CREATE TABLE wallet_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100),                      -- auto-generated or manual
  confidence DECIMAL(3,2) NOT NULL,
  wallet_count INTEGER DEFAULT 0,
  total_realized_roi DECIMAL(12,4),
  total_unrealized_roi DECIMAL(12,4),
  first_seen TIMESTAMP DEFAULT NOW(),
  last_active TIMESTAMP DEFAULT NOW(),
  tags TEXT[]                             -- ['whale', 'pump_fun', 'sniper']
);

-- Cluster memberships
CREATE TABLE cluster_memberships (
  cluster_id UUID REFERENCES wallet_clusters(id),
  wallet_address VARCHAR(44) REFERENCES wallets(address),
  joined_at TIMESTAMP DEFAULT NOW(),
  confidence DECIMAL(3,2),                -- wallet's confidence within cluster
  PRIMARY KEY (cluster_id, wallet_address)
);
```

**Clustering Algorithm (DBSCAN-inspired):**
```typescript
async function runClustering() {
  const wallets = await getAllActiveWallets();
  const relationships = await getAllRelationships(minConfidence: 0.6);

  // Build adjacency list
  const graph = buildGraph(wallets, relationships);

  // Find connected components (funding chains)
  const components = findConnectedComponents(graph);

  // For each component, verify with timing/behavioral evidence
  for (const component of components) {
    const clusterConfidence = calculateClusterConfidence(component);
    if (clusterConfidence > 0.55) {
      await saveCluster(component, clusterConfidence);
    }
  }
}
```

**Run Frequency:** Daily at 02:00 UTC (off-peak), plus on-demand when new wallets are added.

---

## 6. Pattern Recognition System

### 6.1 Pattern Definitions

#### Pattern A: The Snipe
**Trigger:** 3+ wallets in a cluster buy the same token within 3 blocks of each other, and the token is <30 minutes old.
```sql
SELECT token_mint, cluster_id, count(*) as buyer_count
FROM transactions t
JOIN cluster_memberships cm ON t.wallet_address = cm.wallet_address
WHERE t.direction = 'buy'
  AND t.token_age_minutes < 30
  AND t.timestamp > now() - interval '5 minutes'
GROUP BY token_mint, cluster_id
HAVING count(*) >= 3;
```
**Signal Strength:** Very High  
**Action:** Immediate buy (if liquidity >$50k)

#### Pattern B: The Accumulation
**Trigger:** Cluster buys the same token on 3+ separate days, with increasing position sizes.
```typescript
function detectAccumulation(clusterId: string, tokenMint: string): boolean {
  const buys = getClusterBuys(clusterId, tokenMint, days: 7);
  const dailyGroups = groupByDay(buys);

  if (dailyGroups.length < 3) return false;

  // Check increasing trend
  const amounts = dailyGroups.map(g => g.totalUsd);
  return isIncreasingTrend(amounts) && sum(amounts) > 1000; // min $1k total
}
```
**Signal Strength:** High  
**Action:** Buy with 75% position size

#### Pattern C: The Rotation
**Trigger:** Cluster sells Token A (realizing profit) and buys Token B within 1 hour.
```typescript
function detectRotation(clusterId: string): Signal | null {
  const recentSells = getClusterSells(clusterId, hours: 1);
  const recentBuys = getClusterBuys(clusterId, hours: 1);

  for (const sell of recentSells) {
    if (sell.realizedProfit > 0) { // profitable exit
      const rotatedBuy = recentBuys.find(b => 
        b.timestamp > sell.timestamp && 
        b.timestamp < sell.timestamp + 3600000
      );
      if (rotatedBuy) {
        return {
          type: 'ROTATION',
          fromToken: sell.tokenMint,
          toToken: rotatedBuy.tokenMint,
          clusterId,
          confidence: 0.8
        };
      }
    }
  }
  return null;
}
```
**Signal Strength:** Medium-High  
**Action:** Buy Token B

#### Pattern D: The Exit
**Trigger:** 50%+ of cluster members sell >50% of their position in the same token within 1 hour.
```sql
SELECT token_mint, cluster_id,
  count(distinct wallet_address) as sellers,
  sum(amount_usd) as exit_volume
FROM transactions
WHERE direction = 'sell'
  AND timestamp > now() - interval '1 hour'
GROUP BY token_mint, cluster_id
HAVING count(distinct wallet_address) >= (
  SELECT count(*) * 0.5 
  FROM cluster_memberships 
  WHERE cluster_id = transactions.cluster_id
);
```
**Signal Strength:** High (for selling, not buying)  
**Action:** Sell alert / Auto-exit if holding

#### Pattern E: The Stealth Buy
**Trigger:** Cluster buys a token with <$100k market cap, no social mentions, and holds >7 days without selling.
**Signal Strength:** Medium  
**Action:** Research token, small position

### 6.2 Signal Scoring

Each signal gets a composite score:

| Factor | Weight | Description |
|--------|--------|-------------|
| Cluster Confidence | 0.25 | How sure we are these wallets are affiliated |
| Cluster Historical ROI | 0.25 | Avg ROI of this cluster |
| Pattern Type | 0.20 | Snipe > Accumulation > Rotation > Stealth |
| Liquidity | 0.15 | Higher liquidity = safer entry |
| Token Age | 0.10 | Newer tokens = higher risk/reward |
| Market Context | 0.05 | SOL price trend, overall DEX volume |

**Signal Thresholds:**
- **Execute (≥80):** Auto-buy with configured position size
- **Alert (60–79):** Send notification, manual decision
- **Log (<60):** Record for backtesting only

### 6.3 Anti-Patterns (False Positives to Filter)

1. **Airdrop Farming:** Wallets receive airdrop and immediately sell. Not a real pattern.
   - Filter: Exclude transactions where token was received as airdrop (no prior buy)

2. **Rug Pull Setup:** Cluster buys 90% of supply.
   - Filter: Check holder distribution. If cluster holds >30% supply, flag as dangerous.

3. **Wash Trading:** Cluster buys and sells to themselves.
   - Filter: Check if counterparty is also in cluster.

4. **CEX Deposit:** Wallet sends to Binance/Coinbase.
   - Filter: Exclude known CEX addresses from pattern detection.

---

## 7. Trading Execution Layer

### 7.1 Architecture Principles
- **Never hold user funds:** Self-custody. Trade from your own hot wallet.
- **Simulate before execute:** Use Helius `simulateTransaction` before every swap.
- **Idempotency:** Every trade has a UUID. If signal fires twice, trade once.
- **Circuit breaker:** Stop trading if 3 consecutive trades fail or if SL is hit.

### 7.2 Jupiter Integration

**Quote Flow:**
```typescript
async function executeBuy(signal: Signal, config: TradeConfig) {
  const { tokenMint, maxSlippageBps, priorityFee } = config;

  // 1. Get quote
  const quote = await jupiterApi.quote({
    inputMint: 'So11111111111111111111111111111111111111112', // WSOL
    outputMint: tokenMint,
    amount: config.amountLamports,
    slippageBps: maxSlippageBps,
    onlyDirectRoutes: false
  });

  // 2. Validate
  if (quote.priceImpactPct > 5) {
    throw new Error(`Price impact too high: ${quote.priceImpactPct}%`);
  }

  // 3. Get swap transaction
  const swapTx = await jupiterApi.swap({
    quoteResponse: quote,
    userPublicKey: wallet.publicKey,
    wrapAndUnwrapSol: true,
    prioritizationFeeLamports: priorityFee
  });

  // 4. Simulate
  const simulation = await connection.simulateTransaction(swapTx);
  if (simulation.value.err) {
    throw new Error('Simulation failed');
  }

  // 5. Execute
  const signature = await connection.sendTransaction(swapTx, [wallet]);

  // 6. Confirm (with timeout)
  await confirmTransaction(signature, timeoutMs: 30000);

  // 7. Log
  await logTrade({ signal, signature, status: 'filled' });
}
```

### 7.3 Risk Management Rules

| Rule | Implementation |
|------|---------------|
| **Max Position Size** | 5% of total portfolio per trade |
| **Max Daily Exposure** | 25% of portfolio in new positions |
| **Stop Loss** | -20% from entry (monitored via cron job every 5 min) |
| **Take Profit** | Scale out: 50% at +50%, 25% at +100%, 25% runner |
| **Liquidity Filter** | Minimum $50k liquidity on Raydium/Orca |
| **Token Age Filter** | No tokens <5 minutes old (avoid immediate rugs) |
| **Blacklist** | Manual blacklist for known scam tokens/contracts |
| **Duplicate Prevention** | Don't buy same token twice within 24h unless averaging down |

### 7.4 Paper Trading Mode

Before live trading, run in **paper mode** for 2–4 weeks:
- Log the trade you *would* make
- Track P&L using DexScreener historical prices
- Compare against live execution (account for slippage)
- Tune signal thresholds based on paper results

```typescript
if (process.env.TRADE_MODE === 'paper') {
  await logPaperTrade(signal, quote);
  await sendAlert(`[PAPER] Would buy ${tokenSymbol} at $${price}`);
  return;
}
```

---

## 8. Alerting & Notifications

### 8.1 Alert Types

| Type | Channel | Trigger |
|------|---------|---------|
| **Signal Alert** | Telegram Bot | Pattern detected |
| **Trade Executed** | Telegram Bot | Buy/sell filled |
| **Cluster Update** | Telegram Bot | New cluster formed or confidence changed |
| **Risk Alert** | Telegram + Email | Stop loss hit, circuit breaker triggered |
| **Daily Summary** | Telegram Bot | P&L summary at 00:00 UTC |
| **System Health** | Email | Service down, webhook failure, RPC errors |

### 8.2 Telegram Bot Commands

```
/start - Show menu
/status - Portfolio status
/wallets - List tracked wallets
/clusters - List active clusters
/signals - Last 10 signals
/paper - Toggle paper trading
/pause - Pause auto-trading
/resume - Resume auto-trading
```

### 8.3 Alert Format

```
🎯 SIGNAL: The Snipe
Cluster: Cluster-7 (Whale Pod)
Confidence: 87/100
Token: $PEPE2 (PEPE2.0)
Contract: 7xKX...3f9A
Price: $0.000042
Liquidity: $127K
Age: 12 minutes

Pattern: 4 wallets bought within 2 blocks
Cluster Avg ROI: 340%

Action: BUY (5% position)
Risk: Medium

[View Chart] [Execute] [Ignore]
```

---

## 9. Database Schema

### 9.1 PostgreSQL Schema

```sql
-- Wallets being tracked
CREATE TABLE wallets (
  address VARCHAR(44) PRIMARY KEY,
  nickname VARCHAR(100),
  source VARCHAR(50),              -- 'shiller', 'manual', 'discovered'
  status VARCHAR(20) DEFAULT 'active', -- 'active', 'paused', 'blacklisted'
  first_seen TIMESTAMP DEFAULT NOW(),
  last_active TIMESTAMP,
  total_trades INTEGER DEFAULT 0,
  win_rate DECIMAL(5,2),           -- 0.00 to 100.00
  realized_roi DECIMAL(12,4),      -- 1.50 = 150%
  unrealized_roi DECIMAL(12,4),
  avg_hold_time_hours DECIMAL(8,2),
  early_entry_score DECIMAL(5,2),  -- 0.00 to 100.00
  consistency_score DECIMAL(5,2),  -- 0.00 to 100.00
  composite_score DECIMAL(5,2),    -- 0.00 to 100.00
  tier VARCHAR(20),                -- 'elite', 'pro', 'promising', 'speculative'
  portfolio_value_usd DECIMAL(16,2),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Token metadata cache
CREATE TABLE tokens (
  mint VARCHAR(44) PRIMARY KEY,
  symbol VARCHAR(20),
  name VARCHAR(100),
  decimals INTEGER,
  logo_uri TEXT,
  first_seen TIMESTAMP DEFAULT NOW(),
  launch_timestamp TIMESTAMP,
  total_supply BIGINT,
  is_verified BOOLEAN DEFAULT FALSE,
  tags TEXT[],                     -- ['pump_fun', 'raydium', 'meme']
  created_at TIMESTAMP DEFAULT NOW()
);

-- Parsed swap transactions
CREATE TABLE transactions (
  id BIGSERIAL PRIMARY KEY,
  signature VARCHAR(88) NOT NULL,
  wallet_address VARCHAR(44) REFERENCES wallets(address),
  token_in VARCHAR(44) REFERENCES tokens(mint),
  token_out VARCHAR(44) REFERENCES tokens(mint),
  amount_in BIGINT NOT NULL,
  amount_out BIGINT NOT NULL,
  amount_in_usd DECIMAL(16,6),
  amount_out_usd DECIMAL(16,6),
  direction VARCHAR(4) NOT NULL,   -- 'buy' or 'sell' (relative to token_out)
  target_token VARCHAR(44),        -- the token being tracked (non-SOL)
  program_id VARCHAR(44),          -- DEX program
  slot BIGINT,
  timestamp TIMESTAMP NOT NULL,
  block_time BIGINT,               -- unix timestamp
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(signature, wallet_address, target_token)
);
CREATE INDEX idx_tx_wallet ON transactions(wallet_address, timestamp DESC);
CREATE INDEX idx_tx_token ON transactions(target_token, timestamp DESC);
CREATE INDEX idx_tx_cluster_time ON transactions(wallet_address, timestamp) 
  WHERE timestamp > NOW() - INTERVAL '24 hours';

-- Portfolio snapshots (for P&L tracking)
CREATE TABLE portfolio_snapshots (
  id BIGSERIAL PRIMARY KEY,
  wallet_address VARCHAR(44) REFERENCES wallets(address),
  token_mint VARCHAR(44) REFERENCES tokens(mint),
  balance BIGINT NOT NULL,
  cost_basis_usd DECIMAL(16,6),
  current_price_usd DECIMAL(16,6),
  unrealized_pnl_usd DECIMAL(16,6),
  snapshot_time TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_snap_wallet ON portfolio_snapshots(wallet_address, snapshot_time DESC);

-- Clusters (see Section 5.5 for full schema)
CREATE TABLE wallet_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100),
  description TEXT,
  confidence DECIMAL(3,2) NOT NULL,
  wallet_count INTEGER DEFAULT 0,
  total_realized_roi DECIMAL(12,4),
  total_unrealized_roi DECIMAL(12,4),
  avg_composite_score DECIMAL(5,2),
  first_seen TIMESTAMP DEFAULT NOW(),
  last_active TIMESTAMP DEFAULT NOW(),
  status VARCHAR(20) DEFAULT 'active',
  tags TEXT[],
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE cluster_memberships (
  cluster_id UUID REFERENCES wallet_clusters(id) ON DELETE CASCADE,
  wallet_address VARCHAR(44) REFERENCES wallets(address),
  joined_at TIMESTAMP DEFAULT NOW(),
  confidence DECIMAL(3,2),
  PRIMARY KEY (cluster_id, wallet_address)
);

-- Wallet relationships (graph edges)
CREATE TABLE wallet_relationships (
  id SERIAL PRIMARY KEY,
  wallet_a VARCHAR(44) NOT NULL,
  wallet_b VARCHAR(44) NOT NULL,
  relationship_type VARCHAR(20) NOT NULL,
  confidence DECIMAL(3,2) NOT NULL,
  evidence JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(wallet_a, wallet_b, relationship_type)
);
CREATE INDEX idx_rel_a ON wallet_relationships(wallet_a);
CREATE INDEX idx_rel_b ON wallet_relationships(wallet_b);

-- Detected patterns/signals
CREATE TABLE signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_type VARCHAR(20) NOT NULL, -- 'snipe', 'accumulation', 'rotation', 'exit', 'stealth'
  cluster_id UUID REFERENCES wallet_clusters(id),
  token_mint VARCHAR(44) REFERENCES tokens(mint),
  confidence DECIMAL(5,2) NOT NULL,
  signal_score DECIMAL(5,2) NOT NULL,
  trigger_data JSONB NOT NULL,       -- wallets involved, amounts, timestamps
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'executed', 'alerted', 'expired', 'rejected'
  executed_at TIMESTAMP,
  executed_price DECIMAL(16,8),
  executed_amount DECIMAL(16,8),
  trade_signature VARCHAR(88),
  pnl_usd DECIMAL(16,6),
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP               -- signals expire if not acted upon
);
CREATE INDEX idx_signals_status ON signals(status, created_at DESC);
CREATE INDEX idx_signals_cluster ON signals(cluster_id, created_at DESC);

-- Trade execution log
CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id UUID REFERENCES signals(id),
  wallet_address VARCHAR(44),        -- our trading wallet
  token_mint VARCHAR(44),
  direction VARCHAR(4) NOT NULL,     -- 'buy' or 'sell'
  amount_usd DECIMAL(16,6),
  token_amount BIGINT,
  price_usd DECIMAL(16,8),
  slippage_bps INTEGER,
  priority_fee_lamports BIGINT,
  signature VARCHAR(88),
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'confirmed', 'failed', 'simulated'
  simulation_result JSONB,
  error_message TEXT,
  executed_at TIMESTAMP DEFAULT NOW(),
  confirmed_at TIMESTAMP
);

-- System configuration
CREATE TABLE config (
  key VARCHAR(50) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Insert default config
INSERT INTO config (key, value) VALUES
('trading', '{"enabled": false, "mode": "paper", "max_position_pct": 5, "max_daily_exposure_pct": 25, "min_liquidity_usd": 50000}'::jsonb),
('risk', '{"stop_loss_pct": 20, "take_profit_levels": [{"pct": 50, "sell": 50}, {"pct": 100, "sell": 25}], "circuit_breaker_failures": 3}'::jsonb),
('signals', '{"min_signal_score": 60, "auto_execute_min_score": 80}'::jsonb);
```

### 9.2 Redis Schema

```
# Price cache
SET token:price:{mint} {usd_price} EX 30

# Metadata cache
HSET token:meta:{mint} symbol {sym} name {name} decimals {dec}
EXPIRE token:meta:{mint} 3600

# Wallet performance cache
HSET wallet:perf:{address} win_rate {wr} roi {roi} score {score}
EXPIRE wallet:perf:{address} 300

# Active signals (deduplication)
SET signal:active:{pattern}:{token}:{cluster} 1 EX 600

# Trade queue
LPUSH trade:queue {trade_job_json}

# Alert queue
LPUSH alert:queue {alert_json}

# Rate limiting
INCR rate:helius:{minute} EX 60
INCR rate:dexscreener:{minute} EX 60
```

---

## 10. API Specification

### 10.1 REST API Endpoints

**Base URL:** `https://api.swat.local/v1`

#### Wallets
```
GET    /wallets                    # List all tracked wallets
GET    /wallets/:address           # Get wallet details + performance
POST   /wallets                    # Add new wallet(s)
DELETE /wallets/:address           # Remove wallet
GET    /wallets/:address/history   # Paginated trade history
GET    /wallets/:address/holdings  # Current token holdings
```

#### Clusters
```
GET    /clusters                   # List clusters
GET    /clusters/:id               # Cluster details + member wallets
GET    /clusters/:id/performance   # Aggregate P&L
POST   /clusters/:id/refresh       # Trigger re-clustering
GET    /clusters/:id/timeline      # Activity timeline
```

#### Signals
```
GET    /signals                    # List signals (filter by status, pattern)
GET    /signals/:id                # Signal details
POST   /signals/:id/execute        # Manual execute (if auto disabled)
POST   /signals/:id/ignore         # Ignore signal
GET    /signals/stats              # Signal performance stats
```

#### Tokens
```
GET    /tokens                     # List tracked tokens
GET    /tokens/:mint               # Token details + price
GET    /tokens/trending            # Trending tokens (DexScreener)
GET    /tokens/:mint/holders       # Top holders (if available)
```

#### Trading
```
GET    /trading/status             # Current mode (paper/live), exposure
POST   /trading/mode               # Toggle paper/live
GET    /trading/portfolio          # Current portfolio
GET    /trading/performance        # P&L summary
POST   /trading/execute            # Manual trade execution
```

#### System
```
GET    /health                     # Health check
GET    /stats                      # System stats (tx processed, signals, etc.)
POST   /config                     # Update configuration
```

### 10.2 WebSocket Events

```javascript
// Client connects to /ws

// Subscribe to channels
{ "action": "subscribe", "channel": "signals" }
{ "action": "subscribe", "channel": "wallet:{address}" }
{ "action": "subscribe", "channel": "cluster:{id}" }

// Events pushed from server
{ 
  "type": "signal", 
  "data": { /* signal object */ }
}
{ 
  "type": "trade", 
  "data": { /* trade execution update */ }
}
{ 
  "type": "wallet_update", 
  "data": { address, newTx, pnlUpdate }
}
```

---

## 11. Frontend Requirements

### 11.1 Pages

| Page | Purpose | Key Features |
|------|---------|--------------|
| **Dashboard** | Overview | Portfolio value, daily P&L, active signals, recent trades |
| **Wallets** | Wallet management | Table with scores, add/remove, detail view with tx history |
| **Clusters** | Cluster explorer | Graph visualization (D3/Cytoscape), member list, performance |
| **Signals** | Signal feed | Filterable list, execute/ignore buttons, performance tracking |
| **Tokens** | Token research | Trending list, holder analysis, price charts |
| **Settings** | Configuration | Trading mode, risk params, API keys, notification settings |

### 11.2 Key UI Components

1. **Wallet Scorecard:** Radial chart showing composite score, breakdown by metric
2. **Cluster Graph:** Force-directed graph of wallets, edge thickness = relationship confidence
3. **Signal Card:** Pattern type badge, confidence bar, quick-action buttons
4. **Portfolio Chart:** Line chart of portfolio value over time
5. **Trade Log:** Table with P&L, slippage, tx link

### 11.3 Tech Stack
- **Framework:** Next.js 15 (App Router)
- **Styling:** Tailwind CSS + shadcn/ui
- **Charts:** Recharts (portfolio), D3 (cluster graph)
- **State:** Zustand
- **Data Fetching:** TanStack Query (React Query)
- **WebSocket:** Native WebSocket API

---

## 12. Security & Risk Management

### 12.1 Wallet Security
- **Hot Wallet:** Dedicated trading wallet, funded with only trading capital
- **Key Storage:** Use AWS Secrets Manager or HashiCorp Vault. Never commit keys.
- **Spending Limit:** Implement daily max spend in code (not just config)
- **Multi-sig (Phase 2):** Consider Squads or Snowflake for 2-of-3 on large positions

### 12.2 API Security
- **Authentication:** JWT for API access, API keys for webhooks
- **Rate Limiting:** 100 req/min per IP, 1000 req/min per API key
- **Input Validation:** Strict validation on all wallet addresses, mints, amounts
- **CORS:** Restrict to known frontend domains

### 12.3 Operational Security
- **Webhook Verification:** Verify Helius webhook signatures
- **Tx Simulation:** Every trade simulated before broadcast
- **Circuit Breakers:** 
  - Stop trading if 3 consecutive failures
  - Stop trading if portfolio drops >20% in 1 hour
  - Stop trading if SOL price drops >10% in 1 hour (market crash)
- **Blacklist:** Manual + automated (known rug contracts, honeypots)

### 12.4 Data Privacy
- Wallet addresses are sensitive. Encrypt at rest.
- Don't log private keys or seed phrases (ever).
- Access logs for all admin actions.

---

## 13. Deployment & Infrastructure

### 13.1 Local Development
```bash
# Prerequisites: Docker, Node 20, pnpm

git clone https://github.com/yourname/swat.git
cd swat

# Start infrastructure
docker-compose up -d postgres redis

# Install dependencies
pnpm install

# Run migrations
pnpm db:migrate

# Start services (using concurrently or tmux)
pnpm dev:api      # API server (port 3001)
pnpm dev:indexer  # Transaction indexer
pnpm dev:signals  # Signal engine
pnpm dev:alerts   # Alert service
pnpm dev:web      # Next.js frontend (port 3000)
```

### 13.2 Docker Compose (Production-ish)

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: swat
      POSTGRES_USER: swat
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    ports:
      - "6379:6379"

  api:
    build: ./apps/api
    environment:
      - DATABASE_URL=postgresql://swat:${DB_PASSWORD}@postgres:5432/swat
      - REDIS_URL=redis://redis:6379
      - HELIUS_API_KEY=${HELIUS_API_KEY}
      - PRIVATE_KEY=${TRADING_WALLET_PK}
    ports:
      - "3001:3001"
    depends_on:
      - postgres
      - redis

  indexer:
    build: ./apps/indexer
    environment:
      - DATABASE_URL=postgresql://swat:${DB_PASSWORD}@postgres:5432/swat
      - REDIS_URL=redis://redis:6379
      - HELIUS_API_KEY=${HELIUS_API_KEY}
    depends_on:
      - postgres
      - redis

  signal-engine:
    build: ./apps/signal-engine
    environment:
      - DATABASE_URL=postgresql://swat:${DB_PASSWORD}@postgres:5432/swat
      - REDIS_URL=redis://redis:6379
    depends_on:
      - postgres
      - redis

  alert-service:
    build: ./apps/alert-service
    environment:
      - DATABASE_URL=postgresql://swat:${DB_PASSWORD}@postgres:5432/swat
      - REDIS_URL=redis://redis:6379
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
    depends_on:
      - redis

volumes:
  postgres_data:
  redis_data:
```

### 13.3 Production Deployment Options

**Option A: VPS (Recommended for MVP)**
- Provider: Hetzner (€5.35/mo CX21) or DigitalOcean ($12/mo)
- Setup: Docker Compose + Caddy (reverse proxy + SSL)
- Monitoring: PM2 or systemd for process management
- Backup: Daily pg_dump to S3

**Option B: Managed Services**
- DB: Railway PostgreSQL ($5/mo) or Supabase
- Redis: Upstash (free tier) or Railway
- Hosting: Railway, Render, or Fly.io
- Frontend: Vercel (free)

**Option C: Hybrid (Scale Phase)**
- API + Frontend: Vercel/Railway
- Workers (Indexer, Signal Engine): AWS ECS or Google Cloud Run
- DB: AWS RDS PostgreSQL
- Redis: AWS ElastiCache

### 13.4 Monitoring & Logging

| Tool | Purpose | Cost |
|------|---------|------|
| **Grafana + Prometheus** | Metrics (tx rate, signal latency, portfolio value) | Free (self-hosted) |
| **Loki** | Log aggregation | Free (self-hosted) |
| **Uptime Kuma** | Health check alerts | Free |
| **Sentry** | Error tracking | Free tier |

**Key Metrics to Track:**
- Transactions processed per minute
- Signal detection latency (ms)
- Trade execution latency (ms)
- Webhook delivery success rate
- DB query performance (p95)
- Portfolio P&L (obviously)

---

## 14. Development Roadmap

### Phase 1: Foundation (Weeks 1–3)
**Goal:** Ingest wallets, parse history, calculate scores

| Week | Tasks |
|------|-------|
| **W1** | Set up project monorepo, Docker, DB schema. Build wallet ingestor + validator. |
| **W2** | Build Helius integration (RPC + webhooks). Parse Raydium/Jupiter swaps. Write to DB. |
| **W3** | Build wallet scoring engine. Calculate ROI, win rate, early entry. Dashboard v1. |

**Deliverable:** Dashboard showing tracked wallets with performance scores.

### Phase 2: Intelligence (Weeks 4–6)
**Goal:** Cluster wallets, detect patterns, generate signals

| Week | Tasks |
|------|-------|
| **W4** | Build funding graph analysis. Detect wallet relationships. |
| **W5** | Implement clustering algorithm (DBSCAN). Build cluster confidence scoring. |
| **W6** | Build pattern recognition (Snipe, Accumulation, Rotation). Signal scoring. Alert system. |

**Deliverable:** Telegram alerts for detected patterns. No trading yet.

### Phase 3: Paper Trading (Weeks 7–9)
**Goal:** Simulate trades, validate signal quality

| Week | Tasks |
|------|-------|
| **W7** | Build paper trading engine. Log hypothetical trades. Track P&L. |
| **W8** | Tune signal thresholds based on paper results. Add risk management rules. |
| **W9** | Build frontend (signals, clusters, portfolio). Polish UI/UX. |

**Deliverable:** Working platform in paper mode. 2+ weeks of signal data.

### Phase 4: Live Trading (Weeks 10–12)
**Goal:** Execute real trades with small capital

| Week | Tasks |
|------|-------|
| **W10** | Integrate Jupiter swap API. Build trade executor with simulation. |
| **W11** | Deploy with $500 test capital. Monitor execution quality. Fix latency issues. |
| **W12** | Add advanced features (stop losses, take profits, position sizing). Performance review. |

**Deliverable:** Live trading with documented results.

### Phase 5: Scale (Post-MVP)
- Multi-wallet tracking (10,000+ wallets)
- Advanced ML patterns (LSTM for price prediction post-signal)
- Social sentiment integration (Twitter/X, Telegram)
- Mobile app
- Subscription model for signal sharing

---

## 15. Cost Estimates

### MVP Costs (Months 1–3)

| Service | Provider | Monthly Cost |
|---------|----------|--------------|
| VPS (4GB RAM, 2 vCPU) | Hetzner | €5.35 (~$6) |
| RPC + Webhooks | Helius (Growth) | $49 |
| PostgreSQL | Self-hosted (Docker) | $0 |
| Redis | Self-hosted (Docker) | $0 |
| Domain + SSL | Cloudflare | $0 |
| Telegram Bot | BotFather | $0 |
| Monitoring | Self-hosted Grafana | $0 |
| **Total** | | **~$55/mo** |

### Scale Costs (6+ months)

| Service | Provider | Monthly Cost |
|---------|----------|--------------|
| Managed DB (RDS) | AWS | $50–100 |
| Managed Redis | Upstash | $20 |
| Helius (Business) | Helius | $199 |
| VPS/Containers | Railway/AWS | $50–100 |
| Birdeye API (optional) | Birdeye | $99 |
| **Total** | | **~$400–500/mo** |

### Trading Capital
- **Paper Trading:** $0
- **MVP Live Testing:** $500–1,000
- **Serious Trading:** $5,000–10,000 (only after 2+ months of profitable paper trading)

---

## 16. Appendix

### A. Solana Program IDs

| Program | Address | Purpose |
|---------|---------|---------|
| System Program | `11111111111111111111111111111111` | SOL transfers |
| Token Program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | SPL token transfers |
| Associated Token Account | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | ATA creation |
| Raydium AMM | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | Raydium swaps |
| Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | Raydium concentrated liquidity |
| Orca Whirlpool | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | Orca swaps |
| Jupiter Aggregator | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | Jupiter v6 |
| Pump.fun | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | Pump.fun bonding curve |
| Meteora DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | Meteora swaps |

### B. Useful Helius RPC Methods

```typescript
// Get parsed transaction (with inner instructions)
connection.getParsedTransaction(signature, {
  maxSupportedTransactionVersion: 0,
  commitment: 'confirmed'
});

// Get account history
connection.getSignaturesForAddress(pubkey, { limit: 1000 });

// Get token accounts by owner
connection.getParsedTokenAccountsByOwner(pubkey, {
  programId: TOKEN_PROGRAM_ID
});

// Simulate transaction
connection.simulateTransaction(transaction);

// Get priority fee estimate
connection.getRecentPrioritizationFees({ lockedWritableAccounts: [mint] });
```

### C. Jupiter API Examples

```bash
# Get quote
curl "https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000000&slippageBps=50"

# Get swap transaction (POST)
curl -X POST https://quote-api.jup.ag/v6/swap   -H "Content-Type: application/json"   -d '{
    "quoteResponse": { /* quote from above */ },
    "userPublicKey": "YOUR_WALLET_PUBKEY",
    "wrapAndUnwrapSol": true,
    "prioritizationFeeLamports": 10000
  }'
```

### D. Environment Variables Template

```bash
# Database
DATABASE_URL=postgresql://swat:password@localhost:5432/swat

# Redis
REDIS_URL=redis://localhost:6379

# Helius
HELIUS_API_KEY=your_helius_key
HELIUS_WEBHOOK_SECRET=your_webhook_secret

# Trading
TRADING_WALLET_PRIVATE_KEY=base58_encoded_private_key
TRADING_MODE=paper  # or 'live'

# Jupiter
JUPITER_API_URL=https://quote-api.jup.ag/v6

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# DexScreener (free, no key needed)
# DEXSCREENER_API_URL=https://api.dexscreener.com/latest/dex

# Server
PORT=3001
NODE_ENV=development
JWT_SECRET=your_jwt_secret
```

### E. Folder Structure

```
swat/
├── apps/
│   ├── api/                 # REST API + WebSocket server
│   ├── indexer/             # Helius webhook consumer + tx parser
│   ├── signal-engine/       # Pattern detection + signal generation
│   ├── trade-executor/      # Jupiter swap execution
│   ├── alert-service/       # Telegram/Discord notifications
│   └── web/                 # Next.js frontend
├── packages/
│   ├── db/                  # Prisma schema + migrations
│   ├── shared/              # Types, utils, constants
│   └── solana/              # Solana-specific helpers (parsing, programs)
├── docker-compose.yml
├── turbo.json               # Monorepo task runner
└── README.md
```

---

## Conclusion

This specification provides a complete blueprint for building SWAT as a self-hosted, Solana-native wallet intelligence platform. The key technical bets are:

1. **Helius for data ingestion** — best price/performance for Solana RPC + webhooks
2. **Self-built clustering** — using funding graphs + behavioral similarity instead of Bubblemaps
3. **Pattern-based signals** — rule-based v1, ML-enhanced v2
4. **Jupiter for execution** — reliable, liquid, well-documented
5. **Paper-first trading** — validate for 2+ weeks before risking capital

Start with Phase 1. Get 50 wallets ingested and scored. Everything else builds on that foundation.

**Next Action:** Initialize the monorepo, set up Docker Compose with PostgreSQL + Redis, and write the wallet ingestor.
