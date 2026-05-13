import { query } from './client.js';
import type { WalletScoreInput, WalletTier } from '@swat/shared';

export async function getWalletMetrics(address: string): Promise<WalletScoreInput> {
  const rows = await query(`
    WITH closed_positions AS (
      SELECT
        target_token,
        SUM(CASE WHEN direction = 'buy' THEN amount_in_usd ELSE 0 END) as cost_basis,
        SUM(CASE WHEN direction = 'sell' THEN amount_out_usd ELSE 0 END) as realized_value
      FROM transactions
      WHERE wallet_address = $1
        AND amount_in_usd IS NOT NULL
        AND amount_out_usd IS NOT NULL
      GROUP BY target_token
      HAVING SUM(CASE WHEN direction = 'buy' THEN amount_in ELSE 0 END) <= 
             SUM(CASE WHEN direction = 'sell' THEN amount_out ELSE 0 END)
    )
    SELECT 
      (SELECT COUNT(*) FROM closed_positions WHERE realized_value > cost_basis)::float / NULLIF((SELECT COUNT(*) FROM closed_positions), 0) as win_rate,
      (SELECT SUM(realized_value - cost_basis) / NULLIF(SUM(cost_basis), 0) FROM closed_positions) as realized_roi,
      0.5 as early_entry_score,
      0.5 as consistency_score
  `, [address]);

  const row = rows[0] as any;
  return {
    winRate: row?.win_rate ?? 0,
    realizedRoi: row?.realized_roi ?? 0,
    earlyEntryScore: row?.early_entry_score ?? 0,
    consistencyScore: row?.consistency_score ?? 0,
  };
}

export async function updateWalletScore(address: string, score: number, tier: WalletTier, metrics: WalletScoreInput) {
  await query(`
    UPDATE wallets SET
      composite_score = $1,
      tier = $2,
      win_rate = $3,
      realized_roi = $4,
      early_entry_score = $5,
      consistency_score = $6,
      updated_at = NOW()
    WHERE address = $7
  `, [score, tier, metrics.winRate, metrics.realizedRoi, metrics.earlyEntryScore, metrics.consistencyScore, address]);
}

export async function pauseUnderperformingWallets() {
  await query(`
    UPDATE wallets SET status = 'paused'
    WHERE status = 'active' AND (
      (total_trades >= 50 AND composite_score < 40) OR
      (last_active < NOW() - INTERVAL '30 days')
    )
  `);
}

export async function getActiveWallets() {
  return query<{address: string}>(`SELECT address FROM wallets WHERE status = 'active'`);
}
