import {
  getPolymarketMarket,
  getPolymarketOutcomeContext,
  insertParsedTransaction,
  query,
  recordConfirmedPolymarketTrade,
  refreshWalletActivity,
  upsertPolymarketContext,
  upsertToken,
  upsertWallet
} from '@swat/db';
import { Redis } from 'ioredis';
import { REDIS_CHANNELS, stripChainPrefix } from '@swat/shared';
import {
  IngestionBatchError,
  type IngestionBatchResult
} from './ingestion-health.js';
import {
  parseConfirmedPolymarketTrade,
  parsePolymarketMarketContext,
  type ConfirmedPolymarketTrade
} from './polymarket-helpers.js';
import {
  persistPolymarketSourceTrade,
  SourceTradePersistenceError
} from './source-trade-lifecycle.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const POLYMARKET_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
let redis: Redis | null = null;

type FetchImplementation = typeof fetch;

export type PolymarketBackfillDependencies = {
  fetchImpl?: FetchImplementation;
  publish?: (channel: string, message: string) => Promise<unknown>;
};

function getRedis(): Redis {
  redis ??= new Redis(redisUrl, { maxRetriesPerRequest: null });
  return redis;
}

/**
 * Page size. The Data API clamps `limit` at 10000; 500 keeps the request count
 * ~5x lower than the old 100 while staying far inside the 200 req / 10s budget
 * documented for `/trades`.
 */
const TRADES_PAGE_LIMIT = 500;

/**
 * The Data API *rejects* an `offset` past 10000 with a 400 rather than clamping
 * it, and each `start`/`end` window carries its own offset budget.
 */
const TRADES_MAX_OFFSET = 10_000;

function rawTradeTimestampSeconds(row: unknown): number | null {
  const value = (row as { timestamp?: unknown } | null)?.timestamp;
  const seconds = typeof value === 'string' ? Number(value) : value;
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null;
}

/**
 * Read a wallet's whole confirmed-trade history out of the Data API.
 *
 * Paging is windowed, not a flat offset walk. A flat walk cannot get past
 * offset 10000 - the API answers a deeper offset with a 400, which used to
 * abort the entire backfill and discard every page already read, so the
 * highest-volume wallets (exactly the ones worth tracking) could never be
 * backfilled at all. When a window's offset budget is spent we re-anchor `end`
 * on the oldest fill seen and open a fresh window. Rows repeated across a
 * boundary cost nothing: `recordConfirmedPolymarketTrade` dedupes on its
 * natural key and the source-trade fill index is a hash of the same identity.
 */
export async function fetchConfirmedPolymarketTradePages(input: {
  user: string;
  fetchImpl: FetchImplementation;
  pageLimit?: number;
  maxOffset?: number;
}): Promise<unknown[]> {
  const pageLimit = input.pageLimit ?? TRADES_PAGE_LIMIT;
  const maxOffset = input.maxOffset ?? TRADES_MAX_OFFSET;
  const rawTrades: unknown[] = [];
  let offset = 0;
  let windowEnd: number | null = null;
  let oldestInWindow: number | null = null;

  while (true) {
    const url = new URL('https://data-api.polymarket.com/trades');
    // `user` first so the query string stays recognisable in logs and tests.
    url.searchParams.set('user', input.user);
    url.searchParams.set('limit', String(pageLimit));
    url.searchParams.set('offset', String(offset));
    if (windowEnd !== null) url.searchParams.set('end', String(windowEnd));

    const response = await input.fetchImpl(url.toString());
    if (!response.ok) {
      throw new Error(`Polymarket Data API returned status ${response.status}`);
    }
    const page = await response.json() as unknown;
    if (!Array.isArray(page)) throw new Error('Polymarket Data API returned a non-array trade page');
    if (page.length === 0) break;
    console.log(
      `[polymarket] Fetched ${page.length} confirmed trades (offset: ${offset}`
      + `${windowEnd === null ? '' : `, end: ${windowEnd}`}) for ${input.user}`
    );
    rawTrades.push(...page);
    for (const row of page) {
      const seconds = rawTradeTimestampSeconds(row);
      if (seconds === null) continue;
      if (oldestInWindow === null || seconds < oldestInWindow) oldestInWindow = seconds;
    }

    // A short page means this window is exhausted, and the last window is the
    // whole history.
    if (page.length < pageLimit) break;

    offset += pageLimit;
    if (offset + pageLimit <= maxOffset) continue;

    if (oldestInWindow === null) {
      console.warn(
        `[polymarket] offset budget spent with no usable timestamp to re-anchor on for ${input.user};`
        + ' history older than this point was not read'
      );
      break;
    }
    if (windowEnd !== null && oldestInWindow >= windowEnd) {
      // The window did not move, so another pass would re-read the same rows
      // forever. Stop, and say so - a silent truncation here would read as a
      // complete backfill.
      console.warn(
        `[polymarket] could not advance the trade window past ${windowEnd} for ${input.user};`
        + ' history older than that timestamp was not read'
      );
      break;
    }
    windowEnd = oldestInWindow;
    oldestInWindow = null;
    offset = 0;
  }

  return rawTrades;
}

async function fetchGammaMarket(
  conditionId: string,
  fetchImpl: FetchImplementation
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(
    `https://gamma-api.polymarket.com/markets?condition_id=${encodeURIComponent(conditionId)}`
  );
  if (!response.ok) {
    throw new Error(`Polymarket Gamma API returned status ${response.status}`);
  }
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload) || !payload[0] || typeof payload[0] !== 'object') {
    throw new Error(`Polymarket market context not found for ${conditionId}`);
  }
  return payload[0] as Record<string, unknown>;
}

async function fetchTickSize(asset: string, fetchImpl: FetchImplementation): Promise<unknown> {
  const response = await fetchImpl(
    `https://clob.polymarket.com/tick-size?token_id=${encodeURIComponent(asset)}`
  );
  if (!response.ok) {
    throw new Error(`Polymarket CLOB tick-size endpoint returned status ${response.status}`);
  }
  const payload = await response.json() as Record<string, unknown>;
  return payload.minimum_tick_size ?? payload.minimumTickSize;
}

async function ensurePolymarketContext(
  trade: ConfirmedPolymarketTrade,
  fetchImpl: FetchImplementation
) {
  const cached = await getPolymarketOutcomeContext(trade.asset);
  if (cached) {
    if (
      cached.conditionId !== trade.conditionId
      || cached.outcome.toLowerCase() !== trade.outcome.toLowerCase()
    ) {
      throw new Error(`Cached Polymarket outcome mapping conflicts with trade ${trade.transactionHash}`);
    }
    return cached;
  }

  const rawMarket = await fetchGammaMarket(trade.conditionId, fetchImpl);
  const hasTickSize = rawMarket.orderPriceMinTickSize !== undefined
    || rawMarket.minimumTickSize !== undefined;
  const fallbackTickSize = hasTickSize ? undefined : await fetchTickSize(trade.asset, fetchImpl);
  const market = parsePolymarketMarketContext(rawMarket, trade.conditionId, fallbackTickSize);
  const tradedOutcome = market.outcomes.find((outcome) => outcome.tokenId === trade.asset);
  if (!tradedOutcome) {
    throw new Error(`Trade asset ${trade.asset} is not mapped by market ${trade.conditionId}`);
  }
  if (tradedOutcome.outcome.toLowerCase() !== trade.outcome.toLowerCase()) {
    throw new Error(`Trade outcome does not match asset ${trade.asset}`);
  }

  await upsertPolymarketContext({
    conditionId: market.conditionId,
    question: market.question,
    slug: market.slug,
    endDate: market.endDate,
    resolutionSource: market.resolutionSource,
    outcomeCount: market.outcomes.length,
    clobTokenIds: market.outcomes.map((outcome) => outcome.tokenId),
    status: market.status,
    tickSize: market.tickSize,
    negRisk: market.negRisk,
    acceptingOrders: market.acceptingOrders,
    resolutionStatus: market.resolutionStatus,
    outcomes: market.outcomes
  });

  const persisted = await getPolymarketOutcomeContext(trade.asset);
  if (!persisted) {
    throw new Error(`Polymarket context was not persisted for asset ${trade.asset}`);
  }
  return persisted;
}

function toSixDecimalUnits(value: number, field: string): string {
  const units = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(units) || units < 0) {
    throw new Error(`Invalid ${field} amount for 6-decimal persistence`);
  }
  return String(units);
}

export async function backfillPolymarketWallet(
  address: string,
  dependencies: PolymarketBackfillDependencies = {}
): Promise<IngestionBatchResult> {
  const cleanAddr = stripChainPrefix(address).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(cleanAddr)) {
    throw new Error(`Invalid Polygon wallet for Polymarket backfill: ${address}`);
  }
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const publish = dependencies.publish
    ?? ((channel: string, message: string) => getRedis().publish(channel, message));
  console.log(`[polymarket] Backfilling confirmed trades for ${cleanAddr}`);

  await upsertToken(POLYMARKET_USDC, {
    chain: 'polygon',
    decimals: 6,
    symbol: 'USDC',
    name: 'USD Coin'
  });

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let lastEventAt: Date | null = null;
  let sourceTradeFailure: SourceTradePersistenceError | null = null;
  const rawTrades = await fetchConfirmedPolymarketTradePages({
    user: cleanAddr,
    fetchImpl
  });

  const proxyActivity = new Map<string, { inserted: number; latestTimestamp: Date }>();

  for (const rawTrade of rawTrades) {
    let trade: ConfirmedPolymarketTrade;
    try {
      trade = parseConfirmedPolymarketTrade(rawTrade);
    } catch (error) {
      failed++;
      console.warn('[polymarket] rejected invalid confirmed trade:', error);
      continue;
    }

    if (!lastEventAt || trade.timestamp > lastEventAt) lastEventAt = trade.timestamp;

    try {
      const context = await ensurePolymarketContext(trade, fetchImpl);
      await upsertWallet({
        address: trade.proxyWallet,
        chain: 'polygon',
        source: 'discovered',
        discoveryMethod: 'polymarket-proxy'
      });
      await recordConfirmedPolymarketTrade({
        transactionHash: trade.transactionHash,
        proxyWallet: trade.proxyWallet,
        asset: trade.asset,
        conditionId: trade.conditionId,
        side: trade.side,
        size: trade.size,
        price: trade.price,
        timestamp: trade.timestamp
      });

      const usdValue = trade.size * trade.price;
      const outcomeUnits = toSixDecimalUnits(trade.size, 'Polymarket outcome');
      const collateralUnits = toSixDecimalUnits(usdValue, 'Polymarket collateral');
      const persisted = await insertParsedTransaction({
        chain: 'polygon',
        signature: trade.transactionHash,
        walletAddress: trade.proxyWallet,
        tokenIn: trade.side === 'BUY' ? POLYMARKET_USDC : trade.asset,
        tokenOut: trade.side === 'BUY' ? trade.asset : POLYMARKET_USDC,
        amountIn: trade.side === 'BUY' ? collateralUnits : outcomeUnits,
        amountOut: trade.side === 'BUY' ? outcomeUnits : collateralUnits,
        amountInUsd: usdValue,
        amountOutUsd: usdValue,
        direction: trade.side === 'BUY' ? 'buy' : 'sell',
        targetToken: trade.asset,
        programId: 'polymarket-data-api',
        slot: null,
        timestamp: trade.timestamp,
        blockTime: Math.floor(trade.timestamp.getTime() / 1000)
      });
      const sourceTrade = await persistPolymarketSourceTrade({
        trade,
        quantity: outcomeUnits,
        amountUsd: usdValue
      });

      const activity = proxyActivity.get(trade.proxyWallet);
      if (!activity || trade.timestamp > activity.latestTimestamp) {
        proxyActivity.set(trade.proxyWallet, {
          inserted: (activity?.inserted ?? 0) + (persisted ? 1 : 0),
          latestTimestamp: trade.timestamp
        });
      } else if (persisted) {
        activity.inserted++;
      }

      if (!persisted) {
        skipped++;
        continue;
      }
      inserted++;
      await publish(
        REDIS_CHANNELS.walletSwap,
        JSON.stringify({
          chain: 'polygon',
          walletAddress: `polygon:${trade.proxyWallet}`,
          signature: trade.transactionHash,
          sourceTradeId: sourceTrade.event.id,
          tokenMint: context.tokenId,
          direction: trade.side === 'BUY' ? 'buy' : 'sell',
          amountUsd: usdValue,
          timestamp: trade.timestamp.toISOString(),
          conditionId: context.conditionId,
          marketQuestion: context.question,
          outcome: context.outcome,
          marketState: context.marketStatus,
          endDate: context.endDate.toISOString()
        })
      );
    } catch (error) {
      failed++;
      if (error instanceof SourceTradePersistenceError) {
        sourceTradeFailure ??= error;
      }
      console.warn(
        `[polymarket] failed to process confirmed trade ${trade.transactionHash}:`,
        error
      );
    }
  }

  const result = {
    fetched: rawTrades.length,
    inserted,
    skipped,
    failed,
    lastEventAt
  };

  try {
    for (const [proxyWallet, activity] of proxyActivity) {
      await refreshWalletActivity(
        `polygon:${proxyWallet}`,
        activity.latestTimestamp,
        activity.inserted
      );
    }
  } catch (error) {
    throw new IngestionBatchError(
      `Failed to refresh Polymarket proxy wallet activity for ${cleanAddr}`,
      { ...result, failed: result.failed + 1 },
      { cause: error }
    );
  }

  if (sourceTradeFailure) {
    throw new IngestionBatchError(
      `Canonical Polymarket source-trade persistence failed for ${cleanAddr}`,
      result,
      { cause: sourceTradeFailure }
    );
  }

  return result;
}

function parseOutcomePrices(value: unknown): number[] {
  let parsed = value;
  if (typeof value === 'string') parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(Number).filter(Number.isFinite);
}

export async function pollPolymarketResolutions() {
  console.log('[polymarket] Polling for market resolutions...');
  const activeMarkets = await query<{ condition_id: string }>(
    `SELECT condition_id FROM polymarket_markets WHERE status = 'active' AND context_complete = TRUE`
  );

  for (const { condition_id } of activeMarkets) {
    try {
      const cached = await getPolymarketMarket(condition_id);
      const rawMarket = await fetchGammaMarket(condition_id, fetch);
      if (rawMarket.closed === true) {
        const market = parsePolymarketMarketContext(rawMarket, condition_id, cached?.tick_size);
        const prices = parseOutcomePrices(rawMarket.outcomePrices);
        const winningIndex = prices.findIndex((price) => price >= 0.99);
        const winningTokenId = winningIndex >= 0
          ? `polygon:${market.outcomes[winningIndex]?.tokenId}`
          : null;
        await query(
          `UPDATE polymarket_markets
              SET status = 'closed',
                  accepting_orders = FALSE,
                  resolution_status = $1,
                  winning_token_id = $2,
                  updated_at = NOW()
            WHERE condition_id = $3`,
          [market.resolutionStatus, winningTokenId, condition_id]
        );
        console.log(`[polymarket] Market ${condition_id} closed; winning token: ${winningTokenId}`);
      }
    } catch (error) {
      console.error(`[polymarket] failed to poll resolution for ${condition_id}`, error);
    }
  }
}
