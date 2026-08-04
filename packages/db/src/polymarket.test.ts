import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool, query } from './client.js';
import {
  getPolymarketOutcomeContext,
  recordConfirmedPolymarketTrade,
  upsertPolymarketContext
} from './polymarket.js';

vi.mock('./client.js', () => ({
  pool: { connect: vi.fn() },
  query: vi.fn()
}));

const CONDITION_ID = `0x${'a'.repeat(64)}`;
const TOKEN_YES = '1234567890123456789012345678901234567890';
const TOKEN_NO = '9876543210987654321098765432109876543210';
const PROXY_WALLET = `0x${'b'.repeat(40)}`;
const TRANSACTION_HASH = `0x${'c'.repeat(64)}`;

describe('Polymarket database context', () => {
  const client = {
    query: vi.fn(async () => ({ rows: [] })),
    release: vi.fn(),
    // withTransaction attaches an 'error' listener to the checked-out client;
    // a real PoolClient is an EventEmitter.
    on: vi.fn(),
    off: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    client.query.mockResolvedValue({ rows: [] });
    vi.mocked(pool.connect).mockResolvedValue(client as never);
  });

  it('persists complete market context and exact outcome-token mappings transactionally', async () => {
    await upsertPolymarketContext({
      conditionId: CONDITION_ID.toUpperCase(),
      question: 'Will the fixture pass?',
      slug: 'fixture-pass',
      endDate: new Date('2026-08-01T00:00:00Z'),
      resolutionSource: 'Fixture oracle',
      outcomeCount: 2,
      clobTokenIds: [TOKEN_YES, TOKEN_NO],
      status: 'active',
      tickSize: '0.01',
      negRisk: false,
      acceptingOrders: true,
      resolutionStatus: 'unresolved',
      outcomes: [
        { tokenId: TOKEN_YES, outcome: 'Yes', outcomeIndex: 0 },
        { tokenId: TOKEN_NO, outcome: 'No', outcomeIndex: 1 }
      ]
    });

    expect(client.query.mock.calls[0]?.[0]).toBe('BEGIN');
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    const marketCall = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO polymarket_markets'));
    expect(marketCall?.[1]).toEqual(expect.arrayContaining([
      CONDITION_ID,
      JSON.stringify([`polygon:${TOKEN_YES}`, `polygon:${TOKEN_NO}`]),
      0.01,
      false,
      true,
      'unresolved'
    ]));
    const outcomeCalls = client.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO polymarket_outcomes'));
    expect(outcomeCalls.map(([, params]) => params)).toEqual([
      [`polygon:${TOKEN_YES}`, CONDITION_ID, 'Yes', 0],
      [`polygon:${TOKEN_NO}`, CONDITION_ID, 'No', 1]
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('loads context by full token ID instead of outcome symbol', async () => {
    vi.mocked(query).mockResolvedValue([{
      token_id: `polygon:${TOKEN_YES}`,
      condition_id: CONDITION_ID,
      outcome: 'Yes - exact full outcome label',
      outcome_index: 0,
      question: 'Will the fixture pass?',
      slug: 'fixture-pass',
      end_date: new Date('2026-08-01T00:00:00Z'),
      market_status: 'active',
      tick_size: '0.01',
      neg_risk: false,
      accepting_orders: true,
      resolution_status: 'unresolved',
      context_complete: true
    }]);

    const context = await getPolymarketOutcomeContext(TOKEN_YES);

    expect(context?.outcome).toBe('Yes - exact full outcome label');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE o.token_id = $1'),
      [`polygon:${TOKEN_YES}`]
    );
  });

  it('records the confirmed source trade with canonical proxy and asset identities', async () => {
    vi.mocked(query).mockResolvedValue([{ id: '1' }]);

    await expect(recordConfirmedPolymarketTrade({
      transactionHash: TRANSACTION_HASH.toUpperCase(),
      proxyWallet: PROXY_WALLET.toUpperCase(),
      asset: TOKEN_YES,
      conditionId: CONDITION_ID.toUpperCase(),
      side: 'BUY',
      size: '12.5',
      price: '0.64',
      timestamp: new Date('2024-06-26T10:25:00Z')
    })).resolves.toBe(true);

    const params = vi.mocked(query).mock.calls[0]?.[1];
    expect(params).toEqual([
      TRANSACTION_HASH,
      `polygon:${PROXY_WALLET}`,
      `polygon:${TOKEN_YES}`,
      CONDITION_ID,
      'BUY',
      '12.5',
      '0.64',
      new Date('2024-06-26T10:25:00Z')
    ]);
  });
});
