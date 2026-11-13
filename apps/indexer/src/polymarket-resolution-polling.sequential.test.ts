import { describe, expect, it, vi } from 'vitest';
import {
  pollPolymarketResolutionsBounded,
  withholdUnverifiedResolution,
  type ResolutionPollStore,
  type ResolutionPollState,
  type ResolutionPollDependencies
} from './polymarket-resolution-polling.js';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

// A mocked persistent service shared by separate invocations, not a production cursor.
function fixture(marketIds = [id(1), id(2)]) {
  let state: ResolutionPollState = { token: 'lease-1', after: null, upper: marketIds.at(-1) ?? null, attempted: 0, failed: 0 };
  const visited: string[] = [];
  const store: ResolutionPollStore<null> = {
    claim: vi.fn(async () => ({ ...state })),
    fetchPage: vi.fn(async (_state, limit) => marketIds.filter(key => (!state.after || key > state.after) && (!state.upper || key <= state.upper))
      .slice(0, limit).map(conditionId => ({ conditionId, tickSize: null }))),
    reserveAttempt: vi.fn(async (_state, conditionId) => {
      state = { ...state, after: conditionId, attempted: state.attempted + 1, failed: state.failed + 1 };
      return { ...state };
    }),
    settleCovered: vi.fn(async () => { state = { ...state, failed: state.failed - 1 }; return { ...state }; }),
    finishCycle: vi.fn(async () => {}),
    release: vi.fn(async () => {})
  };
  const dependencies: ResolutionPollDependencies<null> = {
    store,
    createMetadataBudget: ({ maxRequests = 100, maxBytes = 1024, timeoutMs = 30_000 } = {}) => ({
      remainingRequests: maxRequests, remainingBytes: maxBytes, timeoutMs, deadlineAt: null
    }),
    fetchGammaMarket: vi.fn(async (conditionId, _fetch, budget) => {
      budget.remainingRequests--;
      budget.remainingBytes -= 10;
      visited.push(conditionId);
      return { closed: false };
    }),
    isMetadataBudgetError: () => false,
    interpretMetadata: () => null,
    fetchImpl: vi.fn(),
    ownerToken: () => 'lease-1'
  };
  return { store, dependencies, visited };
}

describe('bounded resolution polling public seam', () => {
  it('resumes a bounded keyset cycle through a fresh invocation instead of repeating the prefix', async () => {
    const { dependencies, visited } = fixture();
    const first = await pollPolymarketResolutionsBounded(dependencies, { maxMarkets: 1 });
    expect(first).toMatchObject({ coverage: 'partial', cycleFinished: false, attemptedThisRun: 1, reason: 'market-limit' });
    expect(first.continuation).toEqual({ after: id(1), upper: id(2) });
    const second = await pollPolymarketResolutionsBounded({ ...dependencies }, { maxMarkets: 1 });
    expect(second).toMatchObject({ coverage: 'complete', cycleFinished: true, cycleAttempted: 2, cycleFailed: 0 });
    expect(visited).toEqual([id(1), id(2)]);
  });

  it('stops on the shared request budget without reserving unseen markets', async () => {
    const { dependencies, visited, store } = fixture([id(1), id(2), id(3)]);
    const result = await pollPolymarketResolutionsBounded(dependencies, { maxRequests: 1 });
    expect(result).toMatchObject({ coverage: 'partial', reason: 'metadata-budget', attemptedThisRun: 1 });
    expect(result.continuation?.after).toBe(id(1));
    expect(visited).toEqual([id(1)]);
    expect(store.reserveAttempt).toHaveBeenCalledTimes(1);
  });

  it('refuses a late completed metadata observation before any covered DB write', async () => {
    vi.useFakeTimers();
    try {
      const { dependencies, store } = fixture([id(1)]);
      dependencies.fetchGammaMarket = async () => {
        vi.spyOn(performance, 'now').mockReturnValue(1_000_000);
        return { closed: true, outcomePrices: ['1', '0'] };
      };
      const result = await pollPolymarketResolutionsBounded(dependencies, { timeoutMs: 1 });
      expect(result).toMatchObject({ coverage: 'partial', reason: 'deadline', cycleFailed: 1 });
      expect(store.settleCovered).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('does not turn a cursor/observation DB failure into a successful scan', async () => {
    const { dependencies, store } = fixture([id(1)]);
    vi.mocked(store.settleCovered).mockRejectedValueOnce(new Error('database write failed'));
    await expect(pollPolymarketResolutionsBounded(dependencies)).rejects.toMatchObject({
      result: { coverage: 'partial', cycleFinished: false, cycleFailed: 1 }
    });
    expect(store.finishCycle).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, 1_001])('rejects invalid scan market limit %s before storage', async maxMarkets => {
    const { dependencies, store } = fixture();
    await expect(pollPolymarketResolutionsBounded(dependencies, { maxMarkets })).rejects.toThrow('Invalid resolution poll maxMarkets');
    expect(store.claim).not.toHaveBeenCalled();
  });

  it('refuses oversized or unordered keyset pages instead of claiming coverage', async () => {
    const { dependencies, store } = fixture();
    vi.mocked(store.fetchPage).mockResolvedValueOnce([
      { conditionId: id(2), tickSize: null }, { conditionId: id(1), tickSize: null }
    ]);
    await expect(pollPolymarketResolutionsBounded(dependencies)).rejects.toThrow('storage failure');
    expect(store.reserveAttempt).not.toHaveBeenCalled();
  });

  it('keeps durable pessimistic failures after an ordinary provider error and still visits later markets', async () => {
    const { dependencies, visited } = fixture();
    const read = dependencies.fetchGammaMarket;
    dependencies.fetchGammaMarket = async (conditionId, fetchImpl, budget) => {
      if (conditionId === id(1)) throw new Error('poisoned market');
      return read(conditionId, fetchImpl, budget);
    };
    const result = await pollPolymarketResolutionsBounded(dependencies);
    expect(result).toMatchObject({ coverage: 'partial', cycleFinished: true, cycleAttempted: 2, cycleFailed: 1 });
    expect(visited).toEqual([id(2)]);
  });

  it('limits page fetches and bounds each returned page to capacity plus one lookahead', async () => {
    const { dependencies, store } = fixture([id(1), id(2), id(3)]);
    const result = await pollPolymarketResolutionsBounded(dependencies, { pageSize: 1, maxDbFetches: 1 });
    expect(result).toMatchObject({ reason: 'db-fetch-limit', dbFetches: 1, attemptedThisRun: 1 });
    expect(store.fetchPage).toHaveBeenCalledWith(expect.anything(), 2);
  });

  it('safe default handler withholds price-implied winners and reports resolution functionality blocked', async () => {
    const { dependencies } = fixture([id(1)]);
    dependencies.interpretMetadata = withholdUnverifiedResolution;
    dependencies.fetchGammaMarket = async () => ({ conditionId: id(1), closed: true, outcomePrices: ['0.999', '0.001'] });
    const result = await pollPolymarketResolutionsBounded(dependencies);
    expect(result).toMatchObject({ coverage: 'complete', economicResolution: 'blocked-unverified-evidence' });
  });

  it('refuses mismatched provider condition IDs before reporting metadata coverage', async () => {
    const { dependencies, store } = fixture([id(1)]);
    dependencies.interpretMetadata = withholdUnverifiedResolution;
    dependencies.fetchGammaMarket = async () => ({ conditionId: id(2), closed: false });
    const result = await pollPolymarketResolutionsBounded(dependencies);
    expect(result).toMatchObject({ coverage: 'partial', cycleFailed: 1 });
    expect(store.settleCovered).not.toHaveBeenCalled();
  });

  it('a reservation finishing after deadline does not start provider work', async () => {
    const { dependencies, store } = fixture([id(1)]);
    const reserve = store.reserveAttempt;
    store.reserveAttempt = async (...args) => {
      const progress = await reserve(...args);
      vi.spyOn(performance, 'now').mockReturnValue(1_000_000);
      return progress;
    };
    try {
      const result = await pollPolymarketResolutionsBounded(dependencies, { timeoutMs: 1_000 });
      expect(result).toMatchObject({ reason: 'deadline', cycleFailed: 1 });
      expect(dependencies.fetchGammaMarket).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });

  it('eventually attempts market 101 across bounded independent invocations', async () => {
    const { dependencies, visited } = fixture(Array.from({ length: 101 }, (_, index) => id(index + 1)));
    const results = [];
    for (let run = 0; run < 5; run++) results.push(await pollPolymarketResolutionsBounded({ ...dependencies }));
    expect(visited).toHaveLength(101);
    expect(visited.at(-1)).toBe(id(101));
    expect(results.at(-1)).toMatchObject({ coverage: 'complete', cycleAttempted: 101 });
    expect(results.slice(0, 4).every(result => result.coverage === 'partial')).toBe(true);
  });

  it('byte exhaustion stops without advancing the next market', async () => {
    const { dependencies, visited } = fixture();
    const result = await pollPolymarketResolutionsBounded(dependencies, { maxBytes: 10 });
    expect(result).toMatchObject({ reason: 'metadata-budget', attemptedThisRun: 1 });
    expect(visited).toEqual([id(1)]);
  });

  it('late DB settlement is reported incomplete even though its write already committed', async () => {
    const { dependencies, store } = fixture([id(1)]);
    const settle = store.settleCovered;
    store.settleCovered = async (...args) => {
      const progress = await settle(...args);
      vi.spyOn(performance, 'now').mockReturnValue(1_000_000);
      return progress;
    };
    try {
      const result = await pollPolymarketResolutionsBounded(dependencies);
      expect(result).toMatchObject({ coverage: 'partial', reason: 'deadline', coveredThisRun: 1, cycleFinished: false });
      expect(store.finishCycle).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });

  it('a failed durable claim reports unknown incomplete coverage without provider work', async () => {
    const { dependencies, store } = fixture();
    vi.mocked(store.claim).mockRejectedValueOnce(new Error('missing polling table'));
    await expect(pollPolymarketResolutionsBounded(dependencies)).rejects.toMatchObject({
      result: { coverage: 'partial', cycleFinished: false, continuation: null }
    });
    expect(dependencies.fetchGammaMarket).not.toHaveBeenCalled();
  });

  it('does not report on-time completion when final lease release finishes late', async () => {
    const { dependencies, store } = fixture([id(1)]);
    store.release = async () => { vi.spyOn(performance, 'now').mockReturnValue(1_000_000); };
    try {
      const result = await pollPolymarketResolutionsBounded(dependencies);
      expect(result).toMatchObject({ coverage: 'partial', cycleFinished: true, reason: 'deadline' });
    } finally { vi.restoreAllMocks(); }
  });
});
