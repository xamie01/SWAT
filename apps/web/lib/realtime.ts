export type RealtimeStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface RealtimeMessage {
  readonly type: string;
  readonly data?: unknown;
  readonly ts?: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SocketLike {
  readonly readyState: number;
  send?(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: 'open' | 'message' | 'close' | 'error', listener: (ev: any) => void): void;
}

export interface StaleWhileReconnectingCache<T> {
  read(): { readonly data: T; readonly cachedAt: string } | null;
  write(data: T, cachedAt?: string): void;
}

export function resolveWsUrl(
  path = '/v1/me/ws',
  location?: { protocol: string; host: string } | null,
  configuredApiUrl: string | undefined = typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : undefined
): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const trimmed = configuredApiUrl?.trim();
  if (trimmed) {
    const url = new URL(trimmed);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = normalizedPath;
    url.search = '';
    url.hash = '';
    return url.toString();
  }
  const loc = location ?? (typeof window !== 'undefined' ? { protocol: window.location.protocol, host: window.location.host } : null);
  if (loc) {
    const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${loc.host}${normalizedPath}`;
  }
  return `ws://localhost:3001${normalizedPath}`;
}

export function computeReconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
  options: { readonly baseDelayMs?: number; readonly maxDelayMs?: number } = {}
): number {
  const base = options.baseDelayMs ?? 1000;
  const max = options.maxDelayMs ?? 30_000;
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(exp * 0.25 * Math.min(1, Math.max(0, random())));
  return Math.min(max, exp + jitter);
}

export function createStaleWhileReconnectingCache<T>(options: {
  readonly key: string;
  readonly storage?: StorageLike | null;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}): StaleWhileReconnectingCache<T> {
  const maxAgeMs = options.maxAgeMs ?? 5 * 60_000;
  const now = options.now ?? (() => Date.now());
  let memoryFallback: { readonly data: T; readonly cachedAt: string } | null = null;

  return {
    read() {
      const storage = options.storage;
      if (storage) {
        try {
          const raw = storage.getItem(options.key);
          if (raw) {
            const parsed = JSON.parse(raw) as { data?: T; cachedAt?: string };
            if (parsed && 'data' in parsed && typeof parsed.cachedAt === 'string') {
              const age = now() - Date.parse(parsed.cachedAt);
              if (Number.isFinite(age) && age <= maxAgeMs) {
                memoryFallback = { data: parsed.data as T, cachedAt: parsed.cachedAt };
                return memoryFallback;
              }
            }
          }
        } catch {
          // Corrupt or blocked storage falls back to in-memory entry.
        }
      }
      if (!memoryFallback) return null;
      const age = now() - Date.parse(memoryFallback.cachedAt);
      return Number.isFinite(age) && age <= maxAgeMs ? memoryFallback : null;
    },

    write(data, cachedAt = new Date(now()).toISOString()) {
      const envelope = { data, cachedAt };
      memoryFallback = envelope;
      if (options.storage) {
        try {
          options.storage.setItem(options.key, JSON.stringify(envelope));
        } catch {
          // Storage quota exceeded or private-browsing block is non-fatal.
        }
      }
    }
  };
}

export interface RealtimeControllerOptions {
  readonly url: string;
  readonly createSocket?: (url: string) => SocketLike;
  readonly onStatusChange?: (status: RealtimeStatus) => void;
  readonly onEvent: (event: RealtimeMessage) => void;
  readonly onReconnectSync?: (sinceIso: string | null) => void;
  readonly onFallbackPoll?: () => void;
  readonly baseReconnectMs?: number;
  readonly maxReconnectMs?: number;
  readonly fallbackPollMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface RealtimeController {
  start(): void;
  destroy(): void;
  getStatus(): RealtimeStatus;
  getLastSyncedAt(): string | null;
}

export function createRealtimeController(options: RealtimeControllerOptions): RealtimeController {
  const createSocket =
    options.createSocket
    ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => Date.now());
  const fallbackPollMs = options.fallbackPollMs ?? 15_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;

  let status: RealtimeStatus = 'connecting';
  let lastSyncedAt: string | null = null;
  let hasConnectedOnce = false;
  let attempt = 0;
  let destroyed = false;
  let activeSocket: SocketLike | null = null;
  let reconnectTimer: unknown = null;
  let fallbackTimer: unknown = null;
  let watchdogTimer: unknown = null;

  function setStatus(next: RealtimeStatus): void {
    if (status === next) return;
    status = next;
    options.onStatusChange?.(next);
  }

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimer(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearFallback(): void {
    if (fallbackTimer !== null) {
      clearTimer(fallbackTimer);
      fallbackTimer = null;
    }
  }

  function clearWatchdog(): void {
    if (watchdogTimer !== null) {
      clearTimer(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function scheduleFallbackTick(): void {
    clearFallback();
    if (destroyed || !options.onFallbackPoll || fallbackPollMs <= 0) return;
    fallbackTimer = setTimer(() => {
      fallbackTimer = null;
      if (destroyed || status === 'connected') return;
      options.onFallbackPoll?.();
      scheduleFallbackTick();
    }, fallbackPollMs);
  }

  function resetWatchdog(): void {
    clearWatchdog();
    if (destroyed || heartbeatTimeoutMs <= 0) return;
    watchdogTimer = setTimer(() => {
      watchdogTimer = null;
      if (destroyed || !activeSocket) return;
      try {
        activeSocket.close(4000, 'Heartbeat timeout');
      } catch {
        handleDisconnect(activeSocket);
      }
    }, heartbeatTimeoutMs);
  }

  function handleDisconnect(originSocket: SocketLike): void {
    if (destroyed || originSocket !== activeSocket) return;
    activeSocket = null;
    clearWatchdog();
    setStatus('reconnecting');
    scheduleFallbackTick();

    clearReconnect();
    attempt += 1;
    const delay = computeReconnectDelayMs(attempt, options.random, {
      baseDelayMs: options.baseReconnectMs,
      maxDelayMs: options.maxReconnectMs
    });
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      if (!destroyed) connect();
    }, delay);
  }

  function connect(): void {
    if (destroyed) return;
    clearReconnect();
    const socket = createSocket(options.url);
    activeSocket = socket;

    socket.addEventListener('open', () => {
      if (destroyed || socket !== activeSocket) return;
      const reconnecting = hasConnectedOnce;
      const priorSync = lastSyncedAt;
      hasConnectedOnce = true;
      attempt = 0;
      clearFallback();
      setStatus('connected');
      lastSyncedAt = new Date(now()).toISOString();
      resetWatchdog();
      if (reconnecting) {
        options.onReconnectSync?.(priorSync);
      }
    });

    socket.addEventListener('message', (event: { data?: unknown }) => {
      if (destroyed || socket !== activeSocket) return;
      resetWatchdog();
      try {
        const parsed = JSON.parse(String(event?.data ?? '')) as RealtimeMessage;
        if (!parsed || typeof parsed.type !== 'string') return;
        lastSyncedAt = typeof parsed.ts === 'string' ? parsed.ts : new Date(now()).toISOString();
        if (parsed.type === 'ping') {
          if (typeof socket.send === 'function' && socket.readyState === 1) {
            socket.send(JSON.stringify({ type: 'pong' }));
          }
          return;
        }
        if (parsed.type === 'pong' || parsed.type === 'connected') return;
        options.onEvent(parsed);
      } catch {
        // Ignore non-JSON frames.
      }
    });

    socket.addEventListener('close', () => handleDisconnect(socket));
    socket.addEventListener('error', () => handleDisconnect(socket));
  }

  return {
    start() {
      if (destroyed) return;
      setStatus('connecting');
      connect();
    },
    destroy() {
      destroyed = true;
      clearReconnect();
      clearFallback();
      clearWatchdog();
      if (activeSocket) {
        try {
          activeSocket.close(1000, 'Component unmounted');
        } catch {
          // ignore
        }
        activeSocket = null;
      }
      setStatus('closed');
    },
    getStatus() {
      return status;
    },
    getLastSyncedAt() {
      return lastSyncedAt;
    }
  };
}
