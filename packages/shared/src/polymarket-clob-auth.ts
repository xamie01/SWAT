import { createHmac } from 'node:crypto';

/**
 * Polymarket CLOB **V2** L2 authentication (checklist S3-20).
 *
 * Verified against the live docs (`docs.polymarket.com/getting-started/api`)
 * rather than written from memory — the V1→V2 cutover on 2026-04-28 invalidated
 * every legacy SDK and V1-signed order, so a remembered signing scheme would
 * fail against production.
 *
 * Two layers exist:
 *   * **L1** — the wallet signs an EIP-712 `ClobAuth` payload. Used once, to
 *     create or derive API credentials.
 *   * **L2** — every private request is signed with those credentials using
 *     HMAC-SHA256. This module implements L2.
 *
 * Order *placement* needs both: L2 authenticates the request, and a separate
 * wallet signature authorises the order itself.
 *
 * **Not to be confused with the Perps API.** Perps lives under `/v1/trade/*` and
 * does carry client order IDs (`coid`). The predictions CLOB used here does not
 * — its order payload has no client-order-ID field, which is why idempotency is
 * carried by our own persisted signal/execution identity instead (audit G3-P6,
 * closed as venue-limited; re-verified against the docs 2026-08-05).
 */

export const CLOB_BASE_URL = 'https://clob.polymarket.com';

/** Chain ID pinned by the CLOB auth domain. Polygon mainnet. */
export const CLOB_CHAIN_ID = 137;

export interface ClobCredentials {
  readonly apiKey: string;
  /** Base64-encoded HMAC key. Decoded before use — never used as raw text. */
  readonly secret: string;
  readonly passphrase: string;
}

/**
 * Builds the EIP-712 `ClobAuth` payload for L1 signing.
 *
 * The signer address, timestamp, and nonce used here must be passed unchanged to
 * `/auth/api-key` or `/auth/derive-api-key`; the server re-derives the same
 * struct and recovers the signer, so any drift fails verification.
 */
export function buildClobAuthTypedData(input: {
  signerAddress: string;
  timestampSeconds: number;
  /** Credential nonce. `0` unless managing multiple credential sets. */
  nonce?: number;
}) {
  return {
    domain: {
      name: 'ClobAuthDomain',
      version: '1',
      chainId: CLOB_CHAIN_ID
    },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' }
      ],
      ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' }
      ]
    },
    primaryType: 'ClobAuth' as const,
    message: {
      address: input.signerAddress as `0x${string}`,
      // String, not number — the type is `string` in the struct, and a numeric
      // encoding would hash differently and fail signature recovery.
      timestamp: String(input.timestampSeconds),
      nonce: input.nonce ?? 0,
      message: 'This message attests that I control the given wallet'
    }
  } as const;
}

/**
 * URL-safe base64 **with padding retained**.
 *
 * Node's built-in `'base64url'` encoding strips the `=` padding, which the CLOB
 * rejects. The docs specify `urlsafeBase64WithPadding`, so the transform is done
 * explicitly here rather than relying on the built-in.
 */
function urlSafeBase64WithPadding(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

export interface L2SignatureInput {
  readonly secret: string;
  readonly timestampSeconds: number;
  readonly method: string;
  /** Route path only, e.g. `/data/orders`. No host, no query string. */
  readonly path: string;
  /**
   * The **exact serialized body sent over the wire**, or omitted for bodyless
   * requests. Re-serializing here would risk key-order or whitespace drift from
   * what is actually transmitted, and the signature would not verify.
   */
  readonly body?: string;
}

/**
 * Signs an L2 request.
 *
 * `message = timestamp + METHOD + path + body`, HMAC-SHA256 keyed by the
 * **base64-decoded** secret. Using the secret as raw text is the classic error
 * here and produces a signature that never verifies.
 */
export function signClobL2Request(input: L2SignatureInput): string {
  const message = `${input.timestampSeconds}${input.method.toUpperCase()}${input.path}${input.body ?? ''}`;
  const key = Buffer.from(input.secret, 'base64');
  return urlSafeBase64WithPadding(createHmac('sha256', key).update(message).digest());
}

export interface ClobAuthHeaders {
  readonly POLY_ADDRESS: string;
  readonly POLY_SIGNATURE: string;
  readonly POLY_TIMESTAMP: string;
  readonly POLY_API_KEY: string;
  readonly POLY_PASSPHRASE: string;
}

/**
 * Builds the five headers every L2-authenticated CLOB request carries.
 *
 * The timestamp is generated per request and must be the same value that went
 * into the signature — deriving it twice would let a slow call sign one second
 * and send another.
 */
export function buildClobL2Headers(input: {
  credentials: ClobCredentials;
  signerAddress: string;
  method: string;
  path: string;
  body?: string;
  timestampSeconds?: number;
}): ClobAuthHeaders {
  const timestampSeconds = input.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const signature = signClobL2Request({
    secret: input.credentials.secret,
    timestampSeconds,
    method: input.method,
    path: input.path,
    body: input.body
  });
  return {
    POLY_ADDRESS: input.signerAddress,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: String(timestampSeconds),
    POLY_API_KEY: input.credentials.apiKey,
    POLY_PASSPHRASE: input.credentials.passphrase
  };
}

/**
 * Redacts credentials for logging.
 *
 * The audit requires no secrets in logs (G3-P3). Passing a whole credential
 * object to a logger is the easy mistake; this makes the safe form available so
 * there is no reason to.
 */
export function redactCredentials(credentials: ClobCredentials): Record<string, string> {
  return {
    apiKey: `${credentials.apiKey.slice(0, 8)}…`,
    secret: '[redacted]',
    passphrase: '[redacted]'
  };
}
