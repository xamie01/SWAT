import { describe, it, expect, vi } from 'vitest';
import {
  assertUsableClobCredentials,
  clobCredentialCacheKey,
  clobL1SignerFrom,
  createClobCredentialStore,
  deriveClobCredentials,
  fetchClobCredentialsFromSignature,
  normalizeClobSignerAddress,
  parseClobCredentials,
  resolveClobCredentials,
  ClobCredentialError,
  type ClobAuthTypedData,
  type ClobL1Signer
} from './polymarket-clob-credentials.js';
import { signClobL2Request, type ClobCredentials } from './polymarket-clob-auth.js';

/**
 * Tests for the `S3-20` seam: credentials as a function of a signer.
 *
 * Two properties matter more than the rest and are named so a mutation check can
 * point at them:
 *
 *   * `never hands one signer the credentials of another` — the cross-signer
 *     cache isolation.
 *   * `never puts the secret or passphrase in a thrown error` — the redaction
 *     boundary in `parseClobCredentials`.
 */

const ADDRESS_A = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const ADDRESS_B = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';
const SIGNATURE = `0x${'11'.repeat(65)}`;
const ORIGIN = 'https://clob.test';

// Real base64, so `Buffer.from(secret, 'base64')` yields actual key bytes.
const SECRET_A = Buffer.from('signer-a-secret-key-material-32b').toString('base64');
const SECRET_B = Buffer.from('signer-b-secret-key-material-32b').toString('base64');

function credentialsFor(label: string, secret: string): ClobCredentials {
  return {
    apiKey: `api-key-${label}`,
    secret,
    passphrase: `passphrase-${label}`
  };
}

const CREDENTIALS_A = credentialsFor('a', SECRET_A);
const CREDENTIALS_B = credentialsFor('b', SECRET_B);

interface RecordingSigner extends ClobL1Signer {
  readonly payloads: ClobAuthTypedData[];
}

function recordingSigner(address: string, signature: string = SIGNATURE): RecordingSigner {
  const payloads: ClobAuthTypedData[] = [];
  return {
    address,
    payloads,
    async signTypedData(typedData) {
      payloads.push(typedData);
      return signature;
    }
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

function stubFetch(...responses: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const next = responses.shift();
    if (!next) throw new Error('stubFetch ran out of responses');
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls, mock: impl };
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe('L1 derivation is a function of the signer', () => {
  it('signs ClobAuth and sends the four documented L1 headers', async () => {
    const signer = recordingSigner(ADDRESS_A);
    const fetchImpl = stubFetch(jsonResponse(200, CREDENTIALS_A));

    const credentials = await deriveClobCredentials({
      signer,
      baseUrl: ORIGIN,
      fetchImpl: fetchImpl.impl,
      nowSeconds: () => 1_780_000_000
    });

    expect(credentials).toEqual(CREDENTIALS_A);
    expect(fetchImpl.calls[0]!.url).toBe(`${ORIGIN}/auth/api-key`);
    expect(fetchImpl.calls[0]!.init.method).toBe('POST');
    // Exactly the set the installed SDK sends for both auth routes.
    expect(Object.keys(headersOf(fetchImpl.calls[0]!.init)).sort()).toEqual([
      'POLY_ADDRESS',
      'POLY_NONCE',
      'POLY_SIGNATURE',
      'POLY_TIMESTAMP'
    ]);
    expect(headersOf(fetchImpl.calls[0]!.init)).toEqual({
      POLY_ADDRESS: ADDRESS_A,
      POLY_NONCE: '0',
      POLY_SIGNATURE: SIGNATURE,
      POLY_TIMESTAMP: '1780000000'
    });
  });

  it('signs the payload the venue re-derives, with the same timestamp it sends', async () => {
    const signer = recordingSigner(ADDRESS_A);
    const fetchImpl = stubFetch(jsonResponse(200, CREDENTIALS_A));

    await deriveClobCredentials({
      signer,
      baseUrl: ORIGIN,
      fetchImpl: fetchImpl.impl,
      nonce: 3,
      nowSeconds: () => 1_780_000_001
    });

    const payload = signer.payloads[0]!;
    expect(payload.domain).toEqual({ name: 'ClobAuthDomain', version: '1', chainId: 137 });
    expect(payload.primaryType).toBe('ClobAuth');
    expect(payload.message.address).toBe(ADDRESS_A);
    expect(payload.message.timestamp).toBe('1780000001');
    expect(payload.message.nonce).toBe(3);
    // Signature and headers must agree, or the server recovers a different struct.
    expect(headersOf(fetchImpl.calls[0]!.init).POLY_TIMESTAMP).toBe('1780000001');
    expect(headersOf(fetchImpl.calls[0]!.init).POLY_NONCE).toBe('3');
  });

  it('preserves the caller checksummed address on the wire', async () => {
    // The venue recovers the signer from the signature; lowercasing here would
    // be us rewriting a value the caller controls for no reason.
    const signer = recordingSigner(ADDRESS_A);
    const fetchImpl = stubFetch(jsonResponse(200, CREDENTIALS_A));
    await deriveClobCredentials({ signer, baseUrl: ORIGIN, fetchImpl: fetchImpl.impl });
    expect(headersOf(fetchImpl.calls[0]!.init).POLY_ADDRESS).toBe(ADDRESS_A);
    expect(signer.payloads[0]!.message.address).toBe(ADDRESS_A);
  });

  it('derives with GET /auth/derive-api-key when asked to derive', async () => {
    const fetchImpl = stubFetch(jsonResponse(200, CREDENTIALS_A));
    await deriveClobCredentials({
      signer: recordingSigner(ADDRESS_A),
      baseUrl: ORIGIN,
      mode: 'derive',
      fetchImpl: fetchImpl.impl
    });
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]!.url).toBe(`${ORIGIN}/auth/derive-api-key`);
    expect(fetchImpl.calls[0]!.init.method).toBe('GET');
  });

  it('falls back from create to derive on HTTP 400 only', async () => {
    // Mirrors @polymarket/client@0.2.0 createOrDeriveApiKey, which rethrows any
    // status other than 400 rather than making a second call.
    const fetchImpl = stubFetch(jsonResponse(400, { error: 'already exists' }),
      jsonResponse(200, CREDENTIALS_A));

    const credentials = await deriveClobCredentials({
      signer: recordingSigner(ADDRESS_A),
      baseUrl: ORIGIN,
      fetchImpl: fetchImpl.impl
    });

    expect(credentials).toEqual(CREDENTIALS_A);
    expect(fetchImpl.calls.map((call) => call.url)).toEqual([
      `${ORIGIN}/auth/api-key`,
      `${ORIGIN}/auth/derive-api-key`
    ]);
  });

  it('does not fall back on 401, 429 or 500', async () => {
    for (const status of [401, 429, 500]) {
      const fetchImpl = stubFetch(jsonResponse(status, { error: 'nope' }));
      await expect(deriveClobCredentials({
        signer: recordingSigner(ADDRESS_A),
        baseUrl: ORIGIN,
        fetchImpl: fetchImpl.impl
      })).rejects.toMatchObject({
        code: 'clob-credential-rejected',
        status
      });
      expect(fetchImpl.calls).toHaveLength(1);
    }
  });

  it('treats a 400 as a failure when the caller asked to create', async () => {
    const fetchImpl = stubFetch(jsonResponse(400, { error: 'already exists' }));
    await expect(deriveClobCredentials({
      signer: recordingSigner(ADDRESS_A),
      baseUrl: ORIGIN,
      mode: 'create',
      fetchImpl: fetchImpl.impl
    })).rejects.toMatchObject({ code: 'clob-credential-rejected', status: 400 });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('signs before it touches the transport', async () => {
    // Ordering is the safety net: a signer that cannot sign never produces a
    // venue request, so an unstubbed caller fails locally, not on the network.
    const fetchImpl = stubFetch(jsonResponse(200, CREDENTIALS_A));
    const signer: ClobL1Signer = {
      address: ADDRESS_A,
      signTypedData: async () => {
        throw new TypeError('_signTypedData is not a function');
      }
    };

    await expect(deriveClobCredentials({
      signer,
      baseUrl: ORIGIN,
      fetchImpl: fetchImpl.impl
    })).rejects.toMatchObject({ code: 'clob-credential-signing-failed' });
    expect(fetchImpl.mock).not.toHaveBeenCalled();
  });

  it('rejects a signer that returns something other than a hex signature', async () => {
    const fetchImpl = stubFetch(jsonResponse(200, CREDENTIALS_A));
    await expect(deriveClobCredentials({
      signer: recordingSigner(ADDRESS_A, 'user rejected request'),
      baseUrl: ORIGIN,
      fetchImpl: fetchImpl.impl
    })).rejects.toMatchObject({ code: 'clob-credential-signature-malformed' });
    expect(fetchImpl.mock).not.toHaveBeenCalled();
  });

  it('accepts an ERC-1271 length signature, which a Deposit Wallet produces', async () => {
    // Every Polymarket wallet deployed on or after 2026-05-04 is a Deposit
    // Wallet with ERC-7739-wrapped signatures, longer than 65 bytes. A strict
    // 65-byte check would reject the majority wallet type.
    const fetchImpl = stubFetch(jsonResponse(200, CREDENTIALS_A));
    await expect(deriveClobCredentials({
      signer: recordingSigner(ADDRESS_A, `0x${'ab'.repeat(200)}`),
      baseUrl: ORIGIN,
      fetchImpl: fetchImpl.impl
    })).resolves.toEqual(CREDENTIALS_A);
  });

  it('surfaces a transport failure without making a second attempt', async () => {
    const impl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(deriveClobCredentials({
      signer: recordingSigner(ADDRESS_A),
      baseUrl: ORIGIN,
      fetchImpl: impl as unknown as typeof fetch
    })).rejects.toMatchObject({ code: 'clob-credential-transport-failed' });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed signer address without echoing it', async () => {
    // The realistic bad value here is a private key in the wrong field.
    const key = `0x${'de'.repeat(32)}`;
    const fetchImpl = stubFetch(jsonResponse(200, CREDENTIALS_A));
    const failure = await deriveClobCredentials({
      signer: recordingSigner(key),
      baseUrl: ORIGIN,
      fetchImpl: fetchImpl.impl
    }).catch((error: unknown) => error as ClobCredentialError);

    expect(failure.code).toBe('clob-credential-address-invalid');
    expect(failure.message).not.toContain(key);
    expect(failure.message).toContain('66-character string');
  });

  it('rejects a non-integer nonce and a non-positive clock', async () => {
    const fetchImpl = stubFetch(jsonResponse(200, CREDENTIALS_A));
    await expect(deriveClobCredentials({
      signer: recordingSigner(ADDRESS_A),
      baseUrl: ORIGIN,
      nonce: 1.5,
      fetchImpl: fetchImpl.impl
    })).rejects.toMatchObject({ code: 'clob-credential-nonce-invalid' });

    await expect(deriveClobCredentials({
      signer: recordingSigner(ADDRESS_A),
      baseUrl: ORIGIN,
      fetchImpl: fetchImpl.impl,
      nowSeconds: () => 0
    })).rejects.toMatchObject({ code: 'clob-credential-timestamp-invalid' });
  });

  it('derives credentials that actually sign an L2 request', async () => {
    // End to end within the module boundary: the derived secret is the HMAC key
    // `signClobL2Request` expects, base64-decoded.
    const fetchImpl = stubFetch(jsonResponse(200, CREDENTIALS_A));
    const credentials = await deriveClobCredentials({
      signer: recordingSigner(ADDRESS_A),
      baseUrl: ORIGIN,
      fetchImpl: fetchImpl.impl
    });
    const signature = signClobL2Request({
      secret: credentials.secret,
      timestampSeconds: 1_780_000_000,
      method: 'GET',
      path: '/data/orders'
    });
    expect(signature).toHaveLength(44);
  });
});

describe('credential payload validation', () => {
  it('reads apiKey from the wire, which the SDK renames to key', async () => {
    // @polymarket/bindings ApiKeyCredsSchema maps apiKey -> key, so SDK-shaped
    // code and wire-shaped code disagree on this one name.
    const parsed = parseClobCredentials(
      { apiKey: 'k', secret: SECRET_A, passphrase: 'p' },
      'GET /auth/derive-api-key'
    );
    expect(parsed.apiKey).toBe('k');
    expect(parsed).not.toHaveProperty('key');
  });

  it('rejects a secret that decodes to no key bytes', () => {
    // Buffer.from('=', 'base64') is empty, so every L2 signature would be
    // computed with an empty HMAC key: well-formed, and rejected forever.
    expect(() => parseClobCredentials(
      { apiKey: 'k', secret: '=', passphrase: 'p' },
      'GET /auth/derive-api-key'
    )).toThrow('not base64 that decodes to any key bytes');
  });

  it('reports every missing field at once, by name', () => {
    const failure = (() => {
      try {
        parseClobCredentials({ apiKey: 'k' }, 'GET /auth/derive-api-key');
        return null;
      } catch (error) {
        return error as ClobCredentialError;
      }
    })();
    expect(failure?.code).toBe('clob-credential-response-malformed');
    expect(failure?.message).toContain('secret is');
    expect(failure?.message).toContain('passphrase is');
  });

  it('validates preconfigured credentials the same way as derived ones', () => {
    expect(() => assertUsableClobCredentials({
      apiKey: 'k',
      secret: '',
      passphrase: 'p'
    })).toThrow('preconfigured credentials');
    expect(assertUsableClobCredentials(CREDENTIALS_A)).toEqual(CREDENTIALS_A);
  });
});

describe('secret redaction (G3-P3: no secrets in logs or errors)', () => {
  it('never puts the secret or passphrase in a thrown error', () => {
    // The venue answered 200 with two perfectly good bearer credentials and a
    // broken apiKey. The easy implementation interpolates the whole body into
    // the message; the body is two bearer credentials.
    const livePassphrase = 'pass-a-live-bearer-value';
    const body = { apiKey: 42, secret: SECRET_A, passphrase: livePassphrase };
    const failure = (() => {
      try {
        parseClobCredentials(body, 'POST /auth/api-key');
        return null;
      } catch (error) {
        return error as ClobCredentialError;
      }
    })();

    expect(failure).toBeInstanceOf(ClobCredentialError);
    const surfaces = [
      failure!.message,
      String(failure),
      failure!.stack ?? '',
      JSON.stringify(failure, Object.getOwnPropertyNames(failure))
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(SECRET_A);
      expect(surface).not.toContain('signer-a-secret');
      expect(surface).not.toContain(livePassphrase);
    }
    // It still says what went wrong.
    expect(failure!.message).toContain('apiKey is a value of type number');
  });

  it('never puts a venue response body in a rejection error', async () => {
    // The same route returns credentials on success, so nothing is assumed about
    // what a non-2xx body echoes back.
    const fetchImpl = stubFetch(jsonResponse(403, { detail: `leaked ${SECRET_A}` }));
    const failure = await deriveClobCredentials({
      signer: recordingSigner(ADDRESS_A),
      baseUrl: ORIGIN,
      mode: 'derive',
      fetchImpl: fetchImpl.impl
    }).catch((error: unknown) => error as ClobCredentialError);

    expect(failure.message).toBe(
      'clob-credential-rejected: GET /auth/derive-api-key returned HTTP 403'
    );
    expect(failure.message).not.toContain(SECRET_A);
  });

  it('never chains a signer error message, only its constructor name', async () => {
    // A third-party signer's text is outside our control; a badly written
    // adapter could put key material in it.
    const secretish = 'private key 0xdeadbeefcafe';
    const fetchImpl = stubFetch(jsonResponse(200, CREDENTIALS_A));
    const failure = await deriveClobCredentials({
      signer: {
        address: ADDRESS_A,
        signTypedData: async () => {
          throw new RangeError(secretish);
        }
      },
      baseUrl: ORIGIN,
      fetchImpl: fetchImpl.impl
    }).catch((error: unknown) => error as ClobCredentialError);

    expect(failure.message).toContain('RangeError');
    expect(failure.message).not.toContain(secretish);
    expect((failure as { cause?: unknown }).cause).toBeUndefined();
  });

  it('exposes cache keys that carry no secret', async () => {
    const store = createClobCredentialStore({
      baseUrl: ORIGIN,
      derive: async () => CREDENTIALS_A
    });
    await store.credentialsFor(recordingSigner(ADDRESS_A));
    const serialized = store.keys().join(' ');
    expect(serialized).not.toContain(SECRET_A);
    expect(serialized).not.toContain(CREDENTIALS_A.passphrase);
    expect(serialized).toContain(ADDRESS_A.toLowerCase());
  });
});

describe('cache key', () => {
  it('carries the origin, the lowercased address, and the nonce', () => {
    expect(clobCredentialCacheKey({ signerAddress: ADDRESS_A, baseUrl: ORIGIN })).toBe(
      `clob-creds:v1|${ORIGIN}|${ADDRESS_A.toLowerCase()}|0`
    );
  });

  it('gives one key to the checksummed and lowercase forms of one account', () => {
    // EVM addresses are case-insensitive and arrive both ways; one account must
    // not occupy two entries and pay two derivations.
    expect(clobCredentialCacheKey({ signerAddress: ADDRESS_A, baseUrl: ORIGIN })).toBe(
      clobCredentialCacheKey({ signerAddress: ADDRESS_A.toLowerCase(), baseUrl: ORIGIN })
    );
  });

  it('separates different addresses, nonces and origins', () => {
    const base = { signerAddress: ADDRESS_A, baseUrl: ORIGIN };
    const keys = new Set([
      clobCredentialCacheKey(base),
      clobCredentialCacheKey({ ...base, signerAddress: ADDRESS_B }),
      clobCredentialCacheKey({ ...base, nonce: 1 }),
      clobCredentialCacheKey({ ...base, baseUrl: 'https://clob.staging.test' })
    ]);
    expect(keys.size).toBe(4);
  });

  it('normalizes a trailing path or query away rather than splitting the venue', () => {
    expect(clobCredentialCacheKey({ signerAddress: ADDRESS_A, baseUrl: `${ORIGIN}/?x=1` })).toBe(
      clobCredentialCacheKey({ signerAddress: ADDRESS_A, baseUrl: ORIGIN })
    );
  });

  it('refuses to key on a malformed address instead of inventing a key', () => {
    expect(() => clobCredentialCacheKey({ signerAddress: '', baseUrl: ORIGIN })).toThrow(
      ClobCredentialError
    );
    expect(() => clobCredentialCacheKey({ signerAddress: '0xshort', baseUrl: ORIGIN })).toThrow(
      'clob-credential-address-invalid'
    );
    expect(() => normalizeClobSignerAddress(ADDRESS_A)).not.toThrow();
  });
});

describe('per-signer credential store', () => {
  function storeOverTwoSigners() {
    const derive = vi.fn(async (signer: ClobL1Signer) => {
      if (signer.address.toLowerCase() === ADDRESS_A.toLowerCase()) return CREDENTIALS_A;
      if (signer.address.toLowerCase() === ADDRESS_B.toLowerCase()) return CREDENTIALS_B;
      throw new Error(`unexpected signer ${signer.address}`);
    });
    return { derive, store: createClobCredentialStore({ baseUrl: ORIGIN, derive }) };
  }

  it('never hands one signer the credentials of another', async () => {
    // The worst available bug in this module: the request succeeds and
    // authenticates as the wrong account, with no local symptom.
    const { store, derive } = storeOverTwoSigners();
    const signerA = recordingSigner(ADDRESS_A);
    const signerB = recordingSigner(ADDRESS_B);

    const first = await store.credentialsFor(signerA);
    const second = await store.credentialsFor(signerB);
    // Interleaved, and again after both are warm, because a broken key shows up
    // on the second read rather than the first.
    const firstAgain = await store.credentialsFor(signerA);
    const secondAgain = await store.credentialsFor(signerB);

    expect(first).toEqual(CREDENTIALS_A);
    expect(firstAgain).toEqual(CREDENTIALS_A);
    expect(second).toEqual(CREDENTIALS_B);
    expect(secondAgain).toEqual(CREDENTIALS_B);
    expect(first.secret).not.toBe(second.secret);
    expect(first.passphrase).not.toBe(second.passphrase);
    expect(store.size()).toBe(2);
    expect(new Set(store.keys()).size).toBe(2);
    // One derivation each: caching happened, and it happened per signer.
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('separates one address nonce 0 from the same address nonce 1', async () => {
    const derive = vi.fn(async (_signer: ClobL1Signer, options: { nonce: number }) =>
      credentialsFor(`nonce-${options.nonce}`, SECRET_A));
    const store = createClobCredentialStore({ baseUrl: ORIGIN, derive });
    const signer = recordingSigner(ADDRESS_A);

    const zero = await store.credentialsFor(signer);
    const one = await store.credentialsFor(signer, { nonce: 1 });

    expect(zero.apiKey).toBe('api-key-nonce-0');
    expect(one.apiKey).toBe('api-key-nonce-1');
    expect(store.size()).toBe(2);
  });

  it('derives once per signer and reuses the result', async () => {
    const { store, derive } = storeOverTwoSigners();
    const signer = recordingSigner(ADDRESS_A);
    await store.credentialsFor(signer);
    await store.credentialsFor(signer);
    await store.credentialsFor(recordingSigner(ADDRESS_A.toLowerCase()));
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it('shares one derivation between concurrent callers for one signer', async () => {
    // Two overlapping signals for one principal must not burn two L1 signatures.
    let resolveDerivation: (credentials: ClobCredentials) => void = () => {};
    const derive = vi.fn(() => new Promise<ClobCredentials>((resolve) => {
      resolveDerivation = resolve;
    }));
    const store = createClobCredentialStore({ baseUrl: ORIGIN, derive });
    const signer = recordingSigner(ADDRESS_A);

    const both = Promise.all([store.credentialsFor(signer), store.credentialsFor(signer)]);
    resolveDerivation(CREDENTIALS_A);
    expect(await both).toEqual([CREDENTIALS_A, CREDENTIALS_A]);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed derivation', async () => {
    // A cached rejection would replay one venue outage forever.
    const derive = vi.fn()
      .mockRejectedValueOnce(new Error('venue unavailable'))
      .mockResolvedValueOnce(CREDENTIALS_A);
    const store = createClobCredentialStore({ baseUrl: ORIGIN, derive });
    const signer = recordingSigner(ADDRESS_A);

    await expect(store.credentialsFor(signer)).rejects.toThrow('venue unavailable');
    expect(store.size()).toBe(0);
    await expect(store.credentialsFor(signer)).resolves.toEqual(CREDENTIALS_A);
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('refuses to serve an entry whose stored identity does not match the signer', async () => {
    // Second half of the guard, proven by forcing the collision the key
    // function is supposed to make impossible.
    const derive = vi.fn(async (signer: ClobL1Signer) =>
      credentialsFor(signer.address, SECRET_A));
    const store = createClobCredentialStore({
      baseUrl: ORIGIN,
      derive,
      cacheKeyFor: () => 'one-key-for-everyone'
    });

    await store.credentialsFor(recordingSigner(ADDRESS_A));
    await expect(store.credentialsFor(recordingSigner(ADDRESS_B))).rejects.toMatchObject({
      code: 'clob-credential-cache-collision'
    });
  });

  it('invalidates one signer without disturbing the other', async () => {
    const { store, derive } = storeOverTwoSigners();
    const signerA = recordingSigner(ADDRESS_A);
    const signerB = recordingSigner(ADDRESS_B);
    await store.credentialsFor(signerA);
    await store.credentialsFor(signerB);

    expect(store.invalidate(signerA)).toBe(true);
    expect(store.invalidate(signerA)).toBe(false);
    expect(store.size()).toBe(1);

    await store.credentialsFor(signerA);
    await store.credentialsFor(signerB);
    expect(derive).toHaveBeenCalledTimes(3);

    store.clear();
    expect(store.size()).toBe(0);
  });

  it('rejects a malformed signer address before it reaches the deriver', async () => {
    const derive = vi.fn(async () => CREDENTIALS_A);
    const store = createClobCredentialStore({ baseUrl: ORIGIN, derive });
    await expect(store.credentialsFor(recordingSigner('not-an-address'))).rejects.toMatchObject({
      code: 'clob-credential-address-invalid'
    });
    expect(derive).not.toHaveBeenCalled();
  });
});

describe('resolveClobCredentials: the operator is a caller, not a branch', () => {
  it('uses preconfigured credentials without signing anything', async () => {
    const derive = vi.fn(async () => CREDENTIALS_B);
    const signer = recordingSigner(ADDRESS_A);

    const resolved = await resolveClobCredentials({
      signer,
      preconfigured: CREDENTIALS_A,
      derive
    });

    expect(resolved).toEqual({ credentials: CREDENTIALS_A, source: 'preconfigured' });
    expect(derive).not.toHaveBeenCalled();
    expect(signer.payloads).toHaveLength(0);
  });

  it('derives when none were supplied', async () => {
    const derive = vi.fn(async () => CREDENTIALS_A);
    const resolved = await resolveClobCredentials({
      signer: recordingSigner(ADDRESS_A),
      preconfigured: null,
      derive
    });
    expect(resolved).toEqual({ credentials: CREDENTIALS_A, source: 'derived' });
    expect(derive).toHaveBeenCalledWith(expect.objectContaining({ address: ADDRESS_A }), {
      nonce: 0
    });
  });

  it('takes the identical path for the operator signer and a per-user signer', async () => {
    // The branch is on whether credentials were supplied, never on who is
    // asking. Two different signers with no preconfigured credentials produce
    // structurally identical calls.
    const derive = vi.fn(async (signer: ClobL1Signer) =>
      credentialsFor(signer.address, SECRET_A));

    const operator = await resolveClobCredentials({
      signer: recordingSigner(ADDRESS_A),
      derive
    });
    const user = await resolveClobCredentials({
      signer: recordingSigner(ADDRESS_B),
      derive
    });

    expect(operator.source).toBe('derived');
    expect(user.source).toBe('derived');
    expect(derive.mock.calls[0]![1]).toEqual(derive.mock.calls[1]![1]);
    expect(operator.credentials.apiKey).not.toBe(user.credentials.apiKey);
  });

  it('rejects preconfigured credentials that cannot sign an L2 request', async () => {
    await expect(resolveClobCredentials({
      signer: recordingSigner(ADDRESS_A),
      preconfigured: { apiKey: 'k', secret: '=', passphrase: 'p' },
      derive: async () => CREDENTIALS_A
    })).rejects.toMatchObject({ code: 'clob-credential-response-malformed' });
  });

  it('wires a store as the deriver, so the operator gets caching for free', async () => {
    const derive = vi.fn(async () => CREDENTIALS_A);
    const store = createClobCredentialStore({ baseUrl: ORIGIN, derive });
    const signer = clobL1SignerFrom(ADDRESS_A, async () => SIGNATURE);

    const first = await resolveClobCredentials({
      signer,
      derive: (candidate, options) => store.credentialsFor(candidate, options)
    });
    const second = await resolveClobCredentials({
      signer,
      derive: (candidate, options) => store.credentialsFor(candidate, options)
    });

    expect(first.credentials).toEqual(CREDENTIALS_A);
    expect(second.credentials).toEqual(CREDENTIALS_A);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  describe('fetchClobCredentialsFromSignature', () => {
    it('creates or derives credentials using an existing L1 signature', async () => {
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('/auth/api-key')) {
          return new Response(JSON.stringify(CREDENTIALS_A), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const creds = await fetchClobCredentialsFromSignature({
        address: ADDRESS_A,
        signature: SIGNATURE,
        timestampSeconds: 1730000000,
        baseUrl: ORIGIN,
        fetchImpl: fetchImpl as unknown as typeof fetch
      });

      expect(creds).toEqual(CREDENTIALS_A);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('falls back to derive-api-key if create returns 400', async () => {
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('/auth/api-key')) {
          return new Response('User exists', { status: 400 });
        }
        if (u.includes('/auth/derive-api-key')) {
          return new Response(JSON.stringify(CREDENTIALS_B), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const creds = await fetchClobCredentialsFromSignature({
        address: ADDRESS_B,
        signature: SIGNATURE,
        timestampSeconds: 1730000000,
        baseUrl: ORIGIN,
        fetchImpl: fetchImpl as unknown as typeof fetch
      });

      expect(creds).toEqual(CREDENTIALS_B);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });
});
