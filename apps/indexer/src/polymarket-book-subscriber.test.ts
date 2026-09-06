import { describe, expect, it } from 'vitest';
import {
  assessPolymarketBookDepth,
  POLYMARKET_BOOK_MAX_AGE_MS,
  POLYMARKET_BOOK_RESYNC_INTERVAL_MS
} from '@swat/shared';
import {
  applyPolymarketBookMessage,
  assertPolymarketBookResyncBudget,
  chunkPolymarketBookBatch,
  createPolymarketBookSubscriber,
  createPolymarketBookSubscriberState,
  invalidateAllPolymarketBooks,
  parsePolymarketMarketMessage,
  polymarketBooksDueForResync,
  polymarketMarketSubscribeFrame,
  PolymarketBookSubscriberConfigError,
  POLYMARKET_BOOKS_MAX_BATCH,
  type PolymarketBookSubscriberState,
  type PolymarketBookTransport,
  type PolymarketBookTransportHandlers
} from './polymarket-book-subscriber.js';

const TOKEN = '107505882767731489358349912513945399560393482969656700824895970500493757150417';
const OTHER = '7305630249804085635496399869905769372294302716159034447326228509068694952392';
const MARKET = '0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75';

/**
 * One timeline for the whole suite.
 *
 * The depth reader refuses a venue timestamp more than
 * `POLYMARKET_BOOK_CLOCK_SKEW_ALLOWANCE_MS` ahead of `now`, so a fixture stamped
 * with the docs' example epoch while the fake clock reads `1000` is not a book at
 * all -- it is `book-clock-implausible`. Every timestamp below is an offset from
 * this base, and so is every `now`.
 */
const BASE = 1_782_753_357_257;
/** `now` values, as offsets from BASE, to keep the arithmetic readable. */
const T = (offsetMs: number) => BASE + offsetMs;

/** A `book` frame in the raw market-channel dialect the docs publish. */
function bookFrame(overrides: {
  readonly assetId?: string;
  readonly timestamp?: string | null;
  readonly bids?: readonly { price: string; size: string }[];
  readonly asks?: readonly { price: string; size: string }[];
} = {}) {
  return {
    event_type: 'book',
    market: MARKET,
    asset_id: overrides.assetId ?? TOKEN,
    timestamp: overrides.timestamp === undefined ? String(BASE) : overrides.timestamp,
    hash: '0xabc123',
    bids: overrides.bids ?? [{ price: '0.40', size: '1000' }, { price: '0.39', size: '2000' }],
    asks: overrides.asks ?? [{ price: '0.42', size: '1500' }, { price: '0.43', size: '2500' }]
  };
}

/** A `price_change` frame in the raw dialect. */
function priceChangeFrame(input: {
  readonly assetId?: string;
  readonly price: string;
  readonly size: string;
  readonly side: 'BUY' | 'SELL';
  readonly timestamp?: string | null;
}) {
  return {
    event_type: 'price_change',
    market: MARKET,
    price_changes: [
      {
        asset_id: input.assetId ?? TOKEN,
        price: input.price,
        size: input.size,
        side: input.side,
        hash: '56621a121a47ed9333273e21c83b660cff37ae50',
        best_bid: '0.40',
        best_ask: '0.42'
      }
    ],
    timestamp: input.timestamp === undefined ? String(BASE) : input.timestamp
  };
}

function snapshotted(now = 1_000): PolymarketBookSubscriberState {
  const state = createPolymarketBookSubscriberState([TOKEN]);
  return applyPolymarketBookMessage(state, { raw: bookFrame(), now }).state;
}

function bidPrices(state: PolymarketBookSubscriberState, token = TOKEN): number[] {
  const entry = state.books.get(token);
  if (entry === undefined || entry.status !== 'book') throw new Error('expected a snapshotted book');
  return [...entry.ladders.bids].map((level) => level.price).sort((a, b) => b - a);
}

/** A fake transport. No socket, no network: the test pushes frames in by hand. */
function fakeTransport() {
  const sent: string[] = [];
  let handlers: PolymarketBookTransportHandlers | null = null;
  let closed = false;
  const factory = (given: PolymarketBookTransportHandlers): PolymarketBookTransport => {
    handlers = given;
    return {
      send: (frame: string) => sent.push(frame),
      close: () => {
        closed = true;
      }
    };
  };
  return {
    factory,
    sent,
    isClosed: () => closed,
    handlers: () => {
      if (handlers === null) throw new Error('transport was never created');
      return handlers;
    }
  };
}

describe('parsePolymarketMarketMessage', () => {
  it('parses a raw-dialect book frame into a snapshot', () => {
    const message = parsePolymarketMarketMessage(bookFrame());
    expect(message.kind).toBe('snapshot');
    if (message.kind !== 'snapshot') throw new Error('unreachable');
    expect(message.tokenId).toBe(TOKEN);
    expect(message.bids).toHaveLength(2);
    expect(message.venueTimestamp).toBe(BASE);
  });

  it('parses the SDK-dialect book event, payload and camelCase included', () => {
    const message = parsePolymarketMarketMessage({
      topic: 'market',
      type: 'book',
      payload: {
        market: MARKET,
        tokenId: TOKEN,
        bids: [{ price: '0.08', size: '33343.4' }],
        asks: [{ price: '0.09', size: '163939.58' }],
        hash: '0xabc123',
        timestamp: String(BASE),
        tickSize: '0.01',
        minOrderSize: '5'
      }
    });
    expect(message.kind).toBe('snapshot');
    if (message.kind !== 'snapshot') throw new Error('unreachable');
    expect(message.tokenId).toBe(TOKEN);
    expect(message.tickSize).toBe(0.01);
    expect(message.minOrderSize).toBe(5);
  });

  it('drops zero-size levels from a snapshot rather than storing a deletion', () => {
    const message = parsePolymarketMarketMessage(
      bookFrame({ bids: [{ price: '0.40', size: '0' }, { price: '0.39', size: '10' }] })
    );
    if (message.kind !== 'snapshot') throw new Error('expected a snapshot');
    expect(message.bids).toEqual([{ price: 0.39, size: 10 }]);
  });

  it('parses a multi-token price_change frame', () => {
    const message = parsePolymarketMarketMessage({
      event_type: 'price_change',
      market: MARKET,
      price_changes: [
        { asset_id: TOKEN, price: '0.41', size: '5', side: 'BUY' },
        { asset_id: OTHER, price: '0.55', size: '7', side: 'SELL' }
      ],
      timestamp: String(BASE + 1)
    });
    expect(message.kind).toBe('delta');
    if (message.kind !== 'delta') throw new Error('unreachable');
    expect(message.changes.map((change) => change.tokenId)).toEqual([TOKEN, OTHER]);
  });

  it('reports an unrecognised event type as inert rather than guessing', () => {
    const message = parsePolymarketMarketMessage({ event_type: 'something_new_2027' });
    expect(message).toEqual({ kind: 'inert', eventType: 'something_new_2027', recognised: false });
  });

  it('reports documented non-depth events as recognised-inert', () => {
    for (const eventType of ['best_bid_ask', 'last_trade_price', 'new_market']) {
      const message = parsePolymarketMarketMessage({ event_type: eventType });
      expect(message).toEqual({ kind: 'inert', eventType, recognised: true });
    }
  });

  it('refuses a book frame with an unreadable level instead of dropping it', () => {
    const message = parsePolymarketMarketMessage(
      bookFrame({ bids: [{ price: 'not-a-price', size: '10' }] })
    );
    expect(message.kind).toBe('malformed');
  });

  it('refuses a frame that is not JSON', () => {
    expect(parsePolymarketMarketMessage('{oops').kind).toBe('malformed');
  });
});

describe('snapshot transition', () => {
  it('applies a snapshot and stamps observedAt from our clock, not the venue', () => {
    const result = applyPolymarketBookMessage(createPolymarketBookSubscriberState([TOKEN]), {
      raw: bookFrame(),
      now: T(5_000)
    });
    expect(result.codes).toEqual(['applied-snapshot']);
    const entry = result.state.books.get(TOKEN);
    if (entry === undefined || entry.status !== 'book') throw new Error('expected a book');
    expect(entry.observedAt).toBe(T(5_000));
    expect(entry.venueTimestamp).toBe(BASE);
  });

  it('produces an entry the depth reader can price', () => {
    const state = snapshotted(T(10_000));
    const verdict = assessPolymarketBookDepth(
      { get: (token) => state.books.get(token) },
      { tokenMint: `polygon:${TOKEN}`, cohortDirection: 'buy', impactCapBps: 100, now: T(10_500) }
    );
    expect(verdict.outcome).toBe('assessed');
    expect(verdict.depth?.bestPrice).toBe(0.42);
  });

  it('never creates an entry for an untracked token', () => {
    const result = applyPolymarketBookMessage(createPolymarketBookSubscriberState([OTHER]), {
      raw: bookFrame(),
      now: T(1_000)
    });
    expect(result.codes).toEqual(['ignored-untracked-token']);
    expect(result.state.books.has(TOKEN)).toBe(false);
  });

  it('leaves a known-good book intact when a malformed frame arrives', () => {
    const state = snapshotted(T(1_000));
    const result = applyPolymarketBookMessage(state, { raw: '{not json', now: T(2_000) });
    expect(result.codes).toEqual(['refused-malformed-frame']);
    const entry = result.state.books.get(TOKEN);
    expect(entry?.status).toBe('book');
  });
});

describe('delta transition', () => {
  it('replaces a level on the bid side and leaves observedAt on the snapshot clock', () => {
    const state = snapshotted(T(1_000));
    const result = applyPolymarketBookMessage(state, {
      raw: priceChangeFrame({ price: '0.40', size: '99', side: 'BUY', timestamp: String(BASE + 1) }),
      now: T(4_000)
    });
    expect(result.codes).toEqual(['applied-delta']);
    const entry = result.state.books.get(TOKEN);
    if (entry === undefined || entry.status !== 'book') throw new Error('expected a book');
    expect(entry.ladders.bids).toEqual(
      expect.arrayContaining([{ price: 0.4, size: 99 }, { price: 0.39, size: 2000 }])
    );
    // A delta refines a snapshot; it does not re-observe the book. If it advanced
    // observedAt, a delta stream would keep a drifting ladder readable forever.
    expect(entry.observedAt).toBe(T(1_000));
  });

  it('deletes a level when the delta carries size zero', () => {
    const state = snapshotted(T(1_000));
    const result = applyPolymarketBookMessage(state, {
      raw: priceChangeFrame({ price: '0.40', size: '0', side: 'BUY', timestamp: String(BASE + 1) }),
      now: T(2_000)
    });
    expect(bidPrices(result.state)).toEqual([0.39]);
  });

  it('discards a delta that arrives before any snapshot and keeps depth unknown', () => {
    const state = createPolymarketBookSubscriberState([TOKEN]);
    const result = applyPolymarketBookMessage(state, {
      raw: priceChangeFrame({ price: '0.40', size: '99', side: 'BUY' }),
      now: T(3_000)
    });
    expect(result.codes).toEqual(['resync-delta-before-snapshot']);
    const entry = result.state.books.get(TOKEN);
    expect(entry?.status).toBe('awaiting-snapshot');
    // Structural, not a convention: the awaiting-snapshot variant has no ladder.
    expect(entry === undefined ? true : !('ladders' in entry)).toBe(true);
  });

  it('reads as unknown, not as a thin book, when a deletion precedes the snapshot', () => {
    // The exact failure the discard exists to prevent: an empty ladder plus a
    // deletion is a valid-looking thin book, i.e. a number.
    const state = createPolymarketBookSubscriberState([TOKEN]);
    const result = applyPolymarketBookMessage(state, {
      raw: priceChangeFrame({ price: '0.40', size: '0', side: 'BUY' }),
      now: T(3_000)
    });
    const verdict = assessPolymarketBookDepth(
      { get: (token) => result.state.books.get(token) },
      { tokenMint: `polygon:${TOKEN}`, cohortDirection: 'buy', impactCapBps: 100, now: T(3_100) }
    );
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.unknownCode).toBe('book-awaiting-snapshot');
    expect(verdict.liquidity.usableLiquidityUsd).toBeNull();
  });

  it('never applies a delta to a book that is awaiting a snapshot', () => {
    const disconnected = invalidateAllPolymarketBooks(snapshotted(T(1_000)), T(2_000)).state;
    const result = applyPolymarketBookMessage(disconnected, {
      raw: priceChangeFrame({ price: '0.40', size: '99', side: 'BUY' }),
      now: T(3_000)
    });
    expect(result.codes).toEqual(['resync-delta-before-snapshot']);
    expect(result.state.books.get(TOKEN)?.status).toBe('awaiting-snapshot');
  });

  it('forces a resync on an out-of-order delta rather than patching the book', () => {
    const state = snapshotted(T(1_000));
    const result = applyPolymarketBookMessage(state, {
      // Stamped before the snapshot it would patch.
      raw: priceChangeFrame({ price: '0.40', size: '99', side: 'BUY', timestamp: String(BASE - 257) }),
      now: T(2_000)
    });
    expect(result.codes).toEqual(['resync-delta-out-of-order']);
    expect(result.state.books.get(TOKEN)?.status).toBe('awaiting-snapshot');
    expect(result.invalidated).toEqual([TOKEN]);
  });

  it('does not carry the pre-gap ladder past an out-of-order delta', () => {
    const state = snapshotted(T(1_000));
    const gapped = applyPolymarketBookMessage(state, {
      raw: priceChangeFrame({ price: '0.40', size: '99', side: 'BUY', timestamp: String(BASE - 257) }),
      now: T(2_000)
    }).state;
    const verdict = assessPolymarketBookDepth(
      { get: (token) => gapped.books.get(token) },
      { tokenMint: `polygon:${TOKEN}`, cohortDirection: 'buy', impactCapBps: 100, now: T(2_100) }
    );
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.depth).toBeNull();
  });

  it('accepts a delta stamped at the same millisecond as the applied state', () => {
    const state = snapshotted(T(1_000));
    const result = applyPolymarketBookMessage(state, {
      raw: priceChangeFrame({ price: '0.40', size: '99', side: 'BUY', timestamp: String(BASE) }),
      now: T(2_000)
    });
    expect(result.codes).toEqual(['applied-delta']);
  });

  it('treats a timestamp-free delta as unorderable under the default policy', () => {
    const state = snapshotted(T(1_000));
    const result = applyPolymarketBookMessage(state, {
      raw: priceChangeFrame({ price: '0.40', size: '99', side: 'BUY', timestamp: null }),
      now: T(2_000)
    });
    expect(result.codes).toEqual(['resync-delta-unorderable']);
    expect(result.state.books.get(TOKEN)?.status).toBe('awaiting-snapshot');
  });

  it("applies a timestamp-free delta under deltaPolicy 'apply-always'", () => {
    const state = snapshotted(T(1_000));
    const result = applyPolymarketBookMessage(state, {
      raw: priceChangeFrame({ price: '0.40', size: '99', side: 'BUY', timestamp: null }),
      now: T(2_000),
      deltaPolicy: 'apply-always'
    });
    expect(result.codes).toEqual(['applied-delta']);
  });

  it("forces a resync on every delta under deltaPolicy 'never'", () => {
    const state = snapshotted(T(1_000));
    const result = applyPolymarketBookMessage(state, {
      raw: priceChangeFrame({ price: '0.40', size: '99', side: 'BUY', timestamp: String(BASE + 1) }),
      now: T(2_000),
      deltaPolicy: 'never'
    });
    expect(result.codes).toEqual(['resync-delta-policy']);
    expect(result.state.books.get(TOKEN)?.status).toBe('awaiting-snapshot');
  });

  it('invalidates only the gapped token when one frame carries several', () => {
    let state = createPolymarketBookSubscriberState([TOKEN, OTHER]);
    state = applyPolymarketBookMessage(state, { raw: bookFrame(), now: T(1_000) }).state;
    state = applyPolymarketBookMessage(state, {
      raw: bookFrame({ assetId: OTHER }),
      now: T(1_000)
    }).state;
    const result = applyPolymarketBookMessage(state, {
      raw: {
        event_type: 'price_change',
        market: MARKET,
        price_changes: [
          { asset_id: TOKEN, price: '0.40', size: '1', side: 'BUY' },
          { asset_id: OTHER, price: '0.40', size: '1', side: 'BUY' }
        ],
        // One shared frame timestamp, older than both applied snapshots.
        timestamp: String(BASE - 257)
      },
      now: T(2_000)
    });
    expect(result.invalidated.sort()).toEqual([TOKEN, OTHER].sort());
    // And the same frame with a forward timestamp touches both books instead.
    const forward = applyPolymarketBookMessage(state, {
      raw: {
        event_type: 'price_change',
        market: MARKET,
        price_changes: [{ asset_id: TOKEN, price: '0.40', size: '1', side: 'BUY' }],
        timestamp: String(BASE + 742)
      },
      now: T(2_000)
    });
    expect(forward.invalidated).toEqual([]);
    expect(forward.state.books.get(OTHER)?.status).toBe('book');
  });

  it('ignores a delta for a token it does not track', () => {
    const result = applyPolymarketBookMessage(snapshotted(T(1_000)), {
      raw: priceChangeFrame({ assetId: OTHER, price: '0.40', size: '1', side: 'BUY' }),
      now: T(2_000)
    });
    expect(result.codes).toEqual(['ignored-untracked-token']);
    expect(result.state.books.has(OTHER)).toBe(false);
  });
});

describe('disconnect and cold start', () => {
  it('makes every tracked book unknown on disconnect and carries no ladder across', () => {
    const state = snapshotted(T(1_000));
    const result = invalidateAllPolymarketBooks(state, T(9_000));
    expect(result.codes).toEqual(['resync-transport-disconnected']);
    const entry = result.state.books.get(TOKEN);
    if (entry === undefined || entry.status !== 'awaiting-snapshot') {
      throw new Error('expected awaiting-snapshot');
    }
    expect(entry.since).toBe(T(9_000));
    expect('ladders' in entry).toBe(false);
    expect(result.state.connected).toBe(false);
  });

  it('reads as book-awaiting-snapshot after a disconnect, not as the last ladder', () => {
    const disconnected = invalidateAllPolymarketBooks(snapshotted(T(1_000)), T(9_000)).state;
    const verdict = assessPolymarketBookDepth(
      { get: (token) => disconnected.books.get(token) },
      { tokenMint: `polygon:${TOKEN}`, cohortDirection: 'buy', impactCapBps: 100, now: T(9_100) }
    );
    expect(verdict.unknownCode).toBe('book-awaiting-snapshot');
    expect(verdict.depth).toBeNull();
    expect(verdict.liquidity.basis).toBe('unknown');
  });

  it('distinguishes a cold start from a disconnect by code', () => {
    const cold = createPolymarketBookSubscriberState([TOKEN]);
    const coldVerdict = assessPolymarketBookDepth(
      { get: (token) => cold.books.get(token) },
      { tokenMint: `polygon:${TOKEN}`, cohortDirection: 'buy', impactCapBps: 100, now: T(1_000) }
    );
    expect(coldVerdict.unknownCode).toBe('book-not-cached');

    const dropped = invalidateAllPolymarketBooks(snapshotted(T(1_000)), T(2_000)).state;
    const droppedVerdict = assessPolymarketBookDepth(
      { get: (token) => dropped.books.get(token) },
      { tokenMint: `polygon:${TOKEN}`, cohortDirection: 'buy', impactCapBps: 100, now: T(2_100) }
    );
    expect(droppedVerdict.unknownCode).toBe('book-awaiting-snapshot');
    expect(coldVerdict.unknownCode).not.toBe(droppedVerdict.unknownCode);
  });

  it('clears the ordering watermark on invalidation so the next snapshot is accepted', () => {
    const state = snapshotted(T(1_000));
    expect(state.lastVenueTimestamp.get(TOKEN)).toBe(BASE);
    const dropped = invalidateAllPolymarketBooks(state, T(2_000)).state;
    expect(dropped.lastVenueTimestamp.has(TOKEN)).toBe(false);
    const resnapped = applyPolymarketBookMessage(dropped, {
      raw: bookFrame({ timestamp: String(BASE - 7_257) }),
      now: T(3_000)
    });
    expect(resnapped.codes).toEqual(['applied-snapshot']);
  });

  it('invalidates a held book even when it is no longer tracked', () => {
    const state = snapshotted(T(1_000));
    const untracked: PolymarketBookSubscriberState = { ...state, tracked: new Set() };
    const result = invalidateAllPolymarketBooks(untracked, T(5_000));
    expect(result.state.books.get(TOKEN)?.status).toBe('awaiting-snapshot');
  });
});

describe('market lifecycle events', () => {
  it('invalidates the books of a resolved market', () => {
    let state = createPolymarketBookSubscriberState([TOKEN, OTHER]);
    state = applyPolymarketBookMessage(state, { raw: bookFrame(), now: T(1_000) }).state;
    state = applyPolymarketBookMessage(state, {
      raw: bookFrame({ assetId: OTHER }),
      now: T(1_000)
    }).state;
    const result = applyPolymarketBookMessage(state, {
      raw: {
        event_type: 'market_resolved',
        id: '123456',
        market: MARKET,
        assets_ids: [TOKEN, OTHER],
        winning_asset_id: TOKEN,
        timestamp: String(BASE)
      },
      now: T(6_000)
    });
    expect(result.codes).toEqual(['resync-market-resolved', 'resync-market-resolved']);
    expect(result.state.books.get(TOKEN)?.status).toBe('awaiting-snapshot');
    expect(result.state.books.get(OTHER)?.status).toBe('awaiting-snapshot');
  });

  it('records a tick size change on a snapshotted book without touching depth', () => {
    const state = snapshotted(T(1_000));
    const result = applyPolymarketBookMessage(state, {
      raw: {
        event_type: 'tick_size_change',
        market: MARKET,
        asset_id: TOKEN,
        old_tick_size: '0.01',
        new_tick_size: '0.001',
        timestamp: String(BASE + 1)
      },
      now: T(2_000)
    });
    expect(result.codes).toEqual(['applied-tick-size']);
    const entry = result.state.books.get(TOKEN);
    if (entry === undefined || entry.status !== 'book') throw new Error('expected a book');
    expect(entry.tickSize).toBe(0.001);
    expect(entry.observedAt).toBe(T(1_000));
    expect(bidPrices(result.state)).toEqual([0.4, 0.39]);
  });

  it('does not invent an entry for a tick size change with no book', () => {
    const result = applyPolymarketBookMessage(createPolymarketBookSubscriberState([TOKEN]), {
      raw: {
        event_type: 'tick_size_change',
        market: MARKET,
        asset_id: TOKEN,
        new_tick_size: '0.001'
      },
      now: T(2_000)
    });
    expect(result.codes).toEqual(['ignored-tick-size-without-book']);
    expect(result.state.books.has(TOKEN)).toBe(false);
  });

  it('leaves depth untouched for documented non-depth events', () => {
    const state = snapshotted(T(1_000));
    for (const raw of [
      { event_type: 'best_bid_ask', asset_id: TOKEN, best_bid: '0.9', best_ask: '0.95' },
      { event_type: 'last_trade_price', asset_id: TOKEN, price: '0.9', side: 'SELL' },
      { event_type: 'new_market', market: MARKET, assets_ids: [TOKEN] }
    ]) {
      const result = applyPolymarketBookMessage(state, { raw, now: T(2_000) });
      expect(result.codes).toEqual(['ignored-non-depth-event']);
      expect(bidPrices(result.state)).toEqual([0.4, 0.39]);
    }
  });
});

describe('resync cadence', () => {
  it("ties the reader's budget to two resync periods", () => {
    expect(POLYMARKET_BOOK_MAX_AGE_MS).toBe(POLYMARKET_BOOK_RESYNC_INTERVAL_MS * 2);
    expect(() =>
      assertPolymarketBookResyncBudget({
        resyncIntervalMs: POLYMARKET_BOOK_RESYNC_INTERVAL_MS,
        maxAgeMs: POLYMARKET_BOOK_MAX_AGE_MS
      })).not.toThrow();
  });

  it('refuses a cadence that cannot hold a book inside the budget', () => {
    expect(() =>
      assertPolymarketBookResyncBudget({
        resyncIntervalMs: POLYMARKET_BOOK_MAX_AGE_MS,
        maxAgeMs: POLYMARKET_BOOK_MAX_AGE_MS
      })).toThrow(PolymarketBookSubscriberConfigError);
  });

  it('lists never-snapshotted, awaiting and stale tokens as due', () => {
    const cold = createPolymarketBookSubscriberState([TOKEN]);
    expect(polymarketBooksDueForResync(cold, { now: T(0) })).toEqual([TOKEN]);

    const fresh = snapshotted(T(1_000));
    expect(polymarketBooksDueForResync(fresh, { now: T(1_001) })).toEqual([]);
    expect(
      polymarketBooksDueForResync(fresh, { now: T(1_000 + POLYMARKET_BOOK_RESYNC_INTERVAL_MS) })
    ).toEqual([TOKEN]);

    const awaiting = invalidateAllPolymarketBooks(fresh, T(1_500)).state;
    expect(polymarketBooksDueForResync(awaiting, { now: T(1_501) })).toEqual([TOKEN]);
  });

  it('chunks a resync to the documented 500-item maximum', () => {
    const tokens = Array.from({ length: 1_001 }, (_, index) => `token-${index}`);
    const batches = chunkPolymarketBookBatch(tokens);
    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 1]);
    expect(() => chunkPolymarketBookBatch(tokens, POLYMARKET_BOOKS_MAX_BATCH + 1)).toThrow(
      PolymarketBookSubscriberConfigError
    );
  });
});

describe('subscribe frames', () => {
  it('builds the documented initial subscribe frame', () => {
    expect(polymarketMarketSubscribeFrame({ tokenIds: [TOKEN] })).toBe(
      `{"assets_ids":["${TOKEN}"],"type":"market"}`
    );
  });

  it('adds custom_feature_enabled only when asked', () => {
    expect(
      polymarketMarketSubscribeFrame({ tokenIds: [TOKEN], customFeatureEnabled: true })
    ).toBe(`{"assets_ids":["${TOKEN}"],"type":"market","custom_feature_enabled":true}`);
  });

  it('builds the documented live subscribe and unsubscribe operations', () => {
    expect(polymarketMarketSubscribeFrame({ tokenIds: [TOKEN], operation: 'subscribe' })).toBe(
      `{"assets_ids":["${TOKEN}"],"operation":"subscribe"}`
    );
    expect(polymarketMarketSubscribeFrame({ tokenIds: [OTHER], operation: 'unsubscribe' })).toBe(
      `{"assets_ids":["${OTHER}"],"operation":"unsubscribe"}`
    );
  });
});

describe('createPolymarketBookSubscriber', () => {
  function build(overrides: {
    readonly clock?: () => number;
    readonly fetchBooks?: (tokenIds: readonly string[]) => Promise<readonly unknown[]>;
  } = {}) {
    const transport = fakeTransport();
    let clockValue = T(1_000);
    const subscriber = createPolymarketBookSubscriber({
      transportFactory: transport.factory,
      fetchBooks: overrides.fetchBooks ?? (async () => []),
      now: overrides.clock ?? (() => clockValue),
      tokenIds: [TOKEN],
      logger: { info: () => undefined, warn: () => undefined }
    });
    return {
      transport,
      subscriber,
      setClock: (value: number) => {
        clockValue = value;
      }
    };
  }

  it('sends the subscribe frame for the tracked set on open, and re-sends on reconnect', () => {
    const { transport, subscriber } = build();
    subscriber.start();
    transport.handlers().onOpen();
    expect(transport.sent).toEqual([`{"assets_ids":["${TOKEN}"],"type":"market"}`]);
    transport.handlers().onClose('socket hang up');
    subscriber.start();
    transport.handlers().onOpen();
    // Re-sent because the docs say the operation frames update only the current
    // connection's token set.
    expect(transport.sent).toHaveLength(2);
  });

  it('sends the documented PING keepalive and swallows PONG without touching state', () => {
    const { transport, subscriber } = build();
    subscriber.start();
    transport.handlers().onOpen();
    subscriber.sendHeartbeat();
    expect(transport.sent.at(-1)).toBe('PING');
    transport.handlers().onMessage(JSON.stringify(bookFrame()));
    transport.handlers().onMessage('PONG');
    expect(subscriber.state().books.get(TOKEN)?.status).toBe('book');
    expect(subscriber.stats()['refused-malformed-frame']).toBe(0);
  });

  it('routes a frame through the state machine and exposes it on the cache port', () => {
    const { transport, subscriber, setClock } = build();
    subscriber.start();
    transport.handlers().onOpen();
    setClock(T(20_000));
    transport.handlers().onMessage(JSON.stringify(bookFrame()));
    const verdict = assessPolymarketBookDepth(subscriber.cache, {
      tokenMint: `polygon:${TOKEN}`,
      cohortDirection: 'buy',
      impactCapBps: 100,
      now: T(20_500)
    });
    expect(verdict.outcome).toBe('assessed');
    expect(subscriber.stats()['applied-snapshot']).toBe(1);
  });

  it('makes every book unknown when the transport closes', () => {
    const { transport, subscriber, setClock } = build();
    subscriber.start();
    transport.handlers().onOpen();
    transport.handlers().onMessage(JSON.stringify(bookFrame()));
    setClock(T(30_000));
    transport.handlers().onClose('1006');
    expect(subscriber.state().books.get(TOKEN)?.status).toBe('awaiting-snapshot');
    expect(subscriber.stats()['resync-transport-disconnected']).toBe(1);
  });

  it('makes every book unknown on a deliberate stop as well', () => {
    const { transport, subscriber } = build();
    subscriber.start();
    transport.handlers().onOpen();
    transport.handlers().onMessage(JSON.stringify(bookFrame()));
    subscriber.stop();
    expect(transport.isClosed()).toBe(true);
    expect(subscriber.state().books.get(TOKEN)?.status).toBe('awaiting-snapshot');
  });

  it('adds and removes tokens on the live connection', () => {
    const { transport, subscriber } = build();
    subscriber.start();
    transport.handlers().onOpen();
    subscriber.subscribe([OTHER]);
    expect(transport.sent.at(-1)).toBe(`{"assets_ids":["${OTHER}"],"operation":"subscribe"}`);
    expect(subscriber.state().tracked.has(OTHER)).toBe(true);
    transport.handlers().onMessage(JSON.stringify(bookFrame({ assetId: OTHER })));
    subscriber.unsubscribe([OTHER]);
    expect(transport.sent.at(-1)).toBe(`{"assets_ids":["${OTHER}"],"operation":"unsubscribe"}`);
    // The entry goes with the subscription, so the reader answers book-not-cached
    // rather than serving a ladder nothing updates any more.
    expect(subscriber.state().books.has(OTHER)).toBe(false);
  });

  it('re-snapshots a due book through the injected POST /books fetcher', async () => {
    const requested: readonly string[][] = [];
    const { transport, subscriber, setClock } = build({
      fetchBooks: async (tokenIds) => {
        (requested as string[][]).push([...tokenIds]);
        return [
          {
            market: MARKET,
            asset_id: TOKEN,
            timestamp: String(BASE + 2_743),
            hash: 'a'.repeat(64),
            bids: [{ price: '0.30', size: '100' }],
            asks: [{ price: '0.31', size: '100' }],
            min_order_size: '5',
            tick_size: '0.01',
            neg_risk: false,
            last_trade_price: '0.30'
          }
        ];
      }
    });
    subscriber.start();
    transport.handlers().onOpen();
    setClock(T(50_000));
    const codes = await subscriber.runDueResyncs();
    expect(requested).toEqual([[TOKEN]]);
    expect(codes).toEqual(['applied-snapshot']);
    const entry = subscriber.state().books.get(TOKEN);
    if (entry === undefined || entry.status !== 'book') throw new Error('expected a book');
    expect(entry.observedAt).toBe(T(50_000));
    expect(entry.minOrderSize).toBe(5);
  });

  it('leaves books ageing rather than flapping them when a resync request fails', async () => {
    const { transport, subscriber, setClock } = build({
      fetchBooks: async () => {
        throw new Error('502 from clob.polymarket.com');
      }
    });
    subscriber.start();
    transport.handlers().onOpen();
    transport.handlers().onMessage(JSON.stringify(bookFrame()));
    setClock(T(1_000 + POLYMARKET_BOOK_RESYNC_INTERVAL_MS));
    await subscriber.runDueResyncs();
    // Still a book: a single failed request must not invalidate the whole cohort.
    expect(subscriber.state().books.get(TOKEN)?.status).toBe('book');
    // And the reader takes it from here once the budget is exceeded.
    const verdict = assessPolymarketBookDepth(subscriber.cache, {
      tokenMint: `polygon:${TOKEN}`,
      cohortDirection: 'buy',
      impactCapBps: 100,
      now: T(1_000 + POLYMARKET_BOOK_MAX_AGE_MS + 1)
    });
    expect(verdict.unknownCode).toBe('book-snapshot-stale');
  });

  it('publishes only the entries a transition touched', () => {
    const published: string[] = [];
    const transport = fakeTransport();
    const subscriber = createPolymarketBookSubscriber({
      transportFactory: transport.factory,
      fetchBooks: async () => [],
      now: () => T(1_000),
      tokenIds: [TOKEN, OTHER],
      onEntry: (entry) => published.push(`${entry.tokenId}:${entry.status}`),
      logger: { info: () => undefined, warn: () => undefined }
    });
    subscriber.start();
    transport.handlers().onOpen();
    transport.handlers().onMessage(JSON.stringify(bookFrame()));
    expect(published).toEqual([`${TOKEN}:book`]);
  });

  it('refuses to start with a cadence looser than half the reader budget', () => {
    const transport = fakeTransport();
    expect(() =>
      createPolymarketBookSubscriber({
        transportFactory: transport.factory,
        fetchBooks: async () => [],
        now: () => 0,
        resyncIntervalMs: POLYMARKET_BOOK_MAX_AGE_MS
      })).toThrow(PolymarketBookSubscriberConfigError);
  });
});
