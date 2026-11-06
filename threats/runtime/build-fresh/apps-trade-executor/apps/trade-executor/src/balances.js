import { resolveChainAddress } from '@swat/shared';
export function capBaseUnitSpend(requested, balance, reserve) {
    if (requested < 0n || balance < 0n || reserve < 0n) {
        throw new Error('Base-unit balance inputs must be non-negative');
    }
    const spendable = balance > reserve ? balance - reserve : 0n;
    return requested < spendable ? requested : spendable;
}
/** Standard Solana transfer network fee in lamports (0.000005 SOL). */
export const DEFAULT_SOLANA_FEE_LAMPORTS = 5000n;
/**
 * Calculates the safe maximum withdrawable native SOL in lamports, netting both the
 * rent-exempt minimum required to preserve the vault account on-chain and a network fee buffer.
 *
 * Prevents transaction reverts caused by rent-exemption violations or gas starvation.
 */
export function calculateMaxWithdrawableSolLamports(opts) {
    const { totalLamports, rentExemptMinLamports, feeBufferLamports = DEFAULT_SOLANA_FEE_LAMPORTS } = opts;
    if (totalLamports < 0n || rentExemptMinLamports < 0n || feeBufferLamports < 0n) {
        throw new Error('Lamport balance inputs must be non-negative');
    }
    const requiredReserve = rentExemptMinLamports + feeBufferLamports;
    return totalLamports > requiredReserve ? totalLamports - requiredReserve : 0n;
}
export async function fetchSolanaBalanceSol(opts) {
    const walletAddress = resolveChainAddress(opts.walletAddress, 'solana').raw;
    if (!opts.heliusApiKey) {
        throw new Error('HELIUS_API_KEY is required to verify the Trojan wallet balance');
    }
    if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
        throw new Error('Solana balance timeout must be a positive integer');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
        const response = await (opts.fetchFn ?? fetch)(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(opts.heliusApiKey)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'swat-trade-balance',
                method: 'getBalance',
                params: [walletAddress, { commitment: 'confirmed' }]
            })
        });
        if (!response.ok) {
            throw new Error(`Solana balance RPC returned HTTP ${response.status}`);
        }
        const body = await response.json();
        if (body.error) {
            throw new Error(`Solana balance RPC error: ${String(body.error.message ?? 'unknown error')}`);
        }
        const lamports = body.result?.value;
        if (typeof lamports !== 'number' || !Number.isSafeInteger(lamports) || lamports < 0) {
            throw new Error('Solana balance RPC returned an invalid lamport balance');
        }
        return lamports / 1_000_000_000;
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=balances.js.map