export type ResolutionMetadataBudget = {
  remainingRequests: number;
  remainingBytes: number;
  timeoutMs: number;
  deadlineAt: number | null;
};

export type ResolutionPollState = {
  token: string;
  after: string | null;
  upper: string | null;
  attempted: number;
  failed: number;
};

export type ResolutionPollMarket = { conditionId: string; tickSize: string | null };

/** No economic writes: closed/price/token metadata is not a resolution certificate. */
export function withholdUnverifiedResolution(market: ResolutionPollMarket, raw: Record<string, unknown>): null {
  if (typeof raw.conditionId !== 'string' || raw.conditionId.toLowerCase() !== market.conditionId
    || typeof raw.closed !== 'boolean') throw new Error('Unverified Polymarket polling metadata');
  return null;
}

/** Production implementations must persist reservations before returning and fence every write. */
export interface ResolutionPollStore<Observation> {
  claim(token: string, leaseMs: number): Promise<ResolutionPollState | null>;
  fetchPage(state: ResolutionPollState, limit: number): Promise<ResolutionPollMarket[]>;
  reserveAttempt(state: ResolutionPollState, conditionId: string): Promise<ResolutionPollState>;
  settleCovered(state: ResolutionPollState, observation: Observation): Promise<ResolutionPollState>;
  finishCycle(state: ResolutionPollState): Promise<void>;
  release(state: ResolutionPollState): Promise<void>;
}

export type ResolutionPollDependencies<Observation> = {
  store: ResolutionPollStore<Observation>;
  createMetadataBudget(limits?: { maxRequests?: number; timeoutMs?: number; maxBytes?: number }): ResolutionMetadataBudget;
  fetchGammaMarket(conditionId: string, fetchImpl: typeof fetch, budget: ResolutionMetadataBudget): Promise<Record<string, unknown>>;
  isMetadataBudgetError(error: unknown): boolean;
  /** Validate source evidence here; the scheduler never infers winners or finality. */
  interpretMetadata(market: ResolutionPollMarket, raw: Record<string, unknown>): Observation;
  fetchImpl: typeof fetch;
  ownerToken(): string;
};

export type ResolutionPollLimits = {
  maxMarkets?: number;
  pageSize?: number;
  maxDbFetches?: number;
  maxRequests?: number;
  timeoutMs?: number;
  maxBytes?: number;
};

export type ResolutionPollResult = {
  economicResolution: 'blocked-unverified-evidence';
  /** Metadata enumeration coverage only, never economic resolution or finality. */
  coverage: 'complete' | 'partial';
  cycleFinished: boolean;
  reason: 'complete' | 'market-limit' | 'db-fetch-limit' | 'metadata-budget' | 'deadline' | 'market-failures' | 'busy';
  attemptedThisRun: number;
  coveredThisRun: number;
  cycleAttempted: number;
  cycleFailed: number;
  dbFetches: number;
  continuation: { after: string | null; upper: string | null } | null;
};

export class ResolutionPollError extends Error {
  constructor(message: string, readonly result: ResolutionPollResult, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ResolutionPollError';
  }
}

/** One finite keyset cycle, possibly spread over multiple invocations. Partial is never success. */
export async function pollPolymarketResolutionsBounded<Observation>(
  dependencies: ResolutionPollDependencies<Observation>, limits: ResolutionPollLimits = {}
): Promise<ResolutionPollResult> {
  const maxMarkets = limits.maxMarkets ?? 25;
  const pageSize = limits.pageSize ?? 25;
  const maxDbFetches = limits.maxDbFetches ?? 4;
  for (const [name, value, maximum] of [
    ['maxMarkets', maxMarkets, 1_000], ['pageSize', pageSize, 100], ['maxDbFetches', maxDbFetches, 100]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid resolution poll ${name}`);
  }
  const budget = dependencies.createMetadataBudget(limits);
  budget.deadlineAt = performance.now() + budget.timeoutMs;
  let state: ResolutionPollState | null = null;
  const result: ResolutionPollResult = {
    economicResolution: 'blocked-unverified-evidence',
    coverage: 'partial', cycleFinished: false, reason: 'busy', attemptedThisRun: 0,
    coveredThisRun: 0, cycleAttempted: 0, cycleFailed: 0,
    dbFetches: 0, continuation: null
  };
  try {
    state = await dependencies.store.claim(dependencies.ownerToken(), budget.timeoutMs + 10_000);
  } catch (cause) {
    throw new ResolutionPollError('Polymarket resolution scan incomplete: durable claim failed', result, { cause });
  }
  if (!state) return result;
  let primaryFailure: unknown;
  try {
    while (true) {
      if (performance.now() >= budget.deadlineAt) { result.reason = 'deadline'; break; }
      if (result.attemptedThisRun >= maxMarkets) { result.reason = 'market-limit'; break; }
      if (result.dbFetches >= maxDbFetches) { result.reason = 'db-fetch-limit'; break; }
      const capacity = Math.min(pageSize, maxMarkets - result.attemptedThisRun);
      result.dbFetches++;
      const page = await dependencies.store.fetchPage(state, capacity + 1);
      if (page.length > capacity + 1) throw new Error('Oversized resolution keyset page');
      let previous = state.after;
      for (const market of page) {
        if (!/^0x[0-9a-f]{64}$/.test(market.conditionId) || !state.upper
          || (previous !== null && market.conditionId <= previous) || market.conditionId > state.upper) {
          throw new Error('Invalid resolution keyset page');
        }
        previous = market.conditionId;
      }
      const terminal = page.length <= capacity;
      for (const market of page.slice(0, capacity)) {
        if (performance.now() >= budget.deadlineAt) { result.reason = 'deadline'; return snapshot(); }
        if (budget.remainingRequests <= 0 || budget.remainingBytes <= 0) {
          result.reason = 'metadata-budget'; return snapshot();
        }
        state = await dependencies.store.reserveAttempt(state, market.conditionId);
        result.attemptedThisRun++;
        if (performance.now() >= budget.deadlineAt) { result.reason = 'deadline'; return snapshot(); }
        let observation: Observation;
        try {
          const raw = await dependencies.fetchGammaMarket(market.conditionId, dependencies.fetchImpl, budget);
          if (performance.now() >= budget.deadlineAt) { result.reason = 'deadline'; return snapshot(); }
          observation = dependencies.interpretMetadata(market, raw);
          if (performance.now() >= budget.deadlineAt) { result.reason = 'deadline'; return snapshot(); }
        } catch (error) {
          if (dependencies.isMetadataBudgetError(error)) { result.reason = 'metadata-budget'; return snapshot(); }
          continue;
        }
        state = await dependencies.store.settleCovered(state, observation);
        result.coveredThisRun++;
        if (performance.now() >= budget.deadlineAt) { result.reason = 'deadline'; return snapshot(); }
      }
      if (terminal) {
        if (performance.now() >= budget.deadlineAt) { result.reason = 'deadline'; return snapshot(); }
        await dependencies.store.finishCycle(state);
        result.cycleFinished = true;
        result.reason = state.failed === 0 ? 'complete' : 'market-failures';
        result.coverage = state.failed === 0 ? 'complete' : 'partial';
        if (performance.now() >= budget.deadlineAt) { result.reason = 'deadline'; result.coverage = 'partial'; }
        return snapshot();
      }
    }
    return snapshot();
  } catch (cause) {
    primaryFailure = cause;
    throw new ResolutionPollError('Polymarket resolution scan incomplete: storage failure', snapshot(), { cause });
  } finally {
    try {
      await dependencies.store.release(state);
      if (!primaryFailure && performance.now() >= budget.deadlineAt) {
        result.coverage = 'partial'; result.reason = 'deadline';
      }
    }
    catch (cause) {
      if (!primaryFailure) throw new ResolutionPollError('Polymarket resolution scan lease release failed', snapshot(), { cause });
    }
  }

  function snapshot(): ResolutionPollResult {
    result.cycleAttempted = state!.attempted;
    result.cycleFailed = state!.failed;
    result.continuation = result.cycleFinished ? null : { after: state!.after, upper: state!.upper };
    return result;
  }
}
