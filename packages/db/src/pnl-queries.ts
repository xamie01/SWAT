import { fetchTokenPriceUsd } from '@swat/shared';
import { query } from './client.js';
import { markToMarketPnl } from './pnl-math.js';

export { markToMarketPnl } from './pnl-math.js';

type OpenPosition = {
  signal_id: string;
  token_mint: string;
  cost_basis_usd: number | null;
  entry_price_usd: number | null;
};

/**
 * Recompute unrealised P&L for every signal that has at least one buy trade
 * but is not yet closed, writing the result to signals.pnl_usd.
 *
 * This powers /v1/trading/performance. It is a mark-to-market estimate, not a
 * realised-P&L engine (the executor has no sell path yet).
 *
 * Token prices are fetched once per distinct mint to limit API calls.
 */
export async function markToMarketOpenPositions(): Promise<{ updated: number; skipped: number }> {
  const positions = await query<OpenPosition>(`
    SELECT
      t.signal_id,
      t.token_mint,
      -- Cost basis / entry price only from rows that actually have both USD and
      -- token amount, so a row missing token_amount can't skew the weighted
      -- average. Fall back to AVG(price_usd) when no priced rows exist.
      SUM(t.amount_usd) FILTER (WHERE t.amount_usd IS NOT NULL AND t.token_amount > 0) AS cost_basis_usd,
      CASE
        WHEN SUM(t.token_amount) FILTER (WHERE t.amount_usd IS NOT NULL AND t.token_amount > 0) > 0
          THEN SUM(t.amount_usd)     FILTER (WHERE t.amount_usd IS NOT NULL AND t.token_amount > 0)
             / SUM(t.token_amount)   FILTER (WHERE t.amount_usd IS NOT NULL AND t.token_amount > 0)
        ELSE AVG(t.price_usd)
      END                                                 AS entry_price_usd
    FROM trades t
    WHERE t.signal_id IS NOT NULL
      AND t.direction = 'buy'
      AND t.status = 'filled'
      -- Exclude positions that have already been closed by a sell.
      AND NOT EXISTS (
        SELECT 1 FROM trades s
        WHERE s.signal_id = t.signal_id
          AND s.token_mint = t.token_mint
          AND s.direction = 'sell'
      )
    GROUP BY t.signal_id, t.token_mint
  `);

  const priceCache = new Map<string, number | null>();
  let updated = 0;
  let skipped = 0;

  for (const pos of positions) {
    let currentPrice = priceCache.get(pos.token_mint);
    if (currentPrice === undefined) {
      currentPrice = await fetchTokenPriceUsd(pos.token_mint);
      priceCache.set(pos.token_mint, currentPrice);
    }

    const pnl = markToMarketPnl(
      pos.cost_basis_usd != null ? Number(pos.cost_basis_usd) : null,
      pos.entry_price_usd != null ? Number(pos.entry_price_usd) : null,
      currentPrice
    );

    if (pnl === null) {
      skipped++;
      continue;
    }

    await query(`UPDATE signals SET pnl_usd = $1 WHERE id = $2`, [pnl, pos.signal_id]);
    updated++;
  }

  return { updated, skipped };
}
