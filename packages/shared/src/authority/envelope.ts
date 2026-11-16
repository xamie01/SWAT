import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  type KeySealer, type KeyUnwrapper, type LegacyWrapContext, type ResourceWrapContext,
  assertResourceWrapContext, buildLegacyWrapAad, buildWrapAad
} from './key-wrapper.js';

export class EnvelopeEncryptionError extends Error {
  constructor(message: string) { super(message); this.name = 'EnvelopeEncryptionError'; }
}
export class EnvelopeAuthenticationError extends EnvelopeEncryptionError {
  constructor(message: string) { super(message); this.name = 'EnvelopeAuthenticationError'; }
}

function wrapperId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(id)) {
    throw new EnvelopeEncryptionError('invalid wrapper identifier');
  }
}
function payloadAad(context: ResourceWrapContext, id: string): Buffer {
  return Buffer.from(JSON.stringify(['SWAT-SECRET', 2, id, buildWrapAad(context).toString('utf8')]));
}
function bytes(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || !value) {
    throw new EnvelopeEncryptionError('noncanonical envelope encoding');
  }
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value) throw new EnvelopeEncryptionError('noncanonical envelope encoding');
  return result;
}
function selectUnwrapper(id: string, keys: KeyUnwrapper | ReadonlyMap<string, KeyUnwrapper>): KeyUnwrapper {
  const selected = 'get' in keys ? keys.get(id) : keys;
  if (!selected || selected.id !== id) throw new EnvelopeEncryptionError('envelope wrapper not registered');
  if (typeof selected.unwrap !== 'function') throw new EnvelopeEncryptionError('decrypt capability unavailable');
  return selected;
}

/** New writes require complete resource binding. A wrap-only type is not KMS isolation proof. */
export async function sealSecret(plaintext: Buffer | string, context: ResourceWrapContext, wrapper: KeySealer): Promise<string> {
  assertResourceWrapContext(context);
  wrapperId(wrapper.id);
  const secretBytes = Buffer.isBuffer(plaintext) ? Buffer.from(plaintext) : Buffer.from(plaintext, 'utf8');
  if (secretBytes.length === 0) throw new EnvelopeEncryptionError('cannot seal an empty secret');
  const dataKey = randomBytes(32);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(payloadAad(context, wrapper.id));
    const ciphertext = Buffer.concat([cipher.update(secretBytes), cipher.final()]);
    const wrapped = await wrapper.wrap(dataKey, context);
    if (!wrapped.length) throw new EnvelopeEncryptionError('empty wrapped data key');
    return ['v2', wrapper.id, String(context.keyVersion), wrapped.toString('base64'), iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
  } finally {
    dataKey.fill(0);
    secretBytes.fill(0);
  }
}

async function decrypt(parts: string[], context: ResourceWrapContext | LegacyWrapContext, wrapper: KeyUnwrapper, legacy: boolean): Promise<Buffer> {
  const offset = legacy ? 2 : 3;
  const wrapped = bytes(parts[offset]!);
  const iv = bytes(parts[offset + 1]!);
  const tag = bytes(parts[offset + 2]!);
  const ciphertext = bytes(parts[offset + 3]!);
  if (iv.length !== 12 || tag.length !== 16) throw new EnvelopeEncryptionError('invalid IV or auth tag length');
  let key: Buffer | undefined;
  try {
    // Own a copy: zeroing must not mutate a KMS adapter cache.
    key = Buffer.from(await wrapper.unwrap(wrapped, context));
    if (key.length !== 32) throw new Error('invalid data key');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(legacy ? buildLegacyWrapAad(context) : payloadAad(context as ResourceWrapContext, wrapper.id));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new EnvelopeAuthenticationError('secret authentication failed');
  } finally {
    key?.fill(0);
  }
}

/** No legacy fallback and no trial decryption across keys; exactly the registered envelope ID. */
export async function openSealedSecret(envelope: string, context: ResourceWrapContext, keys: KeyUnwrapper | ReadonlyMap<string, KeyUnwrapper>): Promise<Buffer> {
  assertResourceWrapContext(context);
  if (typeof envelope !== 'string') throw new EnvelopeEncryptionError('envelope must be a string');
  const parts = envelope.split('.');
  if (parts.length !== 7 || parts[0] !== 'v2') throw new EnvelopeEncryptionError('v2 envelope required; legacy reads are migration-only');
  wrapperId(parts[1]!);
  if (parts[2] !== String(context.keyVersion)) throw new EnvelopeAuthenticationError('key version mismatch');
  return decrypt(parts, context, selectUnwrapper(parts[1]!, keys), false);
}

/** Privileged migration seam only. v1 cannot prove the destination account/grant/domain. */
export async function openLegacySealedSecretForMigration(envelope: string, context: LegacyWrapContext, legacyWrapper: KeyUnwrapper): Promise<Buffer> {
  buildLegacyWrapAad(context);
  const parts = envelope.split('.');
  if (parts.length !== 6 || parts[0] !== 'v1') throw new EnvelopeEncryptionError('legacy v1 envelope required');
  wrapperId(parts[1]!);
  return decrypt(parts, context, selectUnwrapper(parts[1]!, legacyWrapper), true);
}

/** Re-encrypt to change ciphertext AAD. Caller must audit provenance and atomically CAS the old row. */
export async function migrateSealedSecret(input: {
  envelope: string; legacyContext: LegacyWrapContext; legacyWrapper: KeyUnwrapper;
  context: ResourceWrapContext; wrapper: KeySealer;
}): Promise<string> {
  assertResourceWrapContext(input.context);
  if (input.context.userId !== input.legacyContext.userId || input.context.chainKind !== input.legacyContext.chainKind) {
    throw new EnvelopeAuthenticationError('migration cannot change legacy tenant or chain kind');
  }
  const secret = await openLegacySealedSecretForMigration(input.envelope, input.legacyContext, input.legacyWrapper);
  try { return await sealSecret(secret, input.context, input.wrapper); }
  finally { secret.fill(0); }
}
