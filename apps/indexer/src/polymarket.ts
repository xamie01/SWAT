import {
  insertParsedTransaction,
  upsertToken,
  refreshWalletActivity,
  getPolymarketMarket,
  upsertPolymarketMarket,
  insertPolymarketMarketSkeleton,
  linkTokenToPolymarketMarket,
  getTokensByPolymarketCondition
} from '@swat/db';
import { Redis } from 'ioredis';
import { REDIS_CHANNELS } from '@swat/shared';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

type PolymarketTradeActivity = {
  proxyWallet: string;
  timestamp: string;
  type: 'TRADE' | string;
  conditionId: string;
  size: number; // Number of outcome tokens
  usdcSize: number; // USD value
  price: number; // Price per share (0-1)
  side: 'BUY' | 'SELL';
  transactionHash: string;
  outcome: string; // "Yes" or "No" (or others)
  title: string; // Market question title
  asset?: string; // clobTokenId
};

type GammaMarket = {
  id: string;
  question: string;
  slug: string;
  endDate: string;
  resolutionSource: string;
  outcomes: string[];
  clobTokenIds: string[];
  active: boolean;
  closed: boolean;
};

// Collateral token for Polymarket (pUSD / USDC)
const POLYMARKET_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

async function fetchGammaMarket(conditionId: string): Promise<GammaMarket | null> {
  try {
    const response = await fetch(`https://gamma-api.polymarket.com/markets?condition_id=${conditionId}`);
    if (!response.ok) return null;
    const list = await response.json() as GammaMarket[];
    if (!list || list.length === 0) return null;
    return list[0];
  } catch (e) {
    console.error(`[polymarket] failed to fetch Gamma market for ${conditionId}:`, e);
    return null;
  }
}

async function ensurePolymarketMarketAndTokens(conditionId: string, tradeOutcome: string, tradeTitle: string): Promise<string> {
  // Check cache first
  const cached = await getPolymarketMarket(conditionId);

  let clobTokenId = '';

  if (!cached) {
    // Fetch market metadata from Gamma API
    const market = await fetchGammaMarket(conditionId);

    if (market) {
      // Save market definition
      await upsertPolymarketMarket({
        conditionId,
        question: market.question,
        slug: market.slug,
        endDate: market.endDate ? new Date(market.endDate) : null,
        resolutionSource: market.resolutionSource ?? null,
        outcomeCount: market.outcomes.length,
        clobTokenIds: market.clobTokenIds,
        status: market.closed ? 'closed' : 'active'
      });

      // Create tokens for outcomes
      for (let i = 0; i < market.outcomes.length; i++) {
        const outcomeName = market.outcomes[i];
        const tokenId = market.clobTokenIds[i];

        if (tokenId) {
          // Pre-register token record
          await upsertToken(tokenId, {
            chain: 'polygon',
            decimals: 6,
            symbol: outcomeName.toUpperCase().slice(0, 10),
            name: `${market.question} (${outcomeName})`
          });

          // Update parent link
          await linkTokenToPolymarketMarket(conditionId, tokenId);

          if (outcomeName.toLowerCase() === tradeOutcome.toLowerCase()) {
            clobTokenId = tokenId;
          }
        }
      }
    } else {
      // Fallback: insert minimum skeleton
      await insertPolymarketMarketSkeleton(conditionId, tradeTitle);
    }
  }

  // If clobTokenId not found from Gamma, query tokens matching the conditionId
  if (!clobTokenId) {
    const tokens = await getTokensByPolymarketCondition(conditionId);
    const matched = tokens.find(t => t.symbol.toLowerCase() === tradeOutcome.toLowerCase());
    if (matched) {
      clobTokenId = matched.mint.includes(':') ? matched.mint.split(':')[1] : matched.mint;
    } else {
      // Create a fallback tokenId derived from conditionId
      clobTokenId = `${conditionId}-${tradeOutcome.toLowerCase()}`;
      await upsertToken(clobTokenId, {
        chain: 'polygon',
        decimals: 6,
        symbol: tradeOutcome.toUpperCase().slice(0, 10),
        name: `${tradeTitle} (${tradeOutcome})`
      });
      await linkTokenToPolymarketMarket(conditionId, clobTokenId);
    }
  }

  return clobTokenId;
}

export async function backfillPolymarketWallet(address: string) {
  const cleanAddr = address.includes(':') ? address.split(':')[1] : address;
  console.log(`[polymarket] Backfilling wallet ${cleanAddr}`);

  // Ensure collateral token exists
  await upsertToken(POLYMARKET_USDC, {
    chain: 'polygon',
    decimals: 6,
    symbol: 'USDC',
    name: 'USD Coin'
  });

  let processed = 0;
  let newTrades = 0;
  let latestTimestamp: Date | null = null;
  let offset = 0;
  const limit = 100;

  try {
    while (true) {
      const response = await fetch(`https://data-api.polymarket.com/activity?user=${cleanAddr}&limit=${limit}&offset=${offset}`);
      if (!response.ok) {
        throw new Error(`Polymarket Data API returned status ${response.status}`);
      }

      const activities = await response.json() as PolymarketTradeActivity[];
      if (activities.length === 0) {
        break;
      }

      console.log(`[polymarket] Fetched ${activities.length} activities (offset: ${offset}) for ${cleanAddr}`);

      for (const act of activities) {
        if (act.type !== 'TRADE' && act.type !== 'REDEEM') continue;
        if (!act.conditionId) continue;

        const clobTokenId = await ensurePolymarketMarketAndTokens(act.conditionId, act.outcome, act.title);

        const timestamp = new Date(act.timestamp);
        const blockTime = Math.floor(timestamp.getTime() / 1000);

        // Value of USDC transacted
        const usdVal = Number(act.usdcSize);
        const side = act.type === 'REDEEM' ? 'SELL' : act.side;
        
        const insertPayload = {
          chain: 'polygon' as const,
          signature: act.transactionHash,
          walletAddress: cleanAddr,
          tokenIn: side === 'BUY' ? POLYMARKET_USDC : clobTokenId,
          tokenOut: side === 'BUY' ? clobTokenId : POLYMARKET_USDC,
          amountIn: side === 'BUY' ? String(Math.round(usdVal * 1e6)) : String(Math.round(act.size * 1e6)),
          amountOut: side === 'BUY' ? String(Math.round(act.size * 1e6)) : String(Math.round(usdVal * 1e6)),
          amountInUsd: usdVal,
          amountOutUsd: usdVal,
          direction: side === 'BUY' ? ('buy' as const) : ('sell' as const),
          targetToken: clobTokenId,
          programId: 'polymarket',
          slot: null,
          timestamp,
          blockTime
        };

        const inserted = await insertParsedTransaction(insertPayload);
        processed++;
        if (inserted) {
          newTrades++;
          if (!latestTimestamp || timestamp > latestTimestamp) {
            latestTimestamp = timestamp;
          }
          
          // Notify signal-engine of swap
          await redis.publish(
            REDIS_CHANNELS.walletSwap,
            JSON.stringify({
              chain: 'polygon',
              walletAddress: `polygon:${cleanAddr}`,
              signature: act.transactionHash,
              tokenMint: `polygon:${clobTokenId}`,
              direction: side === 'BUY' ? 'buy' : 'sell',
              amountUsd: usdVal,
              timestamp: timestamp.toISOString()
            })
          );
        }
      }

      if (activities.length < limit) {
        break;
      }
      offset += limit;
    }

    await refreshWalletActivity(`polygon:${cleanAddr}`, latestTimestamp, newTrades);
    return { processed, newTrades };
  } catch (err: any) {
    console.error(`[polymarket] backfill failed for ${cleanAddr}:`, err);
    throw err;
  }
}
