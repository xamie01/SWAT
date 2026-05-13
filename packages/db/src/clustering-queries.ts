import { query } from './client.js';

export async function generateFundingClusters() {
  await query(`
    INSERT INTO wallet_clusters (name, cluster_type)
    SELECT 'Funding Group ' || wr.wallet_a, 'funding'
    FROM wallet_relationships wr
    WHERE wr.relationship_type = 'funding'
    GROUP BY wr.wallet_a
    ON CONFLICT (name) DO NOTHING
  `);

  await query(`
    INSERT INTO cluster_members (cluster_id, wallet_address)
    SELECT c.id, wr.wallet_b
    FROM wallet_relationships wr
    JOIN wallet_clusters c ON c.name = 'Funding Group ' || wr.wallet_a
    WHERE wr.relationship_type = 'funding'
    ON CONFLICT (cluster_id, wallet_address) DO NOTHING
  `);
}

export async function generateBehavioralClusters() {
  await query(`
    WITH sync_buys AS (
      SELECT t1.wallet_address as w1, t2.wallet_address as w2, COUNT(*) as sync_count
      FROM transactions t1
      JOIN transactions t2 
        ON t1.target_token = t2.target_token
        AND t1.id != t2.id
        AND ABS(EXTRACT(EPOCH FROM (t1.timestamp - t2.timestamp))) < 300
      WHERE t1.direction = 'buy' AND t2.direction = 'buy'
      GROUP BY t1.wallet_address, t2.wallet_address
      HAVING COUNT(*) > 3
    )
    INSERT INTO wallet_clusters (name, cluster_type)
    SELECT 'Behavioral Group ' || w1, 'behavioral'
    FROM sync_buys
    ON CONFLICT (name) DO NOTHING
  `);
  
  await query(`
    WITH sync_buys AS (
      SELECT t1.wallet_address as w1, t2.wallet_address as w2
      FROM transactions t1
      JOIN transactions t2 
        ON t1.target_token = t2.target_token
        AND t1.id != t2.id
        AND ABS(EXTRACT(EPOCH FROM (t1.timestamp - t2.timestamp))) < 300
      WHERE t1.direction = 'buy' AND t2.direction = 'buy'
      GROUP BY t1.wallet_address, t2.wallet_address
      HAVING COUNT(*) > 3
    )
    INSERT INTO cluster_members (cluster_id, wallet_address)
    SELECT c.id, sb.w2
    FROM sync_buys sb
    JOIN wallet_clusters c ON c.name = 'Behavioral Group ' || sb.w1
    ON CONFLICT (cluster_id, wallet_address) DO NOTHING
  `);
}
