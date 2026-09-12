import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client.js', () => ({ query: vi.fn() }));

import { query } from './client.js';
import {
  assertMasterAddressMatchesChain,
  countActiveMasterFollowers,
  fetchActiveMasterFollowerCount,
  MasterFollowerInputError,
  summariseMasterFollowerRows,
  type MasterFollowerCountRow
} from './master-followers.js';

const MASTER = 'solana:So11111111111111111111111111111111111111112';

function rows(
  slotHolders: string | null,
  grandfathered: string | null
): MasterFollowerCountRow[] {
  return [{ slot_holders: slotHolders, grandfathered_active: grandfathered }];
}

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('assertMasterAddressMatchesChain', () => {
  it('accepts an address whose prefix is the requested chain', () => {
    expect(() => assertMasterAddressMatchesChain(MASTER, 'solana')).not.toThrow();
    expect(() =>
      assertMasterAddressMatchesChain('polygon:0xabc', 'polygon')
    ).not.toThrow();
  });

  it('refuses an address prefixed for a different chain', () => {
    expect(() => assertMasterAddressMatchesChain('polygon:0xabc', 'solana')).toThrow(
      MasterFollowerInputError
    );
  });

  it('refuses a bare unprefixed address rather than assuming solana', () => {
    expect(() =>
      assertMasterAddressMatchesChain('So11111111111111111111111111111111111111112', 'solana')
    ).toThrow(/no supported chain/);
  });

  it('refuses an empty address', () => {
    expect(() => assertMasterAddressMatchesChain('   ', 'solana')).toThrow(
      MasterFollowerInputError
    );
  });
});

describe('summariseMasterFollowerRows', () => {
  it('reports unknown for an empty result rather than a zero cohort', () => {
    expect(summariseMasterFollowerRows([])).toBeNull();
  });

  it('sums slot holders and grandfathered actives into the capacity-consumer figure', () => {
    expect(summariseMasterFollowerRows(rows('40', '7'))).toEqual({
      slotHolders: 40,
      grandfatheredActive: 7,
      capacityConsumers: 47
    });
  });

  it('counts grandfathered actives toward the cap, not only slot holders', () => {
    // `056` evicts nobody, so an over-subscribed master keeps active members with
    // no ordinal. Counting slot holders alone would under-report exactly those
    // masters — the permissive direction for a cap.
    const counted = summariseMasterFollowerRows(rows('50', '120'));
    expect(counted?.capacityConsumers).toBe(170);
    expect(counted?.capacityConsumers).toBeGreaterThan(counted?.slotHolders ?? 0);
  });

  it('reports a genuinely empty master as zero, not unknown', () => {
    expect(summariseMasterFollowerRows(rows('0', '0'))?.capacityConsumers).toBe(0);
  });

  it('reports unknown when a count is null, because Number(null) is 0', () => {
    expect(summariseMasterFollowerRows(rows(null, '3'))).toBeNull();
    expect(summariseMasterFollowerRows(rows('3', null))).toBeNull();
  });

  it('reports unknown when a count is blank, because Number("") is 0', () => {
    expect(summariseMasterFollowerRows(rows('', '0'))).toBeNull();
    expect(summariseMasterFollowerRows(rows('  ', '0'))).toBeNull();
  });

  it('reports unknown for a non-integer or negative count', () => {
    expect(summariseMasterFollowerRows(rows('4.5', '0'))).toBeNull();
    expect(summariseMasterFollowerRows(rows('-1', '0'))).toBeNull();
    expect(summariseMasterFollowerRows(rows('many', '0'))).toBeNull();
  });

  it('freezes the result so a caller cannot rewrite a cap input', () => {
    const counted = summariseMasterFollowerRows(rows('10', '0'));
    expect(Object.isFrozen(counted)).toBe(true);
  });
});

describe('fetchActiveMasterFollowerCount', () => {
  it('counts only active rows and excludes winding_down and ended in SQL', async () => {
    vi.mocked(query).mockResolvedValue(rows('12', '0'));
    await fetchActiveMasterFollowerCount({ masterWalletAddress: MASTER, chain: 'solana' });

    const sql = vi.mocked(query).mock.calls[0]?.[0] as string;
    expect(sql).toContain("subscription.state = 'active'");
    expect(sql).not.toContain('winding_down');
    expect(sql).not.toContain("state <> 'ended'");
  });

  it('counts grandfathered actives in a second FILTER rather than dropping them', async () => {
    vi.mocked(query).mockResolvedValue(rows('12', '3'));
    const counted = await fetchActiveMasterFollowerCount({
      masterWalletAddress: MASTER,
      chain: 'solana'
    });

    const sql = vi.mocked(query).mock.calls[0]?.[0] as string;
    expect(sql).toContain('membership_grandfathered');
    expect(counted?.capacityConsumers).toBe(15);
  });

  it('scopes to active accounts, matching listFanoutCandidates', async () => {
    vi.mocked(query).mockResolvedValue(rows('1', '0'));
    await fetchActiveMasterFollowerCount({ masterWalletAddress: MASTER, chain: 'solana' });
    expect(vi.mocked(query).mock.calls[0]?.[0] as string).toContain("account.status = 'active'");
  });

  it('passes the master address as the only bound parameter', async () => {
    vi.mocked(query).mockResolvedValue(rows('1', '0'));
    await fetchActiveMasterFollowerCount({ masterWalletAddress: MASTER, chain: 'solana' });
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual([MASTER]);
  });

  it('reports unknown, never zero, when the query throws', async () => {
    vi.mocked(query).mockRejectedValue(new Error('connection terminated'));
    await expect(
      fetchActiveMasterFollowerCount({ masterWalletAddress: MASTER, chain: 'solana' })
    ).resolves.toBeNull();
  });

  it('throws on an incoherent (master, chain) pair without touching the database', async () => {
    await expect(
      fetchActiveMasterFollowerCount({ masterWalletAddress: MASTER, chain: 'polygon' })
    ).rejects.toThrow(MasterFollowerInputError);
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });
});

describe('countActiveMasterFollowers', () => {
  it('returns the capacity-consumer total, not the slot-holder count', async () => {
    vi.mocked(query).mockResolvedValue(rows('50', '9'));
    await expect(
      countActiveMasterFollowers({ masterWalletAddress: MASTER, chain: 'solana' })
    ).resolves.toBe(59);
  });

  it('propagates unknown as null so the cap reports follower-count-unknown', async () => {
    vi.mocked(query).mockResolvedValue([]);
    await expect(
      countActiveMasterFollowers({ masterWalletAddress: MASTER, chain: 'solana' })
    ).resolves.toBeNull();
  });
});
