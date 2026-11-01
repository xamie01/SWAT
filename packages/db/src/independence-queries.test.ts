import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkWalletClusterIndependence, checkWalletHubStatus } from './independence-queries.js';
import * as client from './client.js';

vi.mock('./client.js', () => ({
  query: vi.fn()
}));

describe('independence queries (S4-M10, S4-M11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkWalletClusterIndependence (S4-M10)', () => {
    it('returns clustered: false when the wallet has no cluster memberships', async () => {
      vi.mocked(client.query).mockResolvedValueOnce([]);

      const result = await checkWalletClusterIndependence('solana:unclustered-wallet');
      expect(result).toEqual({
        clustered: false,
        clusterType: null,
        clusterName: null,
        warning: null
      });
    });

    it('returns a funding cluster warning when the wallet belongs to a funding group', async () => {
      vi.mocked(client.query).mockResolvedValueOnce([
        { cluster_type: 'funding', name: 'Funding Group Alice' }
      ]);

      const result = await checkWalletClusterIndependence('solana:clustered-wallet');
      expect(result.clustered).toBe(true);
      expect(result.clusterType).toBe('funding');
      expect(result.clusterName).toBe('Funding Group Alice');
      expect(result.warning).toContain('Shared funding suggests common control or Sybil coordination');
    });

    it('returns a behavioral cluster warning when the wallet belongs to a behavioral group', async () => {
      vi.mocked(client.query).mockResolvedValueOnce([
        { cluster_type: 'behavioral', name: 'Sniper Ring 7' }
      ]);

      const result = await checkWalletClusterIndependence('solana:clustered-wallet');
      expect(result.clustered).toBe(true);
      expect(result.clusterType).toBe('behavioral');
      expect(result.clusterName).toBe('Sniper Ring 7');
      expect(result.warning).toContain('Co-movement suggests shared strategy or bot ring');
    });
  });

  describe('checkWalletHubStatus (S4-M11)', () => {
    it('returns isHub: false for normal unblacklisted wallets', async () => {
      vi.mocked(client.query).mockResolvedValueOnce([
        { status: 'active', nickname: 'Alpha Trader' }
      ]);

      const result = await checkWalletHubStatus(
        'polygon:0x1111111111111111111111111111111111111111',
        '0x1111111111111111111111111111111111111111',
        'polygon'
      );
      expect(result).toEqual({
        isHub: false,
        label: null,
        hubName: null,
        reason: null
      });
    });

    it('returns isHub: true and identifies the hub name when status is blacklisted', async () => {
      vi.mocked(client.query).mockResolvedValueOnce([
        { status: 'blacklisted', nickname: 'Binance 14' }
      ]);

      const result = await checkWalletHubStatus(
        'polygon:0x2222222222222222222222222222222222222222',
        '0x2222222222222222222222222222222222222222',
        'polygon'
      );
      expect(result).toEqual({
        isHub: true,
        label: 'exchange',
        hubName: 'Binance 14',
        reason: 'This is an exchange wallet (Binance 14)'
      });
    });
  });
});
