import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from './client.js';
import {
  clearChainCertificationCache,
  getActiveCertifiedChains
} from './chain-certifications.js';

vi.mock('./client.js', () => ({
  query: vi.fn()
}));

describe('getActiveCertifiedChains', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearChainCertificationCache();
  });

  it('returns only rows accepted by the active certification query', async () => {
    vi.mocked(query).mockResolvedValue([
      { chain: 'polygon' },
      { chain: 'solana' }
    ]);

    await expect(getActiveCertifiedChains()).resolves.toEqual(['polygon', 'solana']);
    const [sql] = vi.mocked(query).mock.calls[0] as [string];
    expect(sql).toContain("status = 'certified'");
    expect(sql).toContain('reviewed_at <= NOW()');
    expect(sql).toContain('evidence_sha256');
    expect(sql).toContain('expires_at > NOW()');
  });

  it('caches certifications for thirty seconds', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(query)
        .mockResolvedValueOnce([{ chain: 'solana' }])
        .mockResolvedValueOnce([{ chain: 'polygon' }]);

      await expect(getActiveCertifiedChains()).resolves.toEqual(['solana']);
      vi.advanceTimersByTime(29_999);
      await expect(getActiveCertifiedChains()).resolves.toEqual(['solana']);
      expect(query).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2);
      await expect(getActiveCertifiedChains()).resolves.toEqual(['polygon']);
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
