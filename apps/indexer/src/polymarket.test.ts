import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  withTransaction,
  createSqlResolutionPollStore,
  getPolymarketMarket,
  getPolymarketOutcomeContext,
  insertParsedTransaction,
  query,
  recordSourceTradeEvent,
  recordConfirmedPolymarketTrade,
  refreshWalletActivity,
  upsertPolymarketContext,
  upsertToken,
  upsertWallet
} from '@swat/db';
import { backfillPolymarketWallet, createMetadataBudget, fetchGammaMarket, fetchConfirmedPolymarketTradePages, pollPolymarketResolutions } from './polymarket.js';
import { parseConfirmedPolymarketTrade } from './polymarket-helpers.js';

vi.mock('@swat/db', async (importOriginal) => ({
  multiplyDecimalText: (await importOriginal<typeof import('@swat/db')>()).multiplyDecimalText,
  createSqlResolutionPollStore: vi.fn((await importOriginal<typeof import('@swat/db')>()).createSqlResolutionPollStore),
  withTransaction: vi.fn(),
  getPolymarketMarket: vi.fn(),
  getPolymarketOutcomeContext: vi.fn(),
  insertParsedTransaction: vi.fn(),
  query: vi.fn(),
  recordSourceTradeEvent: vi.fn(),
  recordConfirmedPolymarketTrade: vi.fn(),
  refreshWalletActivity: vi.fn(),
  upsertPolymarketContext: vi.fn(),
  upsertToken: vi.fn(),
  upsertWallet: vi.fn()
}));

const QUERY_WALLET = `0x${'1'.repeat(40)}`;
const PROXY_WALLET = `0x${'2'.repeat(40)}`;
const CONDITION_ID = `0x${'a'.repeat(64)}`;
const TRANSACTION_HASH = `0x${'b'.repeat(64)}`;
const TOKEN_YES = '1234567890123456789012345678901234567890';
const TOKEN_NO = '9876543210987654321098765432109876543210';

const trade = {
  proxyWallet: PROXY_WALLET,
  timestamp: 1719397500,
  conditionId: CONDITION_ID,
  asset: TOKEN_YES,
  size: 12.5,
  price: 0.64,
  side: 'BUY',
  transactionHash: TRANSACTION_HASH,
  outcome: 'Yes',
  title: 'Will the fixture pass?'
};

const market = {
  conditionId: CONDITION_ID,
  question: 'Will the fixture pass?',
  slug: 'fixture-pass',
  endDate: '2026-08-01T00:00:00Z',
  resolutionSource: 'Fixture oracle',
  outcomes: JSON.stringify(['Yes', 'No']),
  clobTokenIds: JSON.stringify([TOKEN_YES, TOKEN_NO]),
  active: true,
  closed: false,
  acceptingOrders: true,
  negRisk: false,
  orderPriceMinTickSize: 0.01,
  umaResolutionStatus: 'unresolved'
};

const persistedContext = {
  tokenId: `polygon:${TOKEN_YES}`,
  conditionId: CONDITION_ID,
  outcome: 'Yes',
  outcomeIndex: 0,
  question: 'Will the fixture pass?',
  slug: 'fixture-pass',
  endDate: new Date('2026-08-01T00:00:00Z'),
  marketStatus: 'active',
  tickSize: '0.01',
  negRisk: false,
  acceptingOrders: true,
  resolutionStatus: 'unresolved',
  contextComplete: true
};

function backfillFixtureFetch(rows: unknown[], wireBody?: string) {
  return vi.fn(async (input: string | URL | Request) => String(input).includes('/v2/trades')
    ? wireBody === undefined ? jsonResponse(rows) : new Response(wireBody)
    : jsonResponse([market]));
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('Polymarket confirmed-trade backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(upsertToken).mockResolvedValue();
    vi.mocked(upsertWallet).mockResolvedValue({});
    vi.mocked(upsertPolymarketContext).mockResolvedValue();
    vi.mocked(recordConfirmedPolymarketTrade).mockResolvedValue(true);
    vi.mocked(recordSourceTradeEvent).mockResolvedValue({
      event: { id: 'source-trade-1' }
    } as Awaited<ReturnType<typeof recordSourceTradeEvent>>);
    vi.mocked(insertParsedTransaction).mockResolvedValue(true);
    vi.mocked(refreshWalletActivity).mockResolvedValue([]);
  });

  it.each(['open Gamma', 'closed Gamma', 'CLOB'] as const)(
    'refuses invalid supported aliases from %s before projection or alternate-provider bypass', async stage => {
      const invalid = { ...market, condition_id: CONDITION_ID, neg_risk: true,
        tokens: [{ token_id: TOKEN_YES, outcome: 'Yes' }],
        end_date_iso: market.endDate, minimum_tick_size: 0.01 };
      let metadataCalls = 0;
      const fetchImpl = vi.fn(async () => {
        metadataCalls++;
        if (stage === 'open Gamma') return jsonResponse(metadataCalls === 1 ? [invalid] : [market]);
        if (stage === 'closed Gamma') return jsonResponse(metadataCalls === 1 ? [] : metadataCalls === 2 ? [invalid] : [market]);
        return jsonResponse(metadataCalls < 3 ? [] : invalid);
      });
      await expect(fetchGammaMarket(CONDITION_ID, fetchImpl, createMetadataBudget(undefined))).rejects.toThrow(/aliases/);
      expect(metadataCalls).toBe(stage === 'open Gamma' ? 1 : stage === 'closed Gamma' ? 2 : 3);
    }
  );

  it.each([
    { condition_id: `0x${'d'.repeat(64)}` }, { condition_id: null },
    { neg_risk: true }, { minimumTickSize: ['0.01'] }, { minimumTickSize: '0.02' },
    { accepting_orders: false }, { accepting_orders: null }
  ])('refuses supplied metadata aliases before context upsert %j', async override => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    let metadataCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/v2/trades')) return jsonResponse([trade]);
      return jsonResponse([metadataCalls++ === 0 ? { ...market, ...override } : market]);
    });
    const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl, publish: vi.fn() });
    expect(result).toMatchObject({ inserted: 0, failed: 1 });
    expect(metadataCalls).toBe(1);
    expect(upsertPolymarketContext).not.toHaveBeenCalled();
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
  });

  it.each([{ minimumTickSize: ['0.01'] }, { minimumTickSize: '0.02' }, { minimumTickSize: null }])(
    'refuses supplied tick fallback aliases before context upsert %j', async override => {
      vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/v2/trades')) return jsonResponse([trade]);
        if (url.includes('/tick-size')) return jsonResponse({ minimum_tick_size: '0.01', ...override });
        return jsonResponse([{ ...market, orderPriceMinTickSize: undefined }]);
      });
      const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl, publish: vi.fn() });
      expect(result).toMatchObject({ inserted: 0, failed: 1 });
      expect(upsertPolymarketContext).not.toHaveBeenCalled();
      expect(recordSourceTradeEvent).not.toHaveBeenCalled();
    }
  );

  it('normalizes explicit CLOB snake state while keeping observations quarantined', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue({ ...persistedContext, resolutionStatus: 'unknown' });
    const publish = vi.fn();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v2/trades')) return jsonResponse([trade]);
      if (url.includes('gamma-api')) return jsonResponse([]);
      return jsonResponse({ condition_id: CONDITION_ID, question: market.question,
        active: true, closed: false, accepting_orders: true, neg_risk: false,
        end_date_iso: market.endDate, minimum_tick_size: '0.01',
        tokens: [{ token_id: TOKEN_YES, outcome: 'Yes' }, { token_id: TOKEN_NO, outcome: 'No' }] });
    });
    const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl, publish });
    expect(result).toMatchObject({ inserted: 0, failed: 0, skipped: 1,
      evidence: { observed: 1, quarantined: 1, accepted: 0, confirmation: 'withheld' } });
    expect(upsertPolymarketContext).toHaveBeenCalledWith(expect.objectContaining({
      acceptingOrders: true, negRisk: false, resolutionStatus: 'unknown' }));
    expect(recordConfirmedPolymarketTrade).not.toHaveBeenCalled();
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([{ closed: undefined }, { closed: 'false' }, { acceptingOrders: undefined }, { active: undefined }])(
    'refuses unknown lifecycle metadata before context persistence %j', async override => {
      vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
      const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes('/v2/trades')
        ? jsonResponse([trade]) : jsonResponse([{ ...market, ...override }]));
      const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl, publish: vi.fn() });
      expect(result).toMatchObject({ inserted: 0, failed: 1 });
      expect(upsertPolymarketContext).not.toHaveBeenCalled();
      expect(recordSourceTradeEvent).not.toHaveBeenCalled();
    }
  );

  it.each([{ tick: true }, { tick: ['0.01'] }, { tick: { value: 0.01 } }])('refuses nonscalar tick evidence %j before persistence', async ({ tick }) => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes('/v2/trades')
      ? jsonResponse([trade]) : jsonResponse([{ ...market, orderPriceMinTickSize: tick }]));
    const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl: fetchImpl as typeof fetch, publish: vi.fn() });
    expect(result).toMatchObject({ inserted: 0, failed: 1 });
    expect(upsertPolymarketContext).not.toHaveBeenCalled();
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
  });

  it.each(['parse', 'context'] as const)('reports ordinary %s failure as known partial evidence', async stage => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const rows = [{ ...trade, ...(stage === 'parse' ? { asset: undefined } : { outcome: 'No' }) }, trade];
    const result = await backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl: backfillFixtureFetch(rows), publish: vi.fn()
    });
    expect(result).toMatchObject({ fetched: 2, inserted: 0, skipped: 1, failed: 1, evidence: {
      observed: 1, quarantined: 1, accepted: 0, completeness: 'partial',
      confirmation: 'withheld', scope: 'provider-pagination'
    } });
    expect(recordSourceTradeEvent).toHaveBeenCalledOnce();
    expect(recordConfirmedPolymarketTrade).not.toHaveBeenCalled();
    expect(insertParsedTransaction).not.toHaveBeenCalled();
  });

  it('reports empty history as unknown completeness and withheld confirmation', async () => {
    const result = await backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl: backfillFixtureFetch([]) as typeof fetch, publish: vi.fn()
    });
    expect(result).toMatchObject({ fetched: 0, inserted: 0, skipped: 0, failed: 0, evidence: {
      observed: 0, quarantined: 0, accepted: 0, completeness: 'unknown', confirmation: 'withheld', scope: 'provider-pagination'
    } });
  });

  it('does not reuse complete DB context or local snapshots across backfills', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const fetchImpl = backfillFixtureFetch([trade]);
    await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl: fetchImpl as typeof fetch, publish: vi.fn() });
    await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl: fetchImpl as typeof fetch, publish: vi.fn() });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(upsertPolymarketContext).toHaveBeenCalledTimes(2);
    expect(recordSourceTradeEvent).toHaveBeenCalledTimes(2);
  });

  it('rejects conflicting trade mappings even on a locally validated cache hit', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const fetchImpl = backfillFixtureFetch([trade, { ...trade, outcome: 'No' }]);
    const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl: fetchImpl as typeof fetch, publish: vi.fn() });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(recordSourceTradeEvent).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ inserted: 0, skipped: 1, failed: 1 });
  });

  it.each([
    { ...market, clobTokenIds: JSON.stringify([TOKEN_YES, TOKEN_YES]) },
    { ...market, outcomes: JSON.stringify(['Yes', 'yes']) }
  ])('refuses ambiguous provider mapping before metadata persistence', async (rawMarket) => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes('/v2/trades')
      ? jsonResponse([trade]) : jsonResponse([rawMarket]));
    const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl: fetchImpl as typeof fetch, publish: vi.fn() });
    expect(result).toMatchObject({ inserted: 0, failed: 1 });
    expect(upsertPolymarketContext).not.toHaveBeenCalled();
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
  });

  it('refuses CLOB fallback without explicit matching condition provenance', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v2/trades')) return jsonResponse([trade]);
      if (url.includes('gamma-api')) return jsonResponse([]);
      return jsonResponse({
        question: market.question, active: true, closed: false, acceptingOrders: true,
        tokens: [{ token_id: TOKEN_YES, outcome: 'Yes' }, { token_id: TOKEN_NO, outcome: 'No' }],
        neg_risk: false, end_date_iso: market.endDate, minimum_tick_size: 0.01
      });
    });
    const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl: fetchImpl as typeof fetch, publish: vi.fn() });
    expect(result).toMatchObject({ inserted: 0, failed: 1 });
    expect(upsertPolymarketContext).not.toHaveBeenCalled();
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
  });

  it.each(['context write', 'context read', 'wallet write', 'observation write'])(
    'refuses downstream work after a late %s without abandoning the owned DB promise', async (stage) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      let finish!: () => void;
      const pendingDb = new Promise<void>((resolve) => { finish = resolve; });
      vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
      if (stage === 'context write') vi.mocked(upsertPolymarketContext).mockImplementationOnce(() => pendingDb);
      if (stage === 'context read') vi.mocked(getPolymarketOutcomeContext).mockImplementationOnce(async () => {
        await pendingDb; return persistedContext;
      });
      if (stage === 'wallet write') vi.mocked(upsertWallet).mockImplementationOnce(async () => {
        await pendingDb; return {};
      });
      if (stage === 'observation write') vi.mocked(recordSourceTradeEvent).mockImplementationOnce(async () => {
        await pendingDb; return { event: { id: 'source-trade-1' } } as Awaited<ReturnType<typeof recordSourceTradeEvent>>;
      });
      const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes('/v2/trades')
        ? jsonResponse([trade]) : jsonResponse([market]));
      const publish = vi.fn();
      try {
        const pending = backfillPolymarketWallet(QUERY_WALLET, {
          fetchImpl: fetchImpl as typeof fetch, publish, metadataLimits: { timeoutMs: 10 }
        });
        let settled = false;
        void pending.then(() => { settled = true; }, () => { settled = true; });
        await vi.advanceTimersByTimeAsync(11);
        expect(settled).toBe(false); // No DB cancellation capability: we still own the await.
        const assertion = expect(pending).rejects.toMatchObject({
          name: 'IngestionBatchError', result: { fetched: 1, inserted: 0, failed: 1 }
        });
        finish();
        await assertion;
        if (stage === 'observation write') {
          await expect(pending).rejects.toMatchObject({ result: {
            skipped: 1,
            evidence: { observed: 1, quarantined: 1, accepted: 0, confirmation: 'withheld' }
          } });
        }
        if (stage === 'context write') expect(getPolymarketOutcomeContext).not.toHaveBeenCalled();
        if (stage === 'context write' || stage === 'context read') expect(upsertWallet).not.toHaveBeenCalled();
        if (stage !== 'observation write') expect(recordSourceTradeEvent).not.toHaveBeenCalled();
        expect(recordConfirmedPolymarketTrade).not.toHaveBeenCalled();
        expect(insertParsedTransaction).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
      } finally { finish(); vi.useRealTimers(); }
    }
  );

  it.each([
    ['condition', { conditionId: `0x${'c'.repeat(64)}` }],
    ['token', { tokenId: `polygon:${TOKEN_NO}` }],
    ['outcome', { outcome: 'No' }],
    ['index', { outcomeIndex: 1 }],
    ['unknown risk', { negRisk: null }],
    ['changed risk', { negRisk: true }],
    ['unknown tick', { tickSize: null }],
    ['changed tick', { tickSize: '0.1' }],
    ['unknown end date', { endDate: null }],
    ['changed end date', { endDate: new Date('2027-08-01T00:00:00Z') }],
    ['incomplete', { contextComplete: false }]
  ])('refuses %s in read-after-write context even when historical completeness was true', async (_field, patch) => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue({ ...persistedContext, ...patch } as typeof persistedContext);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes('/v2/trades')
      ? jsonResponse([trade]) : jsonResponse([market]));
    const publish = vi.fn();
    const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl: fetchImpl as typeof fetch, publish });
    expect(result).toMatchObject({ inserted: 0, skipped: 0, failed: 1 });
    expect(upsertPolymarketContext).toHaveBeenCalledOnce();
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
    expect(upsertWallet).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('refreshes historical complete context instead of trusting unproven safety defaults', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes('/v2/trades')
      ? jsonResponse([trade]) : jsonResponse([{ ...market, negRisk: undefined }]));
    const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl: fetchImpl as typeof fetch, publish: vi.fn() });
    expect(result).toMatchObject({ inserted: 0, failed: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
    expect(upsertPolymarketContext).not.toHaveBeenCalled();
  });

  it('withholds complete context when Gamma omits negative-risk evidence', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes('/v2/trades')
      ? jsonResponse([trade]) : jsonResponse([{ ...market, negRisk: undefined }]));
    const publish = vi.fn();
    const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl: fetchImpl as typeof fetch, publish });
    expect(result).toMatchObject({ inserted: 0, failed: 1 });
    expect(upsertPolymarketContext).not.toHaveBeenCalled();
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(['neg_risk', 'end_date_iso', 'minimum_tick_size'])('withholds complete CLOB context when %s is unknown', async (field) => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const clobMarket: Record<string, unknown> = {
      condition_id: CONDITION_ID, question: market.question, active: true, closed: false, acceptingOrders: true,
      tokens: [{ token_id: TOKEN_YES, outcome: 'Yes' }, { token_id: TOKEN_NO, outcome: 'No' }],
      neg_risk: false, end_date_iso: market.endDate, minimum_tick_size: 0.01
    };
    delete clobMarket[field];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v2/trades')) return jsonResponse([trade]);
      if (url.includes('gamma-api')) return jsonResponse([]);
      if (url.includes('/tick-size')) return jsonResponse({});
      return jsonResponse(clobMarket);
    });
    const publish = vi.fn();
    const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl: fetchImpl as typeof fetch, publish });
    expect(result).toMatchObject({ inserted: 0, failed: 1 });
    expect(upsertPolymarketContext).not.toHaveBeenCalled();
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('stops the whole metadata backfill when its shared request budget is exhausted', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(null);
    const metadataRequests = vi.fn();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/v2/trades')) return jsonResponse([trade, { ...trade, transactionHash: `0x${'d'.repeat(64)}` }]);
      metadataRequests();
      return jsonResponse([]);
    });
    const publish = vi.fn();
    await expect(backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl: fetchImpl as typeof fetch, publish, metadataLimits: { maxRequests: 2 }
    })).rejects.toMatchObject({ name: 'IngestionBatchError', result: { fetched: 2, inserted: 0, failed: 1 } });
    expect(metadataRequests).toHaveBeenCalledTimes(2);
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('enforces one metadata deadline across fallback requests and disposes late responses', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(null);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const cancellations = vi.fn();
    const pendingResponses: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn((input: string | URL | Request) => String(input).includes('/v2/trades')
      ? Promise.resolve(jsonResponse([trade]))
      : new Promise<Response>((resolve) => { pendingResponses.push(resolve); }));
    try {
      const pending = backfillPolymarketWallet(QUERY_WALLET, {
        fetchImpl: fetchImpl as typeof fetch, publish: vi.fn(), metadataLimits: { timeoutMs: 10 }
      });
      const assertion = expect(pending).rejects.toMatchObject({ name: 'IngestionBatchError', result: { inserted: 0, failed: 1 } });
      await vi.advanceTimersByTimeAsync(10);
      expect(pendingResponses).toHaveLength(1);
      let settled = false;
      void assertion.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await assertion;
      pendingResponses[0]!(new Response(new ReadableStream({ cancel: cancellations })));
      await vi.advanceTimersByTimeAsync(0);
      expect(cancellations).toHaveBeenCalledTimes(1);
      expect(recordSourceTradeEvent).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('counts streamed metadata bytes across failed fallback responses', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(null);
    const cancellations = vi.fn();
    let metadataRequests = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/v2/trades')) return jsonResponse([trade]);
      metadataRequests++;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(metadataRequests === 1 ? '[]' : '[ ]'));
          if (metadataRequests === 1) controller.close();
        },
        cancel: cancellations
      }));
    });
    const publish = vi.fn();
    const pending = backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl: fetchImpl as typeof fetch, publish, metadataLimits: { maxBytes: 4 }
    });
    await expect(pending).rejects.toMatchObject({ name: 'IngestionBatchError', result: { inserted: 0, failed: 1 } });
    expect(metadataRequests).toBe(2);
    expect(cancellations).toHaveBeenCalledTimes(1);
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses a completed metadata response that arrived after the monotonic operation deadline', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(null);
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const publish = vi.fn();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/v2/trades')) return jsonResponse([trade]);
      now = 11;
      return jsonResponse([market]);
    });
    try {
      await expect(backfillPolymarketWallet(QUERY_WALLET, {
        fetchImpl: fetchImpl as typeof fetch, publish, metadataLimits: { timeoutMs: 10 }
      })).rejects.toMatchObject({ name: 'IngestionBatchError', result: { inserted: 0, failed: 1 } });
      expect(upsertPolymarketContext).not.toHaveBeenCalled();
      expect(recordSourceTradeEvent).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it.each([
    { maxRequests: 0 }, { maxRequests: 1.5 }, { maxRequests: 1_001 },
    { timeoutMs: 0 }, { timeoutMs: 120_001 }, { timeoutMs: Infinity },
    { maxBytes: 0 }, { maxBytes: 32 * 1024 * 1024 + 1 }
  ])('rejects invalid metadata limits %j before side effects', async (metadataLimits) => {
    const fetchImpl = vi.fn();
    await expect(backfillPolymarketWallet(QUERY_WALLET, { fetchImpl, publish: vi.fn(), metadataLimits })).rejects.toThrow(/Invalid Polymarket metadata/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(upsertToken).not.toHaveBeenCalled();
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
  });

  it('reuses only operation-local validated metadata within the shared network budget', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes('/v2/trades')
      ? jsonResponse([trade, { ...trade, transactionHash: `0x${'d'.repeat(64)}` }]) : jsonResponse([market]));
    const result = await backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl: fetchImpl as typeof fetch, publish: vi.fn(), metadataLimits: { maxRequests: 1 }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(recordSourceTradeEvent).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ inserted: 0, skipped: 2, failed: 0 });
  });

  it('shares the metadata deadline across streamed response bodies', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(null);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    const cancellations = vi.fn();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes('/v2/trades')
      ? jsonResponse([trade]) : new Response(new ReadableStream({ cancel: cancellations })));
    try {
      const assertion = expect(backfillPolymarketWallet(QUERY_WALLET, {
        fetchImpl: fetchImpl as typeof fetch, publish: vi.fn(), metadataLimits: { timeoutMs: 10 }
      })).rejects.toMatchObject({ name: 'IngestionBatchError', result: { inserted: 0, failed: 1 } });
      await vi.advanceTimersByTimeAsync(10);
      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(cancellations).toHaveBeenCalledTimes(1);
      expect(recordSourceTradeEvent).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('disposes market responses arriving after their request deadlines', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(null);
    vi.useFakeTimers();
    const pendingResponses: Array<(response: Response) => void> = [];
    const cancellations = vi.fn();
    const fetchImpl = vi.fn((input: string | URL | Request) => String(input).includes('/v2/trades')
      ? Promise.resolve(jsonResponse([trade]))
      : new Promise<Response>((resolve) => { pendingResponses.push(resolve); }));
    const publish = vi.fn();
    try {
      const pending = backfillPolymarketWallet(QUERY_WALLET, { fetchImpl: fetchImpl as typeof fetch, publish });
      const assertion = expect(pending).resolves.toMatchObject({ inserted: 0, failed: 1 });
      await vi.advanceTimersByTimeAsync(15001);
      await assertion;
      expect(pendingResponses).toHaveLength(3);
      for (const resolve of pendingResponses) resolve(new Response(new ReadableStream({ cancel: cancellations })));
      await vi.advanceTimersByTimeAsync(0);
      expect(cancellations).toHaveBeenCalledTimes(3);
      expect(recordSourceTradeEvent).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('bounds stalled market response bodies and withholds accepted trades', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(null);
    vi.useFakeTimers();
    const cancellations = vi.fn();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes('/v2/trades')
      ? jsonResponse([trade])
      : new Response(new ReadableStream({ cancel: cancellations })));
    const publish = vi.fn();
    try {
      const pending = backfillPolymarketWallet(QUERY_WALLET, { fetchImpl: fetchImpl as typeof fetch, publish });
      const assertion = expect(pending).resolves.toMatchObject({ inserted: 0, failed: 1 });
      await vi.advanceTimersByTimeAsync(15001);
      await assertion;
      expect(cancellations).toHaveBeenCalledTimes(3);
      expect(recordSourceTradeEvent).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('preserves quoted decimal quantities beyond Number-safe atomic units', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const publish = vi.fn();
    const result = await backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl: backfillFixtureFetch([{ ...trade, size: '9007199254.740993', price: '0.64' }]) as typeof fetch,
      publish
    });
    expect(recordSourceTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
      quantity: '9007199254740993', amountUsd: '5764607523.03423552', priceUsd: '0.64',
      confirmationState: 'observed'
    }));
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(result).toMatchObject({ inserted: 0, skipped: 1, failed: 0 });
  });

  it('preserves exact decimal lexemes in unquoted JSON trade fields', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const body = JSON.stringify([{ ...trade, size: '9007199254.740993', price: '0.640000000000000001' }])
      .replace('"size":"9007199254.740993"', '"size":9007199254.740993')
      .replace('"price":"0.640000000000000001"', '"price":0.640000000000000001');
    const publish = vi.fn();
    const result = await backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl: backfillFixtureFetch([], body) as typeof fetch, publish
    });
    expect(recordSourceTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
      quantity: '9007199254740993', amountUsd: '5764607523.034235529007199254740993',
      priceUsd: '0.640000000000000001', confirmationState: 'observed'
    }));
    expect(result).toMatchObject({ inserted: 0, skipped: 1, failed: 0 });
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(['0.0000001', '1.0000001', '1.9999999'])('refuses outcome size %s instead of rounding to atomic units', async (size) => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const publish = vi.fn();
    const result = await backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl: backfillFixtureFetch([{ ...trade, size }]) as typeof fetch, publish
    });
    expect(result).toMatchObject({ inserted: 0, skipped: 0, failed: 1 });
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
    expect(recordConfirmedPolymarketTrade).not.toHaveBeenCalled();
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('retains a bounded exact notional below collateral atomic precision', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const publish = vi.fn();
    const result = await backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl: backfillFixtureFetch([{ ...trade, size: '0.000001', price: '0.000000000000000000000000000000000001' }]) as typeof fetch, publish
    });
    expect(recordSourceTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
      quantity: '1', amountUsd: '0.000000000000000000000000000000000000000001',
      priceUsd: '0.000000000000000000000000000000000001'
    }));
    expect(result).toMatchObject({ inserted: 0, skipped: 1, failed: 0 });
    expect(recordConfirmedPolymarketTrade).not.toHaveBeenCalled();
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('quarantines provider observations before confirmed-trade storage or swap publication', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const publish = vi.fn();
    const result = await backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl: backfillFixtureFetch([trade]) as typeof fetch,
      publish
    });
    expect(recordSourceTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
      confirmationState: 'observed', quantity: '12500000'
    }));
    expect(recordConfirmedPolymarketTrade).not.toHaveBeenCalled();
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(refreshWalletActivity).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      fetched: 1, inserted: 0, skipped: 1, failed: 0,
      evidence: {
        observed: 1, quarantined: 1, accepted: 0, completeness: 'unknown',
        confirmation: 'withheld', scope: 'provider-pagination'
      }
    });
  });

  it('uses /trades and persists the exact proxy wallet, asset, and market context', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('data-api.polymarket.com/trades') || url.includes('data-api.polymarket.com/v2/trades')) return jsonResponse([trade]);
      if (url.includes('gamma-api.polymarket.com/markets')) return jsonResponse([market]);
      throw new Error(`Unexpected URL: ${url}`);
    });
    const publish = vi.fn(async () => 1);

    const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl, publish });

    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      expect.stringContaining('/trades?user='),
      expect.stringContaining('/markets?condition_id=')
    ]);
    expect(fetchImpl.mock.calls.every(([input]) => !String(input).includes('/activity'))).toBe(true);
    expect(upsertPolymarketContext).toHaveBeenCalledWith(expect.objectContaining({
      conditionId: CONDITION_ID,
      tickSize: 0.01,
      negRisk: false,
      resolutionStatus: 'unresolved',
      outcomes: [
        { tokenId: TOKEN_YES, outcome: 'Yes', outcomeIndex: 0 },
        { tokenId: TOKEN_NO, outcome: 'No', outcomeIndex: 1 }
      ]
    }));
    expect(upsertWallet).toHaveBeenCalledWith({
      address: PROXY_WALLET,
      chain: 'polygon',
      source: 'discovered',
      discoveryMethod: 'polymarket-proxy'
    });
    expect(recordConfirmedPolymarketTrade).not.toHaveBeenCalled();
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(recordSourceTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
      chain: 'polygon',
      sourceEventType: 'venue_trade',
      sourceEventId: TRANSACTION_HASH,
      transactionHash: TRANSACTION_HASH,
      walletAddress: PROXY_WALLET,
      tokenMint: TOKEN_YES,
      side: 'buy',
      quantity: '12500000',
      amountUsd: '8',
      priceUsd: '0.64',
      eventAt: new Date('2024-06-26T10:25:00.000Z'),
      confirmationState: 'observed'
    }));
    expect(refreshWalletActivity).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(result).toMatchObject({ fetched: 1, inserted: 0, skipped: 1, failed: 0 });
  });

  it('rejects an activity-shaped row without an exact asset token ID', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ ...trade, asset: undefined }])) as typeof fetch;

    const result = await backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl,
      publish: vi.fn()
    });

    expect(result).toMatchObject({ fetched: 1, inserted: 0, skipped: 0, failed: 1 });
    expect(upsertPolymarketContext).not.toHaveBeenCalled();
    expect(recordConfirmedPolymarketTrade).not.toHaveBeenCalled();
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
  });

  it('repairs lifecycle persistence when the legacy transaction is already present', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    vi.mocked(insertParsedTransaction).mockResolvedValue(false);
    const fetchImpl = backfillFixtureFetch([trade]) as typeof fetch;
    const publish = vi.fn(async () => 1);

    const result = await backfillPolymarketWallet(QUERY_WALLET, { fetchImpl, publish });

    expect(recordSourceTradeEvent).toHaveBeenCalledTimes(1);
    expect(recordSourceTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: TRANSACTION_HASH,
      quantity: '12500000'
    }));
    expect(publish).not.toHaveBeenCalled();
    expect(result).toMatchObject({ fetched: 1, inserted: 0, skipped: 1, failed: 0 });
  });

  it('persists observed SELL quantities and direction in the canonical lifecycle', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    const fetchImpl = backfillFixtureFetch([{ ...trade, side: 'SELL', size: 4, price: 0.7 }]) as typeof fetch;

    const result = await backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl,
      publish: vi.fn(async () => 1)
    });

    expect(recordSourceTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
      chain: 'polygon',
      side: 'sell',
      quantity: '4000000',
      amountUsd: '2.8',
      priceUsd: '0.7'
    }));
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ fetched: 1, inserted: 0, skipped: 1, failed: 0 });
  });

  it('fails the batch on lifecycle persistence failure without publishing an accepted event', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(persistedContext);
    vi.mocked(recordSourceTradeEvent).mockRejectedValueOnce(
      new Error('canonical lifecycle unavailable')
    );
    const publish = vi.fn(async () => 1);
    const fetchImpl = backfillFixtureFetch([trade]) as typeof fetch;

    await expect(backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl,
      publish
    })).rejects.toMatchObject({
      name: 'IngestionBatchError',
      result: { fetched: 1, inserted: 0, skipped: 0, failed: 1 }
    });

    expect(recordSourceTradeEvent).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(refreshWalletActivity).not.toHaveBeenCalled();
  });

  it('fails closed when Gamma does not map the traded asset', async () => {
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(null);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('data-api.polymarket.com/trades') || url.includes('data-api.polymarket.com/v2/trades')) return jsonResponse([trade]);
      if (url.includes('gamma-api.polymarket.com/markets')) {
        return jsonResponse([{ ...market, clobTokenIds: JSON.stringify([TOKEN_NO, `${TOKEN_NO}1`]) }]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await backfillPolymarketWallet(QUERY_WALLET, {
      fetchImpl,
      publish: vi.fn()
    });

    expect(result).toMatchObject({ fetched: 1, inserted: 0, skipped: 0, failed: 1 });
    expect(recordConfirmedPolymarketTrade).not.toHaveBeenCalled();
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
  });
});

describe('Polymarket resolution polling', () => {
  it('continues bounded metadata coverage across public invocations without claiming economic resolution', async () => {
    vi.clearAllMocks();
    const ids = Array.from({ length: 26 }, (_, index) => `0x${index.toString(16).padStart(64, '0')}`);
    let progress = { token: '', after: null as string | null, upper: ids[25]!, attempted: 0, failed: 0 };
    const store: ReturnType<typeof createSqlResolutionPollStore<null>> = {
      claim: vi.fn(async token => { progress = { ...progress, token }; return progress; }),
      fetchPage: vi.fn(async (state, limit) => ids.filter(id => !state.after || id > state.after)
        .slice(0, limit).map(conditionId => ({ conditionId, tickSize: '0.01' }))),
      reserveAttempt: vi.fn(async (state, conditionId) => {
        progress = { ...state, after: conditionId, attempted: state.attempted + 1, failed: state.failed + 1 };
        return progress;
      }),
      settleCovered: vi.fn(async (state, observation) => {
        expect(observation).toBeNull();
        progress = { ...state, failed: state.failed - 1 };
        return progress;
      }),
      finishCycle: vi.fn(async () => {}),
      release: vi.fn(async () => {})
    };
    vi.mocked(createSqlResolutionPollStore).mockReturnValueOnce(store).mockReturnValueOnce(store);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => jsonResponse([{
      ...market, conditionId: new URL(String(input)).searchParams.get('condition_id'),
      closed: true, umaResolutionStatus: 'resolved', outcomePrices: ['1', '0']
    }]));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      await expect(pollPolymarketResolutions()).rejects.toMatchObject({
        name: 'ResolutionPollError', result: {
          economicResolution: 'blocked-unverified-evidence', coverage: 'partial', reason: 'market-limit',
          attemptedThisRun: 25, coveredThisRun: 25, continuation: { after: ids[24], upper: ids[25] }
        }
      });
      expect(fetchImpl).toHaveBeenCalledTimes(25);
      await expect(pollPolymarketResolutions()).rejects.toMatchObject({
        name: 'ResolutionPollError', result: {
          economicResolution: 'blocked-unverified-evidence', coverage: 'complete', reason: 'complete',
          attemptedThisRun: 1, coveredThisRun: 1, cycleAttempted: 26, cycleFailed: 0, continuation: null
        }
      });
      expect(fetchImpl).toHaveBeenCalledTimes(26);
      expect(store.finishCycle).toHaveBeenCalledOnce();
      expect(store.release).toHaveBeenCalledTimes(2);
      expect(query).not.toHaveBeenCalled();
      expect(getPolymarketMarket).not.toHaveBeenCalled();
      const dependencies = vi.mocked(createSqlResolutionPollStore).mock.calls[0]![0];
      const economicQuery = vi.fn();
      await dependencies.applyObservation({ query: economicQuery }, ids[0]!, null);
      expect(economicQuery).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses missing durable schema before provider work without a legacy scan fallback', async () => {
    vi.clearAllMocks();
    const missingSchema = new Error('relation polymarket_resolution_poll_progress does not exist');
    vi.mocked(withTransaction).mockRejectedValueOnce(missingSchema);
    vi.mocked(query).mockResolvedValue([]);
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    try {
      await expect(pollPolymarketResolutions()).rejects.toMatchObject({
        name: 'ResolutionPollError', cause: missingSchema,
        result: { coverage: 'partial', economicResolution: 'blocked-unverified-evidence' }
      });
      expect(withTransaction).toHaveBeenCalledOnce();
      expect(query).not.toHaveBeenCalled();
      expect(getPolymarketMarket).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Polymarket trade paging', () => {
  it.each(['fetch', 'read', 'parse', 'return'] as const)(
    'refuses completed %s work after the monotonic deadline without waiting for timer dispatch', async stage => {
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('[]'));
        controller.close();
      } });
      const response = new Response(body);
      const cancel = vi.spyOn(body, 'cancel');
      let signal: AbortSignal | null | undefined;
      const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal;
        if (stage === 'fetch') now = 11;
        return response;
      });
      const originalParse = JSON.parse;
      if (stage === 'parse') vi.spyOn(JSON, 'parse').mockImplementation((...args: Parameters<typeof JSON.parse>) => {
        const result = originalParse(...args); now = 11; return result;
      });
      if (stage === 'read') {
        const getReader = body.getReader.bind(body);
        vi.spyOn(body, 'getReader').mockImplementation(() => {
          const reader = getReader();
          const read = reader.read.bind(reader);
          vi.spyOn(reader, 'read').mockImplementation(async () => { const result = await read(); now = 11; return result; });
          return reader;
        });
      }
      if (stage === 'return') vi.spyOn(JSON, 'parse').mockImplementation((...args: Parameters<typeof JSON.parse>) => {
        originalParse(...args);
        // A terminal-envelope property can consume synchronous validation time after parsing.
        return { data: [], pagination: { get next_cursor() { now = 11; return null; }, has_more: false } };
      });
      try {
        await expect(fetchConfirmedPolymarketTradePages({ user: QUERY_WALLET, fetchImpl, timeoutMs: 10 }))
          .rejects.toThrow('operation deadline exceeded');
        expect(signal?.aborted).toBe(true);
        if (stage === 'fetch') expect(cancel).toHaveBeenCalled();
      } finally { vi.restoreAllMocks(); }
    }
  );

  const USER = `0x${'3'.repeat(40)}`;

  function page(count: number, timestampBase: number): unknown[] {
    return Array.from({ length: count }, (_, index) => ({
      ...trade,
      timestamp: timestampBase - index
    }));
  }

  function urlsOf(fetchImpl: { mock: { calls: unknown[][] } }): URL[] {
    return fetchImpl.mock.calls.map(([input]) => new URL(String(input)));
  }

  it('walks cursors across v2 envelopes until next_cursor is null', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const cursor = new URL(String(input)).searchParams.get('cursor');
      if (!cursor) {
        return jsonResponse({
          data: page(2, 1_000),
          pagination: { limit: 2, next_cursor: 'cursor_page_2', has_more: true }
        });
      }
      return jsonResponse({
        data: page(1, 998),
        pagination: { limit: 2, next_cursor: null, has_more: false }
      });
    }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };

    const trades = await fetchConfirmedPolymarketTradePages({
      user: USER,
      fetchImpl,
      pageLimit: 2
    });

    expect(trades).toHaveLength(3);
    expect(urlsOf(fetchImpl).map((url) => url.searchParams.get('cursor'))).toEqual([null, 'cursor_page_2']);
    expect(urlsOf(fetchImpl).every((url) => url.pathname.includes('/v2/trades'))).toBe(true);
  });

  it('supports bare array pages for backwards compatibility with legacy fixtures', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(page(2, 1_000))) as unknown as typeof fetch;
    const trades = await fetchConfirmedPolymarketTradePages({
      user: USER,
      fetchImpl,
      pageLimit: 5
    });
    expect(trades).toHaveLength(2);
  });

  it('rejects incomplete history when a cursor cannot advance', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: page(2, 500),
      pagination: { next_cursor: 'static_stuck_cursor', has_more: true }
    })) as unknown as typeof fetch & { mock: { calls: unknown[][] } };

    await expect(fetchConfirmedPolymarketTradePages({
      user: USER,
      fetchImpl,
      pageLimit: 2
    })).rejects.toThrow('cursor cycle detected');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('propagates a non-OK page as an error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, 500)) as typeof fetch;
    await expect(fetchConfirmedPolymarketTradePages({ user: USER, fetchImpl }))
      .rejects.toThrow('Polymarket Data API returned status 500');
  });

  it('parses v2 snake_case trade fields correctly', () => {
    const v2Trade = {
      proxy_wallet: PROXY_WALLET,
      token_id: TOKEN_YES,
      condition_id: CONDITION_ID,
      transaction_hash: TRANSACTION_HASH,
      side: 'BUY',
      size: 100,
      price: 0.5,
      timestamp: 1710000000,
      outcome: 'Yes',
      title: 'Test Condition'
    };
    const parsed = parseConfirmedPolymarketTrade(v2Trade);
    expect(parsed.proxyWallet).toBe(PROXY_WALLET);
    expect(parsed.asset).toBe(TOKEN_YES);
    expect(parsed.conditionId).toBe(CONDITION_ID);
    expect(parsed.transactionHash).toBe(TRANSACTION_HASH);
  });
});
