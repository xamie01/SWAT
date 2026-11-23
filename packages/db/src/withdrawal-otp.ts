import { createHmac, randomInt } from 'node:crypto';
import { financialText, requireFinancial, type WithdrawalIntent } from './withdrawal-contract.js';
import type { WithdrawalOtpPorts } from './withdrawal-service.js';

/** The key owner supplies an existing protected secret for this operation only. No env/key generation/export. */
export interface WithdrawalOtpKeyPort {
  withKey<T>(operation: (key: Uint8Array) => T): Promise<T>;
}
export interface WithdrawalOtpRecipient {
  readonly userId: string;
  readonly recipientHandle: unknown;
  readonly verified: true;
}
export interface WithdrawalOtpDeliveryPort {
  resolveVerifiedRecipient(userId: string): Promise<WithdrawalOtpRecipient | null>;
  /** A protected principal channel, not an email/address taken from the request. Unknown is never sent. */
  deliver(recipient: WithdrawalOtpRecipient, code: string, intent: WithdrawalIntent): Promise<'sent' | 'failed' | 'unknown'>;
}
export interface WithdrawalOtpCapturePort {
  /** Must invoke consume on the protected principal channel. The caller receives no code/digest. */
  consume<T>(userId: string, intentId: string, authorizationId: string, consume: (code: string) => Promise<T>): Promise<T>;
}

/** Canonical concrete digest. Only the domain's private issue/digest seam ever sees the code. */
export function createProtectedWithdrawalOtp(input: {
  readonly key: WithdrawalOtpKeyPort;
  readonly delivery: WithdrawalOtpDeliveryPort;
}): WithdrawalOtpPorts {
  requireFinancial(input?.key && typeof input.key.withKey === 'function' && input.delivery
    && typeof input.delivery.resolveVerifiedRecipient === 'function' && typeof input.delivery.deliver === 'function',
  'withdrawal-protected-otp-capability-unavailable');
  async function digest(intentHash: string, code: string): Promise<string> {
    requireFinancial(/^[a-f0-9]{64}$/.test(intentHash) && /^[0-9]{6,10}$/.test(code), 'withdrawal-otp-invalid');
    return input.key.withKey(key => {
      requireFinancial(key instanceof Uint8Array && key.byteLength >= 32, 'withdrawal-protected-otp-key-unavailable');
      return createHmac('sha256', key).update(JSON.stringify(['SWAT-WITHDRAWAL-OTP', 1, intentHash, code])).digest('hex');
    });
  }
  return Object.freeze({
    async issue(intentHash: string) {
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      return { code, digest: await digest(intentHash, code) };
    },
    digest,
    async deliver(userId: string, code: string, intent: WithdrawalIntent) {
      financialText(userId);
      requireFinancial(userId === intent.userId, 'withdrawal-otp-principal-mismatch');
      const recipient = await input.delivery.resolveVerifiedRecipient(userId);
      requireFinancial(recipient?.verified === true && recipient.userId === userId && recipient.recipientHandle != null,
        'withdrawal-verified-recipient-unavailable');
      // Delivery errors are intentionally handled by the canonical service as unknown, with no resend on retry.
      const state = await input.delivery.deliver(recipient, code, intent);
      if (state === 'unknown') throw new Error('withdrawal-protected-otp-delivery-unknown');
      return state === 'sent';
    }
  });
}

/** Capture is single-use locally too; durable OTP consumption/replay remains the canonical SQL service's job. */
export async function consumeProtectedWithdrawalOtp<T>(capture: WithdrawalOtpCapturePort, userId: string,
  intentId: string, authorizationId: string, consume: (code: string) => Promise<T>): Promise<T> {
  requireFinancial(capture && typeof capture.consume === 'function', 'withdrawal-protected-otp-capture-unavailable');
  let called = false;
  const pending: { result?: Promise<T> } = {};
  await capture.consume(userId, intentId, authorizationId, code => {
    requireFinancial(!called, 'withdrawal-protected-otp-capture-reused');
    called = true;
    requireFinancial(typeof code === 'string' && /^[0-9]{6,10}$/.test(code), 'withdrawal-otp-invalid');
    pending.result = consume(code);
    return pending.result;
  });
  requireFinancial(called && pending.result, 'withdrawal-protected-otp-capture-unavailable');
  // Do not trust a capture callback's returned completion projection.
  return await pending.result;
}
