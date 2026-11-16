import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const release = vi.fn();
  return {
    clientQuery, release,
    connect: vi.fn(async () => ({ query: clientQuery, release, on: vi.fn(), off: vi.fn() })),
    query: vi.fn()
  };
});
vi.mock('./client.js', () => ({ pool: { connect: mocks.connect }, query: mocks.query }));
import { generateBehavioralClusters, generateFundingClusters } from './clustering-queries.js';
import { MAX_FUNDER_DEGREE, MIN_FUNDED_WALLETS } from './independence.js';

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const calls = (): string[] => mocks.clientQuery.mock.calls.map(([sql]) => sql as string);
function candidates(rows: unknown[]): void {
  mocks.clientQuery.mockImplementation(async (sql: string) => ({
    command: sql === 'COMMIT' ? 'COMMIT' : undefined,
    rows: sql.includes('AS observed_funded_wallet_count') ? rows : []
  }));
}

describe('cluster membership regeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    candidates([]);
  });

  it('reconciles funding memberships inside one repeatable-read transaction', async () => {
    await generateFundingClusters();
    const sql = calls();
    expect(sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(sql[1]).toContain('AS observed_funded_wallet_count');
    expect(sql[2]).toContain('INSERT INTO wallet_clusters');
    expect(sql[3]).toContain('DELETE FROM cluster_memberships');
    expect(sql[3]).toContain("c.cluster_type = 'funding'");
    expect(sql[3]).toContain('expected_memberships');
    expect(sql[4]).toContain('INSERT INTO cluster_memberships');
    expect(sql[5]).toContain("WHERE cluster_type = 'funding'");
    expect(sql[6]).toContain('DELETE FROM wallet_clusters');
    expect(sql[7]).toBe('COMMIT');
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('reconciles behavioral memberships without touching other cluster types', async () => {
    await generateBehavioralClusters();
    const sql = calls();
    expect(sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(sql[2]).toContain('DELETE FROM cluster_memberships');
    expect(sql[2]).toContain("c.cluster_type = 'behavioral'");
    expect(sql[2]).toContain('expected_memberships');
    expect(sql[3]).toContain('INSERT INTO cluster_memberships');
    expect(sql[4]).toContain("WHERE cluster_type = 'behavioral'");
    expect(sql[5]).toContain('DELETE FROM wallet_clusters');
    expect(sql[6]).toBe('COMMIT');
  });

  describe('funder degree bound (S4-M11)', () => {
    it('excludes both over-ceiling and below-minimum funders at policy admission', async () => {
      candidates([
        { wallet_a: 'solana:large', status: 'active', observed_funded_wallet_count: MAX_FUNDER_DEGREE + 1 },
        { wallet_a: 'solana:small', status: 'active', observed_funded_wallet_count: MIN_FUNDED_WALLETS - 1 }
      ]);
      await generateFundingClusters();
      expect(mocks.clientQuery.mock.calls[2]?.[1]).toEqual([[]]);
      expect(calls()[1]).toContain('COUNT(DISTINCT wr.wallet_b)');
    });

    it('excludes blacklisted and unassessed funders even inside the degree band', async () => {
      candidates([
        { wallet_a: 'solana:exchange', status: 'blacklisted', observed_funded_wallet_count: 3 },
        { wallet_a: 'solana:unlabelled', status: 'active', observed_funded_wallet_count: 3 }
      ]);
      await generateFundingClusters();
      expect(calls()[1]).toContain('JOIN wallets funder ON funder.address = wr.wallet_a');
      expect(mocks.clientQuery.mock.calls[2]?.[1]).toEqual([[]]);
    });

    it('applies the identical assessed set to clusters and memberships', async () => {
      await generateFundingClusters();
      const eligibility = /eligible_funders AS \((.*?)\) *,? *(?:expected_memberships|INSERT)/;
      const insert = eligibility.exec(flat(calls()[2]!));
      const remove = eligibility.exec(flat(calls()[3]!));
      const memberInsert = eligibility.exec(flat(calls()[4]!));
      expect(insert?.[1]).toContain('address = ANY($1::text[])');
      expect(remove?.[1]).toBe(insert?.[1]);
      expect(memberInsert?.[1]).toBe(insert?.[1]);
      expect(mocks.clientQuery.mock.calls[3]?.[1]).toEqual(mocks.clientQuery.mock.calls[2]?.[1]);
      expect(mocks.clientQuery.mock.calls[4]?.[1]).toEqual(mocks.clientQuery.mock.calls[2]?.[1]);
    });

    it('still tears down a cluster whose funder crossed the ceiling', async () => {
      candidates([{ wallet_a: 'solana:large', status: 'active', observed_funded_wallet_count: MAX_FUNDER_DEGREE + 1 }]);
      await generateFundingClusters();
      expect(flat(calls()[3]!)).toContain('DELETE FROM cluster_memberships');
      expect(flat(calls()[5]!)).toContain('wallet_count =');
      expect(flat(calls()[6]!)).toContain("DELETE FROM wallet_clusters WHERE cluster_type = 'funding' AND wallet_count < 2");
    });
  });

  it('rolls back and releases the client when reconciliation fails', async () => {
    mocks.clientQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('cluster write failed')).mockResolvedValueOnce({ rows: [] });
    await expect(generateFundingClusters()).rejects.toThrow('cluster write failed');
    expect(mocks.clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
