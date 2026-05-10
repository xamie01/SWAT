# SWAT: Solana Wallet Analysis & Tracking
## Comprehensive Project Specification

**Version:** 2.0
**Date:** May 2026
**Chain:** Solana
**Status:** Active Development
**Core Thesis:** Autonomously discover, score, and cluster profitable wallets. Detect their buying patterns in real-time and surface high-conviction signals via Telegram — formatted for immediate execution through fast external trading bots (Trojan, Maestro, BonkBot).

---

## Table of Contents
1. [Executive Summary](#1-executive-summary)
2. [Hybrid Architecture — Intelligence + Execution Split](#2-hybrid-architecture--intelligence--execution-split)
3. [Data Layer](#3-data-layer)
4. [Autonomous Wallet Discovery Engine](#4-autonomous-wallet-discovery-engine)
5. [Wallet Intelligence & Scoring](#5-wallet-intelligence--scoring)
6. [Clustering & Affiliation Detection](#6-clustering--affiliation-detection)
7. [Pattern Recognition System](#7-pattern-recognition-system)
8. [Signal Formatting & Alert Delivery](#8-signal-formatting--alert-delivery)
9. [Execution Layer — External Bot Integration](#9-execution-layer--external-bot-integration)
10. [Database Schema](#10-database-schema)
11. [API Specification](#11-api-specification)
12. [Frontend Requirements](#12-frontend-requirements)
13. [Security & Risk Management](#13-security--risk-management)
14. [Deployment & Infrastructure](#14-deployment--infrastructure)
15. [Development Roadmap](#15-development-roadmap)
16. [Cost Estimates](#16-cost-estimates)
17. [Appendix](#17-appendix)

---

## 1. Executive Summary

### 1.1 What We're Building

SWAT is a Solana-native wallet intelligence platform that operates as the **brain** in a two-layer trading system:

**Layer 1 — SWAT (Intelligence)**
1. Autonomously discovers profitable wallets from on-chain data (no manual curation)
2. Continuously scores and prunes the wallet list based on real performance
3. Clusters wallets by funding source and behavioral similarity
4. Detects real-time buying patterns across clusters
5. Delivers high-conviction, action-ready signals via Telegram

**Layer 2 — External Execution Bot (Speed)**
1. Trojan, Maestro, BonkBot, or equivalent Telegram-native trading bot
2. Pre-configured with position sizes, slippage, and TP/SL levels
3. Receives signal → operator pastes CA or auto-trigger fires → sub-1s execution

### 1.2 Why This Split?

Meme coin execution requires sub-second transaction speed backed by co-located RPC infrastructure that costs thousands per month to replicate. Telegram trading bots (Trojan, Maestro) already provide this. SWAT's edge is not in raw execution speed — it's in **knowing what to buy before the crowd does** and delivering that information in a format that enables instant action.

```
SWAT detects signal (cluster of scored wallets buys new token)
            ↓
Telegram alert fires with CA + full context (<3 seconds)
            ↓
Operator pastes CA into Trojan / taps one-click buy
            ↓
Executed on Trojan infrastructure (<1 second)
            ↓
TP/SL managed by bot automatically
```

This sidesteps the architecture's latency limitations entirely while preserving the intelligence advantage.

### 1.3 Key Differentiators
- **Autonomous wallet discovery:** SWAT finds and curates its own watchlist from on-chain data. No manual input required after initial seeding.
- **Self-pruning:** Underperforming wallets are automatically demoted or removed. The watchlist stays sharp.
- **Execution-ready alerts:** Signal format is designed around what you need to paste into a trading bot — CA front and center, context beneath.
- **Cluster-grade conviction:** Signals are backed by cluster ROI history, not just single wallet activity.
- **Safety checks on every signal:** Mint authority, freeze authority, holder concentration, and liquidity checked before alert fires.

### 1.4 Success Metrics (MVP)
- Autonomously maintain a watchlist of 200–500 scored wallets with <20% manual intervention
- Surface 3–10 actionable signals per day with >70% signal score
- Alert-to-execution latency: <5 seconds (SWAT) + <1 second (Trojan)
- Paper-trade win rate: >55% before enabling any automation
- Cluster confidence >0.80 on at least 30% of active clusters

---

## 2. Hybrid Architecture — Intelligence + Execution Split

### 2.1 System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     SWAT (Intelligence Layer)                │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   Discovery  │───▶│   Indexer    │───▶│  Scorer /    │  │
│  │   Engine     │    │  (Helius RPC │    │  Pruner      │  │
│  │              │    │  + Webhooks) │    │  (Nightly)   │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│         │                   │                   │           │
│         ▼                   ▼                   ▼           │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              PostgreSQL + Redis                       │  │
│  │   wallets | transactions | clusters | signals        │  │
│  └──────────────────────────────────────────────────────┘  │
│         │                   │                   │           │
│         ▼                   ▼                   ▼           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  Cluster     │    │   Signal     │    │   Safety     │  │
│  │  Engine      │───▶│   Engine     │───▶│   Checker    │  │
│  │  (Batch)     │    │  (Real-time) │    │              │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│                              │                              │
│                              ▼                              │
│                    ┌──────────────────┐                     │
│                    │  Alert Service   │                     │
│                    │  (Formatted for  │                     │
│                    │   TG Bot paste)  │                     │
│                    └──────────────────┘                     │
└─────────────────────────────┬───────────────────────────────┘
                              │ Telegram Signal
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Execution Layer (External)                      │
│                                                             │
│   Trojan Bot / Maestro / BonkBot                            │
│   - Pre-configured position size (e.g. 0.5 SOL)            │
│   - Pre-configured slippage (15%)                           │
│   - Pre-configured TP: 2x sell 50%, 3x sell 25%            │
│   - Pre-configured SL: -25%                                 │
│                                                             │
│   Operator sees alert → pastes CA → executes in <1s        │
│   OR: SWAT auto-triggers buy via bot API (score ≥ 90)      │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Service Breakdown

| Service | Purpose | Run Mode |
|---------|---------|----------|
| **Discovery Engine** | Finds new wallets from on-chain data | Continuous + on-demand |
| **Indexer** | Helius webhook consumer + tx parser | Always-on |
| **Scorer / Pruner** | Nightly batch: recalculate scores, demote/remove wallets | Cron (02:00 UTC) |
| **Cluster Engine** | Funding graph + behavioral clustering | Cron (02:30 UTC) + on-demand |
| **Signal Engine** | Real-time pattern detection | Always-on |
| **Safety Checker** | On-chain token safety validation | Per-signal |
| **Alert Service** | Telegram delivery + optional bot API trigger | Event-driven |
| **API Server** | REST API for frontend + config | Always-on |
| **Frontend** | Dashboard, wallet explorer, signal feed | Next.js |

### 2.3 Communication Patterns
- **Real-time:** Helius webhooks → Indexer → Redis Pub/Sub → Signal Engine → Alert Service
- **Async Jobs:** BullMQ for backfills, discovery runs, clustering, and scoring
- **Batch:** Nightly cron for scoring, pruning, and cluster refresh
- **External:** Telegram Bot API for alerts; optional bot API for auto-execution

---

## 3. Data Layer

### 3.1 Data Sources

#### A. Helius (Primary Infrastructure)
- **Enhanced RPC:** `getSignaturesForAddress`, `getParsedTransactions`
- **Webhooks:** Account-level webhooks for tracked wallets (real-time tx notifications)
- **Priority Fees:** Dynamic fee estimation
- **Cost:** Free tier → $49/mo (Growth) → $199/mo (Business)
- **Usage:** All on-chain data ingestion, webhook delivery

#### B. DexScreener (Price & Token Data)
- **Endpoint:** `https://api.dexscreener.com/latest/dex/tokens/{mint}`
- **Data:** USD price at transaction time, liquidity, volume, pair address
- **Cost:** Free (rate limited)
- **Usage:** USD enrichment on every transaction insert; liquidity validation on signals

#### C. Jupiter (Token Metadata & Price)
- **Token List:** Verified token metadata, mint authority status
- **Quote API:** Pre-execution price impact estimation
- **Cost:** Free
- **Usage:** Token safety checks, symbol/name resolution

#### D. On-Chain Safety Checks (via Helius RPC)
- `getAccountInfo` on token mint → check mint authority, freeze authority
- `getTokenLargestAccounts` → top holder concentration
- **Usage:** Per-signal safety validation before alert fires

### 3.2 Data Flow

```
Helius Webhook (Account Update)
    │
    ▼
[Indexer Service]
    ├── Parse swap instruction
    ├── Resolve USD value (DexScreener price)
    ├── Write to transactions table
    └── Publish to Redis: swat:wallet:swap
              │
              ▼
        [Signal Engine]
              ├── Pattern match across clusters
              ├── Score signal
              └── Enqueue to signal queue
                        │
                        ▼
               [Safety Checker]
                        ├── Mint authority check
                        ├── Freeze authority check
                        ├── Holder concentration check
                        └── Liquidity check
                                  │
                                  ▼
                         [Alert Service]
                                  ├── Format execution-ready alert
                                  ├── Send Telegram message
                                  └── Auto-trigger bot API (if score ≥ 90)
```

### 3.3 Caching Strategy (Redis)

| Key Pattern | TTL | Purpose |
|-------------|-----|---------|
| `token:price:{mint}` | 30s | USD price for USD enrichment |
| `token:metadata:{mint}` | 1h | Name, symbol, decimals, safety flags |
| `wallet:performance:{address}` | 5m | Cached scorecard |
| `cluster:members:{clusterId}` | 15m | Wallet list per cluster |
| `signal:active:{pattern}:{token}:{cluster}` | 10m | Deduplication |
| `discovery:seen:{address}` | 24h | Avoid re-ingesting recently checked wallets |

---

## 4. Autonomous Wallet Discovery Engine

This is the core of SWAT's self-sustaining operation. The system finds its own wallets and keeps the list sharp without manual input.

### 4.1 Discovery Sources

#### Source A: Early Buyer Extraction (Seed from known winners)
Work backwards from tokens that performed well. Find wallets that bought within the first 10 minutes of launch.

```typescript
async function discoverFromToken(tokenMint: string, minInvestedLamports = 500_000_000n) {
  // Get early buyers within first 10 minutes of first recorded transaction
  const earlyBuyers = await query<{
    wallet_address: string;
    first_buy: Date;
    total_invested: string;
  }>(`
    SELECT
      wallet_address,
      MIN(timestamp) as first_buy,
      SUM(amount_in::bigint) as total_invested
    FROM transactions
    WHERE target_token = $1
      AND direction = 'buy'
      AND timestamp < (
        SELECT MIN(timestamp) + INTERVAL '10 minutes'
        FROM transactions WHERE target_token = $1
      )
    GROUP BY wallet_address
    ORDER BY first_buy ASC
    LIMIT 50
  `, [tokenMint]);

  const candidates = earlyBuyers.filter(w => BigInt(w.total_invested) > minInvestedLamports);

  await ingestWallets(candidates.map(w => ({
    address: w.wallet_address,
    source: 'discovered' as const
  })));

  return { discovered: candidates.length };
}
```

#### Source B: Funding Graph Expansion
When a tracked wallet funds a new wallet with SOL, auto-ingest the recipient. Funded wallets from elite operators are high-probability candidates.

```typescript
async function expandFromFundingGraph() {
  // Find SOL transfers from tracked elite/pro wallets to unknown addresses
  const newWallets = await query<{ wallet_b: string }>(`
    SELECT DISTINCT wr.wallet_b
    FROM wallet_relationships wr
    WHERE wr.relationship_type = 'funding'
      AND wr.wallet_a IN (
        SELECT address FROM wallets WHERE tier IN ('elite', 'pro')
      )
      AND wr.wallet_b NOT IN (SELECT address FROM wallets)
    LIMIT 100
  `);

  if (newWallets.length > 0) {
    await ingestWallets(newWallets.map(w => ({
      address: w.wallet_b,
      source: 'discovered' as const
    })));
  }

  return { discovered: newWallets.length };
}
```

#### Source C: Recurring Counterparty Detection
Wallets that repeatedly appear as counterparties to high-scoring tracked wallets are likely operating in the same circles.

```typescript
async function discoverFromCounterparties() {
  const candidates = await query<{ wallet_address: string; overlap_count: number }>(`
    SELECT t2.wallet_address, COUNT(*) as overlap_count
    FROM transactions t1
    JOIN transactions t2
      ON t1.target_token = t2.target_token
      AND ABS(EXTRACT(EPOCH FROM (t1.timestamp - t2.timestamp))) < 300
    JOIN wallets w ON t1.wallet_address = w.address
    WHERE w.tier IN ('elite', 'pro')
      AND t1.direction = 'buy'
      AND t2.direction = 'buy'
      AND t2.wallet_address NOT IN (SELECT address FROM wallets)
    GROUP BY t2.wallet_address
    HAVING COUNT(*) >= 5
    ORDER BY overlap_count DESC
    LIMIT 50
  `);

  if (candidates.length > 0) {
    await ingestWallets(candidates.map(w => ({
      address: w.wallet_address,
      source: 'discovered' as const
    })));
  }

  return { discovered: candidates.length };
}
```

#### Source D: Manual Seed (Initial Bootstrap Only)
On first run, seed with a small list of known profitable wallets or token mints. Everything after that is autonomous.

```bash
# Seed via environment variable (comma-separated)
WALLET_ADDRESSES=wallet1,wallet2,wallet3

# Or seed from a known good token mint
POST /v1/discovery/from-token
{ "tokenMint": "7xKX...3f9A" }
```

### 4.2 Autonomous Maintenance — Scoring & Pruning

Runs nightly at 02:00 UTC. Keeps the watchlist sharp without manual intervention.

```typescript
async function runScoringAndPruning() {
  const wallets = await listWallets();

  for (const wallet of wallets) {
    // 1. Recalculate metrics from raw transactions
    const metrics = await calculateWalletMetrics(wallet.address);

    // 2. Update composite score and tier
    const score = calculateCompositeScore(metrics);
    const tier = scoreToTier(score);
    await updateWalletScore(wallet.address, { ...metrics, score, tier });

    // 3. Pruning rules
    if (metrics.totalTrades >= 50 && score < 40) {
      await setWalletStatus(wallet.address, 'paused');
      continue;
    }

    if (metrics.daysSinceLastActive > 30) {
      await setWalletStatus(wallet.address, 'paused');
      continue;
    }

    if (wallet.source === 'discovered' && metrics.totalTrades >= 20 && score > 75) {
      await setWalletPriority(wallet.address, 'high');
    }
  }

  // 4. Re-activate paused wallets that have new activity
  await reactivateDormantWallets();

  // 5. Expand discovery to backfill gaps
  await expandFromFundingGraph();
  await discoverFromCounterparties();
}
```

**Pruning Rules Summary:**

| Condition | Action |
|-----------|--------|
| Score < 40 after 50+ trades | `status = paused` |
| No activity > 30 days | `status = paused` |
| Discovered wallet, score > 75 after 20 trades | Promote to high priority |
| Paused wallet shows new transaction | Reactivate, re-backfill |
| Wallet funded by elite wallet | Auto-ingest immediately |

---

## 5. Wallet Intelligence & Scoring

### 5.1 USD Enrichment on Ingest

Every transaction must have USD values populated at insert time using DexScreener. This unlocks all downstream scoring.

```typescript
async function enrichTransactionUsd(
  tokenMint: string,
  amountIn: bigint,
  amountOut: bigint,
  direction: 'buy' | 'sell'
): Promise<{ amountInUsd: number; amountOutUsd: number }> {
  const cached = await redis.get(`token:price:${tokenMint}`);
  const price = cached
    ? parseFloat(cached)
    : await fetchDexScreenerPrice(tokenMint);

  if (direction === 'buy') {
    const solPrice = await getSolPrice();
    const amountInUsd = (Number(amountIn) / 1e9) * solPrice;
    return { amountInUsd, amountOutUsd: amountInUsd };
  } else {
    const amountOutUsd = (Number(amountOut) / 1e9) * (await getSolPrice());
    return { amountInUsd: amountOutUsd, amountOutUsd };
  }
}
```

### 5.2 Performance Metrics (Per Wallet)

| Metric | Formula | Update Frequency |
|--------|---------|------------------|
| **Total Trades** | Count of swap transactions | Real-time |
| **Win Rate** | Profitable sells / Total completed positions | Nightly batch |
| **Realized ROI** | FIFO P&L: Σ(sell USD - cost basis USD) / Σ(cost basis USD) | Nightly batch |
| **Unrealized ROI** | Σ(current value - cost basis) / Σ(cost basis) | Every 5 min |
| **Avg Hold Time** | Mean(sell_timestamp - buy_timestamp) per position | Nightly batch |
| **Early Entry Score** | % of tokens bought within 10 min of launch | Nightly batch |
| **Consistency Score** | 1 - (std dev of monthly ROI / mean monthly ROI) | Weekly |

### 5.3 Composite Scoring

```typescript
function calculateCompositeScore(input: WalletScoreInput): number {
  const weights = {
    winRate: 0.25,
    realizedRoi: 0.30,
    earlyEntryScore: 0.25,
    consistencyScore: 0.20
  };

  const normalizedRoi = Math.min(input.realizedRoi / 10, 1); // cap at 10x

  return Number((
    input.winRate * weights.winRate * 100 +
    normalizedRoi * weights.realizedRoi * 100 +
    input.earlyEntryScore * weights.earlyEntryScore * 100 +
    input.consistencyScore * weights.consistencyScore * 100
  ).toFixed(2));
}

function scoreToTier(score: number): WalletTier {
  if (score >= 90) return 'elite';     // Full position size tracking
  if (score >= 75) return 'pro';       // High priority tracking
  if (score >= 60) return 'promising'; // Standard tracking
  return 'speculative';                // Low priority, candidate for pruning
}
```

---

## 6. Clustering & Affiliation Detection

### 6.1 Cluster Types

#### Type 1: Funding Cluster (Highest Confidence)
Wallets funded by the same source wallet within a short window. Strong evidence of single entity control.

```sql
SELECT
  from_address as funder,
  array_agg(to_address) as funded_wallets,
  count(*) as wallet_count
FROM sol_transfers
WHERE amount < 0.5
  AND timestamp > NOW() - INTERVAL '30 days'
GROUP BY from_address
HAVING count(*) >= 3;
```
**Confidence weight: 0.40**

#### Type 2: Timing Correlation Cluster (Medium-High Confidence)
Wallets that repeatedly buy the same tokens within minutes of each other. May be same entity or same private alpha group.

```typescript
async function calculateTimingCorrelation(walletA: string, walletB: string): Promise<number> {
  const commonTokens = await query<{ token: string; time_a: Date; time_b: Date }>(`
    SELECT t1.target_token as token, t1.timestamp as time_a, t2.timestamp as time_b
    FROM transactions t1
    JOIN transactions t2
      ON t1.target_token = t2.target_token
      AND t1.direction = 'buy'
      AND t2.direction = 'buy'
      AND t1.wallet_address = $1
      AND t2.wallet_address = $2
  `, [walletA, walletB]);

  if (commonTokens.length < 3) return 0;

  const correlated = commonTokens.filter(row =>
    Math.abs(row.time_a.getTime() - row.time_b.getTime()) < 15 * 60 * 1000
  );

  return correlated.length / commonTokens.length;
}
```
**Confidence weight: 0.25**

#### Type 3: Behavioral Cluster (Medium Confidence)
Similar position sizes, DEX preferences, hold durations, and time-of-day patterns.
**Confidence weight: 0.20**

#### Type 4: Portfolio Overlap Cluster (Lower Confidence)
High current holding overlap. Could reflect same alpha source rather than same entity.
**Confidence weight: 0.15**

### 6.2 Cluster Confidence Tiers

| Confidence | Label | Treatment |
|------------|-------|-----------|
| > 0.85 | Confirmed | Treat as single entity. Full signal weight. |
| 0.70–0.85 | Likely | Strong signal weight. Flag for manual review. |
| 0.55–0.70 | Possible | Reduced signal weight. Monitor. |
| < 0.55 | Unrelated | Discard relationship. |

### 6.3 Cluster Performance Tracking

Each cluster tracks aggregate performance, so signal confidence can be weighted by the cluster's actual track record.

```sql
UPDATE wallet_clusters SET
  total_realized_roi = (
    SELECT AVG(realized_roi) FROM wallets w
    JOIN cluster_memberships cm ON w.address = cm.wallet_address
    WHERE cm.cluster_id = wallet_clusters.id
  ),
  avg_composite_score = (
    SELECT AVG(composite_score) FROM wallets w
    JOIN cluster_memberships cm ON w.address = cm.wallet_address
    WHERE cm.cluster_id = wallet_clusters.id
  ),
  last_active = NOW()
WHERE id = $1;
```

---

## 7. Pattern Recognition System

### 7.1 Pattern Definitions

#### Pattern A: The Snipe
3+ wallets in a cluster buy the same token within 3 blocks, token is < 30 minutes old.
**Signal strength: Very High | Action: Immediate alert**

#### Pattern B: The Accumulation
Cluster buys the same token across 3+ separate days with increasing position sizes.
**Signal strength: High | Action: Alert with context**

#### Pattern C: The Rotation
Cluster takes profit on Token A and moves into Token B within 1 hour.
**Signal strength: Medium-High | Action: Alert on Token B entry**

#### Pattern D: The Exit
50%+ of cluster sells > 50% of their position in a token within 1 hour.
**Signal strength: High (sell signal) | Action: Exit alert if holding**

#### Pattern E: The Stealth Buy
Cluster buys token with < $100k market cap, no social mentions, holds > 7 days.
**Signal strength: Medium | Action: Research alert, small position**

### 7.2 Signal Scoring

| Factor | Weight | Notes |
|--------|--------|-------|
| Cluster confidence | 0.25 | How sure we are wallets are affiliated |
| Cluster historical ROI | 0.25 | Track record of this specific cluster |
| Pattern type | 0.20 | Snipe > Accumulation > Rotation > Stealth |
| Liquidity | 0.15 | Higher = safer entry and exit |
| Token age | 0.10 | Newer = higher risk/reward |
| Market context | 0.05 | SOL price trend, overall DEX volume |

**Thresholds:**
- **≥ 90:** Auto-trigger bot API (if enabled) + Telegram alert
- **70–89:** Telegram alert, operator executes via bot
- **< 70:** Log only, no alert

### 7.3 Safety Checks (Pre-Alert Gate)

Every signal passes through a safety checker before the alert fires. A failed check suppresses the alert or adds a warning flag.

```typescript
interface SafetyCheckResult {
  passed: boolean;
  flags: string[];     // hard fails — alert suppressed
  warnings: string[];  // soft flags — alert sent with warning
}

async function runSafetyChecks(tokenMint: string): Promise<SafetyCheckResult> {
  const flags: string[] = [];
  const warnings: string[] = [];

  // 1. Mint authority — if not disabled, token supply can be inflated
  const mintInfo = await getMintInfo(tokenMint);
  if (mintInfo.mintAuthority !== null) {
    flags.push('MINT_AUTHORITY_ACTIVE');
  }

  // 2. Freeze authority — if set, wallets can be frozen
  if (mintInfo.freezeAuthority !== null) {
    warnings.push('FREEZE_AUTHORITY_SET');
  }

  // 3. Top holder concentration
  const topHolders = await getTokenLargestAccounts(tokenMint);
  const top10Pct = topHolders.slice(0, 10).reduce((sum, h) => sum + h.pct, 0);
  if (top10Pct > 60) {
    flags.push(`TOP_10_HOLD_${Math.round(top10Pct)}PCT`);
  } else if (top10Pct > 35) {
    warnings.push(`TOP_10_HOLD_${Math.round(top10Pct)}PCT`);
  }

  // 4. Liquidity check
  const liquidity = await getDexScreenerLiquidity(tokenMint);
  if (liquidity < 50_000) {
    flags.push(`LOW_LIQUIDITY_${Math.round(liquidity / 1000)}K`);
  }

  return { passed: flags.length === 0, flags, warnings };
}
```

---

## 8. Signal Formatting & Alert Delivery

### 8.1 Execution-Ready Alert Format

The alert is designed so the operator can act in one step: copy CA → paste into Trojan → buy. All decision context is visible but the CA is unmissable.

```
🎯 SNIPE SIGNAL — Score: 87/100

📋 CA: 7xKXabcd...3f9A
(tap to copy)

Token: $LEMUR (Lemur Finance)
Chain: Solana

━━━━━━━━━━━━━━━━━━━━
📊 CLUSTER INTEL
━━━━━━━━━━━━━━━━━━━━
Cluster: Whale Pod #7
Cluster 90d ROI: +340% ✅
Cluster confidence: 91% ✅
Wallets triggered: 4 of 6 members
Pattern: Snipe (4 buys in 2 blocks)

━━━━━━━━━━━━━━━━━━━━
🪙 TOKEN SAFETY
━━━━━━━━━━━━━━━━━━━━
Liquidity: $127K ✅
Token age: 8 mins ✅
Mint authority: Disabled ✅
Freeze authority: None ✅
Top 10 holders: 34% ⚠️

━━━━━━━━━━━━━━━━━━━━
⚡ SUGGESTED EXECUTION
━━━━━━━━━━━━━━━━━━━━
Size: 0.5 SOL
Slippage: 15%
TP1: 2x → sell 50%
TP2: 3x → sell 25%
SL: -25%

🔗 DexScreener | Solscan | Birdeye
```

### 8.2 Alert Service Implementation

```typescript
async function handleSignal(signal: Signal, safety: SafetyCheckResult) {
  if (!safety.passed) {
    console.log(`[alert] signal ${signal.id} suppressed — safety flags: ${safety.flags.join(', ')}`);
    await updateSignalStatus(signal.id, 'rejected');
    return;
  }

  const message = formatSignalAlert(signal, safety);
  await sendTelegram(message);

  // Auto-trigger only on very high confidence signals
  if (signal.signalScore >= 90 && process.env.AUTO_EXECUTE === 'true') {
    await triggerExternalBot({
      tokenMint: signal.tokenMint,
      amountSol: calculatePositionSize(signal),
      slippageBps: 1500
    });
  }

  await updateSignalStatus(signal.id, 'alerted');
}
```

### 8.3 Exit Alerts

When a sell pattern is detected on a token the operator may be holding:

```
🔴 EXIT SIGNAL

Token: $LEMUR (7xKX...3f9A)
Cluster: Whale Pod #7

4 of 6 cluster wallets sold >50% of position
in the last 45 minutes.

Total exit volume: $84K

Action: Consider taking profit or tightening SL.
```

---

## 9. Execution Layer — External Bot Integration

### 9.1 Why External Bots

| Requirement | Building in SWAT | Trojan/Maestro |
|-------------|-----------------|----------------|
| Execution latency | 2–5s (webhook lag + tx build) | < 1s (co-located RPC) |
| MEV protection | Requires Jito integration ($$$) | Built-in |
| TP/SL management | Requires monitoring infra | Built-in |
| Infrastructure cost | High | $0 (bot takes % fee per trade) |
| Reliability | Dependent on your uptime | High availability |

### 9.2 Recommended Bots

| Bot | Strengths | Best For |
|-----|-----------|----------|
| **Trojan** | Fastest execution, MEV protection, API access | Primary executor |
| **Maestro** | Good TP/SL, copy trade features | Alternative |
| **BonkBot** | Simple, low fee | Backup |
| **Photon** | Good for new launches | Pump.fun tokens |

### 9.3 Pre-Configuration for SWAT Workflow

Set up your chosen bot once with these defaults, then execution is a single paste/tap per signal:

```
Default buy amount: 0.5 SOL (adjust to your risk tolerance)
Slippage: 15% (meme coins need headroom)
MEV protection: ON
Auto TP1: +100% → sell 50%
Auto TP2: +200% → sell 25%
Auto SL: -25%
```

### 9.4 Auto-Execution Mode (Score ≥ 90 Only)

For signals with score ≥ 90 and all safety checks passed, SWAT can trigger the bot automatically without operator input. This requires bot API access (Trojan supports this).

```typescript
async function triggerTrojanBuy(params: {
  tokenMint: string;
  amountSol: number;
  slippageBps: number;
}) {
  const response = await fetch(process.env.TROJAN_API_URL!, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.TROJAN_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      token: params.tokenMint,
      amount: params.amountSol,
      slippage: params.slippageBps / 100
    })
  });

  if (!response.ok) {
    throw new Error(`Trojan API error: ${response.status}`);
  }

  return response.json();
}
```

**Auto-execution is disabled by default (`AUTO_EXECUTE=false`).** Enable only after 2+ weeks of validated paper signal quality.

### 9.5 Position Sizing Logic

```typescript
function calculatePositionSize(signal: Signal): number {
  const base = parseFloat(process.env.BASE_POSITION_SOL ?? '0.5');

  const tierMultiplier: Record<string, number> = {
    elite: 1.0,
    pro: 0.75,
    promising: 0.5,
    speculative: 0.25
  };

  const clusterTier = signal.clusterTier ?? 'promising';
  const scoreMultiplier = signal.signalScore >= 90 ? 1.0
    : signal.signalScore >= 80 ? 0.75
    : 0.5;

  return base * (tierMultiplier[clusterTier] ?? 0.5) * scoreMultiplier;
}
```

---

## 10. Database Schema

### 10.1 PostgreSQL Schema

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE wallets (
  address VARCHAR(44) PRIMARY KEY,
  nickname VARCHAR(100),
  source VARCHAR(50) NOT NULL DEFAULT 'manual',    -- 'shiller','manual','discovered'
  status VARCHAR(20) NOT NULL DEFAULT 'active',    -- 'active','paused','blacklisted'
  priority VARCHAR(20) DEFAULT 'normal',           -- 'high','normal','low'
  first_seen TIMESTAMP DEFAULT NOW(),
  last_active TIMESTAMP,
  total_trades INTEGER DEFAULT 0,
  win_rate DECIMAL(5,2),
  realized_roi DECIMAL(12,4),
  unrealized_roi DECIMAL(12,4),
  avg_hold_time_hours DECIMAL(8,2),
  early_entry_score DECIMAL(5,2),
  consistency_score DECIMAL(5,2),
  composite_score DECIMAL(5,2),
  tier VARCHAR(20),
  portfolio_value_usd DECIMAL(16,2),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

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
  mint_authority_disabled BOOLEAN DEFAULT FALSE,
  freeze_authority_disabled BOOLEAN DEFAULT FALSE,
  tags TEXT[],
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE transactions (
  id BIGSERIAL PRIMARY KEY,
  signature VARCHAR(88) NOT NULL,
  wallet_address VARCHAR(44) REFERENCES wallets(address),
  token_in VARCHAR(44) REFERENCES tokens(mint),
  token_out VARCHAR(44) REFERENCES tokens(mint),
  amount_in BIGINT NOT NULL,
  amount_out BIGINT NOT NULL,
  amount_in_usd DECIMAL(16,6),          -- populated at insert via DexScreener
  amount_out_usd DECIMAL(16,6),         -- populated at insert via DexScreener
  direction VARCHAR(4) NOT NULL,
  target_token VARCHAR(44),
  program_id VARCHAR(44),
  slot BIGINT,
  timestamp TIMESTAMP NOT NULL,
  block_time BIGINT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(signature, wallet_address, target_token)
);
CREATE INDEX idx_tx_wallet ON transactions(wallet_address, timestamp DESC);
CREATE INDEX idx_tx_token ON transactions(target_token, timestamp DESC);

CREATE TABLE wallet_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100),
  description TEXT,
  confidence DECIMAL(3,2) NOT NULL,
  cluster_type VARCHAR(20),             -- 'funding','timing','behavioral','mixed'
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

CREATE TABLE signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_type VARCHAR(20) NOT NULL,
  cluster_id UUID REFERENCES wallet_clusters(id),
  token_mint VARCHAR(44) REFERENCES tokens(mint),
  confidence DECIMAL(5,2) NOT NULL,
  signal_score DECIMAL(5,2) NOT NULL,
  trigger_data JSONB NOT NULL,
  safety_flags TEXT[],
  safety_warnings TEXT[],
  status VARCHAR(20) DEFAULT 'pending',
  alerted_at TIMESTAMP,
  executed_at TIMESTAMP,
  executed_price DECIMAL(16,8),
  executed_amount DECIMAL(16,8),
  trade_signature VARCHAR(88),
  pnl_usd DECIMAL(16,6),
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);
CREATE INDEX idx_signals_status ON signals(status, created_at DESC);
CREATE INDEX idx_signals_cluster ON signals(cluster_id, created_at DESC);

CREATE TABLE trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id UUID REFERENCES signals(id),
  execution_mode VARCHAR(10) NOT NULL,  -- 'auto','manual','paper'
  executor VARCHAR(20),                 -- 'trojan','maestro','bonkbot','internal'
  token_mint VARCHAR(44),
  direction VARCHAR(4) NOT NULL,
  amount_sol DECIMAL(16,8),
  amount_usd DECIMAL(16,6),
  token_amount BIGINT,
  price_usd DECIMAL(16,8),
  slippage_bps INTEGER,
  signature VARCHAR(88),
  status VARCHAR(20) DEFAULT 'pending',
  error_message TEXT,
  executed_at TIMESTAMP DEFAULT NOW(),
  confirmed_at TIMESTAMP
);

CREATE TABLE discovery_log (
  id BIGSERIAL PRIMARY KEY,
  source VARCHAR(20) NOT NULL,          -- 'token','funding','counterparty','manual'
  seed_value VARCHAR(100),
  wallets_discovered INTEGER DEFAULT 0,
  ran_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE config (
  key VARCHAR(50) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO config (key, value) VALUES
('trading', '{"enabled": false, "mode": "paper", "base_position_sol": 0.5, "auto_execute_min_score": 90}'::jsonb),
('risk', '{"stop_loss_pct": 25, "take_profit_levels": [{"pct": 100, "sell": 50}, {"pct": 200, "sell": 25}], "circuit_breaker_failures": 3}'::jsonb),
('signals', '{"min_signal_score": 70, "auto_execute_min_score": 90, "min_liquidity_usd": 50000}'::jsonb),
('discovery', '{"auto_expand_funding_graph": true, "auto_expand_counterparties": true, "min_invested_lamports": 500000000}'::jsonb),
('pruning', '{"min_trades_to_prune": 50, "min_score_to_keep": 40, "max_inactive_days": 30}'::jsonb)
ON CONFLICT (key) DO NOTHING;
```

---

## 11. API Specification

### 11.1 REST Endpoints

**Base URL:** `http://localhost:3001/v1`

#### Wallets
```
GET    /wallets                         List wallets (sorted by score)
GET    /wallets/:address                Wallet details + performance
POST   /wallets                         Manually add wallet(s)
DELETE /wallets/:address                Remove wallet
GET    /wallets/:address/history        Paginated trade history (with USD values)
GET    /wallets/:address/holdings       Current token holdings + unrealized P&L
```

#### Discovery
```
POST   /discovery/from-token            Seed discovery from a token mint
POST   /discovery/run                   Trigger manual discovery run
GET    /discovery/log                   Discovery history and results
```

#### Clusters
```
GET    /clusters                        List clusters (by confidence desc)
GET    /clusters/:id                    Cluster details + member wallets
GET    /clusters/:id/performance        Aggregate P&L + win rate
POST   /clusters/:id/refresh            Trigger re-clustering
GET    /clusters/:id/timeline           Recent cluster activity
```

#### Signals
```
GET    /signals                         List signals (filter by status, score, pattern)
GET    /signals/:id                     Signal detail + safety check results
POST   /signals/:id/execute             Manual execute via configured bot
POST   /signals/:id/ignore              Ignore signal
GET    /signals/stats                   Win rate, ROI on acted signals
```

#### Tokens
```
GET    /tokens/:mint                    Token details + safety info
GET    /tokens/trending                 Trending tokens from DexScreener
```

#### System
```
GET    /health                          Health check
GET    /stats                           Wallets tracked, signals today, win rate
POST   /config                          Update configuration
GET    /trading/status                  Current mode, auto-execute threshold
```

### 11.2 WebSocket Events

```javascript
// Subscribe
{ "action": "subscribe", "channel": "signals" }
{ "action": "subscribe", "channel": "wallet:{address}" }

// Server pushes
{ "type": "signal", "data": { /* signal + safety check */ } }
{ "type": "trade", "data": { /* execution update */ } }
{ "type": "wallet_score_update", "data": { address, score, tier } }
{ "type": "cluster_update", "data": { clusterId, confidence, memberCount } }
```

---

## 12. Frontend Requirements

### 12.1 Pages

| Page | Key Features |
|------|-------------|
| **Dashboard** | Active signals with CA copy button, portfolio P&L, cluster activity feed |
| **Wallets** | Scored table with tier badges, discovery source, prune status; drill down to tx history with USD |
| **Clusters** | Force-directed graph (D3), confidence bars, aggregate ROI, member list |
| **Signals** | Live feed, score + safety breakdown, CA copy button, execute/ignore actions |
| **Discovery** | Run discovery, seed from token mint, view discovery log |
| **Settings** | Bot configuration, position sizing, auto-execute threshold, pruning rules |

### 12.2 Key UI Priorities
- **CA copy button** on every signal card — this is the most-used action
- **Safety badge** (green/amber/red) visible at a glance on every signal
- **Cluster ROI** displayed prominently on signal cards — this is the conviction indicator
- **Tier badges** on wallet list (Elite / Pro / Promising / Speculative)
- Mobile-friendly signal feed for quick action from phone

---

## 13. Security & Risk Management

### 13.1 Signal Integrity
- Every signal requires safety check to pass before alert fires
- Signals expire after 10 minutes — stale signals are suppressed automatically
- Deduplication: same token + cluster cannot fire more than once per 10 minutes
- Anti-patterns filtered: airdrop farming, wash trading, CEX deposits

### 13.2 Auto-Execution Safeguards
- Auto-execute disabled by default (`AUTO_EXECUTE=false`)
- Minimum score threshold: 90 (configurable, conservative by default)
- Daily spend cap: configurable max SOL per day across auto-executed trades
- Circuit breaker: auto-execute pauses after 3 consecutive losses
- All auto-executed trades logged with full signal context for review

### 13.3 API Security
- JWT authentication for all API endpoints
- Helius webhook signature verification on every webhook POST
- Input validation on all wallet addresses and token mints
- Rate limiting: 100 req/min per IP

### 13.4 Key Management
- Bot API keys stored in environment variables, never in DB or code
- Trading wallet private key never touches SWAT codebase when using external bot
- Rotate Helius webhook secret periodically

---

## 14. Deployment & Infrastructure

### 14.1 Local Development

```bash
cp .env.example .env
docker-compose up -d postgres redis
pnpm install
pnpm db:migrate

# Seed initial discovery from a known good token
curl -X POST http://localhost:3001/v1/discovery/from-token \
  -H "Content-Type: application/json" \
  -d '{"tokenMint": "YOUR_SEED_TOKEN_MINT"}'

# Run services
pnpm dev:api
pnpm dev:indexer
pnpm dev:signals
pnpm dev:alerts
pnpm dev:web
```

### 14.2 Environment Variables

```bash
# Infrastructure
DATABASE_URL=postgresql://swat:swat@localhost:5432/swat
REDIS_URL=redis://localhost:6379
PORT=3001
NODE_ENV=development
JWT_SECRET=change-me

# Helius
HELIUS_API_KEY=your_helius_key
HELIUS_WEBHOOK_SECRET=your_webhook_secret

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Execution bot (Trojan recommended)
TROJAN_API_URL=https://api.trojan.so/v1
TROJAN_API_KEY=your_trojan_key

# Trading
AUTO_EXECUTE=false                    # enable only after signal validation
BASE_POSITION_SOL=0.5
AUTO_EXECUTE_MIN_SCORE=90

# Seed wallets (comma-separated, optional — use discovery endpoint instead)
WALLET_ADDRESSES=
```

### 14.3 Production (VPS)

Recommended: Hetzner CX21 (€5.35/mo) + Docker Compose + Caddy for reverse proxy.

Add scorer and discovery as additional services with cron-based execution:

```yaml
# docker-compose additions for production
services:
  scorer:
    build: ./apps/scorer
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=${REDIS_URL}
    # Triggered by cron: 0 2 * * *

  discovery:
    build: ./apps/discovery
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=${REDIS_URL}
      - HELIUS_API_KEY=${HELIUS_API_KEY}
    # Triggered by cron: 30 2 * * *
```

---

## 15. Development Roadmap

### Phase 1: Real Data Foundation (Weeks 1–2)
**Goal:** Wallets with real USD scores

- [ ] DexScreener USD enrichment on transaction insert
- [ ] SOL price feed (cached, refreshed every 30s)
- [ ] Nightly scoring batch: compute win rate, realized ROI (FIFO), write composite_score + tier to wallets
- [ ] Wallet performance visible on frontend

**Deliverable:** Dashboard showing wallets with real, meaningful performance scores.

### Phase 2: Autonomous Discovery (Weeks 3–4)
**Goal:** System finds and maintains its own watchlist

- [ ] `discoverFromToken()` — seed from known profitable token mints
- [ ] `expandFromFundingGraph()` — auto-ingest wallets funded by tracked elites
- [ ] `discoverFromCounterparties()` — ingest frequent co-buyers of tracked wallets
- [ ] Nightly pruning: demote/pause low scorers and dormant wallets
- [ ] Discovery API endpoint + frontend trigger
- [ ] Discovery log visible in dashboard

**Deliverable:** Watchlist grows and self-prunes without manual input.

### Phase 3: Clustering (Weeks 5–6)
**Goal:** Wallets grouped into clusters with confidence scores

- [ ] Funding-source clustering (highest confidence, implement first)
- [ ] Timing correlation clustering
- [ ] Cluster confidence scoring and tier assignment
- [ ] Cluster performance tracking (aggregate ROI, win rate)
- [ ] Cluster graph visualization on frontend

**Deliverable:** Wallets in clusters. Signal engine queries start returning real results.

### Phase 4: Signals + Safety + Alerts (Weeks 7–8)
**Goal:** Execution-ready Telegram alerts with safety checks

- [ ] Safety checker: mint authority, freeze authority, holder concentration, liquidity
- [ ] Signal engine tuning against real cluster data
- [ ] Execution-ready Telegram alert format (CA prominent, context clear)
- [ ] Exit signal detection and formatting
- [ ] Signal deduplication and 10-minute expiry

**Deliverable:** Telegram alerts firing on real patterns, formatted for immediate bot execution.

### Phase 5: Execution Integration (Weeks 9–10)
**Goal:** One-tap or auto execution on high-confidence signals

- [ ] Trojan bot pre-configuration (size, slippage, TP/SL)
- [ ] Auto-execute trigger for score ≥ 90 signals (disabled by default)
- [ ] Position sizing logic (cluster tier × signal score × base size)
- [ ] Trade logging (execution mode, bot used, outcome)
- [ ] Circuit breaker on consecutive losses

**Deliverable:** Full loop from on-chain activity to executed trade.

### Phase 6: Validation & Tuning (Weeks 11–12)
**Goal:** Proven signal quality before scaling capital

- [ ] Paper trade results dashboard (signals fired vs actual price action)
- [ ] Signal score threshold tuning based on real outcomes
- [ ] Cluster confidence weight tuning
- [ ] Backtesting harness for historical signal validation
- [ ] Scale capital only after demonstrating consistent edge

---

## 16. Cost Estimates

### MVP Costs

| Service | Provider | Monthly |
|---------|----------|---------|
| VPS (4GB RAM) | Hetzner CX21 | ~$6 |
| RPC + Webhooks | Helius Growth | $49 |
| Database | Self-hosted Docker | $0 |
| Redis | Self-hosted Docker | $0 |
| Telegram Bot | BotFather | $0 |
| Trading bot fees | Trojan (~1% per trade) | Variable |
| **Total fixed** | | **~$55/mo** |

### Trading Capital Guidelines

| Phase | Capital | Condition |
|-------|---------|-----------|
| Paper trading | $0 | Always first — no exceptions |
| Initial live | 0.5–1 SOL per signal | After 2+ weeks paper with >55% win rate |
| Scale up | Gradual | After documented profitable track record only |

---

## 17. Appendix

### A. Solana Program IDs

| Program | Address |
|---------|---------|
| Raydium AMM | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` |
| Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` |
| Orca Whirlpool | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` |
| Jupiter v6 | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` |
| Pump.fun | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` |
| Meteora DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |

### B. Folder Structure

```
swat/
├── apps/
│   ├── api/                 # REST API + WebSocket
│   ├── indexer/             # Helius webhook consumer + tx parser + USD enrichment
│   ├── signal-engine/       # Pattern detection + signal generation + safety checks
│   ├── alert-service/       # Telegram delivery + bot API trigger
│   ├── scorer/              # Nightly wallet scoring + pruning batch
│   ├── discovery/           # Autonomous wallet discovery engine
│   └── web/                 # Next.js dashboard
├── packages/
│   ├── db/                  # Schema + migrations + DB helpers
│   └── shared/              # Types, scoring, constants, validation
├── docker-compose.yml
├── turbo.json
└── README.md
```

### C. Signal Quality Validation Checklist

Before enabling auto-execution, verify each of the following over a minimum 2-week paper period:

- [ ] Signal win rate > 55% (signals that were actionable and would have profited)
- [ ] Average signal-to-peak time < 2 hours (confirms timing advantage over crowd)
- [ ] Safety checker blocking rate < 30% (confirms quality signals, not noise)
- [ ] Cluster confidence correlates with signal win rate (higher confidence = higher win rate)
- [ ] No more than 3 rugs slipping through safety checks in 2 weeks
- [ ] Alert-to-operator latency < 5 seconds consistently

Only after all boxes are checked should auto-execution be enabled, and only at minimum position sizes.

---

## Conclusion

SWAT operates as a **self-sustaining intelligence layer** feeding a fast external execution layer. The architecture acknowledges that competing on raw execution speed against co-located bots is economically impractical for an MVP. Instead, SWAT competes on **information quality and timing** — surfacing high-conviction signals before the crowd notices, then delegating execution to purpose-built tools that already have the infrastructure.

The system requires minimal ongoing manual input:
- Wallets are discovered and pruned autonomously
- Clusters form and update on schedule
- Signals fire with safety gates already passed
- The operator's only required action is reviewing the Telegram alert and deciding to execute

The edge is knowing **who** is buying, **how confident** we are in that cluster's track record, and getting that information fast enough to act before the broader market reacts.

**First action:** Get real USD values into the `transactions` table. Everything downstream — scoring, clustering, signals — depends on that being populated correctly.
