/**
 * SIWE (EIP-4361) and SIWS wallet-signature verification.
 *
 * A valid signature proves control of a key. It does **not** prove the signer
 * meant to authenticate to *this* site, at *this* moment, once. Three separate
 * checks supply the rest, and dropping any one of them is a real vulnerability:
 *
 *   1. **Nonce, single-use.** Consumed atomically in Redis; a replayed message
 *      is rejected because the nonce is already gone.
 *   2. **Domain and URI binding.** Without this, a signature harvested by any
 *      other site whose message the user signed can be replayed here. This is
 *      the check most often omitted.
 *   3. **Expiry.** A 5-minute TTL bounds the window for a stolen signature.
 */
export type ChainKind = 'evm' | 'solana';
export interface SiweMessageParams {
    readonly domain: string;
    readonly uri: string;
    readonly address: string;
    readonly nonce: string;
    readonly issuedAt: string;
    readonly chainKind: ChainKind;
    readonly statement?: string;
}
/** Nonce lifetime. Long enough for a hardware wallet, short enough to bound theft. */
export declare const NONCE_TTL_SECONDS = 300;
export declare function generateNonce(): string;
/**
 * Builds the exact message the client must sign.
 *
 * The server generates this rather than accepting a client-supplied string:
 * verifying a message the caller wrote is verifying nothing, since they can put
 * any domain in it.
 */
export declare function buildSignInMessage(params: SiweMessageParams): string;
export interface VerifyInput {
    readonly chainKind: ChainKind;
    readonly address: string;
    readonly message: string;
    readonly signature: string;
    /** The nonce the server issued and has just atomically consumed. */
    readonly expectedNonce: string;
    readonly expectedDomain: string;
    readonly expectedUri: string;
}
export type VerifyFailure = 'nonce-mismatch' | 'domain-mismatch' | 'uri-mismatch' | 'address-mismatch' | 'malformed-message' | 'bad-signature';
export type VerifyResult = {
    readonly ok: true;
    readonly address: string;
} | {
    readonly ok: false;
    readonly reason: VerifyFailure;
};
/**
 * Normalises an address for comparison and storage.
 *
 * EVM is case-insensitive (EIP-55 checksums are presentational), so it is
 * lowercased. Solana base58 is case-*sensitive* and lowercasing it would produce
 * a different, invalid key — the same asymmetry `resolveChainAddress` encodes.
 */
export declare function normaliseAddress(chainKind: ChainKind, address: string): string;
export declare function verifySignInSignature(input: VerifyInput): Promise<VerifyResult>;
//# sourceMappingURL=wallet-signature.d.ts.map