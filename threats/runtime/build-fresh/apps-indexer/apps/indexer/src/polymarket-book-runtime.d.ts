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
import { type PolymarketBookPublisher } from '@swat/shared';
import { type PolymarketBookResyncFetcher, type PolymarketBookSubscriber, type PolymarketBookTransportFactory } from './polymarket-book-subscriber.js';
/** Attempts per batch, including the first. Three is two retries. */
export declare const POLYMARKET_BOOKS_MAX_ATTEMPTS = 3;
/** First backoff step, doubled per attempt. */
export declare const POLYMARKET_BOOKS_BASE_BACKOFF_MS = 250;
/**
 * Ceiling on one sleep.
 *
 * Bounded well under the resync interval (15s) on purpose: a backoff that
 * outlasts the cadence means the *next* resync tick fires while this one is
 * still sleeping, which the runtime's overlap guard then skips — turning a slow
 * endpoint into no resyncs at all rather than late ones.
 */
export declare const POLYMARKET_BOOKS_MAX_BACKOFF_MS = 2000;
/**
 * Full jitter, in `[0, 1]` of the computed step.
 *
 * Not decoration. Every service instance restarts together after a deploy and
 * every book ages out on the same cadence, so an unjittered backoff synchronises
 * retries into a thundering herd against one endpoint — which is precisely the
 * condition that caused the failure being retried. `random` is injected so the
 * schedule is assertable without flake.
 */
export declare function polymarketBooksBackoffMs(input: {
    readonly attempt: number;
    readonly random: () => number;
    readonly baseMs?: number;
    readonly maxMs?: number;
}): number;
/**
 * Whether a `POST /books` response is usable.
 *
 * Split out because "200 but not an array" is the shape that hurts: an error
 * envelope or an HTML error page parses fine and then iterates as zero rows,
 * which would read as "this market has no book" rather than "the request
 * failed". The two are opposite operator actions.
 */
export type PolymarketBooksResponseVerdict = {
    readonly ok: true;
    readonly rows: readonly unknown[];
} | {
    readonly ok: false;
    readonly retryable: boolean;
    readonly detail: string;
};
export declare function classifyPolymarketBooksResponse(input: {
    readonly status: number;
    readonly body: unknown;
}): PolymarketBooksResponseVerdict;
/**
 * `WebSocket.readyState` values that accept a frame.
 *
 * Pure so the rule is testable without a socket. `send` on a CONNECTING or
 * CLOSED socket **throws** in the WHATWG API, and the subscriber calls `send`
 * from a `setInterval` heartbeat — an uncaught throw there is an unhandled
 * rejection in the indexer, for a frame that was only a keepalive.
 */
export declare function polymarketSocketAcceptsFrames(readyState: number | undefined): boolean;
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
export declare class PolymarketBookWebSocketUnavailableError extends Error {
    constructor(message: string);
}
/**
 * Build the transport factory the subscriber shell takes.
 *
 * **Late frames cannot resurrect state.** A socket that we closed may still emit
 * `close` or a buffered `message`; both are suppressed after our `close()`,
 * because the shell's `onClose` invalidates every book and re-running that after
 * a deliberate stop would fight the next connection's snapshot.
 */
export declare function createWebSocketPolymarketBookTransportFactory(options?: PolymarketBookWebSocketOptions): PolymarketBookTransportFactory;
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
/** The documented request body: `[{"token_id":"..."}]`. */
export declare function polymarketBooksRequestBody(tokenIds: readonly string[]): string;
/**
 * `POST /books`, chunked and retried, that **never rejects**.
 *
 * The shell's `runDueResyncs` already catches a throw per batch, so rejecting
 * would not crash anything — but it would abandon the whole batch on the first
 * blip. Returning fewer rows is strictly better: the books that did come back
 * are refreshed, and the ones that did not keep ageing until the reader calls
 * them stale, which is the fail-closed direction and needs no invalidation here.
 */
export declare function createPolymarketBooksFetcher(options?: PolymarketBooksFetcherOptions): PolymarketBookResyncFetcher;
/**
 * Whether a periodic async task may start.
 *
 * A 15s timer in front of a call that can take longer than 15s otherwise stacks
 * unbounded concurrent POSTs, each making the next slower. The guard is a pure
 * predicate so the rule is tested without timers.
 */
export declare function shouldStartPeriodicRun(inFlight: boolean): boolean;
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
export declare function createPolymarketBookRuntime(options?: PolymarketBookRuntimeOptions): PolymarketBookRuntime;
/**
 * Convenience for the service: a runtime on a real `ioredis` connection.
 *
 * Kept separate so every test path above stays free of `ioredis`, and so the
 * connection's lifecycle belongs to the caller that created it.
 */
export declare function createPolymarketBookRuntimeOnRedis(redis: Redis, options?: Omit<PolymarketBookRuntimeOptions, 'redis'>): PolymarketBookRuntime;
//# sourceMappingURL=polymarket-book-runtime.d.ts.map