import { fetchTokenPriceUsd } from '@swat/shared';
import { query } from './client.js';
import { calculateAverageCostPnl } from './pnl-math.js';

export { calculateAverageCostPnl, markToMarketPnl } from './pnl-math.js';

type PositionTrade = {
  signal_id: string;
  token_mint: string;
  direction: 'buy' | 'sell';
  token_amount: number | string | null;
  amount_usd: number | string | null;
  price_usd: number | string | null;
  fee_usd: number | string | null;
};

/**
 * Recompute realized and unrealized average-cost P&L from ordered filled trades.
 * Token prices are fetched once per distinct mint and only for open positions.
 */
export async function markToMarketOpenPositions(
  signalId?: string
): Promise<{ updated: number; skipped: number }> {
  const trades = await query<PositionTrade>(`
    SELECT
      t.signal_id,
      t.token_mint,
      t.direction,
      t.token_amount,
      t.amount_usd,
      t.price_usd,
      t.fee_usd
    FROM trades t
    WHERE t.signal_id IS NOT NULL
      AND t.status IN ('filled', 'partial')
      AND t.direction IN ('buy', 'sell')
      AND (t.execution_mode IS NULL OR t.execution_mode != 'shadow')
      AND ($1::uuid IS NULL OR t.signal_id = $1)
    ORDER BY t.signal_id, t.executed_at, t.id
  `, [signalId ?? null]);

  const grouped = new Map<string, PositionTrade[]>();
  for (const trade of trades) {
    const group = grouped.get(trade.signal_id) ?? [];
    group.push(trade);
    grouped.set(trade.signal_id, group);
  }

  const priceCache = new Map<string, number | null>();
  let updated = 0;
  let skipped = 0;

  for (const [signalId, signalTrades] of grouped) {
    const tokenMint = signalTrades[0]?.token_mint;
    if (!tokenMint) {
      skipped++;
      continue;
    }
    if (signalTrades.some((trade) => trade.token_mint !== tokenMint)) {
      skipped++;
      continue;
    }

    const ledgerTrades = signalTrades.map((trade) => {
      const tokenAmount = Number(trade.token_amount);
      const explicitAmountUsd = trade.amount_usd == null ? null : Number(trade.amount_usd);
      const priceUsd = trade.price_usd == null ? null : Number(trade.price_usd);
      const feeUsd = trade.fee_usd == null ? 0 : Number(trade.fee_usd);
      const amountUsd = explicitAmountUsd ?? (
        priceUsd !== null && Number.isFinite(priceUsd) ? tokenAmount * priceUsd : Number.NaN
      );
      return { direction: trade.direction, tokenAmount, amountUsd, feeUsd };
    });

    let openQuantity = 0;
    let ledgerValid = true;
    for (const trade of ledgerTrades) {
      if (!Number.isFinite(trade.tokenAmount) || trade.tokenAmount <= 0) {
        ledgerValid = false;
        break;
      }
      openQuantity += trade.direction === 'buy' ? trade.tokenAmount : -trade.tokenAmount;
      if (openQuantity < -1e-12) {
        ledgerValid = false;
        break;
      }
    }
    if (!ledgerValid) {
      skipped++;
      continue;
    }

    let currentPrice: number | null = null;
    if (openQuantity > 1e-12) {
      const cached = priceCache.get(tokenMint);
      if (cached !== undefined) {
        currentPrice = cached;
      } else {
        currentPrice = await fetchTokenPriceUsd(tokenMint);
        priceCache.set(tokenMint, currentPrice);

        if (currentPrice !== null) {
          const sep = tokenMint.indexOf(':');
          const chain = sep >= 0 ? tokenMint.slice(0, sep) : 'solana';
          await query(`
            INSERT INTO price_snapshots (token_mint, chain, price_usd, snapshot_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (token_mint, chain, snapshot_at) DO NOTHING
          `, [tokenMint, chain, currentPrice]).catch((error) => {
            console.error('[db] failed to save price snapshot', error);
          });
        }
      }
    }

    const pnl = calculateAverageCostPnl(ledgerTrades, currentPrice);
    if (pnl === null) {
      skipped++;
      continue;
    }

    await query(
      `UPDATE signals
          SET pnl_usd = $1,
              realized_pnl_usd = $2,
              unrealized_pnl_usd = $3
        WHERE id = $4`,
      [pnl.totalPnlUsd, pnl.realizedPnlUsd, pnl.unrealizedPnlUsd, signalId]
    );
    updated++;
  }

  return { updated, skipped };
}
