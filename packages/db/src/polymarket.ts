import { pool, query } from './client.js';
import { getChainPrefix, prefixChainValue, stripChainPrefix } from '@swat/shared';

function normalizeConditionId(conditionId: string): string {
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

function normalizeTokenId(tokenId: string): string {
  const raw = stripChainPrefix(tokenId).trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid Polymarket outcome token ID: ${tokenId}`);
  }
  return prefixChainValue(raw, 'polygon');
}

function normalizeProxyWallet(address: string): string {
  const raw = stripChainPrefix(address).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(raw)) {
    throw new Error(`Invalid Polymarket proxy wallet: ${address}`);
  }
  return prefixChainValue(raw, 'polygon');
}

function normalizeTransactionHash(hash: string): string {
  const normalized = hash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Invalid Polymarket transaction hash: ${hash}`);
  }
  return normalized;
}

export type PolymarketMarketInsert = {
  conditionId: string;
  question: string;
  slug?: string | null;
  endDate?: Date | null;
  resolutionSource?: string | null;
  outcomeCount: number;
  clobTokenIds?: any;
  status?: string;
  tickSize?: string | number | null;
  negRisk?: boolean | null;
  acceptingOrders?: boolean | null;
  resolutionStatus?: string | null;
  contextComplete?: boolean;
};

export type PolymarketOutcomeInsert = {
  tokenId: string;
  outcome: string;
  outcomeIndex: number;
};

export type PolymarketContextInsert = PolymarketMarketInsert & {
  endDate: Date;
  tickSize: string | number;
  negRisk: boolean;
  acceptingOrders: boolean;
  resolutionStatus: string;
  outcomes: PolymarketOutcomeInsert[];
};

export type PolymarketOutcomeContext = {
  tokenId: string;
  conditionId: string;
  outcome: string;
  outcomeIndex: number;
  question: string;
  slug: string | null;
  endDate: Date;
  marketStatus: string;
  tickSize: string | number;
  negRisk: boolean;
  acceptingOrders: boolean;
  resolutionStatus: string;
  contextComplete: boolean;
};

export type ConfirmedPolymarketTradeInsert = {
  transactionHash: string;
  proxyWallet: string;
  asset: string;
  conditionId: string;
  side: 'BUY' | 'SELL';
  size: string | number;
  price: string | number;
  timestamp: Date;
};

export async function getPolymarketMarket(conditionId: string) {
  const normalizedConditionId = normalizeConditionId(conditionId);
  const rows = await query<{
    condition_id: string;
    question: string;
    slug: string | null;
    end_date: Date | null;
    resolution_source: string | null;
    outcome_count: number;
    clob_token_ids: any;
    status: string;
    tick_size: string | null;
    neg_risk: boolean | null;
    accepting_orders: boolean | null;
    resolution_status: string | null;
    context_complete: boolean;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT condition_id, question, slug, end_date, resolution_source, outcome_count,
            clob_token_ids, status, tick_size, neg_risk, accepting_orders,
            resolution_status, context_complete, created_at, updated_at
     FROM polymarket_markets
     WHERE condition_id = $1`,
    [normalizedConditionId]
  );
  return rows[0] ?? null;
}

export async function upsertPolymarketContext(context: PolymarketContextInsert): Promise<void> {
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tokenIds = context.outcomes.map((outcome) => normalizeTokenId(outcome.tokenId));
    await client.query(
      `INSERT INTO polymarket_markets (
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
         updated_at = NOW()`,
      [
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
      ]
    );

    for (let index = 0; index < context.outcomes.length; index++) {
      const outcome = context.outcomes[index];
      const tokenId = tokenIds[index];
      if (!outcome || !tokenId || outcome.outcomeIndex !== index || !outcome.outcome.trim()) {
        throw new Error(`Invalid Polymarket outcome mapping for ${conditionId} at index ${index}`);
      }
      await client.query(
        `INSERT INTO tokens (mint, chain, decimals, symbol, name, polymarket_condition_id)
         VALUES ($1, 'polygon', 6, $2, $3, $4)
         ON CONFLICT (mint) DO UPDATE SET
           chain = 'polygon',
           decimals = 6,
           symbol = EXCLUDED.symbol,
           name = EXCLUDED.name,
           polymarket_condition_id = EXCLUDED.polymarket_condition_id`,
        [
          tokenId,
          outcome.outcome.trim().toUpperCase().slice(0, 20),
          `${context.question} (${outcome.outcome.trim()})`,
          conditionId
        ]
      );
      await client.query(
        `INSERT INTO polymarket_outcomes (token_id, condition_id, outcome, outcome_index)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (token_id) DO UPDATE SET
           condition_id = EXCLUDED.condition_id,
           outcome = EXCLUDED.outcome,
           outcome_index = EXCLUDED.outcome_index,
           updated_at = NOW()`,
        [tokenId, conditionId, outcome.outcome.trim(), outcome.outcomeIndex]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getPolymarketOutcomeContext(tokenId: string): Promise<PolymarketOutcomeContext | null> {
  const normalizedTokenId = normalizeTokenId(tokenId);
  const rows = await query<{
    token_id: string;
    condition_id: string;
    outcome: string;
    outcome_index: number;
    question: string;
    slug: string | null;
    end_date: Date;
    market_status: string;
    tick_size: string | number;
    neg_risk: boolean;
    accepting_orders: boolean;
    resolution_status: string;
    context_complete: boolean;
  }>(
    `SELECT o.token_id, o.condition_id, o.outcome, o.outcome_index,
            m.question, m.slug, m.end_date, m.status AS market_status,
            m.tick_size, m.neg_risk, m.accepting_orders,
            m.resolution_status, m.context_complete
       FROM polymarket_outcomes o
       JOIN polymarket_markets m ON m.condition_id = o.condition_id
      WHERE o.token_id = $1
        AND m.context_complete = TRUE`,
    [normalizedTokenId]
  );
  const row = rows[0];
  if (!row) return null;
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

export async function recordConfirmedPolymarketTrade(
  trade: ConfirmedPolymarketTradeInsert
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `INSERT INTO polymarket_trades (
       transaction_hash, proxy_wallet, asset, condition_id, side, size, price,
       trade_timestamp
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (
       transaction_hash, proxy_wallet, asset, side, size, price, trade_timestamp
     ) DO NOTHING
     RETURNING id`,
    [
      normalizeTransactionHash(trade.transactionHash),
      normalizeProxyWallet(trade.proxyWallet),
      normalizeTokenId(trade.asset),
      normalizeConditionId(trade.conditionId),
      trade.side,
      String(trade.size),
      String(trade.price),
      trade.timestamp
    ]
  );
  return rows.length > 0;
}
