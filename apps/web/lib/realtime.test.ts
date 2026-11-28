import { describe, expect, it, vi } from 'vitest';
import {
  computeReconnectDelayMs,
  createRealtimeController,
  createStaleWhileReconnectingCache,
  resolveWsUrl,
  type RealtimeStatus,
  type SocketLike
} from './realtime.js';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Array<(ev: any) => void>>();

  addEventListener(event: 'open' | 'message' | 'close' | 'error', listener: (ev: any) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  emit(event: 'open' | 'message' | 'close' | 'error', ev: any = {}): void {
    if (event === 'open') this.readyState = 1;
    if (event === 'close') this.readyState = 3;
    for (const listener of this.listeners.get(event) ?? []) listener(ev);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit('close');
  }
}

describe('WebSocket URL and stale-while-reconnecting cache', () => {
  it('resolves wss/ws URLs from configured API URL or browser location', () => {
    expect(resolveWsUrl('/v1/me/ws', null, 'https://api.wake.trade')).toBe('wss://api.wake.trade/v1/me/ws');
    expect(resolveWsUrl('/v1/me/ws', null, 'http://localhost:3001')).toBe('ws://localhost:3001/v1/me/ws');
    expect(resolveWsUrl('/v1/me/ws', { protocol: 'https:', host: 'app.wake.trade' }, '')).toBe(
      'wss://app.wake.trade/v1/me/ws'
    );
  });

  it('retains cached snapshot within TTL and handles storage errors gracefully', () => {
    let clock = 1_000_000;
    const map = new Map<string, string>();
    const cache = createStaleWhileReconnectingCache<{ balances: number[] }>({
      key: 'swat:dash',
      storage: {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => {
          map.set(k, v);
        }
      },
      maxAgeMs: 60_000,
      now: () => clock
    });

    cache.write({ balances: [1250] });
    expect(cache.read()?.data).toEqual({ balances: [1250] });

    clock += 65_000;
    expect(cache.read()).toBeNull();
  });

  it('computes bounded exponential backoff with jitter', () => {
    expect(computeReconnectDelayMs(1, () => 0, { baseDelayMs: 1000, maxDelayMs: 30_000 })).toBe(1000);
    expect(computeReconnectDelayMs(3, () => 1, { baseDelayMs: 1000, maxDelayMs: 30_000 })).toBe(5000);
    expect(computeReconnectDelayMs(10, () => 1, { baseDelayMs: 1000, maxDelayMs: 30_000 })).toBe(30_000);
  });
});

describe('RealtimeController lifecycle', () => {
  it('connects, stops fallback polling while connected, and triggers delta sync + fallback only while disconnected', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const statuses: RealtimeStatus[] = [];
    const events: any[] = [];
    const onReconnectSync = vi.fn();
    const onFallbackPoll = vi.fn();

    const controller = createRealtimeController({
      url: 'wss://api.wake.trade/v1/me/ws',
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      onStatusChange: (s) => statuses.push(s),
      onEvent: (ev) => events.push(ev),
      onReconnectSync,
      onFallbackPoll,
      baseReconnectMs: 1000,
      fallbackPollMs: 5000,
      heartbeatTimeoutMs: 60_000,
      random: () => 0
    });

    controller.start();
    expect(sockets).toHaveLength(1);
    sockets[0]!.emit('open');
    expect(controller.getStatus()).toBe('connected');
    expect(onReconnectSync).not.toHaveBeenCalled();

    // Ping responds automatically and is not forwarded as an app event
    sockets[0]!.emit('message', { data: JSON.stringify({ type: 'ping', ts: '2026-11-28T00:00:01Z' }) });
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: 'pong' })]);
    expect(events).toHaveLength(0);

    // App event forwards cleanly
    sockets[0]!.emit('message', {
      data: JSON.stringify({ type: 'settings_changed', data: { killed: true }, ts: '2026-11-28T00:00:02Z' })
    });
    expect(events).toHaveLength(1);
    expect(controller.getLastSyncedAt()).toBe('2026-11-28T00:00:02Z');

    // No fallback polling while connected
    vi.advanceTimersByTime(10_000);
    expect(onFallbackPoll).not.toHaveBeenCalled();

    // Disconnect -> switches to reconnecting, preserves state, schedules reconnect at 1000ms
    sockets[0]!.emit('close');
    expect(controller.getStatus()).toBe('reconnecting');

    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);

    // Reconnect open triggers delta sync using lastSyncedAt timestamp
    sockets[1]!.emit('open');
    expect(controller.getStatus()).toBe('connected');
    expect(onReconnectSync).toHaveBeenCalledWith('2026-11-28T00:00:02Z');

    // Second disconnect running longer than 5s exercises fallback polling ONLY while disconnected
    sockets[1]!.emit('close');
    vi.advanceTimersByTime(5500);
    expect(onFallbackPoll).toHaveBeenCalled();

    controller.destroy();
    expect(controller.getStatus()).toBe('closed');
    expect(statuses).toContain('reconnecting');
    vi.useRealTimers();
  });
});
