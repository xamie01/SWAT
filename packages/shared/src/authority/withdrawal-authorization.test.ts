import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  buildWithdrawalAuthorizationMessage,
  verifySolanaWithdrawalAuthorization,
  type WithdrawalAuthorizationPayload
} from './withdrawal-authorization.js';

const B58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function bytesToBase58(bytes: Uint8Array): string {
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    for (let j = 0; j < digits.length; j++) {
      digits[j] <<= 8;
    }
    digits[0] += bytes[i];
    let carry = 0;
    for (let j = 0; j < digits.length; j++) {
      digits[j] += carry;
      carry = (digits[j] / 58) | 0;
      digits[j] %= 58;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    digits.push(0);
  }
  return digits
    .reverse()
    .map(d => B58_CHARS[d])
    .join('');
}

describe('verifySolanaWithdrawalAuthorization', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const ownerPubkey = bytesToBase58(rawPub);
  const recipientPubkey = 'Atk1111111111111111111111111111111111111111';

  function signPayload(payload: WithdrawalAuthorizationPayload, privKey: any): string {
    const message = buildWithdrawalAuthorizationMessage(payload);
    const msgBytes = Buffer.from(message, 'utf8');
    const sig = sign(null, msgBytes, privKey);
    return sig.toString('hex');
  }

  it('validates an authentic cryptographic withdrawal signature within window', () => {
    const now = Date.now();
    const payload: WithdrawalAuthorizationPayload = {
      chain: 'solana',
      ownerPubkey,
      recipientPubkey,
      amountLamports: 10_000_000n,
      timestampMs: now - 5_000,
      nonce: 'nonce-123'
    };

    const signatureHex = signPayload(payload, privateKey);
    const result = verifySolanaWithdrawalAuthorization({
      payload,
      signatureHex,
      nowMs: now
    });

    expect(result.valid).toBe(true);
    expect(result.code).toBe('auth-ok');
  });

  it('rejects an expired withdrawal authorization', () => {
    const now = Date.now();
    const payload: WithdrawalAuthorizationPayload = {
      chain: 'solana',
      ownerPubkey,
      recipientPubkey,
      amountLamports: 10_000_000n,
      timestampMs: now - 400_000, // 400s ago (> 300s maxAge)
      nonce: 'nonce-expired'
    };

    const signatureHex = signPayload(payload, privateKey);
    const result = verifySolanaWithdrawalAuthorization({
      payload,
      signatureHex,
      nowMs: now
    });

    expect(result.valid).toBe(false);
    expect(result.code).toBe('timestamp-expired');
    expect(result.reason).toContain('expired');
  });

  it('rejects an authorization with future timestamp exceeding drift tolerance', () => {
    const now = Date.now();
    const payload: WithdrawalAuthorizationPayload = {
      chain: 'solana',
      ownerPubkey,
      recipientPubkey,
      amountLamports: 10_000_000n,
      timestampMs: now + 60_000, // 60s in future (> 30s tolerance)
      nonce: 'nonce-future'
    };

    const signatureHex = signPayload(payload, privateKey);
    const result = verifySolanaWithdrawalAuthorization({
      payload,
      signatureHex,
      nowMs: now
    });

    expect(result.valid).toBe(false);
    expect(result.code).toBe('timestamp-future');
  });

  it('rejects zero or negative withdrawal amounts', () => {
    const now = Date.now();
    const payload: WithdrawalAuthorizationPayload = {
      chain: 'solana',
      ownerPubkey,
      recipientPubkey,
      amountLamports: 0n,
      timestampMs: now,
      nonce: 'nonce-zero'
    };

    const signatureHex = signPayload(payload, privateKey);
    const result = verifySolanaWithdrawalAuthorization({
      payload,
      signatureHex,
      nowMs: now
    });

    expect(result.valid).toBe(false);
    expect(result.code).toBe('invalid-amount');
  });

  it('rejects a forged or tampered signature (attacker impersonation)', () => {
    const now = Date.now();
    const { privateKey: attackerPrivateKey } = generateKeyPairSync('ed25519');

    const payload: WithdrawalAuthorizationPayload = {
      chain: 'solana',
      ownerPubkey,
      recipientPubkey,
      amountLamports: 10_000_000n,
      timestampMs: now,
      nonce: 'nonce-attack'
    };

    // Signed by attacker instead of authentic owner
    const forgedSig = signPayload(payload, attackerPrivateKey);

    const result = verifySolanaWithdrawalAuthorization({
      payload,
      signatureHex: forgedSig,
      nowMs: now
    });

    expect(result.valid).toBe(false);
    expect(result.code).toBe('invalid-signature');
    expect(result.reason).toContain('signer does not match owner');
  });
});
