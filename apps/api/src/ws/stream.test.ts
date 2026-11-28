import Fastify from 'fastify';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { REDIS_CHANNELS } from '@swat/shared';
import { registerUserWebSocketStream } from './stream.js';

function createMockPubSub() {
  const emitter = new EventEmitter();
  const subscribed: string[] = [];
  return {
    subscribed,
    subscriber: {
      subscribe: async (...channels: string[]) => {
        subscribed.push(...channels);
        return channels.length;
      },
      on: (event: 'message', listener: (channel: string, message: string) => void) =>
        emitter.on(event, listener)
    },
    publisher: {
      publish: async (channel: string, message: string) => {
        emitter.emit('message', channel, message);
        return 1;
      }
    }
  };
}

function receiveNextJson(ws: { once: Function }): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    ws.once('message', (buf: unknown) => {
      resolve(JSON.parse(String(buf)));
    });
  });
}

describe('User WebSocket Stream (/v1/me/ws)', () => {
  const ALICE = '11111111-1111-4111-8111-111111111111';
  const BOB = '22222222-2222-4222-8222-222222222222';

  async function buildApp(options: { maxConnectionsPerUser?: number; requireOrigin?: boolean } = {}) {
    const pubsub = createMockPubSub();
    const app = Fastify({ logger: false });
    app.decorateRequest('principal', undefined);
    app.addHook('onRequest', async (request) => {
      const userHeader = request.headers['x-test-user'];
      const kindHeader = request.headers['x-test-kind'];
      if (kindHeader === 'service') {
        request.principal = { kind: 'service' };
        return;
      }
      if (typeof userHeader === 'string' && userHeader) {
        request.principal = {
          kind: 'user',
          sessionId: 'sess-1',
          user: { id: userHeader, tier: 'operator', tierExpiresAt: null, role: 'user', status: 'active' } as any
        };
      }
    });

    const handle = await registerUserWebSocketStream(app, {
      subscriber: pubsub.subscriber,
      publisher: pubsub.publisher,
      allowedOrigins: ['https://app.wake.trade'],
      requireOrigin: options.requireOrigin ?? true,
      maxConnectionsPerUser: options.maxConnectionsPerUser ?? 2,
      heartbeatMs: 5_000,
      staleTimeoutMs: 15_000
    });

    return { app, pubsub, handle };
  }

  it('rejects unauthenticated, service-principal, and disallowed-origin WebSocket upgrades', async () => {
    const { app } = await buildApp();
    await app.ready();

    try {
      await expect(
        app.injectWS('/v1/me/ws', { headers: { origin: 'https://evil.example', 'x-test-user': ALICE } })
      ).rejects.toThrow();

      await expect(
        app.injectWS('/v1/me/ws', { headers: { 'x-test-user': ALICE } })
      ).rejects.toThrow();

      await expect(
        app.injectWS('/v1/me/ws', { headers: { origin: 'https://app.wake.trade' } })
      ).rejects.toThrow();

      await expect(
        app.injectWS('/v1/me/ws', { headers: { origin: 'https://app.wake.trade', 'x-test-kind': 'service' } })
      ).rejects.toThrow();
    } finally {
      await app.close();
    }
  });

  it('delivers tenant-scoped user events strictly to matching userId and enforces per-user socket cap', async () => {
    const { app, pubsub, handle } = await buildApp({ maxConnectionsPerUser: 2 });
    await app.ready();
    expect(pubsub.subscribed).toEqual(
      expect.arrayContaining([REDIS_CHANNELS.userEvent, REDIS_CHANNELS.walletSwap, REDIS_CHANNELS.signalDetected])
    );

    const aliceWs = await app.injectWS('/v1/me/ws', {
      headers: { origin: 'https://app.wake.trade', 'x-test-user': ALICE }
    });
    const bobWs = await app.injectWS('/v1/me/ws', {
      headers: { origin: 'https://app.wake.trade', 'x-test-user': BOB }
    });

    const aliceMessages: Record<string, any>[] = [];
    const bobMessages: Record<string, any>[] = [];
    aliceWs.on('message', (buf) => aliceMessages.push(JSON.parse(String(buf))));
    bobWs.on('message', (buf) => bobMessages.push(JSON.parse(String(buf))));

    const bobNext = receiveNextJson(bobWs);
    await handle.publishUserEvent(BOB, { type: 'settings_changed', data: { killed: true } });
    const receivedByBob = await bobNext;

    expect(receivedByBob.type).toBe('settings_changed');
    expect(receivedByBob.data).toEqual({ killed: true });
    expect(aliceMessages.some((m) => m.type === 'settings_changed')).toBe(false);

    // Enforces maxConnectionsPerUser = 2
    const aliceWs2 = await app.injectWS('/v1/me/ws', {
      headers: { origin: 'https://app.wake.trade', 'x-test-user': ALICE }
    });
    expect(handle.activeConnectionCount(ALICE)).toBe(2);

    await expect(
      app.injectWS('/v1/me/ws', {
        headers: { origin: 'https://app.wake.trade', 'x-test-user': ALICE }
      })
    ).rejects.toThrow();

    aliceWs.terminate();
    aliceWs2.terminate();
    bobWs.terminate();
    await app.close();
  });
});
