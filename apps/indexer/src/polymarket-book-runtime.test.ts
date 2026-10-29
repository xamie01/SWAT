import { describe, expect, it, vi } from 'vitest';

import {
  createInMemoryPolymarketBookTransport,
  deserializePolymarketBookEntry,
  polymarketBookKey,
  POLYMARKET_BOOK_MAX_AGE_MS,
  POLYMARKET_BOOK_RESYNC_INTERVAL_MS
} from '@swat/shared';

import {
  classifyPolymarketBooksResponse,
  createPolymarketBookRuntime,
  createPolymarketBooksFetcher,
  createWebSocketPolymarketBookTransportFactory,
  polymarketBooksBackoffMs,
  polymarketBooksRequestBody,
  polymarketSocketAcceptsFrames,
  POLYMARKET_BOOKS_BASE_BACKOFF_MS,
  POLYMARKET_BOOKS_MAX_ATTEMPTS,
  POLYMARKET_BOOKS_MAX_BACKOFF_MS,
  PolymarketBookWebSocketUnavailableError,
  shouldStartPeriodicRun
} from './polymarket-book-runtime.js';
import {
  POLYMARKET_BOOKS_REST_URL,
  POLYMARKET_MARKET_WS_HEARTBEAT_MS,
  type PolymarketBookTransportHandlers
} from './polymarket-book-subscriber.js';

const TOKEN_ID = '71321045679252212594626385532706912750332728571942532289631379312455583992563';
const NOW = 1_770_000_000_000;

// ═══════════════════════════════════════════════════════════════════════════
// A controllable fake socket, standing in for the global WebSocket
// ═══════════════════════════════════════════════════════════════════════════

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closeCalls = 0;
  sendThrows = false;
  closeThrows = false;
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  send(frame: string): void {
    if (this.sendThrows) throw new Error('InvalidStateError: socket is not open');
    this.sent.push(frame);
  }

  close(): void {
    this.closeCalls += 1;
    if (this.closeThrows) throw new Error('already closed');
    this.readyState = 3;
  }

  emit(type: string, event: unknown = {}): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }
}

function fakeSocketImpl(): typeof WebSocket {
  FakeSocket.instances = [];
  return FakeSocket as unknown as typeof WebSocket;
}

function noopHandlers(over: Partial<PolymarketBookTransportHandlers> = {}): PolymarketBookTransportHandlers {
  return {
    onOpen: over.onOpen ?? vi.fn(),
    onMessage: over.onMessage ?? vi.fn(),
    onClose: over.onClose ?? vi.fn(),
    onError: over.onError ?? vi.fn()
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe('polymarketBooksBackoffMs', () => {
  it('doubles per attempt at full jitter', () => {
    const random = () => 1;
    expect(polymarketBooksBackoffMs({ attempt: 1, random })).toBe(POLYMARKET_BOOKS_BASE_BACKOFF_MS);
    expect(polymarketBooksBackoffMs({ attempt: 2, random })).toBe(POLYMARKET_BOOKS_BASE_BACKOFF_MS * 2);
    expect(polymarketBooksBackoffMs({ attempt: 3, random })).toBe(POLYMARKET_BOOKS_BASE_BACKOFF_MS * 4);
  });

  it('applies the jitter factor rather than ignoring it', () => {
    expect(polymarketBooksBackoffMs({ attempt: 2, random: () => 0.5 }))
      .toBe(POLYMARKET_BOOKS_BASE_BACKOFF_MS);
    expect(polymarketBooksBackoffMs({ attempt: 2, random: () => 0 })).toBe(0);
  });

  it('caps the exponential growth at the ceiling', () => {
    expect(polymarketBooksBackoffMs({ attempt: 20, random: () => 1 }))
      .toBe(POLYMARKET_BOOKS_MAX_BACKOFF_MS);
  });

  it('keeps the ceiling well under the resync interval so ticks are not starved', () => {
    expect(POLYMARKET_BOOKS_MAX_BACKOFF_MS * POLYMARKET_BOOKS_MAX_ATTEMPTS)
      .toBeLessThan(POLYMARKET_BOOK_RESYNC_INTERVAL_MS);
  });

  it('never produces a negative or NaN delay from a hostile RNG', () => {
    expect(polymarketBooksBackoffMs({ attempt: 2, random: () => -5 })).toBe(0);
    expect(polymarketBooksBackoffMs({ attempt: 2, random: () => Number.NaN }))
      .toBe(POLYMARKET_BOOKS_BASE_BACKOFF_MS * 2);
    expect(polymarketBooksBackoffMs({ attempt: 2, random: () => 7 }))
      .toBe(POLYMARKET_BOOKS_BASE_BACKOFF_MS * 2);
  });

  it('treats attempt 0 as the first step rather than a half step', () => {
    expect(polymarketBooksBackoffMs({ attempt: 0, random: () => 1 }))
      .toBe(POLYMARKET_BOOKS_BASE_BACKOFF_MS);
  });
});

describe('classifyPolymarketBooksResponse', () => {
  it('accepts a 200 array', () => {
    const verdict = classifyPolymarketBooksResponse({ status: 200, body: [{ asset_id: TOKEN_ID }] });
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.rows).toHaveLength(1);
  });

  it('refuses a 200 that is not an array rather than iterating zero rows', () => {
    const verdict = classifyPolymarketBooksResponse({ status: 200, body: { error: 'nope' } });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.retryable).toBe(false);
  });

  it('treats 429 and 5xx as retryable', () => {
    for (const status of [429, 500, 502, 503]) {
      const verdict = classifyPolymarketBooksResponse({ status, body: null });
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.retryable).toBe(true);
    }
  });

  it('treats other 4xx as a request defect, not worth retrying', () => {
    for (const status of [400, 401, 404, 422]) {
      const verdict = classifyPolymarketBooksResponse({ status, body: null });
      expect(verdict.ok === false && verdict.retryable).toBe(false);
    }
  });

  it('builds the documented request body', () => {
    expect(JSON.parse(polymarketBooksRequestBody([TOKEN_ID]))).toEqual([{ token_id: TOKEN_ID }]);
  });
});

describe('createPolymarketBooksFetcher', () => {
  function okResponse(rows: unknown[]): Response {
    return { status: 200, json: async () => rows } as unknown as Response;
  }
  function statusResponse(status: number): Response {
    return { status, json: async () => ({ error: 'x' }) } as unknown as Response;
  }

  it('returns the rows on a first-attempt success', async () => {
    const fetchImpl = vi.fn(async () => okResponse([{ asset_id: TOKEN_ID }]));
    const rows = await createPolymarketBooksFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined
    })([TOKEN_ID]);

    expect(rows).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('posts to the documented endpoint with a JSON body', async () => {
    const fetchImpl = vi.fn(async () => okResponse([]));
    await createPolymarketBooksFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined
    })([TOKEN_ID]);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(POLYMARKET_BOOKS_REST_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual([{ token_id: TOKEN_ID }]);
  });

  it('retries a 500 and returns the eventual rows', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call < 3 ? statusResponse(500) : okResponse([{ asset_id: TOKEN_ID }]);
    });
    const sleep = vi.fn(async () => undefined);

    const rows = await createPolymarketBooksFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      random: () => 1
    })([TOKEN_ID]);

    expect(rows).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([
      POLYMARKET_BOOKS_BASE_BACKOFF_MS,
      POLYMARKET_BOOKS_BASE_BACKOFF_MS * 2
    ]);
  });

  it('does not retry a 404', async () => {
    const fetchImpl = vi.fn(async () => statusResponse(404));
    const rows = await createPolymarketBooksFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      logger: { warn: vi.fn() }
    })([TOKEN_ID]);

    expect(rows).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt ceiling and returns no rows rather than throwing', async () => {
    const fetchImpl = vi.fn(async () => statusResponse(503));
    const warn = vi.fn();

    const rows = await createPolymarketBooksFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      logger: { warn }
    })([TOKEN_ID]);

    expect(rows).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(POLYMARKET_BOOKS_MAX_ATTEMPTS);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never rejects when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });

    await expect(
      createPolymarketBooksFetcher({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => undefined,
        logger: { warn: vi.fn() }
      })([TOKEN_ID])
    ).resolves.toEqual([]);
  });

  it('never rejects when the body will not parse', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      }
    } as unknown as Response));

    await expect(
      createPolymarketBooksFetcher({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => undefined,
        logger: { warn: vi.fn() }
      })([TOKEN_ID])
    ).resolves.toEqual([]);
  });

  it('chunks a batch larger than the documented 500-item ceiling', async () => {
    const tokens = Array.from({ length: 1_100 }, (_, index) => `token-${index}`);
    const seen: number[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { token_id: string }[];
      seen.push(body.length);
      return okResponse(body.map(({ token_id }) => ({ asset_id: token_id })));
    });

    const rows = await createPolymarketBooksFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined
    })(tokens);

    expect(seen).toEqual([500, 500, 100]);
    expect(rows).toHaveLength(1_100);
  });

  it('keeps the rows from the batches that succeeded when one fails', async () => {
    const tokens = Array.from({ length: 600 }, (_, index) => `token-${index}`);
    let batch = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      batch += 1;
      const body = JSON.parse(String(init.body)) as { token_id: string }[];
      if (batch === 1) return statusResponse(400);
      return okResponse(body.map(({ token_id }) => ({ asset_id: token_id })));
    });

    const rows = await createPolymarketBooksFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      logger: { warn: vi.fn() }
    })(tokens);

    expect(rows).toHaveLength(100);
  });

  it('makes no request for an empty token list', async () => {
    const fetchImpl = vi.fn();
    const rows = await createPolymarketBooksFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch
    })([]);

    expect(rows).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('polymarketSocketAcceptsFrames', () => {
  it('accepts only OPEN', () => {
    expect(polymarketSocketAcceptsFrames(0)).toBe(false); // CONNECTING
    expect(polymarketSocketAcceptsFrames(1)).toBe(true); // OPEN
    expect(polymarketSocketAcceptsFrames(2)).toBe(false); // CLOSING
    expect(polymarketSocketAcceptsFrames(3)).toBe(false); // CLOSED
    expect(polymarketSocketAcceptsFrames(undefined)).toBe(false);
  });
});

describe('createWebSocketPolymarketBookTransportFactory', () => {
  it('forwards open, message, close and error to the shell handlers', () => {
    const impl = fakeSocketImpl();
    const onOpen = vi.fn();
    const onMessage = vi.fn();
    const onClose = vi.fn();
    const onError = vi.fn();

    createWebSocketPolymarketBookTransportFactory({ webSocketImpl: impl })(
      noopHandlers({ onOpen, onMessage, onClose, onError })
    );
    const socket = FakeSocket.instances[0]!;

    socket.open();
    socket.emit('message', { data: '{"event_type":"book"}' });
    socket.emit('error', {});
    socket.emit('close', { code: 1006, reason: '' });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith('{"event_type":"book"}');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('code 1006');
  });

  it('carries the close reason when the venue sends one', () => {
    const impl = fakeSocketImpl();
    const onClose = vi.fn();
    createWebSocketPolymarketBookTransportFactory({ webSocketImpl: impl })(noopHandlers({ onClose }));

    FakeSocket.instances[0]!.emit('close', { code: 1001, reason: 'going away' });
    expect(onClose).toHaveBeenCalledWith('code 1001: going away');
  });

  it('stringifies a non-string frame rather than dropping it', () => {
    const impl = fakeSocketImpl();
    const onMessage = vi.fn();
    createWebSocketPolymarketBookTransportFactory({ webSocketImpl: impl })(noopHandlers({ onMessage }));

    FakeSocket.instances[0]!.emit('message', { data: 12345 });
    expect(onMessage).toHaveBeenCalledWith('12345');
  });

  it('sends on an OPEN socket', () => {
    const impl = fakeSocketImpl();
    const transport = createWebSocketPolymarketBookTransportFactory({ webSocketImpl: impl })(noopHandlers());
    const socket = FakeSocket.instances[0]!;

    socket.open();
    transport.send('PING');
    expect(socket.sent).toEqual(['PING']);
  });

  it('drops rather than throws when the socket is still CONNECTING', () => {
    const impl = fakeSocketImpl();
    const onSendDropped = vi.fn();
    const transport = createWebSocketPolymarketBookTransportFactory({
      webSocketImpl: impl,
      onSendDropped
    })(noopHandlers());

    expect(() => transport.send('PING')).not.toThrow();
    expect(FakeSocket.instances[0]!.sent).toEqual([]);
    expect(onSendDropped).toHaveBeenCalledWith('PING', 0);
  });

  it('swallows a send that throws in the gap between the check and the call', () => {
    const impl = fakeSocketImpl();
    const transport = createWebSocketPolymarketBookTransportFactory({
      webSocketImpl: impl,
      logger: { info: vi.fn(), warn: vi.fn() }
    })(noopHandlers());
    const socket = FakeSocket.instances[0]!;

    socket.open();
    socket.sendThrows = true;
    expect(() => transport.send('PING')).not.toThrow();
  });

  it('closes exactly once however many times close is called', () => {
    const impl = fakeSocketImpl();
    const transport = createWebSocketPolymarketBookTransportFactory({ webSocketImpl: impl })(noopHandlers());
    const socket = FakeSocket.instances[0]!;

    socket.open();
    transport.close();
    transport.close();
    transport.close();

    expect(socket.closeCalls).toBe(1);
  });

  it('suppresses a late close event after we closed, so books are not invalidated twice', () => {
    const impl = fakeSocketImpl();
    const onClose = vi.fn();
    const transport = createWebSocketPolymarketBookTransportFactory({ webSocketImpl: impl })(
      noopHandlers({ onClose })
    );
    const socket = FakeSocket.instances[0]!;

    socket.open();
    transport.close();
    socket.emit('close', { code: 1000, reason: 'normal' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('suppresses a buffered message that arrives after we closed', () => {
    const impl = fakeSocketImpl();
    const onMessage = vi.fn();
    const transport = createWebSocketPolymarketBookTransportFactory({ webSocketImpl: impl })(
      noopHandlers({ onMessage })
    );
    const socket = FakeSocket.instances[0]!;

    socket.open();
    transport.close();
    socket.emit('message', { data: '{"event_type":"book"}' });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('refuses to send after close', () => {
    const impl = fakeSocketImpl();
    const transport = createWebSocketPolymarketBookTransportFactory({ webSocketImpl: impl })(noopHandlers());
    const socket = FakeSocket.instances[0]!;

    socket.open();
    transport.close();
    socket.readyState = 1; // pretend it is still open
    transport.send('PING');

    expect(socket.sent).toEqual([]);
  });

  it('reports a constructor failure through onError instead of throwing out of start', () => {
    const onError = vi.fn();
    const exploding = function Exploding(): never {
      throw new Error('Invalid URL');
    } as unknown as typeof WebSocket;

    expect(() =>
      createWebSocketPolymarketBookTransportFactory({
        webSocketImpl: exploding,
        logger: { info: vi.fn(), warn: vi.fn() }
      })(noopHandlers({ onError }))
    ).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('throws a named error when no WebSocket implementation exists at all', () => {
    expect(() =>
      createWebSocketPolymarketBookTransportFactory({
        webSocketImpl: undefined as unknown as typeof WebSocket,
        // Force the global lookup to miss.
        url: 'wss://example.invalid'
      })
    ).not.toThrow(); // building the factory is lazy

    const original = globalThis.WebSocket;
    try {
      // @ts-expect-error deliberately removing the global for this assertion
      delete globalThis.WebSocket;
      expect(() =>
        createWebSocketPolymarketBookTransportFactory({})(noopHandlers())
      ).toThrow(PolymarketBookWebSocketUnavailableError);
    } finally {
      globalThis.WebSocket = original;
    }
  });

  it('resolves the global lazily, so a fake installed after module load is used', () => {
    const original = globalThis.WebSocket;
    try {
      globalThis.WebSocket = fakeSocketImpl();
      createWebSocketPolymarketBookTransportFactory({})(noopHandlers());
      expect(FakeSocket.instances).toHaveLength(1);
    } finally {
      globalThis.WebSocket = original;
    }
  });
});

describe('shouldStartPeriodicRun', () => {
  it('permits a run only when none is in flight', () => {
    expect(shouldStartPeriodicRun(false)).toBe(true);
    expect(shouldStartPeriodicRun(true)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Composition root
// ═══════════════════════════════════════════════════════════════════════════

/** A manual interval driver: nothing runs until a test fires a tick. */
function manualTimers() {
  const handlers = new Map<number, { handler: () => void; ms: number }>();
  let nextId = 1;
  return {
    setIntervalImpl: (handler: () => void, ms: number) => {
      const id = nextId;
      nextId += 1;
      handlers.set(id, { handler, ms });
      return id;
    },
    clearIntervalImpl: (handle: unknown) => {
      handlers.delete(handle as number);
    },
    /** Fire every timer registered at this cadence. */
    tick: (ms: number) => {
      for (const entry of handlers.values()) if (entry.ms === ms) entry.handler();
    },
    count: () => handlers.size,
    cadences: () => [...handlers.values()].map((entry) => entry.ms)
  };
}

function redisBackedRuntime(over: Parameters<typeof createPolymarketBookRuntime>[0] = {}) {
  const store = createInMemoryPolymarketBookTransport(() => NOW);
  const redis = {
    get: (key: string) => store.get(key),
    set: async (key: string, value: string, _mode: 'PX', ttlMs: number) => {
      await store.set(key, value, ttlMs);
      return 'OK';
    },
    mget: (...keys: string[]) => store.mget(keys) as Promise<(string | null)[]>
  };
  const timers = manualTimers();
  const runtime = createPolymarketBookRuntime({
    redis,
    now: () => NOW,
    tokenIds: [TOKEN_ID],
    transportFactory: () => ({ send: vi.fn(), close: vi.fn() }),
    fetchBooks: async () => [],
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    logger: { info: vi.fn(), warn: vi.fn() },
    ...over
  });
  return { runtime, timers, store, redis };
}

describe('createPolymarketBookRuntime', () => {
  it('registers a heartbeat and a resync timer at the documented cadences', () => {
    const { runtime, timers } = redisBackedRuntime();
    runtime.start();

    expect(timers.count()).toBe(2);
    expect(timers.cadences().sort((a, b) => a - b)).toEqual(
      [POLYMARKET_MARKET_WS_HEARTBEAT_MS, POLYMARKET_BOOK_RESYNC_INTERVAL_MS].sort((a, b) => a - b)
    );
  });

  it('sends PING on each heartbeat tick', () => {
    const send = vi.fn();
    const { runtime, timers } = redisBackedRuntime({
      transportFactory: () => ({ send, close: vi.fn() })
    });
    runtime.start();

    timers.tick(POLYMARKET_MARKET_WS_HEARTBEAT_MS);
    timers.tick(POLYMARKET_MARKET_WS_HEARTBEAT_MS);

    expect(send.mock.calls.filter(([frame]) => frame === 'PING')).toHaveLength(2);
  });

  it('starts only once however many times start is called', () => {
    const { runtime, timers } = redisBackedRuntime();
    runtime.start();
    runtime.start();
    runtime.start();

    expect(timers.count()).toBe(2);
  });

  it('clears both timers and closes the socket on stop', () => {
    const close = vi.fn();
    const { runtime, timers } = redisBackedRuntime({
      transportFactory: () => ({ send: vi.fn(), close })
    });
    runtime.start();
    runtime.stop();

    expect(timers.count()).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on stop', () => {
    const close = vi.fn();
    const { runtime } = redisBackedRuntime({
      transportFactory: () => ({ send: vi.fn(), close })
    });
    runtime.start();
    runtime.stop();
    runtime.stop();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('can be restarted after a stop', () => {
    const { runtime, timers } = redisBackedRuntime();
    runtime.start();
    runtime.stop();
    runtime.start();

    expect(timers.count()).toBe(2);
  });

  it('skips an overlapping resync rather than stacking concurrent POSTs', async () => {
    let release: (() => void) | null = null;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchBooks = vi.fn(async () => {
      await inFlight;
      return [];
    });

    const { runtime, timers } = redisBackedRuntime({ fetchBooks, tokenIds: [TOKEN_ID] });
    runtime.start();

    timers.tick(POLYMARKET_BOOK_RESYNC_INTERVAL_MS);
    timers.tick(POLYMARKET_BOOK_RESYNC_INTERVAL_MS);
    timers.tick(POLYMARKET_BOOK_RESYNC_INTERVAL_MS);

    expect(runtime.stats().resyncSkippedOverlapping).toBe(2);

    release?.();
    await inFlight;
    await Promise.resolve();
    await Promise.resolve();
  });

  it('lets the next tick run once the in-flight resync settles', async () => {
    const fetchBooks = vi.fn(async () => []);
    const { runtime, timers } = redisBackedRuntime({ fetchBooks });
    runtime.start();

    timers.tick(POLYMARKET_BOOK_RESYNC_INTERVAL_MS);
    await new Promise((resolve) => { setImmediate(resolve); });
    timers.tick(POLYMARKET_BOOK_RESYNC_INTERVAL_MS);
    await new Promise((resolve) => { setImmediate(resolve); });

    expect(runtime.stats().resyncSkippedOverlapping).toBe(0);
    expect(fetchBooks).toHaveBeenCalledTimes(2);
  });

  it('survives a heartbeat that throws', () => {
    const warn = vi.fn();
    const { runtime, timers } = redisBackedRuntime({
      transportFactory: () => ({
        send: () => {
          throw new Error('socket gone');
        },
        close: vi.fn()
      }),
      logger: { info: vi.fn(), warn }
    });
    runtime.start();

    expect(() => timers.tick(POLYMARKET_MARKET_WS_HEARTBEAT_MS)).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('survives a resync that rejects', async () => {
    const warn = vi.fn();
    const { runtime, timers } = redisBackedRuntime({
      fetchBooks: async () => {
        throw new Error('boom');
      },
      logger: { info: vi.fn(), warn }
    });
    runtime.start();

    expect(() => timers.tick(POLYMARKET_BOOK_RESYNC_INTERVAL_MS)).not.toThrow();
    await new Promise((resolve) => { setImmediate(resolve); });
    // A rejected fetch must still clear the in-flight flag, or every later tick
    // is skipped forever.
    timers.tick(POLYMARKET_BOOK_RESYNC_INTERVAL_MS);
    expect(runtime.stats().resyncSkippedOverlapping).toBe(0);
  });

  it('publishes a book to Redis when the stream delivers one', async () => {
    let captured: PolymarketBookTransportHandlers | null = null;
    const { runtime, store } = redisBackedRuntime({
      transportFactory: (handlers) => {
        captured = handlers;
        return { send: vi.fn(), close: vi.fn() };
      }
    });
    runtime.start();

    captured!.onMessage(JSON.stringify({
      event_type: 'book',
      asset_id: TOKEN_ID,
      bids: [{ price: '0.4', size: '1000' }],
      asks: [{ price: '0.5', size: '1000' }],
      timestamp: String(NOW)
    }));

    await new Promise((resolve) => { setImmediate(resolve); });

    const raw = await store.get(polymarketBookKey(TOKEN_ID));
    expect(raw).not.toBeNull();
    const decoded = deserializePolymarketBookEntry(raw!);
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.entry.status).toBe('book');
  });

  it('enables the depth feature flag, without which every ladder stays empty', () => {
    const send = vi.fn();
    const { runtime } = redisBackedRuntime({
      transportFactory: (handlers) => {
        const transport = { send, close: vi.fn() };
        queueMicrotask(() => handlers.onOpen());
        return transport;
      }
    });
    runtime.start();

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        const frames = send.mock.calls.map(([frame]) => JSON.parse(String(frame)) as Record<string, unknown>);
        expect(frames.some((frame) => frame.custom_feature_enabled === true)).toBe(true);
        resolve();
      });
    });
  });

  it('runs degraded without Redis rather than crashing the indexer', () => {
    const warn = vi.fn();
    const timers = manualTimers();
    const runtime = createPolymarketBookRuntime({
      redis: null,
      now: () => NOW,
      tokenIds: [TOKEN_ID],
      transportFactory: () => ({ send: vi.fn(), close: vi.fn() }),
      fetchBooks: async () => [],
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      logger: { info: vi.fn(), warn }
    });

    expect(runtime.publisher).toBeNull();
    expect(() => runtime.start()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('capacity-unknown');
  });

  it('still serves its in-process cache when Redis is absent', () => {
    let captured: PolymarketBookTransportHandlers | null = null;
    const timers = manualTimers();
    const runtime = createPolymarketBookRuntime({
      redis: null,
      now: () => NOW,
      tokenIds: [TOKEN_ID],
      transportFactory: (handlers) => {
        captured = handlers;
        return { send: vi.fn(), close: vi.fn() };
      },
      fetchBooks: async () => [],
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    runtime.start();

    captured!.onMessage(JSON.stringify({
      event_type: 'book',
      asset_id: TOKEN_ID,
      bids: [{ price: '0.4', size: '1000' }],
      asks: [{ price: '0.5', size: '1000' }],
      timestamp: String(NOW)
    }));

    expect(runtime.subscriber.cache.get(TOKEN_ID)?.status).toBe('book');
  });

  it('counts a publish failure rather than letting it reach the socket handler', async () => {
    const warn = vi.fn();
    const timers = manualTimers();
    let captured: PolymarketBookTransportHandlers | null = null;
    const runtime = createPolymarketBookRuntime({
      redis: {
        get: async () => null,
        set: async () => {
          throw new Error('READONLY You can not write against a read only replica');
        },
        mget: async () => []
      },
      now: () => NOW,
      tokenIds: [TOKEN_ID],
      transportFactory: (handlers) => {
        captured = handlers;
        return { send: vi.fn(), close: vi.fn() };
      },
      fetchBooks: async () => [],
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      logger: { info: vi.fn(), warn }
    });
    runtime.start();

    expect(() =>
      captured!.onMessage(JSON.stringify({
        event_type: 'book',
        asset_id: TOKEN_ID,
        bids: [{ price: '0.4', size: '1000' }],
        asks: [{ price: '0.5', size: '1000' }],
        timestamp: String(NOW)
      }))
    ).not.toThrow();

    await new Promise((resolve) => { setImmediate(resolve); });
    expect(runtime.stats().publishFailures).toBe(1);
    expect(runtime.subscriber.cache.get(TOKEN_ID)?.status).toBe('book');
  });

  it('survives a logger that itself throws, rather than crashing the indexer', async () => {
    // Every log call sits in a timer callback or a .catch. A throw there is an
    // uncaught exception or an unhandled rejection, and Node exits on the
    // latter -- so a broken log transport would kill ingestion for every chain
    // at the exact moment it was reporting a fault.
    const hostileLogger = {
      info: () => {
        throw new Error('log transport is full');
      },
      warn: () => {
        throw new Error('log transport is full');
      }
    };
    const timers = manualTimers();
    const runtime = createPolymarketBookRuntime({
      redis: null,
      now: () => NOW,
      tokenIds: [TOKEN_ID],
      transportFactory: () => ({ send: vi.fn(), close: vi.fn() }),
      fetchBooks: async () => {
        throw new Error('boom');
      },
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      logger: hostileLogger
    });

    expect(() => runtime.start()).not.toThrow();
    expect(() => timers.tick(POLYMARKET_BOOK_RESYNC_INTERVAL_MS)).not.toThrow();
    await new Promise((resolve) => { setImmediate(resolve); });

    // The in-flight flag must still have been cleared: if the logger's throw
    // escaped the catch, the finally would be the only thing that could clear
    // it, and a stranded flag means no resync ever runs again.
    timers.tick(POLYMARKET_BOOK_RESYNC_INTERVAL_MS);
    expect(runtime.stats().resyncSkippedOverlapping).toBe(0);
  });

  it('honours the shared freshness budget by default', () => {
    const { runtime } = redisBackedRuntime();
    runtime.start();
    // The subscriber asserts resync*2 <= maxAge at construction; reaching here
    // at all proves the two constants were passed consistently.
    expect(POLYMARKET_BOOK_RESYNC_INTERVAL_MS * 2).toBeLessThanOrEqual(POLYMARKET_BOOK_MAX_AGE_MS);
  });

  it('refuses a resync cadence that cannot keep the cache inside the budget', () => {
    const timers = manualTimers();
    expect(() =>
      createPolymarketBookRuntime({
        redis: null,
        now: () => NOW,
        resyncIntervalMs: POLYMARKET_BOOK_MAX_AGE_MS,
        transportFactory: () => ({ send: vi.fn(), close: vi.fn() }),
        fetchBooks: async () => [],
        setIntervalImpl: timers.setIntervalImpl,
        clearIntervalImpl: timers.clearIntervalImpl,
        logger: { info: vi.fn(), warn: vi.fn() }
      })
    ).toThrow();
  });
});
