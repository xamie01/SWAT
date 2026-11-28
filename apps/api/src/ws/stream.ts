import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { REDIS_CHANNELS } from '@swat/shared';
import { requireUser } from '../auth/plugin.js';

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping?(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface UserRealtimeEvent {
  readonly type: string;
  readonly data?: unknown;
  readonly ts?: string;
}

export interface PubSubSubscriber {
  subscribe(...channels: string[]): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  quit?(): Promise<unknown>;
}

export interface PubSubPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface RegisterUserWebSocketOptions {
  readonly subscriber: PubSubSubscriber;
  readonly publisher: PubSubPublisher;
  readonly allowedOrigins?: readonly string[];
  readonly requireOrigin?: boolean;
  readonly isProduction?: boolean;
  readonly maxConnectionsPerUser?: number;
  readonly heartbeatMs?: number;
  readonly staleTimeoutMs?: number;
}

export interface UserWebSocketHandle {
  publishUserEvent(userId: string, event: UserRealtimeEvent): Promise<void>;
  activeConnectionCount(userId?: string): number;
}

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.trim();
  }
}

export function isAllowedWebSocketOrigin(
  originHeader: string | string[] | undefined,
  allowedOrigins: readonly string[],
  requireOrigin: boolean
): boolean {
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!origin || !origin.trim()) {
    return !requireOrigin;
  }
  if (allowedOrigins.length === 0) {
    return !requireOrigin;
  }
  const normalized = normalizeOrigin(origin);
  return allowedOrigins.some((allowed) => normalizeOrigin(allowed) === normalized);
}

export async function registerUserWebSocketStream(
  app: FastifyInstance,
  options: RegisterUserWebSocketOptions
): Promise<UserWebSocketHandle> {
  const maxConnectionsPerUser = options.maxConnectionsPerUser ?? 5;
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const staleTimeoutMs = options.staleTimeoutMs ?? 60_000;
  const allowedOrigins = (options.allowedOrigins ?? []).filter(Boolean);
  const requireOrigin = options.requireOrigin ?? process.env.NODE_ENV === 'production';

  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 }
  });

  const socketsByUser = new Map<string, Set<WebSocketLike>>();
  const lastActivityBySocket = new WeakMap<WebSocketLike, number>();
  let lastPulseAt = 0;

  function addSocket(userId: string, socket: WebSocketLike): void {
    let set = socketsByUser.get(userId);
    if (!set) {
      set = new Set();
      socketsByUser.set(userId, set);
    }
    set.add(socket);
    lastActivityBySocket.set(socket, Date.now());
  }

  function removeSocket(userId: string, socket: WebSocketLike): void {
    const set = socketsByUser.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) {
      socketsByUser.delete(userId);
    }
  }

  function sendJson(socket: WebSocketLike, payload: unknown): boolean {
    if (socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function dispatchToUser(userId: string, payload: UserRealtimeEvent): void {
    const set = socketsByUser.get(userId);
    if (!set || set.size === 0) return;
    const envelope = {
      type: payload.type,
      ...(payload.data !== undefined ? { data: payload.data } : {}),
      ts: payload.ts ?? new Date().toISOString()
    };
    for (const socket of [...set]) {
      if (!sendJson(socket, envelope)) {
        removeSocket(userId, socket);
      }
    }
  }

  function broadcastPulse(source: 'feed' | 'signals'): void {
    const now = Date.now();
    if (now - lastPulseAt < 1500) return;
    lastPulseAt = now;
    // Emits a payload-free hint only; clients refresh via RLS/tier-enforced REST endpoints.
    const envelope = { type: 'activity_pulse', data: { source }, ts: new Date(now).toISOString() };
    for (const [userId, set] of socketsByUser) {
      for (const socket of [...set]) {
        if (!sendJson(socket, envelope)) {
          removeSocket(userId, socket);
        }
      }
    }
  }

  await options.subscriber
    .subscribe(REDIS_CHANNELS.userEvent, REDIS_CHANNELS.walletSwap, REDIS_CHANNELS.signalDetected)
    .catch((err) => {
      app.log.error({ err }, '[ws] failed to subscribe to Redis channels');
    });

  options.subscriber.on('message', (channel, message) => {
    if (channel === REDIS_CHANNELS.userEvent) {
      try {
        const parsed = JSON.parse(message) as { userId?: unknown; type?: unknown; data?: unknown; ts?: unknown };
        if (typeof parsed.userId === 'string' && parsed.userId && typeof parsed.type === 'string') {
          dispatchToUser(parsed.userId, {
            type: parsed.type,
            data: parsed.data,
            ts: typeof parsed.ts === 'string' ? parsed.ts : undefined
          });
        }
      } catch {
        // Ignore malformed Pub/Sub frames.
      }
      return;
    }
    if (channel === REDIS_CHANNELS.walletSwap) {
      broadcastPulse('feed');
      return;
    }
    if (channel === REDIS_CHANNELS.signalDetected) {
      broadcastPulse('signals');
    }
  });

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const pingFrame = { type: 'ping', ts: new Date(now).toISOString() };
    for (const [userId, set] of socketsByUser) {
      for (const socket of [...set]) {
        const lastActive = lastActivityBySocket.get(socket) ?? now;
        if (now - lastActive > staleTimeoutMs) {
          removeSocket(userId, socket);
          try {
            socket.terminate();
          } catch {
            // ignore
          }
          continue;
        }
        try {
          if (typeof socket.ping === 'function') socket.ping();
          sendJson(socket, pingFrame);
        } catch {
          removeSocket(userId, socket);
        }
      }
    }
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(heartbeatTimer);
    for (const set of socketsByUser.values()) {
      for (const socket of set) {
        try {
          socket.close(1001, 'Server shutting down');
        } catch {
          // ignore
        }
      }
      set.clear();
    }
    socketsByUser.clear();
    if (typeof options.subscriber.quit === 'function') {
      await options.subscriber.quit().catch(() => undefined);
    }
  });

  app.get(
    '/v1/me/ws',
    {
      websocket: true,
      preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
        if (!isAllowedWebSocketOrigin(request.headers.origin, allowedOrigins, requireOrigin)) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Disallowed WebSocket origin' });
        }
        const scope = requireUser(request, reply);
        if (!scope) return;
        const currentCount = socketsByUser.get(scope.userId)?.size ?? 0;
        if (currentCount >= maxConnectionsPerUser) {
          return reply.code(429).send({
            error: 'Too Many Requests',
            message: 'Concurrent WebSocket connection limit reached'
          });
        }
      }
    },
    (socket: WebSocketLike, request: FastifyRequest) => {
      const principal = request.principal;
      if (principal?.kind !== 'user') {
        socket.close(1008, 'Unauthorized');
        return;
      }
      const userId = principal.user.id;
      addSocket(userId, socket);

      sendJson(socket, {
        type: 'connected',
        ts: new Date().toISOString()
      });

      socket.on('pong', () => {
        lastActivityBySocket.set(socket, Date.now());
      });

      socket.on('message', (raw: unknown) => {
        lastActivityBySocket.set(socket, Date.now());
        try {
          const msg = JSON.parse(String(raw)) as { type?: unknown };
          if (msg?.type === 'pong' || msg?.type === 'ping') {
            if (msg.type === 'ping') {
              sendJson(socket, { type: 'pong', ts: new Date().toISOString() });
            }
          }
        } catch {
          // Ignore non-JSON frames from client.
        }
      });

      socket.on('close', () => {
        removeSocket(userId, socket);
      });

      socket.on('error', () => {
        removeSocket(userId, socket);
      });
    }
  );

  return {
    async publishUserEvent(userId, event) {
      if (!userId || userId === '*') return;
      const payload = JSON.stringify({
        userId,
        type: event.type,
        ...(event.data !== undefined ? { data: event.data } : {}),
        ts: event.ts ?? new Date().toISOString()
      });
      await options.publisher.publish(REDIS_CHANNELS.userEvent, payload).catch(() => undefined);
    },

    activeConnectionCount(userId) {
      if (userId) return socketsByUser.get(userId)?.size ?? 0;
      let total = 0;
      for (const set of socketsByUser.values()) total += set.size;
      return total;
    }
  };
}
