import { query } from './client.js';
import { withTransaction } from './transaction.js';
import { getChainPrefix, prefixChainValue, stripChainPrefix } from '@swat/shared';
function normalizeConditionId(conditionId) {
    const prefix = getChainPrefix(conditionId);
    if (prefix && prefix !== 'polygon') {
        throw new Error(`Polymarket condition ID cannot use the ${prefix} prefix`);
    }
    const normalized = stripChainPrefix(conditionId).trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
        throw new Error(`Invalid Polymarket condition ID: ${conditionId}`);
    }
    return normalized;
}
function normalizeTokenId(tokenId) {
    const raw = stripChainPrefix(tokenId).trim();
    if (!/^\d+$/.test(raw)) {
        throw new Error(`Invalid Polymarket outcome token ID: ${tokenId}`);
    }
    return prefixChainValue(raw, 'polygon');
}
function normalizeProxyWallet(address) {
    const raw = stripChainPrefix(address).trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(raw)) {
        throw new Error(`Invalid Polymarket proxy wallet: ${address}`);
    }
    return prefixChainValue(raw, 'polygon');
}
function normalizeTransactionHash(hash) {
    const normalized = hash.trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
        throw new Error(`Invalid Polymarket transaction hash: ${hash}`);
    }
    return normalized;
}
export async function getPolymarketMarket(conditionId) {
    const normalizedConditionId = normalizeConditionId(conditionId);
    const rows = await query(`SELECT condition_id, question, slug, end_date, resolution_source, outcome_count,
            clob_token_ids, status, tick_size, neg_risk, accepting_orders,
            resolution_status, context_complete, created_at, updated_at
     FROM polymarket_markets
     WHERE condition_id = $1`, [normalizedConditionId]);
    return rows[0] ?? null;
}
export async function upsertPolymarketContext(context) {
    const conditionId = normalizeConditionId(context.conditionId);
    if (context.outcomes.length !== context.outcomeCount || context.outcomes.length === 0) {
        throw new Error(`Polymarket outcome count mismatch for ${conditionId}`);
    }
    const tickSize = Number(context.tickSize);
    if (!Number.isFinite(tickSize) || tickSize <= 0 || tickSize > 1) {
        throw new Error(`Invalid Polymarket tick size for ${conditionId}`);
    }
    if (Number.isNaN(context.endDate.getTime())) {
        throw new Error(`Invalid Polymarket end date for ${conditionId}`);
    }
    await withTransaction(async (client) => {
        const tokenIds = context.outcomes.map((outcome) => normalizeTokenId(outcome.tokenId));
        await client.query(`INSERT INTO polymarket_markets (
         condition_id, question, slug, end_date, resolution_source, outcome_count,
         clob_token_ids, status, tick_size, neg_risk, accepting_orders,
         resolution_status, context_complete
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE)
       ON CONFLICT (condition_id) DO UPDATE SET
         question = EXCLUDED.question,
         slug = EXCLUDED.slug,
         end_date = EXCLUDED.end_date,
         resolution_source = EXCLUDED.resolution_source,
         outcome_count = EXCLUDED.outcome_count,
         clob_token_ids = EXCLUDED.clob_token_ids,
         status = EXCLUDED.status,
         tick_size = EXCLUDED.tick_size,
         neg_risk = EXCLUDED.neg_risk,
         accepting_orders = EXCLUDED.accepting_orders,
         resolution_status = EXCLUDED.resolution_status,
         context_complete = TRUE,
         updated_at = NOW()`, [
            conditionId,
            context.question,
            context.slug ?? null,
            context.endDate,
            context.resolutionSource ?? null,
            context.outcomeCount,
            JSON.stringify(tokenIds),
            context.status ?? 'active',
            tickSize,
            context.negRisk,
            context.acceptingOrders,
            context.resolutionStatus
        ]);
        for (let index = 0; index < context.outcomes.length; index++) {
            const outcome = context.outcomes[index];
            const tokenId = tokenIds[index];
            if (!outcome || !tokenId || outcome.outcomeIndex !== index || !outcome.outcome.trim()) {
                throw new Error(`Invalid Polymarket outcome mapping for ${conditionId} at index ${index}`);
            }
            await client.query(`INSERT INTO tokens (mint, chain, decimals, symbol, name, polymarket_condition_id)
         VALUES ($1, 'polygon', 6, $2, $3, $4)
         ON CONFLICT (mint) DO UPDATE SET
           chain = 'polygon',
           decimals = 6,
           symbol = EXCLUDED.symbol,
           name = EXCLUDED.name,
           polymarket_condition_id = EXCLUDED.polymarket_condition_id`, [
                tokenId,
                outcome.outcome.trim().toUpperCase().slice(0, 20),
                `${context.question} (${outcome.outcome.trim()})`,
                conditionId
            ]);
            await client.query(`INSERT INTO polymarket_outcomes (token_id, condition_id, outcome, outcome_index)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (token_id) DO UPDATE SET
           condition_id = EXCLUDED.condition_id,
           outcome = EXCLUDED.outcome,
           outcome_index = EXCLUDED.outcome_index,
           updated_at = NOW()`, [tokenId, conditionId, outcome.outcome.trim(), outcome.outcomeIndex]);
        }
    });
}
export async function getPolymarketOutcomeContext(tokenId) {
    const normalizedTokenId = normalizeTokenId(tokenId);
    const rows = await query(`SELECT o.token_id, o.condition_id, o.outcome, o.outcome_index,
            m.question, m.slug, m.end_date, m.status AS market_status,
            m.tick_size, m.neg_risk, m.accepting_orders,
            m.resolution_status, m.context_complete
       FROM polymarket_outcomes o
       JOIN polymarket_markets m ON m.condition_id = o.condition_id
      WHERE o.token_id = $1
        AND m.context_complete = TRUE`, [normalizedTokenId]);
    const row = rows[0];
    if (!row)
        return null;
    return {
        tokenId: row.token_id,
        conditionId: row.condition_id,
        outcome: row.outcome,
        outcomeIndex: row.outcome_index,
        question: row.question,
        slug: row.slug,
        endDate: row.end_date,
        marketStatus: row.market_status,
        tickSize: row.tick_size,
        negRisk: row.neg_risk,
        acceptingOrders: row.accepting_orders,
        resolutionStatus: row.resolution_status,
        contextComplete: row.context_complete
    };
}
export async function recordConfirmedPolymarketTrade(trade) {
    const rows = await query(`INSERT INTO polymarket_trades (
       transaction_hash, proxy_wallet, asset, condition_id, side, size, price,
       trade_timestamp
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (
       transaction_hash, proxy_wallet, asset, side, size, price, trade_timestamp
     ) DO NOTHING
     RETURNING id`, [
        normalizeTransactionHash(trade.transactionHash),
        normalizeProxyWallet(trade.proxyWallet),
        normalizeTokenId(trade.asset),
        normalizeConditionId(trade.conditionId),
        trade.side,
        String(trade.size),
        String(trade.price),
        trade.timestamp
    ]);
    return rows.length > 0;
}
//# sourceMappingURL=polymarket.js.map