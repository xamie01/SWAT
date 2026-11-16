import { randomUUID } from 'node:crypto';
import {
  createSqlResolutionPollStore,
  getPolymarketOutcomeContext,
  insertParsedTransaction,
  multiplyDecimalText,
  withTransaction,
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
  observedIngestionEvidence,
  type IngestionBatchResult
} from './ingestion-health.js';
import {
  parseConfirmedPolymarketTrade,
  parsePolymarketMarketContext,
  PolymarketMetadataValidationError,
  validatePolymarketMetadataAliases,
  type ConfirmedPolymarketTrade
} from './polymarket-helpers.js';
import {
  pollPolymarketResolutionsBounded,
  ResolutionPollError,
  withholdUnverifiedResolution
} from './polymarket-resolution-polling.js';
import {
  persistPolymarketSourceTrade,
  SourceTradePersistenceError
} from './source-trade-lifecycle.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const POLYMARKET_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
let redis: Redis | null = null;

export type FetchImplementation = typeof fetch;

export type PolymarketBackfillDependencies = {
  fetchImpl?: FetchImplementation;
  publish?: (channel: string, message: string) => Promise<unknown>;
  metadataLimits?: { maxRequests?: number; timeoutMs?: number; maxBytes?: number };
};

export class PolymarketMetadataBudgetError extends Error {}

export function isPolymarketMetadataBudgetError(error: unknown): error is PolymarketMetadataBudgetError {
  return error instanceof PolymarketMetadataBudgetError;
}

export type PolymarketMetadataBudget = {
  remainingRequests: number;
  remainingBytes: number;
  timeoutMs: number;
  deadlineAt: number | null;
};

export function createMetadataBudget(limits: PolymarketBackfillDependencies['metadataLimits']): PolymarketMetadataBudget {
  const maxRequests = limits?.maxRequests ?? 100;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 1_000) {
    throw new Error('Invalid Polymarket metadata request budget');
  }
  const timeoutMs = limits?.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('Invalid Polymarket metadata operation timeout');
  }
  const maxBytes = limits?.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) {
    throw new Error('Invalid Polymarket metadata byte budget');
  }
  return { remainingRequests: maxRequests, remainingBytes: maxBytes, timeoutMs, deadlineAt: null };
}

function metadataTimeRemaining(budget: PolymarketMetadataBudget): number {
  budget.deadlineAt ??= performance.now() + budget.timeoutMs;
  const remaining = budget.deadlineAt - performance.now();
  if (remaining <= 0) throw new PolymarketMetadataBudgetError('Polymarket metadata operation deadline exceeded');
  return remaining;
}

function getRedis(): Redis {
  redis ??= new Redis(redisUrl, { maxRetriesPerRequest: null });
  return redis;
}

/**
 * Page size for Data API v2.
 */
const TRADES_PAGE_LIMIT = 500;

function rawTradeTimestampSeconds(row: unknown): number | null {
  const value = (row as { timestamp?: unknown } | null)?.timestamp;
  const seconds = typeof value === 'string' ? Number(value) : value;
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null;
}

/**
 * Read a wallet's confirmed-trade history out of Polymarket Data API v2.
 *
 * Uses opaque cursor pagination via `next_cursor` across `https://data-api.polymarket.com/v2/trades`.
 * Handles both the v2 envelope `{ data: [...], pagination: { next_cursor, has_more } }`
 * and bare arrays for backwards compatibility with legacy mocks.
 */
export async function fetchConfirmedPolymarketTradePages(input: {
  user: string;
  fetchImpl: FetchImplementation;
  pageLimit?: number;
  maxOffset?: number;
  maxPages?: number;
  timeoutMs?: number;
}): Promise<unknown[]> {
  const pageLimit = input.pageLimit ?? TRADES_PAGE_LIMIT;
  const maxItems = input.maxOffset ?? 25_000;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 25_000) {
    throw new Error('Invalid Polymarket trade item budget');
  }
  const maxPages = input.maxPages ?? 100;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100
      || !Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > TRADES_PAGE_LIMIT) {
    throw new Error('Invalid Polymarket trade page budget');
  }
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid Polymarket trade deadline');
  const deadlineAt = performance.now() + timeoutMs;
  const checkDeadline = () => {
    if (performance.now() >= deadlineAt) {
      throw new Error('Polymarket trade history incomplete: operation deadline exceeded');
    }
  };
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectDeadline!: (reason: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    rejectDeadline(new Error('Polymarket trade history incomplete: operation deadline exceeded'));
    controller.abort();
    void reader?.cancel().catch(() => {});
  }, timeoutMs);
  try {
    const rawTrades: unknown[] = [];
    let pages = 0;
    let totalBytes = 0;
    let cursor: string | null = null;
    const visitedCursors = new Set<string>();

    while (true) {
      if (pages++ >= maxPages) throw new Error('Polymarket trade history incomplete: page budget exhausted');
      const url = new URL('https://data-api.polymarket.com/v2/trades');
      // `user` first so the query string stays recognisable in logs and tests.
      url.searchParams.set('user', input.user);
      url.searchParams.set('limit', String(pageLimit));
      if (cursor) {
        url.searchParams.set('cursor', cursor);
      }

      checkDeadline();
      const fetchResponse = input.fetchImpl(url.toString(), { signal: controller.signal, redirect: 'error' })
        .then((response) => {
          if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
          return response;
        });
      const response = await Promise.race([fetchResponse, deadline]);
      if (performance.now() >= deadlineAt) {
        void response.body?.cancel().catch(() => {});
        checkDeadline();
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`Polymarket Data API returned status ${response.status}`);
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error('Polymarket Data API returned an empty response body');
      const chunks: Uint8Array[] = [];
      let pageBytes = 0;
      while (true) {
        checkDeadline();
        const result = await Promise.race([reader.read(), deadline]);
        checkDeadline();
        if (result.done) break;
        pageBytes += result.value.byteLength;
        totalBytes += result.value.byteLength;
        if (pageBytes > 8 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024) {
          throw new Error('Polymarket trade history incomplete: response byte budget exceeded');
        }
        chunks.push(result.value);
      }
      reader.releaseLock();
      reader = undefined;
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'), (
        key: string, value: unknown, context?: { source?: string }
      ) => {
        // Number values have already been rounded; only the original JSON token is authoritative.
        if ((key === 'size' || key === 'price') && typeof value === 'number') {
          if (typeof context?.source !== 'string') throw new Error('Polymarket exact JSON number parsing unavailable');
          return context.source;
        }
        return value;
      }) as unknown;
      checkDeadline();
      let page: unknown[] = [];
      let nextCursor: string | null = null;
      let hasMore: boolean | undefined = undefined;
      let explicitTerminal = false;

      if (Array.isArray(payload)) {
        page = payload;
      } else if (payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).data)) {
        page = (payload as Record<string, unknown>).data as unknown[];
        const paginationValue = (payload as Record<string, unknown>).pagination;
        if (!paginationValue || typeof paginationValue !== 'object' || Array.isArray(paginationValue)) {
          throw new Error('Polymarket trade history incomplete: missing pagination metadata');
        }
        const pagination = paginationValue as Record<string, unknown>;
        if ((pagination.next_cursor !== undefined && pagination.next_cursor !== null
              && (typeof pagination.next_cursor !== 'string' || pagination.next_cursor.length === 0 || pagination.next_cursor.length > 4096))
            || (pagination.has_more !== undefined && typeof pagination.has_more !== 'boolean')) {
          throw new Error('Polymarket trade history incomplete: malformed pagination metadata');
        }
        nextCursor = typeof pagination.next_cursor === 'string' ? pagination.next_cursor : null;
        hasMore = pagination.has_more as boolean | undefined;
        explicitTerminal = pagination.next_cursor === null || hasMore === false;
        if (!nextCursor && hasMore !== false && pagination.next_cursor !== null) {
          throw new Error('Polymarket trade history incomplete: missing terminal pagination marker');
        }
        if (nextCursor && hasMore === false) {
          throw new Error('Polymarket trade history incomplete: contradictory pagination metadata');
        }
      } else {
        throw new Error('Polymarket Data API returned an invalid trade page envelope');
      }

      if (page.length > pageLimit) {
        throw new Error('Polymarket trade history incomplete: provider page exceeds requested limit');
      }
      if (page.length === 0) {
        if (nextCursor || hasMore === true) throw new Error('Polymarket trade history incomplete: inconsistent empty pagination');
        break;
      }
      if (hasMore === true && !nextCursor) throw new Error('Polymarket trade history incomplete: missing pagination cursor');
      console.log(
        `[polymarket] Fetched ${page.length} confirmed trades`
        + `${cursor ? ` (cursor: ${cursor.slice(0, 16)}...)` : ''} for ${input.user}`
      );
      if (rawTrades.length + page.length > maxItems) {
        throw new Error('Polymarket trade history incomplete: item budget exceeded');
      }
      rawTrades.push(...page);

      if (rawTrades.length === maxItems && (nextCursor || hasMore === true)) {
        throw new Error('Polymarket trade history incomplete: item budget exhausted');
      }

      if (nextCursor) {
        if (visitedCursors.has(nextCursor)) {
          throw new Error('Polymarket trade history incomplete: cursor cycle detected');
        }
        visitedCursors.add(nextCursor);
        cursor = nextCursor;
      } else if (explicitTerminal || page.length < pageLimit) {
        break;
      } else {
        throw new Error('Polymarket trade history incomplete: missing terminal pagination marker');
      }
    }

    checkDeadline();
    return rawTrades;
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

async function fetchMetadataJson(
  url: string, fetchImpl: FetchImplementation, budget: PolymarketMetadataBudget
): Promise<unknown> {
  const remainingMs = metadataTimeRemaining(budget);
  if (budget.remainingRequests === 0) throw new PolymarketMetadataBudgetError('Polymarket metadata request budget exceeded');
  if (budget.remainingBytes === 0) throw new PolymarketMetadataBudgetError('Polymarket metadata operation byte budget exhausted');
  budget.remainingRequests--;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectDeadline!: (reason: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    rejectDeadline(remainingMs <= 5_000
      ? new PolymarketMetadataBudgetError('Polymarket metadata operation deadline exceeded')
      : new Error('Polymarket metadata deadline exceeded'));
    controller.abort();
    void reader?.cancel().catch(() => {});
  }, Math.min(5_000, remainingMs));
  try {
    const fetchResponse = fetchImpl(url, { signal: controller.signal, redirect: 'error' })
      .then((response) => {
        if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
        return response;
      });
    const response = await Promise.race([fetchResponse, deadline]);
    if (budget.deadlineAt !== null && performance.now() >= budget.deadlineAt) {
      void response.body?.cancel().catch(() => {});
      throw new PolymarketMetadataBudgetError('Polymarket metadata operation deadline exceeded');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`Polymarket metadata returned status ${response.status}`);
    }
    reader = response.body?.getReader();
    if (!reader) throw new Error('Polymarket metadata returned an empty response body');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const result = await Promise.race([reader.read(), deadline]);
      metadataTimeRemaining(budget);
      if (result.done) break;
      bytes += result.value.byteLength;
      budget.remainingBytes -= result.value.byteLength;
      if (budget.remainingBytes < 0) throw new PolymarketMetadataBudgetError('Polymarket metadata operation byte budget exceeded');
      if (bytes > 2 * 1024 * 1024) throw new Error('Polymarket metadata byte budget exceeded');
      chunks.push(result.value);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    metadataTimeRemaining(budget);
    return payload;
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}

export async function fetchGammaMarket(
  conditionId: string,
  fetchImpl: FetchImplementation,
  budget: PolymarketMetadataBudget
): Promise<Record<string, unknown>> {
  const normTarget = conditionId.toLowerCase();

  // Try 1: Open / active markets via condition_id and condition_ids
  try {
    const payload = await fetchMetadataJson(
      `https://gamma-api.polymarket.com/markets?condition_id=${encodeURIComponent(conditionId)}&condition_ids=${encodeURIComponent(conditionId)}`,
      fetchImpl,
      budget
    );
    {
      if (Array.isArray(payload)) {
        const match = payload
          .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
          .map(validatePolymarketMetadataAliases)
          .find(m => m.conditionId === normTarget);
        if (match) return match;
      }
    }
  } catch (error) {
    if (error instanceof PolymarketMetadataBudgetError || error instanceof PolymarketMetadataValidationError) throw error;
    // Fall through to closed markets
  }

  // Try 2: Closed / resolved historical markets via condition_id, condition_ids, & closed=true
  try {
    const payload = await fetchMetadataJson(
      `https://gamma-api.polymarket.com/markets?condition_id=${encodeURIComponent(conditionId)}&condition_ids=${encodeURIComponent(conditionId)}&closed=true`,
      fetchImpl,
      budget
    );
    {
      if (Array.isArray(payload)) {
        const match = payload
          .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
          .map(validatePolymarketMetadataAliases)
          .find(m => m.conditionId === normTarget);
        if (match) return match;
      }
    }
  } catch (error) {
    if (error instanceof PolymarketMetadataBudgetError || error instanceof PolymarketMetadataValidationError) throw error;
    // Fall through to CLOB fallback
  }

  // Try 3: CLOB market endpoint directly as ultimate fallback
  try {
    const clobData = await fetchMetadataJson(
      `https://clob.polymarket.com/markets/${encodeURIComponent(conditionId)}`,
      fetchImpl,
      budget
    ) as Record<string, unknown>;
    {
      if (clobData && Array.isArray(clobData.tokens)
          && typeof clobData.condition_id === 'string'
          && clobData.condition_id.toLowerCase() === normTarget) {
        const validated = validatePolymarketMetadataAliases(clobData);
        return {
          ...validated,
          outcomes: (clobData.tokens as any[]).map((t) => t.outcome),
          clobTokenIds: (clobData.tokens as any[]).map((t) => t.token_id)
        };
      }
    }
  } catch (error) {
    if (error instanceof PolymarketMetadataBudgetError || error instanceof PolymarketMetadataValidationError) throw error;
    // Ignore
  }

  throw new Error(`Polymarket market context not found for ${conditionId}`);
}

async function fetchTickSize(asset: string, fetchImpl: FetchImplementation, budget: PolymarketMetadataBudget): Promise<unknown> {
  const payload = await fetchMetadataJson(
    `https://clob.polymarket.com/tick-size?token_id=${encodeURIComponent(asset)}`,
    fetchImpl,
    budget
  ) as Record<string, unknown>;
  return validatePolymarketMetadataAliases(payload).orderPriceMinTickSize;
}

async function ensurePolymarketContext(
  trade: ConfirmedPolymarketTrade,
  fetchImpl: FetchImplementation,
  budget: PolymarketMetadataBudget,
  validatedContexts: Map<string, NonNullable<Awaited<ReturnType<typeof getPolymarketOutcomeContext>>>>
) {
  metadataTimeRemaining(budget);
  const validated = validatedContexts.get(trade.asset);
  if (validated) {
    if (validated.conditionId !== trade.conditionId || validated.outcome.toLowerCase() !== trade.outcome.toLowerCase()) {
      throw new Error(`Validated Polymarket mapping conflicts with trade ${trade.transactionHash}`);
    }
    return validated;
  }
  // The DB projection has no provider retrieval evidence. contextComplete and
  // updated_at cannot prove freshness or undo historically fabricated defaults.
  const rawMarket = await fetchGammaMarket(trade.conditionId, fetchImpl, budget);
  const hasTickSize = rawMarket.orderPriceMinTickSize !== undefined;
  const fallbackTickSize = hasTickSize ? undefined : await fetchTickSize(trade.asset, fetchImpl, budget);
  const market = parsePolymarketMarketContext(rawMarket, trade.conditionId, fallbackTickSize);
  if (new Set(market.outcomes.map((outcome) => outcome.tokenId)).size !== market.outcomes.length
      || new Set(market.outcomes.map((outcome) => outcome.outcome.toLowerCase())).size !== market.outcomes.length) {
    throw new Error(`Ambiguous Polymarket outcome mapping for ${trade.conditionId}`);
  }
  const tradedOutcome = market.outcomes.find((outcome) => outcome.tokenId === trade.asset);
  if (!tradedOutcome) {
    throw new Error(`Trade asset ${trade.asset} is not mapped by market ${trade.conditionId}`);
  }
  if (tradedOutcome.outcome.toLowerCase() !== trade.outcome.toLowerCase()) {
    throw new Error(`Trade outcome does not match asset ${trade.asset}`);
  }

  // Keep ownership of DB awaits: no cancellation seam is exposed by this adapter.
  // Refuse subsequent work after completion, rather than racing a live transaction.
  metadataTimeRemaining(budget);
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

  metadataTimeRemaining(budget);
  const persisted = await getPolymarketOutcomeContext(trade.asset);
  metadataTimeRemaining(budget);
  if (!persisted) {
    throw new Error(`Polymarket context was not persisted for asset ${trade.asset}`);
  }
  if (persisted.contextComplete !== true
      || persisted.tokenId !== `polygon:${trade.asset}`
      || persisted.conditionId !== market.conditionId
      || persisted.outcome.toLowerCase() !== tradedOutcome.outcome.toLowerCase()
      || persisted.outcomeIndex !== tradedOutcome.outcomeIndex
      || typeof persisted.negRisk !== 'boolean' || persisted.negRisk !== market.negRisk
      || (typeof persisted.tickSize !== 'string' && typeof persisted.tickSize !== 'number')
      || Number(persisted.tickSize) !== market.tickSize
      || !(persisted.endDate instanceof Date) || persisted.endDate.getTime() !== market.endDate.getTime()
      || persisted.marketStatus !== market.status
      || persisted.acceptingOrders !== market.acceptingOrders
      || persisted.resolutionStatus !== market.resolutionStatus) {
    throw new Error(`Persisted Polymarket context conflicts with retrieved evidence for asset ${trade.asset}`);
  }
  validatedContexts.set(trade.asset, persisted);
  return persisted;
}

function toSixDecimalUnits(value: string, field: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`Invalid ${field} amount for 6-decimal persistence`);
  }
  const [integer = '0', fraction = ''] = value.split('.');
  if (fraction.slice(6).replace(/0/g, '') !== '') {
    throw new Error(`Invalid ${field} sub-atomic precision for 6-decimal persistence`);
  }
  return BigInt(integer + fraction.slice(0, 6).padEnd(6, '0')).toString();
}

export async function backfillPolymarketWallet(
  address: string,
  dependencies: PolymarketBackfillDependencies = {}
): Promise<IngestionBatchResult> {
  const cleanAddr = stripChainPrefix(address).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(cleanAddr)) {
    throw new Error(`Invalid Polygon wallet for Polymarket backfill: ${address}`);
  }
  const metadataBudget = createMetadataBudget(dependencies.metadataLimits);
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
  let observed = 0;
  let quarantined = 0;
  let accepted = 0;
  const evidence = () => observedIngestionEvidence(
    observed, quarantined, accepted, failed > 0 ? 'partial' : 'unknown', 'provider-pagination'
  );
  let lastEventAt: Date | null = null;
  let sourceTradeFailure: SourceTradePersistenceError | null = null;
  const rawTrades = await fetchConfirmedPolymarketTradePages({
    user: cleanAddr,
    fetchImpl
  });

  const proxyActivity = new Map<string, { inserted: number; latestTimestamp: Date }>();
  // No cross-backfill trust: only snapshots checked during this operation qualify.
  const validatedContexts = new Map<string, NonNullable<Awaited<ReturnType<typeof getPolymarketOutcomeContext>>>>();

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
      const context = await ensurePolymarketContext(trade, fetchImpl, metadataBudget, validatedContexts);
      metadataTimeRemaining(metadataBudget);
      await upsertWallet({
        address: trade.proxyWallet,
        chain: 'polygon',
        source: 'discovered',
        discoveryMethod: 'polymarket-proxy'
      });
      metadataTimeRemaining(metadataBudget);
      const usdValue = multiplyDecimalText(trade.size, trade.price);
      const outcomeUnits = toSixDecimalUnits(trade.size, 'Polymarket outcome');
      const sourceTrade = await persistPolymarketSourceTrade({
        trade,
        quantity: outcomeUnits,
        amountUsd: usdValue
      });
      observed++;
      if (!sourceTrade.eligibleForCopy) {
        quarantined++;
        skipped++;
        metadataTimeRemaining(metadataBudget);
        continue;
      }
      accepted++;
      metadataTimeRemaining(metadataBudget);

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

      const collateralUnits = toSixDecimalUnits(usdValue, 'Polymarket collateral');
      const displayUsdValue = Number(usdValue);
      const persisted = await insertParsedTransaction({
        chain: 'polygon',
        signature: trade.transactionHash,
        walletAddress: trade.proxyWallet,
        tokenIn: trade.side === 'BUY' ? POLYMARKET_USDC : trade.asset,
        tokenOut: trade.side === 'BUY' ? trade.asset : POLYMARKET_USDC,
        amountIn: trade.side === 'BUY' ? collateralUnits : outcomeUnits,
        amountOut: trade.side === 'BUY' ? outcomeUnits : collateralUnits,
        amountInUsd: displayUsdValue,
        amountOutUsd: displayUsdValue,
        direction: trade.side === 'BUY' ? 'buy' : 'sell',
        targetToken: trade.asset,
        programId: 'polymarket-data-api',
        slot: null,
        timestamp: trade.timestamp,
        blockTime: Math.floor(trade.timestamp.getTime() / 1000)
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
          amountUsd: displayUsdValue,
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
      if (error instanceof PolymarketMetadataBudgetError) {
        throw new IngestionBatchError('Polymarket metadata operation budget exhausted', {
          fetched: rawTrades.length, inserted, skipped, failed, lastEventAt, evidence: evidence()
        }, { cause: error });
      }
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
    lastEventAt,
    evidence: evidence()
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

export async function pollPolymarketResolutions(): Promise<void> {
  const result = await pollPolymarketResolutionsBounded({
    store: createSqlResolutionPollStore<null>({
      transaction: operation => withTransaction(operation),
      // Coverage bookkeeping only: provider metadata cannot authorize economic writes.
      applyObservation: async () => {}
    }),
    createMetadataBudget,
    fetchGammaMarket,
    isMetadataBudgetError: isPolymarketMetadataBudgetError,
    interpretMetadata: withholdUnverifiedResolution,
    fetchImpl: fetch,
    ownerToken: randomUUID
  });
  // A void/success caller must not mistake even complete metadata coverage for resolution readiness.
  if (result.coverage === 'partial' || result.economicResolution === 'blocked-unverified-evidence') {
    throw new ResolutionPollError('Polymarket economic resolution unavailable: unverified evidence', result);
  }
}
