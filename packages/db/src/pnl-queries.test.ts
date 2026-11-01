import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchTokenPriceUsd: vi.fn(),
  query: vi.fn()
}));

vi.mock('@swat/shared', () => ({
  fetchTokenPriceUsd: mocks.fetchTokenPriceUsd,
  isChain: (value: unknown) =>
    value === 'solana' || value === 'polygon' || value === 'robinhood-chain'
}));

vi.mock('./client.js', () => ({
  query: mocks.query
}));

import { markToMarketOpenPositions } from './pnl-queries.js';

describe('markToMarketOpenPositions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue([]);
  });

  it('loads only ordered, filled, non-shadow ledger entries', async () => {
    await expect(markToMarketOpenPositions()).resolves.toEqual({
      updated: 0,
      skipped: 0,
      positions: []
    });

    expect(mocks.query).toHaveBeenCalledOnce();
    const [sql] = mocks.query.mock.calls[0] as [string];
    expect(sql).toContain("AND t.status IN ('filled', 'partial')");
    expect(sql).toContain("AND t.direction IN ('buy', 'sell')");
    expect(sql).toContain("t.execution_mode != 'shadow'");
    expect(sql).toContain('($1::uuid IS NULL OR t.signal_id = $1)');
    // `user_id` in the projection and in the ORDER BY is what makes the grouping below
    // per (signal, user). Without it every tenant's trades on one signal merge into one
    // position, and `signal_stop_losses` (PRIMARY KEY (account, signal_id)) then lets
    // one holder's claim block every other holder's (`S4-M46`).
    expect(sql).toContain('t.user_id');
    expect(sql).toContain('ORDER BY t.signal_id, t.user_id, t.executed_at, t.id');
    expect(mocks.query).toHaveBeenCalledWith(expect.any(String), [null]);
    expect(mocks.fetchTokenPriceUsd).not.toHaveBeenCalled();
  });

  it('persists realized and unrealized components for a partial sell', async () => {
    mocks.query
      .mockResolvedValueOnce([
        {
          signal_id: 'signal-1',
          user_id: null,
          token_mint: 'solana:token-1',
          direction: 'buy',
          token_amount: '100',
          amount_usd: '100',
          price_usd: '1',
          fee_usd: '1'
        },
        {
          signal_id: 'signal-1',
          user_id: null,
          token_mint: 'solana:token-1',
          direction: 'sell',
          token_amount: '40',
          amount_usd: '80',
          price_usd: '2',
          fee_usd: '2'
        }
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.fetchTokenPriceUsd.mockResolvedValue(1.5);

    await expect(markToMarketOpenPositions()).resolves.toEqual({
      updated: 1,
      skipped: 0,
      positions: [
        {
          signalId: 'signal-1',
          userId: null,
          tokenMint: 'solana:token-1',
          chain: 'solana',
          openQuantity: 60,
          openCostBasisUsd: 60.6,
          unrealizedPnlUsd: 29.4,
          currentPriceUsd: 1.5
        }
      ]
    });

    expect(mocks.fetchTokenPriceUsd).toHaveBeenCalledWith('solana:token-1');
    const updateCall = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes('realized_pnl_usd = $2')
    );
    expect(updateCall?.[1]).toEqual([67, 37.6, 29.4, 'signal-1']);
  });

  it('persists realized P&L for a closed position without fetching a price', async () => {
    mocks.query
      .mockResolvedValueOnce([
        {
          signal_id: 'signal-2',
          user_id: null,
          token_mint: 'polygon:token-2',
          direction: 'buy',
          token_amount: 10,
          amount_usd: 100,
          price_usd: 10
        },
        {
          signal_id: 'signal-2',
          user_id: null,
          token_mint: 'polygon:token-2',
          direction: 'sell',
          token_amount: 10,
          amount_usd: 130,
          price_usd: 13
        }
      ])
      .mockResolvedValueOnce([]);

    await expect(markToMarketOpenPositions()).resolves.toEqual({
      updated: 1,
      skipped: 0,
      positions: []
    });
    expect(mocks.fetchTokenPriceUsd).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([30, 30, 0, 'signal-2']);
  });

  it('skips an oversold ledger instead of fabricating P&L', async () => {
    mocks.query.mockResolvedValueOnce([
      {
        signal_id: 'signal-3',
        user_id: null,
        token_mint: 'polygon:token-3',
        direction: 'sell',
        token_amount: 1,
        amount_usd: 1,
        price_usd: 1
      }
    ]);

    await expect(markToMarketOpenPositions()).resolves.toEqual({
      updated: 0,
      skipped: 1,
      positions: []
    });
    expect(mocks.fetchTokenPriceUsd).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledOnce();
  });
});

describe('markToMarketOpenPositions per-tenant grouping (S4-M46)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue([]);
  });

  function buy(overrides: Record<string, unknown>) {
    return {
      signal_id: 'shared-signal',
      token_mint: 'solana:token-1',
      direction: 'buy',
      fee_usd: 0,
      ...overrides
    };
  }

  it('values two tenants on ONE signal as two positions, each on its own cost basis', async () => {
    // The defect this closes: merged, these two produce ONE position of 200 units at a
    // blended $1.50 basis, so user-b's drawdown is measured partly against money user-a
    // spent -- and one `signal_stop_losses` claim then covers a cohort of two.
    mocks.query
      .mockResolvedValueOnce([
        buy({ user_id: 'user-a', token_amount: '100', amount_usd: '100', price_usd: '1' }),
        buy({ user_id: 'user-b', token_amount: '100', amount_usd: '200', price_usd: '2' })
      ])
      .mockResolvedValue([]);
    mocks.fetchTokenPriceUsd.mockResolvedValue(1);

    const result = await markToMarketOpenPositions();

    expect(result.positions).toEqual([
      {
        signalId: 'shared-signal',
        userId: 'user-a',
        tokenMint: 'solana:token-1',
        chain: 'solana',
        openQuantity: 100,
        openCostBasisUsd: 100,
        unrealizedPnlUsd: 0,
        currentPriceUsd: 1
      },
      {
        signalId: 'shared-signal',
        userId: 'user-b',
        tokenMint: 'solana:token-1',
        chain: 'solana',
        openQuantity: 100,
        openCostBasisUsd: 200,
        // -100 on a 200 basis is a 50% drawdown. Merged, the blended basis would have
        // reported -50 on 300, i.e. 16.7%, and user-b's real breach would be invisible.
        unrealizedPnlUsd: -100,
        currentPriceUsd: 1
      }
    ]);
  });

  it('keeps two tenants’ positions separate even when they are identical', async () => {
    // Nothing distinguishes these rows but `user_id`. Merged they become one 100-unit
    // position and one claim; separated they are two 50-unit positions and two claims.
    mocks.query
      .mockResolvedValueOnce([
        buy({ user_id: 'user-a', token_amount: '50', amount_usd: '50', price_usd: '1' }),
        buy({ user_id: 'user-b', token_amount: '50', amount_usd: '50', price_usd: '1' })
      ])
      .mockResolvedValue([]);
    mocks.fetchTokenPriceUsd.mockResolvedValue(1);

    const { positions } = await markToMarketOpenPositions();

    expect(positions).toHaveLength(2);
    expect(positions.map((position) => [position.userId, position.openQuantity])).toEqual([
      ['user-a', 50],
      ['user-b', 50]
    ]);
  });

  it('keeps the operator’s legacy NULL rows on their own ledger, not merged with a tenant’s', async () => {
    // Migration 050 backfills nothing, so `user_id NULL` is a real account and not a
    // missing value. Merging it into a tenant's ledger would put the operator's cost
    // basis behind that tenant's stop-loss decision.
    mocks.query
      .mockResolvedValueOnce([
        buy({ user_id: null, token_amount: '10', amount_usd: '10', price_usd: '1' }),
        buy({ user_id: 'user-a', token_amount: '20', amount_usd: '20', price_usd: '1' })
      ])
      .mockResolvedValue([]);
    mocks.fetchTokenPriceUsd.mockResolvedValue(1);

    const { positions } = await markToMarketOpenPositions();

    expect(positions.map((position) => [position.userId, position.openQuantity])).toEqual([
      [null, 10],
      ['user-a', 20]
    ]);
  });

  it('sums the tenants into ONE signal-level total, because `signals` has no user column', async () => {
    // Realized and unrealized P&L are additive over disjoint sub-ledgers; average unit
    // cost is not. So per-tenant valuation summed afterwards is the correct total, and
    // it is what the dashboard reads.
    mocks.query
      .mockResolvedValueOnce([
        buy({ user_id: 'user-a', token_amount: '10', amount_usd: '100', price_usd: '10' }),
        {
          signal_id: 'shared-signal',
          user_id: 'user-a',
          token_mint: 'solana:token-1',
          direction: 'sell',
          token_amount: '10',
          amount_usd: '130',
          price_usd: '13',
          fee_usd: 0
        },
        buy({ user_id: 'user-b', token_amount: '10', amount_usd: '100', price_usd: '10' }),
        {
          signal_id: 'shared-signal',
          user_id: 'user-b',
          token_mint: 'solana:token-1',
          direction: 'sell',
          token_amount: '10',
          amount_usd: '150',
          price_usd: '15',
          fee_usd: 0
        }
      ])
      .mockResolvedValue([]);

    await expect(markToMarketOpenPositions()).resolves.toMatchObject({
      updated: 1,
      skipped: 0,
      positions: []
    });

    const updateCalls = mocks.query.mock.calls.filter(([sql]) =>
      String(sql).includes('realized_pnl_usd = $2')
    );
    // ONE update for the signal, not one per tenant -- two writes would race to
    // last-writer-wins and the loser's P&L would vanish.
    expect(updateCalls).toHaveLength(1);
    // 30 + 50 realized, nothing open.
    expect(updateCalls[0]?.[1]).toEqual([80, 80, 0, 'shared-signal']);
  });

  it('skips the signal total when ONE tenant’s ledger is unusable, but still protects the others', async () => {
    // A total built from the tenants that happened to resolve is a fabricated number on
    // the performance dashboard. The tenant who DID resolve still gets a position, since
    // an open position needs a stop-loss regardless of another tenant's bookkeeping.
    mocks.query
      .mockResolvedValueOnce([
        {
          signal_id: 'shared-signal',
          user_id: 'user-a',
          token_mint: 'solana:token-1',
          direction: 'sell',
          token_amount: '5',
          amount_usd: '5',
          price_usd: '1',
          fee_usd: 0
        },
        buy({ user_id: 'user-b', token_amount: '10', amount_usd: '10', price_usd: '1' })
      ])
      .mockResolvedValue([]);
    mocks.fetchTokenPriceUsd.mockResolvedValue(1);

    const result = await markToMarketOpenPositions();

    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.positions.map((position) => position.userId)).toEqual(['user-b']);
    expect(
      mocks.query.mock.calls.filter(([sql]) => String(sql).includes('realized_pnl_usd = $2'))
    ).toHaveLength(0);
  });

  it('fetches each mint’s price once no matter how many tenants hold it', async () => {
    mocks.query
      .mockResolvedValueOnce([
        buy({ user_id: 'user-a', token_amount: '10', amount_usd: '10', price_usd: '1' }),
        buy({ user_id: 'user-b', token_amount: '10', amount_usd: '10', price_usd: '1' }),
        buy({ user_id: 'user-c', token_amount: '10', amount_usd: '10', price_usd: '1' })
      ])
      .mockResolvedValue([]);
    mocks.fetchTokenPriceUsd.mockResolvedValue(1);

    const { positions } = await markToMarketOpenPositions();

    expect(positions).toHaveLength(3);
    expect(mocks.fetchTokenPriceUsd).toHaveBeenCalledOnce();
  });

  it('does not let an unknown price become a zero-valued position', async () => {
    // A null price with an open quantity must propagate as unknown. Valuing it at 0
    // would report a 100% drawdown and the sweep would sell a healthy position.
    mocks.query
      .mockResolvedValueOnce([
        buy({ user_id: 'user-a', token_amount: '10', amount_usd: '10', price_usd: '1' })
      ])
      .mockResolvedValue([]);
    mocks.fetchTokenPriceUsd.mockResolvedValue(null);

    await expect(markToMarketOpenPositions()).resolves.toEqual({
      updated: 0,
      skipped: 1,
      positions: []
    });
  });

  it('emits one keyed snapshot per open master lot while rolling up the signal once', async () => {
    mocks.query
      .mockResolvedValueOnce([
        buy({ user_id: 'user-a', token_amount: '15', amount_usd: '150', price_usd: '10' })
      ])
      .mockResolvedValueOnce([
        {
          lot_id: 'lot-master-a',
          signal_id: 'shared-signal',
          user_id: 'user-a',
          master_wallet_address: 'solana:master-a',
          token_mint: 'solana:token-1',
          chain: 'solana',
          remaining_quantity: '10',
          remaining_cost_basis_usd: '100'
        },
        {
          lot_id: 'lot-master-b',
          signal_id: 'shared-signal',
          user_id: 'user-a',
          master_wallet_address: 'solana:master-b',
          token_mint: 'solana:token-1',
          chain: 'solana',
          remaining_quantity: '5',
          remaining_cost_basis_usd: '50'
        }
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mocks.fetchTokenPriceUsd.mockResolvedValue(5);

    const result = await markToMarketOpenPositions();

    expect(result.positions).toEqual([
      {
        signalId: 'shared-signal',
        userId: 'user-a',
        positionKey: 'lot-master-a',
        tokenMint: 'solana:token-1',
        chain: 'solana',
        openQuantity: 10,
        openCostBasisUsd: 100,
        unrealizedPnlUsd: -50,
        currentPriceUsd: 5
      },
      {
        signalId: 'shared-signal',
        userId: 'user-a',
        positionKey: 'lot-master-b',
        tokenMint: 'solana:token-1',
        chain: 'solana',
        openQuantity: 5,
        openCostBasisUsd: 50,
        unrealizedPnlUsd: -25,
        currentPriceUsd: 5
      }
    ]);
    expect(result.updated).toBe(1);
    expect(
      mocks.query.mock.calls.filter(([sql]) => String(sql).includes('realized_pnl_usd = $2'))
    ).toHaveLength(1);
  });
});
