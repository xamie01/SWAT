import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn()
}));

vi.mock('./client.js', () => ({
  query: mocks.query,
  pool: { connect: vi.fn() }
}));

import { listSubscriptionMasterLots } from './copy-trade-lifecycle.js';

/**
 * S4-M3 / ADR-0007 lot visibility.
 *
 * `listSubscriptionMasterLots` is the read-only enumeration that wind-down
 * sweeps, close-all planners, and the subscription-end guard all consume. It
 * must return the attributable open lots for one (user, master, chain, token)
 * without leaking another master's inventory on the same token.
 */

function lotRow(overrides: Partial<{
  id: string;
  confirmed_quantity: string;
  reserved_sell_quantity: string;
}> = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? 'lot-1',
    target_account: 'solana:PAPER',
    user_id: 'user-1',
    master_wallet_address: 'solana:MasterA',
    chain: 'solana',
    token_mint: 'solana:Token',
    confirmed_quantity: overrides.confirmed_quantity ?? '100',
    reserved_sell_quantity: overrides.reserved_sell_quantity ?? '0',
    cost_basis_usd: '95',
    cost_basis_unvalued_fill_count: 0,
    total_acquired_quantity: '100',
    total_reduced_quantity: '0',
    unmatched_reduction_quantity: '0',
    last_evidence_at: new Date('2026-10-03T00:00:00Z')
  };
}

const DEFAULT_INPUT = {
  targetAccount: 'solana:PAPER',
  userId: 'user-1',
  masterWalletAddress: 'solana:MasterA',
  chain: 'solana' as const,
  tokenMint: 'solana:Token'
};

describe('listSubscriptionMasterLots', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it('returns open lots for the named master only', async () => {
    mocks.query.mockResolvedValue([lotRow({ confirmed_quantity: '100' })]);

    const result = await listSubscriptionMasterLots(DEFAULT_INPUT);

    expect(result).toHaveLength(1);
    expect(result[0].masterWalletAddress).toBe('solana:MasterA');
    expect(result[0].confirmedQuantity).toBe('100');
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array when the master has no open lots', async () => {
    mocks.query.mockResolvedValue([]);

    const result = await listSubscriptionMasterLots(DEFAULT_INPUT);

    expect(result).toEqual([]);
  });

  it('excludes zero-balance lots but keeps reserved ones', async () => {
    mocks.query.mockResolvedValue([
      lotRow({ id: 'lot-reserved', confirmed_quantity: '0', reserved_sell_quantity: '25' })
    ]);

    const result = await listSubscriptionMasterLots(DEFAULT_INPUT);

    expect(result[0].reservedSellQuantity).toBe('25');
    expect(result[0].confirmedQuantity).toBe('0');
  });

  it('passes a NULL user_id through IS NOT DISTINCT FROM without filtering it out', async () => {
    mocks.query.mockResolvedValue([lotRow({ id: 'lot-op' })]);

    await listSubscriptionMasterLots({ ...DEFAULT_INPUT, userId: null });

    const sql = String(mocks.query.mock.calls[0][0]);
    expect(sql).toMatch(/IS NOT DISTINCT FROM/);
  });

  it('does not query another master token combination', async () => {
    mocks.query.mockResolvedValue([lotRow({ id: 'lot-a' })]);

    await listSubscriptionMasterLots(DEFAULT_INPUT);

    const sql = String(mocks.query.mock.calls[0][0]);
    const values = mocks.query.mock.calls[0][1];
    expect(values).toEqual([
      DEFAULT_INPUT.targetAccount,
      DEFAULT_INPUT.userId,
      DEFAULT_INPUT.masterWalletAddress,
      DEFAULT_INPUT.chain,
      DEFAULT_INPUT.tokenMint
    ]);
    expect(sql).not.toMatch(/JOIN|copy_execution/);
  });
});
