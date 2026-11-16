import type { SignalAlertPayload } from './alert-payload.js';

export type SignalNotificationClaim = 'claimed' | 'busy' | 'delivered' | 'uncertain' | 'missing';

export type SignalNotificationDependencies = {
  /** A fresh opaque token for every attempt, never shared across workers. */
  ownerToken(): string;
  claim(signalId: string, ownerToken: string): Promise<SignalNotificationClaim>;
  beginSend(signalId: string, ownerToken: string): Promise<boolean>;
  complete(signalId: string, ownerToken: string): Promise<boolean>;
  uncertain(signalId: string, ownerToken: string): Promise<boolean>;
  release(signalId: string, ownerToken: string): Promise<boolean>;
  format(payload: SignalAlertPayload): Promise<string>;
  send(message: string): Promise<void>;
};

/**
 * The durable sending marker commits BEFORE transport. A crash or ambiguous
 * response requires reconciliation, not automatic retransmission. Telegram has
 * no client idempotency key: this deliberately does not promise exactly-once.
 */
export async function deliverSignalNotification(
  payload: SignalAlertPayload,
  dependencies: SignalNotificationDependencies
) {
  const owner = dependencies.ownerToken();
  const claim = await dependencies.claim(payload.signalId, owner);
  if (claim === 'busy') throw new Error('notification lease busy; retry required');
  if (claim !== 'claimed') {
    return { sent: false, reason: claim, ...(claim === 'uncertain' ? { reconciliationRequired: true } : {}) };
  }

  // Failures before a committed send-start can safely return to pending. If
  // send-start commits but its response is lost, release is restricted to
  // preparing in the DB, so the sending marker still cannot be erased.
  try {
    const message = await dependencies.format(payload);
    if (!await dependencies.beginSend(payload.signalId, owner)) {
      throw new Error('notification ownership lost before send');
    }
    try {
      await dependencies.send(message);
      if (!await dependencies.complete(payload.signalId, owner)) {
        throw new Error('notification completion ownership lost');
      }
      return { sent: true };
    } catch {
      // Even if this write fails, the earlier durable sending marker remains
      // ineligible for resend. A later claimant exposes it as uncertain.
      await dependencies.uncertain(payload.signalId, owner).catch(() => false);
      return { sent: null, reason: 'uncertain', reconciliationRequired: true };
    }
  } catch (error) {
    await dependencies.release(payload.signalId, owner).catch(() => false);
    throw error;
  }
}
