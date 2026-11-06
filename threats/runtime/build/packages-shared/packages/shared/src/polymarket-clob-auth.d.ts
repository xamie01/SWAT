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
export declare const CLOB_BASE_URL = "https://clob.polymarket.com";
/** Chain ID pinned by the CLOB auth domain. Polygon mainnet. */
export declare const CLOB_CHAIN_ID = 137;
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
export declare function buildClobAuthTypedData(input: {
    signerAddress: string;
    timestampSeconds: number;
    /** Credential nonce. `0` unless managing multiple credential sets. */
    nonce?: number;
}): {
    domain: {
        name: string;
        version: string;
        chainId: number;
    };
    types: {
        EIP712Domain: {
            name: string;
            type: string;
        }[];
        ClobAuth: {
            name: string;
            type: string;
        }[];
    };
    primaryType: "ClobAuth";
    message: {
        address: string;
        timestamp: string;
        nonce: number;
        message: string;
    };
};
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
export declare function signClobL2Request(input: L2SignatureInput): string;
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
export declare function buildClobL2Headers(input: {
    credentials: ClobCredentials;
    signerAddress: string;
    method: string;
    path: string;
    body?: string;
    timestampSeconds?: number;
}): ClobAuthHeaders;
/**
 * Redacts credentials for logging.
 *
 * The audit requires no secrets in logs (G3-P3). Passing a whole credential
 * object to a logger is the easy mistake; this makes the safe form available so
 * there is no reason to.
 */
export declare function redactCredentials(credentials: ClobCredentials): Record<string, string>;
//# sourceMappingURL=polymarket-clob-auth.d.ts.map