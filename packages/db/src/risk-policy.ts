import type { Chain } from '@swat/shared';
import { DEFAULT_RISK_CONFIG } from '@swat/shared';
import { query } from './client.js';

const RISK_POLICY_CACHE_TTL_MS = 30_000;

export interface RiskPolicy {
  maxPositionPct: number;
  maxDailyExposurePct: number;
  stopLossPct: number;
  maxConsecutiveFailures: number;
  minLiquidityUsd: number;
}

interface CachedRiskPolicy {
  policy: RiskPolicy;
  timestamp: number;
}

// Keyed by account:chain. The resolved policy is chain-specific (the env
// fallbacks below differ per chain), so a single shared slot would let one
// chain serve another chain's limits for the whole TTL.
const cachedPolicies = new Map<string, CachedRiskPolicy>();
const policyLoads = new Map<string, { generation: number; promise: Promise<RiskPolicy> }>();
let cacheGeneration = 0;

function policyCacheKey(account: string, chain: Chain): string {
  return `${account}:${chain}`;
}

function numberOrUndefined(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

async function loadRiskPolicyFromDb(chain: Chain): Promise<RiskPolicy> {
  const rows = await query<{ key: string; value: unknown }>(
    `SELECT key, value FROM config WHERE key IN ('trading', 'risk')`
  );

  const trading = rows.find((r) => r.key === 'trading')?.value as any | undefined;
  const risk = rows.find((r) => r.key === 'risk')?.value as any | undefined;

  // DB values
  const dbMaxPosition = trading ? numberOrUndefined(trading.max_position_pct) : undefined;
  const dbMaxDaily = trading ? numberOrUndefined(trading.max_daily_exposure_pct) : undefined;
  const dbMinLiquidity = trading ? numberOrUndefined(trading.min_liquidity_usd) : undefined;
  const dbStopLoss = risk ? numberOrUndefined(risk.stop_loss_pct) : undefined;
  const dbBreakerFailures = risk ? numberOrUndefined(risk.circuit_breaker_failures) : undefined;

  // Env fallbacks
  const envPaper = numberOrUndefined(process.env.PAPER_MAX_POSITION_PCT);
  const envChainFallback = chain === 'polygon'
    ? numberOrUndefined(process.env.USDC_BALANCE_RISK_PCT)
    : chain === 'robinhood-chain'
      ? numberOrUndefined(process.env.ETH_BALANCE_RISK_PCT)
      : undefined;

  const maxPositionPct = dbMaxPosition ?? envPaper ?? envChainFallback ?? DEFAULT_RISK_CONFIG.maxPositionPct;
  const maxDailyExposurePct = dbMaxDaily ?? numberOrUndefined(process.env.DAILY_EXPOSURE_PCT) ?? DEFAULT_RISK_CONFIG.maxDailyExposurePct;
  const stopLossPct = dbStopLoss ?? numberOrUndefined(process.env.STOP_LOSS_PCT) ?? DEFAULT_RISK_CONFIG.stopLossPct;
  const maxConsecutiveFailures = Math.max(1, Math.floor(dbBreakerFailures ?? DEFAULT_RISK_CONFIG.maxConsecutiveFailures));
  const minLiquidityUsd = dbMinLiquidity ?? DEFAULT_RISK_CONFIG.minLiquidityUsd;

  return {
    maxPositionPct,
    maxDailyExposurePct,
    stopLossPct,
    maxConsecutiveFailures,
    minLiquidityUsd
  };
}

export async function resolveRiskPolicy(account: string, chain: Chain): Promise<RiskPolicy> {
  // account is part of the cache key so per-account policies (Standing Rule 2)
  // can be added here without a cache redesign; the lookup itself is not yet
  // account-scoped.
  const key = policyCacheKey(account, chain);
  const cached = cachedPolicies.get(key);
  if (cached && Date.now() - cached.timestamp < RISK_POLICY_CACHE_TTL_MS) {
    return cached.policy;
  }

  const inFlight = policyLoads.get(key);
  if (inFlight?.generation === cacheGeneration) return inFlight.promise;

  const generation = cacheGeneration;
  const promise = loadRiskPolicyFromDb(chain).then((policy) => {
    if (generation === cacheGeneration) {
      cachedPolicies.set(key, { policy, timestamp: Date.now() });
    }
    return policy;
  });
  policyLoads.set(key, { generation, promise });

  try {
    return await promise;
  } finally {
    if (policyLoads.get(key)?.promise === promise) policyLoads.delete(key);
  }
}

export function clearRiskPolicyCache(): void {
  cacheGeneration += 1;
  cachedPolicies.clear();
  policyLoads.clear();
}
