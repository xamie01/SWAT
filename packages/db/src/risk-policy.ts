import type { PoolClient } from 'pg';
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
//
// Bounded on purpose (`S4-P3`). With one operator this map holds three entries;
// under fan-out the key includes a user id, so it grows one entry per active user
// per chain and — because entries were only ever TTL-checked on *read*, never
// swept — retained every user who had ever traded, including churned ones. That
// is unbounded growth keyed by user id inside the process that also holds the
// custody master key, which is the last place to leak memory.
const cachedPolicies = new Map<string, CachedRiskPolicy>();
const policyLoads = new Map<string, { generation: number; promise: Promise<RiskPolicy> }>();
let cacheGeneration = 0;

/**
 * Hard entry cap. Sized for a few thousand active (user, chain) pairs; well past
 * that the DB round trip is cheaper than the resident memory.
 */
const RISK_POLICY_CACHE_MAX_ENTRIES = 5_000;

/**
 * Drops expired entries, then evicts oldest-first if still over the cap.
 *
 * Eviction is by insertion order, which `Map` preserves — an approximation of LRU
 * that costs nothing, and is adequate because every entry expires within the TTL
 * anyway. The cap is the backstop for a burst that outruns expiry, not the primary
 * mechanism.
 */
function pruneRiskPolicyCache(now: number): void {
  for (const [key, entry] of cachedPolicies) {
    if (now - entry.timestamp >= RISK_POLICY_CACHE_TTL_MS) cachedPolicies.delete(key);
  }
  if (cachedPolicies.size <= RISK_POLICY_CACHE_MAX_ENTRIES) return;
  const excess = cachedPolicies.size - RISK_POLICY_CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const key of cachedPolicies.keys()) {
    if (removed >= excess) break;
    cachedPolicies.delete(key);
    removed += 1;
  }
}

function policyCacheKey(account: string, chain: Chain): string {
  return `${account}:${chain}`;
}

function numberOrUndefined(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  if (v === undefined) return undefined;
  throw new Error('Invalid explicit risk policy value; refusing to substitute a fallback');
}

async function loadRiskPolicyFromDb(chain: Chain, client?: PoolClient): Promise<RiskPolicy> {
  const sql = `SELECT key, value FROM config WHERE key IN ('trading', 'risk')`;
  const rows = client
    ? (await client.query<{ key: string; value: unknown }>(sql)).rows
    : await query<{ key: string; value: unknown }>(sql);

  const objectValue = (value: unknown): Record<string, unknown> | undefined => {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid risk policy config object');
    }
    return value as Record<string, unknown>;
  };
  const trading = objectValue(rows.find((r) => r.key === 'trading')?.value);
  const risk = objectValue(rows.find((r) => r.key === 'risk')?.value);

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
  const maxConsecutiveFailures = dbBreakerFailures ?? DEFAULT_RISK_CONFIG.maxConsecutiveFailures;
  const minLiquidityUsd = dbMinLiquidity ?? DEFAULT_RISK_CONFIG.minLiquidityUsd;
  for (const pct of [maxPositionPct, maxDailyExposurePct, stopLossPct]) {
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new Error('Invalid risk policy percentage');
  }
  if (!Number.isInteger(maxConsecutiveFailures) || maxConsecutiveFailures < 1 || maxConsecutiveFailures > 100) {
    throw new Error('Invalid risk policy circuit breaker threshold');
  }
  if (!Number.isFinite(minLiquidityUsd) || minLiquidityUsd < 0) throw new Error('Invalid risk policy liquidity minimum');

  return {
    maxPositionPct,
    maxDailyExposurePct,
    stopLossPct,
    maxConsecutiveFailures,
    minLiquidityUsd
  };
}

export interface RiskPolicyReadOptions {
  forceFresh?: boolean;
  /** Reads within the caller's transaction; never cached and never owns COMMIT. */
  client?: PoolClient;
}

export async function resolveRiskPolicy(account: string, chain: Chain, options: RiskPolicyReadOptions = {}): Promise<RiskPolicy> {
  if (typeof account !== 'string' || account.trim() === '') throw new Error('Risk policy account is required');
  if (options.client) return loadRiskPolicyFromDb(chain, options.client);
  // This remains platform policy: account is a cache/ledger key, not a claim of
  // tenant-specific config. Current user settings must be intersected by callers.
  if (options.forceFresh) clearRiskPolicyCache();
  const key = policyCacheKey(account, chain);
  const cached = cachedPolicies.get(key);
  if (cached && Date.now() - cached.timestamp < RISK_POLICY_CACHE_TTL_MS) {
    return cached.policy;
  }

  const inFlight = policyLoads.get(key);
  if (inFlight?.generation === cacheGeneration) return inFlight.promise;

  const generation = cacheGeneration;
  const promise = loadRiskPolicyFromDb(chain).then((policy) => {
    if (generation !== cacheGeneration) throw new Error('Stale in-flight risk policy authorization');
    {
      const now = Date.now();
      cachedPolicies.set(key, { policy, timestamp: now });
      // Swept on write rather than on a timer: a timer would keep the process
      // alive and would run when nothing is being cached, whereas growth only
      // ever happens here.
      pruneRiskPolicyCache(now);
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

/** Entry count. Test-only — lets a test assert the cache is actually bounded. */
export function riskPolicyCacheSize(): number {
  return cachedPolicies.size;
}

export { RISK_POLICY_CACHE_MAX_ENTRIES, RISK_POLICY_CACHE_TTL_MS };

export * from './risk-spend-owned.js';
