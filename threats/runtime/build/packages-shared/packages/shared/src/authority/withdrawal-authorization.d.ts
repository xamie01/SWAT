export interface WithdrawalAuthorizationPayload {
    readonly chain: 'solana' | 'robinhood-chain' | 'polygon';
    readonly ownerPubkey: string;
    readonly recipientPubkey: string;
    readonly amountLamports: bigint;
    readonly timestampMs: number;
    readonly nonce: string;
}
export interface VerificationResult {
    readonly valid: boolean;
    readonly reason?: string;
    readonly code?: 'auth-ok' | 'invalid-amount' | 'timestamp-expired' | 'timestamp-future' | 'invalid-owner' | 'invalid-signature';
}
/**
 * Builds the canonical plaintext message to be signed by the user's wallet.
 *
 * Enforces strict line-delimited key-value structure so signatures cannot be
 * cross-interpreted across chains, recipients, or times.
 */
export declare function buildWithdrawalAuthorizationMessage(payload: WithdrawalAuthorizationPayload): string;
/**
 * Cryptographically verifies an off-chain withdrawal authorization request (S4-P21, ADR-0003 §5).
 *
 * Guarantees:
 *   1. Non-zero amount requested.
 *   2. Strict replay protection via expiration window (default 5 minutes).
 *   3. Clock drift bound (maximum 30s future tolerance).
 *   4. Valid Ed25519 signature verified directly against the authentic owner public key using native crypto.
 */
export declare function verifySolanaWithdrawalAuthorization(opts: {
    readonly payload: WithdrawalAuthorizationPayload;
    readonly signatureHex: string;
    readonly nowMs?: number;
    readonly maxAgeMs?: number;
}): VerificationResult;
//# sourceMappingURL=withdrawal-authorization.d.ts.map