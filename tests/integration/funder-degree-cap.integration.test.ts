import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closePool,
  generateFundingClusters,
  pool,
  query
} from '../../packages/db/src/index.js';
// Deep import: `independence.ts` is not re-exported from the `@swat/db` barrel yet
// (the barrel is owned elsewhere this session). Switch to the barrel once it is.
import {
  MAX_FUNDER_DEGREE,
  MIN_FUNDED_WALLETS
} from '../../packages/db/src/independence.js';

/**
 * S4-M11: the funder degree cap and hub exclusion, against real SQL.
 *
 * WRITTEN BUT NEVER RUN. No database was available in the session that produced
 * it, so treat every assertion here as unverified. It exists because two things
 * in S4-M11 cannot live in the pure predicate and therefore cannot be tested
 * without Postgres:
 *
 *  1. `BETWEEN ... AND ...` over `COUNT(DISTINCT wr.wallet_b)` -- the degree is
 *     an aggregate over a table. Pulling it into TypeScript would mean loading
 *     every funding edge into the scorer, so the band is evaluated in SQL and
 *     `assessFunderIndependence` is the testable statement of the same rule.
 *  2. Cluster teardown on demotion. That a funder crossing the ceiling loses its
 *     cluster is an emergent consequence of four statements running in order
 *     (membership DELETE -> membership INSERT -> recount -> empty-cluster
 *     DELETE). The unit test can only assert the statements and their order; only
 *     a database shows the row is gone.
 *
 * Requires `INTEGRATION_DATABASE_URL` (or `DATABASE_URL`) on a `_integration` /
 * `_test` database -- `vitest.integration.config.ts` refuses otherwise.
 */

const CHAIN = 'solana';
const PREFIX = 's4m11';

function addr(name: string): string {
  return `${CHAIN}:${PREFIX}-${name}`;
}

async function seedWallet(address: string, status = 'active'): Promise<void> {
  await query(
    `INSERT INTO wallets (address, chain, source, status)
     VALUES ($1, $2, 'manual', $3)
     ON CONFLICT (address) DO UPDATE SET status = EXCLUDED.status`,
    [address, CHAIN, status]
  );
}

/** Give `funder` `degree` distinct funded wallets, all seeded. */
async function seedFunding(funder: string, degree: number): Promise<void> {
  await seedWallet(funder);
  for (let i = 0; i < degree; i += 1) {
    const funded = addr(`${funder.split('-').pop()}-recipient-${i}`);
    await seedWallet(funded);
    await query(
      `INSERT INTO wallet_relationships (wallet_a, wallet_b, relationship_type, confidence)
       VALUES ($1, $2, 'funding', 0.60)
       ON CONFLICT (wallet_a, wallet_b, relationship_type) DO NOTHING`,
      [funder, funded]
    );
  }
}

async function fundingCluster(funder: string) {
  const rows = await query<{ id: string; wallet_count: number }>(
    `SELECT id, wallet_count FROM wallet_clusters
     WHERE cluster_type = 'funding' AND name = $1`,
    [`Funding Group ${funder}`]
  );
  return rows[0] ?? null;
}

async function cleanup(): Promise<void> {
  await query(
    `DELETE FROM cluster_memberships
     WHERE wallet_address LIKE $1
        OR cluster_id IN (SELECT id FROM wallet_clusters WHERE name LIKE $2)`,
    [`${CHAIN}:${PREFIX}-%`, `Funding Group ${CHAIN}:${PREFIX}-%`]
  );
  await query(`DELETE FROM wallet_clusters WHERE name LIKE $1`, [
    `Funding Group ${CHAIN}:${PREFIX}-%`
  ]);
  await query(`DELETE FROM wallet_relationships WHERE wallet_a LIKE $1 OR wallet_b LIKE $1`, [
    `${CHAIN}:${PREFIX}-%`
  ]);
  await query(`DELETE FROM wallets WHERE address LIKE $1`, [`${CHAIN}:${PREFIX}-%`]);
}

describe('funder degree cap', () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await closePool();
  });

  it('clusters a person-scale funder', async () => {
    const funder = addr('friends');
    await seedFunding(funder, MIN_FUNDED_WALLETS + 1);

    await generateFundingClusters();

    const cluster = await fundingCluster(funder);
    expect(cluster).not.toBeNull();
    // Funder plus each recipient.
    expect(Number(cluster?.wallet_count)).toBe(MIN_FUNDED_WALLETS + 2);
  });

  it('forms no cluster for a funder one wallet over the ceiling', async () => {
    const funder = addr('hotwallet');
    await seedFunding(funder, MAX_FUNDER_DEGREE + 1);

    await generateFundingClusters();

    expect(await fundingCluster(funder)).toBeNull();
    const memberships = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM cluster_memberships WHERE wallet_address LIKE $1`,
      [`${CHAIN}:${PREFIX}-hotwallet%`]
    );
    expect(Number(memberships[0]?.n)).toBe(0);
  });

  it('clusters a funder sitting exactly on the ceiling', async () => {
    const funder = addr('edge');
    await seedFunding(funder, MAX_FUNDER_DEGREE);

    await generateFundingClusters();

    expect(await fundingCluster(funder)).not.toBeNull();
  });

  it('tears down the cluster of a funder that grows past the ceiling', async () => {
    // The regression that matters: the ceiling must apply to funders already
    // clustered, not only to new ones.
    const funder = addr('grower');
    await seedFunding(funder, MAX_FUNDER_DEGREE);
    await generateFundingClusters();
    expect(await fundingCluster(funder)).not.toBeNull();

    await seedFunding(funder, MAX_FUNDER_DEGREE + 5);
    await generateFundingClusters();

    expect(await fundingCluster(funder)).toBeNull();
  });

  it('excludes a blacklisted funder whose degree is inside the band', async () => {
    // The hub exclusion, doing what the band cannot: an exchange only a handful
    // of whose recipients we index has a small OBSERVED degree.
    const funder = addr('quietcex');
    await seedFunding(funder, MIN_FUNDED_WALLETS + 1);
    await seedWallet(funder, 'blacklisted');

    await generateFundingClusters();

    expect(await fundingCluster(funder)).toBeNull();
  });

  it('tears down the cluster of a funder blacklisted after the fact', async () => {
    const funder = addr('lateflag');
    await seedFunding(funder, MIN_FUNDED_WALLETS + 1);
    await generateFundingClusters();
    expect(await fundingCluster(funder)).not.toBeNull();

    await seedWallet(funder, 'blacklisted');
    await generateFundingClusters();

    expect(await fundingCluster(funder)).toBeNull();
  });

  it('leaves other funders untouched when one is excluded', async () => {
    const good = addr('good');
    const hub = addr('hub');
    await seedFunding(good, MIN_FUNDED_WALLETS);
    await seedFunding(hub, MAX_FUNDER_DEGREE + 1);

    await generateFundingClusters();

    expect(await fundingCluster(good)).not.toBeNull();
    expect(await fundingCluster(hub)).toBeNull();
  });

  it('holds the pool open for the suite', () => {
    expect(pool).toBeDefined();
  });
});
