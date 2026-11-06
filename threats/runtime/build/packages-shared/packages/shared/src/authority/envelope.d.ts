import { type KeyWrapper, type WrapContext } from './key-wrapper.js';
export declare class EnvelopeEncryptionError extends Error {
    constructor(message: string);
}
export declare class EnvelopeAuthenticationError extends EnvelopeEncryptionError {
    constructor(message: string);
}
/**
 * Seals a plaintext secret under envelope encryption (`S4-3`, ADR-0003 §5).
 *
 * 1. Generates a fresh 32-byte AES-256-GCM data key.
 * 2. Encrypts the secret with the data key, a fresh 12-byte IV, and AAD bound to the user/chain/version.
 * 3. Wraps the data key using the provided KeyWrapper.
 * 4. Assembles the self-describing versioned envelope:
 *    `v1.<wrapperId>.<b64(wrappedDataKey)>.<b64(iv)>.<b64(authTag)>.<b64(ciphertext)>`
 */
export declare function sealSecret(plaintext: Buffer | string, context: WrapContext, wrapper: KeyWrapper): Promise<string>;
/**
 * Opens a sealed secret envelope (`S4-3`, ADR-0003 §5).
 *
 * Validates the envelope format, checks wrapper ID, unwraps the data key with
 * the wrapper, and decrypts the ciphertext with GCM authentication.
 * If the ciphertext or context has been tampered with or swapped, throws an
 * EnvelopeAuthenticationError.
 */
export declare function openSealedSecret(envelope: string, context: WrapContext, wrapper: KeyWrapper): Promise<Buffer>;
//# sourceMappingURL=envelope.d.ts.map