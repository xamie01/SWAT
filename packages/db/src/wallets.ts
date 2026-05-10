import { query } from './client.js';

type WalletInsert = {
  address: string;
  source: 'shiller' | 'manual' | 'discovered';
  nickname?: string;
};

export async function listWallets() {
  return query(
    `SELECT address, nickname, source, status, total_trades, win_rate, realized_roi, unrealized_roi, composite_score, tier, created_at, updated_at
     FROM wallets
     ORDER BY composite_score DESC NULLS LAST, created_at DESC`
  );
}

export async function getWallet(address: string) {
  const rows = await query(
    `SELECT address, nickname, source, status, total_trades, win_rate, realized_roi, unrealized_roi, composite_score, tier, created_at, updated_at
     FROM wallets
     WHERE address = $1`,
    [address]
  );
  return rows[0] ?? null;
}

export async function upsertWallet(wallet: WalletInsert) {
  const rows = await query(
    `INSERT INTO wallets (address, source, nickname)
     VALUES ($1, $2, $3)
     ON CONFLICT (address) DO UPDATE SET
       nickname = COALESCE(EXCLUDED.nickname, wallets.nickname),
       source = EXCLUDED.source,
       updated_at = NOW()
     RETURNING *`,
    [wallet.address, wallet.source, wallet.nickname ?? null]
  );
  return rows[0];
}

export async function deleteWallet(address: string) {
  await query('DELETE FROM wallets WHERE address = $1', [address]);
}
