import {
  buildClobAuthTypedData,
  CLOB_BASE_URL,
  type ClobCredentials
} from './polymarket-clob-auth.js';

/**
 * Deriving Polymarket CLOB L2 credentials **as a function of a signer**
 * (checklist `S3-20`, ADR-0003 section 4).
 *
 * ## What this adds to `polymarket-clob-auth.ts`
 *
 * That module already builds the L1 `ClobAuth` typed data and computes the L2
 * HMAC. What it never did was join them: nothing turned "I hold this signer" into
 * "here are its three credential values". The operator got its credentials from
 * environment variables, or from inside `@polymarket/client`'s own
 * `createSecureClient`, which reads a private key at the edge of the process.
 * Neither shape can serve a second principal.
 *
 * This module is that join, and it takes the signer as an argument. There is no
 * module-level credential, no `process.env` read, and no notion of *whose* signer
 * it is — the operator and a Stage 4 per-user grant are two callers of one
 * function, exactly as `solana-signer.ts` is a parameter to
 * `createJupiterJitoRuntime` and `UserExecutionAuthority`'s operator adapter is
 * one entry in a list rather than a branch in the executor.
 *
 * ## What credentials do and do not buy you
 *
 * L2 credentials authenticate an HTTP *request*. They cannot place an order:
 * every order carries an EIP-712 `Order` struct with a fresh `salt`, signed by
 * the account signer (ADR-0003 section 4.2). So a caller that holds only
 * credentials can read private endpoints and cancel, and cannot trade. This is
 * why ADR-0003 section 4.3 concludes that Polymarket cannot be made
 * non-custodial and why fork (b) exists: per-user credentials are necessary and
 * nowhere near sufficient.
 *
 * Deriving them still has to be per-signer, because the credentials the venue
 * issues are bound to the signer address that produced the L1 signature. One
 * operator-wide credential set cannot authenticate a request made on behalf of a
 * different wallet.
 *
 * ## Verified, not remembered
 *
 * Endpoints, headers and the create/derive fallback rule were read off the live
 * docs (`getting-started/api`) and off the installed SDK, not recalled:
 *
 *   * `POST /auth/api-key` creates; `GET /auth/derive-api-key` derives.
 *   * Both take exactly `POLY_ADDRESS`, `POLY_NONCE`, `POLY_SIGNATURE`,
 *     `POLY_TIMESTAMP` (`@polymarket/client@0.2.0`
 *     `dist/chunk-FA3ZDOJN.js`, the header builder for both routes).
 *   * The response field is `apiKey`. The SDK renames it to `key` in
 *     `ApiKeyCredsSchema` (`@polymarket/bindings@0.2.0/dist/clob/index.js`), so
 *     code written against the SDK type and code written against the wire
 *     disagree on that one name. This module speaks the wire.
 *   * `create-or-derive` tries create first and falls back to derive **only on
 *     HTTP 400**, which is what the SDK's `createOrDeriveApiKey` does:
 *     `try { return await create(...) } catch (e) { if (!(e instanceof HttpError)
 *     || e.status !== 400) throw e } return derive(...)`. Any other status is a
 *     real failure and must not be papered over by a second call.
 *
 * ## Nothing here logs, and nothing here echoes a value it was given
 *
 * Every value this module handles is a bearer credential or a private key's
 * public shadow. So: no logger, no `console`, and every error message is built
 * from field *names*, HTTP statuses and lengths only. `describeOpaque` exists
 * because the most likely malformed "address" a caller passes is a private key,
 * and an error that echoed its argument would write that key to a log.
 *
 * The same discipline as `packages/db/src/execution-grants.ts`, which never
 * selects the `sealed_secret` column on a read path so the ciphertext cannot
 * reach a response by accident.
 */

/** The EIP-712 payload `buildClobAuthTypedData` produces. */
export type ClobAuthTypedData = ReturnType<typeof buildClobAuthTypedData>;

/**
 * The whole of what credential derivation needs from a principal.
 *
 * Two members, neither of them a key: an address, and the ability to sign one
 * specific payload. An ethers `Wallet`, a viem account, a KMS client, a Privy
 * remote signer (ADR-0003 section 4.3's reopened fork (c)) and a test stub all
 * fit, and none of them has to be imported here — this module pulls in no chain
 * library at all, for the same reason `execution-authority.ts` declares
 * `Eip712TypedData` locally rather than importing it from `viem`.
 */
export interface ClobL1Signer {
  /** Polygon address the signature must recover to. `0x` + 40 hex. */
  readonly address: string;
  signTypedData(typedData: ClobAuthTypedData): Promise<string>;
}

/**
 * Wraps an address and a signing function as a `ClobL1Signer`.
 *
 * Exists so callers do not hand-roll the object literal and get the member name
 * wrong; every adapter (ethers v5's `_signTypedData`, viem's `signTypedData`, a
 * remote signer's HTTP call) is a one-line closure through here.
 */
export function clobL1SignerFrom(
  address: string,
  signTypedData: (typedData: ClobAuthTypedData) => Promise<string>
): ClobL1Signer {
  return { address, signTypedData };
}

/** How credentials are obtained for a signer the caller has not cached. */
export type ClobCredentialDeriver = (
  signer: ClobL1Signer,
  options: { readonly nonce: number }
) => Promise<ClobCredentials>;

export type ClobCredentialFailureCode =
  /** The signer's `address` is not an EVM address. */
  | 'clob-credential-address-invalid'
  /** The credential nonce is not a non-negative safe integer. */
  | 'clob-credential-nonce-invalid'
  /** The clock produced something that is not a positive integer second. */
  | 'clob-credential-timestamp-invalid'
  /** `baseUrl` is not a URL we can take an origin from. */
  | 'clob-credential-base-url-invalid'
  /** The injected signer threw. The mechanism is present; it refused or broke. */
  | 'clob-credential-signing-failed'
  /** The signer returned something that is not a hex signature. */
  | 'clob-credential-signature-malformed'
  /** The request never completed: DNS, TCP, TLS, timeout. */
  | 'clob-credential-transport-failed'
  /** The venue answered with a non-2xx status. */
  | 'clob-credential-rejected'
  /** 2xx, but the body is not usable credentials. */
  | 'clob-credential-response-malformed'
  /**
   * Two different signer identities landed on one cache key. Should be
   * unreachable; it is checked because the failure it guards against — handing
   * one user's credentials to another — is invisible from the outside.
   */
  | 'clob-credential-cache-collision';

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
  readonly code: ClobCredentialFailureCode;
  /** HTTP status when the venue answered, else `null`. */
  readonly status: number | null;

  constructor(
    code: ClobCredentialFailureCode,
    detail: string,
    options: { readonly status?: number | null; readonly cause?: unknown } = {}
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ClobCredentialError';
    this.code = code;
    this.status = options.status ?? null;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
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
function describeOpaque(value: unknown): string {
  if (typeof value === 'string') return `a ${value.length}-character string`;
  if (value === null) return 'null';
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
export function normalizeClobSignerAddress(address: string): string {
  const trimmed = typeof address === 'string' ? address.trim() : '';
  if (!EVM_ADDRESS_PATTERN.test(trimmed)) {
    throw new ClobCredentialError(
      'clob-credential-address-invalid',
      `signer address must be 0x followed by 40 hex characters, got ${describeOpaque(address)}`
    );
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
export function normalizeClobNonce(nonce?: number): number {
  const resolved = nonce ?? 0;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new ClobCredentialError(
      'clob-credential-nonce-invalid',
      `credential nonce must be a non-negative safe integer, got ${describeOpaque(nonce)}`
    );
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
export function normalizeClobOrigin(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ClobCredentialError(
      'clob-credential-base-url-invalid',
      `CLOB base URL is not a URL, got ${describeOpaque(baseUrl)}`
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ClobCredentialError(
      'clob-credential-base-url-invalid',
      `CLOB base URL must be http or https, got protocol ${url.protocol}`
    );
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
export function clobCredentialCacheKey(input: {
  readonly signerAddress: string;
  readonly nonce?: number;
  readonly baseUrl?: string;
}): string {
  const origin = normalizeClobOrigin(input.baseUrl ?? CLOB_BASE_URL);
  const address = normalizeClobSignerAddress(input.signerAddress);
  const nonce = normalizeClobNonce(input.nonce);
  return `clob-creds:v1|${origin}|${address}|${nonce}`;
}

/**
 * Which endpoint to use.
 *
 * `create-or-derive` mirrors `@polymarket/client`'s `createOrDeriveApiKey`
 * exactly, including that the fallback is scoped to HTTP 400. The other two
 * exist because a caller that knows which case it is in should say so: Stage 4
 * onboarding creates once, and every later execution derives.
 */
export type ClobCredentialMode = 'create-or-derive' | 'create' | 'derive';

const CREATE_ROUTE = '/auth/api-key';
const DERIVE_ROUTE = '/auth/derive-api-key';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface DeriveClobCredentialsInput {
  /** The principal. The only thing that makes this call about one account. */
  readonly signer: ClobL1Signer;
  readonly nonce?: number;
  readonly baseUrl?: string;
  readonly mode?: ClobCredentialMode;
  /**
   * The HTTP transport. **Required, with no default.**
   *
   * Every other injected dependency in this repo defaults (`email.ts` uses
   * `deps.fetchImpl ?? fetch`). This one does not, because the route it calls
   * issues bearer credentials against a real signature: a test that forgot to
   * stub would reach `clob.polymarket.com` with the operator's key. Making the
   * transport a required argument turns that into a compile error.
   */
  readonly fetchImpl: typeof fetch;
  /** Unix **seconds**. Injected so signature fixtures are reproducible. */
  readonly nowSeconds?: () => number;
  readonly timeoutMs?: number;
}

/**
 * Derives one principal's CLOB L2 credentials from its signer.
 *
 * The signer is signed *before* the transport is touched, deliberately: a signer
 * that cannot sign must not produce a venue request, and the ordering means an
 * unstubbed test fails at the signer rather than on the network.
 */
export async function deriveClobCredentials(
  input: DeriveClobCredentialsInput
): Promise<ClobCredentials> {
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

  let signature: string;
  try {
    signature = await input.signer.signTypedData(typedData);
  } catch (error) {
    throw new ClobCredentialError(
      'clob-credential-signing-failed',
      `the signer for ${signerAddress} threw ${errorLabel(error)}`
    );
  }
  assertL1Signature(signature);

  const headers: Record<string, string> = {
    POLY_ADDRESS: input.signer.address,
    POLY_NONCE: String(nonce),
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: String(timestampSeconds)
  };

  const mode = input.mode ?? 'create-or-derive';
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = { fetchImpl: input.fetchImpl, origin, headers, timeoutMs };

  if (mode === 'derive') {
    return requireCredentials(
      await requestCredentials({ ...transport, method: 'GET', route: DERIVE_ROUTE })
    );
  }

  const created = await requestCredentials({
    ...transport,
    method: 'POST',
    route: CREATE_ROUTE,
    // Only `create-or-derive` treats 400 as "already exists"; a caller that
    // asked for `create` gets the 400 as the failure it is.
    tolerateAlreadyExists: mode === 'create-or-derive'
  });
  if (created) return created;

  return requireCredentials(
    await requestCredentials({ ...transport, method: 'GET', route: DERIVE_ROUTE })
  );
}

function resolveTimestampSeconds(nowSeconds?: () => number): number {
  const value = nowSeconds ? nowSeconds() : Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ClobCredentialError(
      'clob-credential-timestamp-invalid',
      `L1 timestamp must be a positive integer number of seconds, got ${describeOpaque(value)}`
    );
  }
  return value;
}

/** The cause's constructor name only. Never its message. See `ClobCredentialError`. */
function errorLabel(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
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
function assertL1Signature(signature: unknown): asserts signature is string {
  const valid =
    typeof signature === 'string' &&
    HEX_SIGNATURE_PATTERN.test(signature) &&
    signature.length >= 4 &&
    signature.length % 2 === 0;
  if (!valid) {
    throw new ClobCredentialError(
      'clob-credential-signature-malformed',
      `the signer returned ${describeOpaque(signature)} instead of a 0x-prefixed hex signature`
    );
  }
}

interface CredentialRequest {
  readonly fetchImpl: typeof fetch;
  readonly origin: string;
  readonly route: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Record<string, string>;
  readonly timeoutMs: number;
  readonly tolerateAlreadyExists?: boolean;
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
async function requestCredentials(request: CredentialRequest): Promise<ClobCredentials | null> {
  const label = `${request.method} ${request.route}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);

  let response: Response;
  try {
    response = await request.fetchImpl(`${request.origin}${request.route}`, {
      method: request.method,
      headers: request.headers,
      signal: controller.signal
    });
  } catch (error) {
    throw new ClobCredentialError(
      'clob-credential-transport-failed',
      `${label} did not complete`,
      { cause: error }
    );
  } finally {
    clearTimeout(timer);
  }

  if (request.tolerateAlreadyExists && response.status === 400) return null;
  if (!response.ok) {
    throw new ClobCredentialError(
      'clob-credential-rejected',
      `${label} returned HTTP ${response.status}`,
      { status: response.status }
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ClobCredentialError(
      'clob-credential-response-malformed',
      `${label} returned a body that is not JSON`
    );
  }
  return parseClobCredentials(body, label);
}

function requireCredentials(credentials: ClobCredentials | null): ClobCredentials {
  // Unreachable: only a tolerated 400 yields null, and that path never reaches
  // here. Present so the type narrows without a non-null assertion.
  if (!credentials) {
    throw new ClobCredentialError(
      'clob-credential-response-malformed',
      'the auth route yielded no credentials'
    );
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
export function parseClobCredentials(body: unknown, route: string): ClobCredentials {
  const record: Record<string, unknown> =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const problems: string[] = [];

  const apiKey = readCredentialField(record.apiKey, 'apiKey', problems);
  const secret = readCredentialField(record.secret, 'secret', problems);
  const passphrase = readCredentialField(record.passphrase, 'passphrase', problems);

  if (secret !== null && Buffer.from(secret, 'base64').length === 0) {
    problems.push('secret is not base64 that decodes to any key bytes');
  }

  if (problems.length > 0 || apiKey === null || secret === null || passphrase === null) {
    throw new ClobCredentialError(
      'clob-credential-response-malformed',
      `${route} returned credentials this client cannot use: ${problems.join('; ')}`
    );
  }
  return { apiKey, secret, passphrase };
}

function readCredentialField(
  value: unknown,
  field: string,
  problems: string[]
): string | null {
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
export function assertUsableClobCredentials(credentials: ClobCredentials): ClobCredentials {
  return parseClobCredentials(credentials, 'preconfigured credentials');
}

export type ClobCredentialSource = 'preconfigured' | 'derived';

export interface ResolveClobCredentialsInput {
  readonly signer: ClobL1Signer;
  /**
   * Credentials the caller already holds, if any.
   *
   * The operator has these when `POLYMARKET_API_KEY` and friends are set. A
   * Stage 4 per-user grant never does. That is a property of the *input*, not of
   * who is asking — which is why there is no principal on this type and no
   * branch on one anywhere in this module.
   */
  readonly preconfigured?: ClobCredentials | null;
  readonly derive: ClobCredentialDeriver;
  readonly nonce?: number;
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
export async function resolveClobCredentials(input: ResolveClobCredentialsInput): Promise<{
  readonly credentials: ClobCredentials;
  readonly source: ClobCredentialSource;
}> {
  const nonce = normalizeClobNonce(input.nonce);
  if (input.preconfigured) {
    return {
      credentials: assertUsableClobCredentials(input.preconfigured),
      source: 'preconfigured'
    };
  }
  return { credentials: await input.derive(input.signer, { nonce }), source: 'derived' };
}

/**
 * A per-signer credential cache.
 *
 * Credentials have **no documented expiry or rotation** on this venue (ADR-0003
 * section 4.2), so re-deriving per request would burn an L1 signature and a
 * round trip for a value that never changes. Caching is therefore worth doing —
 * and is also the single most dangerous thing in this module, because a cache
 * keyed too coarsely hands one principal another's credentials and the resulting
 * request succeeds.
 */
export interface ClobCredentialStore {
  credentialsFor(
    signer: ClobL1Signer,
    options?: { readonly nonce?: number }
  ): Promise<ClobCredentials>;
  /** The cache keys held. Addresses and origins only — safe to log. */
  keys(): readonly string[];
  size(): number;
  /** Drops one entry, e.g. after the venue rejects its credentials. */
  invalidate(signer: ClobL1Signer, options?: { readonly nonce?: number }): boolean;
  clear(): void;
}

export interface ClobCredentialStoreOptions {
  /**
   * How to derive for a signer that is not cached. No default: the store holds
   * no transport, so a caller must decide what talks to the venue.
   */
  readonly derive: ClobCredentialDeriver;
  readonly baseUrl?: string;
  /**
   * Overridable **only so the collision guard below can be tested**. Production
   * callers must leave this alone; a key function that drops a component is
   * exactly the defect the guard exists to catch.
   */
  readonly cacheKeyFor?: (input: {
    readonly signerAddress: string;
    readonly nonce: number;
    readonly baseUrl: string;
  }) => string;
}

interface CacheEntry {
  readonly signerAddress: string;
  readonly nonce: number;
  readonly origin: string;
  readonly credentials: Promise<ClobCredentials>;
}

export function createClobCredentialStore(
  options: ClobCredentialStoreOptions
): ClobCredentialStore {
  const baseUrl = options.baseUrl ?? CLOB_BASE_URL;
  const origin = normalizeClobOrigin(baseUrl);
  const keyFor = options.cacheKeyFor ?? clobCredentialCacheKey;
  const entries = new Map<string, CacheEntry>();

  function identify(signer: ClobL1Signer, given?: { readonly nonce?: number }) {
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
        if (
          existing.signerAddress !== signerAddress ||
          existing.nonce !== nonce ||
          existing.origin !== origin
        ) {
          throw new ClobCredentialError(
            'clob-credential-cache-collision',
            `cache key ${key} holds credentials for ${existing.signerAddress} nonce ` +
              `${existing.nonce}; refusing to serve them to ${signerAddress} nonce ${nonce}`
          );
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
        if (entries.get(key)?.credentials === pending) entries.delete(key);
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
