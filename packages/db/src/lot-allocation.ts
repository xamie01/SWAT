import type { PoolClient } from 'pg';
import type { Chain } from '@swat/shared';
import type { CopyExecutionRecord } from './copy-trade-lifecycle.js';

/** Decimal wire quantities must not pass through Number for identity or sizing. */
export function assertExactExitQuantity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 256 || !/^\d+(?:\.\d+)?$/.test(value) || !/[1-9]/.test(value)) {
    throw new Error('Lot exit requires a positive exact decimal quantity');
  }
}

function normalizedQuantity(value: string): string {
  assertExactExitQuantity(value);
  const [whole, fraction = ''] = value.split('.');
  const integer = whole!.replace(/^0+(?=\d)/, '');
  const tail = fraction.replace(/0+$/, '');
  return tail ? `${integer}.${tail}` : integer;
}

export interface LotExitJobIdentity {
  readonly userId: string | null;
  readonly signalId: string;
  readonly exitLotId: string;
  readonly chain: Chain;
  readonly tokenMint: string;
  readonly masterWalletAddress: string;
  readonly targetAccount: string;
  readonly acquisitionExecutionMode: CopyExecutionRecord['executionMode'];
  readonly requestedBaseQuantity: string;
}

export function assertLotExitJobIdentity(identity: LotExitJobIdentity): void {
  assertExactExitQuantity(identity.requestedBaseQuantity);
  if (identity.userId !== null && (typeof identity.userId !== 'string' || !identity.userId.trim())) {
    throw new Error('Lot exit requires an explicit owning tenant or null operator');
  }
  if (!['paper', 'shadow', 'live'].includes(identity.acquisitionExecutionMode)
      || !['solana', 'polygon', 'robinhood-chain'].includes(identity.chain)) {
    throw new Error('Lot exit acquisition mode/chain is unavailable');
  }
  for (const value of [identity.signalId, identity.exitLotId, identity.tokenMint,
    identity.masterWalletAddress, identity.targetAccount]) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) {
      throw new Error('Lot exit requires complete immutable lot/master/account identity');
    }
  }
  if ([identity.tokenMint, identity.masterWalletAddress, identity.targetAccount]
    .some(value => !value.startsWith(`${identity.chain}:`))) {
    throw new Error('Lot exit account/master/token chain mismatch');
  }
}

/** Master ownership is checked by the DB lot join; CopyExecutionRecord has no master field. */
export function assertLotExitExecutionMatches(
  execution: CopyExecutionRecord,
  identity: LotExitJobIdentity,
  trigger: NonNullable<CopyExecutionRecord['exitTrigger']>
): void {
  assertLotExitJobIdentity(identity);
  if (execution.userId !== identity.userId || execution.signalId !== identity.signalId
      || execution.exitLotId !== identity.exitLotId || execution.exitTrigger !== trigger
      || execution.chain !== identity.chain || execution.tokenMint !== identity.tokenMint
      || execution.targetAccount !== identity.targetAccount
      || execution.executionMode !== identity.acquisitionExecutionMode
      || execution.direction !== 'sell' || execution.sourceTradeId !== null
      || execution.sourceSellFraction !== null || execution.sourcePositionBeforeQuantity !== null
      || execution.requestedBaseQuantity === null
      || normalizedQuantity(execution.requestedBaseQuantity) !== normalizedQuantity(identity.requestedBaseQuantity)) {
    throw new Error('Lot exit execution does not match immutable job identity/quantity/mode');
  }
}

export interface MasterSellAvailabilityInput {
  readonly targetAccount: string;
  readonly userId: string | null;
  readonly chain: Chain;
  readonly tokenMint: string;
  readonly masterWalletAddress: string;
  readonly executionMode: CopyExecutionRecord['executionMode'];
  readonly requestedBaseQuantity?: string;
  readonly sourceSellFraction?: string;
  readonly exitLotId?: string;
}

/**
 * Caller owns the existing PoolClient transaction. Check an idempotent existing
 * execution first; insert its reservation BEFORE committing this transaction.
 * No schema exists for source-to-lot reservation allocations: source vs explicit
 * exits on the same master are conservatively mutually exclusive. Other masters
 * remain isolated. This is availability under locks, not a standalone reservation.
 */
export async function getMasterSellAvailabilityWithClient(
  client: PoolClient,
  input: MasterSellAvailabilityInput
): Promise<{ quantity: string | null; reason: string | null }> {
  if (input.userId !== null && (typeof input.userId !== 'string' || !input.userId.trim())) {
    throw new Error('Master sell requires explicit tenant or null operator');
  }
  if (!['paper', 'shadow', 'live'].includes(input.executionMode)
      || !['solana', 'polygon', 'robinhood-chain'].includes(input.chain)
      || [input.targetAccount, input.tokenMint, input.masterWalletAddress].some(value =>
        typeof value !== 'string' || !value.startsWith(`${input.chain}:`) || value.includes('\u0000'))) {
    throw new Error('Master sell requires matching account/master/token/mode scope');
  }
  if (input.requestedBaseQuantity !== undefined) assertExactExitQuantity(input.requestedBaseQuantity);
  if (input.sourceSellFraction !== undefined) {
    assertExactExitQuantity(input.sourceSellFraction);
    const fraction = normalizedQuantity(input.sourceSellFraction);
    const [whole, decimalPart = ''] = fraction.split('.');
    if (whole !== '0' && (whole !== '1' || decimalPart !== '')) {
      throw new Error('Source sell fraction exceeds one');
    }
  }
  if (input.exitLotId !== undefined && (!input.exitLotId.trim() || input.sourceSellFraction !== undefined)) {
    throw new Error('Explicit lot exit cannot carry a source sell fraction');
  }
  if (input.requestedBaseQuantity === undefined && input.sourceSellFraction === undefined && input.exitLotId === undefined) {
    throw new Error('Master sell requires exact requested quantity or source sell fraction');
  }
  const scope = [input.targetAccount, input.chain, input.tokenMint, input.userId];
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(scope)]);
  const position = await client.query<{ id: string }>(
    `SELECT id FROM copy_positions
      WHERE target_account = $1 AND chain = $2 AND token_mint = $3
        AND user_id IS NOT DISTINCT FROM $4 FOR UPDATE`, scope
  );
  const positionId = position.rows[0]?.id;
  if (!positionId) return { quantity: null, reason: 'No attributable open master lot inventory' };
  const held = await client.query(
    `SELECT lot.id FROM copy_position_master_lots lot
      WHERE lot.position_id = $1 AND lot.user_id IS NOT DISTINCT FROM $2
        AND lot.master_wallet_address = $3 AND lot.chain = $4 AND lot.token_mint = $5
      ORDER BY lot.acquired_at, lot.id FOR UPDATE OF lot`,
    [positionId, input.userId, input.masterWalletAddress, input.chain, input.tokenMint]
  );
  if (held.rows.length === 0) return { quantity: null, reason: 'No attributable open master lot inventory' };
  const result = await client.query<{ quantity: string | null; reason: string | null }>(
    `WITH lots AS (
       SELECT lot.id, lot.remaining_quantity, acquisition.execution_mode,
              (acquisition.id IS NOT NULL AND source.id IS NOT NULL
                AND evidence.id IS NOT NULL AND application.evidence_id IS NOT NULL) AS trusted
       FROM copy_position_master_lots lot
       LEFT JOIN copy_executions acquisition ON acquisition.id = lot.acquisition_execution_id
         AND acquisition.user_id IS NOT DISTINCT FROM lot.user_id
         AND acquisition.target_account = $1 AND acquisition.chain = $2
         AND acquisition.token_mint = $3 AND acquisition.direction = 'buy'
         AND acquisition.signal_id IS NOT DISTINCT FROM lot.signal_id
         AND acquisition.source_trade_id = lot.source_trade_id
       LEFT JOIN copy_execution_evidence evidence ON evidence.id = lot.acquisition_evidence_id
         AND evidence.execution_id = acquisition.id
         AND evidence.confirmation_state IN ('confirmed', 'finalized')
       LEFT JOIN copy_position_applications application ON application.evidence_id = evidence.id
         AND application.execution_id = acquisition.id AND application.active
         AND application.position_id = lot.position_id
         AND application.user_id IS NOT DISTINCT FROM lot.user_id
         AND application.target_account = acquisition.target_account
         AND application.chain = lot.chain AND application.token_mint = lot.token_mint
       LEFT JOIN source_trades source ON source.id = lot.source_trade_id
         AND source.wallet_address = lot.master_wallet_address
         AND source.chain = lot.chain AND source.token_mint = lot.token_mint AND source.direction = 'buy'
       WHERE lot.position_id = $10 AND lot.user_id IS NOT DISTINCT FROM $4
         AND lot.master_wallet_address = $5 AND lot.chain = $2 AND lot.token_mint = $3
         AND lot.remaining_quantity > 0
     ), pending AS (
       SELECT execution.reserved_base_quantity, execution.exit_lot_id,
              CASE WHEN execution.exit_lot_id IS NOT NULL AND execution.source_trade_id IS NULL
                     AND exit_acquisition.id IS NOT NULL AND exit_source.id IS NOT NULL
                     AND exit_acquisition.execution_mode = execution.execution_mode
                     AND execution.signal_id IS NOT DISTINCT FROM exit_lot.signal_id
                     AND execution.source_sell_fraction IS NULL AND execution.source_position_before_quantity IS NULL
                   THEN exit_lot.master_wallet_address
                   WHEN execution.exit_lot_id IS NULL AND execution.source_trade_id IS NOT NULL
                     AND execution.exit_trigger IS NULL THEN source.wallet_address
                   ELSE NULL END AS master,
              execution.execution_mode
       FROM copy_executions execution
       LEFT JOIN source_trades source ON source.id = execution.source_trade_id
         AND source.chain = $2 AND source.token_mint = $3 AND source.direction = 'sell'
       LEFT JOIN copy_position_master_lots exit_lot ON exit_lot.id = execution.exit_lot_id
         AND exit_lot.position_id = $10 AND exit_lot.user_id IS NOT DISTINCT FROM $4
         AND exit_lot.chain = $2 AND exit_lot.token_mint = $3
       LEFT JOIN copy_executions exit_acquisition ON exit_acquisition.id = exit_lot.acquisition_execution_id
         AND exit_acquisition.user_id IS NOT DISTINCT FROM $4
         AND exit_acquisition.target_account = $1 AND exit_acquisition.chain = $2
         AND exit_acquisition.token_mint = $3 AND exit_acquisition.direction = 'buy'
         AND exit_acquisition.source_trade_id = exit_lot.source_trade_id
         AND exit_acquisition.signal_id IS NOT DISTINCT FROM exit_lot.signal_id
       LEFT JOIN source_trades exit_source ON exit_source.id = exit_lot.source_trade_id
         AND exit_source.chain = $2 AND exit_source.token_mint = $3 AND exit_source.direction = 'buy'
         AND exit_source.wallet_address = exit_lot.master_wallet_address
       WHERE execution.target_account = $1 AND execution.chain = $2 AND execution.token_mint = $3
         AND execution.user_id IS NOT DISTINCT FROM $4 AND execution.direction = 'sell'
         AND (execution.reserved_base_quantity > 0
           OR execution.state NOT IN ('failed', 'cancelled', 'confirmed'))
     ), availability AS (
       SELECT
         COALESCE((SELECT SUM(remaining_quantity) FROM lots WHERE execution_mode = $6), 0) AS owned,
         COALESCE((SELECT SUM(reserved_base_quantity) FROM pending WHERE master = $5), 0) AS master_pending,
         GREATEST(0, position.confirmed_quantity - GREATEST(position.reserved_sell_quantity,
           COALESCE((SELECT SUM(reserved_base_quantity) FROM pending), 0))) AS aggregate_available,
         (SELECT remaining_quantity FROM lots WHERE id = $9::uuid AND execution_mode = $6) AS lot_quantity,
         EXISTS (SELECT 1 FROM lots WHERE NOT trusted OR execution_mode IS NULL
           OR execution_mode NOT IN ('paper', 'shadow', 'live')) AS untrusted_lots,
         EXISTS (SELECT 1 FROM pending WHERE master IS NULL) AS unscoped_pending,
         EXISTS (SELECT 1 FROM pending WHERE master = $5 AND execution_mode IS DISTINCT FROM $6) AS mixed_pending,
         EXISTS (SELECT 1 FROM lots WHERE execution_mode <> $6) AS mixed_lots,
         EXISTS (SELECT 1 FROM pending WHERE master = $5 AND
           (($9::uuid IS NULL AND exit_lot_id IS NOT NULL)
             OR ($9::uuid IS NOT NULL AND exit_lot_id IS NULL)
             OR exit_lot_id = $9::uuid)) AS overlapping_exit
       FROM copy_positions position WHERE position.id = $10
     ), decision AS (
       SELECT *, CASE
         WHEN untrusted_lots THEN 'Master lot acquisition provenance is unavailable'
         WHEN unscoped_pending THEN 'Unattributed pending sell blocks reservation'
         WHEN mixed_pending OR mixed_lots THEN 'Incompatible acquisition mode blocks reservation'
         WHEN overlapping_exit THEN 'Overlapping source or explicit master exit is reserved'
         WHEN owned <= 0 OR ($9::uuid IS NOT NULL AND lot_quantity IS NULL) THEN 'No attributable open master lot inventory'
         WHEN aggregate_available <= 0 OR owned - master_pending <= 0 THEN 'No unreserved master inventory is available'
         WHEN $9::uuid IS NOT NULL AND COALESCE($7::numeric, lot_quantity)
           > LEAST(lot_quantity, aggregate_available, owned - master_pending)
           THEN 'Exact lot exit exceeds unreserved lot inventory'
         ELSE NULL END AS reason
       FROM availability
     ) SELECT CASE WHEN reason IS NOT NULL THEN NULL
       WHEN $9::uuid IS NOT NULL THEN COALESCE($7::numeric, lot_quantity)::text
       ELSE LEAST(aggregate_available, GREATEST(0, owned - master_pending),
         COALESCE($7::numeric, owned), owned * COALESCE($8::numeric, 1))::text
       END AS quantity, reason FROM decision`,
    [...scope, input.masterWalletAddress, input.executionMode,
      input.requestedBaseQuantity ?? null, input.sourceSellFraction ?? null, input.exitLotId ?? null, positionId]
  );
  const row = result.rows[0];
  if (!row?.quantity) return { quantity: null, reason: row?.reason ?? 'Master inventory availability is unknown' };
  assertExactExitQuantity(row.quantity);
  return row;
}

export type PositionLot = {
  readonly id: string;
  readonly masterWalletAddress: string;
  readonly remainingQuantity: number;
  readonly remainingCostBasisUsd: number | null;
  readonly acquiredAt: Date;
};

export type LotReduction = {
  readonly lotId: string;
  readonly quantity: number;
  readonly costBasisUsd: number | null;
};

export type LotAllocationResult = {
  readonly reductions: readonly LotReduction[];
  readonly unmatchedQuantity: number;
};

/**
 * Allocate one source master's sell across that master's open lots in FIFO order.
 * The caller must pass only lots belonging to the same tenant/token position; this
 * function still checks the master key so a query bug cannot silently borrow inventory.
 */
export function allocateLotsForMasterSell(input: {
  readonly masterWalletAddress: string;
  readonly quantity: number;
  readonly lots: readonly PositionLot[];
}): LotAllocationResult {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new Error('sell quantity must be a positive finite number');
  }

  const ordered = [...input.lots].sort((left, right) => {
    const byTime = left.acquiredAt.getTime() - right.acquiredAt.getTime();
    return byTime || left.id.localeCompare(right.id);
  });
  let remaining = input.quantity;
  const reductions: LotReduction[] = [];

  for (const lot of ordered) {
    if (lot.masterWalletAddress !== input.masterWalletAddress) {
      throw new Error(`lot ${lot.id} belongs to a different master`);
    }
    if (!Number.isFinite(lot.remainingQuantity) || lot.remainingQuantity < 0) {
      throw new Error(`lot ${lot.id} has an invalid remaining quantity`);
    }
    if (remaining <= 0) break;
    const quantity = Math.min(remaining, lot.remainingQuantity);
    if (quantity <= 0) continue;
    const ratio = lot.remainingQuantity > 0 ? quantity / lot.remainingQuantity : 0;
    reductions.push({
      lotId: lot.id,
      quantity,
      costBasisUsd: lot.remainingCostBasisUsd === null
        ? null
        : lot.remainingCostBasisUsd * ratio
    });
    remaining -= quantity;
  }

  return {
    reductions,
    unmatchedQuantity: Math.max(0, remaining)
  };
}

export function assertLotAllocationComplete(result: LotAllocationResult): void {
  if (!Number.isFinite(result.unmatchedQuantity) || result.unmatchedQuantity > 0) {
    throw new Error(
      `sell exceeds the master's open lot inventory by ${result.unmatchedQuantity}`
    );
  }
}
