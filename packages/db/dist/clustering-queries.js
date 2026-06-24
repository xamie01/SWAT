import { query } from './client.js';
export async function generateFundingClusters() {
    // Create a cluster per funder that funded >= 2 distinct wallets (a hub — the
    // Sybil/coordination signal). A lone A→B funding pair is too weak to be a
    // "group" and previously produced a constant-0.85 cluster from a single dust
    // transfer. Confidence is now derived from the actual edge confidences
    // (which scale with transfer size) plus a small bonus per extra funded wallet.
    await query(`
    INSERT INTO wallet_clusters (name, cluster_type, confidence)
    SELECT
      'Funding Group ' || wr.wallet_a,
      'funding',
      LEAST(0.95, AVG(wr.confidence) + 0.05 * (COUNT(DISTINCT wr.wallet_b) - 1))
    FROM wallet_relationships wr
    WHERE wr.relationship_type = 'funding'
    GROUP BY wr.wallet_a
    HAVING COUNT(DISTINCT wr.wallet_b) >= 2
    -- Refresh confidence on re-run so it tracks current evidence instead of
    -- being frozen at first-creation (DO NOTHING).
    ON CONFLICT (name) DO UPDATE SET confidence = EXCLUDED.confidence, updated_at = NOW()
  `);
    // Add members — NOTE: correct table is cluster_memberships (not cluster_members).
    // Insert BOTH sides of each funding edge: the funder (wallet_a, after whom the
    // cluster is named) and the funded wallet (wallet_b). Previously only wallet_b
    // was inserted, so the funder was missing from its own cluster and
    // wallet_count was undercounted.
    await query(`
    INSERT INTO cluster_memberships (cluster_id, wallet_address)
    SELECT c.id, edge.wallet_address
    FROM wallet_relationships wr
    JOIN wallet_clusters c ON c.name = 'Funding Group ' || wr.wallet_a
    CROSS JOIN LATERAL (VALUES (wr.wallet_a), (wr.wallet_b)) AS edge(wallet_address)
    WHERE wr.relationship_type = 'funding'
      AND edge.wallet_address IN (SELECT address FROM wallets)
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
    // A synchronized pair = two DISTINCT wallets that bought the same token within
    // 5 minutes of each other, on >3 distinct occasions.
    //
    // The join is constrained to `w_low < w_high` so each unordered pair is
    // produced exactly once. Without that guard the previous version counted every
    // pair twice (A,B and B,A), inflating sync_count ~2x AND creating a duplicate
    // cluster per direction. We also count DISTINCT synchronized buys
    // (COUNT(DISTINCT t1.id)) rather than ordered transaction-pair combinations,
    // so the >3 threshold and the confidence formula reflect real buy events.
    //
    // Clusters are anchored on the lexicographically-smaller wallet of each pair.
    // (A fully transitive connected-components grouping is a future improvement;
    // this already removes the direction-duplication and double-counting.)
    const syncPairsCte = `
    WITH sync_pairs AS (
      SELECT
        t1.wallet_address AS w_low,
        t2.wallet_address AS w_high,
        COUNT(DISTINCT t1.id) AS sync_count
      FROM transactions t1
      JOIN transactions t2
        ON t1.target_token = t2.target_token
        AND t1.wallet_address < t2.wallet_address
        AND ABS(EXTRACT(EPOCH FROM (t1.timestamp - t2.timestamp))) < 300
      WHERE t1.direction = 'buy' AND t2.direction = 'buy'
        AND t1.target_token IS NOT NULL
      GROUP BY t1.wallet_address, t2.wallet_address
      HAVING COUNT(DISTINCT t1.id) > 3
    )`;
    // Step 1: create one cluster per anchor wallet (w_low).
    await query(`
    ${syncPairsCte}
    INSERT INTO wallet_clusters (name, cluster_type, confidence)
    SELECT
      'Behavioral Group ' || w_low,
      'behavioral',
      LEAST(0.95, 0.50 + (MAX(sync_count)::float * 0.05))
    FROM sync_pairs
    GROUP BY w_low
    ON CONFLICT (name) DO UPDATE SET confidence = EXCLUDED.confidence, updated_at = NOW()
  `);
    // Step 2: add BOTH wallets of each pair to the cluster (previously only w_high
    // was inserted, so the anchor was missing from its own cluster).
    await query(`
    ${syncPairsCte}
    INSERT INTO cluster_memberships (cluster_id, wallet_address)
    SELECT c.id, edge.wallet_address
    FROM sync_pairs sp
    JOIN wallet_clusters c ON c.name = 'Behavioral Group ' || sp.w_low
    CROSS JOIN LATERAL (VALUES (sp.w_low), (sp.w_high)) AS edge(wallet_address)
    WHERE edge.wallet_address IN (SELECT address FROM wallets)
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
export async function updateClusterPerformance(clusterId) {
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
    ORDER BY confidence DESC, wallet_count DESC, id DESC
  `);
}
export async function getClusterWithMembers(clusterId) {
    const [cluster] = await query(`SELECT * FROM wallet_clusters WHERE id = $1`, [clusterId]);
    if (!cluster)
        return null;
    const members = await query(`SELECT w.address, w.tier, w.composite_score, w.win_rate, w.realized_roi, cm.confidence, cm.joined_at
     FROM cluster_memberships cm
     JOIN wallets w ON w.address = cm.wallet_address
     WHERE cm.cluster_id = $1
     ORDER BY w.composite_score DESC NULLS LAST`, [clusterId]);
    return { cluster, members };
}
//# sourceMappingURL=clustering-queries.js.map