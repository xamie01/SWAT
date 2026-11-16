import { describe, expect, it, vi } from 'vitest';
import * as withdrawal from './withdrawal-authorization.js';
// Opaque verifier fixtures only. This suite never generates keys or signatures.
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, createPublicKey: vi.fn(() => 'opaque-fixture-public-key'), verify: vi.fn(() => true) };
});
const legacy = { chain: 'solana' as const, ownerPubkey: '11111111111111111111111111111111', recipientPubkey: '11111111111111111111111111111111', amountLamports: 10n, timestampMs: 1000, nonce: 'fixture-intent' };
describe('package21 withdrawal containment', () => {
  it('verified legacy signatures are not executable single-use authorization', () => {
    const result = withdrawal.verifySolanaWithdrawalAuthorization({ payload: legacy, signatureHex: '11'.repeat(64), nowMs: 1000 });
    expect(result.valid).toBe(false);
    expect(result.code).toBe('intent-state-unavailable');
  });
  it('legacy messages cannot be silently reused as v2 resource-bound messages', () => {
    expect(() => withdrawal.buildWithdrawalAuthorizationMessage(legacy)).toThrow(/legacy/);
  });
  it('exposes only a pure durable intent transition contract, not a signing or execution consumer', () => {
    expect(withdrawal).toHaveProperty('planWithdrawalIntentConsumption');
    expect(withdrawal).toHaveProperty('buildWithdrawalIntentMessage');
  });
});
