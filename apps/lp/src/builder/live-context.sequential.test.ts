import { describe, expect, it, vi } from 'vitest';
vi.mock('@swat/db', () => ({ getLpPool: vi.fn() }));
import { createLiveContextSource } from './live-context.js';
describe('read-only context freshness', () => {
  it('cache fallback retains observation timestamp and warns, never forges freshness', async () => {
    const observed = new Date('2026-11-15T00:00:00Z');
    const source = createLiveContextSource({ getPool: vi.fn(async () => ({ currentPrice: 1, lastScannedAt: observed, binStep: 50, tickSpacing: null })) as any });
    const result = await source.fetchLiveContext('solana', 'solana:pool');
    expect(result!.fetchedAt).toEqual(observed); expect(result!.warnings.join(' ')).toContain('stale');
  });
  it('supported Solana bin reader returns actual current price without financial mutation', async () => {
    const fetchBins = vi.fn(async () => ({ activeBinId: 1, binStep: 50, bins: [{ binId: 1, price: 123, baseAmount: 2, quoteAmount: 5 }] }));
    const source = createLiveContextSource({ solanaBinSource: { fetchBins } });
    const before = Date.now(); const result = await source.fetchLiveContext('solana', 'solana:pool');
    expect(result!.currentPrice).toBe(123); expect(result!.fetchedAt.getTime()).toBeGreaterThanOrEqual(before); expect(result!.warnings).toEqual([]);
  });
});
