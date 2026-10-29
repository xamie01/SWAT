import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Context passed to KeyWrapper wrap/unwrap operations (`S4-4`).
 * Both AWS KMS, Vault Transit, and AES-GCM require this context for AAD binding.
 */
export interface WrapContext {
  readonly userId: string;
  readonly chainKind: 'evm' | 'solana';
  readonly keyVersion: number;
}

/**
 * KeyWrapper interface for envelope encryption (`S4-4`, D11).
 *
 * Provides the abstraction seam separating data-key encryption from key-storage
 * backends. Allows transitioning from environment master keys (EnvMasterKeyWrapper)
 * to Vault Transit (VaultTransitWrapper) or AWS KMS with zero business-logic refactoring.
 */
export interface KeyWrapper {
  /** Stable id embedded in every SealedKey this wrapper produces (e.g. 'env:v1', 'null:v1'). */
  readonly id: string;
  wrap(dataKey: Buffer, context: WrapContext): Promise<Buffer>;
  unwrap(wrapped: Buffer, context: WrapContext): Promise<Buffer>;
}

export function buildWrapAad(context: WrapContext): Buffer {
  return Buffer.from(`${context.userId}|${context.chainKind}|${context.keyVersion}`, 'utf8');
}

/**
 * EnvMasterKeyWrapper (`env:v<n>`)
 *
 * Implements envelope encryption using a master key loaded from environment variables
 * (e.g. `CUSTODY_MASTER_KEY`). Data keys are wrapped using AES-256-GCM with a fresh
 * 12-byte IV and AAD bound to the WrapContext.
 */
export class EnvMasterKeyWrapper implements KeyWrapper {
  readonly id: string;
  private readonly masterKey: Buffer;

  constructor(options?: { masterKey?: Buffer | string; version?: number }) {
    const version = options?.version ?? 1;
    this.id = `env:v${version}`;

    let rawKey = options?.masterKey ?? process.env.CUSTODY_MASTER_KEY;
    if (!rawKey) {
      // If neither is provided, check if CUSTODY_MASTER_KEY_HEX or default is set
      rawKey = process.env.CUSTODY_MASTER_KEY_HEX;
    }

    if (!rawKey) {
      throw new Error('[custody] EnvMasterKeyWrapper requires CUSTODY_MASTER_KEY to be configured');
    }

    if (Buffer.isBuffer(rawKey)) {
      this.masterKey = rawKey;
    } else if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
      this.masterKey = Buffer.from(rawKey, 'hex');
    } else {
      this.masterKey = Buffer.from(rawKey, 'utf8');
    }

    if (this.masterKey.length !== 32) {
      throw new Error(
        `[custody] EnvMasterKeyWrapper master key must be exactly 32 bytes (got ${this.masterKey.length})`
      );
    }
  }

  async wrap(dataKey: Buffer, context: WrapContext): Promise<Buffer> {
    if (dataKey.length !== 32) {
      throw new Error(`[custody] data key to wrap must be 32 bytes, got ${dataKey.length}`);
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(buildWrapAad(context));

    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Packed wire format for wrapped dataKey: IV (12) + Tag (16) + Ciphertext (32) = 60 bytes
    return Buffer.concat([iv, tag, ciphertext]);
  }

  async unwrap(wrapped: Buffer, context: WrapContext): Promise<Buffer> {
    if (wrapped.length !== 60) {
      throw new Error(
        `[custody] invalid wrapped data key length: expected 60 bytes, got ${wrapped.length}`
      );
    }

    const iv = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const ciphertext = wrapped.subarray(28);

    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAAD(buildWrapAad(context));
    decipher.setAuthTag(tag);

    try {
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext;
    } catch (error) {
      throw new Error('[custody] failed to unwrap data key: authentication tag mismatch or tampered context');
    }
  }
}

/**
 * NullWrapper (`null:v1`)
 *
 * Refuses wrap and unwrap operations. Used by staging and tests to guarantee that
 * simulated execution environments cannot accidentally access or store real custody secrets.
 */
export class NullWrapper implements KeyWrapper {
  readonly id = 'null:v1';

  async wrap(_dataKey: Buffer, _context: WrapContext): Promise<Buffer> {
    throw new Error('[custody] NullWrapper refuses to wrap secrets');
  }

  async unwrap(_wrapped: Buffer, _context: WrapContext): Promise<Buffer> {
    throw new Error('[custody] NullWrapper refuses to unwrap secrets');
  }
}
