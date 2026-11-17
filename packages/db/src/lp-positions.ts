import {
  canTransitionLpPosition,
  type LpChain,
  type LpPositionState
} from '@swat/shared';
import { scopedQuery as queryForScope } from './tenancy.js';
import type { LpProtocol } from './lp-pools.js';
import { isCrossTenant, withTenantTransaction, type UserScope } from './tenancy.js';

/**
 * User LP positions and their state machine (`059`).
 *
 * `transitionLpPosition` is the only writer of `lp_positions.state`. It runs
 * the shared predicate (`canTransitionLpPosition`) and the SQL trigger enforces
 * the same table a second time, so the two cannot drift silently: code drift is
 * caught by the trigger raising, trigger drift is caught by the code refusing
 * before the statement is even sent.
 *
 * The monitor sweep (`listPositionsForMonitor`) crosses tenants by design and
 * therefore requires a `crossTenantScope` at the call site, like every other
 * platform sweep in this package.
 */

export type LpStrategyType = 'spot' | 'curve' | 'bidask';

/** One ladder rung. Meteora rungs carry bin ids; Uniswap rungs carry tick bounds. */
export interface LpRungAllocation {
  readonly priceLower: number;
  readonly priceUpper: number;
  /** Fraction of the deposit assigned to this rung, 0..1. Rungs sum to ≤ 1. */
  readonly weight: number;
  readonly binId?: number;
  readonly tickLower?: number;
  readonly tickUpper?: number;
}

export interface LpPosition {
  readonly id: string;
  readonly userId: string;
  readonly chain: LpChain;
  readonly protocol: LpProtocol;
  /** Chain-prefixed. */
  readonly poolAddress: string;
  readonly strategyType: LpStrategyType;
  readonly rangeLower: number;
  readonly rangeUpper: number;
  readonly rungAllocations: readonly LpRungAllocation[];
  readonly depositAmount: number;
  /** Chain-prefixed mint of the single deposit token. */
  readonly depositAsset: string;
  readonly state: LpPositionState;
  /** Chain-prefixed; null while building or paper-only. */
  readonly onChainPositionAddress: string | null;
  /**
   * Track I: the owner's opt-in to automatic rebalancing. The scheduled
   * monitor only queues rebalances for opted-in positions; manual triggers
   * bypass this flag (the user IS the consent).
   */
  readonly autoRebalance: boolean;
  readonly acquisitionMode?: 'unknown' | 'paper' | 'live';
  readonly acquisitionProvenance?: string | null;
  readonly depositValueUsd?: number | null;
  readonly valuationEvidence?: unknown;
  readonly paperPlan?: unknown;
  readonly acquisitionKey?: string | null;
  readonly acquisitionFingerprint?: string | null;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly updatedAt: Date;
}

export interface PositionRow {
  id: string;
  user_id: string;
  chain: LpChain;
  protocol: LpProtocol;
  pool_address: string;
  strategy_type: LpStrategyType;
  range_lower: number | string;
  range_upper: number | string;
  rung_allocations: unknown;
  deposit_amount: number | string;
  deposit_asset: string;
  state: LpPositionState;
  on_chain_position_address: string | null;
  auto_rebalance: boolean;
  acquisition_mode?: 'unknown' | 'paper' | 'live';
  acquisition_provenance?: string | null;
  deposit_value_usd?: number | string | null;
  valuation_evidence?: unknown;
  paper_plan?: unknown;
  acquisition_key?: string | null;
  acquisition_fingerprint?: string | null;
  opened_at: Date;
  closed_at: Date | null;
  updated_at: Date;
}

export const POSITION_COLUMNS =
  'id, user_id, chain, protocol, pool_address, strategy_type, range_lower, range_upper, ' +
  'rung_allocations, deposit_amount, deposit_asset, state, on_chain_position_address, ' +
  'auto_rebalance, acquisition_mode, acquisition_provenance, deposit_value_usd, valuation_evidence, ' +
  'paper_plan, acquisition_key, acquisition_fingerprint, opened_at, closed_at, updated_at';

function toSafeNumber(value: number | string): number {
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`stored NUMERIC ${String(value)} does not fit a float64`);
  }
  return parsed;
}

function toRungAllocations(value: unknown): LpRungAllocation[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const rung = entry as Record<string, unknown>;
    return {
      priceLower: Number(rung.priceLower),
      priceUpper: Number(rung.priceUpper),
      weight: Number(rung.weight),
      binId: rung.binId === undefined ? undefined : Number(rung.binId),
      tickLower: rung.tickLower === undefined ? undefined : Number(rung.tickLower),
      tickUpper: rung.tickUpper === undefined ? undefined : Number(rung.tickUpper)
    };
  });
}

export function toPosition(row: PositionRow): LpPosition {
  return {
    id: row.id,
    userId: row.user_id,
    chain: row.chain,
    protocol: row.protocol,
    poolAddress: row.pool_address,
    strategyType: row.strategy_type,
    rangeLower: toSafeNumber(row.range_lower),
    rangeUpper: toSafeNumber(row.range_upper),
    rungAllocations: toRungAllocations(row.rung_allocations),
    depositAmount: toSafeNumber(row.deposit_amount),
    depositAsset: row.deposit_asset,
    state: row.state,
    onChainPositionAddress: row.on_chain_position_address,
    autoRebalance: row.auto_rebalance,
    acquisitionMode: row.acquisition_mode ?? 'unknown',
    acquisitionProvenance: row.acquisition_provenance ?? null,
    depositValueUsd: row.deposit_value_usd == null ? null : toSafeNumber(row.deposit_value_usd),
    valuationEvidence: row.valuation_evidence ?? null,
    paperPlan: row.paper_plan ?? null,
    acquisitionKey: row.acquisition_key ?? null,
    acquisitionFingerprint: row.acquisition_fingerprint ?? null,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    updatedAt: row.updated_at
  };
}

function assertRungs(rungs: readonly LpRungAllocation[]): void {
  let totalWeight = 0;
  for (const rung of rungs) {
    if (
      !Number.isFinite(rung.priceLower) || rung.priceLower <= 0
      || !Number.isFinite(rung.priceUpper) || rung.priceUpper <= rung.priceLower
    ) {
      throw new Error(`invalid ladder rung price bounds: ${rung.priceLower}..${rung.priceUpper}`);
    }
    if (!Number.isFinite(rung.weight) || rung.weight < 0 || rung.weight > 1) {
      throw new Error(`ladder rung weight must be a finite fraction in 0..1, got ${rung.weight}`);
    }
    totalWeight += rung.weight;
  }
  if (totalWeight > 1 + 1e-9) {
    throw new Error(`ladder rung weights must sum to at most 1, got ${totalWeight}`);
  }
}

export interface CreateLpPositionInput {
  readonly chain: LpChain;
  readonly protocol: LpProtocol;
  /** Chain-prefixed. */
  readonly poolAddress: string;
  readonly strategyType: LpStrategyType;
  readonly rangeLower: number;
  readonly rangeUpper: number;
  readonly rungAllocations: readonly LpRungAllocation[];
  readonly depositAmount: number;
  /** Chain-prefixed. */
  readonly depositAsset: string;
  /** Track I: opt into automatic rebalancing at deploy time. Default false. */
  readonly autoRebalance?: boolean;
}

export async function createLpPosition(
  _scope: UserScope,
  _input: CreateLpPositionInput
): Promise<LpPosition> {
  throw new Error('LP legacy unvalued acquisition unavailable; exact injected rawscale domain required');
}

export async function getLpPosition(scope: UserScope, positionId: string): Promise<LpPosition | null> {
  const rows = await queryForScope<PositionRow>(scope,
    `SELECT ${POSITION_COLUMNS} FROM lp_positions WHERE id = $1 AND user_id = $2`,
    [positionId, scope.userId]
  );
  return rows[0] ? toPosition(rows[0]) : null;
}

/**
 * Worker-side read of one position regardless of owner. Platform sweep — pass
 * `crossTenantScope(reason)`. The execution worker receives only the position
 * id in its job payload and must be able to see any user's row to refuse
 * acting on one that closed (or never left `building`) between enqueue and run.
 */
export async function getLpPositionAnyOwner(scope: UserScope, positionId: string): Promise<LpPosition | null> {
  if (!isCrossTenant(scope)) {
    throw new Error('getLpPositionAnyOwner is a platform read; pass crossTenantScope(reason)');
  }
  const rows = await queryForScope<PositionRow>(scope,
    `SELECT ${POSITION_COLUMNS} FROM lp_positions WHERE id = $1`,
    [positionId]
  );
  return rows[0] ? toPosition(rows[0]) : null;
}

export async function listLpPositions(
  scope: UserScope,
  options: { includeClosed?: boolean; limit?: number } = {}
): Promise<LpPosition[]> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error(`listLpPositions limit must be an integer in 1..500, got ${limit}`);
  }
  const rows = options.includeClosed
    ? await queryForScope<PositionRow>(scope,
        `SELECT ${POSITION_COLUMNS} FROM lp_positions
          WHERE user_id = $1
          ORDER BY opened_at DESC
          LIMIT $2`,
        [scope.userId, limit]
      )
    : await queryForScope<PositionRow>(scope,
        `SELECT ${POSITION_COLUMNS} FROM lp_positions
          WHERE user_id = $1 AND state <> 'closed'
          ORDER BY opened_at DESC
          LIMIT $2`,
        [scope.userId, limit]
      );
  return rows.map(toPosition);
}

/**
 * Open positions due for a monitor pass on one chain. Platform sweep — pass
 * `crossTenantScope('lp position monitor sweep')`. Served by
 * idx_lp_positions_monitor.
 */
export async function listPositionsForMonitor(
  scope: UserScope,
  chain: LpChain,
  limit = 500
): Promise<LpPosition[]> {
  if (!isCrossTenant(scope)) {
    throw new Error('listPositionsForMonitor is a platform sweep; pass crossTenantScope(reason)');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
    throw new Error(`listPositionsForMonitor limit must be an integer in 1..2000, got ${limit}`);
  }
  const rows = await queryForScope<PositionRow>(scope,
    `SELECT ${POSITION_COLUMNS} FROM lp_positions
      WHERE chain = $1 AND state IN ('active', 'near_edge', 'out_of_range')
      ORDER BY updated_at
      LIMIT $2`,
    [chain, limit]
  );
  return rows.map(toPosition);
}

/**
 * Track I: flips the auto-rebalance opt-in. A preference write, not a state
 * transition — it must not touch `state` or the journal.
 */
export async function setLpPositionAutoRebalance(
  scope: UserScope,
  positionId: string,
  enabled: boolean
): Promise<void> {
  return withTenantTransaction(scope, async client => {
    const owner = await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [scope.userId]);
    if (!owner.rows[0]) throw new Error('LP owner unavailable');
    const result = await client.query(`UPDATE lp_positions SET auto_rebalance=$3,updated_at=statement_timestamp()
      WHERE id=$1 AND user_id=$2 RETURNING id`, [positionId, scope.userId, enabled]);
    if (!result.rows[0]) throw new Error('LP owned position unavailable');
  });
}

export interface LpPositionStateTransition {
  readonly toState: LpPositionState;
  /** Required for every transition; the history row is the audit trail. */
  readonly reason: string;
}

/**
 * The only writer of `lp_positions.state`.
 *
 * Locks the row FOR UPDATE first so two racing transitions (monitor sweep vs.
 * user close) serialize instead of both passing the predicate on the same
 * pre-image. Refusing a transition leaves the row untouched — a refused
 * transition that still writes is the failure mode the history table exists to
 * catch.
 */
export async function transitionLpPosition(
  scope: UserScope,
  positionId: string,
  transition: LpPositionStateTransition
): Promise<LpPosition> {
  if (!transition.reason || transition.reason.trim().length === 0) {
    throw new Error('transitionLpPosition requires a reason');
  }
  if (isCrossTenant(scope)) throw new Error('LP transition requires the resolved owner tenant scope; privileged monitor enumeration unavailable');
  const filterByUser = true;

  return withTenantTransaction(scope, async (client) => {
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [scope.userId]);
    // Ownership rides in the locked SELECT rather than a pre-check outside the
    // transaction: one round trip, and no window where a row passes the check
    // and is gone before the lock.
    const locked = await client.query<PositionRow>(
      `SELECT ${POSITION_COLUMNS} FROM lp_positions
        WHERE id = $1 ${filterByUser ? 'AND user_id = $2' : ''}
        FOR UPDATE`,
      filterByUser ? [positionId, scope.userId] : [positionId]
    );
    if (locked.rows.length === 0) {
      throw new Error(
        `lp position ${positionId} not found${filterByUser ? ' for this user' : ''}`
      );
    }
    const current = toPosition(locked.rows[0]!);
    if (transition.toState === 'closed' || transition.toState === 'rebalancing') {
      throw new Error('LP financial lifecycle requires the durable paper operation path; live/unknown unsupported');
    }
    if (!canTransitionLpPosition(current.state, transition.toState)) {
      throw new Error(
        `invalid lp position transition: ${current.state} -> ${transition.toState}`
      );
    }

    const updated = await client.query<PositionRow>(
      `UPDATE lp_positions
         SET state = $2,
             closed_at = CASE WHEN $2 = 'closed' THEN NOW() ELSE closed_at END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING ${POSITION_COLUMNS}`,
      [positionId, transition.toState]
    );
    await client.query(
      `INSERT INTO lp_position_state_history (position_id, from_state, to_state, reason)
       VALUES ($1, $2, $3, $4)`,
      [positionId, current.state, transition.toState, transition.reason]
    );
    return toPosition(updated.rows[0]!);
  });
}

/** Track E wiring: records the on-chain position address once the ladder is built. */
export async function attachOnChainPositionAddress(
  scope: UserScope,
  positionId: string,
  onChainPositionAddress: string
): Promise<void> {
  if (onChainPositionAddress.indexOf(':') < 0) {
    throw new Error('on-chain position address must be chain-prefixed');
  }
  throw new Error('live LP attachment unsupported; certified receipt settlement required');
  await queryForScope(scope,
    `UPDATE lp_positions
       SET on_chain_position_address = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
    [positionId, scope.userId, onChainPositionAddress]
  );
}

/**
 * Total open LP capital for a user, summed over non-closed positions. The
 * exposure cap (Track G1) measures a pool against this base, so a position
 * closing must shrink the base immediately — hence the state filter here
 * rather than a cached total.
 */
export async function sumOpenLpDeposits(scope: UserScope): Promise<number> {
  const rows = await queryForScope<{ total: number | string | null; unvalued: number | string }>(scope,
    `SELECT SUM(deposit_value_usd) AS total, COUNT(*) FILTER (WHERE deposit_value_usd IS NULL OR acquisition_mode = 'unknown') AS unvalued FROM lp_positions
      WHERE user_id = $1 AND state <> 'closed'`,
    [scope.userId]
  );
  if (Number(rows[0]?.unvalued ?? 0) > 0) throw new Error('LP exposure unassessed: missing acquisition valuation');
  const total = rows[0]?.total;
  return total === null || total === undefined ? 0 : toSafeNumber(total);
}

/**
 * The user's open capital currently committed to one pool. Chain rides along
 * because pool addresses are chain-prefixed and unique per chain.
 */
export async function sumOpenLpPoolExposure(
  scope: UserScope,
  chain: LpChain,
  poolAddress: string
): Promise<number> {
  const rows = await queryForScope<{ total: number | string | null; unvalued: number | string }>(scope,
    `SELECT SUM(deposit_value_usd) AS total, COUNT(*) FILTER (WHERE deposit_value_usd IS NULL OR acquisition_mode = 'unknown') AS unvalued FROM lp_positions
      WHERE user_id = $1 AND chain = $2 AND pool_address = $3 AND state <> 'closed'`,
    [scope.userId, chain, poolAddress]
  );
  if (Number(rows[0]?.unvalued ?? 0) > 0) throw new Error('LP exposure unassessed: missing acquisition valuation');
  const total = rows[0]?.total;
  return total === null || total === undefined ? 0 : toSafeNumber(total);
}
