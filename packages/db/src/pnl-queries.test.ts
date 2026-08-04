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
    expect(sql).toContain('ORDER BY t.signal_id, t.executed_at, t.id');
    expect(mocks.query).toHaveBeenCalledWith(expect.any(String), [null]);
    expect(mocks.fetchTokenPriceUsd).not.toHaveBeenCalled();
  });

  it('persists realized and unrealized components for a partial sell', async () => {
    mocks.query
      .mockResolvedValueOnce([
        {
          signal_id: 'signal-1',
          token_mint: 'solana:token-1',
          direction: 'buy',
          token_amount: '100',
          amount_usd: '100',
          price_usd: '1',
          fee_usd: '1'
        },
        {
          signal_id: 'signal-1',
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
          token_mint: 'polygon:token-2',
          direction: 'buy',
          token_amount: 10,
          amount_usd: 100,
          price_usd: 10
        },
        {
          signal_id: 'signal-2',
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
