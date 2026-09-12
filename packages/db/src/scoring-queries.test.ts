import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findUnprofitableBigBuyers,
  getActiveWallets,
  getWalletMetrics,
  pauseUnderperformingWallets,
  pauseUnsubscribedWallets,
  pruneUnprofitableBigBuyers,
  updateWalletScore
} from './scoring-queries.js';
import * as client from './client.js';
import { deleteWalletCascade } from './wallets.js';

vi.mock('./client.js', () => ({
  query: vi.fn(),
  pool: { connect: vi.fn() }
}));

vi.mock('./wallets.js', () => ({
  deleteWalletCascade: vi.fn()
}));

describe('chain-aware scoring queries', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('filters every wallet metric input by address and chain', async () => {
    vi.mocked(client.query).mockResolvedValue([{
      win_rate: 0.75,
      realized_roi: 0.2,
      early_entry_score: 0.5,
      consistency_score: 0.8
    }]);

    const metrics = await getWalletMetrics('polygon:0xabc', 'polygon');

    const [sql, values] = vi.mocked(client.query).mock.calls[0] ?? [];
    expect(sql.match(/\.chain = \$2/g)).toHaveLength(3);
    expect(values).toEqual(['polygon:0xabc', 'polygon']);
    expect(metrics).toEqual({
      chain: 'polygon',
      winRate: 0.75,
      realizedRoi: 0.2,
      earlyEntryScore: 0.5,
      consistencyScore: 0.8
    });
    expect(sql).toContain('POWER(10::numeric, COALESCE(token_decimals, 0))');
  });

  it('normalizes PostgreSQL numeric metrics before scoring', async () => {
    vi.mocked(client.query).mockResolvedValue([{
      win_rate: '0.75',
      realized_roi: '0.2',
      early_entry_score: null,
      consistency_score: 'not-a-number'
    }]);

    await expect(getWalletMetrics('polygon:0xabc', 'polygon')).resolves.toEqual({
      chain: 'polygon',
      winRate: 0.75,
      realizedRoi: 0.2,
      earlyEntryScore: 0,
      consistencyScore: 0
    });
  });

  it('updates only the matching wallet chain', async () => {
    vi.mocked(client.query).mockResolvedValue([]);

    await updateWalletScore('polygon:0xabc', 82, 'pro', {
      chain: 'polygon',
      winRate: 0.7,
      realizedRoi: 0.1,
      earlyEntryScore: 0.4,
      consistencyScore: 0.6
    });

    const [sql, values] = vi.mocked(client.query).mock.calls[0] ?? [];
    expect(sql).toContain('AND chain = $8');
    expect(values?.slice(-2)).toEqual(['polygon:0xabc', 'polygon']);
  });

  it('returns chain identity with active wallets', async () => {
    vi.mocked(client.query).mockResolvedValue([
      { address: 'solana:abc', chain: 'solana' },
      { address: 'polygon:0xabc', chain: 'polygon' }
    ]);

    const wallets = await getActiveWallets();

    expect(wallets).toHaveLength(2);
    expect(wallets[1]?.chain).toBe('polygon');
    expect(vi.mocked(client.query).mock.calls[0]?.[0]).toContain('SELECT address, chain');
  });

  it('requires matching-chain transactions before pruning a wallet', async () => {
    vi.mocked(client.query).mockResolvedValue([]);
    await findUnprofitableBigBuyers();

    expect(vi.mocked(client.query).mock.calls[0]?.[0]).toContain('t.chain = w.chain');
    expect(vi.mocked(client.query).mock.calls[0]?.[0]).toContain('SELECT w.address, w.chain');
  });

  it('preserves chain identity while deleting pruned wallets', async () => {
    vi.mocked(client.query).mockResolvedValue([
      { address: 'polygon:0xabc', chain: 'polygon' }
    ]);

    await expect(pruneUnprofitableBigBuyers()).resolves.toBe(1);
    expect(deleteWalletCascade).toHaveBeenCalledWith('polygon:0xabc', 'polygon');
  });
});

describe('subscriber probes ignore ended subscriptions (051 / S4-M3)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(client.query).mockResolvedValue([]);
  });

  // `051` retains an ended subscription rather than deleting the row. A bare
  // existence check therefore reads a wallet nobody tracks as still subscribed and
  // pins it to `active` forever — indexing cost stops being sublinear in user
  // count and grows with user churn instead, which is the D9 bound both of these
  // sweeps exist to enforce.
  it.each([
    ['pauseUnderperformingWallets', pauseUnderperformingWallets],
    ['pauseUnsubscribedWallets', pauseUnsubscribedWallets]
  ])('%s excludes ended rows from its subscriber check', async (_name, run) => {
    await run();
    const sql = vi.mocked(client.query).mock.calls[0]?.[0] as string;
    expect(sql).toContain('user_wallet_subscriptions');
    expect(sql).toMatch(/uws\.state\s*<>\s*'ended'/);
  });

  it.each([
    ['pauseUnderperformingWallets', pauseUnderperformingWallets],
    ['pauseUnsubscribedWallets', pauseUnsubscribedWallets]
  ])('%s still counts a winding_down row as a subscriber', async (_name, run) => {
    // A winding-down subscriber holds positions whose exits arrive as this
    // wallet's sell mirror. Pausing it would strand them with no exit signal —
    // strictly worse than keeping one wallet indexed.
    await run();
    const sql = vi.mocked(client.query).mock.calls[0]?.[0] as string;
    expect(sql).not.toContain("'winding_down'");
    expect(sql).not.toMatch(/uws\.state\s*=\s*'active'/);
  });
});
