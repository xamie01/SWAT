/**
 * The concrete I/O layer for the Polymarket book feed (`S4-M38`).
 *
 * `polymarket-book-subscriber.ts` is a pure shell: it takes a transport factory,
 * a batch fetcher and a clock, and it never opens a socket, calls `fetch`, reads
 * an environment variable or touches Redis. That is what makes its 51 tests
 * meaningful. This module is the other half — the part that actually connects —
 * and it is deliberately thin, with every *decision* extracted into a pure
 * exported function below so the thin part has nothing left to get wrong.
 *
 * Three pieces:
 *
 *   1. `createWebSocketPolymarketBookTransportFactory` — the market stream, over
 *      Node's **built-in global `WebSocket`**. No `ws` dependency: Node 22 ships
 *      one, and the repo already requires Node 22+ (Node 24+ for Polymarket live
 *      execution). Adding a package for something in the platform would be a new
 *      supply-chain surface for nothing.
 *   2. `createPolymarketBooksFetcher` — `POST /books`, chunked, retried with
 *      bounded jittered backoff, and **never throwing**.
 *   3. `createPolymarketBookRuntime` — the composition root that wires the
 *      subscriber to the publisher and owns the two timers.
 *
 * ── The failure mode this module exists to prevent ────────────────────────
 *
 * Everything here runs in `indexer`. Nothing here is on the money path. What it
 * feeds is: `signal-engine` reads these books out of Redis before fan-out
 * (`polymarket-book-reader.ts`), and a book it cannot read is `capacity-unknown`,
 * which under `unassessablePolicy: 'skip'` admits **nobody** on polygon.
 *
 * So the asymmetry that shapes every choice below is: a crash, an unhandled
 * rejection or a thrown error in this file does not merely lose a book — it can
 * take down the indexer process that also ingests every chain's transactions. A
 * stale book fails closed and costs one market's copiers. A dead indexer costs
 * everything. Hence: no throw escapes a timer callback, a send on a closed socket
 * is dropped rather than raised, and a failed HTTP batch returns fewer rows
 * rather than rejecting.
 */

import { Redis } from 'ioredis';
import {
  createPolymarketBookPublisher,
  polymarketBookRedisTransport,
  POLYMARKET_BOOK_ENTRY_TTL_MS,
  POLYMARKET_BOOK_MAX_AGE_MS,
  POLYMARKET_BOOK_RESYNC_INTERVAL_MS,
  type PolymarketBookEntry,
  type PolymarketBookKeyValueTransport,
  type PolymarketBookPublisher,
  type PolymarketBookPublishResult
} from '@swat/shared';

import {
  createPolymarketBookSubscriber,
  POLYMARKET_BOOKS_MAX_BATCH,
  POLYMARKET_BOOKS_REST_URL,
  POLYMARKET_MARKET_WS_HEARTBEAT_MS,
  POLYMARKET_MARKET_WS_URL,
  chunkPolymarketBookBatch,
  type PolymarketBookResyncFetcher,
  type PolymarketBookSubscriber,
  type PolymarketBookTransport,
  type PolymarketBookTransportFactory,
  type PolymarketBookTransportHandlers
} from './polymarket-book-subscriber.js';

// ═══════════════════════════════════════════════════════════════════════════
// Retry policy — pure
// ═══════════════════════════════════════════════════════════════════════════

/** Attempts per batch, including the first. Three is two retries. */
export const POLYMARKET_BOOKS_MAX_ATTEMPTS = 3;

/** First backoff step, doubled per attempt. */
export const POLYMARKET_BOOKS_BASE_BACKOFF_MS = 250;

/**
 * Ceiling on one sleep.
 *
 * Bounded well under the resync interval (15s) on purpose: a backoff that
 * outlasts the cadence means the *next* resync tick fires while this one is
 * still sleeping, which the runtime's overlap guard then skips — turning a slow
 * endpoint into no resyncs at all rather than late ones.
 */
export const POLYMARKET_BOOKS_MAX_BACKOFF_MS = 2_000;

/**
 * Full jitter, in `[0, 1]` of the computed step.
 *
 * Not decoration. Every service instance restarts together after a deploy and
 * every book ages out on the same cadence, so an unjittered backoff synchronises
 * retries into a thundering herd against one endpoint — which is precisely the
 * condition that caused the failure being retried. `random` is injected so the
 * schedule is assertable without flake.
 */
export function polymarketBooksBackoffMs(input: {
  readonly attempt: number;
  readonly random: () => number;
  readonly baseMs?: number;
  readonly maxMs?: number;
}): number {
  const baseMs = input.baseMs ?? POLYMARKET_BOOKS_BASE_BACKOFF_MS;
  const maxMs = input.maxMs ?? POLYMARKET_BOOKS_MAX_BACKOFF_MS;
  // `attempt` is 1-based: the wait *after* attempt 1 is one base step.
  const exponent = Math.max(0, input.attempt - 1);
  const uncapped = baseMs * 2 ** exponent;
  const capped = Math.min(maxMs, uncapped);
  const roll = input.random();
  // A transport-supplied RNG that returns something absurd must not produce a
  // negative or NaN delay, which would make `setTimeout` fire immediately in a
  // tight loop.
  const factor = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 1;
  return Math.round(capped * factor);
}

/**
 * Whether a `POST /books` response is usable.
 *
 * Split out because "200 but not an array" is the shape that hurts: an error
 * envelope or an HTML error page parses fine and then iterates as zero rows,
 * which would read as "this market has no book" rather than "the request
 * failed". The two are opposite operator actions.
 */
export type PolymarketBooksResponseVerdict =
  | { readonly ok: true; readonly rows: readonly unknown[] }
  | { readonly ok: false; readonly retryable: boolean; readonly detail: string };

export function classifyPolymarketBooksResponse(input: {
  readonly status: number;
  readonly body: unknown;
}): PolymarketBooksResponseVerdict {
  if (input.status < 200 || input.status >= 300) {
    // 4xx other than 429 is a request defect — a malformed token id, say — and
    // retrying it just repeats the same mistake three times. 429 and 5xx are
    // conditions that pass.
    const retryable = input.status === 429 || input.status >= 500;
    return {
      ok: false,
      retryable,
      detail: `POST ${POLYMARKET_BOOKS_REST_URL} returned HTTP ${input.status}`
    };
  }
  if (!Array.isArray(input.body)) {
    return {
      ok: false,
      // Not retryable: a 200 with the wrong shape is a contract change or a
      // proxy in the way, and hammering it will not fix either.
      retryable: false,
      detail:
        `POST ${POLYMARKET_BOOKS_REST_URL} returned HTTP ${input.status} with a non-array body `
        + `(${typeof input.body}). Refused rather than iterated: an error envelope yields zero `
        + 'rows, which would read as an empty market instead of a failed request.'
    };
  }
  return { ok: true, rows: input.body };
}

// ═══════════════════════════════════════════════════════════════════════════
// WebSocket transport
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `WebSocket.readyState` values that accept a frame.
 *
 * Pure so the rule is testable without a socket. `send` on a CONNECTING or
 * CLOSED socket **throws** in the WHATWG API, and the subscriber calls `send`
 * from a `setInterval` heartbeat — an uncaught throw there is an unhandled
 * rejection in the indexer, for a frame that was only a keepalive.
 */
export function polymarketSocketAcceptsFrames(readyState: number | undefined): boolean {
  return readyState === 1; // WebSocket.OPEN
}

export interface PolymarketBookWebSocketOptions {
  readonly url?: string;
  /**
   * Injected constructor. Defaults to the global at **call** time rather than at
   * module load, so a test can install a fake and so the module imports cleanly
   * on a runtime where the global is absent.
   */
  readonly webSocketImpl?: typeof WebSocket;
  /** Called for each frame dropped because the socket was not OPEN. */
  readonly onSendDropped?: (frame: string, readyState: number | undefined) => void;
  readonly logger?: {
    readonly info: (message: string) => void;
    readonly warn: (message: string, error?: unknown) => void;
  };
}

export class PolymarketBookWebSocketUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolymarketBookWebSocketUnavailableError';
  }
}

/**
 * Build the transport factory the subscriber shell takes.
 *
 * **Late frames cannot resurrect state.** A socket that we closed may still emit
 * `close` or a buffered `message`; both are suppressed after our `close()`,
 * because the shell's `onClose` invalidates every book and re-running that after
 * a deliberate stop would fight the next connection's snapshot.
 */
export function createWebSocketPolymarketBookTransportFactory(
  options: PolymarketBookWebSocketOptions = {}
): PolymarketBookTransportFactory {
  const url = options.url ?? POLYMARKET_MARKET_WS_URL;
  const log = options.logger ?? {
    info: (message: string) => console.log(`[polymarket-book-ws] ${message}`),
    warn: (message: string, error?: unknown) =>
      console.warn(`[polymarket-book-ws] ${message}`, error ?? '')
  };

  return (handlers: PolymarketBookTransportHandlers): PolymarketBookTransport => {
    const Impl = options.webSocketImpl ?? globalThis.WebSocket;
    if (typeof Impl !== 'function') {
      throw new PolymarketBookWebSocketUnavailableError(
        'No global WebSocket is available. Node 22+ provides one and this repo requires it; '
        + 'pass webSocketImpl explicitly if running somewhere older. A `ws` dependency is '
        + 'deliberately not added for a platform built-in.'
      );
    }

    let closedByUs = false;
    let socket: WebSocket;
    try {
      socket = new Impl(url);
    } catch (error) {
      // A constructor throw (bad URL, no network stack) must reach the shell as
      // an error event, not as a throw out of `start()`.
      log.warn(`could not open ${url}`, error);
      handlers.onError(error);
      return {
        send: () => undefined,
        close: () => undefined
      };
    }

    socket.addEventListener('open', () => {
      if (closedByUs) return;
      handlers.onOpen();
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      if (closedByUs) return;
      const data: unknown = event.data;
      // Binary frames are not part of this protocol, but a proxy can produce
      // one. Stringifying rather than dropping keeps the shell's malformed-frame
      // counter as the single place that reports unusable input.
      handlers.onMessage(typeof data === 'string' ? data : String(data));
    });

    socket.addEventListener('close', (event: CloseEvent) => {
      if (closedByUs) return;
      const reason = event.reason === '' ? `code ${event.code}` : `code ${event.code}: ${event.reason}`;
      handlers.onClose(reason);
    });

    socket.addEventListener('error', (event: Event) => {
      if (closedByUs) return;
      handlers.onError(event);
    });

    return {
      send: (frame: string) => {
        if (closedByUs) return;
        if (!polymarketSocketAcceptsFrames(socket.readyState)) {
          // Dropped, never thrown: this is called from the heartbeat interval.
          if (options.onSendDropped !== undefined) options.onSendDropped(frame, socket.readyState);
          return;
        }
        try {
          socket.send(frame);
        } catch (error) {
          // A race between the readyState check and the send.
          log.warn('frame dropped on a socket that closed mid-send', error);
        }
      },
      close: () => {
        if (closedByUs) return;
        closedByUs = true;
        try {
          socket.close();
        } catch (error) {
          log.warn('close() on an already-closed socket', error);
        }
      }
    };
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /books fetcher
// ═══════════════════════════════════════════════════════════════════════════

export interface PolymarketBooksFetcherOptions {
  readonly url?: string;
  readonly fetchImpl?: typeof fetch;
  /** Injected for the backoff jitter. Defaults to `Math.random`. */
  readonly random?: () => number;
  /** Injected so a test asserts the schedule without waiting. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly batchSize?: number;
  readonly logger?: {
    readonly warn: (message: string, error?: unknown) => void;
  };
}

/** The documented request body: `{"token_ids": [...]}`. */
export function polymarketBooksRequestBody(tokenIds: readonly string[]): string {
  return JSON.stringify({ token_ids: [...tokenIds] });
}

/**
 * `POST /books`, chunked and retried, that **never rejects**.
 *
 * The shell's `runDueResyncs` already catches a throw per batch, so rejecting
 * would not crash anything — but it would abandon the whole batch on the first
 * blip. Returning fewer rows is strictly better: the books that did come back
 * are refreshed, and the ones that did not keep ageing until the reader calls
 * them stale, which is the fail-closed direction and needs no invalidation here.
 */
export function createPolymarketBooksFetcher(
  options: PolymarketBooksFetcherOptions = {}
): PolymarketBookResyncFetcher {
  const url = options.url ?? POLYMARKET_BOOKS_REST_URL;
  const maxAttempts = Math.max(1, options.maxAttempts ?? POLYMARKET_BOOKS_MAX_ATTEMPTS);
  const batchSize = Math.max(1, Math.min(options.batchSize ?? POLYMARKET_BOOKS_MAX_BATCH, POLYMARKET_BOOKS_MAX_BATCH));
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const warn = (message: string, error?: unknown): void => {
    if (options.logger !== undefined) options.logger.warn(message, error);
    else console.warn(`[polymarket-books] ${message}`, error ?? '');
  };

  async function fetchBatch(batch: readonly string[]): Promise<readonly unknown[]> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let verdict: PolymarketBooksResponseVerdict;
      try {
        const impl = options.fetchImpl ?? globalThis.fetch;
        const response = await impl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: polymarketBooksRequestBody(batch)
        });
        // A non-2xx body is never parsed: an error page is not rows.
        if (response.status < 200 || response.status >= 300) {
          verdict = classifyPolymarketBooksResponse({ status: response.status, body: null });
        } else {
          verdict = classifyPolymarketBooksResponse({
            status: response.status,
            body: await response.json()
          });
        }
      } catch (error) {
        // Network error or a body that would not parse. Retryable.
        verdict = {
          ok: false,
          retryable: true,
          detail: `POST ${url} threw: ${error instanceof Error ? error.message : String(error)}`
        };
      }

      if (verdict.ok) return verdict.rows;

      if (!verdict.retryable || attempt === maxAttempts) {
        // Ops-facing only: counts and status codes, never a price or a size, so
        // nothing here can leak into a user-visible surface.
        warn(
          `resync batch of ${batch.length} token(s) failed after ${attempt} attempt(s): `
          + `${verdict.detail}. Those books keep ageing and read stale rather than being `
          + 'invalidated, which fails closed.'
        );
        return [];
      }

      await sleep(polymarketBooksBackoffMs({ attempt, random }));
    }
    return [];
  }

  return async (tokenIds: readonly string[]): Promise<readonly unknown[]> => {
    if (tokenIds.length === 0) return [];
    const rows: unknown[] = [];
    // Chunked even though the shell already chunks at `POLYMARKET_BOOKS_MAX_BATCH`:
    // the documented ceiling is 500 per request, and an over-long batch that the
    // API truncates silently would return books for a *subset* of the tokens with
    // no indication which — attributing depth to the wrong markets by omission.
    for (const batch of chunkPolymarketBookBatch(tokenIds, batchSize)) {
      rows.push(...(await fetchBatch(batch)));
    }
    return rows;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Overlap guard — pure
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Whether a periodic async task may start.
 *
 * A 15s timer in front of a call that can take longer than 15s otherwise stacks
 * unbounded concurrent POSTs, each making the next slower. The guard is a pure
 * predicate so the rule is tested without timers.
 */
export function shouldStartPeriodicRun(inFlight: boolean): boolean {
  return !inFlight;
}

// ═══════════════════════════════════════════════════════════════════════════
// Composition root
// ═══════════════════════════════════════════════════════════════════════════

export interface PolymarketBookRuntimeOptions {
  readonly tokenIds?: readonly string[];
  /**
   * The Redis client the books are published through. Structural, not a `Redis`
   * instance, so this module stays testable and so `ioredis` is not required to
   * exercise it.
   *
   * **Absent is allowed and is not an error**, but it is loudly degraded: the
   * subscriber still runs and its in-process cache still works, while
   * `signal-engine` — a different process — sees nothing and every polygon
   * fan-out reads `capacity-unknown`. Crashing the indexer over it would be
   * worse; saying nothing would be much worse.
   */
  readonly redis?: {
    readonly get: (key: string) => Promise<string | null>;
    readonly set: (key: string, value: string, mode: 'PX', ttlMs: number) => Promise<unknown>;
    readonly mget: (...keys: string[]) => Promise<(string | null)[]>;
  } | null;
  readonly now?: () => number;
  readonly heartbeatIntervalMs?: number;
  readonly resyncIntervalMs?: number;
  readonly maxAgeMs?: number;
  readonly ttlMs?: number;
  readonly webSocket?: PolymarketBookWebSocketOptions;
  readonly books?: PolymarketBooksFetcherOptions;
  /** Overrides the whole transport; used by tests and by nothing else. */
  readonly transportFactory?: PolymarketBookTransportFactory;
  /** Overrides the whole fetcher; used by tests and by nothing else. */
  readonly fetchBooks?: PolymarketBookResyncFetcher;
  readonly setIntervalImpl?: (handler: () => void, ms: number) => unknown;
  readonly clearIntervalImpl?: (handle: unknown) => void;
  readonly logger?: {
    readonly info: (message: string) => void;
    readonly warn: (message: string, error?: unknown) => void;
  };
}

export interface PolymarketBookRuntime {
  readonly subscriber: PolymarketBookSubscriber;
  /** `null` when no Redis client was supplied — see the degraded note above. */
  readonly publisher: PolymarketBookPublisher | null;
  readonly start: () => void;
  readonly stop: () => void;
  /** Counters an ops surface can read: skipped ticks and publish failures. */
  readonly stats: () => {
    readonly resyncSkippedOverlapping: number;
    readonly publishFailures: number;
  };
}

export function createPolymarketBookRuntime(
  options: PolymarketBookRuntimeOptions = {}
): PolymarketBookRuntime {
  const now = options.now ?? (() => Date.now());
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? POLYMARKET_MARKET_WS_HEARTBEAT_MS;
  const resyncIntervalMs = options.resyncIntervalMs ?? POLYMARKET_BOOK_RESYNC_INTERVAL_MS;
  const maxAgeMs = options.maxAgeMs ?? POLYMARKET_BOOK_MAX_AGE_MS;
  const setIntervalImpl = options.setIntervalImpl ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalImpl = options.clearIntervalImpl ?? ((handle) => { clearInterval(handle as NodeJS.Timeout); });
  const supplied = options.logger ?? {
    info: (message: string) => console.log(`[polymarket-book] ${message}`),
    warn: (message: string, error?: unknown) => console.warn(`[polymarket-book] ${message}`, error ?? '')
  };

  /**
   * A logger that cannot throw.
   *
   * Every `log` call below sits in a timer callback, a socket handler or a
   * `.catch` — places where a thrown error becomes an uncaught exception or an
   * unhandled rejection, and Node terminates the process on the latter by
   * default. An injected logger that throws (a full disk behind a file
   * transport, a serialiser that chokes on a circular `error`) would therefore
   * take down the indexer *while it was reporting a problem*, which is the worst
   * possible time. Swallowing here is the correct trade: a lost log line costs
   * observability, a dead indexer costs every chain's ingestion.
   */
  const log = {
    info: (message: string) => {
      try {
        supplied.info(message);
      } catch {
        // Nothing to do: reporting the reporting failure has the same problem.
      }
    },
    warn: (message: string, error?: unknown) => {
      try {
        supplied.warn(message, error);
      } catch {
        // As above.
      }
    }
  };

  let publishFailures = 0;
  let resyncSkippedOverlapping = 0;

  let publisher: PolymarketBookPublisher | null = null;
  if (options.redis) {
    const transport: PolymarketBookKeyValueTransport = polymarketBookRedisTransport(options.redis);
    publisher = createPolymarketBookPublisher({
      transport,
      ttlMs: options.ttlMs ?? POLYMARKET_BOOK_ENTRY_TTL_MS,
      maxAgeMs,
      onFailure: (failure: PolymarketBookPublishResult) => {
        publishFailures += 1;
        if (!failure.ok) {
          log.warn(`book publish ${failure.code} for ${failure.key ?? 'unknown key'}: ${failure.detail}`);
        }
      }
    });
  } else {
    log.warn(
      'no Redis client supplied: books stay in this process only. signal-engine reads the book '
      + 'from Redis before fan-out, so every polygon cohort will read capacity-unknown and admit '
      + 'nobody until a client is wired. Running degraded rather than exiting, because the '
      + 'indexer also ingests every other chain.'
    );
  }

  const subscriber = createPolymarketBookSubscriber({
    transportFactory:
      options.transportFactory ?? createWebSocketPolymarketBookTransportFactory({
        ...(options.webSocket ?? {}),
        logger: options.webSocket?.logger ?? log
      }),
    fetchBooks: options.fetchBooks ?? createPolymarketBooksFetcher({
      ...(options.books ?? {}),
      logger: options.books?.logger ?? log
    }),
    now,
    resyncIntervalMs,
    maxAgeMs,
    // The market channel's depth events require it; without it the stream
    // delivers top-of-book only and every ladder reads awaiting-snapshot.
    customFeatureEnabled: true,
    ...(options.tokenIds === undefined ? {} : { tokenIds: options.tokenIds }),
    logger: log,
    onEntry: (entry: PolymarketBookEntry) => {
      if (publisher === null) return;
      // Deliberately not awaited: this runs inside the socket's message handler,
      // and awaiting a Redis round trip there would serialise frame processing
      // behind network latency. `publish` never rejects (it routes failures to
      // `onFailure`), so the floating promise cannot become an unhandled
      // rejection — but the `.catch` is kept as a belt on that contract.
      void publisher.publish(entry).catch((error: unknown) => {
        publishFailures += 1;
        log.warn('book publish threw despite its no-throw contract', error);
      });
    }
  });

  let heartbeatHandle: unknown = null;
  let resyncHandle: unknown = null;
  let resyncInFlight = false;
  let started = false;

  return {
    subscriber,
    publisher,
    stats: () => ({ resyncSkippedOverlapping, publishFailures }),
    start: () => {
      if (started) return;
      started = true;
      subscriber.start();

      heartbeatHandle = setIntervalImpl(() => {
        // The documented keepalive. Wrapped because a throw inside a timer
        // callback is an uncaught exception in the indexer process.
        try {
          subscriber.sendHeartbeat();
        } catch (error) {
          log.warn('heartbeat failed', error);
        }
      }, heartbeatIntervalMs);

      resyncHandle = setIntervalImpl(() => {
        if (!shouldStartPeriodicRun(resyncInFlight)) {
          resyncSkippedOverlapping += 1;
          return;
        }
        resyncInFlight = true;
        void (async () => {
          try {
            await subscriber.runDueResyncs();
          } catch (error) {
            log.warn('resync sweep failed', error);
          } finally {
            resyncInFlight = false;
          }
        })();
      }, resyncIntervalMs);

      log.info(
        `book runtime started: heartbeat ${heartbeatIntervalMs}ms, resync ${resyncIntervalMs}ms, `
        + `max age ${maxAgeMs}ms, publisher ${publisher === null ? 'disabled' : 'enabled'}`
      );
    },
    stop: () => {
      if (!started) return;
      started = false;
      if (heartbeatHandle !== null) clearIntervalImpl(heartbeatHandle);
      if (resyncHandle !== null) clearIntervalImpl(resyncHandle);
      heartbeatHandle = null;
      resyncHandle = null;
      subscriber.stop();
    }
  };
}

/**
 * Convenience for the service: a runtime on a real `ioredis` connection.
 *
 * Kept separate so every test path above stays free of `ioredis`, and so the
 * connection's lifecycle belongs to the caller that created it.
 */
export function createPolymarketBookRuntimeOnRedis(
  redis: Redis,
  options: Omit<PolymarketBookRuntimeOptions, 'redis'> = {}
): PolymarketBookRuntime {
  return createPolymarketBookRuntime({
    ...options,
    redis: {
      get: (key: string) => redis.get(key),
      set: (key: string, value: string, mode: 'PX', ttlMs: number) => redis.set(key, value, mode, ttlMs),
      mget: (...keys: string[]) => redis.mget(...keys)
    }
  });
}
