import { query } from './client.js';

export type PolymarketMarketInsert = {
  conditionId: string;
  question: string;
  slug?: string | null;
  endDate?: Date | null;
  resolutionSource?: string | null;
  outcomeCount: number;
  clobTokenIds?: any;
  status?: string;
};

export async function getPolymarketMarket(conditionId: string) {
  const rows = await query<{
    condition_id: string;
    question: string;
    slug: string | null;
    end_date: Date | null;
    resolution_source: string | null;
    outcome_count: number;
    clob_token_ids: any;
    status: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT condition_id, question, slug, end_date, resolution_source, outcome_count, clob_token_ids, status, created_at, updated_at
     FROM polymarket_markets
     WHERE condition_id = $1`,
    [conditionId]
  );
  return rows[0] ?? null;
}

export async function upsertPolymarketMarket(market: PolymarketMarketInsert) {
  await query(
    `INSERT INTO polymarket_markets (condition_id, question, slug, end_date, resolution_source, outcome_count, clob_token_ids, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (condition_id) DO UPDATE SET
       question = EXCLUDED.question,
       slug = EXCLUDED.slug,
       end_date = EXCLUDED.end_date,
       status = EXCLUDED.status,
       updated_at = NOW()`,
    [
      market.conditionId,
      market.question,
      market.slug ?? null,
      market.endDate ?? null,
      market.resolutionSource ?? null,
      market.outcomeCount,
      market.clobTokenIds ? JSON.stringify(market.clobTokenIds) : null,
      market.status ?? 'active'
    ]
  );
}

export async function insertPolymarketMarketSkeleton(conditionId: string, question: string) {
  await query(
    `INSERT INTO polymarket_markets (condition_id, question, outcome_count)
     VALUES ($1, $2, 2)
     ON CONFLICT (condition_id) DO NOTHING`,
    [conditionId, question]
  );
}

export async function linkTokenToPolymarketMarket(conditionId: string, tokenMint: string) {
  await query(
    `UPDATE tokens 
     SET polymarket_condition_id = $1 
     WHERE mint = $2`,
    [
      conditionId.startsWith('polygon:') ? conditionId : `polygon:${conditionId}`,
      tokenMint.startsWith('polygon:') ? tokenMint : `polygon:${tokenMint}`
    ]
  );
}

export async function getTokensByPolymarketCondition(conditionId: string) {
  const prefixedConditionId = conditionId.startsWith('polygon:') ? conditionId : `polygon:${conditionId}`;
  return query<{ mint: string; symbol: string }>(
    `SELECT mint, symbol FROM tokens WHERE polymarket_condition_id = $1`,
    [prefixedConditionId]
  );
}
