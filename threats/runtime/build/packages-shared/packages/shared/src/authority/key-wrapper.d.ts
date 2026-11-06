/**
 * Context passed to KeyWrapper wrap/unwrap operations (`S4-4`).
 * Both AWS KMS, Vault Transit, and AES-GCM require this context for AAD binding.
 */
export interface WrapContext {
    readonly userId: string;
    readonly chainKind: 'evm' | 'solana';
    readonly keyVersion: number;
}
/**
 * KeyWrapper interface for envelope encryption (`S4-4`, D11).
 *
 * Provides the abstraction seam separating data-key encryption from key-storage
 * backends. Allows transitioning from environment master keys (EnvMasterKeyWrapper)
 * to Vault Transit (VaultTransitWrapper) or AWS KMS with zero business-logic refactoring.
 */
export interface KeyWrapper {
    /** Stable id embedded in every SealedKey this wrapper produces (e.g. 'env:v1', 'null:v1'). */
    readonly id: string;
    wrap(dataKey: Buffer, context: WrapContext): Promise<Buffer>;
    unwrap(wrapped: Buffer, context: WrapContext): Promise<Buffer>;
}
export declare function buildWrapAad(context: WrapContext): Buffer;
/**
 * EnvMasterKeyWrapper (`env:v<n>`)
 *
 * Implements envelope encryption using a master key loaded from environment variables
 * (e.g. `CUSTODY_MASTER_KEY`). Data keys are wrapped using AES-256-GCM with a fresh
 * 12-byte IV and AAD bound to the WrapContext.
 */
export declare class EnvMasterKeyWrapper implements KeyWrapper {
    readonly id: string;
    private readonly masterKey;
    constructor(options?: {
        masterKey?: Buffer | string;
        version?: number;
    });
    wrap(dataKey: Buffer, context: WrapContext): Promise<Buffer>;
    unwrap(wrapped: Buffer, context: WrapContext): Promise<Buffer>;
}
/**
 * NullWrapper (`null:v1`)
 *
 * Refuses wrap and unwrap operations. Used by staging and tests to guarantee that
 * simulated execution environments cannot accidentally access or store real custody secrets.
 */
export declare class NullWrapper implements KeyWrapper {
    readonly id = "null:v1";
    wrap(_dataKey: Buffer, _context: WrapContext): Promise<Buffer>;
    unwrap(_wrapped: Buffer, _context: WrapContext): Promise<Buffer>;
}
//# sourceMappingURL=key-wrapper.d.ts.map