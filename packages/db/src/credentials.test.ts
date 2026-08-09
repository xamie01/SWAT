import { describe, it, expect } from 'vitest';
import { hash as argonHash } from '@node-rs/argon2';
import {
  hashPassword,
  verifyPassword,
  verifyPasswordAgainstDummy,
  generateToken,
  hashToken,
  tokenMatches,
  generateApiKey,
  parseApiKeyPrefix
} from './credentials.js';

describe('credentials', () => {
  describe('password hashing', () => {
    it('accepts the correct password', async () => {
      const stored = await hashPassword('correct-horse-battery');
      expect(await verifyPassword(stored, 'correct-horse-battery')).toBe(true);
    });

    it('rejects the wrong password', async () => {
      const stored = await hashPassword('correct-horse-battery');
      expect(await verifyPassword(stored, 'wrong-horse-battery')).toBe(false);
    });

    it('produces a different hash for the same password (salted)', async () => {
      const a = await hashPassword('same-password');
      const b = await hashPassword('same-password');
      expect(a).not.toBe(b);
      expect(await verifyPassword(a, 'same-password')).toBe(true);
      expect(await verifyPassword(b, 'same-password')).toBe(true);
    });

    it('fails closed on a malformed stored hash rather than throwing', async () => {
      // A truncated or corrupted column value must not surface as a 500 that
      // tells the caller their password was at least well-formed.
      expect(await verifyPassword('not-an-argon2-hash', 'password')).toBe(false);
      expect(await verifyPassword('', 'password')).toBe(false);
      expect(await verifyPassword('$argon2id$v=19$truncated', 'password')).toBe(false);
    });

    it('verifies hashes written under different parameters', async () => {
      // The design doc claims argon2 parameters can be retuned without a
      // migration because the encoded hash carries its own parameters. If that
      // is false, changing ARGON2_OPTIONS silently locks every existing user out.
      const legacy = await argonHash('legacy-password', {
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1
      });
      expect(legacy).toContain('m=19456');
      expect(await verifyPassword(legacy, 'legacy-password')).toBe(true);
      expect(await verifyPassword(legacy, 'wrong')).toBe(false);
    });
  });

  describe('unknown-email timing defence', () => {
    it('always returns false', async () => {
      expect(await verifyPasswordAgainstDummy('anything')).toBe(false);
      expect(await verifyPasswordAgainstDummy('')).toBe(false);
    });

    it('costs about the same as a real verify, so timing does not enumerate users', async () => {
      const stored = await hashPassword('pw');
      // Warm both paths first; the dummy hash is generated lazily on first use
      // and that one-off cost would otherwise dominate the measurement.
      await verifyPassword(stored, 'pw');
      await verifyPasswordAgainstDummy('pw');

      const realStart = Date.now();
      await verifyPassword(stored, 'pw');
      const realMs = Date.now() - realStart;

      const dummyStart = Date.now();
      await verifyPasswordAgainstDummy('pw');
      const dummyMs = Date.now() - dummyStart;

      // Deliberately loose: this asserts the same order of magnitude, not a
      // constant-time guarantee, and must not flake on a busy CI box.
      expect(dummyMs).toBeGreaterThan(realMs * 0.25);
      expect(dummyMs).toBeLessThan(realMs * 4 + 50);
    });
  });

  describe('opaque tokens', () => {
    it('generates distinct high-entropy tokens', () => {
      const seen = new Set(Array.from({ length: 50 }, () => generateToken()));
      expect(seen.size).toBe(50);
      // 32 bytes base64url = 43 chars.
      expect([...seen][0]!.length).toBe(43);
    });

    it('matches only the digest of the same token', () => {
      const token = generateToken();
      expect(tokenMatches(hashToken(token), hashToken(token))).toBe(true);
      expect(tokenMatches(hashToken(token), hashToken(generateToken()))).toBe(false);
    });

    it('returns false rather than throwing on a length mismatch', () => {
      // timingSafeEqual throws on unequal lengths, which would itself be a leak
      // and a 500. The guard must absorb it.
      expect(() => tokenMatches(Buffer.from('short'), Buffer.alloc(32, 0xff))).not.toThrow();
      expect(tokenMatches(Buffer.from('short'), Buffer.alloc(32, 0xff))).toBe(false);
    });
  });

  describe('api keys', () => {
    it('generates well-formed, distinct keys', () => {
      const a = generateApiKey();
      const b = generateApiKey();
      // Prefix is hex so it can never contain the `_` delimiter.
      expect(a.key).toMatch(/^swat_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
      expect(a.hash.length).toBe(32);
      expect(a.key).not.toBe(b.key);
      expect(a.prefix).not.toBe(b.prefix);
    });

    it('round-trips its lookup prefix even when the secret contains underscores', () => {
      // Regression: the first implementation parsed with `split('_')` and
      // required exactly 3 parts. base64url includes `_`, so any key whose
      // secret contained one was rejected as malformed — roughly half of them.
      for (let i = 0; i < 40; i++) {
        const { key, prefix } = generateApiKey();
        expect(parseApiKeyPrefix(key)).toBe(prefix);
      }
      const withUnderscores = 'swat_0123abcd_secret_with_many_underscores';
      expect(parseApiKeyPrefix(withUnderscores)).toBe('0123abcd');
    });

    it('rejects malformed keys', () => {
      expect(parseApiKeyPrefix('noprefix')).toBe(null);
      expect(parseApiKeyPrefix('vendor_0123abcd_xyz')).toBe(null);
      expect(parseApiKeyPrefix('swat_missing-secret')).toBe(null);
      expect(parseApiKeyPrefix('swat_0123abcd')).toBe(null);
      expect(parseApiKeyPrefix('swat_0123abcd_')).toBe(null);
      expect(parseApiKeyPrefix('swat_SHORT_secret')).toBe(null);
      // Non-hex prefix of the right length must still be rejected.
      expect(parseApiKeyPrefix('swat_zzzzzzzz_secret')).toBe(null);
      expect(parseApiKeyPrefix('')).toBe(null);
    });

    it('hashes the full key, not just the secret', () => {
      const { key, hash } = generateApiKey();
      expect(tokenMatches(hashToken(key), hash)).toBe(true);
      const secretOnly = key.split('_')[2]!;
      expect(tokenMatches(hashToken(secretOnly), hash)).toBe(false);
    });
  });
});
