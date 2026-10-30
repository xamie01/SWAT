import { describe, expect, it, vi } from 'vitest';
import { executeBillingSweepJob } from './billing-sweep.js';

vi.mock('@swat/db', () => ({
  runTierDowngradeSweep: vi.fn().mockResolvedValue({
    evaluatedAt: new Date('2026-10-30T00:00:00Z'),
    downgradedCount: 2,
    downgradedUserIds: ['usr_1', 'usr_2']
  }),
  closePool: vi.fn().mockResolvedValue(undefined)
}));

describe('Billing Sweep Cron Job', () => {
  it('executes downgrade sweep and logs metrics', async () => {
    const res = await executeBillingSweepJob(new Date('2026-10-30T00:00:00Z'));
    expect(res.downgradedCount).toBe(2);
    expect(res.downgradedUserIds).toEqual(['usr_1', 'usr_2']);
  });
});
