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

export interface RiskSpendScope {
  account: string;
  chain: Chain;
  executionMode: 'paper' | 'live' | 'shadow';
  executionId: string;
  /** Durable current policy epoch from the authorized writer, never an env flag. */
  policyEpoch: string;
}

export interface RiskSpendReservationInput extends RiskSpendScope {
  /** Conservative priced maximum debit, including fees. Exact USD decimal text. */
  requestedUsd: string;
}

export type RiskSpendState = 'reserved' | 'submitted' | 'unknown' | 'partial' | 'confirmed' | 'released';
interface RiskSpendRow {
  execution_id: string;
  requested_usd: string;
  confirmed_usd: string;
  liability_usd: string;
  policy_epoch: string;
  state: RiskSpendState;
}
export interface RiskSpendReservation {
  executionId: string;
  state: RiskSpendState;
  liabilityUsd: string;
  confirmedUsd: string;
}

// Bounded exact money arithmetic. NUMERIC(38,18) in the unapplied schema;
// accepting exponents/float coercion here would under-reserve real obligations.
function riskUsd(value: string, positive = false): bigint {
  if (typeof value !== 'string' || !/^\d{1,20}(?:\.\d{1,18})?$/.test(value)) {
    throw new Error('Risk reservation requires exact non-negative USD decimal text');
  }
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  if (positive && units === 0n) throw new Error('Risk reservation USD must be positive');
  return units;
}
function riskUsdText(value: bigint): string {
  const text = value.toString().padStart(19, '0');
  return `${text.slice(0, -18)}.${text.slice(-18)}`.replace(/0+$/, '').replace(/\.$/, '');
}
function assertRiskSpendScope(scope: RiskSpendScope): void {
  if (typeof scope.account !== 'string' || !scope.account.trim() || scope.account.length > 128) {
    throw new Error('Risk reservation account is required');
  }
  if (!['paper', 'live', 'shadow'].includes(scope.executionMode)) throw new Error('Invalid risk reservation mode');
  if (typeof scope.executionId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(scope.executionId)) {
    throw new Error('Risk reservation requires a canonical execution UUID');
  }
  if (typeof scope.policyEpoch !== 'string' || !/^[1-9]\d{0,18}$/.test(scope.policyEpoch)) {
    throw new Error('Risk reservation requires a durable policy epoch');
  }
}
const RISK_SPEND_ROWS_SQL = `SELECT execution_id::text, requested_usd::text,
       confirmed_usd::text, liability_usd::text, policy_epoch::text, state
  FROM risk_spend_reservations
 WHERE account = $1 AND chain = $2 AND execution_mode = $3
   AND (state NOT IN ('confirmed', 'released') OR settled_at >= NOW() - INTERVAL '24 hours'
        OR execution_id = $4::uuid)
 FOR UPDATE`;
function riskSpendResult(row: RiskSpendRow): RiskSpendReservation {
  riskUsd(row.liability_usd); riskUsd(row.confirmed_usd);
  return { executionId: row.execution_id, state: row.state,
    liabilityUsd: row.liability_usd, confirmedUsd: row.confirmed_usd };
}

/** Caller owns BEGIN/tenant scope/claim/outbox/COMMIT. Missing schema or policy
 * fails closed; this helper cannot confer permission to sign or submit. The
 * policy row serializes ALL admissions/settlements/stops for this scope. */
export async function reserveRiskSpend(client: PoolClient, input: RiskSpendReservationInput): Promise<RiskSpendReservation> {
  assertRiskSpendScope(input);
  const requested = riskUsd(input.requestedUsd, true);
  const control = await client.query<{ epoch: string; enabled: boolean; cap_usd: string; accounting_ready: boolean }>(
    `SELECT epoch::text, enabled, cap_usd::text, accounting_ready FROM risk_policy_control
      WHERE account = $1 AND chain = $2 AND execution_mode = $3 FOR UPDATE`,
    [input.account, input.chain, input.executionMode]
  );
  const policy = control.rows[0];
  if (!policy || policy.accounting_ready !== true) throw new Error('Risk policy/accounting unavailable');
  if (policy.enabled !== true) throw new Error('Risk policy is stopped');
  if (policy.epoch !== input.policyEpoch) throw new Error('Stale risk policy epoch');
  const cap = riskUsd(policy.cap_usd, true);
  const result = await client.query<RiskSpendRow>(RISK_SPEND_ROWS_SQL,
    [input.account, input.chain, input.executionMode, input.executionId]);
  const existing = result.rows.find(row => row.execution_id === input.executionId);
  if (existing) {
    if (riskUsd(existing.requested_usd) !== requested || existing.policy_epoch !== input.policyEpoch) {
      throw new Error('Risk reservation immutable terms mismatch');
    }
    if (existing.state !== 'reserved') throw new Error('Risk reservation already submitted or terminal; reconcile without new effect');
    return riskSpendResult(existing);
  }
  const used = result.rows.reduce((sum, row) => sum + riskUsd(row.liability_usd), 0n);
  if (used + requested > cap) throw new Error('Risk spending cap reached');
  const inserted = await client.query<RiskSpendRow>(
    `INSERT INTO risk_spend_reservations
      (account, chain, execution_mode, execution_id, requested_usd, policy_epoch, liability_usd)
     VALUES ($1, $2, $3, $4::uuid, $5::numeric, $6::bigint, $5::numeric)
     RETURNING execution_id::text, state, liability_usd::text, confirmed_usd::text`,
    [input.account, input.chain, input.executionMode, input.executionId, input.requestedUsd, input.policyEpoch]
  );
  if (!inserted.rows[0]) throw new Error('Risk reservation was not persisted');
  return riskSpendResult(inserted.rows[0]);
}

/** Must be called with canonical evidence inserted/deduped and cumulative USD
 * derived inside this SAME transaction. No per-fill arithmetic or stop/TTL
 * release. Unknown pricing/submission retains at least the full requested debit.
 * Proven on-chain terminal failures need an integrator-owned receipt contract;
 * this narrow helper only releases orders known never to have been submitted. */
export async function updateRiskSpendReservation(client: PoolClient, input: RiskSpendScope & {
  state: RiskSpendState;
  confirmedUsd: string | null;
  provenNotSubmitted?: boolean;
}): Promise<RiskSpendReservation> {
  assertRiskSpendScope(input);
  if (!['reserved', 'submitted', 'unknown', 'partial', 'confirmed', 'released'].includes(input.state)) {
    throw new Error('Invalid risk reservation state');
  }
  await client.query(`SELECT epoch FROM risk_policy_control
    WHERE account = $1 AND chain = $2 AND execution_mode = $3 FOR UPDATE`,
  [input.account, input.chain, input.executionMode]);
  const result = await client.query<RiskSpendRow>(RISK_SPEND_ROWS_SQL,
    [input.account, input.chain, input.executionMode, input.executionId]);
  const row = result.rows.find(row => row.execution_id === input.executionId);
  if (!row || row.policy_epoch !== input.policyEpoch) throw new Error('Risk reservation identity/epoch missing');
  const canonical = await client.query<{
    state: string; submission_id: string | null; confirmed_usd: string | null;
    unvalued_count: string; completes_execution: boolean;
  }>(`SELECT execution.state, execution.submission_id,
      (SELECT SUM(evidence.quote_quantity)::text FROM copy_execution_evidence evidence
       WHERE evidence.execution_id = execution.id AND evidence.confirmation_state IN ('confirmed','finalized')) AS confirmed_usd,
      (SELECT COUNT(*)::text FROM copy_execution_evidence evidence WHERE evidence.execution_id = execution.id
       AND evidence.confirmation_state IN ('confirmed','finalized') AND evidence.quote_quantity IS NULL) AS unvalued_count,
      EXISTS (SELECT 1 FROM copy_execution_evidence evidence WHERE evidence.execution_id = execution.id
       AND evidence.confirmation_state IN ('confirmed','finalized') AND evidence.completes_execution) AS completes_execution
     FROM copy_executions execution WHERE execution.id = $4::uuid AND execution.chain = $2
       AND execution.execution_mode = $3 AND execution.direction = 'buy'
       AND COALESCE(execution.user_id::text, 'operator') = $1 FOR UPDATE OF execution`,
    [input.account, input.chain, input.executionMode, input.executionId]);
  const evidence = canonical.rows[0];
  if (!evidence) throw new Error('Canonical risk execution ownership/evidence unavailable');
  const previous = riskUsd(row.confirmed_usd);
  const confirmed = input.confirmedUsd === null ? previous : riskUsd(input.confirmedUsd);
  if (input.confirmedUsd !== null && (evidence.confirmed_usd === null
      ? confirmed !== 0n : riskUsd(evidence.confirmed_usd) !== confirmed)) {
    throw new Error('Risk USD does not match canonical cumulative evidence');
  }
  if (input.state === 'confirmed' && (evidence.state !== 'confirmed'
      || evidence.completes_execution !== true || evidence.unvalued_count !== '0')) {
    throw new Error('Canonical terminal risk evidence is incomplete/unvalued');
  }
  if (confirmed < previous) throw new Error('Risk cumulative evidence reversal refused');
  if (row.state === 'confirmed' || row.state === 'released') {
    if (row.state !== input.state || confirmed !== previous) throw new Error('Risk terminal evidence is immutable');
    return riskSpendResult(row);
  }
  if (input.state === 'reserved' && row.state !== 'reserved') throw new Error('Submitted liability cannot return to reserved');
  if (input.state === 'released' && (input.provenNotSubmitted !== true || row.state !== 'reserved'
      || confirmed !== 0n || evidence.submission_id !== null || !['requested', 'simulated', 'failed', 'cancelled'].includes(evidence.state))) {
    throw new Error('Cannot release submitted/unknown liability as a non-submission');
  }
  if (input.state === 'confirmed' && input.confirmedUsd === null) throw new Error('Confirmed USD pricing is unknown');
  const requested = riskUsd(row.requested_usd, true);
  const liability = input.state === 'released' ? 0n : input.state === 'confirmed'
    ? confirmed : [requested, riskUsd(row.liability_usd), confirmed].reduce((max, n) => n > max ? n : max);
  const updated = await client.query<RiskSpendRow>(
    `UPDATE risk_spend_reservations SET state = $5, confirmed_usd = $6::numeric,
       liability_usd = $7::numeric, settled_at = CASE WHEN $5 IN ('confirmed','released') THEN NOW() ELSE NULL END
     WHERE account = $1 AND chain = $2 AND execution_mode = $3 AND execution_id = $4::uuid
     RETURNING execution_id::text, state, liability_usd::text, confirmed_usd::text`,
    [input.account, input.chain, input.executionMode, input.executionId, input.state, riskUsdText(confirmed), riskUsdText(liability)]
  );
  if (!updated.rows[0]) throw new Error('Risk reservation update was not persisted');
  return riskSpendResult(updated.rows[0]);
}
