import { buildClobAuthTypedData, CLOB_BASE_URL } from './polymarket-clob-auth.js';
/**
 * Wraps an address and a signing function as a `ClobL1Signer`.
 *
 * Exists so callers do not hand-roll the object literal and get the member name
 * wrong; every adapter (ethers v5's `_signTypedData`, viem's `signTypedData`, a
 * remote signer's HTTP call) is a one-line closure through here.
 */
export function clobL1SignerFrom(address, signTypedData) {
    return { address, signTypedData };
}
/**
 * A derivation failure, with a stable code.
 *
 * `cause` is attached for `clob-credential-transport-failed` only. A transport
 * error comes from `fetch` and describes a socket; a *signing* error comes from
 * whatever signer the caller injected, and a third-party signer's message text
 * is outside our control — chaining it would let a badly written adapter put key
 * material into our error. So the signing path records the cause's constructor
 * name and nothing else.
 */
export class ClobCredentialError extends Error {
    code;
    /** HTTP status when the venue answered, else `null`. */
    status;
    constructor(code, detail, options = {}) {
        super(`${code}: ${detail}`);
        this.name = 'ClobCredentialError';
        this.code = code;
        this.status = options.status ?? null;
        if (options.cause !== undefined) {
            this.cause = options.cause;
        }
    }
}
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HEX_SIGNATURE_PATTERN = /^0x[0-9a-fA-F]+$/;
/**
 * Describes a value by shape, never by content.
 *
 * Used for every rejected input. The realistic bad "signer address" is a private
 * key pasted into the wrong field, and the realistic bad "signature" is an
 * error string from a signer; echoing either into a message that reaches a log
 * is the leak this function exists to prevent.
 */
function describeOpaque(value) {
    if (typeof value === 'string')
        return `a ${value.length}-character string`;
    if (value === null)
        return 'null';
    return `a value of type ${typeof value}`;
}
/**
 * Validates an EVM address and returns it lowercased.
 *
 * The lowercase form is the **cache identity**, not what goes on the wire.
 * `POLY_ADDRESS` and the typed data both carry the caller's own string, so a
 * checksummed address stays checksummed for the venue's benefit, while
 * `0xAbC…` and `0xabc…` still resolve to one cache entry — the same split
 * `evmNonceLockKey` makes in `packages/db/src/evm-nonce.ts`, and for the same
 * reason: one account must not yield two keys.
 */
export function normalizeClobSignerAddress(address) {
    const trimmed = typeof address === 'string' ? address.trim() : '';
    if (!EVM_ADDRESS_PATTERN.test(trimmed)) {
        throw new ClobCredentialError('clob-credential-address-invalid', `signer address must be 0x followed by 40 hex characters, got ${describeOpaque(address)}`);
    }
    return trimmed.toLowerCase();
}
/**
 * Credential nonce. `0` unless a principal deliberately holds several sets.
 *
 * Part of the identity of a credential set, so it is part of the cache key: two
 * nonces for one address are two different credential sets, and serving one
 * where the other was asked for would authenticate as the wrong set.
 */
export function normalizeClobNonce(nonce) {
    const resolved = nonce ?? 0;
    if (!Number.isSafeInteger(resolved) || resolved < 0) {
        throw new ClobCredentialError('clob-credential-nonce-invalid', `credential nonce must be a non-negative safe integer, got ${describeOpaque(nonce)}`);
    }
    return resolved;
}
/**
 * Reduces a base URL to its origin.
 *
 * The origin, not the whole URL, because it is a cache-key component and a
 * trailing slash or a stray query string must not split one venue into two
 * entries. It is also the only free-form component of the key, and a serialized
 * origin cannot contain the key separator (see `clobCredentialCacheKey`).
 */
export function normalizeClobOrigin(baseUrl) {
    let url;
    try {
        url = new URL(baseUrl);
    }
    catch {
        throw new ClobCredentialError('clob-credential-base-url-invalid', `CLOB base URL is not a URL, got ${describeOpaque(baseUrl)}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new ClobCredentialError('clob-credential-base-url-invalid', `CLOB base URL must be http or https, got protocol ${url.protocol}`);
    }
    return url.origin;
}
/**
 * The cache identity of one credential set.
 *
 * **This is the function that must not collide.** A key that ignored any
 * component would let one principal read another's credentials out of the cache,
 * which is the worst available outcome here: the request succeeds, the venue
 * accepts it, and it authenticates as the wrong account. Every component is
 * therefore part of the key, and each is normalized first so the same identity
 * cannot produce two keys:
 *
 *   * **origin** — staging and production issue unrelated credentials for the
 *     same address, and a test double's origin must never share a key with
 *     production.
 *   * **address**, lowercased — the venue binds credentials to the signer that
 *     produced the L1 signature.
 *   * **nonce** — one address can hold several sets.
 *
 * The key cannot be ambiguous, because the separator `|` cannot appear in any
 * component: a serialized URL origin is scheme, host and optional port with `|`
 * excluded from all three, an EVM address is `0x` plus hex, and a nonce is
 * digits. So key strings and identity triples are one-to-one.
 *
 * Pure and exported for the same reason `evmNonceLockKey` is: getting it wrong
 * fails in two directions and neither is visible at runtime — too coarse and
 * principals share credentials, too fine and every request re-derives.
 */
export function clobCredentialCacheKey(input) {
    const origin = normalizeClobOrigin(input.baseUrl ?? CLOB_BASE_URL);
    const address = normalizeClobSignerAddress(input.signerAddress);
    const nonce = normalizeClobNonce(input.nonce);
    return `clob-creds:v1|${origin}|${address}|${nonce}`;
}
const CREATE_ROUTE = '/auth/api-key';
const DERIVE_ROUTE = '/auth/derive-api-key';
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Derives one principal's CLOB L2 credentials from its signer.
 *
 * The signer is signed *before* the transport is touched, deliberately: a signer
 * that cannot sign must not produce a venue request, and the ordering means an
 * unstubbed test fails at the signer rather than on the network.
 */
export async function deriveClobCredentials(input) {
    const origin = normalizeClobOrigin(input.baseUrl ?? CLOB_BASE_URL);
    // Validated for shape, then kept only as the identity used in messages. What
    // travels on the wire is `input.signer.address` unchanged, because the venue
    // recovers the signer from the signature and the caller owns the checksum.
    const signerAddress = normalizeClobSignerAddress(input.signer.address);
    const nonce = normalizeClobNonce(input.nonce);
    const timestampSeconds = resolveTimestampSeconds(input.nowSeconds);
    const typedData = buildClobAuthTypedData({
        signerAddress: input.signer.address,
        timestampSeconds,
        nonce
    });
    let signature;
    try {
        signature = await input.signer.signTypedData(typedData);
    }
    catch (error) {
        throw new ClobCredentialError('clob-credential-signing-failed', `the signer for ${signerAddress} threw ${errorLabel(error)}`);
    }
    assertL1Signature(signature);
    const headers = {
        POLY_ADDRESS: input.signer.address,
        POLY_NONCE: String(nonce),
        POLY_SIGNATURE: signature,
        POLY_TIMESTAMP: String(timestampSeconds)
    };
    const mode = input.mode ?? 'create-or-derive';
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const transport = { fetchImpl: input.fetchImpl, origin, headers, timeoutMs };
    if (mode === 'derive') {
        return requireCredentials(await requestCredentials({ ...transport, method: 'GET', route: DERIVE_ROUTE }));
    }
    const created = await requestCredentials({
        ...transport,
        method: 'POST',
        route: CREATE_ROUTE,
        // Only `create-or-derive` treats 400 as "already exists"; a caller that
        // asked for `create` gets the 400 as the failure it is.
        tolerateAlreadyExists: mode === 'create-or-derive'
    });
    if (created)
        return created;
    return requireCredentials(await requestCredentials({ ...transport, method: 'GET', route: DERIVE_ROUTE }));
}
function resolveTimestampSeconds(nowSeconds) {
    const value = nowSeconds ? nowSeconds() : Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new ClobCredentialError('clob-credential-timestamp-invalid', `L1 timestamp must be a positive integer number of seconds, got ${describeOpaque(value)}`);
    }
    return value;
}
/** The cause's constructor name only. Never its message. See `ClobCredentialError`. */
function errorLabel(error) {
    if (error instanceof Error)
        return error.name || 'Error';
    return `a non-Error ${typeof error}`;
}
/**
 * Accepts any `0x` hex signature of even byte length.
 *
 * Deliberately **not** a 65-byte check. A Deposit Wallet signs L1 through an
 * ERC-1271 / ERC-7739 wrapper (ADR-0003 section 4: every account deployed on or
 * after 4 May 2026 is a Deposit Wallet), and those signatures are longer than 65
 * bytes. Pinning the length here would reject the majority wallet type.
 */
function assertL1Signature(signature) {
    const valid = typeof signature === 'string' &&
        HEX_SIGNATURE_PATTERN.test(signature) &&
        signature.length >= 4 &&
        signature.length % 2 === 0;
    if (!valid) {
        throw new ClobCredentialError('clob-credential-signature-malformed', `the signer returned ${describeOpaque(signature)} instead of a 0x-prefixed hex signature`);
    }
}
/**
 * One call to one auth route. `null` only when a tolerated 400 came back.
 *
 * **The response body never reaches an error message.** On this route a 2xx body
 * *is* the credentials, and there is no guarantee about what a non-2xx body
 * echoes back of the request — so the rejection carries the method, the route and
 * the status, which is what an operator needs, and nothing that could carry a
 * secret.
 */
async function requestCredentials(request) {
    const label = `${request.method} ${request.route}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    let response;
    try {
        response = await request.fetchImpl(`${request.origin}${request.route}`, {
            method: request.method,
            headers: request.headers,
            signal: controller.signal
        });
    }
    catch (error) {
        throw new ClobCredentialError('clob-credential-transport-failed', `${label} did not complete`, { cause: error });
    }
    finally {
        clearTimeout(timer);
    }
    if (request.tolerateAlreadyExists && response.status === 400)
        return null;
    if (!response.ok) {
        throw new ClobCredentialError('clob-credential-rejected', `${label} returned HTTP ${response.status}`, { status: response.status });
    }
    let body;
    try {
        body = await response.json();
    }
    catch {
        throw new ClobCredentialError('clob-credential-response-malformed', `${label} returned a body that is not JSON`);
    }
    return parseClobCredentials(body, label);
}
function requireCredentials(credentials) {
    // Unreachable: only a tolerated 400 yields null, and that path never reaches
    // here. Present so the type narrows without a non-null assertion.
    if (!credentials) {
        throw new ClobCredentialError('clob-credential-response-malformed', 'the auth route yielded no credentials');
    }
    return credentials;
}
/**
 * Validates a credential payload, naming fields and never values.
 *
 * **This is the redaction boundary.** The obvious implementation of a
 * "malformed response" error is to interpolate the body, and on this one route
 * the body is two bearer credentials. So each problem is reported as a field
 * name plus a shape, and `describeOpaque` is the only thing allowed near a
 * value.
 *
 * The base64 check is not cosmetic: `signClobL2Request` keys the HMAC on
 * `Buffer.from(secret, 'base64')`, so a `secret` that decodes to zero bytes
 * produces a signature computed with an empty key. That signature is
 * well-formed, 44 characters long, and rejected by the venue on every request —
 * a failure mode with no local symptom at all.
 */
export function parseClobCredentials(body, route) {
    const record = typeof body === 'object' && body !== null ? body : {};
    const problems = [];
    const apiKey = readCredentialField(record.apiKey, 'apiKey', problems);
    const secret = readCredentialField(record.secret, 'secret', problems);
    const passphrase = readCredentialField(record.passphrase, 'passphrase', problems);
    if (secret !== null && Buffer.from(secret, 'base64').length === 0) {
        problems.push('secret is not base64 that decodes to any key bytes');
    }
    if (problems.length > 0 || apiKey === null || secret === null || passphrase === null) {
        throw new ClobCredentialError('clob-credential-response-malformed', `${route} returned credentials this client cannot use: ${problems.join('; ')}`);
    }
    return { apiKey, secret, passphrase };
}
function readCredentialField(value, field, problems) {
    if (typeof value !== 'string') {
        problems.push(`${field} is ${describeOpaque(value)}, not a string`);
        return null;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
        problems.push(`${field} is an empty string`);
        return null;
    }
    return trimmed;
}
/**
 * Runs a credential set through the same validation a derived one gets.
 *
 * Exported because preconfigured credentials arrive from an operator's
 * environment and are the *more* likely of the two to be mistyped — a truncated
 * `POLYMARKET_API_SECRET` decodes to a short key and fails every L2 request with
 * a venue-side 401 and no local clue.
 */
export function assertUsableClobCredentials(credentials) {
    return parseClobCredentials(credentials, 'preconfigured credentials');
}
/**
 * The call every principal makes: use the credentials you were given, or derive
 * them from your signer.
 *
 * This is the seam `apps/trade-executor/src/polymarket.ts` becomes a caller of.
 * Before `S3-20` the operator's version of this decision was spread across an
 * environment read, a module-level `ethers.Wallet` built from
 * `process.env.EVM_PRIVATE_KEY` at import, and `createSecureClient`'s own
 * internal derivation — three things a second principal cannot reuse.
 */
export async function resolveClobCredentials(input) {
    const nonce = normalizeClobNonce(input.nonce);
    if (input.preconfigured) {
        return {
            credentials: assertUsableClobCredentials(input.preconfigured),
            source: 'preconfigured'
        };
    }
    return { credentials: await input.derive(input.signer, { nonce }), source: 'derived' };
}
export function createClobCredentialStore(options) {
    const baseUrl = options.baseUrl ?? CLOB_BASE_URL;
    const origin = normalizeClobOrigin(baseUrl);
    const keyFor = options.cacheKeyFor ?? clobCredentialCacheKey;
    const entries = new Map();
    function identify(signer, given) {
        const signerAddress = normalizeClobSignerAddress(signer.address);
        const nonce = normalizeClobNonce(given?.nonce);
        return { signerAddress, nonce, key: keyFor({ signerAddress, nonce, baseUrl }) };
    }
    return {
        async credentialsFor(signer, given) {
            const { signerAddress, nonce, key } = identify(signer, given);
            const existing = entries.get(key);
            if (existing) {
                // The outbound half of the guard, in the spirit of `authorizeThrough` in
                // `execution-authority.ts`: the key says these credentials belong here,
                // and this re-checks the identity they were stored under. Belt and
                // braces, because "the cache served the wrong principal" produces a
                // successful venue request and is undetectable downstream.
                if (existing.signerAddress !== signerAddress ||
                    existing.nonce !== nonce ||
                    existing.origin !== origin) {
                    throw new ClobCredentialError('clob-credential-cache-collision', `cache key ${key} holds credentials for ${existing.signerAddress} nonce ` +
                        `${existing.nonce}; refusing to serve them to ${signerAddress} nonce ${nonce}`);
                }
                return existing.credentials;
            }
            // Stored before the first await, so two concurrent calls for one signer
            // share one derivation rather than racing two L1 signatures.
            const pending = options.derive(signer, { nonce });
            entries.set(key, { signerAddress, nonce, origin, credentials: pending });
            pending.catch(() => {
                // A rejected derivation must not be cached: the next call would replay
                // the same failure forever without ever retrying the venue. Guarded on
                // identity so a retry already in flight is not evicted.
                if (entries.get(key)?.credentials === pending)
                    entries.delete(key);
            });
            return pending;
        },
        keys() {
            return [...entries.keys()];
        },
        size() {
            return entries.size;
        },
        invalidate(signer, given) {
            return entries.delete(identify(signer, given).key);
        },
        clear() {
            entries.clear();
        }
    };
}
/**
 * Calls Polymarket CLOB auth endpoints using an existing L1 EIP-712 signature
 * (e.g. produced by a browser wallet via eth_signTypedData_v4).
 *
 * Tries POST /auth/api-key first, and on HTTP 400 falls back to GET /auth/derive-api-key.
 */
export async function fetchClobCredentialsFromSignature(input) {
    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    const origin = normalizeClobOrigin(input.baseUrl ?? CLOB_BASE_URL);
    normalizeClobSignerAddress(input.address);
    const nonce = normalizeClobNonce(input.nonce);
    assertL1Signature(input.signature);
    const headers = {
        POLY_ADDRESS: input.address,
        POLY_NONCE: String(nonce),
        POLY_SIGNATURE: input.signature,
        POLY_TIMESTAMP: String(input.timestampSeconds)
    };
    const transport = {
        fetchImpl,
        origin,
        headers,
        timeoutMs: DEFAULT_TIMEOUT_MS
    };
    const created = await requestCredentials({
        ...transport,
        method: 'POST',
        route: CREATE_ROUTE,
        tolerateAlreadyExists: true
    });
    if (created)
        return created;
    return requireCredentials(await requestCredentials({
        ...transport,
        method: 'GET',
        route: DERIVE_ROUTE
    }));
}
//# sourceMappingURL=polymarket-clob-credentials.js.map