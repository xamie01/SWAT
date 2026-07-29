import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisMocks = vi.hoisted(() => ({
  on: vi.fn(),
  lpush: vi.fn().mockResolvedValue(1),
  ltrim: vi.fn().mockResolvedValue('OK'),
  publish: vi.fn().mockResolvedValue(1)
}));

vi.mock('ioredis', () => ({
  Redis: class MockRedis {
    on = redisMocks.on;
    lpush = redisMocks.lpush;
    ltrim = redisMocks.ltrim;
    publish = redisMocks.publish;
  }
}));

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  redisMocks.lpush.mockResolvedValue(1);
  redisMocks.ltrim.mockResolvedValue('OK');
  redisMocks.publish.mockResolvedValue(1);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('logger serialization', () => {
  it('formats circular objects, bigint, errors, and functions without throwing', async () => {
    const {
      serializeLogArguments
    } = await import('./logger.js');
    const circular: Record<string, unknown> = { amount: 42n };
    circular.self = circular;

    const message = serializeLogArguments([
      circular,
      new Error('boom'),
      function worker() {}
    ]);

    expect(message).toContain('42n');
    expect(message).toContain('[Circular');
    expect(message).toContain('Error: boom');
    expect(message).toContain('[Function: worker]');
  });

  it('does not invoke getters or custom inspection hooks', async () => {
    const {
      serializeLogArguments
    } = await import('./logger.js');
    const getter = vi.fn(() => 'secret');
    const customInspect = vi.fn(() => 'custom');
    const value = Object.defineProperties({}, {
      hidden: { enumerable: true, get: getter },
      [Symbol.for('nodejs.util.inspect.custom')]: {
        value: customInspect
      }
    });

    const message = serializeLogArguments([value]);

    expect(message).toContain('[Getter]');
    expect(getter).not.toHaveBeenCalled();
    expect(customInspect).not.toHaveBeenCalled();
  });

  it('falls back for revoked proxies and truncates oversized output', async () => {
    const {
      serializeLogArguments
    } = await import('./logger.js');
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    expect(() => serializeLogArguments([revocable.proxy])).not.toThrow();
    expect(serializeLogArguments([revocable.proxy])).toBe('<Revoked Proxy>');
    expect(serializeLogArguments(['x'.repeat(25_000)])).toMatch(
      /\.\.\.\[truncated\]$/
    );
  });

  it('keeps console callers alive and publishes the safe message', async () => {
    const { initLogger } = await import('./logger.js');
    const circular: Record<string, unknown> = { id: 1 };
    circular.self = circular;

    initLogger('logger-test');

    expect(() => console.log('payload', circular, 99n)).not.toThrow();
    expect(() => console.error(new Error('failure'), circular)).not.toThrow();
    expect(redisMocks.lpush).toHaveBeenCalledTimes(2);

    const infoPayload = JSON.parse(redisMocks.lpush.mock.calls[0][1] as string);
    const errorPayload = JSON.parse(redisMocks.lpush.mock.calls[1][1] as string);
    expect(infoPayload).toMatchObject({
      service: 'logger-test',
      level: 'info'
    });
    expect(infoPayload.message).toContain('[Circular');
    expect(infoPayload.message).toContain('99n');
    expect(errorPayload).toMatchObject({
      service: 'logger-test',
      level: 'error'
    });
    expect(errorPayload.message).toContain('Error: failure');
  });
});
