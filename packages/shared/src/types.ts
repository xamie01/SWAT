export type WalletTier = 'elite' | 'pro' | 'promising' | 'speculative';

export interface WalletScoreInput {
  winRate: number;
  realizedRoi: number;
  earlyEntryScore: number;
  consistencyScore: number;
}

export interface WalletRecord {
  address: string;
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
  status: 'pending' | 'executed' | 'alerted' | 'expired' | 'rejected';
  createdAt: Date;
}
