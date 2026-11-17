import type { Observation } from './portfolio-model.js';

export interface LpMasterObservation { walletAddress: string; chain: string; closedPositionCount: number; winRate: number | null; realizedPnlUsd: number | null }
export function lpMasterCount(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : 'Unassessed';
}
export function lpWinRate(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? `${(value * 100).toFixed(1)}%` : 'Unassessed';
}
export function validPoolPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
export function lpBuilderHref(pool: { poolAddress: string; chain: string; currentPrice: unknown }): string {
  const params = new URLSearchParams({ pool: pool.poolAddress, chain: pool.chain });
  if (validPoolPrice(pool.currentPrice)) params.set('price', String(pool.currentPrice));
  return `/lp/builder?${params.toString()}`;
}
export function observedBuilderBounds(price: string | null): { lower: number; upper: number } | null {
  if (price === null || price.trim() === '') return null;
  const value = Number(price); if (!validPoolPrice(value)) return null;
  const lower = Number((value * 0.9).toFixed(4)), upper = Number((value * 1.1).toFixed(4));
  return Number.isFinite(lower) && Number.isFinite(upper) && lower > 0 && upper > lower ? { lower, upper } : null;
}
export function recordedRiskNotice(score: unknown): string {
  return typeof score === 'number' && Number.isFinite(score) ? `Recorded score ${score} — protection unverified` : 'Risk unassessed — protection unverified';
}
export function lpListState<T>(observation: Observation<T[]>): 'loading' | 'unavailable' | 'empty' | 'records' {
  if (observation.state === 'loading') return 'loading';
  if (observation.state === 'unavailable' || !Array.isArray(observation.data)) return 'unavailable';
  return observation.data.length === 0 ? 'empty' : 'records';
}
