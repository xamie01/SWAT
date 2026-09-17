import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('./client.js', () => ({ query: mocks.query }));

import {
  fetchPolymarketBookSubscriptionCandidates,
  loadPolymarketBookSubscriptionSet,
  POLYMARKET_BOOK_ACTIVITY_WINDOW_MS,
  POLYMARKET_BOOK_MAX_SUBSCRIPTIONS,
  selectPolymarketBookSubscriptions,
  type PolymarketBookSubscriptionCandidate
} from './polymarket-book-subscriptions.js';

/**
 * Which Polymarket markets the book feed subscribes to (`S4-M38`).
 *
 * **What these tests can and cannot prove.** There is no database on this
 * branch, so nothing here executes SQL. `mocks.query` records the statement text
 * and the parameters, which pins the *contract* — the two sources, the polygon
 * predicate, the non-zero balance filter, the window parameter — and pins all of
 * the row-to-candidate mapping. It cannot prove the SQL runs, that the tables
 * carry these columns, or that the `UNION ALL` returns what the planner thinks.
 * That needs an integration run and has never happened.
 *
 * The eviction rule is where the consequence lives, so it carries most of the
 * assertions: dropping the *newest* market instead of the least active would
 * blind the capacity gate on exactly the market that just became tradeable.
 */

const NOW = new Date('2026-09-13T00:00:00.000Z');
const TOKEN_A = '71321045679252212594626385532706912750332728571942532289631379312455583992563';
const TOKEN_B = '21742633143463906290569050155826241533067272736897614950488156847949938836455';

function candidate(
  over: Partial<PolymarketBookSubscriptionCandidate> = {}
): PolymarketBookSubscriptionCandidate {
  return {
    tokenMint: `polygon:${TOKEN_A}`,
    lastActiveAt: NOW.getTime(),
    source: 'recent-trade',
    ...over
  };
}

beforeEach(() => {
  mocks.query.mockReset();
});

describe('selectPolymarketBookSubscriptions', () => {
  it('returns bare token ids, because that is what assets_ids speaks', () => {
    const set = selectPolymarketBookSubscriptions([candidate()]);
    expect(set.tokenIds).toEqual([TOKEN_A]);
  });

  it('accepts an already-bare token id unchanged', () => {
    const set = selectPolymarketBookSubscriptions([candidate({ tokenMint: TOKEN_A })]);
    expect(set.tokenIds).toEqual([TOKEN_A]);
  });

  it('dedupes a market that is both recently traded and held', () => {
    const set = selectPolymarketBookSubscriptions([
      candidate({ source: 'recent-trade', lastActiveAt: NOW.getTime() }),
      candidate({ source: 'open-position', lastActiveAt: NOW.getTime() - 90_000 })
    ]);

    expect(set.tokenIds).toEqual([TOKEN_A]);
    expect(set.tokenIds).toHaveLength(1);
  });

  it('keeps the most recent activity across sources regardless of row order', () => {
    const recent = NOW.getTime();
    const older = NOW.getTime() - 500_000;

    const positionFirst = selectPolymarketBookSubscriptions([
      candidate({ source: 'open-position', lastActiveAt: older }),
      candidate({ source: 'recent-trade', lastActiveAt: recent })
    ]);
    const tradeFirst = selectPolymarketBookSubscriptions([
      candidate({ source: 'recent-trade', lastActiveAt: recent }),
      candidate({ source: 'open-position', lastActiveAt: older })
    ]);

    // Both must attribute the token to the trade, not to whichever row the
    // UNION happened to emit second.
    expect(positionFirst.counts).toEqual({ recentTrade: 1, openPosition: 0 });
    expect(tradeFirst.counts).toEqual({ recentTrade: 1, openPosition: 0 });
  });

  it('orders by most recent activity first', () => {
    const set = selectPolymarketBookSubscriptions([
      candidate({ tokenMint: `polygon:${TOKEN_A}`, lastActiveAt: NOW.getTime() - 10_000 }),
      candidate({ tokenMint: `polygon:${TOKEN_B}`, lastActiveAt: NOW.getTime() })
    ]);

    expect(set.tokenIds).toEqual([TOKEN_B, TOKEN_A]);
  });

  it('evicts the LEAST recently active market, never the newest', () => {
    const stale = candidate({ tokenMint: 'polygon:stale', lastActiveAt: NOW.getTime() - 900_000 });
    const fresh = candidate({ tokenMint: 'polygon:fresh', lastActiveAt: NOW.getTime() });

    const set = selectPolymarketBookSubscriptions([stale, fresh], 1);

    // The whole point: a token nobody has traded for days has no imminent
    // fan-out to gate. Dropping `fresh` would blind the gate on the market that
    // just became active.
    expect(set.tokenIds).toEqual(['fresh']);
    expect(set.evicted).toBe(1);
  });

  it('reports how many candidates the cap excluded', () => {
    const candidates = Array.from({ length: 10 }, (_, index) =>
      candidate({ tokenMint: `polygon:token-${index}`, lastActiveAt: NOW.getTime() - index * 1_000 })
    );

    const set = selectPolymarketBookSubscriptions(candidates, 4);
    expect(set.tokenIds).toHaveLength(4);
    expect(set.evicted).toBe(6);
  });

  it('reports zero evictions when everything fits', () => {
    const set = selectPolymarketBookSubscriptions([candidate()], POLYMARKET_BOOK_MAX_SUBSCRIPTIONS);
    expect(set.evicted).toBe(0);
  });

  it('counts evictions after dedupe, not before', () => {
    // Three rows, two distinct tokens, cap of 2: nothing is actually dropped.
    const set = selectPolymarketBookSubscriptions(
      [
        candidate({ tokenMint: `polygon:${TOKEN_A}`, source: 'recent-trade' }),
        candidate({ tokenMint: `polygon:${TOKEN_A}`, source: 'open-position' }),
        candidate({ tokenMint: `polygon:${TOKEN_B}` })
      ],
      2
    );

    expect(set.tokenIds).toHaveLength(2);
    expect(set.evicted).toBe(0);
  });

  it('breaks recency ties deterministically so the tail does not churn on restart', () => {
    const tied = [
      candidate({ tokenMint: 'polygon:zzz', lastActiveAt: NOW.getTime() }),
      candidate({ tokenMint: 'polygon:aaa', lastActiveAt: NOW.getTime() }),
      candidate({ tokenMint: 'polygon:mmm', lastActiveAt: NOW.getTime() })
    ];

    const first = selectPolymarketBookSubscriptions(tied, 2);
    const shuffled = selectPolymarketBookSubscriptions([tied[2]!, tied[0]!, tied[1]!], 2);

    expect(first.tokenIds).toEqual(['aaa', 'mmm']);
    expect(shuffled.tokenIds).toEqual(first.tokenIds);
  });

  it('splits the counts by source', () => {
    const set = selectPolymarketBookSubscriptions([
      candidate({ tokenMint: 'polygon:a', source: 'recent-trade' }),
      candidate({ tokenMint: 'polygon:b', source: 'open-position' }),
      candidate({ tokenMint: 'polygon:c', source: 'open-position' })
    ]);

    expect(set.counts).toEqual({ recentTrade: 1, openPosition: 2 });
  });

  it('drops a row whose token id is empty rather than subscribing to nothing', () => {
    const set = selectPolymarketBookSubscriptions([
      candidate({ tokenMint: 'polygon:' }),
      candidate({ tokenMint: `polygon:${TOKEN_A}` })
    ]);

    expect(set.tokenIds).toEqual([TOKEN_A]);
  });

  it('handles an empty candidate list', () => {
    const set = selectPolymarketBookSubscriptions([]);
    expect(set.tokenIds).toEqual([]);
    expect(set.evicted).toBe(0);
    expect(set.counts).toEqual({ recentTrade: 0, openPosition: 0 });
  });

  it('treats a zero or negative cap as subscribing to nothing, not as unlimited', () => {
    // The fail-closed direction: a misconfigured cap must lose books, which
    // reads as capacity-unknown, rather than silently uncapping the feed.
    expect(selectPolymarketBookSubscriptions([candidate()], 0).tokenIds).toEqual([]);
    expect(selectPolymarketBookSubscriptions([candidate()], -5).tokenIds).toEqual([]);
    expect(selectPolymarketBookSubscriptions([candidate()], 0).evicted).toBe(1);
  });

  it('floors a fractional cap rather than admitting a partial market', () => {
    const candidates = [
      candidate({ tokenMint: 'polygon:a', lastActiveAt: NOW.getTime() }),
      candidate({ tokenMint: 'polygon:b', lastActiveAt: NOW.getTime() - 1_000 })
    ];
    expect(selectPolymarketBookSubscriptions(candidates, 1.9).tokenIds).toEqual(['a']);
  });

  it('keeps the default cap within the documented POST /books batch arithmetic', () => {
    // 500 ids per request is the documented ceiling, so the default must be a
    // small whole number of requests per resync cycle.
    expect(POLYMARKET_BOOK_MAX_SUBSCRIPTIONS % 500).toBe(0);
    expect(POLYMARKET_BOOK_MAX_SUBSCRIPTIONS / 500).toBeLessThanOrEqual(4);
  });
});

describe('fetchPolymarketBookSubscriptionCandidates', () => {
  it('reads both sources in one round trip', async () => {
    mocks.query.mockResolvedValue([]);
    await fetchPolymarketBookSubscriptionCandidates({ now: NOW });

    expect(mocks.query).toHaveBeenCalledTimes(1);
    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql).toContain('source_trades');
    expect(sql).toContain('wallet_positions');
    expect(sql).toContain('UNION ALL');
  });

  it('restricts both sources to polygon', async () => {
    mocks.query.mockResolvedValue([]);
    await fetchPolymarketBookSubscriptionCandidates({ now: NOW });

    const sql = String(mocks.query.mock.calls[0]?.[0]);
    expect(sql.match(/chain = 'polygon'/g)).toHaveLength(2);
  });

  it('only counts positions somebody still holds', async () => {
    mocks.query.mockResolvedValue([]);
    await fetchPolymarketBookSubscriptionCandidates({ now: NOW });

    // A closed position needs no book: there is nothing left to exit.
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('balance > 0');
  });

  it('passes the activity window as a bound parameter', async () => {
    mocks.query.mockResolvedValue([]);
    await fetchPolymarketBookSubscriptionCandidates({ now: NOW });

    const [, params] = mocks.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toHaveLength(1);
    expect((params[0] as Date).getTime()).toBe(NOW.getTime() - POLYMARKET_BOOK_ACTIVITY_WINDOW_MS);
  });

  it('honours an explicit window override', async () => {
    mocks.query.mockResolvedValue([]);
    await fetchPolymarketBookSubscriptionCandidates({ now: NOW, activityWindowMs: 60_000 });

    const [, params] = mocks.query.mock.calls[0] as unknown as [string, unknown[]];
    expect((params[0] as Date).getTime()).toBe(NOW.getTime() - 60_000);
  });

  it('maps rows to candidates, parsing the timestamp', async () => {
    mocks.query.mockResolvedValue([
      { token_mint: `polygon:${TOKEN_A}`, last_active_at: NOW, source: 'recent-trade' },
      { token_mint: `polygon:${TOKEN_B}`, last_active_at: NOW.toISOString(), source: 'open-position' }
    ]);

    const candidates = await fetchPolymarketBookSubscriptionCandidates({ now: NOW });

    expect(candidates).toEqual([
      { tokenMint: `polygon:${TOKEN_A}`, lastActiveAt: NOW.getTime(), source: 'recent-trade' },
      { tokenMint: `polygon:${TOKEN_B}`, lastActiveAt: NOW.getTime(), source: 'open-position' }
    ]);
  });

  it('maps any unrecognised source label to recent-trade rather than throwing', async () => {
    mocks.query.mockResolvedValue([
      { token_mint: `polygon:${TOKEN_A}`, last_active_at: NOW, source: 'something-new' }
    ]);

    const candidates = await fetchPolymarketBookSubscriptionCandidates({ now: NOW });
    expect(candidates[0]?.source).toBe('recent-trade');
  });
});

describe('loadPolymarketBookSubscriptionSet', () => {
  it('reads then decides', async () => {
    mocks.query.mockResolvedValue([
      { token_mint: `polygon:${TOKEN_A}`, last_active_at: NOW, source: 'recent-trade' },
      { token_mint: `polygon:${TOKEN_B}`, last_active_at: new Date(NOW.getTime() - 1_000), source: 'open-position' }
    ]);

    const set = await loadPolymarketBookSubscriptionSet({ now: NOW });

    expect(set.tokenIds).toEqual([TOKEN_A, TOKEN_B]);
    expect(set.counts).toEqual({ recentTrade: 1, openPosition: 1 });
  });

  it('applies an explicit cap', async () => {
    mocks.query.mockResolvedValue([
      { token_mint: 'polygon:a', last_active_at: NOW, source: 'recent-trade' },
      { token_mint: 'polygon:b', last_active_at: new Date(NOW.getTime() - 1_000), source: 'recent-trade' }
    ]);

    const set = await loadPolymarketBookSubscriptionSet({ now: NOW, maxSubscriptions: 1 });
    expect(set.tokenIds).toEqual(['a']);
    expect(set.evicted).toBe(1);
  });

  it('returns an empty set rather than throwing when the read fails', async () => {
    mocks.query.mockRejectedValue(new Error('relation "source_trades" does not exist'));
    const onFailure = vi.fn();

    const set = await loadPolymarketBookSubscriptionSet({ now: NOW, onFailure });

    // An indexer that refuses to boot over one seed query would stop ingesting
    // every chain. An empty seed only costs Polymarket depth, which the capacity
    // gate already handles by admitting nobody.
    expect(set).toEqual({ tokenIds: [], evicted: 0, counts: { recentTrade: 0, openPosition: 0 } });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(String(onFailure.mock.calls[0]?.[0])).toContain('capacity-unknown');
  });

  it('does not require a failure handler', async () => {
    mocks.query.mockRejectedValue(new Error('down'));
    await expect(loadPolymarketBookSubscriptionSet({ now: NOW })).resolves.toEqual({
      tokenIds: [],
      evicted: 0,
      counts: { recentTrade: 0, openPosition: 0 }
    });
  });
});
