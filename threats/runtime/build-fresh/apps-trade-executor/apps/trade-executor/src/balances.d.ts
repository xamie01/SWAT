type FetchLike = typeof fetch;
export declare function capBaseUnitSpend(requested: bigint, balance: bigint, reserve: bigint): bigint;
/** Standard Solana transfer network fee in lamports (0.000005 SOL). */
export declare const DEFAULT_SOLANA_FEE_LAMPORTS = 5000n;
/**
 * Calculates the safe maximum withdrawable native SOL in lamports, netting both the
 * rent-exempt minimum required to preserve the vault account on-chain and a network fee buffer.
 *
 * Prevents transaction reverts caused by rent-exemption violations or gas starvation.
 */
export declare function calculateMaxWithdrawableSolLamports(opts: {
    totalLamports: bigint;
    rentExemptMinLamports: bigint;
    feeBufferLamports?: bigint;
}): bigint;
export declare function fetchSolanaBalanceSol(opts: {
    walletAddress: string;
    heliusApiKey: string;
    timeoutMs: number;
    fetchFn?: FetchLike;
}): Promise<number>;
export {};
//# sourceMappingURL=balances.d.ts.map