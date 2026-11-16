import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Context passed to KeyWrapper wrap/unwrap operations (`S4-4`).
 * Both AWS KMS, Vault Transit, and AES-GCM require this context for AAD binding.
 */
/** v1 is migration-only: its three-field AAD cannot establish resource ownership. */
export interface LegacyWrapContext {
  readonly userId: string;
  readonly chainKind: 'evm' | 'solana';
  readonly keyVersion: number;
}

/** Values must come from the authenticated grant and trusted deployment domain. */
export interface ResourceWrapContext extends LegacyWrapContext {
  readonly contextVersion: 2;
  readonly deploymentId: string;
  readonly chainId: string;
  readonly accountAddress: string;
  readonly grantId: string;
  readonly grantKind: string;
  readonly purpose: string;
}

export type WrapContext = LegacyWrapContext | ResourceWrapContext;

/** Capability interfaces are not proof of a separately authorized KMS identity. */
export interface KeySealer {
  readonly id: string;
  wrap(dataKey: Buffer, context: WrapContext): Promise<Buffer>;
}
export interface KeyUnwrapper {
  readonly id: string;
  unwrap(wrapped: Buffer, context: WrapContext): Promise<Buffer>;
}
export interface KeyWrapper extends KeySealer, KeyUnwrapper {}

function requireContextString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 ||
      value.trim() !== value || /[\u0000-\u0020\u007f|]/.test(value)) {
    throw new Error(`[custody] invalid ${field}`);
  }
}

export function assertResourceWrapContext(context: WrapContext): asserts context is ResourceWrapContext {
  if (!context || !('contextVersion' in context) || context.contextVersion !== 2) {
    throw new Error('[custody] resource context v2 required; legacy context is migration-only');
  }
  for (const field of ['userId', 'deploymentId', 'chainId', 'accountAddress', 'grantId', 'grantKind', 'purpose'] as const) {
    requireContextString(context[field], field);
  }
  if (context.chainKind !== 'evm' && context.chainKind !== 'solana') throw new Error('[custody] invalid chain kind');
  if (!Number.isSafeInteger(context.keyVersion) || context.keyVersion <= 0) throw new Error('[custody] invalid key version');
  if (context.chainKind === 'evm' &&
      (!/^[1-9][0-9]*$/.test(context.chainId) || !/^0x[0-9a-f]{40}$/.test(context.accountAddress))) {
    throw new Error('[custody] EVM network and account must be canonical');
  }
}

export function buildLegacyWrapAad(context: LegacyWrapContext): Buffer {
  requireContextString(context.userId, 'userId');
  if (context.chainKind !== 'evm' && context.chainKind !== 'solana') throw new Error('[custody] invalid chain kind');
  if (!Number.isSafeInteger(context.keyVersion) || context.keyVersion <= 0) throw new Error('[custody] invalid key version');
  if ('contextVersion' in context) throw new Error('[custody] resource context cannot be downgraded to legacy');
  return Buffer.from(`${context.userId}|${context.chainKind}|${context.keyVersion}`, 'utf8');
}

export function buildWrapAad(context: WrapContext): Buffer {
  assertResourceWrapContext(context);
  return Buffer.from(JSON.stringify([
    'SWAT-AUTHORITY-ENVELOPE', 2, context.deploymentId, context.userId,
    context.chainKind, context.chainId, context.accountAddress, context.grantId,
    context.grantKind, context.purpose, context.keyVersion
  ]), 'utf8');
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
    const rawKey = options?.masterKey;
    if (!rawKey) {
      throw new Error('[custody] EnvMasterKeyWrapper requires explicit masterKey; API wrapping must use a separately authorized service');
    }
    const version = options?.version;
    if (!Number.isSafeInteger(version) || !version || version <= 0) {
      throw new Error('[custody] EnvMasterKeyWrapper requires an explicit positive version');
    }
    this.id = `env:v${version}`;

    if (Buffer.isBuffer(rawKey)) {
      this.masterKey = Buffer.from(rawKey);
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
    // Legacy AAD is reachable only through the explicit migration reader.
    decipher.setAAD('contextVersion' in context ? buildWrapAad(context) : buildLegacyWrapAad(context));
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
