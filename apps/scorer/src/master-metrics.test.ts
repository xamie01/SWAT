import { describe, expect, it, vi } from 'vitest';

// `master-metrics.ts` imports `query` from @swat/db, whose barrel eagerly
// constructs the pg pool. Nothing here connects - every DB call in the batch is
// an injected dependency - but the module demands a URL at import time.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://master-metrics-unit-test/unused';
});

// The oracle. `calculateAverageCostPnl` is the repo's existing average-cost
// ledger; asserting our round-trip walker sums to its `realizedPnlUsd` is what
// stops the two conventions drifting apart.
import { calculateAverageCostPnl } from '@swat/db';

// `PositionLedgerTrade` is declared in `packages/db/src/pnl-math.ts` but is not
// re-exported by `pnl-queries.ts`, so it is not reachable through `@swat/db` in
// either `src` or `dist`. Structurally identical local copy rather than a change
// to a package this item may not touch.
type PositionLedgerTrade = {
  direction: 'buy' | 'sell';
  tokenAmount: number;
  amountUsd: number;
  feeUsd?: number;
};

import {
  DEFAULT_MIN_TRADES_BY_WINDOW,
  MASTER_METRIC_WINDOWS,
  ROUND_TRIP_LOOKBACK_MS,
  buildMasterRoundTrips,
  compareWindows,
  computeMasterMetrics,
  computeWindowMetrics,
  formatMasterMetricsLine,
  median,
  realizedMaxDrawdownUsd,
  resolveMinTradesByWindow,
  roundTripsInWindow,
  runMasterMetricsBatch,
  type MasterMetricsBatchDependencies,
  type MasterRoundTrip,
  type MasterTradeRow,
  type MasterWindowFigures
} from './master-metrics.js';

const T0 = new Date('2026-08-20T00:00:00.000Z');
const HOUR = 3_600_000;
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

function row(overrides: Partial<MasterTradeRow> = {}): MasterTradeRow {
  return {
    walletAddress: 'solana:MASTER',
    chain: 'solana',
    tokenMint: 'solana:TOKEN-A',
    direction: 'buy',
    tokenAmount: 100,
    amountUsd: 1000,
    feeUsd: null,
    eventAt: at(0),
    ...overrides
  };
}

function roundTrip(overrides: Partial<MasterRoundTrip> = {}): MasterRoundTrip {
  const openedAt = overrides.openedAt ?? at(0);
  const closedAt = overrides.closedAt ?? at(1);
  return {
    walletAddress: 'solana:MASTER',
    chain: 'solana',
    tokenMint: 'solana:TOKEN-A',
    openedAt,
    closedAt,
    holdMs: closedAt.getTime() - openedAt.getTime(),
    costBasisUsd: 1000,
    proceedsUsd: 1100,
    realizedPnlUsd: 100,
    feeUsd: 0,
    feesRecorded: false,
    legs: 2,
    ...overrides
  };
}

/** The five-trade window sample used by several assertions below. */
function sampleWindowRoundTrips(): MasterRoundTrip[] {
  return [
    roundTrip({ openedAt: at(0), closedAt: at(1), realizedPnlUsd: 100 }),
    roundTrip({ openedAt: at(1), closedAt: at(3), realizedPnlUsd: -50 }),
    roundTrip({ openedAt: at(2), closedAt: at(5), realizedPnlUsd: -80 }),
    roundTrip({ openedAt: at(3), closedAt: at(7), realizedPnlUsd: 30 }),
    roundTrip({ openedAt: at(4), closedAt: at(9), realizedPnlUsd: 200 })
  ];
}

function ok(metrics: ReturnType<typeof computeWindowMetrics>): MasterWindowFigures {
  if (metrics.status !== 'ok') {
    throw new Error(`expected figures, got ${metrics.status} for ${metrics.window}`);
  }
  return metrics;
}

describe('buildMasterRoundTrips', () => {
  it('pairs one buy to one sell and reports basis, proceeds, PnL and hold time', () => {
    const set = buildMasterRoundTrips([
      row({ direction: 'buy', tokenAmount: 100, amountUsd: 1000, eventAt: at(0) }),
      row({ direction: 'sell', tokenAmount: 100, amountUsd: 1500, eventAt: at(2) })
    ]);

    expect(set.roundTrips).toHaveLength(1);
    expect(set.openEpisodes).toBe(0);
    expect(set.unmatchedSells).toBe(0);
    const [trip] = set.roundTrips;
    expect(trip!.costBasisUsd).toBe(1000);
    expect(trip!.proceedsUsd).toBe(1500);
    expect(trip!.realizedPnlUsd).toBe(500);
    expect(trip!.holdMs).toBe(2 * HOUR);
    expect(trip!.openedAt).toEqual(at(0));
    expect(trip!.closedAt).toEqual(at(2));
    expect(trip!.legs).toBe(2);
  });

  it('folds fees into basis and proceeds, and agrees with calculateAverageCostPnl', () => {
    const legs: PositionLedgerTrade[] = [
      { direction: 'buy', tokenAmount: 100, amountUsd: 1000, feeUsd: 10 },
      { direction: 'sell', tokenAmount: 100, amountUsd: 1500, feeUsd: 5 }
    ];
    const set = buildMasterRoundTrips([
      row({ direction: 'buy', tokenAmount: 100, amountUsd: 1000, feeUsd: 10, eventAt: at(0) }),
      row({ direction: 'sell', tokenAmount: 100, amountUsd: 1500, feeUsd: 5, eventAt: at(1) })
    ]);

    // 1500 - 5 - (1000 + 10) = 485
    expect(set.roundTrips[0]!.realizedPnlUsd).toBeCloseTo(485, 10);
    expect(set.roundTrips[0]!.feeUsd).toBeCloseTo(15, 10);
    expect(set.roundTrips[0]!.feesRecorded).toBe(true);
    expect(set.roundTrips[0]!.realizedPnlUsd)
      .toBeCloseTo(calculateAverageCostPnl(legs, null)!.realizedPnlUsd, 10);
  });

  it('folds partial exits into one round trip closing at the final leg', () => {
    const legs: PositionLedgerTrade[] = [
      { direction: 'buy', tokenAmount: 100, amountUsd: 1000 },
      { direction: 'sell', tokenAmount: 40, amountUsd: 500 },
      { direction: 'sell', tokenAmount: 60, amountUsd: 900 }
    ];
    const set = buildMasterRoundTrips([
      row({ direction: 'buy', tokenAmount: 100, amountUsd: 1000, eventAt: at(0) }),
      row({ direction: 'sell', tokenAmount: 40, amountUsd: 500, eventAt: at(1) }),
      row({ direction: 'sell', tokenAmount: 60, amountUsd: 900, eventAt: at(3) })
    ]);

    expect(set.roundTrips).toHaveLength(1);
    const [trip] = set.roundTrips;
    expect(trip!.realizedPnlUsd).toBeCloseTo(400, 10);
    expect(trip!.costBasisUsd).toBeCloseTo(1000, 10);
    expect(trip!.proceedsUsd).toBeCloseTo(1400, 10);
    expect(trip!.holdMs).toBe(3 * HOUR);
    expect(trip!.legs).toBe(3);
    // Same ledger through the repo's existing average-cost function.
    expect(trip!.realizedPnlUsd)
      .toBeCloseTo(calculateAverageCostPnl(legs, null)!.realizedPnlUsd, 10);
  });

  it('excludes a still-open position instead of emitting a zero-return trade', () => {
    const set = buildMasterRoundTrips([
      row({ direction: 'buy', tokenAmount: 100, amountUsd: 1000, eventAt: at(0) }),
      row({ direction: 'sell', tokenAmount: 40, amountUsd: 500, eventAt: at(1) })
    ]);

    expect(set.roundTrips).toHaveLength(0);
    expect(set.openEpisodes).toBe(1);
    expect(set.incompleteEpisodes).toBe(0);
  });

  it('records a sell with nothing open as unmatched rather than a phantom trade', () => {
    const set = buildMasterRoundTrips([
      row({ direction: 'sell', tokenAmount: 50, amountUsd: 100, eventAt: at(0) })
    ]);

    expect(set.roundTrips).toHaveLength(0);
    expect(set.unmatchedSells).toBe(1);
    expect(set.openEpisodes).toBe(0);
  });

  it('caps an oversized sell at the visible quantity and pro-rates its proceeds', () => {
    const set = buildMasterRoundTrips([
      row({ direction: 'buy', tokenAmount: 100, amountUsd: 1000, eventAt: at(0) }),
      row({ direction: 'sell', tokenAmount: 150, amountUsd: 3000, eventAt: at(1) })
    ]);

    expect(set.unmatchedSells).toBe(1);
    expect(set.roundTrips).toHaveLength(1);
    // 100 of 150 credited: proceeds 3000 * 2/3 = 2000, basis 1000.
    expect(set.roundTrips[0]!.proceedsUsd).toBeCloseTo(2000, 10);
    expect(set.roundTrips[0]!.realizedPnlUsd).toBeCloseTo(1000, 10);
  });

  it('excludes an episode with a leg missing amountUsd', () => {
    const set = buildMasterRoundTrips([
      row({ direction: 'buy', tokenAmount: 100, amountUsd: null, eventAt: at(0) }),
      row({ direction: 'sell', tokenAmount: 100, amountUsd: 1500, eventAt: at(1) })
    ]);

    expect(set.roundTrips).toHaveLength(0);
    expect(set.incompleteEpisodes).toBe(1);
  });

  it('ignores non-mirrorable directions such as transfers', () => {
    const transfer = { ...row({ eventAt: at(0) }), direction: 'transfer_in' } as unknown as MasterTradeRow;
    const set = buildMasterRoundTrips([
      transfer,
      row({ direction: 'buy', tokenAmount: 100, amountUsd: 1000, eventAt: at(1) }),
      row({ direction: 'sell', tokenAmount: 100, amountUsd: 1200, eventAt: at(2) })
    ]);

    expect(set.roundTrips).toHaveLength(1);
    expect(set.roundTrips[0]!.legs).toBe(2);
    expect(set.roundTrips[0]!.costBasisUsd).toBe(1000);
  });

  it('sorts unordered rows and keeps re-entries as separate round trips', () => {
    const set = buildMasterRoundTrips([
      row({ direction: 'sell', tokenAmount: 100, amountUsd: 1500, eventAt: at(4) }),
      row({ direction: 'buy', tokenAmount: 100, amountUsd: 1000, eventAt: at(3) }),
      row({ direction: 'sell', tokenAmount: 100, amountUsd: 900, eventAt: at(2) }),
      row({ direction: 'buy', tokenAmount: 100, amountUsd: 1000, eventAt: at(1) })
    ]);

    expect(set.roundTrips).toHaveLength(2);
    expect(set.roundTrips.map((trip) => trip.realizedPnlUsd)).toEqual([-100, 500]);
    expect(set.roundTrips.map((trip) => trip.closedAt)).toEqual([at(2), at(4)]);
  });

  it('keeps separate tokens in separate episodes', () => {
    const set = buildMasterRoundTrips([
      row({ tokenMint: 'solana:TOKEN-A', direction: 'buy', amountUsd: 1000, eventAt: at(0) }),
      row({ tokenMint: 'solana:TOKEN-B', direction: 'buy', amountUsd: 2000, eventAt: at(1) }),
      row({ tokenMint: 'solana:TOKEN-A', direction: 'sell', amountUsd: 1100, eventAt: at(2) }),
      row({ tokenMint: 'solana:TOKEN-B', direction: 'sell', amountUsd: 1500, eventAt: at(3) })
    ]);

    expect(set.roundTrips.map((trip) => trip.tokenMint)).toEqual(['solana:TOKEN-A', 'solana:TOKEN-B']);
    expect(set.roundTrips.map((trip) => trip.realizedPnlUsd)).toEqual([100, -500]);
  });
});

describe('median', () => {
  it('returns the middle value of an odd sample', () => {
    expect(median([300, 60, 180, 120, 240])).toBe(180);
  });

  it('averages the two middle values of an even sample', () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it('returns null for an empty sample', () => {
    expect(median([])).toBeNull();
  });
});

describe('realizedMaxDrawdownUsd', () => {
  it('measures peak-to-trough of the cumulative PnL curve', () => {
    // cum: 100, 50, -30, 0 against a peak of 100 -> worst 130
    const trips = [100, -50, -80, 30].map((pnl) => ({ realizedPnlUsd: pnl }));
    expect(realizedMaxDrawdownUsd(trips)).toBe(130);
  });

  it('reports the whole loss when the curve never rises', () => {
    expect(realizedMaxDrawdownUsd([{ realizedPnlUsd: -10 }, { realizedPnlUsd: -20 }])).toBe(30);
  });

  it('is zero for a monotonically rising curve', () => {
    expect(realizedMaxDrawdownUsd([{ realizedPnlUsd: 10 }, { realizedPnlUsd: 5 }])).toBe(0);
  });
});

describe('roundTripsInWindow', () => {
  it('assigns round trips by exit time', () => {
    const trips = [
      roundTrip({ openedAt: at(-40 * 24), closedAt: at(-20 * 24) }),
      roundTrip({ openedAt: at(-10), closedAt: at(-2) }),
      roundTrip({ openedAt: at(0), closedAt: at(1) })
    ];
    const asOf = at(2);

    expect(roundTripsInWindow(trips, '24h', asOf)).toHaveLength(2);
    expect(roundTripsInWindow(trips, '7d', asOf)).toHaveLength(2);
    expect(roundTripsInWindow(trips, '30d', asOf)).toHaveLength(3);
  });
});

describe('computeWindowMetrics', () => {
  it('reports insufficient history rather than a number below the minimum', () => {
    const metrics = computeWindowMetrics('30d', sampleWindowRoundTrips(), at(24), 20);

    expect(metrics.status).toBe('insufficient_history');
    expect(metrics.tradeCount).toBe(5);
    expect(metrics.minTradeCount).toBe(20);
    // No figure of any kind leaks out of a gated window.
    expect(Object.keys(metrics)).toEqual(['window', 'windowStartAt', 'tradeCount', 'minTradeCount', 'status']);
  });

  it('computes PnL, hit rate, drawdown and median hold for a sufficient window', () => {
    const metrics = ok(computeWindowMetrics('24h', sampleWindowRoundTrips(), at(24), 5));

    expect(metrics.tradeCount).toBe(5);
    expect(metrics.pnlNetUsd).toBe(200);
    expect(metrics.pnlPerTradeUsd).toBe(40);
    expect(metrics.deployedCapitalUsd).toBe(5000);
    expect(metrics.winCount).toBe(3);
    expect(metrics.lossCount).toBe(2);
    expect(metrics.hitRatePct).toBe(60);
    expect(metrics.maxDrawdownUsd).toBe(130);
    expect(metrics.maxDrawdownPctOfDeployedCapital).toBeCloseTo(2.6, 10);
    expect(metrics.medianHoldMinutes).toBe(180);
    expect(metrics.windowStartAt).toEqual(at(0));
  });

  it('never reports a capacity estimate - that is S4-M6', () => {
    const metrics = ok(computeWindowMetrics('24h', sampleWindowRoundTrips(), at(24), 5));
    expect(metrics.capacityEstimate).toBeNull();
    expect(metrics.capacityStatus).toBe('deferred-to-s4-m6');
  });

  it('flags netOfFees false when any contributing leg had no recorded fee', () => {
    const withoutFees = ok(computeWindowMetrics('24h', sampleWindowRoundTrips(), at(24), 5));
    expect(withoutFees.netOfFees).toBe(false);

    const withFees = sampleWindowRoundTrips().map((trip) => ({ ...trip, feesRecorded: true }));
    expect(ok(computeWindowMetrics('24h', withFees, at(24), 5)).netOfFees).toBe(true);
  });

  it('counts a break-even trade as a loss, not a win', () => {
    const trips = [
      roundTrip({ closedAt: at(1), realizedPnlUsd: 0 }),
      roundTrip({ closedAt: at(2), realizedPnlUsd: 10 })
    ];
    const metrics = ok(computeWindowMetrics('24h', trips, at(3), 2));
    expect(metrics.winCount).toBe(1);
    expect(metrics.hitRatePct).toBe(50);
  });

  it('returns a null drawdown percentage when no capital is attributable', () => {
    const trips = [
      roundTrip({ closedAt: at(1), realizedPnlUsd: -5, costBasisUsd: 0 }),
      roundTrip({ closedAt: at(2), realizedPnlUsd: 5, costBasisUsd: 0 })
    ];
    const metrics = ok(computeWindowMetrics('24h', trips, at(3), 2));
    expect(metrics.maxDrawdownUsd).toBe(5);
    expect(metrics.maxDrawdownPctOfDeployedCapital).toBeNull();
  });
});

describe('compareWindows - divergence is the finding', () => {
  const figures = (
    pnlPerTradeUsd: number,
    hitRatePct: number,
    window: '24h' | '7d' | '30d'
  ): MasterWindowFigures => ({
    ...ok(computeWindowMetrics(window, sampleWindowRoundTrips(), at(24), 5)),
    pnlPerTradeUsd,
    hitRatePct
  });

  it('calls a sign flip from strong 30d to negative 24h decaying', () => {
    const result = compareWindows(figures(-10, 20, '24h'), figures(10, 60, '30d'));
    expect(result.trend).toBe('decaying');
    expect(result.relativeChange).toBeCloseTo(-2, 10);
    expect(result.hitRatePctDelta).toBe(-40);
    expect(result.reason).toBeNull();
  });

  it('calls a small change stable', () => {
    const result = compareWindows(figures(10, 55, '24h'), figures(12, 56, '30d'));
    expect(result.trend).toBe('stable');
    expect(result.relativeChange).toBeCloseTo(-2 / 12, 10);
  });

  it('calls a large rise improving', () => {
    const result = compareWindows(figures(30, 70, '24h'), figures(10, 50, '30d'));
    expect(result.trend).toBe('improving');
    expect(result.relativeChange).toBeCloseTo(20 / 30, 10);
  });

  it('treats two flat windows as stable rather than dividing by zero', () => {
    const result = compareWindows(figures(0, 50, '24h'), figures(0, 50, '30d'));
    expect(result.trend).toBe('stable');
    expect(result.relativeChange).toBe(0);
  });

  it('is indeterminate, with a reason, when either side lacks history', () => {
    const gated = computeWindowMetrics('24h', sampleWindowRoundTrips(), at(24), 99);
    const result = compareWindows(gated, figures(10, 50, '30d'));
    expect(result.trend).toBe('indeterminate');
    expect(result.relativeChange).toBeNull();
    expect(result.reason).toBe('insufficient history in 24h');
  });
});

describe('resolveMinTradesByWindow', () => {
  it('defaults to the policy table and scales with the window', () => {
    expect(resolveMinTradesByWindow()).toEqual(DEFAULT_MIN_TRADES_BY_WINDOW);
    expect(DEFAULT_MIN_TRADES_BY_WINDOW['24h']).toBeLessThan(DEFAULT_MIN_TRADES_BY_WINDOW['30d']);
  });

  it('applies per-window overrides and ignores nonsense', () => {
    expect(resolveMinTradesByWindow({ '24h': 2, '7d': 0, '30d': Number.NaN })).toEqual({
      '24h': 2,
      '7d': DEFAULT_MIN_TRADES_BY_WINDOW['7d'],
      '30d': DEFAULT_MIN_TRADES_BY_WINDOW['30d']
    });
  });
});

describe('computeMasterMetrics', () => {
  const relaxed = { '24h': 1, '7d': 1, '30d': 1 } as const;

  it('excludes round trips entered before observation began', () => {
    const report = computeMasterMetrics({
      walletAddress: 'solana:MASTER',
      chain: 'solana',
      rows: [
        // In-sample: entered ten hours before we started watching.
        row({ tokenMint: 'solana:TOKEN-A', direction: 'buy', amountUsd: 1000, eventAt: at(-10) }),
        row({ tokenMint: 'solana:TOKEN-A', direction: 'sell', amountUsd: 5000, eventAt: at(2) }),
        // Out-of-sample.
        row({ tokenMint: 'solana:TOKEN-B', direction: 'buy', amountUsd: 1000, eventAt: at(1) }),
        row({ tokenMint: 'solana:TOKEN-B', direction: 'sell', amountUsd: 1100, eventAt: at(3) })
      ],
      asOf: at(24),
      observationStartAt: at(0),
      minTradesByWindow: relaxed
    });

    expect(report.outOfSampleRoundTrips).toBe(1);
    expect(report.inSampleRoundTripsExcluded).toBe(1);
    const window = ok(report.windows['24h']);
    // The excluded episode's +4000 must not appear anywhere.
    expect(window.pnlNetUsd).toBeCloseTo(100, 10);
    expect(window.tradeCount).toBe(1);
  });

  it('reports insufficient history in every window when observation start is unknown', () => {
    const report = computeMasterMetrics({
      walletAddress: 'solana:MASTER',
      chain: 'solana',
      rows: [
        row({ direction: 'buy', amountUsd: 1000, eventAt: at(1) }),
        row({ direction: 'sell', amountUsd: 1100, eventAt: at(2) })
      ],
      asOf: at(24),
      observationStartAt: null,
      minTradesByWindow: relaxed
    });

    expect(report.outOfSampleRoundTrips).toBe(0);
    for (const window of MASTER_METRIC_WINDOWS) {
      expect(report.windows[window].status).toBe('insufficient_history');
    }
    expect(report.trend).toBe('indeterminate');
  });

  it('does not let an open position dilute hit rate toward zero', () => {
    const report = computeMasterMetrics({
      walletAddress: 'solana:MASTER',
      chain: 'solana',
      rows: [
        row({ tokenMint: 'solana:TOKEN-A', direction: 'buy', amountUsd: 1000, eventAt: at(1) }),
        row({ tokenMint: 'solana:TOKEN-A', direction: 'sell', amountUsd: 1200, eventAt: at(2) }),
        // Still open at asOf.
        row({ tokenMint: 'solana:TOKEN-B', direction: 'buy', amountUsd: 5000, eventAt: at(3) })
      ],
      asOf: at(24),
      observationStartAt: at(0),
      minTradesByWindow: relaxed
    });

    expect(report.openEpisodes).toBe(1);
    const window = ok(report.windows['24h']);
    expect(window.tradeCount).toBe(1);
    expect(window.hitRatePct).toBe(100);
    expect(window.pnlNetUsd).toBeCloseTo(200, 10);
  });

  it('produces all three window pairs and takes 24h-vs-30d as the headline trend', () => {
    const report = computeMasterMetrics({
      walletAddress: 'solana:MASTER',
      chain: 'solana',
      rows: [],
      asOf: at(24),
      observationStartAt: at(0),
      minTradesByWindow: relaxed
    });

    expect(report.divergence.map((entry) => `${entry.shorter}->${entry.longer}`))
      .toEqual(['24h->7d', '7d->30d', '24h->30d']);
    expect(report.trend).toBe('indeterminate');
  });

  it('surfaces a decaying master: strong on 30d, negative on 24h', () => {
    const rows: MasterTradeRow[] = [];
    // Six winners closing between 25 and 30 days ago (30d window only).
    for (let index = 0; index < 6; index++) {
      const token = `solana:OLD-${index}`;
      rows.push(row({ tokenMint: token, direction: 'buy', amountUsd: 1000, eventAt: at(-29 * 24 + index) }));
      rows.push(row({ tokenMint: token, direction: 'sell', amountUsd: 1600, eventAt: at(-28 * 24 + index) }));
    }
    // Three losers closing inside the last 24h.
    for (let index = 0; index < 3; index++) {
      const token = `solana:NEW-${index}`;
      rows.push(row({ tokenMint: token, direction: 'buy', amountUsd: 1000, eventAt: at(-20 + index) }));
      rows.push(row({ tokenMint: token, direction: 'sell', amountUsd: 400, eventAt: at(-10 + index) }));
    }

    const report = computeMasterMetrics({
      walletAddress: 'solana:MASTER',
      chain: 'solana',
      rows,
      asOf: at(0),
      observationStartAt: at(-60 * 24),
      minTradesByWindow: { '24h': 3, '7d': 3, '30d': 3 }
    });

    const short = ok(report.windows['24h']);
    const long = ok(report.windows['30d']);
    expect(short.tradeCount).toBe(3);
    expect(short.pnlNetUsd).toBeCloseTo(-1800, 10);
    expect(short.hitRatePct).toBe(0);
    expect(long.tradeCount).toBe(9);
    expect(long.pnlNetUsd).toBeCloseTo(3600 - 1800, 10);
    expect(report.trend).toBe('decaying');
  });

  it('never emits an ROI field of any kind', () => {
    const report = computeMasterMetrics({
      walletAddress: 'solana:MASTER',
      chain: 'solana',
      rows: [
        row({ direction: 'buy', amountUsd: 1000, eventAt: at(1) }),
        row({ direction: 'sell', amountUsd: 1100, eventAt: at(2) })
      ],
      asOf: at(24),
      observationStartAt: at(0),
      minTradesByWindow: relaxed
    });

    expect(JSON.stringify(report)).not.toMatch(/roi/i);
    expect(JSON.stringify(report)).not.toMatch(/follower/i);
  });
});

describe('formatMasterMetricsLine', () => {
  const report = () => computeMasterMetrics({
    walletAddress: 'solana:MASTER',
    chain: 'solana',
    rows: [
      row({ direction: 'buy', amountUsd: 1000, eventAt: at(1) }),
      row({ direction: 'sell', amountUsd: 1100, eventAt: at(2) })
    ],
    asOf: at(24),
    observationStartAt: at(0),
    minTradesByWindow: { '24h': 1, '7d': 5, '30d': 5 }
  });

  it('says "insufficient history" for a gated window instead of a number', () => {
    const line = formatMasterMetricsLine(report());
    expect(line).toContain('7d: insufficient history (1/5)');
    expect(line).toContain('30d: insufficient history (1/5)');
  });

  it('marks a PnL figure as gross while master fees are unrecorded', () => {
    const line = formatMasterMetricsLine(report());
    expect(line).toContain('pnl=$100.00 (gross of master fees)');
    expect(line).toContain('trend=indeterminate');
  });

  it('never mentions followers or popularity', () => {
    expect(formatMasterMetricsLine(report())).not.toMatch(/follower|popular/i);
  });
});

describe('runMasterMetricsBatch', () => {
  function deps(overrides: Partial<MasterMetricsBatchDependencies> = {}): MasterMetricsBatchDependencies {
    return {
      listMasters: vi.fn().mockResolvedValue([
        { walletAddress: 'solana:MASTER', chain: 'solana', observationStartAt: at(-48) }
      ]),
      fetchTrades: vi.fn().mockResolvedValue([
        row({ direction: 'buy', amountUsd: 1000, eventAt: at(-10) }),
        row({ direction: 'sell', amountUsd: 1100, eventAt: at(-2) })
      ]),
      asOf: at(0),
      minTradesByWindow: { '24h': 1, '7d': 1, '30d': 1 },
      ...overrides
    };
  }

  it('computes one report per master and passes the fetch window through', async () => {
    const dependencies = deps();
    const result = await runMasterMetricsBatch(dependencies);

    expect(result.masters).toBe(1);
    expect(result.reports).toHaveLength(1);
    expect(result.failed).toBe(0);
    expect(dependencies.fetchTrades).toHaveBeenCalledWith({
      walletAddress: 'solana:MASTER',
      chain: 'solana',
      since: at(-48),
      asOf: at(0)
    });
    expect(ok(result.reports[0]!.windows['24h']).pnlNetUsd).toBeCloseTo(100, 10);
  });

  it('clamps an observation start older than the lookback bound', async () => {
    const dependencies = deps({
      listMasters: vi.fn().mockResolvedValue([
        { walletAddress: 'solana:MASTER', chain: 'solana', observationStartAt: at(-365 * 24) }
      ])
    });
    await runMasterMetricsBatch(dependencies);

    expect(dependencies.fetchTrades).toHaveBeenCalledWith(expect.objectContaining({
      since: new Date(at(0).getTime() - ROUND_TRIP_LOOKBACK_MS)
    }));
  });

  it('skips the query entirely when the observation start is unknown', async () => {
    const dependencies = deps({
      listMasters: vi.fn().mockResolvedValue([
        { walletAddress: 'solana:MASTER', chain: 'solana', observationStartAt: null }
      ])
    });
    const result = await runMasterMetricsBatch(dependencies);

    expect(dependencies.fetchTrades).not.toHaveBeenCalled();
    expect(result.insufficientEverywhere).toBe(1);
    expect(result.reports[0]!.observationStartAt).toBeNull();
  });

  it('contains one master failure without losing the rest of the batch', async () => {
    const failing = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([
        row({ direction: 'buy', amountUsd: 1000, eventAt: at(-10) }),
        row({ direction: 'sell', amountUsd: 1100, eventAt: at(-2) })
      ]);
    const dependencies = deps({
      listMasters: vi.fn().mockResolvedValue([
        { walletAddress: 'solana:BROKEN', chain: 'solana', observationStartAt: at(-48) },
        { walletAddress: 'solana:FINE', chain: 'solana', observationStartAt: at(-48) }
      ]),
      fetchTrades: failing
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runMasterMetricsBatch(dependencies);

    expect(result.masters).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]!.walletAddress).toBe('solana:FINE');
    errorSpy.mockRestore();
  });

  it('hands each report to the optional persist hook', async () => {
    const persistReport = vi.fn().mockResolvedValue(undefined);
    await runMasterMetricsBatch(deps({ persistReport }));
    expect(persistReport).toHaveBeenCalledTimes(1);
  });
});
