import type { WalletScoreInput, WalletTier } from './types.js';

const WEIGHTS = {
  solana: {
    winRate: 0.25,
    realizedRoi: 0.3,
    earlyEntryScore: 0.25,
    consistencyScore: 0.2
  },
  polygon: { // Polymarket
    winRate: 0.50, // High weight on resolution-derived skill
    realizedRoi: 0.3,
    earlyEntryScore: 0.0,
    consistencyScore: 0.2
  },
  'robinhood-chain': {
    winRate: 0.25,
    realizedRoi: 0.3,
    earlyEntryScore: 0.25,
    consistencyScore: 0.2
  }
} as const;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function calculateCompositeScore(input: WalletScoreInput): number {
  const normalizedRoi = clamp01(input.realizedRoi / 10);
  const winRate = clamp01(input.winRate);
  const earlyEntryScore = clamp01(input.earlyEntryScore);
  const consistencyScore = clamp01(input.consistencyScore);
  
  const w = WEIGHTS[input.chain] ?? WEIGHTS.solana;

  return Number(
    (
      winRate * w.winRate * 100 +
      normalizedRoi * w.realizedRoi * 100 +
      earlyEntryScore * w.earlyEntryScore * 100 +
      consistencyScore * w.consistencyScore * 100
    ).toFixed(2)
  );
}

export function scoreToTier(score: number): WalletTier {
  if (score >= 90) return 'elite';
  if (score >= 75) return 'pro';
  if (score >= 60) return 'promising';
  return 'speculative';
}
