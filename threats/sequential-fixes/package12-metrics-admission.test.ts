import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), clientQuery: vi.fn(), connect: vi.fn() }));
vi.mock('../../packages/db/src/client.js', () => ({ query: mocks.query, pool: { connect: mocks.connect } }));
vi.mock('../../packages/db/src/wallets.js', () => ({ deleteWalletCascade: vi.fn() }));

import { getWalletMetrics, updateWalletScore, promoteHighScoringDiscoveredWallets, pruneUnprofitableBigBuyers } from '../../packages/db/src/scoring-queries.js';
import { calculateCompositeScore } from '../../packages/shared/src/scoring.js';
import { assessFunderIndependence, admitsFundingCluster } from '../../packages/db/src/independence.js';
import { checkWalletClusterIndependence, checkWalletHubStatus } from '../../packages/db/src/independence-queries.js';
import { generateFundingClusters } from '../../packages/db/src/clustering-queries.js';
import { fetchMasterTradeRows, listMasterCandidates } from '../../apps/scorer/src/master-metrics.js';

const metrics = { chain: 'solana' as const, winRate: 1, realizedRoi: 10, earlyEntryScore: 1, consistencyScore: 1 };

describe('package12 diagnostic history is not verified admission', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.query.mockResolvedValue([]);
    mocks.clientQuery.mockImplementation(async (sql: string) => ({ rows: [], command: sql === 'COMMIT' ? 'COMMIT' : undefined }));
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: vi.fn(), on: vi.fn(), off: vi.fn() });
  });

  it('keeps legacy arithmetic diagnostic and exposes missing verification', async () => {
    mocks.query.mockResolvedValue([{ win_rate: 1, realized_roi: 10, early_entry_score: 1, consistency_score: 1 }]);
    const result = await getWalletMetrics('solana:poisoned', 'solana');
    expect(calculateCompositeScore(result)).toBe(100);
    expect(result).toMatchObject({ assessment: 'unassessed', assessmentReason: 'source-economics-and-control-unverified' });
  });

  it('does not persist a trusted tier or score from poisoned aggregate ROI', async () => {
    await updateWalletScore('solana:poisoned', 100, 'elite', metrics);
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([null, 'speculative', 1, 10, 1, 1, 'solana:poisoned', 'solana']);
  });

  it('does not promote or destructively prune from old unverified score rows', async () => {
    await promoteHighScoringDiscoveredWallets();
    expect(await pruneUnprofitableBigBuyers()).toBe(0);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('does not read asserted confirmed source rows while the verifier is unavailable', async () => {
    expect(await listMasterCandidates({ asOf: new Date('2026-11-13T00:00:00Z') })).toEqual([]);
    expect(await fetchMasterTradeRows({ walletAddress: 'solana:poisoned', chain: 'solana', since: new Date('2026-11-12T00:00:00Z'), asOf: new Date('2026-11-13T00:00:00Z') })).toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('does not positively clear an unlabelled small observed degree', () => {
    const result = assessFunderIndependence({ funder: 'solana:unknown', observedFundedWalletCount: 3, label: null });
    expect(result.verdict).toBe('unassessed');
    expect(admitsFundingCluster(result)).toBe(false);
    expect(assessFunderIndependence({ funder: 'solana:reviewed', observedFundedWalletCount: 3, label: 'individual' }).verdict).toBe('independent');
  });

  it('uses the pure policy at funding SQL admission, not the absence of a blacklist', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => ({
      command: sql === 'COMMIT' ? 'COMMIT' : undefined,
      rows: sql.includes('AS observed_funded_wallet_count') ? [{ wallet_a: 'solana:unknown', status: 'active', observed_funded_wallet_count: '3' }] : []
    }));
    await generateFundingClusters();
    const insert = mocks.clientQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO wallet_clusters'));
    expect(insert?.[1]).toEqual([[]]);
    expect(insert?.[0]).toContain('ANY($1::text[])');
  });

  it('aggregates all cluster memberships and preserves unassessed absence', async () => {
    mocks.query.mockResolvedValueOnce([{ cluster_type: 'funding', name: 'Funding A' }, { cluster_type: 'behavioral', name: 'Ring B' }]);
    const clustered = await checkWalletClusterIndependence('solana:candidate');
    expect(clustered.warning).toContain('Funding A');
    expect(clustered.warning).toContain('Ring B');
    expect(clustered).toMatchObject({ assessment: 'suspected-coordination', memberships: [{ clusterType: 'funding', clusterName: 'Funding A' }, { clusterType: 'behavioral', clusterName: 'Ring B' }] });
    expect(mocks.query.mock.calls[0]?.[0]).not.toContain('LIMIT 1');
    const unknown = await checkWalletClusterIndependence('solana:untracked');
    expect(unknown).toMatchObject({ assessment: 'unassessed', clustered: false, memberships: [] });
    expect(unknown.warning).toContain('not evidence of independent control');
  });

  it('any same-chain blacklisted alias dominates a normal alias', async () => {
    mocks.query.mockResolvedValue([{ status: 'active', nickname: 'Normal alias' }, { status: 'blacklisted', nickname: 'Exchange alias' }]);
    const result = await checkWalletHubStatus('base:0xabc', '0xabc', 'base');
    expect(result).toMatchObject({ isHub: true, assessment: 'hub', hubName: 'Exchange alias' });
    expect(mocks.query.mock.calls[0]?.[0]).not.toContain('LIMIT 1');
    expect(mocks.query.mock.calls[0]?.[0]).toContain('chain = $3');
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(['base:0xabc', '0xabc', 'base']);
  });

  it('does not report a normal or absent wallet as independently controlled', async () => {
    mocks.query.mockResolvedValue([{ status: 'active', nickname: 'Normal' }]);
    const result = await checkWalletHubStatus('base:0xabc', '0xabc', 'base');
    expect(result).toMatchObject({ isHub: false, assessment: 'unassessed' });
    expect(result.reason).toContain('not evidence of independent control');
  });
});
