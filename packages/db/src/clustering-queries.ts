import { query } from './client.js';

export async function generateFundingClusters() {
  // Create cluster rows with a valid confidence value (NOT NULL in schema)
  await query(`
    INSERT INTO wallet_clusters (name, cluster_type, confidence)
    SELECT 
      'Funding Group ' || wr.wallet_a,
      'funding',
      0.85
    FROM wallet_relationships wr
    WHERE wr.relationship_type = 'funding'
    GROUP BY wr.wallet_a
    ON CONFLICT (name) DO NOTHING
  `);

  // Add members — NOTE: correct table is cluster_memberships (not cluster_members)
  await query(`
    INSERT INTO cluster_memberships (cluster_id, wallet_address)
    SELECT c.id, wr.wallet_b
    FROM wallet_relationships wr
    JOIN wallet_clusters c ON c.name = 'Funding Group ' || wr.wallet_a
    WHERE wr.relationship_type = 'funding'
    ON CONFLICT (cluster_id, wallet_address) DO NOTHING
  `);

  // Update wallet_count on clusters
  await query(`
    UPDATE wallet_clusters SET
      wallet_count = (
        SELECT COUNT(*) FROM cluster_memberships cm
        WHERE cm.cluster_id = wallet_clusters.id
      ),
      updated_at = NOW()
    WHERE cluster_type = 'funding'
  `);
}

export async function generateBehavioralClusters() {
  // Step 1: Find wallet pairs with 3+ synchronized buys within 5 minutes
  await query(`
    WITH sync_buys AS (
      SELECT t1.wallet_address as w1, t2.wallet_address as w2, COUNT(*) as sync_count
      FROM transactions t1
      JOIN transactions t2 
        ON t1.target_token = t2.target_token
        AND t1.id != t2.id
        AND ABS(EXTRACT(EPOCH FROM (t1.timestamp - t2.timestamp))) < 300
      WHERE t1.direction = 'buy' AND t2.direction = 'buy'
        AND t1.wallet_address != t2.wallet_address
      GROUP BY t1.wallet_address, t2.wallet_address
      HAVING COUNT(*) > 3
    )
    INSERT INTO wallet_clusters (name, cluster_type, confidence)
    SELECT 
      'Behavioral Group ' || w1,
      'behavioral',
      LEAST(0.95, 0.50 + (sync_count::float * 0.05))
    FROM sync_buys
    ON CONFLICT (name) DO NOTHING
  `);

  // Step 2: Add both members of each synced pair to cluster_memberships
  await query(`
    WITH sync_buys AS (
      SELECT t1.wallet_address as w1, t2.wallet_address as w2
      FROM transactions t1
      JOIN transactions t2 
        ON t1.target_token = t2.target_token
        AND t1.id != t2.id
        AND ABS(EXTRACT(EPOCH FROM (t1.timestamp - t2.timestamp))) < 300
      WHERE t1.direction = 'buy' AND t2.direction = 'buy'
        AND t1.wallet_address != t2.wallet_address
      GROUP BY t1.wallet_address, t2.wallet_address
      HAVING COUNT(*) > 3
    )
    INSERT INTO cluster_memberships (cluster_id, wallet_address)
    SELECT c.id, sb.w2
    FROM sync_buys sb
    JOIN wallet_clusters c ON c.name = 'Behavioral Group ' || sb.w1
    ON CONFLICT (cluster_id, wallet_address) DO NOTHING
  `);

  // Step 3: Update wallet_count
  await query(`
    UPDATE wallet_clusters SET
      wallet_count = (
        SELECT COUNT(*) FROM cluster_memberships cm
        WHERE cm.cluster_id = wallet_clusters.id
      ),
      updated_at = NOW()
    WHERE cluster_type = 'behavioral'
  `);
}

export async function updateClusterPerformance(clusterId: string) {
  await query(`
    UPDATE wallet_clusters SET
      total_realized_roi = (
        SELECT AVG(w.realized_roi) FROM wallets w
        JOIN cluster_memberships cm ON w.address = cm.wallet_address
        WHERE cm.cluster_id = $1
      ),
      avg_composite_score = (
        SELECT AVG(w.composite_score) FROM wallets w
        JOIN cluster_memberships cm ON w.address = cm.wallet_address
        WHERE cm.cluster_id = $1
      ),
      last_active = NOW(),
      updated_at = NOW()
    WHERE id = $1
  `, [clusterId]);
}

export async function listClusters() {
  return query(`
    SELECT id, name, cluster_type, confidence, wallet_count, 
           total_realized_roi, avg_composite_score, status, 
           last_active, created_at
    FROM wallet_clusters
    WHERE status = 'active'
    ORDER BY confidence DESC, wallet_count DESC
  `);
}

export async function getClusterWithMembers(clusterId: string) {
  const [cluster] = await query<{ id: string; name: string; confidence: number }>(
    `SELECT * FROM wallet_clusters WHERE id = $1`, [clusterId]
  );
  if (!cluster) return null;

  const members = await query(
    `SELECT w.address, w.tier, w.composite_score, w.win_rate, w.realized_roi, cm.confidence, cm.joined_at
     FROM cluster_memberships cm
     JOIN wallets w ON w.address = cm.wallet_address
     WHERE cm.cluster_id = $1
     ORDER BY w.composite_score DESC NULLS LAST`,
    [clusterId]
  );

  return { cluster, members };
}
