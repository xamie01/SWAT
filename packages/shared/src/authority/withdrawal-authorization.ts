import { createPublicKey, verify } from 'node:crypto';
import { resolveChainAddress } from '../address.js';

export interface WithdrawalAuthorizationPayload {
  readonly chain: 'solana' | 'robinhood-chain' | 'polygon';
  readonly ownerPubkey: string;
  readonly recipientPubkey: string;
  readonly amountLamports: bigint;
  readonly timestampMs: number;
  readonly nonce: string;
}

export interface VerificationResult {
  readonly valid: boolean;
  readonly reason?: string;
  readonly code?:
    | 'auth-ok'
    | 'invalid-amount'
    | 'timestamp-expired'
    | 'timestamp-future'
    | 'invalid-owner'
    | 'invalid-signature';
}

// SPKI DER prefix for raw 32-byte Ed25519 public keys (RFC 8410)
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Builds the canonical plaintext message to be signed by the user's wallet.
 *
 * Enforces strict line-delimited key-value structure so signatures cannot be
 * cross-interpreted across chains, recipients, or times.
 */
export function buildWithdrawalAuthorizationMessage(payload: WithdrawalAuthorizationPayload): string {
  return [
    'WAKE-VAULT-WITHDRAWAL',
    `Chain: ${payload.chain}`,
    `Owner: ${payload.ownerPubkey}`,
    `Recipient: ${payload.recipientPubkey}`,
    `AmountLamports: ${payload.amountLamports.toString()}`,
    `Timestamp: ${payload.timestampMs}`,
    `Nonce: ${payload.nonce}`
  ].join('\n');
}

/**
 * Cryptographically verifies an off-chain withdrawal authorization request (S4-P21, ADR-0003 §5).
 *
 * Guarantees:
 *   1. Non-zero amount requested.
 *   2. Strict replay protection via expiration window (default 5 minutes).
 *   3. Clock drift bound (maximum 30s future tolerance).
 *   4. Valid Ed25519 signature verified directly against the authentic owner public key using native crypto.
 */
export function verifySolanaWithdrawalAuthorization(opts: {
  readonly payload: WithdrawalAuthorizationPayload;
  readonly signatureHex: string;
  readonly nowMs?: number;
  readonly maxAgeMs?: number;
}): VerificationResult {
  const { payload, signatureHex, nowMs = Date.now(), maxAgeMs = 300_000 } = opts;

  // 1. Amount verification
  if (payload.amountLamports <= 0n) {
    return {
      valid: false,
      code: 'invalid-amount',
      reason: 'Withdrawal amount must be greater than zero'
    };
  }

  // 2. Replay window: expired check
  if (nowMs - payload.timestampMs > maxAgeMs) {
    return {
      valid: false,
      code: 'timestamp-expired',
      reason: `Authorization expired: timestamp ${payload.timestampMs} exceeds max age of ${maxAgeMs}ms`
    };
  }

  // 3. Clock drift: future timestamp check
  if (payload.timestampMs - nowMs > 30_000) {
    return {
      valid: false,
      code: 'timestamp-future',
      reason: `Authorization timestamp is too far in the future (${payload.timestampMs} vs ${nowMs})`
    };
  }

  // 4. Validate and decode owner public key
  let rawOwnerBytes: Buffer;
  try {
    const resolved = resolveChainAddress(payload.ownerPubkey, 'solana');
    rawOwnerBytes = Buffer.from(decodeBase58Pubkey(resolved.raw));
    if (rawOwnerBytes.length !== 32) {
      throw new Error('Solana public key must be exactly 32 bytes');
    }
  } catch (err) {
    return {
      valid: false,
      code: 'invalid-owner',
      reason: `Invalid owner public key: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  // 5. Decode signature
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signatureHex, 'hex');
    if (signatureBytes.length !== 64) {
      throw new Error('Ed25519 signature must be exactly 64 bytes');
    }
  } catch (err) {
    return {
      valid: false,
      code: 'invalid-signature',
      reason: `Malformed signature format: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  // 6. Verify Ed25519 signature over canonical message using native node:crypto
  try {
    const publicKeyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawOwnerBytes]),
      format: 'der',
      type: 'spki'
    });

    const message = buildWithdrawalAuthorizationMessage(payload);
    const messageBuffer = Buffer.from(message, 'utf8');

    const isValid = verify(null, messageBuffer, publicKeyObject, signatureBytes);

    if (!isValid) {
      return {
        valid: false,
        code: 'invalid-signature',
        reason: 'Ed25519 cryptographic signature verification failed: signer does not match owner'
      };
    }
  } catch (err) {
    return {
      valid: false,
      code: 'invalid-signature',
      reason: `Cryptographic verification error: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  return { valid: true, code: 'auth-ok' };
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Uint8Array(256).fill(255);
for (let i = 0; i < B58_ALPHABET.length; i++) {
  B58_MAP[B58_ALPHABET.charCodeAt(i)] = i;
}

function decodeBase58Pubkey(input: string): Uint8Array {
  const bytes = [0];
  for (let i = 0; i < input.length; i++) {
    const val = B58_MAP[input.charCodeAt(i)];
    if (val === 255) throw new Error(`Invalid Base58 character: ${input[i]}`);
    for (let j = 0; j < bytes.length; j++) {
      bytes[j] *= 58;
    }
    bytes[0] += val;
    let carry = 0;
    for (let j = 0; j < bytes.length; j++) {
      bytes[j] += carry;
      carry = bytes[j] >> 8;
      bytes[j] &= 0xff;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < input.length && input[i] === '1'; i++) {
    bytes.push(0);
  }
  const result = new Uint8Array(bytes.reverse());
  if (result.length > 32) {
    const leading = result.length - 32;
    for (let i = 0; i < leading; i++) {
      if (result[i] !== 0) throw new Error('Base58 string decodes to more than 32 bytes');
    }
    return result.slice(leading);
  }
  if (result.length < 32) {
    const padded = new Uint8Array(32);
    padded.set(result, 32 - result.length);
    return padded;
  }
  return result;
}
