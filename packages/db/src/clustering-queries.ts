import { query } from './client.js';
import { withTransaction } from './transaction.js';
import { assessFunderIndependence, admitsFundingCluster } from './independence.js';

/** Cluster creation and membership reconciliation consume the same assessed set. */
const eligibleFundersCte = `
    eligible_funders AS (
      SELECT address AS wallet_a
      FROM wallets
      WHERE address = ANY($1::text[])
    )`;

export async function generateFundingClusters() {
  const expectedMembershipsCte = `
    WITH ${eligibleFundersCte},
    expected_memberships AS (
      SELECT DISTINCT c.id AS cluster_id, edge.wallet_address
      FROM eligible_funders ef
      JOIN wallet_relationships wr
        ON wr.wallet_a = ef.wallet_a
       AND wr.relationship_type = 'funding'
      JOIN wallet_clusters c
        ON c.name = 'Funding Group ' || ef.wallet_a
       AND c.cluster_type = 'funding'
      CROSS JOIN LATERAL (VALUES (wr.wallet_a), (wr.wallet_b)) AS edge(wallet_address)
      JOIN wallets w ON w.address = edge.wallet_address
    )`;

  await withTransaction(async (client) => {
    const candidates = await client.query<{
      wallet_a: string;
      status: string;
      observed_funded_wallet_count: string | number;
    }>(`
      SELECT wr.wallet_a, funder.status,
             COUNT(DISTINCT wr.wallet_b) AS observed_funded_wallet_count
      FROM wallet_relationships wr
      JOIN wallets funder ON funder.address = wr.wallet_a
      WHERE wr.relationship_type = 'funding'
      GROUP BY wr.wallet_a, funder.status
    `);
    const admittedFunders = candidates.rows
      .map((row) => assessFunderIndependence({
        funder: row.wallet_a,
        observedFundedWalletCount: Number(row.observed_funded_wallet_count),
        // No reviewed individual label exists in the current schema. A missing
        // blacklist is not positive control evidence; keep it unassessed.
        label: row.status === 'blacklisted' ? 'exchange' : null
      }))
      .filter(admitsFundingCluster)
      .map((assessment) => assessment.funder);

  // Create a cluster per eligible funder (see eligibleFundersCte: a funded-wallet
  // count inside the band, and not an excluded hub). A lone A->B funding pair is
  // too weak to be a "group" and previously produced a constant-0.85 cluster from
  // a single dust transfer. Confidence is derived from the actual edge confidences
  // (which scale with transfer size) plus a small bonus per extra funded wallet.
    await client.query(`
      WITH ${eligibleFundersCte}
      INSERT INTO wallet_clusters (name, cluster_type, confidence, chain)
      SELECT
        'Funding Group ' || wr.wallet_a,
        'funding',
        LEAST(0.95, AVG(wr.confidence) + 0.05 * (COUNT(DISTINCT wr.wallet_b) - 1)),
        MAX(w.chain)
      FROM eligible_funders ef
      JOIN wallet_relationships wr
        ON wr.wallet_a = ef.wallet_a
       AND wr.relationship_type = 'funding'
      JOIN wallets w ON w.address = wr.wallet_a
      GROUP BY wr.wallet_a
      -- Refresh confidence on re-run so it tracks current evidence instead of
      -- being frozen at first-creation (DO NOTHING).
      ON CONFLICT (name) DO UPDATE SET confidence = EXCLUDED.confidence, updated_at = NOW()
    `, [admittedFunders]);

    // Remove members no longer implied by an eligible funding hub before
    // inserting any newly expected members. Valid existing rows retain joined_at.
    await client.query(`
      ${expectedMembershipsCte}
      DELETE FROM cluster_memberships cm
      USING wallet_clusters c
      WHERE cm.cluster_id = c.id
        AND c.cluster_type = 'funding'
        AND NOT EXISTS (
          SELECT 1
          FROM expected_memberships expected
          WHERE expected.cluster_id = cm.cluster_id
            AND expected.wallet_address = cm.wallet_address
        )
    `, [admittedFunders]);

    // Insert BOTH sides of each current funding edge.
    await client.query(`
      ${expectedMembershipsCte}
      INSERT INTO cluster_memberships (cluster_id, wallet_address)
      SELECT cluster_id, wallet_address
      FROM expected_memberships
      ON CONFLICT (cluster_id, wallet_address) DO NOTHING
    `, [admittedFunders]);

    await client.query(`
      UPDATE wallet_clusters SET
        wallet_count = (
          SELECT COUNT(*) FROM cluster_memberships cm
          WHERE cm.cluster_id = wallet_clusters.id
        ),
        updated_at = NOW()
      WHERE cluster_type = 'funding'
    `);

    // Remove clusters that no longer have enough members. This is also how a
    // funder that grew past MAX_FUNDER_DEGREE, or was newly blacklisted, gets
    // its cluster torn down: it stops appearing in expected_memberships, so the
    // DELETE above empties it and it lands here at wallet_count = 0.
    await client.query(`
      DELETE FROM wallet_clusters
      WHERE cluster_type = 'funding' AND wallet_count < 2
    `);
  }, { isolationLevel: 'REPEATABLE READ' });
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
        COUNT(DISTINCT t1.id) AS sync_count,
        MAX(w1.chain) AS chain
      FROM transactions t1
      JOIN transactions t2
        ON t1.target_token = t2.target_token
        AND t1.wallet_address < t2.wallet_address
        AND ABS(EXTRACT(EPOCH FROM (t1.timestamp - t2.timestamp))) < 300
      JOIN wallets w1 ON w1.address = t1.wallet_address
      JOIN wallets w2 ON w2.address = t2.wallet_address
      WHERE t1.direction = 'buy' AND t2.direction = 'buy'
        AND t1.target_token IS NOT NULL
        AND w1.chain = w2.chain
      GROUP BY t1.wallet_address, t2.wallet_address
      HAVING COUNT(DISTINCT t1.id) > 3
    )`;
  const expectedMembershipsCte = `
    ${syncPairsCte},
    expected_memberships AS (
      SELECT DISTINCT c.id AS cluster_id, edge.wallet_address
      FROM sync_pairs sp
      JOIN wallet_clusters c
        ON c.name = 'Behavioral Group ' || sp.w_low
       AND c.cluster_type = 'behavioral'
      CROSS JOIN LATERAL (VALUES (sp.w_low), (sp.w_high)) AS edge(wallet_address)
      JOIN wallets w ON w.address = edge.wallet_address
    )`;

  await withTransaction(async (client) => {

    // Step 1: create one cluster per anchor wallet (w_low).
    await client.query(`
      ${syncPairsCte}
      INSERT INTO wallet_clusters (name, cluster_type, confidence, chain)
      SELECT
        'Behavioral Group ' || w_low,
        'behavioral',
        LEAST(0.95, 0.50 + (MAX(sync_count)::float * 0.05)),
        MAX(chain)
      FROM sync_pairs
      GROUP BY w_low
      ON CONFLICT (name) DO UPDATE SET confidence = EXCLUDED.confidence, updated_at = NOW()
    `);

    // Step 2: remove members no longer present in the current synchronized-buy
    // graph, scoped strictly to behavioral clusters.
    await client.query(`
      ${expectedMembershipsCte}
      DELETE FROM cluster_memberships cm
      USING wallet_clusters c
      WHERE cm.cluster_id = c.id
        AND c.cluster_type = 'behavioral'
        AND NOT EXISTS (
          SELECT 1
          FROM expected_memberships expected
          WHERE expected.cluster_id = cm.cluster_id
            AND expected.wallet_address = cm.wallet_address
        )
    `);

    // Step 3: add both wallets of every currently synchronized pair.
    await client.query(`
      ${expectedMembershipsCte}
      INSERT INTO cluster_memberships (cluster_id, wallet_address)
      SELECT cluster_id, wallet_address
      FROM expected_memberships
      ON CONFLICT (cluster_id, wallet_address) DO NOTHING
    `);

    await client.query(`
      UPDATE wallet_clusters SET
        wallet_count = (
          SELECT COUNT(*) FROM cluster_memberships cm
          WHERE cm.cluster_id = wallet_clusters.id
        ),
        updated_at = NOW()
      WHERE cluster_type = 'behavioral'
    `);

    // Remove clusters that no longer have enough members
    await client.query(`
      DELETE FROM wallet_clusters
      WHERE cluster_type = 'behavioral' AND wallet_count < 2
    `);
  }, { isolationLevel: 'REPEATABLE READ' });
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
           last_active, created_at, chain
    FROM wallet_clusters
    WHERE status = 'active'
    ORDER BY confidence DESC, wallet_count DESC, id DESC
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
