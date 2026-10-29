import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  EnvMasterKeyWrapper,
  NullWrapper,
  type WrapContext
} from './key-wrapper.js';
import {
  sealSecret,
  openSealedSecret,
  EnvelopeAuthenticationError,
  EnvelopeEncryptionError
} from './envelope.js';

describe('Envelope Encryption and KeyWrapper (S4-3, S4-4)', () => {
  const masterKey = randomBytes(32);
  const wrapper = new EnvMasterKeyWrapper({ masterKey, version: 1 });
  const context: WrapContext = {
    userId: 'user-uuid-1234',
    chainKind: 'evm',
    keyVersion: 1
  };

  it('seals and opens secrets round-trip', async () => {
    const secret = Buffer.from('my-super-secret-session-key', 'utf8');
    const envelope = await sealSecret(secret, context, wrapper);

    expect(envelope).toMatch(/^v1\.env:v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);

    const opened = await openSealedSecret(envelope, context, wrapper);
    expect(opened.toString('utf8')).toBe('my-super-secret-session-key');
  });

  it('binds envelope to user context (AAD): swapping userId fails authentication', async () => {
    const secret = Buffer.from('user-a-secret', 'utf8');
    const envelope = await sealSecret(secret, context, wrapper);

    const attackerContext: WrapContext = {
      userId: 'attacker-uuid-9999',
      chainKind: 'evm',
      keyVersion: 1
    };

    await expect(openSealedSecret(envelope, attackerContext, wrapper)).rejects.toThrow(
      EnvelopeAuthenticationError
    );
  });

  it('binds envelope to chainKind (AAD): swapping evm to solana fails authentication', async () => {
    const secret = Buffer.from('chain-bound-secret', 'utf8');
    const envelope = await sealSecret(secret, context, wrapper);

    const wrongChainContext: WrapContext = {
      ...context,
      chainKind: 'solana'
    };

    await expect(openSealedSecret(envelope, wrongChainContext, wrapper)).rejects.toThrow(
      EnvelopeAuthenticationError
    );
  });

  it('binds envelope to keyVersion (AAD): swapping version fails authentication', async () => {
    const secret = Buffer.from('version-bound-secret', 'utf8');
    const envelope = await sealSecret(secret, context, wrapper);

    const wrongVersionContext: WrapContext = {
      ...context,
      keyVersion: 2
    };

    await expect(openSealedSecret(envelope, wrongVersionContext, wrapper)).rejects.toThrow(
      EnvelopeAuthenticationError
    );
  });

  it('detects tampered ciphertext', async () => {
    const secret = Buffer.from('tamper-test-secret', 'utf8');
    const envelope = await sealSecret(secret, context, wrapper);
    const parts = envelope.split('.');
    // Tamper with the ciphertext component (last part)
    const ctBuffer = Buffer.from(parts[5], 'base64');
    ctBuffer[0] ^= 0xff;
    parts[5] = ctBuffer.toString('base64');
    const tampered = parts.join('.');

    await expect(openSealedSecret(tampered, context, wrapper)).rejects.toThrow(
      EnvelopeAuthenticationError
    );
  });

  it('detects wrapper id mismatch', async () => {
    const secret = Buffer.from('wrapper-mismatch-secret', 'utf8');
    const envelope = await sealSecret(secret, context, wrapper);

    const wrapperV2 = new EnvMasterKeyWrapper({ masterKey, version: 2 });
    await expect(openSealedSecret(envelope, context, wrapperV2)).rejects.toThrow(
      /envelope wrapper mismatch: expected env:v2, got env:v1/
    );
  });

  it('NullWrapper refuses wrap and unwrap', async () => {
    const nullWrapper = new NullWrapper();
    expect(nullWrapper.id).toBe('null:v1');

    await expect(
      nullWrapper.wrap(randomBytes(32), context)
    ).rejects.toThrow(/NullWrapper refuses to wrap/);

    await expect(
      nullWrapper.unwrap(randomBytes(60), context)
    ).rejects.toThrow(/NullWrapper refuses to unwrap/);
  });

  it('refuses master key of invalid length', () => {
    expect(() => new EnvMasterKeyWrapper({ masterKey: randomBytes(16) })).toThrow(
      /must be exactly 32 bytes/
    );
    expect(() => new EnvMasterKeyWrapper({ masterKey: randomBytes(64) })).toThrow(
      /must be exactly 32 bytes/
    );
  });

  it('refuses to seal an empty secret', async () => {
    await expect(sealSecret(Buffer.alloc(0), context, wrapper)).rejects.toThrow(
      EnvelopeEncryptionError
    );
  });
});
