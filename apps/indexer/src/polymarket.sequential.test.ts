import { describe, expect, it, vi } from 'vitest';
import { fetchConfirmedPolymarketTradePages } from './polymarket.js';

vi.mock('@swat/db', () => ({}));
const USER = `0x${'3'.repeat(40)}`;
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' }
});

describe('bounded Polymarket source pagination', () => {
  it('accepts a full terminal envelope with an explicit null cursor', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 1 }], pagination: { next_cursor: null } }));
    await expect(fetchConfirmedPolymarketTradePages({ user: USER, fetchImpl: fetchImpl as typeof fetch, pageLimit: 1 }))
      .resolves.toEqual([{ id: 1 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('refuses a page exceeding the requested provider limit', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 1 }, { id: 2 }], pagination: { next_cursor: null, has_more: false } }));
    await expect(fetchConfirmedPolymarketTradePages({ user: USER, fetchImpl: fetchImpl as typeof fetch, pageLimit: 1 }))
      .rejects.toThrow(/incomplete.*page.*limit/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('refuses a short v2 envelope without an explicit terminal marker', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 1 }], pagination: {} }));
    await expect(fetchConfirmedPolymarketTradePages({ user: USER, fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toThrow(/incomplete.*terminal/i);
  });
  it('disposes a response that arrives after the fetch deadline', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    let cancelled = false;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    try {
      const pending = fetchConfirmedPolymarketTradePages({ user: USER, fetchImpl: fetchImpl as typeof fetch, timeoutMs: 50 });
      const assertion = expect(pending).rejects.toThrow(/deadline/i);
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
      resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it.each([
    { next_cursor: 'A', has_more: false },
    { next_cursor: 7, has_more: false },
    { next_cursor: null, has_more: 'false' }
  ])('refuses contradictory or malformed pagination metadata: %j', async (pagination) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 1 }], pagination }));
    await expect(fetchConfirmedPolymarketTradePages({ user: USER, fetchImpl: fetchImpl as typeof fetch, maxPages: 2 }))
      .rejects.toThrow(/incomplete.*pagination/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('preserves the opaque continuation cursor exactly', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 1 }], pagination: { next_cursor: ' A+/= ', has_more: true } }))
      .mockResolvedValueOnce(jsonResponse({ data: [], pagination: { next_cursor: null, has_more: false } }));
    await expect(fetchConfirmedPolymarketTradePages({ user: USER, fetchImpl: fetchImpl as typeof fetch })).resolves.toHaveLength(1);
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get('cursor')).toBe(' A+/= ');
  });
  it('refuses a full page without an explicit terminal or continuation marker', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ id: 1 }]));
    await expect(fetchConfirmedPolymarketTradePages({ user: USER, fetchImpl: fetchImpl as typeof fetch, pageLimit: 1 }))
      .rejects.toThrow(/incomplete.*pagination/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('rejects an empty page that still advertises remaining history', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [], pagination: { next_cursor: 'A', has_more: true } }));
    await expect(fetchConfirmedPolymarketTradePages({ user: USER, fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toThrow(/incomplete.*pagination/i);
  });
  it('cancels an oversized streamed page before parsing or retaining its rows', async () => {
    let cancelled = false;
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; }
    })));
    await expect(fetchConfirmedPolymarketTradePages({ user: USER, fetchImpl: fetchImpl as typeof fetch, timeoutMs: 50 }))
      .rejects.toThrow(/byte.*budget/i);
    expect(cancelled).toBe(true);
  });
  it('cancels a stalled response body at the operation deadline', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    try {
      const pending = fetchConfirmedPolymarketTradePages({ user: USER, fetchImpl: fetchImpl as typeof fetch, timeoutMs: 50 });
      const assertion = expect(pending).rejects.toThrow(/deadline/i);
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
      expect(cancelled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('stops fresh cursors when the page budget is exhausted', async () => {
    let page = 0;
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: ++page }], pagination: { next_cursor: String(page), has_more: true } }));
    await expect(fetchConfirmedPolymarketTradePages({ user: USER, fetchImpl: fetchImpl as typeof fetch, maxPages: 2 }))
      .rejects.toThrow(/incomplete.*page/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('refuses item-budget truncation while the provider advertises more history', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 1 }], pagination: { next_cursor: 'A', has_more: true } }));
    await expect(fetchConfirmedPolymarketTradePages({ user: USER, fetchImpl: fetchImpl as typeof fetch, maxOffset: 1 }))
      .rejects.toThrow(/incomplete.*item/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('rejects a nonadjacent cursor cycle instead of returning incomplete history', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 1 }], pagination: { next_cursor: 'A', has_more: true } }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 2 }], pagination: { next_cursor: 'B', has_more: true } }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 3 }], pagination: { next_cursor: 'A', has_more: true } }))
      .mockResolvedValueOnce(jsonResponse({ data: [], pagination: { next_cursor: null, has_more: false } }));
    await expect(fetchConfirmedPolymarketTradePages({ user: USER, fetchImpl: fetchImpl as typeof fetch }))
      .rejects.toThrow(/cursor.*cycle/i);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
