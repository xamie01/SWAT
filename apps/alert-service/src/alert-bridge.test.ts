import { describe, expect, it, vi } from 'vitest';
import { createRedisAlertBridge, type AlertBridgeEnqueue } from './alert-bridge.js';
import { deliverQueuedAlert } from './alert-delivery.js';

const CHANNEL = 'swat:alert:queue';

function createDeliveryHarness() {
  const sentMessages: string[] = [];
  const deliverSignal = vi.fn().mockResolvedValue({ sent: true });
  const enqueue = vi.fn<AlertBridgeEnqueue>(async (_name, payload) => {
    await deliverQueuedAlert(payload, {
      deliverSignal,
      sendOperational: async (message) => {
        sentMessages.push(message);
      }
    });
  });
  const logRejected = vi.fn();
  const bridge = createRedisAlertBridge({
    channel: CHANNEL,
    enqueue,
    logRejected
  });
  return { bridge, deliverSignal, enqueue, logRejected, sentMessages };
}

describe('Redis alert bridge', () => {
  it('accepts, queues, formats, and delivers a nightly expectancy alert', async () => {
    const harness = createDeliveryHarness();
    const raw = JSON.stringify({
      type: 'NIGHTLY_EXPECTANCY',
      title: 'Nightly Expectancy Report',
      message: 'snipe | proven | solana | live\nCount: 12 | HR: 58.3% | Exp: $2.41'
    });

    const result = await harness.bridge.handleMessage(CHANNEL, raw);

    expect(result).toMatchObject({ accepted: true, kind: 'expectancy' });
    expect(harness.enqueue).toHaveBeenCalledOnce();
    expect(harness.enqueue.mock.calls[0][0]).toBe('expectancy-alert');
    expect(harness.enqueue.mock.calls[0][1]).toMatchObject({
      kind: 'expectancy',
      eventType: 'NIGHTLY_EXPECTANCY'
    });
    expect(harness.enqueue.mock.calls[0][2]).toMatchObject({
      attempts: 4,
      deduplication: { ttl: 300_000 },
      removeOnComplete: true
    });
    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]).toContain('<b>SWAT NIGHTLY EXPECTANCY</b>');
    expect(harness.sentMessages[0]).toContain('Count: 12 | HR: 58.3% | Exp: $2.41');
    expect(harness.deliverSignal).not.toHaveBeenCalled();
  });

  it('accepts a system alert and includes escaped operational context', async () => {
    const harness = createDeliveryHarness();
    const raw = JSON.stringify({
      type: 'ROBINHOOD_LIVE_NOT_READY',
      title: 'Robinhood <live> execution is not ready',
      message: 'Configured router & quoter do not match.',
      severity: 'critical',
      chain: 'robinhood-chain',
      requestedMode: 'live+shadow',
      checkedAt: '2026-07-26T10:00:00.000Z'
    });

    const result = await harness.bridge.handleMessage(CHANNEL, raw);

    expect(result).toMatchObject({ accepted: true, kind: 'system' });
    expect(harness.enqueue.mock.calls[0][0]).toBe('system-alert');
    expect(harness.sentMessages[0]).toContain('SWAT CRITICAL SYSTEM ALERT');
    expect(harness.sentMessages[0]).toContain('Robinhood &lt;live&gt; execution is not ready');
    expect(harness.sentMessages[0]).toContain('<b>Chain:</b> robinhood-chain');
    expect(harness.sentMessages[0]).toContain('Configured router &amp; quoter do not match.');
  });

  it('keeps escaped operational messages within Telegram limits', async () => {
    const harness = createDeliveryHarness();
    const raw = JSON.stringify({
      type: 'SYSTEM_CAP_EXCEEDED',
      title: '&'.repeat(200),
      message: '<'.repeat(12_000),
      severity: 'high',
      chain: '&'.repeat(64),
      requestedMode: 'live+shadow'
    });

    await harness.bridge.handleMessage(CHANNEL, raw);

    expect(harness.sentMessages[0].length).toBeLessThanOrEqual(4_096);
    expect(harness.sentMessages[0]).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/);
  });

  it('uses a stable deduplication ID for duplicate publications', async () => {
    const harness = createDeliveryHarness();
    const raw = JSON.stringify({
      type: 'SYSTEM_CAP_EXCEEDED',
      title: '24h Exposure Cap Exceeded: solana',
      message: 'A trade was blocked.',
      severity: 'high'
    });

    const first = await harness.bridge.handleMessage(CHANNEL, raw);
    const second = await harness.bridge.handleMessage(CHANNEL, raw);

    expect(first).toMatchObject({ accepted: true });
    expect(second).toMatchObject({ accepted: true });
    if (!first.accepted || !second.accepted) throw new Error('expected accepted alerts');
    expect(first.deduplicationId).toBe(second.deduplicationId);
    expect(harness.enqueue.mock.calls[0][2].deduplication?.id)
      .toBe(harness.enqueue.mock.calls[1][2].deduplication?.id);
  });

  it.each([
    ['invalid JSON', '{not-json'],
    ['missing message', JSON.stringify({ type: 'SYSTEM_CAP_EXCEEDED', title: 'Cap', severity: 'high' })],
    ['invalid severity', JSON.stringify({
      type: 'SYSTEM_CAP_EXCEEDED',
      title: 'Cap',
      message: 'Blocked',
      severity: 'urgent'
    })]
  ])('rejects %s without enqueueing or throwing', async (_label, raw) => {
    const harness = createDeliveryHarness();

    await expect(harness.bridge.handleMessage(CHANNEL, raw)).resolves.toEqual({
      accepted: false,
      reason: 'invalid_payload'
    });
    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.logRejected).toHaveBeenCalledOnce();
  });
});

describe('queued alert delivery', () => {
  it('preserves legacy signal-job routing', async () => {
    const deliverSignal = vi.fn().mockResolvedValue({ sent: true });
    const sendOperational = vi.fn();

    await deliverQueuedAlert({
      signalId: 'signal-123',
      pattern: 'snipe',
      tokenMint: 'mint-123',
      score: 91,
      isSafe: true
    }, { deliverSignal, sendOperational });

    expect(deliverSignal).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'signal',
      signalId: 'signal-123',
      pattern: 'snipe'
    }));
    expect(sendOperational).not.toHaveBeenCalled();
  });

  it('rejects malformed queued payloads before delivery', async () => {
    const deliverSignal = vi.fn();
    const sendOperational = vi.fn();

    await expect(deliverQueuedAlert({
      kind: 'system',
      eventType: 'NIGHTLY_EXPECTANCY',
      title: 'Wrong discriminant',
      message: 'This must not be sent.'
    }, { deliverSignal, sendOperational })).rejects.toThrow('alert kind does not match');
    expect(deliverSignal).not.toHaveBeenCalled();
    expect(sendOperational).not.toHaveBeenCalled();
  });

  it('propagates operational delivery failures for BullMQ retry handling', async () => {
    const deliveryError = new Error('Telegram unavailable');

    await expect(deliverQueuedAlert({
      kind: 'system',
      eventType: 'SYSTEM_CAP_EXCEEDED',
      title: 'Exposure cap exceeded',
      message: 'Trade blocked.',
      severity: 'high'
    }, {
      deliverSignal: vi.fn(),
      sendOperational: vi.fn().mockRejectedValue(deliveryError)
    })).rejects.toThrow('Telegram unavailable');
  });
});
