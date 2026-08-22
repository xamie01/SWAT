import { describe, expect, it } from 'vitest';
import type { QueryResultRow } from 'pg';
import {
  ADVERSE_SIGN,
  BPS_PER_UNIT,
  InvalidTrackingDifferenceError,
  TRACKING_DIFFERENCE_FEE_BASIS,
  computeTrackingDifference,
  entryLagMs,
  isTradeableSide,
  loadTrackingDifferenceSummary,
  loadTrackingDifferences,
  mapTrackingDifferenceRow,
  resolveMasterPriceUsd,
  resolveUserPriceUsd,
  summarizeTrackingDifferences,
  toTrackingDifferenceRecord
} from './tracking-difference.js';
import type {
  MasterFill,
  TrackingDifference,
  TrackingDifferenceCode,
  TrackingDifferenceDbRow,
  TrackingDifferenceInput,
  TrackingDifferenceQuery,
  UserFill
} from './tracking-difference.js';

// No `vi.hoisted` DATABASE_URL block is needed here, unlike `stop-loss.test.ts`:
// `tracking-difference.ts` never imports `./client.js`, so collecting this file does
// not construct a connection pool. The DB half takes its executor as a parameter.

const MASTER_EVENT_AT = new Date('2026-08-22T12:00:00.000Z');
const USER_FILL_AT = new Date('2026-08-22T12:00:04.250Z');

function master(overrides: Partial<MasterFill> = {}): MasterFill {
  return {
    side: 'buy',
    priceUsd: 0.4,
    amountUsd: 40,
    quantity: 100,
    eventAt: MASTER_EVENT_AT,
    ...overrides
  };
}

function user(overrides: Partial<UserFill> = {}): UserFill {
  return {
    side: 'buy',
    filledQuantity: 100,
    pricedQuantity: 100,
    pricedNotionalUsd: 42,
    firstFillAt: USER_FILL_AT,
    ...overrides
  };
}

function input(
  masterOverrides: Partial<MasterFill> = {},
  userOverrides: Partial<UserFill> = {}
): TrackingDifferenceInput {
  return { master: master(masterOverrides), user: user(userOverrides) };
}

describe('the master price is the master price (S4-M23 orientation)', () => {
  it('treats the source trade as the benchmark and our fill as the thing measured', () => {
    // If these two were ever swapped, this assertion inverts: the user paid 0.42 on
    // a buy where the master paid 0.40, so the user is WORSE, and the sign must say
    // so. `source_trades.price_usd` is the master's (per the comment on
    // `getCanonicalSourceTradeById`); `copy_execution_evidence.price_usd` is ours.
    const result = computeTrackingDifference(input());
    expect(result.masterPriceUsd).toBe(0.4);
    expect(result.userPriceUsd).toBeCloseTo(0.42, 12);
    expect(result.worseForUser).toBe(true);
    expect(result.adverseBps).toBeGreaterThan(0);
  });
});

describe('unknown is never zero — the core distinction', () => {
  const uncomparable: ReadonlyArray<[Exclude<TrackingDifferenceCode, 'computed'>, TrackingDifference]> = [
    [
      'master-price-unknown',
      // The common case: NULL on robinhood-chain and non-stablecoin Solana routes.
      computeTrackingDifference(input({ priceUsd: null, amountUsd: null, quantity: null }))
    ],
    [
      'user-price-unknown',
      // Our fill landed but no evidence row carried a `price_usd` (Solana and
      // robinhood-chain live paths pass none).
      computeTrackingDifference(input({}, { pricedQuantity: 0, pricedNotionalUsd: 0 }))
    ],
    [
      'both-prices-unknown',
      computeTrackingDifference(
        input({ priceUsd: null, amountUsd: null, quantity: null }, { pricedQuantity: 0, pricedNotionalUsd: 0 })
      )
    ],
    [
      'no-user-fill',
      computeTrackingDifference(input({}, { filledQuantity: 0, pricedQuantity: 0, pricedNotionalUsd: 0 }))
    ],
    ['side-mismatch', computeTrackingDifference(input({ side: 'sell' }, { side: 'buy' }))],
    ['master-side-not-tradeable', computeTrackingDifference(input({ side: 'transfer_in' }))],
    [
      'master-price-not-positive',
      computeTrackingDifference(input({ priceUsd: 0, amountUsd: 0, quantity: 100 }))
    ],
    ['user-price-not-positive', computeTrackingDifference(input({}, { pricedNotionalUsd: 0 }))]
  ];

  it('produces the expected code for each uncomparable situation', () => {
    for (const [code, result] of uncomparable) {
      expect(result.code).toBe(code);
    }
  });

  it.each(uncomparable)(
    'reports %s as null, never as a zero difference',
    (_code, result) => {
      // Reporting an unmeasured gap as 0 would tell the user they matched the
      // master's price when nothing was compared. `null` is the only honest answer,
      // and `toBeNull` plus `not.toBe(0)` states both halves.
      expect(result.adverseBps).toBeNull();
      expect(result.adverseBps).not.toBe(0);
      expect(result.adverseUsd).toBeNull();
      expect(result.adverseUsd).not.toBe(0);
      expect(result.worseForUser).toBeNull();
      expect(result.worseForUser).not.toBe(false);
      expect(result.adverseUsdPartial).toBe(false);
      expect(result.comparable).toBe(false);
      expect(result.explanation).toContain('Not compared');
    }
  );

  it('reserves a zero difference for two prices that were actually compared', () => {
    const matched = computeTrackingDifference(input({ priceUsd: 0.4 }, { pricedNotionalUsd: 40 }));
    expect(matched.code).toBe('computed');
    expect(matched.comparable).toBe(true);
    expect(matched.adverseBps).toBe(0);
    expect(matched.adverseUsd).toBe(0);
    expect(matched.worseForUser).toBe(false);
    expect(matched.explanation).toContain('Matched');
  });

  it('keeps `comparable` in lockstep with the code, for every code', () => {
    for (const [, result] of uncomparable) expect(result.comparable).toBe(false);
    expect(computeTrackingDifference(input()).comparable).toBe(true);
  });

  it('still reports the entry lag when the difference itself is unknown', () => {
    // On the chains with no price, the lag is often the only honest number we have.
    const result = computeTrackingDifference(input({ priceUsd: null, amountUsd: null, quantity: null }));
    expect(result.code).toBe('master-price-unknown');
    expect(result.entryLagMs).toBe(4250);
  });
});

describe('worse for the user is one sign on both sides', () => {
  it('calls paying above the master worse on a buy', () => {
    const result = computeTrackingDifference(input({ priceUsd: 0.4 }, { pricedNotionalUsd: 42 }));
    expect(result.adverseBps).toBeCloseTo(500, 9);
    expect(result.adverseUsd).toBeCloseTo(2, 9);
    expect(result.worseForUser).toBe(true);
  });

  it('calls receiving below the master worse on a sell, by the same number', () => {
    // The whole point of `ADVERSE_SIGN`: the same 2-cent adverse move gives the same
    // +500 bps and the same +$2 on a sell as on a buy. A raw signed
    // `userPrice - masterPrice` would be -0.02 here and +0.02 above, and a UI
    // colouring on the raw sign would render one of the two backwards.
    const result = computeTrackingDifference(
      input({ side: 'sell', priceUsd: 0.4 }, { side: 'sell', pricedNotionalUsd: 38 })
    );
    expect(result.adverseBps).toBeCloseTo(500, 9);
    expect(result.adverseUsd).toBeCloseTo(2, 9);
    expect(result.worseForUser).toBe(true);
  });

  it('calls paying below the master better on a buy', () => {
    const result = computeTrackingDifference(input({ priceUsd: 0.4 }, { pricedNotionalUsd: 38 }));
    expect(result.adverseBps).toBeCloseTo(-500, 9);
    expect(result.adverseUsd).toBeCloseTo(-2, 9);
    expect(result.worseForUser).toBe(false);
    expect(result.explanation).toContain('in your favour');
  });

  it('calls receiving above the master better on a sell, by the same number', () => {
    const result = computeTrackingDifference(
      input({ side: 'sell', priceUsd: 0.4 }, { side: 'sell', pricedNotionalUsd: 42 })
    );
    expect(result.adverseBps).toBeCloseTo(-500, 9);
    expect(result.adverseUsd).toBeCloseTo(-2, 9);
    expect(result.worseForUser).toBe(false);
  });

  it('exposes the sign map as +1 buy / -1 sell and nothing else', () => {
    expect(ADVERSE_SIGN).toEqual({ buy: 1, sell: -1 });
    expect(Object.isFrozen(ADVERSE_SIGN)).toBe(true);
  });

  it('never admits a transfer into the sign map', () => {
    expect(isTradeableSide('buy')).toBe(true);
    expect(isTradeableSide('sell')).toBe(true);
    expect(isTradeableSide('transfer_in')).toBe(false);
    expect(isTradeableSide('transfer_out')).toBe(false);
  });
});

describe('basis points and dollars answer different questions', () => {
  it('makes a 2-cent gap on a cheap outcome and an expensive token comparable in bps', () => {
    // 2 cents on a $0.40 Polymarket outcome is 500 bps; the same 2 cents on a
    // $4,000 token is 0.05 bps. The bps figure is what makes those the same kind of
    // number, which is why bps is reported and not only dollars.
    const polymarket = computeTrackingDifference(
      input({ priceUsd: 0.4, amountUsd: null, quantity: null }, { pricedNotionalUsd: 42 })
    );
    const token = computeTrackingDifference(
      input(
        { priceUsd: 4_000, amountUsd: null, quantity: null },
        { filledQuantity: 1, pricedQuantity: 1, pricedNotionalUsd: 4_000.02 }
      )
    );
    expect(polymarket.adverseBps).toBeCloseTo(500, 6);
    expect(token.adverseBps).toBeCloseTo(0.05, 6);

    // And the dollars are what makes them differently important: $2 lost against
    // 2 cents. Neither number alone tells the user both things.
    expect(polymarket.adverseUsd).toBeCloseTo(2, 9);
    expect(token.adverseUsd).toBeCloseTo(0.02, 9);
  });

  it('uses the master price as the ratio denominator', () => {
    const result = computeTrackingDifference(input({ priceUsd: 0.4 }, { pricedNotionalUsd: 50 }));
    // (0.50 - 0.40) / 0.40, not / 0.50 and not / 0.45.
    expect(result.adverseBps).toBeCloseTo((0.1 / 0.4) * BPS_PER_UNIT, 6);
  });

  it('scales the dollar figure by the priced quantity, not by the whole fill', () => {
    const result = computeTrackingDifference(
      input({ priceUsd: 0.4 }, { filledQuantity: 100, pricedQuantity: 60, pricedNotionalUsd: 25.2 })
    );
    expect(result.userPriceUsd).toBeCloseTo(0.42, 12);
    expect(result.pricedQuantityFraction).toBeCloseTo(0.6, 12);
    expect(result.adverseUsd).toBeCloseTo(1.2, 9);
    expect(result.adverseUsdPartial).toBe(true);
    expect(result.explanation).toContain('priced part of the fill');
  });

  it('does not flag a fully priced fill as partial', () => {
    const result = computeTrackingDifference(input());
    expect(result.pricedQuantityFraction).toBe(1);
    expect(result.adverseUsdPartial).toBe(false);
  });
});

describe('fees are excluded and the result says so', () => {
  it('stamps the fee basis on every result, comparable or not', () => {
    expect(computeTrackingDifference(input()).feeBasis).toBe(TRACKING_DIFFERENCE_FEE_BASIS);
    expect(computeTrackingDifference(input({ priceUsd: null, amountUsd: null, quantity: null })).feeBasis)
      .toBe(TRACKING_DIFFERENCE_FEE_BASIS);
    expect(TRACKING_DIFFERENCE_FEE_BASIS).toBe('gross-excludes-fees');
  });

  it('says gross of fees in the computed explanation', () => {
    expect(computeTrackingDifference(input()).explanation).toContain('Gross of fees');
  });
});

describe('resolveMasterPriceUsd', () => {
  it('prefers source_trades.price_usd and names that basis', () => {
    expect(resolveMasterPriceUsd(master())).toEqual({ priceUsd: 0.4, basis: 'source-price-usd' });
  });

  it('falls back to amount_usd / token_amount when the price column is null', () => {
    const resolved = resolveMasterPriceUsd(master({ priceUsd: null, amountUsd: 45, quantity: 100 }));
    expect(resolved.basis).toBe('source-amount-over-quantity');
    expect(resolved.priceUsd).toBeCloseTo(0.45, 12);
    expect(computeTrackingDifference(input({ priceUsd: null, amountUsd: 45, quantity: 100 })).masterPriceBasis)
      .toBe('source-amount-over-quantity');
  });

  it('reports no basis when neither column pair yields a price', () => {
    expect(resolveMasterPriceUsd(master({ priceUsd: null, amountUsd: null, quantity: 100 })))
      .toEqual({ priceUsd: null, basis: 'unavailable' });
    expect(resolveMasterPriceUsd(master({ priceUsd: null, amountUsd: 40, quantity: 0 })))
      .toEqual({ priceUsd: null, basis: 'unavailable' });
    expect(resolveMasterPriceUsd(master({ priceUsd: null, amountUsd: 0, quantity: 100 })))
      .toEqual({ priceUsd: null, basis: 'unavailable' });
  });
});

describe('resolveUserPriceUsd', () => {
  it('is the quantity-weighted average over the priced part', () => {
    expect(resolveUserPriceUsd(user({ pricedQuantity: 60, pricedNotionalUsd: 25.2 })))
      .toBeCloseTo(0.42, 12);
  });

  it('is null, not zero, when nothing was priced', () => {
    const price = resolveUserPriceUsd(user({ pricedQuantity: 0, pricedNotionalUsd: 0 }));
    expect(price).toBeNull();
    expect(price).not.toBe(0);
  });
});

describe('entryLagMs', () => {
  it('measures our first fill against the master event', () => {
    expect(entryLagMs(MASTER_EVENT_AT, USER_FILL_AT)).toBe(4250);
  });

  it('is null when either instant is unknown', () => {
    expect(entryLagMs(null, USER_FILL_AT)).toBeNull();
    expect(entryLagMs(MASTER_EVENT_AT, null)).toBeNull();
  });

  it('passes a negative lag through rather than clamping a clock defect to zero', () => {
    expect(entryLagMs(USER_FILL_AT, MASTER_EVENT_AT)).toBe(-4250);
  });
});

describe('incoherent input fails loud rather than becoming unknown', () => {
  it('rejects a non-finite or negative price', () => {
    expect(() => computeTrackingDifference(input({ priceUsd: Number.NaN })))
      .toThrow(InvalidTrackingDifferenceError);
    expect(() => computeTrackingDifference(input({ priceUsd: -0.4 })))
      .toThrow(InvalidTrackingDifferenceError);
    expect(() => computeTrackingDifference(input({ priceUsd: Number.POSITIVE_INFINITY })))
      .toThrow(InvalidTrackingDifferenceError);
  });

  it('rejects a negative or non-finite quantity', () => {
    expect(() => computeTrackingDifference(input({}, { filledQuantity: -1 })))
      .toThrow(InvalidTrackingDifferenceError);
    expect(() => computeTrackingDifference(input({}, { pricedQuantity: Number.NaN })))
      .toThrow(InvalidTrackingDifferenceError);
  });

  it('rejects a priced quantity larger than the fill it is part of', () => {
    expect(() => computeTrackingDifference(input({}, { filledQuantity: 10, pricedQuantity: 11 })))
      .toThrow(InvalidTrackingDifferenceError);
  });
});

describe('summarizeTrackingDifferences keeps the uncompared visible', () => {
  const worse = computeTrackingDifference(input({ priceUsd: 0.4 }, { pricedNotionalUsd: 42 }));
  const worseHarder = computeTrackingDifference(input({ priceUsd: 0.4 }, { pricedNotionalUsd: 76 }));
  const better = computeTrackingDifference(input({ priceUsd: 0.4 }, { pricedNotionalUsd: 38 }));
  const matched = computeTrackingDifference(input({ priceUsd: 0.4 }, { pricedNotionalUsd: 40 }));
  const masterUnknown = computeTrackingDifference(input({ priceUsd: null, amountUsd: null, quantity: null }));
  const userUnknown = computeTrackingDifference(input({}, { pricedQuantity: 0, pricedNotionalUsd: 0 }));

  it('returns nulls, not zeros, for an empty set', () => {
    const summary = summarizeTrackingDifferences([]);
    expect(summary).toMatchObject({
      total: 0,
      comparedCount: 0,
      uncomparedCount: 0,
      matchedCount: 0,
      medianAdverseBps: null,
      meanAdverseBps: null,
      totalAdverseUsd: null
    });
    expect(summary.medianAdverseBps).not.toBe(0);
    expect(summary.totalAdverseUsd).not.toBe(0);
  });

  it('returns nulls when nothing in a non-empty set could be compared', () => {
    // The robinhood-chain reality: rows exist, none of them is a number. A zero
    // median here would read as "you track the master perfectly".
    const summary = summarizeTrackingDifferences([masterUnknown, masterUnknown, userUnknown]);
    expect(summary.total).toBe(3);
    expect(summary.comparedCount).toBe(0);
    expect(summary.uncomparedCount).toBe(3);
    expect(summary.medianAdverseBps).toBeNull();
    expect(summary.meanAdverseBps).toBeNull();
    expect(summary.totalAdverseUsd).toBeNull();
    expect(summary.uncomparedByCode).toEqual({
      'master-price-unknown': 2,
      'user-price-unknown': 1
    });
  });

  it('attributes every refusal to a code so an empty comparison is explainable', () => {
    const summary = summarizeTrackingDifferences([worse, masterUnknown, userUnknown]);
    expect(summary.comparedCount).toBe(1);
    expect(summary.uncomparedCount).toBe(2);
    expect(Object.values(summary.uncomparedByCode).reduce((a, b) => a + b, 0))
      .toBe(summary.uncomparedCount);
  });

  it('counts a genuine match separately from a refusal to compare', () => {
    const summary = summarizeTrackingDifferences([matched, masterUnknown]);
    expect(summary.matchedCount).toBe(1);
    expect(summary.worseForUserCount).toBe(0);
    expect(summary.betterForUserCount).toBe(0);
    expect(summary.uncomparedCount).toBe(1);
  });

  it('reports median and mean, which disagree on a skewed set', () => {
    const summary = summarizeTrackingDifferences([better, worse, worseHarder]);
    // bps are -500, +500, +9000: the median is the typical experience, the mean is
    // dragged by the one bad fill.
    expect(summary.medianAdverseBps).toBeCloseTo(500, 6);
    expect(summary.meanAdverseBps).toBeCloseTo(3_000, 6);
    expect(summary.worseForUserCount).toBe(2);
    expect(summary.betterForUserCount).toBe(1);
  });

  it('sums the dollar figures and says how much of the set they cover', () => {
    const partial = computeTrackingDifference(
      input({ priceUsd: 0.4 }, { filledQuantity: 100, pricedQuantity: 60, pricedNotionalUsd: 25.2 })
    );
    const summary = summarizeTrackingDifferences([worse, partial, masterUnknown]);
    expect(summary.totalAdverseUsd).toBeCloseTo(3.2, 9);
    expect(summary.adverseUsdPartialCount).toBe(1);
    expect(summary.adverseUsdMissingCount).toBe(0);
    expect(summary.uncomparedCount).toBe(1);
    expect(summary.feeBasis).toBe(TRACKING_DIFFERENCE_FEE_BASIS);
  });
});

// ── DB half, with the executor injected ───────────────────────────────────────

function dbRow(overrides: Partial<TrackingDifferenceDbRow> = {}): TrackingDifferenceDbRow {
  return {
    execution_id: 'execution-1',
    signal_id: 'signal-1',
    source_trade_id: 'source-1',
    chain: 'polygon',
    target_account: 'operator',
    user_id: null,
    token_mint: 'polygon:0xabc',
    execution_mode: 'live',
    state: 'confirmed',
    user_side: 'buy',
    master_side: 'buy',
    master_price_usd: '0.40000000',
    master_amount_usd: '40.00',
    master_quantity: '100',
    master_event_at: MASTER_EVENT_AT,
    user_filled_quantity: '100',
    user_priced_quantity: '100',
    user_priced_notional_usd: '42.00',
    user_first_fill_at: USER_FILL_AT,
    ...overrides
  };
}

function stubExecutor(rows: TrackingDifferenceDbRow[]): {
  execute: TrackingDifferenceQuery;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const execute = (async <R extends QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<R[]> => {
    calls.push({ sql, params: params ?? [] });
    return rows as unknown as R[];
  }) as TrackingDifferenceQuery;
  return { execute, calls };
}

describe('mapTrackingDifferenceRow', () => {
  it('parses NUMERIC-as-text into the pure input', () => {
    const mapped = mapTrackingDifferenceRow(dbRow());
    expect(mapped.master.priceUsd).toBeCloseTo(0.4, 12);
    expect(mapped.master.amountUsd).toBe(40);
    expect(mapped.master.quantity).toBe(100);
    expect(mapped.user.filledQuantity).toBe(100);
    expect(mapped.user.pricedNotionalUsd).toBe(42);
    expect(mapped.master.eventAt).toBe(MASTER_EVENT_AT);
    expect(mapped.user.firstFillAt).toBe(USER_FILL_AT);
  });

  it('keeps a NULL price as null rather than parsing it to zero', () => {
    const mapped = mapTrackingDifferenceRow(dbRow({ master_price_usd: null, master_amount_usd: null }));
    expect(mapped.master.priceUsd).toBeNull();
    expect(mapped.master.amountUsd).toBeNull();
  });

  it('throws on unparseable numeric text instead of calling it unknown', () => {
    expect(() => mapTrackingDifferenceRow(dbRow({ master_price_usd: 'NaN' })))
      .toThrow(InvalidTrackingDifferenceError);
    expect(() => mapTrackingDifferenceRow(dbRow({ user_filled_quantity: 'oops' })))
      .toThrow(InvalidTrackingDifferenceError);
  });

  it('throws when our own execution direction violates the migration-028 CHECK', () => {
    expect(() => mapTrackingDifferenceRow(dbRow({ user_side: 'transfer_in' })))
      .toThrow(/copy_executions.direction must be buy or sell/);
  });

  it('accepts a transfer on the master side, which the schema does allow', () => {
    const record = toTrackingDifferenceRecord(dbRow({ master_side: 'transfer_out' }));
    expect(record.difference.code).toBe('master-side-not-tradeable');
    expect(record.difference.adverseBps).toBeNull();
  });
});

describe('toTrackingDifferenceRecord', () => {
  it('carries identity and lifecycle state alongside the difference', () => {
    const record = toTrackingDifferenceRecord(dbRow({ state: 'reconciliation_required' }));
    expect(record).toMatchObject({
      executionId: 'execution-1',
      signalId: 'signal-1',
      sourceTradeId: 'source-1',
      chain: 'polygon',
      targetAccount: 'operator',
      userId: null,
      tokenMint: 'polygon:0xabc',
      executionMode: 'live',
      state: 'reconciliation_required'
    });
    // State is passed through, not branched on: a distrusted ledger is a product
    // call for the surface, not arithmetic.
    expect(record.difference.code).toBe('computed');
  });
});

describe('loadTrackingDifferences', () => {
  it('reads confirmed and finalized evidence only, splitting priced from unpriced', () => {
    const { execute, calls } = stubExecutor([dbRow()]);
    return loadTrackingDifferences(execute).then((records) => {
      const [call] = calls;
      const sql = (call as { sql: string }).sql;
      // Same predicate `recordCopyExecutionEvidence` uses for the execution totals,
      // so this read cannot disagree with them about what filled.
      expect(sql).toContain("evidence.confirmation_state IN ('confirmed', 'finalized')");
      // The priced/unpriced split, without which SUM's NULL-skipping would understate
      // our price by the unpriced share.
      expect(sql).toContain('FILTER (WHERE evidence.price_usd IS NOT NULL)');
      expect(sql).toContain('JOIN source_trades st ON st.id = ce.source_trade_id');
      // `quote_quantity` is deliberately absent: it is SOL on Solana and ETH on
      // robinhood-chain, so it is not a USD price.
      expect(sql).not.toContain('quote_quantity');
      expect(records).toHaveLength(1);
      expect((records[0] as { difference: TrackingDifference }).difference.adverseBps)
        .toBeCloseTo(500, 6);
    });
  });

  it('passes no filters as nulls and a default limit', async () => {
    const { execute, calls } = stubExecutor([]);
    await loadTrackingDifferences(execute);
    expect((calls[0] as { params: unknown[] }).params).toEqual([null, null, null, false, null, 100]);
  });

  it('filters by execution ids, signal and target account', async () => {
    const { execute, calls } = stubExecutor([]);
    await loadTrackingDifferences(execute, {
      executionIds: ['execution-1', 'execution-2'],
      signalId: 'signal-9',
      targetAccount: 'operator',
      limit: 25
    });
    expect((calls[0] as { params: unknown[] }).params).toEqual([
      ['execution-1', 'execution-2'],
      'signal-9',
      'operator',
      false,
      null,
      25
    ]);
  });

  it('treats an empty execution-id list as no filter rather than as match-nothing', async () => {
    const { execute, calls } = stubExecutor([]);
    await loadTrackingDifferences(execute, { executionIds: [] });
    expect((calls[0] as { params: unknown[] }).params[0]).toBeNull();
  });

  it('distinguishes "no tenant filter" from "the operator rows only"', async () => {
    // `undefined` must not become `IS NULL`, or a tenant query would silently return
    // the pre-multi-tenant operator rows instead of the tenant's own.
    const absent = stubExecutor([]);
    await loadTrackingDifferences(absent.execute, {});
    expect((absent.calls[0] as { params: unknown[] }).params.slice(3, 5)).toEqual([false, null]);

    const operatorOnly = stubExecutor([]);
    await loadTrackingDifferences(operatorOnly.execute, { userId: null });
    expect((operatorOnly.calls[0] as { params: unknown[] }).params.slice(3, 5)).toEqual([true, null]);

    const tenant = stubExecutor([]);
    await loadTrackingDifferences(tenant.execute, { userId: 'user-7' });
    expect((tenant.calls[0] as { params: unknown[] }).params.slice(3, 5)).toEqual([true, 'user-7']);
    expect((tenant.calls[0] as { sql: string }).sql)
      .toContain('ce.user_id IS NOT DISTINCT FROM $5::uuid');
  });

  it('rejects a nonsensical limit instead of trusting the caller', async () => {
    const { execute } = stubExecutor([]);
    await expect(loadTrackingDifferences(execute, { limit: 0 }))
      .rejects.toThrow(InvalidTrackingDifferenceError);
    await expect(loadTrackingDifferences(execute, { limit: 5_000 }))
      .rejects.toThrow(InvalidTrackingDifferenceError);
    await expect(loadTrackingDifferences(execute, { limit: 2.5 }))
      .rejects.toThrow(InvalidTrackingDifferenceError);
  });
});

describe('loadTrackingDifferenceSummary', () => {
  it('returns the records and a summary that discloses what it could not compare', async () => {
    const { execute } = stubExecutor([
      dbRow(),
      dbRow({ execution_id: 'execution-2', master_price_usd: null, master_amount_usd: null })
    ]);
    const { records, summary } = await loadTrackingDifferenceSummary(execute);
    expect(records).toHaveLength(2);
    expect(summary.total).toBe(2);
    expect(summary.comparedCount).toBe(1);
    expect(summary.uncomparedCount).toBe(1);
    expect(summary.uncomparedByCode).toEqual({ 'master-price-unknown': 1 });
    expect(summary.medianAdverseBps).toBeCloseTo(500, 6);
  });
});
