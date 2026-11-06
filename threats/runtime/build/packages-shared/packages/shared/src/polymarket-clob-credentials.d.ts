import { buildClobAuthTypedData, type ClobCredentials } from './polymarket-clob-auth.js';
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
export declare function clobL1SignerFrom(address: string, signTypedData: (typedData: ClobAuthTypedData) => Promise<string>): ClobL1Signer;
/** How credentials are obtained for a signer the caller has not cached. */
export type ClobCredentialDeriver = (signer: ClobL1Signer, options: {
    readonly nonce: number;
}) => Promise<ClobCredentials>;
export type ClobCredentialFailureCode = 
/** The signer's `address` is not an EVM address. */
'clob-credential-address-invalid'
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
export declare class ClobCredentialError extends Error {
    readonly code: ClobCredentialFailureCode;
    /** HTTP status when the venue answered, else `null`. */
    readonly status: number | null;
    constructor(code: ClobCredentialFailureCode, detail: string, options?: {
        readonly status?: number | null;
        readonly cause?: unknown;
    });
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
export declare function normalizeClobSignerAddress(address: string): string;
/**
 * Credential nonce. `0` unless a principal deliberately holds several sets.
 *
 * Part of the identity of a credential set, so it is part of the cache key: two
 * nonces for one address are two different credential sets, and serving one
 * where the other was asked for would authenticate as the wrong set.
 */
export declare function normalizeClobNonce(nonce?: number): number;
/**
 * Reduces a base URL to its origin.
 *
 * The origin, not the whole URL, because it is a cache-key component and a
 * trailing slash or a stray query string must not split one venue into two
 * entries. It is also the only free-form component of the key, and a serialized
 * origin cannot contain the key separator (see `clobCredentialCacheKey`).
 */
export declare function normalizeClobOrigin(baseUrl: string): string;
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
export declare function clobCredentialCacheKey(input: {
    readonly signerAddress: string;
    readonly nonce?: number;
    readonly baseUrl?: string;
}): string;
/**
 * Which endpoint to use.
 *
 * `create-or-derive` mirrors `@polymarket/client`'s `createOrDeriveApiKey`
 * exactly, including that the fallback is scoped to HTTP 400. The other two
 * exist because a caller that knows which case it is in should say so: Stage 4
 * onboarding creates once, and every later execution derives.
 */
export type ClobCredentialMode = 'create-or-derive' | 'create' | 'derive';
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
export declare function deriveClobCredentials(input: DeriveClobCredentialsInput): Promise<ClobCredentials>;
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
export declare function parseClobCredentials(body: unknown, route: string): ClobCredentials;
/**
 * Runs a credential set through the same validation a derived one gets.
 *
 * Exported because preconfigured credentials arrive from an operator's
 * environment and are the *more* likely of the two to be mistyped — a truncated
 * `POLYMARKET_API_SECRET` decodes to a short key and fails every L2 request with
 * a venue-side 401 and no local clue.
 */
export declare function assertUsableClobCredentials(credentials: ClobCredentials): ClobCredentials;
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
export declare function resolveClobCredentials(input: ResolveClobCredentialsInput): Promise<{
    readonly credentials: ClobCredentials;
    readonly source: ClobCredentialSource;
}>;
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
    credentialsFor(signer: ClobL1Signer, options?: {
        readonly nonce?: number;
    }): Promise<ClobCredentials>;
    /** The cache keys held. Addresses and origins only — safe to log. */
    keys(): readonly string[];
    size(): number;
    /** Drops one entry, e.g. after the venue rejects its credentials. */
    invalidate(signer: ClobL1Signer, options?: {
        readonly nonce?: number;
    }): boolean;
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
export declare function createClobCredentialStore(options: ClobCredentialStoreOptions): ClobCredentialStore;
export interface FetchClobCredentialsInput {
    readonly address: string;
    readonly signature: string;
    readonly timestampSeconds: number;
    readonly nonce?: number;
    readonly baseUrl?: string;
    readonly fetchImpl?: typeof fetch;
}
/**
 * Calls Polymarket CLOB auth endpoints using an existing L1 EIP-712 signature
 * (e.g. produced by a browser wallet via eth_signTypedData_v4).
 *
 * Tries POST /auth/api-key first, and on HTTP 400 falls back to GET /auth/derive-api-key.
 */
export declare function fetchClobCredentialsFromSignature(input: FetchClobCredentialsInput): Promise<ClobCredentials>;
//# sourceMappingURL=polymarket-clob-credentials.d.ts.map