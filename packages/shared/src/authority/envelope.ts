import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { type KeyWrapper, type WrapContext, buildWrapAad } from './key-wrapper.js';

export class EnvelopeEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeEncryptionError';
  }
}

export class EnvelopeAuthenticationError extends EnvelopeEncryptionError {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeAuthenticationError';
  }
}

/**
 * Seals a plaintext secret under envelope encryption (`S4-3`, ADR-0003 §5).
 *
 * 1. Generates a fresh 32-byte AES-256-GCM data key.
 * 2. Encrypts the secret with the data key, a fresh 12-byte IV, and AAD bound to the user/chain/version.
 * 3. Wraps the data key using the provided KeyWrapper.
 * 4. Assembles the self-describing versioned envelope:
 *    `v1.<wrapperId>.<b64(wrappedDataKey)>.<b64(iv)>.<b64(authTag)>.<b64(ciphertext)>`
 */
export async function sealSecret(
  plaintext: Buffer | string,
  context: WrapContext,
  wrapper: KeyWrapper
): Promise<string> {
  const secretBytes = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  if (secretBytes.length === 0) {
    throw new EnvelopeEncryptionError('cannot seal an empty secret');
  }

  // 1. Fresh 32-byte data key
  const dataKey = randomBytes(32);

  // 2. Encrypt secret under dataKey
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(buildWrapAad(context));

  const ciphertext = Buffer.concat([cipher.update(secretBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // 3. Wrap data key
  const wrappedDataKey = await wrapper.wrap(dataKey, context);

  // 4. Assemble envelope
  return [
    'v1',
    wrapper.id,
    wrappedDataKey.toString('base64'),
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64')
  ].join('.');
}

/**
 * Opens a sealed secret envelope (`S4-3`, ADR-0003 §5).
 *
 * Validates the envelope format, checks wrapper ID, unwraps the data key with
 * the wrapper, and decrypts the ciphertext with GCM authentication.
 * If the ciphertext or context has been tampered with or swapped, throws an
 * EnvelopeAuthenticationError.
 */
export async function openSealedSecret(
  envelope: string,
  context: WrapContext,
  wrapper: KeyWrapper
): Promise<Buffer> {
  if (typeof envelope !== 'string') {
    throw new EnvelopeEncryptionError('envelope must be a string');
  }

  const parts = envelope.split('.');
  if (parts.length !== 6) {
    throw new EnvelopeEncryptionError(
      `invalid envelope format: expected 6 dot-separated components, got ${parts.length}`
    );
  }

  const [version, wrapperId, b64WrappedDataKey, b64Iv, b64AuthTag, b64Ciphertext] = parts;

  if (version !== 'v1') {
    throw new EnvelopeEncryptionError(`unsupported envelope version: ${version}`);
  }

  if (wrapperId !== wrapper.id) {
    throw new EnvelopeEncryptionError(
      `envelope wrapper mismatch: expected ${wrapper.id}, got ${wrapperId}`
    );
  }

  const wrappedDataKey = Buffer.from(b64WrappedDataKey, 'base64');
  const iv = Buffer.from(b64Iv, 'base64');
  const authTag = Buffer.from(b64AuthTag, 'base64');
  const ciphertext = Buffer.from(b64Ciphertext, 'base64');

  if (iv.length !== 12) {
    throw new EnvelopeEncryptionError(`invalid IV length: expected 12 bytes, got ${iv.length}`);
  }
  if (authTag.length !== 16) {
    throw new EnvelopeEncryptionError(
      `invalid auth tag length: expected 16 bytes, got ${authTag.length}`
    );
  }

  // 1. Unwrap data key
  let dataKey: Buffer;
  try {
    dataKey = await wrapper.unwrap(wrappedDataKey, context);
  } catch (error) {
    throw new EnvelopeAuthenticationError(
      `data key unwrap failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 2. Decrypt secret
  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, iv);
    decipher.setAAD(buildWrapAad(context));
    decipher.setAuthTag(authTag);

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext;
  } catch (error) {
    throw new EnvelopeAuthenticationError(
      'secret decryption failed: ciphertext tampered or AAD mismatch (user/chain/version mismatch)'
    );
  }
}
