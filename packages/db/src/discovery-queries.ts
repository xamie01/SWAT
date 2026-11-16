import { query } from './client.js';
import { withTransaction } from './transaction.js';
import type { PoolClient } from 'pg';
import { resolveChainAddress, type Chain } from '@swat/shared';

export type DiscoveredWalletBackfillInput = {
  address: string;
  source: 'discovered';
  discoveryMethod: 'funding' | 'counterparty';
};

export type DiscoveryBackfillIntent = { address: string; chain: Chain; intentId: string };

/** Caller owns BEGIN/COMMIT: never opens a second transaction/client. */
export async function persistDiscoveredWalletBackfillWithClient(
  client: PoolClient,
  input: DiscoveredWalletBackfillInput
): Promise<DiscoveryBackfillIntent> {
  const { prefixed: address, chain } = resolveChainAddress(input.address);
  // Admission is insert-only: discovery cannot overwrite manual/master metadata.
  // If the intent table is absent the caller transaction rolls this insert back.
  await client.query(
    `INSERT INTO wallets (address, chain, source, discovery_method)
     VALUES ($1, $2, 'discovered', $3) ON CONFLICT (address) DO NOTHING`,
    [address, chain, input.discoveryMethod]
  );
  const stored = await client.query<{ address: string; chain: Chain }>(
    'SELECT address, chain FROM wallets WHERE address = $1 FOR KEY SHARE', [address]
  );
  if (!stored.rows[0] || stored.rows[0].chain !== chain) throw new Error('discovery wallet chain mismatch');
  await client.query(
    `INSERT INTO discovery_backfill_intents (wallet_address, chain)
     VALUES ($1, $2) ON CONFLICT (wallet_address) DO NOTHING`, [address, chain]
  );
  const result = await client.query<{ id: string }>(
    'SELECT id FROM discovery_backfill_intents WHERE wallet_address = $1 AND chain = $2', [address, chain]
  );
  if (!result.rows[0]) throw new Error('durable discovery backfill intent unavailable');
  return { address, chain, intentId: result.rows[0].id };
}

export async function persistDiscoveredWalletBackfill(input: DiscoveredWalletBackfillInput): Promise<DiscoveryBackfillIntent> {
  return withTransaction(client => persistDiscoveredWalletBackfillWithClient(client, input));
}

/** Primary reads: pending survives process/queue failures and does not depend on rediscovery. */
export async function listPendingDiscoveryBackfills(limit = 100): Promise<DiscoveryBackfillIntent[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('discovery recovery limit must be in 1..1000');
  const rows = await query<{ id: string; wallet_address: string; chain: Chain }>(
    `SELECT id, wallet_address, chain FROM discovery_backfill_intents
     WHERE state = 'pending' ORDER BY created_at, id LIMIT $1`, [limit]
  );
  return rows.map(row => ({ intentId: row.id, address: row.wallet_address, chain: row.chain }));
}

/** This acknowledges queue acceptance, NOT successful historical indexing. */
export async function acknowledgeDiscoveryBackfill(intentId: string): Promise<void> {
  await query(
    `UPDATE discovery_backfill_intents SET state = 'enqueued', enqueued_at = NOW()
     WHERE id = $1 AND state = 'pending'`, [intentId]
  );
}


export async function logDiscoveryRun(source: string, seedValue: string, walletsDiscovered: number) {
  await query(
    `INSERT INTO discovery_log (source, seed_value, wallets_discovered) VALUES ($1, $2, $3)`,
    [source, seedValue, walletsDiscovered]
  );
}

export async function findEarlyBuyers(tokenMint: string, minInvestedLamports = 500_000_000): Promise<string[]> {
  const rows = await query<{ wallet_address: string }>(`
    SELECT wallet_address
    FROM transactions
    WHERE target_token = $1
      AND direction = 'buy'
      AND timestamp < (
        SELECT MIN(timestamp) + INTERVAL '10 minutes'
        FROM transactions WHERE target_token = $1
      )
    GROUP BY wallet_address
    HAVING SUM(amount_in::bigint) > $2
    ORDER BY MIN(timestamp) ASC
    LIMIT 50
  `, [tokenMint, minInvestedLamports]);
  
  return rows.map(r => r.wallet_address);
}

export async function findFundedUnknownWallets(): Promise<string[]> {
  const rows = await query<{ wallet_b: string }>(`
    SELECT DISTINCT wr.wallet_b
    FROM wallet_relationships wr
    WHERE wr.relationship_type = 'funding'
      AND wr.wallet_a IN (
        SELECT address FROM wallets WHERE tier IN ('elite', 'pro')
      )
      AND wr.wallet_b NOT IN (SELECT address FROM wallets)
    LIMIT 100
  `);
  
  return rows.map(r => r.wallet_b);
}

export async function findFrequentCounterparties(): Promise<string[]> {
  const rows = await query<{ wallet_address: string }>(`
    SELECT t2.wallet_address
    FROM transactions t1
    JOIN transactions t2
      ON t1.target_token = t2.target_token
      AND ABS(EXTRACT(EPOCH FROM (t1.timestamp - t2.timestamp))) < 300
      -- A wallet must not match itself (t1.id != t2.id) and the two sides must
      -- be different wallets; without these guards a wallet's own two buys
      -- match and counts are double-inflated.
      AND t1.id <> t2.id
      AND t1.wallet_address <> t2.wallet_address
    JOIN wallets w ON t1.wallet_address = w.address
    WHERE w.tier IN ('elite', 'pro')
      AND t1.direction = 'buy'
      AND t2.direction = 'buy'
      AND t2.wallet_address NOT IN (SELECT address FROM wallets)
    GROUP BY t2.wallet_address
    HAVING COUNT(DISTINCT t2.id) >= 5
    ORDER BY COUNT(DISTINCT t2.id) DESC
    LIMIT 50
  `);
  
  return rows.map(r => r.wallet_address);
}
