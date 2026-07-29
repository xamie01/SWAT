import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findUnprofitableBigBuyers,
  getActiveWallets,
  getWalletMetrics,
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
