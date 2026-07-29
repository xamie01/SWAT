import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const release = vi.fn();
  return {
    clientQuery,
    release,
    connect: vi.fn(async () => ({ query: clientQuery, release })),
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
