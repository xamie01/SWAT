import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  buildSignInMessage,
  generateNonce,
  normaliseAddress,
  verifySignInSignature
} from './wallet-signature.js';

const DOMAIN = 'app.swat.test';
const URI = 'https://app.swat.test';

function baseParams(address: string, nonce: string, chainKind: 'evm' | 'solana') {
  return {
    domain: DOMAIN,
    uri: URI,
    address,
    nonce,
    issuedAt: '2026-08-05T00:00:00.000Z',
    chainKind
  } as const;
}

describe('wallet signature verification', () => {
  describe('EVM (SIWE)', () => {
    it('accepts a signature from the claimed address', async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const nonce = generateNonce();
      const message = buildSignInMessage(baseParams(account.address, nonce, 'evm'));
      const signature = await account.signMessage({ message });

      const result = await verifySignInSignature({
        chainKind: 'evm',
        address: account.address,
        message,
        signature,
        expectedNonce: nonce,
        expectedDomain: DOMAIN,
        expectedUri: URI
      });

      expect(result).toEqual({ ok: true, address: account.address.toLowerCase() });
    });

    it('rejects a signature from a different key', async () => {
      const signer = privateKeyToAccount(generatePrivateKey());
      const victim = privateKeyToAccount(generatePrivateKey());
      const nonce = generateNonce();
      // Message claims the victim's address; signed by someone else.
      const message = buildSignInMessage(baseParams(victim.address, nonce, 'evm'));
      const signature = await signer.signMessage({ message });

      const result = await verifySignInSignature({
        chainKind: 'evm',
        address: victim.address,
        message,
        signature,
        expectedNonce: nonce,
        expectedDomain: DOMAIN,
        expectedUri: URI
      });

      expect(result).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('rejects a replayed nonce', async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const nonce = generateNonce();
      const message = buildSignInMessage(baseParams(account.address, nonce, 'evm'));
      const signature = await account.signMessage({ message });

      const result = await verifySignInSignature({
        chainKind: 'evm',
        address: account.address,
        message,
        signature,
        // Server expects a fresh nonce; the message carries the old one.
        expectedNonce: generateNonce(),
        expectedDomain: DOMAIN,
        expectedUri: URI
      });

      expect(result).toEqual({ ok: false, reason: 'nonce-mismatch' });
    });

    it('rejects a signature harvested for another domain', async () => {
      // The attack this guards: a user signs an identical-looking message on
      // evil.test, and the attacker replays it here. Signature is valid; intent
      // was never for this site.
      const account = privateKeyToAccount(generatePrivateKey());
      const nonce = generateNonce();
      const message = buildSignInMessage({
        ...baseParams(account.address, nonce, 'evm'),
        domain: 'evil.test'
      });
      const signature = await account.signMessage({ message });

      const result = await verifySignInSignature({
        chainKind: 'evm',
        address: account.address,
        message,
        signature,
        expectedNonce: nonce,
        expectedDomain: DOMAIN,
        expectedUri: URI
      });

      expect(result).toEqual({ ok: false, reason: 'domain-mismatch' });
    });

    it('rejects a mismatched URI', async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const nonce = generateNonce();
      const message = buildSignInMessage({
        ...baseParams(account.address, nonce, 'evm'),
        uri: 'https://other.test'
      });
      const signature = await account.signMessage({ message });

      const result = await verifySignInSignature({
        chainKind: 'evm',
        address: account.address,
        message,
        signature,
        expectedNonce: nonce,
        expectedDomain: DOMAIN,
        expectedUri: URI
      });

      expect(result).toEqual({ ok: false, reason: 'uri-mismatch' });
    });

    it('rejects when the claimed address differs from the one in the message', async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const other = privateKeyToAccount(generatePrivateKey());
      const nonce = generateNonce();
      const message = buildSignInMessage(baseParams(account.address, nonce, 'evm'));
      const signature = await account.signMessage({ message });

      const result = await verifySignInSignature({
        chainKind: 'evm',
        address: other.address,
        message,
        signature,
        expectedNonce: nonce,
        expectedDomain: DOMAIN,
        expectedUri: URI
      });

      expect(result).toEqual({ ok: false, reason: 'address-mismatch' });
    });

    it('fails closed on a malformed signature instead of throwing', async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const nonce = generateNonce();
      const message = buildSignInMessage(baseParams(account.address, nonce, 'evm'));

      const result = await verifySignInSignature({
        chainKind: 'evm',
        address: account.address,
        message,
        signature: '0xnotasignature',
        expectedNonce: nonce,
        expectedDomain: DOMAIN,
        expectedUri: URI
      });

      expect(result).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('rejects a message missing required fields', async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const result = await verifySignInSignature({
        chainKind: 'evm',
        address: account.address,
        message: 'just some text',
        signature: '0x00',
        expectedNonce: 'abc',
        expectedDomain: DOMAIN,
        expectedUri: URI
      });
      expect(result).toEqual({ ok: false, reason: 'malformed-message' });
    });
  });

  describe('Solana (SIWS)', () => {
    it('accepts a signature from the claimed address', () => {
      const keypair = nacl.sign.keyPair();
      const address = bs58.encode(keypair.publicKey);
      const nonce = generateNonce();
      const message = buildSignInMessage(baseParams(address, nonce, 'solana'));
      const signature = bs58.encode(
        nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey)
      );

      return expect(
        verifySignInSignature({
          chainKind: 'solana',
          address,
          message,
          signature,
          expectedNonce: nonce,
          expectedDomain: DOMAIN,
          expectedUri: URI
        })
      ).resolves.toEqual({ ok: true, address });
    });

    it('rejects a signature from a different keypair', async () => {
      const victim = nacl.sign.keyPair();
      const attacker = nacl.sign.keyPair();
      const address = bs58.encode(victim.publicKey);
      const nonce = generateNonce();
      const message = buildSignInMessage(baseParams(address, nonce, 'solana'));
      const signature = bs58.encode(
        nacl.sign.detached(new TextEncoder().encode(message), attacker.secretKey)
      );

      const result = await verifySignInSignature({
        chainKind: 'solana',
        address,
        message,
        signature,
        expectedNonce: nonce,
        expectedDomain: DOMAIN,
        expectedUri: URI
      });

      expect(result).toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('fails closed on undecodable base58 instead of throwing', async () => {
      const keypair = nacl.sign.keyPair();
      const address = bs58.encode(keypair.publicKey);
      const nonce = generateNonce();
      const message = buildSignInMessage(baseParams(address, nonce, 'solana'));

      const result = await verifySignInSignature({
        chainKind: 'solana',
        address,
        message,
        signature: '!!!not-base58!!!',
        expectedNonce: nonce,
        expectedDomain: DOMAIN,
        expectedUri: URI
      });

      expect(result).toEqual({ ok: false, reason: 'bad-signature' });
    });
  });

  describe('address normalisation', () => {
    it('lowercases EVM but preserves Solana case', () => {
      // Lowercasing base58 would produce a different, invalid public key.
      expect(normaliseAddress('evm', '0xAbCdEf0123456789')).toBe('0xabcdef0123456789');
      const solana = '7EqQdEULxWcraVx3mXKFjc84LhCkMGZCkRuDpvcMwJeK';
      expect(normaliseAddress('solana', solana)).toBe(solana);
    });
  });
});
