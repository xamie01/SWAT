import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const release = vi.fn();
  return {
    clientQuery,
    release,
    // `on`/`off`: a real PoolClient is an EventEmitter, and withTransaction
    // attaches an 'error' listener so a mid-transaction socket failure cannot
    // crash the process. transaction.test.ts covers that behaviour itself.
    connect: vi.fn(async () => ({ query: clientQuery, release, on: vi.fn(), off: vi.fn() })),
    query: vi.fn()
  };
});

vi.mock('./client.js', () => ({
  pool: { connect: mocks.connect },
  query: mocks.query
}));

import {
  generateBehavioralClusters,
  generateFundingClusters
} from './clustering-queries.js';
import { MAX_FUNDER_DEGREE, MIN_FUNDED_WALLETS } from './independence.js';

/** Collapse whitespace so an assertion is not hostage to SQL indentation. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('cluster membership regeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientQuery.mockResolvedValue({ rows: [] });
  });

  it('reconciles funding memberships inside one repeatable-read transaction', async () => {
    await generateFundingClusters();

    const sqlCalls = mocks.clientQuery.mock.calls.map(([sql]) => sql as string);
    expect(sqlCalls[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(sqlCalls[1]).toContain("INSERT INTO wallet_clusters");
    expect(sqlCalls[2]).toContain('DELETE FROM cluster_memberships');
    expect(sqlCalls[2]).toContain("c.cluster_type = 'funding'");
    expect(sqlCalls[2]).toContain('expected_memberships');
    expect(sqlCalls[3]).toContain('INSERT INTO cluster_memberships');
    expect(sqlCalls[4]).toContain("WHERE cluster_type = 'funding'");
    expect(sqlCalls[5]).toContain('DELETE FROM wallet_clusters');
    expect(sqlCalls[6]).toBe('COMMIT');
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('reconciles behavioral memberships without touching other cluster types', async () => {
    await generateBehavioralClusters();

    const sqlCalls = mocks.clientQuery.mock.calls.map(([sql]) => sql as string);
    expect(sqlCalls[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(sqlCalls[2]).toContain('DELETE FROM cluster_memberships');
    expect(sqlCalls[2]).toContain("c.cluster_type = 'behavioral'");
    expect(sqlCalls[2]).toContain('expected_memberships');
    expect(sqlCalls[3]).toContain('INSERT INTO cluster_memberships');
    expect(sqlCalls[4]).toContain("WHERE cluster_type = 'behavioral'");
    expect(sqlCalls[5]).toContain('DELETE FROM wallet_clusters');
    expect(sqlCalls[6]).toBe('COMMIT');
  });

  describe('funder degree bound (S4-M11)', () => {
    it('bounds funder degree from above, not only below', async () => {
      await generateFundingClusters();

      const clusterInsert = flat(mocks.clientQuery.mock.calls[1]?.[0] as string);
      // The bug: a floor with no ceiling, so a CEX hot wallet that funded millions
      // of addresses became one Funding Group.
      expect(clusterInsert).not.toContain('COUNT(DISTINCT wr.wallet_b) >= 2');
      expect(clusterInsert).toContain(
        `HAVING COUNT(DISTINCT wr.wallet_b) BETWEEN ${MIN_FUNDED_WALLETS} `
          + `AND ${MAX_FUNDER_DEGREE}`
      );
    });

    it('excludes blacklisted funders as hubs, on top of the degree band', async () => {
      await generateFundingClusters();

      const clusterInsert = flat(mocks.clientQuery.mock.calls[1]?.[0] as string);
      expect(clusterInsert).toContain('JOIN wallets funder ON funder.address = wr.wallet_a');
      expect(clusterInsert).toContain("funder.status <> 'blacklisted'");
    });

    it('applies the identical eligibility rule to clusters and to memberships', async () => {
      await generateFundingClusters();

      // The two must not drift: a membership set computed from a looser rule than
      // the cluster set would delete every member of a cluster just created, and a
      // tighter one would leave hub clusters populated.
      const eligibility = /eligible_funders AS \((.*?)\) *,? *(?:expected_memberships|INSERT)/;
      const fromInsert = eligibility.exec(
        flat(mocks.clientQuery.mock.calls[1]?.[0] as string)
      );
      const fromDelete = eligibility.exec(
        flat(mocks.clientQuery.mock.calls[2]?.[0] as string)
      );
      const fromMemberInsert = eligibility.exec(
        flat(mocks.clientQuery.mock.calls[3]?.[0] as string)
      );

      // Guard the regex itself: a capture that matched nothing useful would make
      // the equality below vacuously true.
      expect(fromInsert?.[1]).toContain(
        `HAVING COUNT(DISTINCT wr.wallet_b) BETWEEN ${MIN_FUNDED_WALLETS} `
          + `AND ${MAX_FUNDER_DEGREE}`
      );
      expect(fromInsert?.[1]).toContain("funder.status <> 'blacklisted'");
      expect(fromDelete?.[1]).toBe(fromInsert?.[1]);
      expect(fromMemberInsert?.[1]).toBe(fromInsert?.[1]);
    });

    it('still tears down a cluster whose funder crossed the ceiling', async () => {
      await generateFundingClusters();

      const sqlCalls = mocks.clientQuery.mock.calls.map(([sql]) => sql as string);
      // Demotion needs no new statement: the funder drops out of
      // expected_memberships, the DELETE empties the cluster, the recount zeroes
      // wallet_count, and the final DELETE drops the row. Order is what makes that
      // work, so it is asserted.
      expect(flat(sqlCalls[2] ?? '')).toContain('DELETE FROM cluster_memberships');
      expect(flat(sqlCalls[4] ?? '')).toContain('wallet_count =');
      expect(flat(sqlCalls[5] ?? '')).toContain(
        "DELETE FROM wallet_clusters WHERE cluster_type = 'funding' AND wallet_count < 2"
      );
    });
  });

  it('rolls back and releases the client when reconciliation fails', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('cluster write failed'))
      .mockResolvedValueOnce({ rows: [] });

    await expect(generateFundingClusters()).rejects.toThrow('cluster write failed');
    expect(mocks.clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
