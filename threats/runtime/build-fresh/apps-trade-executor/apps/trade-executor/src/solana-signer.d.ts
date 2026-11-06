/**
 * Concrete Solana signer for the Jupiter + Jito runtime (checklist S3-1, S3-2).
 *
 * Supplies the two functions `createJupiterJitoRuntime` takes as parameters:
 * `signTransaction` and `buildTipTransaction`. Keeping them injectable is
 * Standing Rule 2 — this module is the *operator* implementation, and Stage 4
 * substitutes a per-user custodial signer without touching the runtime.
 *
 * **The private key never leaves this module.** It is loaded once, held in a
 * closure, and only ever used inside `sign`. It is never returned, logged, or
 * placed on an object the caller can reach.
 */
export interface SolanaSignerOptions {
    /** Base58-encoded 64-byte secret key, as exported by common wallets. */
    readonly privateKeyBase58: string;
    /** RPC endpoint used only to fetch a recent blockhash for the tip transaction. */
    readonly rpcUrl: string;
}
export interface SolanaSigner {
    readonly publicKey: string;
    /** Signs a base64 versioned transaction, returning it base64-encoded. */
    sign(transactionBase64: string): Promise<string>;
    /** Builds and signs a base64 tip transfer. */
    buildTip(input: {
        tipAccount: string;
        lamports: number;
    }): Promise<string>;
    /** Current block height, for blockhash-expiry checks during reconciliation. */
    getBlockHeight(): Promise<number>;
}
export declare function createSolanaSigner(options: SolanaSignerOptions): SolanaSigner;
/**
 * Builds the signer from the environment, or returns null when unconfigured.
 *
 * Null rather than throwing: paper mode must run on a box with no Solana key,
 * and that is the default posture. The absence is only an error at the point
 * something actually tries to execute live, where `resolveChainMode` already
 * clamps to paper with a stated reason.
 */
export declare function createSolanaSignerFromEnvironment(): SolanaSigner | null;
//# sourceMappingURL=solana-signer.d.ts.map