import { describe, expect, it, vi } from 'vitest';
import { deliverQueuedAlert } from './alert-delivery.js';

function harness() {
  const notification = {
    ownerToken: () => 'owner-a',
    claim: vi.fn().mockResolvedValue('claimed'),
    beginSend: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(true),
    uncertain: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(true),
    format: vi.fn().mockResolvedValue('signal message'),
    send: vi.fn().mockResolvedValue(undefined)
  };
  const dependencies = {
    notification,
    deliverSignal: vi.fn().mockRejectedValue(new Error('unsafe legacy delivery invoked')),
    sendOperational: vi.fn()
  };
  return { notification, dependencies };
}
const signal = { signalId: 'signal-a', pattern: 'snipe' };

describe('package24 signal notification public delivery seam', () => {
  it('persists send-start before transport and completes using the same owner', async () => {
    const { notification: n, dependencies } = harness();
    await expect(deliverQueuedAlert(signal, dependencies)).resolves.toEqual({ sent: true });
    expect(n.beginSend).toHaveBeenCalledWith('signal-a', 'owner-a');
    expect(n.beginSend.mock.invocationCallOrder[0]).toBeLessThan(n.send.mock.invocationCallOrder[0]);
    expect(n.complete).toHaveBeenCalledWith('signal-a', 'owner-a');
    expect(n.release).not.toHaveBeenCalled();
  });

  it('does not acknowledge a contended claim as a completed delivery', async () => {
    const { notification: n, dependencies } = harness();
    n.claim.mockResolvedValue('busy');
    await expect(deliverQueuedAlert(signal, dependencies)).rejects.toThrow('busy');
    expect(n.send).not.toHaveBeenCalled();
  });

  it.each(['delivered', 'uncertain', 'missing'])('never sends for %s', async state => {
    const { notification: n, dependencies } = harness();
    n.claim.mockResolvedValue(state);
    await expect(deliverQueuedAlert(signal, dependencies)).resolves.toMatchObject({ sent: false, reason: state });
    expect(n.send).not.toHaveBeenCalled();
  });

  it('retains reconciliation-required uncertainty after send succeeded but persistence failed', async () => {
    const { notification: n, dependencies } = harness();
    n.complete.mockRejectedValue(new Error('DB commit unavailable'));
    await expect(deliverQueuedAlert(signal, dependencies)).resolves.toEqual({ sent: null, reason: 'uncertain', reconciliationRequired: true });
    expect(n.uncertain).toHaveBeenCalledWith('signal-a', 'owner-a');
    expect(n.release).not.toHaveBeenCalled();
  });

  it('never releases a lease after send-start, even when uncertainty recording also fails', async () => {
    const { notification: n, dependencies } = harness();
    n.send.mockRejectedValue(new Error('transport timeout; remote outcome unknown'));
    n.uncertain.mockRejectedValue(new Error('DB unavailable'));
    await expect(deliverQueuedAlert(signal, dependencies)).resolves.toMatchObject({ sent: null, reconciliationRequired: true });
    expect(n.release).not.toHaveBeenCalled();
  });

  it('releases only its owner token on a pre-send formatting failure', async () => {
    const { notification: n, dependencies } = harness();
    n.format.mockRejectedValue(new Error('metadata unavailable'));
    await expect(deliverQueuedAlert(signal, dependencies)).rejects.toThrow('metadata unavailable');
    expect(n.release).toHaveBeenCalledWith('signal-a', 'owner-a');
    expect(n.send).not.toHaveBeenCalled();
  });

  it('an expired old owner cannot begin a send or release a newer send lease', async () => {
    const { notification: n, dependencies } = harness();
    n.beginSend.mockResolvedValue(false);
    await expect(deliverQueuedAlert(signal, dependencies)).rejects.toThrow('ownership');
    expect(n.release).toHaveBeenCalledWith('signal-a', 'owner-a');
    expect(n.send).not.toHaveBeenCalled();
  });
});
