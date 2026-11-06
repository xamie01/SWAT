import { getPolymarketMarket, getPolymarketOutcomeContext, insertParsedTransaction, query, recordConfirmedPolymarketTrade, refreshWalletActivity, upsertPolymarketContext, upsertToken, upsertWallet } from '@swat/db';
import { Redis } from 'ioredis';
import { REDIS_CHANNELS, stripChainPrefix } from '@swat/shared';
import { IngestionBatchError } from './ingestion-health.js';
import { parseConfirmedPolymarketTrade, parsePolymarketMarketContext } from './polymarket-helpers.js';
import { persistPolymarketSourceTrade, SourceTradePersistenceError } from './source-trade-lifecycle.js';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const POLYMARKET_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
let redis = null;
function getRedis() {
    redis ??= new Redis(redisUrl, { maxRetriesPerRequest: null });
    return redis;
}
/**
 * Page size for Data API v2.
 */
const TRADES_PAGE_LIMIT = 500;
function rawTradeTimestampSeconds(row) {
    const value = row?.timestamp;
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
export async function fetchConfirmedPolymarketTradePages(input) {
    const pageLimit = input.pageLimit ?? TRADES_PAGE_LIMIT;
    const maxItems = input.maxOffset;
    const rawTrades = [];
    let cursor = null;
    while (true) {
        const url = new URL('https://data-api.polymarket.com/v2/trades');
        // `user` first so the query string stays recognisable in logs and tests.
        url.searchParams.set('user', input.user);
        url.searchParams.set('limit', String(pageLimit));
        if (cursor) {
            url.searchParams.set('cursor', cursor);
        }
        const response = await input.fetchImpl(url.toString());
        if (!response.ok) {
            throw new Error(`Polymarket Data API returned status ${response.status}`);
        }
        const payload = await response.json();
        let page = [];
        let nextCursor = null;
        let hasMore = undefined;
        if (Array.isArray(payload)) {
            page = payload;
        }
        else if (payload && typeof payload === 'object' && Array.isArray(payload.data)) {
            page = payload.data;
            const pagination = payload.pagination;
            nextCursor = typeof pagination?.next_cursor === 'string' && pagination.next_cursor.trim()
                ? pagination.next_cursor.trim()
                : null;
            hasMore = typeof pagination?.has_more === 'boolean' ? pagination.has_more : undefined;
        }
        else {
            throw new Error('Polymarket Data API returned an invalid trade page envelope');
        }
        if (page.length === 0)
            break;
        console.log(`[polymarket] Fetched ${page.length} confirmed trades`
            + `${cursor ? ` (cursor: ${cursor.slice(0, 16)}...)` : ''} for ${input.user}`);
        rawTrades.push(...page);
        if (maxItems !== undefined && rawTrades.length >= maxItems) {
            break;
        }
        if (nextCursor) {
            if (cursor === nextCursor) {
                console.warn(`[polymarket] cursor did not advance for ${input.user}; terminating pagination`);
                break;
            }
            cursor = nextCursor;
        }
        else if (hasMore === false || page.length < pageLimit) {
            break;
        }
        else {
            break;
        }
    }
    return rawTrades;
}
async function fetchGammaMarket(conditionId, fetchImpl) {
    const normTarget = conditionId.toLowerCase();
    // Try 1: Open / active markets via condition_id and condition_ids
    try {
        const response = await fetchImpl(`https://gamma-api.polymarket.com/markets?condition_id=${encodeURIComponent(conditionId)}&condition_ids=${encodeURIComponent(conditionId)}`);
        if (response.ok) {
            const payload = (await response.json());
            if (Array.isArray(payload)) {
                const match = payload.find((m) => typeof m === 'object' &&
                    m !== null &&
                    (m.conditionId?.toLowerCase() === normTarget || m.condition_id?.toLowerCase() === normTarget));
                if (match) {
                    return {
                        ...match,
                        negRisk: typeof match.negRisk === 'boolean'
                            ? match.negRisk
                            : Boolean(match.neg_risk)
                    };
                }
            }
        }
    }
    catch {
        // Fall through to closed markets
    }
    // Try 2: Closed / resolved historical markets via condition_id, condition_ids, & closed=true
    try {
        const response = await fetchImpl(`https://gamma-api.polymarket.com/markets?condition_id=${encodeURIComponent(conditionId)}&condition_ids=${encodeURIComponent(conditionId)}&closed=true`);
        if (response.ok) {
            const payload = (await response.json());
            if (Array.isArray(payload)) {
                const match = payload.find((m) => typeof m === 'object' &&
                    m !== null &&
                    (m.conditionId?.toLowerCase() === normTarget || m.condition_id?.toLowerCase() === normTarget));
                if (match) {
                    return {
                        ...match,
                        negRisk: typeof match.negRisk === 'boolean'
                            ? match.negRisk
                            : Boolean(match.neg_risk)
                    };
                }
            }
        }
    }
    catch {
        // Fall through to CLOB fallback
    }
    // Try 3: CLOB market endpoint directly as ultimate fallback
    try {
        const clobRes = await fetchImpl(`https://clob.polymarket.com/markets/${encodeURIComponent(conditionId)}`);
        if (clobRes.ok) {
            const clobData = (await clobRes.json());
            if (clobData && Array.isArray(clobData.tokens)) {
                return {
                    ...clobData,
                    conditionId: clobData.condition_id ?? conditionId,
                    outcomes: clobData.tokens.map((t) => t.outcome),
                    clobTokenIds: clobData.tokens.map((t) => t.token_id),
                    negRisk: clobData.neg_risk ?? false,
                    endDate: clobData.end_date_iso ?? clobData.end_date ?? new Date().toISOString(),
                    orderPriceMinTickSize: clobData.minimum_tick_size ?? 0.001
                };
            }
        }
    }
    catch {
        // Ignore
    }
    throw new Error(`Polymarket market context not found for ${conditionId}`);
}
async function fetchTickSize(asset, fetchImpl) {
    const response = await fetchImpl(`https://clob.polymarket.com/tick-size?token_id=${encodeURIComponent(asset)}`);
    if (!response.ok) {
        throw new Error(`Polymarket CLOB tick-size endpoint returned status ${response.status}`);
    }
    const payload = await response.json();
    return payload.minimum_tick_size ?? payload.minimumTickSize;
}
async function ensurePolymarketContext(trade, fetchImpl) {
    const cached = await getPolymarketOutcomeContext(trade.asset);
    if (cached) {
        if (cached.conditionId !== trade.conditionId
            || cached.outcome.toLowerCase() !== trade.outcome.toLowerCase()) {
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
function toSixDecimalUnits(value, field) {
    const units = Math.round(value * 1_000_000);
    if (!Number.isSafeInteger(units) || units < 0) {
        throw new Error(`Invalid ${field} amount for 6-decimal persistence`);
    }
    return String(units);
}
export async function backfillPolymarketWallet(address, dependencies = {}) {
    const cleanAddr = stripChainPrefix(address).trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(cleanAddr)) {
        throw new Error(`Invalid Polygon wallet for Polymarket backfill: ${address}`);
    }
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const publish = dependencies.publish
        ?? ((channel, message) => getRedis().publish(channel, message));
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
    let lastEventAt = null;
    let sourceTradeFailure = null;
    const rawTrades = await fetchConfirmedPolymarketTradePages({
        user: cleanAddr,
        fetchImpl
    });
    const proxyActivity = new Map();
    for (const rawTrade of rawTrades) {
        let trade;
        try {
            trade = parseConfirmedPolymarketTrade(rawTrade);
        }
        catch (error) {
            failed++;
            console.warn('[polymarket] rejected invalid confirmed trade:', error);
            continue;
        }
        if (!lastEventAt || trade.timestamp > lastEventAt)
            lastEventAt = trade.timestamp;
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
            }
            else if (persisted) {
                activity.inserted++;
            }
            if (!persisted) {
                skipped++;
                continue;
            }
            inserted++;
            await publish(REDIS_CHANNELS.walletSwap, JSON.stringify({
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
            }));
        }
        catch (error) {
            failed++;
            if (error instanceof SourceTradePersistenceError) {
                sourceTradeFailure ??= error;
            }
            console.warn(`[polymarket] failed to process confirmed trade ${trade.transactionHash}:`, error);
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
            await refreshWalletActivity(`polygon:${proxyWallet}`, activity.latestTimestamp, activity.inserted);
        }
    }
    catch (error) {
        throw new IngestionBatchError(`Failed to refresh Polymarket proxy wallet activity for ${cleanAddr}`, { ...result, failed: result.failed + 1 }, { cause: error });
    }
    if (sourceTradeFailure) {
        throw new IngestionBatchError(`Canonical Polymarket source-trade persistence failed for ${cleanAddr}`, result, { cause: sourceTradeFailure });
    }
    return result;
}
function parseOutcomePrices(value) {
    let parsed = value;
    if (typeof value === 'string')
        parsed = JSON.parse(value);
    if (!Array.isArray(parsed))
        return [];
    return parsed.map(Number).filter(Number.isFinite);
}
export async function pollPolymarketResolutions() {
    console.log('[polymarket] Polling for market resolutions...');
    const activeMarkets = await query(`SELECT condition_id FROM polymarket_markets WHERE status = 'active' AND context_complete = TRUE`);
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
                await query(`UPDATE polymarket_markets
              SET status = 'closed',
                  accepting_orders = FALSE,
                  resolution_status = $1,
                  winning_token_id = $2,
                  updated_at = NOW()
            WHERE condition_id = $3`, [market.resolutionStatus, winningTokenId, condition_id]);
                console.log(`[polymarket] Market ${condition_id} closed; winning token: ${winningTokenId}`);
            }
        }
        catch (error) {
            console.error(`[polymarket] failed to poll resolution for ${condition_id}`, error);
        }
    }
}
//# sourceMappingURL=polymarket.js.map