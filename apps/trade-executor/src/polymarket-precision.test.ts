import { describe, it, expect, vi } from 'vitest';

// `polymarket.ts` constructs an ethers.Wallet at module scope, so this must be a
// well-formed 32-byte key. Deliberately a throwaway constant, never funded.
process.env.EVM_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
process.env.POLYMARKET_SIGNATURE_TYPE = 'EOA';
process.env.POLYMARKET_BUILDER_CODE = `0x${'a'.repeat(64)}`;

// `polymarket.js` reaches @swat/db, which opens a pool at import time. Stubbed
// as `polymarket.test.ts` does — `planPolymarketBookOrder` is pure and touches
// no database.
vi.mock('@swat/db', () => ({
  recordConfirmedPolymarketTrade: vi.fn(),
  getPolymarketOutcomeContext: vi.fn(),
  getPolymarketMarket: vi.fn(),
  listRedeemablePolymarketMarkets: vi.fn(),
  claimPolymarketRedemption: vi.fn(),
  confirmPolymarketRedemption: vi.fn(),
  failPolymarketRedemption: vi.fn(),
  releaseStalePolymarketRedemptionClaims: vi.fn(),
  query: vi.fn(),
  pool: {}
}));

const { planPolymarketBookOrder, POLYMARKET_SHARE_DECIMALS } = await import('./polymarket.js');

/**
 * Venue precision parity (checklist S3-19 / audit G3-P10).
 *
 * Pins our rounding against the published contract in `trading/place-orders`:
 *
 *   | Tick size | Price decimals | Size decimals | Amount decimals |
 *   | 0.1       | 1              | 2             | 3               |
 *   | 0.01      | 2              | 2             | 4               |
 *   | 0.005     | 3              | 2             | 5               |
 *   | 0.0025    | 4              | 2             | 6               |
 *   | 0.001     | 3              | 2             | 5               |
 *   | 0.0001    | 4              | 2             | 6               |
 *
 * **Size decimals are 2 for every tick size**, which is why a single
 * `POLYMARKET_SHARE_DECIMALS` constant is correct rather than a lookup table.
 *
 * We deliberately do *not* implement the price-decimals column. Instead the book
 * walk rejects any price off the current tick grid, which is strictly stronger:
 * a price on a `0.0025` grid can never exceed 4 decimals, and off-grid prices
 * with the "right" decimal count (0.0026 under a 0.0025 tick) are still refused.
 * The equivalence is proven exhaustively by the last test in this file, so the
 * stronger check cannot silently drift from the documented one.
 */

const DOCS_PRECISION = [
  { tickSize: '0.1', priceDecimals: 1 },
  { tickSize: '0.01', priceDecimals: 2 },
  { tickSize: '0.005', priceDecimals: 3 },
  { tickSize: '0.0025', priceDecimals: 4 },
  { tickSize: '0.001', priceDecimals: 3 },
  { tickSize: '0.0001', priceDecimals: 4 }
] as const;

function book(params: {
  tickSize: string;
  asks?: Array<{ price: string; size: string }>;
  bids?: Array<{ price: string; size: string }>;
  minimumShares?: string;
}) {
  return {
    conditionId: `0x${'1'.repeat(64)}`,
    tokenId: 'token-precision',
    timestamp: Date.now(),
    asks: params.asks ?? [],
    bids: params.bids ?? [],
    minOrderSize: params.minimumShares ?? '1',
    tickSize: params.tickSize,
    negRisk: false,
    hash: 'a'.repeat(40)
  } as Parameters<typeof planPolymarketBookOrder>[0];
}

function plan(bookInput: ReturnType<typeof book>, direction: 'buy' | 'sell', amount: number) {
  return planPolymarketBookOrder(bookInput, direction, amount, 5_000, Date.now());
}

describe('polymarket venue precision parity', () => {
  it.each(DOCS_PRECISION)(
    'accepts an on-grid price at tick $tickSize',
    ({ tickSize }) => {
      const tick = Number(tickSize);
      // Two ticks in, so the price is unambiguously on-grid and below 1.
      const price = (tick * 2).toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
      // Depth is priced in USD (size × price), so a fixed share count starves a
      // low-tick book: at tick 0.0001, 1000 shares at 0.0002 is $0.20. Size the
      // level to the notional under test instead.
      const size = String(Math.ceil(10 / (tick * 2)) * 2);
      const result = plan(
        book({ tickSize, asks: [{ price, size }] }),
        'buy',
        10
      );
      expect(result.estimatedShares).toBeGreaterThan(0);
    }
  );

  it.each(DOCS_PRECISION)(
    'rejects an off-grid price at tick $tickSize even when its decimal count looks legal',
    ({ tickSize, priceDecimals }) => {
      // Half a tick off. This has at most `priceDecimals + 1` decimals, so a
      // decimals-only check would wave some of these through; the CLOB would
      // then reject the order at submission.
      const offGrid = (Number(tickSize) * 2.5).toFixed(priceDecimals + 1);
      expect(() =>
        plan(book({ tickSize, asks: [{ price: offGrid, size: '1000' }] }), 'buy', 10)
      ).toThrow(/tick-size grid/);
    }
  );

  it('rounds shares DOWN to 2 decimals, never up', () => {
    // Rounding up would sell shares the position does not hold, or buy more
    // than the sized notional pays for.
    const result = plan(
      book({ tickSize: '0.01', asks: [{ price: '0.03', size: '1000' }] }),
      'buy',
      1
    );
    // 1 / 0.03 = 33.333…; floor at 2dp is 33.33.
    expect(result.estimatedShares).toBe(33.33);
    expect(POLYMARKET_SHARE_DECIMALS).toBe(2);
  });

  it('rejects an order that falls below the minimum after rounding', () => {
    // The rounding itself can push a marginal order under the venue floor, and
    // submitting it would be a guaranteed rejection.
    expect(() =>
      plan(
        book({ tickSize: '0.01', minimumShares: '5', asks: [{ price: '0.5', size: '1000' }] }),
        'buy',
        1
      )
    ).toThrow(/below the 5-share minimum/);
  });

  it('rejects a price at or above 1, which is not a valid outcome price', () => {
    expect(() =>
      plan(book({ tickSize: '0.01', asks: [{ price: '1', size: '10' }] }), 'buy', 1)
    ).toThrow(/invalid order-book price/);
  });

  it('proves tick-grid conformance implies the documented price decimals', () => {
    // The justification for not implementing the price-decimals column. If a
    // future tick size broke this, the stronger check would stop being a
    // superset and this test would catch it.
    for (const { tickSize, priceDecimals } of DOCS_PRECISION) {
      const tick = Number(tickSize);
      let maxDecimals = 0;
      for (let step = 1; step * tick < 1; step++) {
        const price = Number((step * tick).toFixed(10));
        const text = price.toString();
        const decimals = text.includes('.') ? text.split('.')[1]!.length : 0;
        if (decimals > maxDecimals) maxDecimals = decimals;
      }
      expect(
        maxDecimals,
        `at tick ${tickSize} exceeds ${priceDecimals} decimals`
      ).toBeLessThanOrEqual(priceDecimals);
    }
  }, 15_000);
});
