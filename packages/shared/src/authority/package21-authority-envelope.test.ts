import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as envelopes from './envelope.js';
import { buildWrapAad, EnvMasterKeyWrapper } from './key-wrapper.js';

// Fixed inert AES fixtures only: no entropy/key generation and no environment key reads.
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: vi.fn((size: number) => Buffer.alloc(size, 7)) };
});
const context = {
  contextVersion: 2 as const, userId: 'fixture-user', chainKind: 'evm' as const, keyVersion: 1,
  deploymentId: 'fixture-installation', chainId: '137', accountAddress: '0x1111111111111111111111111111111111111111',
  grantId: 'fixture-grant', grantKind: 'polymarket_signer', purpose: 'clob-l2-credentials'
};
const wrap = vi.fn(async () => Buffer.from('opaque-fixture-wrapped-key'));
const unwrap = vi.fn(async () => Buffer.alloc(32, 7));
const wrapper = { id: 'fixture:v1', wrap, unwrap };
beforeEach(() => vi.clearAllMocks());

describe('package21 resource envelopes', () => {
  it.each(['deploymentId', 'chainId', 'accountAddress', 'grantId', 'grantKind', 'purpose'] as const)(
    'authenticates concrete %s even when user and broad chain are unchanged', async field => {
      const sealed = await envelopes.sealSecret('inert-fixture', context, wrapper);
      await expect(envelopes.openSealedSecret(sealed, { ...context, [field]: 'other-resource' }, wrapper)).rejects.toThrow();
    }
  );
  it('writes only fully bound v2 and refuses implicit legacy sealing', async () => {
    await expect(envelopes.sealSecret('fixture', context, wrapper)).resolves.toMatch(/^v2\.fixture:v1\.1\./);
    await expect(envelopes.sealSecret('fixture', { userId: 'fixture-user', chainKind: 'evm', keyVersion: 1 } as typeof context, wrapper)).rejects.toThrow();
  });
  it('selects an exact registered old wrapper and never tries alternate decrypt keys', async () => {
    const sealed = await envelopes.sealSecret('fixture', context, wrapper);
    const alternate = { id: 'fixture:v2', unwrap: vi.fn(async () => Buffer.alloc(32, 7)) };
    const keyring = new Map([[wrapper.id, wrapper], [alternate.id, alternate]]);
    await expect(envelopes.openSealedSecret(sealed, context, keyring as never)).resolves.toEqual(Buffer.from('fixture'));
    expect(alternate.unwrap).not.toHaveBeenCalled();
    await expect(envelopes.openSealedSecret(sealed, context, new Map([[alternate.id, alternate]]) as never)).rejects.toThrow();
  });
  it('a wrap-only principal cannot decrypt and fails before any unwrap operation', async () => {
    const sealed = await envelopes.sealSecret('fixture', context, { id: wrapper.id, wrap } as never);
    await expect(envelopes.openSealedSecret(sealed, context, { id: wrapper.id, wrap } as never)).rejects.toThrow(/decrypt capability/);
    expect(unwrap).not.toHaveBeenCalled();
  });
  it('refuses default environment custody loading', () => {
    expect(() => new EnvMasterKeyWrapper()).toThrow(/explicit masterKey/);
  });
  it('uses unambiguous canonical encoding and rejects malformed domain fields', () => {
    expect(buildWrapAad(context)).not.toEqual(buildWrapAad({ ...context, grantId: 'other' }));
    expect(() => buildWrapAad({ ...context, purpose: 'purpose\nInjected: authority' })).toThrow();
    expect(() => buildWrapAad({ ...context, keyVersion: 0 })).toThrow();
  });
  it('refuses legacy by default but provides explicit re-encryption migration', () => {
    expect(envelopes).toHaveProperty('openLegacySealedSecretForMigration');
    expect(envelopes).toHaveProperty('migrateSealedSecret');
  });
});
