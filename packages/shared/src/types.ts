export type WalletTier = 'elite' | 'pro' | 'promising' | 'speculative';
export type Chain = 'solana' | 'polygon' | 'robinhood-chain';

/**
 * Chains the LP dashboard operates on (migration `059`, `apps/lp`). LP is
 * Meteora DLMM on Solana and Uniswap v3/v4 on Robinhood Chain; copy trading
 * additionally serves polygon, so this is a narrowing of `Chain`, not a peer.
 */
export type LpChain = Extract<Chain, 'solana' | 'robinhood-chain'>;

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
  '*'?: ExecutionMode;
}
