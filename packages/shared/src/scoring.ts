import type { WalletScoreInput, WalletTier } from './types.js';

const WEIGHTS = {
  winRate: 0.25,
  realizedRoi: 0.3,
  earlyEntryScore: 0.25,
  consistencyScore: 0.2
} as const;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function calculateCompositeScore(input: WalletScoreInput): number {
  const normalizedRoi = clamp01(input.realizedRoi / 10);
  const winRate = clamp01(input.winRate);
  const earlyEntryScore = clamp01(input.earlyEntryScore);
  const consistencyScore = clamp01(input.consistencyScore);

  return Number(
    (
      winRate * WEIGHTS.winRate * 100 +
      normalizedRoi * WEIGHTS.realizedRoi * 100 +
      earlyEntryScore * WEIGHTS.earlyEntryScore * 100 +
      consistencyScore * WEIGHTS.consistencyScore * 100
    ).toFixed(2)
  );
}

export function scoreToTier(score: number): WalletTier {
  if (score >= 90) return 'elite';
  if (score >= 75) return 'pro';
  if (score >= 60) return 'promising';
  return 'speculative';
}
