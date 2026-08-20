import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildClobAuthTypedData,
  buildClobL2Headers,
  CLOB_CHAIN_ID,
  redactCredentials,
  signClobL2Request,
  type ClobCredentials
} from './polymarket-clob-auth.js';

// A real base64 value, so `Buffer.from(secret, 'base64')` decodes to actual key
// bytes rather than silently producing an empty buffer.
const SECRET = Buffer.from('swat-test-secret-key-material-32').toString('base64');

const credentials: ClobCredentials = {
  apiKey: '7b1e2d60-6f9a-4dd7-8f3e-21b8f94c77a2',
  secret: SECRET,
  passphrase: '9fH3kL7m2qW8xP4r'
};

describe('CLOB L1 auth payload', () => {
  it('pins the ClobAuthDomain and Polygon chain id', () => {
    const typed = buildClobAuthTypedData({
      signerAddress: '0xabc',
      timestampSeconds: 1_780_000_000
    });
    expect(typed.domain).toEqual({ name: 'ClobAuthDomain', version: '1', chainId: 137 });
    expect(CLOB_CHAIN_ID).toBe(137);
    expect(typed.primaryType).toBe('ClobAuth');
  });

  it('encodes timestamp as a string, matching the struct type', () => {
    // The struct declares `timestamp` as `string`. A numeric encoding hashes
    // differently and fails signature recovery server-side.
    const typed = buildClobAuthTypedData({
      signerAddress: '0xabc',
      timestampSeconds: 1_780_000_000
    });
    expect(typed.message.timestamp).toBe('1780000000');
    expect(typeof typed.message.timestamp).toBe('string');
  });

  it('defaults the nonce to 0 and carries the exact attestation text', () => {
    const typed = buildClobAuthTypedData({ signerAddress: '0xabc', timestampSeconds: 1 });
    expect(typed.message.nonce).toBe(0);
    expect(typed.message.message).toBe(
      'This message attests that I control the given wallet'
    );
  });
});

describe('CLOB L2 request signing', () => {
  it('signs timestamp + METHOD + path with the base64-DECODED secret', () => {
    const signature = signClobL2Request({
      secret: SECRET,
      timestampSeconds: 1_780_000_000,
      method: 'GET',
      path: '/data/orders'
    });

    // Recomputed independently: the key must be the decoded bytes, not the
    // base64 text. Using the text as the key is the classic failure here and
    // produces a signature that never verifies.
    const expected = createHmac('sha256', Buffer.from(SECRET, 'base64'))
      .update('1780000000GET/data/orders')
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    expect(signature).toBe(expected);
  });

  it('uppercases the method', () => {
    const lower = signClobL2Request({
      secret: SECRET,
      timestampSeconds: 1,
      method: 'post',
      path: '/orders'
    });
    const upper = signClobL2Request({
      secret: SECRET,
      timestampSeconds: 1,
      method: 'POST',
      path: '/orders'
    });
    expect(lower).toBe(upper);
  });

  it('appends the body verbatim', () => {
    const body = '[{"order":{"a":1}}]';
    const signature = signClobL2Request({
      secret: SECRET,
      timestampSeconds: 42,
      method: 'POST',
      path: '/orders',
      body
    });
    const expected = createHmac('sha256', Buffer.from(SECRET, 'base64'))
      .update(`42POST/orders${body}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    expect(signature).toBe(expected);
  });

  it('differs when the body differs, even by whitespace', () => {
    // The signature covers the exact bytes on the wire, so re-serializing a
    // body before signing would break verification.
    const a = signClobL2Request({
      secret: SECRET, timestampSeconds: 1, method: 'POST', path: '/orders', body: '{"a":1}'
    });
    const b = signClobL2Request({
      secret: SECRET, timestampSeconds: 1, method: 'POST', path: '/orders', body: '{"a": 1}'
    });
    expect(a).not.toBe(b);
  });

  it('produces URL-safe base64 that RETAINS padding', () => {
    // Node's 'base64url' strips `=`, which the CLOB rejects. SHA-256 is 32
    // bytes, so the base64 form is always 44 chars ending in a single `=`.
    const signature = signClobL2Request({
      secret: SECRET,
      timestampSeconds: 1_780_000_000,
      method: 'GET',
      path: '/data/orders'
    });
    expect(signature).not.toMatch(/[+/]/);
    expect(signature).toMatch(/^[A-Za-z0-9\-_]+=*$/);
    expect(signature.endsWith('=')).toBe(true);
    expect(signature.length).toBe(44);
  });

  it('changes with the timestamp, so a signature cannot be replayed', () => {
    const first = signClobL2Request({
      secret: SECRET, timestampSeconds: 1_780_000_000, method: 'GET', path: '/data/orders'
    });
    const second = signClobL2Request({
      secret: SECRET, timestampSeconds: 1_780_000_001, method: 'GET', path: '/data/orders'
    });
    expect(first).not.toBe(second);
  });
});

describe('CLOB L2 headers', () => {
  it('emits all five required headers', () => {
    const headers = buildClobL2Headers({
      credentials,
      signerAddress: '0xdeadbeef',
      method: 'GET',
      path: '/data/orders',
      timestampSeconds: 1_780_000_000
    });
    expect(Object.keys(headers).sort()).toEqual([
      'POLY_ADDRESS',
      'POLY_API_KEY',
      'POLY_PASSPHRASE',
      'POLY_SIGNATURE',
      'POLY_TIMESTAMP'
    ]);
    expect(headers.POLY_ADDRESS).toBe('0xdeadbeef');
    expect(headers.POLY_API_KEY).toBe(credentials.apiKey);
    expect(headers.POLY_PASSPHRASE).toBe(credentials.passphrase);
  });

  it('signs with the SAME timestamp it sends', () => {
    // Deriving the timestamp twice would let a slow call sign one second and
    // send another, failing verification intermittently and unreproducibly.
    const headers = buildClobL2Headers({
      credentials,
      signerAddress: '0xdeadbeef',
      method: 'GET',
      path: '/data/orders',
      timestampSeconds: 1_780_000_000
    });
    const expected = signClobL2Request({
      secret: credentials.secret,
      timestampSeconds: Number(headers.POLY_TIMESTAMP),
      method: 'GET',
      path: '/data/orders'
    });
    expect(headers.POLY_SIGNATURE).toBe(expected);
  });

  it('never places the secret in a header', () => {
    const headers = buildClobL2Headers({
      credentials,
      signerAddress: '0xdeadbeef',
      method: 'GET',
      path: '/data/orders'
    });
    expect(JSON.stringify(headers)).not.toContain(credentials.secret);
  });
});

describe('credential redaction (G3-P3: no secrets in logs)', () => {
  it('hides the secret and passphrase entirely', () => {
    const redacted = redactCredentials(credentials);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(credentials.secret);
    expect(serialized).not.toContain(credentials.passphrase);
    expect(redacted.secret).toBe('[redacted]');
    expect(redacted.passphrase).toBe('[redacted]');
  });

  it('keeps only a short api-key prefix for correlation', () => {
    const redacted = redactCredentials(credentials);
    expect(redacted.apiKey).toBe('7b1e2d60…');
    expect(redacted.apiKey).not.toBe(credentials.apiKey);
  });
});
