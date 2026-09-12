import { describe, expect, it, vi } from 'vitest';
import {
  assessPolymarketBookDepth,
  POLYMARKET_BOOK_MAX_AGE_MS,
  POLYMARKET_BOOK_RESYNC_INTERVAL_MS,
  type PolymarketBookEntry
} from './polymarket-book-depth.js';
import {
  assertPolymarketBookTtlBudget,
  buildPolymarketBookSnapshot,
  createInMemoryPolymarketBookTransport,
  createPolymarketBookPublisher,
  deserializePolymarketBookEntry,
  encodePolymarketBookEntry,
  loadPolymarketBookEntry,
  loadPolymarketBookSnapshot,
  polymarketBookEntryFreshness,
  polymarketBookKey,
  polymarketBookRedisTransport,
  POLYMARKET_BOOK_ENTRY_TTL_MS,
  POLYMARKET_BOOK_KEY_PREFIX,
  POLYMARKET_BOOK_WIRE_VERSION,
  PolymarketBookTransportError,
  serializePolymarketBookEntry,
  type PolymarketBookKeyValueTransport
} from './polymarket-book-transport.js';

/** A real-shaped CLOB token id: the `asset_id` on the market channel. */
const TOKEN_ID = '107505882767731489358349912513945399560393482969656700824895970500493757150417';
const OTHER_TOKEN_ID = '211451232867132399874351239878123498712349871234987123498712349871234987123499';
const PREFIXED = `polygon:${TOKEN_ID}`;

const NOW = 1_782_753_400_000;

/** Polygon's aggregate-impact ceiling today. Mirrors the depth suite's constant. */
const POLYGON_CAP_BPS = 100;

function bookEntry(over: Partial<Extract<PolymarketBookEntry, { status: 'book' }>> = {}) {
  const entry: PolymarketBookEntry = {
    status: 'book',
    tokenId: TOKEN_ID,
    observedAt: NOW - 1_000,
    ladders: {
      bids: [{ price: 0.4, size: 1_000 }],
      asks: [{ price: 0.5, size: 1_000 }]
    },
    ...over
  };
  return entry;
}

function awaitingEntry(
  over: Partial<Extract<PolymarketBookEntry, { status: 'awaiting-snapshot' }>> = {}
) {
  const entry: PolymarketBookEntry = {
    status: 'awaiting-snapshot',
    tokenId: TOKEN_ID,
    since: NOW - 2_000,
    ...over
  };
  return entry;
}

function ok(raw: string): PolymarketBookEntry {
  const decoded = deserializePolymarketBookEntry(raw);
  if (!decoded.ok) throw new Error(`expected a decode, got ${decoded.code}: ${decoded.detail}`);
  return decoded.entry;
}

function refused(raw: string) {
  const decoded = deserializePolymarketBookEntry(raw);
  if (decoded.ok) throw new Error('expected a refusal, got a decoded entry');
  return decoded;
}

// ═══════════════════════════════════════════════════════════════════════════
// Keys and budgets
// ═══════════════════════════════════════════════════════════════════════════

describe('polymarketBookKey', () => {
  it('namespaces under the repo-wide swat: convention and accepts both token forms', () => {
    expect(polymarketBookKey(TOKEN_ID)).toBe(`${POLYMARKET_BOOK_KEY_PREFIX}:${TOKEN_ID}`);
    expect(polymarketBookKey(PREFIXED)).toBe(polymarketBookKey(TOKEN_ID));
    expect(POLYMARKET_BOOK_KEY_PREFIX.startsWith('swat:')).toBe(true);
  });

  it('refuses a token prefixed for another chain rather than stripping it', () => {
    expect(() => polymarketBookKey('solana:So11111111111111111111111111111111111111112'))
      .toThrow(PolymarketBookTransportError);
    expect(() => polymarketBookKey(`robinhood-chain:${TOKEN_ID}`))
      .toThrow(/routing bug/);
  });

  it('refuses an empty or padded token', () => {
    expect(() => polymarketBookKey('')).toThrow(PolymarketBookTransportError);
    expect(() => polymarketBookKey(` ${TOKEN_ID}`)).toThrow(PolymarketBookTransportError);
    expect(() => polymarketBookKey('polygon:')).toThrow(PolymarketBookTransportError);
  });
});

describe('POLYMARKET_BOOK_ENTRY_TTL_MS', () => {
  it('is derived from the existing constants, not a fresh number', () => {
    expect(POLYMARKET_BOOK_ENTRY_TTL_MS).toBe(
      POLYMARKET_BOOK_MAX_AGE_MS + POLYMARKET_BOOK_RESYNC_INTERVAL_MS
    );
  });

  it('is at least the reader freshness budget, so a stale entry is never a missing key', () => {
    expect(POLYMARKET_BOOK_ENTRY_TTL_MS).toBeGreaterThanOrEqual(POLYMARKET_BOOK_MAX_AGE_MS);
    expect(() =>
      assertPolymarketBookTtlBudget({
        ttlMs: POLYMARKET_BOOK_ENTRY_TTL_MS,
        maxAgeMs: POLYMARKET_BOOK_MAX_AGE_MS
      })
    ).not.toThrow();
  });

  it('refuses a TTL below the age budget, which would report the wrong cause', () => {
    expect(() =>
      assertPolymarketBookTtlBudget({
        ttlMs: POLYMARKET_BOOK_MAX_AGE_MS - 1,
        maxAgeMs: POLYMARKET_BOOK_MAX_AGE_MS
      })
    ).toThrow(/shorter than the reader's/);
    expect(() => assertPolymarketBookTtlBudget({ ttlMs: 0, maxAgeMs: 1_000 })).toThrow();
    expect(() =>
      assertPolymarketBookTtlBudget({ ttlMs: 1_000, maxAgeMs: Number.NaN })
    ).toThrow();
  });

  it('is enforced by the publisher constructor, not merely documented', () => {
    const transport = createInMemoryPolymarketBookTransport(() => NOW);
    expect(() =>
      createPolymarketBookPublisher({ transport, ttlMs: POLYMARKET_BOOK_MAX_AGE_MS - 1 })
    ).toThrow(PolymarketBookTransportError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Codec: the variant distinction must survive the wire
// ═══════════════════════════════════════════════════════════════════════════

describe('serialisation round-trips every variant', () => {
  it('round-trips a book entry with every optional field', () => {
    const entry = bookEntry({ venueTimestamp: NOW - 1_200, tickSize: 0.01, minOrderSize: 5 });
    expect(ok(serializePolymarketBookEntry(entry))).toEqual(entry);
  });

  it('round-trips a book entry with no optional fields, without inventing nulls', () => {
    const entry = bookEntry();
    const decoded = ok(serializePolymarketBookEntry(entry));
    expect(decoded).toEqual(entry);
    expect('venueTimestamp' in decoded).toBe(false);
    expect('tickSize' in decoded).toBe(false);
  });

  it('preserves an explicit null venueTimestamp as null, distinct from absent', () => {
    const decoded = ok(serializePolymarketBookEntry(bookEntry({ venueTimestamp: null })));
    expect(decoded.status).toBe('book');
    expect('venueTimestamp' in decoded).toBe(true);
    expect((decoded as Extract<PolymarketBookEntry, { status: 'book' }>).venueTimestamp).toBeNull();
  });

  it('round-trips an awaiting-snapshot entry and keeps top-of-book', () => {
    const entry = awaitingEntry({ bestBid: 0.4, bestAsk: 0.5 });
    expect(ok(serializePolymarketBookEntry(entry))).toEqual(entry);
  });

  it('round-trips a bare awaiting-snapshot entry', () => {
    const entry = awaitingEntry();
    expect(ok(serializePolymarketBookEntry(entry))).toEqual(entry);
  });

  it('never writes a ladders field for awaiting-snapshot -- the gap is structural on the wire', () => {
    const payload = encodePolymarketBookEntry(awaitingEntry({ bestBid: 0.4, bestAsk: 0.5 }));
    expect('ladders' in payload).toBe(false);
    expect(JSON.parse(serializePolymarketBookEntry(awaitingEntry()))).not.toHaveProperty('ladders');
  });

  it('never writes a since field for a book entry', () => {
    expect('since' in encodePolymarketBookEntry(bookEntry())).toBe(false);
  });

  it('an awaiting-snapshot entry never deserialises into a book, with or without a ladder', () => {
    // The whole reason this codec is discriminated: a gap that decodes into a
    // `book` with an empty ladder reads as a valid thin book -- a NUMBER -- rather
    // than as a gap.
    const decoded = ok(serializePolymarketBookEntry(awaitingEntry()));
    expect(decoded.status).toBe('awaiting-snapshot');
    expect(decoded).not.toHaveProperty('ladders');
  });

  it('stamps the wire version on both variants', () => {
    expect(encodePolymarketBookEntry(bookEntry()).v).toBe(POLYMARKET_BOOK_WIRE_VERSION);
    expect(encodePolymarketBookEntry(awaitingEntry()).v).toBe(POLYMARKET_BOOK_WIRE_VERSION);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Codec refusals: three distinct facts, never defaulted
// ═══════════════════════════════════════════════════════════════════════════

describe('deserializePolymarketBookEntry refuses rather than defaulting', () => {
  it('reports non-JSON as value-malformed', () => {
    expect(refused('not json at all').code).toBe('value-malformed');
    expect(refused('').code).toBe('value-malformed');
  });

  it('reports a JSON scalar or array as value-malformed, not entry-invalid', () => {
    expect(refused('7').code).toBe('value-malformed');
    expect(refused('null').code).toBe('value-malformed');
    expect(refused('[]').code).toBe('value-malformed');
  });

  it('reports a different wire version as version-skew, distinct from malformed', () => {
    const skewed = { ...encodePolymarketBookEntry(bookEntry()), v: POLYMARKET_BOOK_WIRE_VERSION + 1 };
    const result = refused(JSON.stringify(skewed));
    expect(result.code).toBe('version-skew');
    expect(result.detail).toContain(String(POLYMARKET_BOOK_WIRE_VERSION));
  });

  it('refuses a payload with NO version tag as version-skew', () => {
    // A missing tag is the pre-versioning writer, which is exactly the skew the
    // tag exists to name. Accepting it would silently decode an unknown shape.
    const { v: _dropped, ...untagged } = encodePolymarketBookEntry(bookEntry());
    expect(refused(JSON.stringify(untagged)).code).toBe('version-skew');
  });

  it('refuses a version tag of the wrong TYPE rather than coercing it', () => {
    const stringy = { ...encodePolymarketBookEntry(bookEntry()), v: String(POLYMARKET_BOOK_WIRE_VERSION) };
    expect(refused(JSON.stringify(stringy)).code).toBe('version-skew');
  });

  it('checks the version BEFORE the shape, so a skewed payload cannot pass on shape alone', () => {
    // Structurally a perfect `book` payload; only `v` is wrong. If shape were
    // checked first this would decode.
    const skewed = { ...encodePolymarketBookEntry(bookEntry()), v: 99 };
    expect(refused(JSON.stringify(skewed)).code).toBe('version-skew');
  });

  it('refuses a book payload with NO ladders instead of defaulting to empty sides', () => {
    // The load-bearing refusal. `{bids: [], asks: []}` would be fresh, valid, and
    // read as an observed thin book -- a number where there should be a gap.
    const { ladders: _dropped, ...noLadder } = encodePolymarketBookEntry(bookEntry()) as Record<string, unknown>;
    const result = refused(JSON.stringify(noLadder));
    expect(result.code).toBe('entry-invalid');
    expect(result.detail).toContain('no ladders object');
  });

  it('refuses a book payload whose ladders is not an object', () => {
    const payload = { ...encodePolymarketBookEntry(bookEntry()), ladders: 'nope' };
    expect(refused(JSON.stringify(payload)).code).toBe('entry-invalid');
    expect(refused(JSON.stringify({ ...payload, ladders: [] })).code).toBe('entry-invalid');
    expect(refused(JSON.stringify({ ...payload, ladders: null })).code).toBe('entry-invalid');
  });

  it('refuses an awaiting-snapshot payload that carries a ladder', () => {
    const payload = {
      ...encodePolymarketBookEntry(awaitingEntry()),
      ladders: { bids: [], asks: [] }
    };
    const result = refused(JSON.stringify(payload));
    expect(result.code).toBe('entry-invalid');
    expect(result.detail).toContain('confused the two variants');
  });

  it('refuses an unknown status rather than guessing which variant was meant', () => {
    const payload = { v: POLYMARKET_BOOK_WIRE_VERSION, status: 'resolved', tokenId: TOKEN_ID };
    expect(refused(JSON.stringify(payload)).code).toBe('entry-invalid');
  });

  it('refuses a missing ladder side, and does not treat it as empty', () => {
    const payload = {
      v: POLYMARKET_BOOK_WIRE_VERSION,
      status: 'book',
      tokenId: TOKEN_ID,
      observedAt: NOW,
      ladders: { bids: [{ price: 0.4, size: 1 }] }
    };
    expect(refused(JSON.stringify(payload)).code).toBe('entry-invalid');
  });

  it('refuses a string-valued level rather than coercing it (Number("") is 0)', () => {
    const payload = {
      v: POLYMARKET_BOOK_WIRE_VERSION,
      status: 'book',
      tokenId: TOKEN_ID,
      observedAt: NOW,
      ladders: { bids: [{ price: '0.4', size: '1000' }], asks: [] }
    };
    expect(refused(JSON.stringify(payload)).code).toBe('entry-invalid');
  });

  it('refuses a non-finite observedAt, since it is the clock staleness is measured on', () => {
    const payload = { ...encodePolymarketBookEntry(bookEntry()), observedAt: null };
    expect(refused(JSON.stringify(payload)).code).toBe('entry-invalid');
    // JSON has no Infinity, so a serialised Infinity arrives as null -- covered above.
    const missing = { ...encodePolymarketBookEntry(bookEntry()) } as Record<string, unknown>;
    delete missing.observedAt;
    expect(refused(JSON.stringify(missing)).code).toBe('entry-invalid');
  });

  it('refuses a non-finite since on an awaiting-snapshot entry', () => {
    const payload = { ...encodePolymarketBookEntry(awaitingEntry()), since: null };
    expect(refused(JSON.stringify(payload)).code).toBe('entry-invalid');
  });

  it('refuses a payload with no usable tokenId', () => {
    const payload = { ...encodePolymarketBookEntry(bookEntry()), tokenId: '' };
    expect(refused(JSON.stringify(payload)).code).toBe('entry-invalid');
  });

  it('accepts a zero-size level, because price_change publishes size "0" to delete', () => {
    const entry = bookEntry({ ladders: { bids: [{ price: 0.4, size: 0 }], asks: [] } });
    expect(ok(serializePolymarketBookEntry(entry))).toEqual(entry);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Freshness: observability, not a second gate
// ═══════════════════════════════════════════════════════════════════════════

describe('polymarketBookEntryFreshness', () => {
  it('defaults to the reader budget rather than a number of its own', () => {
    expect(
      polymarketBookEntryFreshness({
        entry: bookEntry({ observedAt: NOW - POLYMARKET_BOOK_MAX_AGE_MS }),
        now: NOW
      })
    ).toBe('fresh');
    expect(
      polymarketBookEntryFreshness({
        entry: bookEntry({ observedAt: NOW - POLYMARKET_BOOK_MAX_AGE_MS - 1 }),
        now: NOW
      })
    ).toBe('stale');
  });

  it('never calls an awaiting-snapshot entry fresh', () => {
    expect(polymarketBookEntryFreshness({ entry: awaitingEntry(), now: NOW }))
      .toBe('awaiting-snapshot');
  });

  it('answers age-unknown rather than fresh when no age can be computed', () => {
    expect(
      polymarketBookEntryFreshness({ entry: bookEntry({ observedAt: Number.NaN }), now: NOW })
    ).toBe('age-unknown');
    expect(polymarketBookEntryFreshness({ entry: bookEntry(), now: Number.NaN })).toBe('age-unknown');
    expect(polymarketBookEntryFreshness({ entry: bookEntry(), now: NOW, maxAgeMs: 0 }))
      .toBe('age-unknown');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Snapshot building: missing / malformed / stale stay three distinct facts
// ═══════════════════════════════════════════════════════════════════════════

describe('buildPolymarketBookSnapshot keeps the three facts distinct', () => {
  const key = polymarketBookKey(TOKEN_ID);

  it('codes an absent value key-missing and serves NO entry -- never a zero-depth book', () => {
    const snapshot = buildPolymarketBookSnapshot({
      slots: [{ tokenId: TOKEN_ID, key, value: null }],
      readAt: NOW
    });
    expect(snapshot.counts['key-missing']).toBe(1);
    expect(snapshot.statusFor(PREFIXED)?.code).toBe('key-missing');
    expect(snapshot.cache.get(TOKEN_ID)).toBeUndefined();
    // The refusal that matters: a missing key must not become a fabricated book.
    expect(snapshot.statusFor(TOKEN_ID)?.entry).toBeNull();
  });

  it('a missing key reads book-not-cached through the real reader, never a priced zero', () => {
    const snapshot = buildPolymarketBookSnapshot({
      slots: [{ tokenId: TOKEN_ID, key, value: null }],
      readAt: NOW
    });
    const verdict = assessPolymarketBookDepth(snapshot.cache, {
      tokenMint: PREFIXED,
      cohortDirection: 'buy',
      impactCapBps: POLYGON_CAP_BPS,
      now: NOW
    });
    expect(verdict.outcome).toBe('unknown');
    expect(verdict.unknownCode).toBe('book-not-cached');
    expect(verdict.liquidity.usableLiquidityUsd).toBeNull();
    expect(verdict.liquidity.basis).toBe('unknown');
    // Explicitly not the known-zero outcome, which would say "this market is thin".
    expect(verdict.outcome).not.toBe('no-depth-within-bound');
  });

  it('codes a malformed value value-malformed, distinct from key-missing', () => {
    const snapshot = buildPolymarketBookSnapshot({
      slots: [{ tokenId: TOKEN_ID, key, value: '{oops' }],
      readAt: NOW
    });
    expect(snapshot.counts['value-malformed']).toBe(1);
    expect(snapshot.counts['key-missing']).toBe(0);
    expect(snapshot.cache.get(TOKEN_ID)).toBeUndefined();
  });

  it('codes a skewed value version-skew, distinct from both', () => {
    const skewed = JSON.stringify({ ...encodePolymarketBookEntry(bookEntry()), v: 42 });
    const snapshot = buildPolymarketBookSnapshot({
      slots: [{ tokenId: TOKEN_ID, key, value: skewed }],
      readAt: NOW
    });
    expect(snapshot.counts['version-skew']).toBe(1);
    expect(snapshot.counts['value-malformed']).toBe(0);
    expect(snapshot.counts['key-missing']).toBe(0);
    expect(snapshot.cache.get(TOKEN_ID)).toBeUndefined();
  });

  it('codes a stale entry entry-stale AND still serves it, so the reader reports the age', () => {
    const stale = bookEntry({ observedAt: NOW - POLYMARKET_BOOK_MAX_AGE_MS - 5_000 });
    const snapshot = buildPolymarketBookSnapshot({
      slots: [{ tokenId: TOKEN_ID, key, value: serializePolymarketBookEntry(stale) }],
      readAt: NOW
    });
    expect(snapshot.counts['entry-stale']).toBe(1);
    expect(snapshot.counts['key-missing']).toBe(0);
    expect(snapshot.cache.get(TOKEN_ID)).toEqual(stale);

    const verdict = assessPolymarketBookDepth(snapshot.cache, {
      tokenMint: PREFIXED,
      cohortDirection: 'buy',
      impactCapBps: POLYGON_CAP_BPS,
      now: NOW
    });
    // Not `book-not-cached`: the cause is a lagging subscriber, not an unwired one.
    expect(verdict.unknownCode).toBe('book-snapshot-stale');
    expect(verdict.ageMs).toBe(POLYMARKET_BOOK_MAX_AGE_MS + 5_000);
    expect(verdict.liquidity.usableLiquidityUsd).toBeNull();
  });

  it('codes a fresh decode entry-decoded and prices it through the unchanged reader', () => {
    const entry = bookEntry();
    const snapshot = buildPolymarketBookSnapshot({
      slots: [{ tokenId: TOKEN_ID, key, value: serializePolymarketBookEntry(entry) }],
      readAt: NOW
    });
    expect(snapshot.counts['entry-decoded']).toBe(1);
    expect(snapshot.statusFor(TOKEN_ID)?.freshness).toBe('fresh');

    const verdict = assessPolymarketBookDepth(snapshot.cache, {
      tokenMint: PREFIXED,
      cohortDirection: 'buy',
      impactCapBps: POLYGON_CAP_BPS,
      now: NOW
    });
    expect(verdict.outcome).toBe('assessed');
    expect(verdict.liquidity.basis).toBe('order-book-depth');
    expect(verdict.liquidity.usableLiquidityUsd).toBeGreaterThan(0);
    expect(verdict.liquidity.calibratedForImpactCapBps).toBe(POLYGON_CAP_BPS);
  });

  it('serves an awaiting-snapshot entry so the reader answers book-awaiting-snapshot, not not-cached', () => {
    const entry = awaitingEntry({ bestBid: 0.4, bestAsk: 0.5 });
    const snapshot = buildPolymarketBookSnapshot({
      slots: [{ tokenId: TOKEN_ID, key, value: serializePolymarketBookEntry(entry) }],
      readAt: NOW
    });
    expect(snapshot.statusFor(TOKEN_ID)?.freshness).toBe('awaiting-snapshot');
    const verdict = assessPolymarketBookDepth(snapshot.cache, {
      tokenMint: PREFIXED,
      cohortDirection: 'buy',
      impactCapBps: POLYGON_CAP_BPS,
      now: NOW
    });
    expect(verdict.unknownCode).toBe('book-awaiting-snapshot');
    expect(verdict.outcome).not.toBe('no-depth-within-bound');
    expect(verdict.liquidity.usableLiquidityUsd).toBeNull();
  });

  it('refuses a value whose tokenId does not match the key it was stored under', () => {
    const foreign = serializePolymarketBookEntry(bookEntry({ tokenId: OTHER_TOKEN_ID }));
    const snapshot = buildPolymarketBookSnapshot({
      slots: [{ tokenId: TOKEN_ID, key, value: foreign }],
      readAt: NOW
    });
    expect(snapshot.counts['entry-invalid']).toBe(1);
    expect(snapshot.cache.get(TOKEN_ID)).toBeUndefined();
    expect(snapshot.cache.get(OTHER_TOKEN_ID)).toBeUndefined();
  });

  it('keeps per-token codes apart in one mixed snapshot', () => {
    const snapshot = buildPolymarketBookSnapshot({
      slots: [
        { tokenId: TOKEN_ID, key, value: serializePolymarketBookEntry(bookEntry()) },
        { tokenId: OTHER_TOKEN_ID, key: polymarketBookKey(OTHER_TOKEN_ID), value: null }
      ],
      readAt: NOW
    });
    expect(snapshot.counts['entry-decoded']).toBe(1);
    expect(snapshot.counts['key-missing']).toBe(1);
    expect(snapshot.statusFor(TOKEN_ID)?.code).toBe('entry-decoded');
    expect(snapshot.statusFor(OTHER_TOKEN_ID)?.code).toBe('key-missing');
  });

  it('stamps readAt so a caller can prove it did not hold a snapshot across decisions', () => {
    expect(buildPolymarketBookSnapshot({ slots: [], readAt: NOW }).readAt).toBe(NOW);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Writer
// ═══════════════════════════════════════════════════════════════════════════

describe('createPolymarketBookPublisher', () => {
  it('publishes an entry the reader then decodes, with the derived TTL', async () => {
    const transport = createInMemoryPolymarketBookTransport(() => NOW);
    const publisher = createPolymarketBookPublisher({ transport });
    expect(publisher.ttlMs).toBe(POLYMARKET_BOOK_ENTRY_TTL_MS);

    const result = await publisher.publish(bookEntry());
    expect(result.ok).toBe(true);
    expect(result.key).toBe(polymarketBookKey(TOKEN_ID));

    const snapshot = await loadPolymarketBookEntry({ transport, now: () => NOW }, PREFIXED);
    expect(snapshot.statusFor(TOKEN_ID)?.code).toBe('entry-decoded');
  });

  it('round-trips an awaiting-snapshot entry across the transport as a gap, not a book', async () => {
    const transport = createInMemoryPolymarketBookTransport(() => NOW);
    const publisher = createPolymarketBookPublisher({ transport });
    await publisher.publish(awaitingEntry({ bestBid: 0.41, bestAsk: 0.52 }));

    const snapshot = await loadPolymarketBookEntry({ transport, now: () => NOW }, PREFIXED);
    const served = snapshot.cache.get(TOKEN_ID);
    expect(served?.status).toBe('awaiting-snapshot');
    expect(served).not.toHaveProperty('ladders');
    const verdict = assessPolymarketBookDepth(snapshot.cache, {
      tokenMint: PREFIXED,
      cohortDirection: 'buy',
      impactCapBps: POLYGON_CAP_BPS,
      now: NOW
    });
    expect(verdict.unknownCode).toBe('book-awaiting-snapshot');
  });

  it('refuses to publish a token from another chain rather than writing a bad key', async () => {
    const transport = createInMemoryPolymarketBookTransport(() => NOW);
    const failures: string[] = [];
    const publisher = createPolymarketBookPublisher({
      transport,
      onFailure: (failure) => { if (!failure.ok) failures.push(failure.code); }
    });
    const result = await publisher.publish(bookEntry({ tokenId: 'solana:So11111111111111111111111111111111111111112' }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('publish-refused');
    expect(failures).toEqual(['publish-refused']);
    expect(transport.size()).toBe(0);
  });

  it('swallows a transport failure so a Redis blip cannot break the subscriber', async () => {
    const failures: string[] = [];
    const transport: PolymarketBookKeyValueTransport = {
      get: async () => null,
      set: async () => { throw new Error('ECONNREFUSED'); },
      mget: async (keys) => keys.map(() => null)
    };
    const publisher = createPolymarketBookPublisher({
      transport,
      onFailure: (failure) => { if (!failure.ok) failures.push(failure.detail); }
    });
    const result = await publisher.publish(bookEntry());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('transport-failed');
    expect(failures[0]).toContain('ECONNREFUSED');
  });

  it('expires an entry after the TTL, so a dead writer stops serving books', async () => {
    let clock = NOW;
    const transport = createInMemoryPolymarketBookTransport(() => clock);
    const publisher = createPolymarketBookPublisher({ transport });
    await publisher.publish(bookEntry());

    clock = NOW + POLYMARKET_BOOK_ENTRY_TTL_MS + 1;
    const snapshot = await loadPolymarketBookEntry({ transport, now: () => clock }, PREFIXED);
    expect(snapshot.statusFor(TOKEN_ID)?.code).toBe('key-missing');
  });

  it('keeps a stale-but-live entry readable inside the TTL window', async () => {
    // The TTL/staleness distinction, end to end: past the age budget, inside the
    // TTL, so the reader can still name the cause as a lagging subscriber.
    let clock = NOW;
    const transport = createInMemoryPolymarketBookTransport(() => clock);
    await createPolymarketBookPublisher({ transport }).publish(bookEntry({ observedAt: NOW }));

    clock = NOW + POLYMARKET_BOOK_MAX_AGE_MS + 1;
    const snapshot = await loadPolymarketBookEntry({ transport, now: () => clock }, PREFIXED);
    expect(snapshot.statusFor(TOKEN_ID)?.code).toBe('entry-stale');
    const verdict = assessPolymarketBookDepth(snapshot.cache, {
      tokenMint: PREFIXED,
      cohortDirection: 'buy',
      impactCapBps: POLYGON_CAP_BPS,
      now: clock
    });
    expect(verdict.unknownCode).toBe('book-snapshot-stale');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reader I/O
// ═══════════════════════════════════════════════════════════════════════════

describe('loadPolymarketBookSnapshot', () => {
  it('reads a batch in one mget and collapses duplicate tokens', async () => {
    const mget = vi.fn(async (keys: readonly string[]) => keys.map(() => null));
    const transport: PolymarketBookKeyValueTransport = {
      get: async () => null,
      set: async () => {},
      mget
    };
    const snapshot = await loadPolymarketBookSnapshot(
      { transport, now: () => NOW },
      [PREFIXED, TOKEN_ID, OTHER_TOKEN_ID]
    );
    expect(mget).toHaveBeenCalledTimes(1);
    expect(mget.mock.calls[0]![0]).toHaveLength(2);
    expect(snapshot.statuses).toHaveLength(2);
  });

  it('does not call the transport at all for an empty token list', async () => {
    const mget = vi.fn(async () => []);
    const snapshot = await loadPolymarketBookSnapshot(
      { transport: { get: async () => null, set: async () => {}, mget }, now: () => NOW },
      []
    );
    expect(mget).not.toHaveBeenCalled();
    expect(snapshot.statuses).toHaveLength(0);
  });

  it('degrades a transport failure to key-missing for every token rather than throwing', async () => {
    const details: string[] = [];
    const transport: PolymarketBookKeyValueTransport = {
      get: async () => { throw new Error('ETIMEDOUT'); },
      set: async () => {},
      mget: async () => { throw new Error('ETIMEDOUT'); }
    };
    const snapshot = await loadPolymarketBookSnapshot(
      { transport, now: () => NOW },
      [PREFIXED, OTHER_TOKEN_ID],
      (detail) => details.push(detail)
    );
    expect(snapshot.counts['key-missing']).toBe(2);
    expect(details[0]).toContain('ETIMEDOUT');

    const single = await loadPolymarketBookEntry({ transport, now: () => NOW }, PREFIXED);
    expect(single.statusFor(TOKEN_ID)?.code).toBe('key-missing');
  });

  it('refuses a short mget result wholesale rather than zipping it best-effort', async () => {
    // A compacted or reordered result would attribute one market's book to
    // another, which is a wrong number rather than a missing one.
    const good = serializePolymarketBookEntry(bookEntry());
    const details: string[] = [];
    const transport: PolymarketBookKeyValueTransport = {
      get: async () => null,
      set: async () => {},
      mget: async () => [good]
    };
    const snapshot = await loadPolymarketBookSnapshot(
      { transport, now: () => NOW },
      [PREFIXED, OTHER_TOKEN_ID],
      (detail) => details.push(detail)
    );
    expect(snapshot.counts['key-missing']).toBe(2);
    expect(snapshot.cache.get(TOKEN_ID)).toBeUndefined();
    expect(details[0]).toContain('one slot per key');
  });

  it('reads back exactly what the publisher wrote, per token, across the port', async () => {
    const transport = createInMemoryPolymarketBookTransport(() => NOW);
    const publisher = createPolymarketBookPublisher({ transport });
    const first = bookEntry();
    const second = awaitingEntry({ tokenId: OTHER_TOKEN_ID, since: NOW - 500 });
    await publisher.publish(first);
    await publisher.publish(second);

    const snapshot = await loadPolymarketBookSnapshot(
      { transport, now: () => NOW },
      [PREFIXED, `polygon:${OTHER_TOKEN_ID}`]
    );
    expect(snapshot.cache.get(TOKEN_ID)).toEqual(first);
    expect(snapshot.cache.get(OTHER_TOKEN_ID)).toEqual(second);
  });
});

describe('polymarketBookRedisTransport', () => {
  it('translates the port onto the ioredis method shapes without importing ioredis', async () => {
    const calls: unknown[][] = [];
    const client = {
      get: async (key: string) => { calls.push(['get', key]); return null; },
      set: async (key: string, value: string, mode: 'PX', ttlMs: number) => {
        calls.push(['set', key, value, mode, ttlMs]);
        return 'OK';
      },
      mget: async (...keys: string[]) => { calls.push(['mget', ...keys]); return keys.map(() => null); }
    };
    const transport = polymarketBookRedisTransport(client);
    await transport.set('k', 'v', 45_000.4);
    await transport.get('k');
    await transport.mget(['a', 'b']);
    expect(calls[0]).toEqual(['set', 'k', 'v', 'PX', 45_001]);
    expect(calls[1]).toEqual(['get', 'k']);
    expect(calls[2]).toEqual(['mget', 'a', 'b']);
  });

  it('never sends a PX of zero, which would delete on write', async () => {
    let sent = -1;
    const transport = polymarketBookRedisTransport({
      get: async () => null,
      set: async (_key, _value, _mode, ttlMs) => { sent = ttlMs; return 'OK'; },
      mget: async () => []
    });
    await transport.set('k', 'v', 0.2);
    expect(sent).toBe(1);
  });
});
