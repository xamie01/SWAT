import { query } from './client.js';

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
