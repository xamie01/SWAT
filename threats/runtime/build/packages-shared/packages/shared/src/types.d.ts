export type WalletTier = 'elite' | 'pro' | 'promising' | 'speculative';
export type Chain = 'solana' | 'polygon' | 'robinhood-chain' | 'base' | 'ethereum' | 'bsc';
/**
 * Chains the LP microservice operates on: Solana (Meteora DLMM & Raydium CLMM)
 * and EVM Concentrated Liquidity (Uniswap v3 / PancakeSwap v3 on Robinhood,
 * Base, Ethereum, and BSC).
 */
export type LpChain = 'solana' | 'robinhood-chain' | 'base' | 'ethereum' | 'bsc';
/**
 * Supported Liquidity Provision protocols.
 * - 'meteora-dlmm': Discrete bin dynamic volatility fee AMM on Solana.
 * - 'raydium-clmm': Tick-based concentrated liquidity on Solana.
 * - 'uniswap-v3': Standard tick-based CLMM on Ethereum, Base, Robinhood.
 * - 'uniswap-v4': Singleton hook-enabled CLMM on EVM.
 * - 'pancakeswap-v3': PancakeSwap v3 (Uniswap v3 bytecode) on BSC.
 */
export type LpProtocol = 'meteora-dlmm' | 'raydium-clmm' | 'uniswap-v3' | 'uniswap-v4' | 'pancakeswap-v3';
export interface WalletScoreInput {
    chain: Chain;
    winRate: number;
    realizedRoi: number;
    earlyEntryScore: number;
    consistencyScore: number;
}
export interface WalletRecord {
    address: string;
    chain: Chain;
    nickname?: string | null;
    source: 'shiller' | 'manual' | 'discovered';
    status: 'active' | 'paused' | 'blacklisted';
    totalTrades: number;
    winRate: number | null;
    realizedRoi: number | null;
    unrealizedRoi: number | null;
    compositeScore: number | null;
    tier: WalletTier | null;
    createdAt: Date;
    updatedAt: Date;
}
export interface SignalRecord {
    id: string;
    patternType: 'snipe' | 'accumulation' | 'rotation' | 'exit' | 'stealth';
    clusterId: string | null;
    tokenMint: string | null;
    confidence: number;
    signalScore: number;
    status: 'pending' | 'executing' | 'executed' | 'alerted' | 'expired' | 'rejected' | 'ignored';
    createdAt: Date;
    tokenName?: string | null;
    tokenSymbol?: string | null;
}
export type ExecutionMode = 'off' | 'paper' | 'live' | 'live+shadow';
export interface ExecutionConfig {
    solana?: ExecutionMode;
    polygon?: ExecutionMode;
    'robinhood-chain'?: ExecutionMode;
    base?: ExecutionMode;
    ethereum?: ExecutionMode;
    bsc?: ExecutionMode;
    '*'?: ExecutionMode;
}
//# sourceMappingURL=types.d.ts.map