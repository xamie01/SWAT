import { query } from './client.js';
export async function logDiscoveryRun(source, seedValue, walletsDiscovered) {
    await query(`INSERT INTO discovery_log (source, seed_value, wallets_discovered) VALUES ($1, $2, $3)`, [source, seedValue, walletsDiscovered]);
}
export async function findEarlyBuyers(tokenMint, minInvestedLamports = 500_000_000) {
    const rows = await query(`
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
export async function findFundedUnknownWallets() {
    const rows = await query(`
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
export async function findFrequentCounterparties() {
    const rows = await query(`
    SELECT t2.wallet_address
    FROM transactions t1
    JOIN transactions t2
      ON t1.target_token = t2.target_token
      AND ABS(EXTRACT(EPOCH FROM (t1.timestamp - t2.timestamp))) < 300
    JOIN wallets w ON t1.wallet_address = w.address
    WHERE w.tier IN ('elite', 'pro')
      AND t1.direction = 'buy'
      AND t2.direction = 'buy'
      AND t2.wallet_address NOT IN (SELECT address FROM wallets)
    GROUP BY t2.wallet_address
    HAVING COUNT(*) >= 5
    ORDER BY COUNT(*) DESC
    LIMIT 50
  `);
    return rows.map(r => r.wallet_address);
}
//# sourceMappingURL=discovery-queries.js.map