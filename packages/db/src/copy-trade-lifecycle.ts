import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  canTransitionCopyExecution,
  canTransitionSourceConfirmation,
  isAppliedSourceConfirmation,
  resolveChainAddress,
  resolveChainValue,
  type Chain,
  type CopyExecutionMode,
  type CopyExecutionState,
  type SourceConfirmationState,
  type SourceTradeSide
} from '@swat/shared';
import { query } from './client.js';
import {
  summarizeConfirmedQuoteTotal,
  valuateQuoteLeg,
  type ConfirmedQuoteTotal,
  type QuoteCurrency,
  type QuoteLegInput,
  type QuoteLegValuation
} from './quote-valuation.js';
import { withTransaction } from './transaction.js';
import {
  allocateLotsForMasterSell,
  assertLotAllocationComplete,
  type PositionLot
} from './lot-allocation.js';

export type DecimalInput = string | number;
export type SourceEventType = 'transaction' | 'order' | 'venue_trade';
export type ExecutionEvidenceType =
  | 'chain_receipt'
  | 'venue_fill'
  | 'balance_reconciliation'
  | 'paper_simulation';

export interface SourceTradeEventInput {
  chain: Chain;
  sourceEventType: SourceEventType;
  sourceEventId: string;
  sourceEventIndex?: string;
  transactionHash?: string | null;
  walletAddress: string;
  tokenMint: string;
  side: SourceTradeSide;
  quantity: DecimalInput;
  amountUsd?: DecimalInput | null;
  priceUsd?: DecimalInput | null;
  feeUsd?: DecimalInput | null;
  eventAt: Date;
  observedAt?: Date;
  confirmationState: SourceConfirmationState;
  confirmationEvidenceId: string;
}

export interface CanonicalSourceTrade {
  id: string;
  chain: Chain;
  sourceEventType: SourceEventType;
  sourceEventId: string;
  sourceEventIndex: string;
  transactionHash: string | null;
  walletAddress: string;
  tokenMint: string;
  side: SourceTradeSide;
  quantity: string;
  amountUsd: string | null;
  priceUsd: string | null;
  feeUsd?: string | null;
  eventAt: Date;
  observedAt: Date;
  confirmationState: SourceConfirmationState;
}

export interface PositionRecord {
  walletAddress: string;
  chain: Chain;
  tokenMint: string;
  confirmedQuantity: string;
  costBasisUsd: string;
  totalAcquiredQuantity: string;
  totalReducedQuantity: string;
  unmatchedReductionQuantity: string;
  lastEventAt: Date | null;
}

export interface CopyExecutionRecord {
  id: string;
  signalId: string | null;
  sourceTradeId: string | null;
  exitLotId?: string | null;
  exitTrigger?: 'close-all' | 'stop-loss' | 'manual' | 'redemption' | null;
  chain: Chain;
  targetAccount: string;
  /**
   * Owning tenant, or `null` for the pre-multi-tenant operator account.
   *
   * This is the dimension that separates two users in paper mode, where they
   * share one synthetic `targetAccount` per chain (S4-10, migration 050).
   */
  userId: string | null;
  tokenMint: string;
  direction: 'buy' | 'sell';
  executionMode: CopyExecutionMode;
  clientOrderId: string;
  state: CopyExecutionState;
  requestedBaseQuantity: string | null;
  requestedQuoteQuantity: string | null;
  confirmedBaseQuantity: string;
  /**
   * USD sum over confirmed fills whose USD value is known.
   *
   * `null` means *unknown*: at least one confirmed fill exists and none of them
   * carries a USD value. `'0'` means a genuine zero. Read alongside
   * {@link quoteUnassessedFillCount} before treating this as a settled total —
   * see migration 054 and `quote-valuation.ts` (S4-M35).
   */
  confirmedQuoteQuantity: string | null;
  /** Confirmed fills omitted from `confirmedQuoteQuantity` because their USD value is unknown. */
  quoteUnassessedFillCount: number;
  reservedBaseQuantity: string;
  submissionAttempts: number;
  maxSubmissionAttempts: number;
  simulationId: string | null;
  submissionType: 'transaction' | 'order' | null;
  submissionId: string | null;
  nextReconciliationAt: Date | null;
  reconciliationClaimId: string | null;
  reconciliationAttempts: number;
  maxReconciliationAttempts: number;
  sourcePositionBeforeQuantity: string | null;
  sourceSellFraction: string | null;
}

export interface SourceTradeSignalCandidate {
  sourceTradeId: string;
  chain: Chain;
  walletAddress: string;
  tokenMint: string;
  side: 'buy' | 'sell';
  quantity: string;
  amountUsd: string | null;
  priceUsd: string | null;
  feeUsd?: string | null;
  eventAt: Date;
  walletScore: number;
  walletTier: string | null;
  clusterId: string | null;
  clusterConfidence: number;
}

export interface CopyPositionRecord {
  /** Surrogate key added by migration 050; the natural key is no longer unique. */
  id: string;
  targetAccount: string;
  chain: Chain;
  tokenMint: string;
  /** Owning tenant, or `null` for the pre-multi-tenant operator account. */
  userId: string | null;
  confirmedQuantity: string;
  reservedSellQuantity: string;
  costBasisUsd: string;
  /**
   * Applied buy fills that contributed nothing to `costBasisUsd` because neither a
   * USD quote value nor a USD price was recorded for them.
   *
   * Non-zero means `costBasisUsd` is a lower bound, not the whole basis. Present so
   * a caller cannot read the number without also seeing what it omits (S4-M35).
   */
  costBasisUnvaluedFillCount: number;
  totalAcquiredQuantity: string;
  totalReducedQuantity: string;
  unmatchedReductionQuantity: string;
  lastEvidenceAt: Date | null;
}

type SourceTradeDbRow = QueryResultRow & {
  id: string;
  chain: Chain;
  source_event_type: SourceEventType;
  source_event_id: string;
  source_event_index: string;
  transaction_hash: string | null;
  wallet_address: string;
  token_mint: string;
  direction: SourceTradeSide;
  quantity: string;
  amount_usd: string | null;
  price_usd: string | null;
  fee_usd?: string | null;
  event_at: Date;
  observed_at: Date;
  confirmation_state: SourceConfirmationState;
  payload_matches?: boolean;
};

type CopyExecutionDbRow = QueryResultRow & {
  id: string;
  signal_id: string | null;
  source_trade_id: string | null;
  exit_lot_id: string | null;
  exit_trigger: 'close-all' | 'stop-loss' | 'manual' | 'redemption' | null;
  chain: Chain;
  target_account: string;
  user_id: string | null;
  token_mint: string;
  direction: 'buy' | 'sell';
  execution_mode: CopyExecutionMode;
  client_order_id: string;
  state: CopyExecutionState;
  requested_base_quantity: string | null;
  requested_quote_quantity: string | null;
  confirmed_base_quantity: string;
  confirmed_quote_quantity: string | null;
  quote_unassessed_fill_count: number;
  reserved_base_quantity: string;
  submission_attempts: number;
  max_submission_attempts: number;
  simulation_id: string | null;
  submission_type: 'transaction' | 'order' | null;
  submission_id: string | null;
  next_reconciliation_at: Date | null;
  reconciliation_claim_id: string | null;
  reconciliation_attempts: number;
  max_reconciliation_attempts: number;
  source_position_before_quantity: string | null;
  source_sell_fraction: string | null;
  payload_matches?: boolean;
};

const SOURCE_TRADE_COLUMNS = `
  id,
  chain,
  source_event_type,
  source_event_id,
  source_event_index,
  transaction_hash,
  wallet_address,
  token_mint,
  direction,
  token_amount::text AS quantity,
  amount_usd::text AS amount_usd,
  price_usd::text AS price_usd,
  fee_usd::text AS fee_usd,
  event_at,
  observed_at,
  confirmation_state`;

const COPY_EXECUTION_COLUMNS = `
  id,
  signal_id,
  source_trade_id,
  exit_lot_id,
  exit_trigger,
  chain,
  target_account,
  user_id,
  token_mint,
  direction,
  execution_mode,
  client_order_id,
  state,
  requested_base_quantity::text AS requested_base_quantity,
  requested_quote_quantity::text AS requested_quote_quantity,
  confirmed_base_quantity::text AS confirmed_base_quantity,
  confirmed_quote_quantity::text AS confirmed_quote_quantity,
  quote_unassessed_fill_count,
  reserved_base_quantity::text AS reserved_base_quantity,
  submission_attempts,
  max_submission_attempts,
  simulation_id,
  submission_type,
  submission_id,
  next_reconciliation_at,
  reconciliation_claim_id,
  reconciliation_attempts,
  max_reconciliation_attempts,
  source_position_before_quantity::text AS source_position_before_quantity,
  source_sell_fraction::text AS source_sell_fraction`;

function assertIdentifier(name: string, value: string, maximumLength = 256): string {
  if (!value || value.trim() !== value || value.length > maximumLength) {
    throw new Error(`${name} must be non-empty, trimmed, and at most ${maximumLength} characters`);
  }
  return value;
}

function assertDate(name: string, value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${name} must be a valid date`);
  }
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Field separator used when hashing a tuple into a stable identity string.
 *
 * MUST stay equal to the separator `buildCopyExecutionClientOrderId` passes to
 * `Array.prototype.join`, or the tenant-scoped digest stops matching the
 * unscoped one for the same tuple. NUL is safe as a separator because no field
 * being joined can contain it: `assertIdentifier` rejects untrimmed input, and
 * the values are UUIDs, chain names, addresses and a fixed mode enum.
 */
const COPY_IDENTITY_SEPARATOR = String.fromCharCode(0);

/**
 * Normalise an acting tenant id to either a canonical UUID or `null`.
 *
 * `null` is a real, load-bearing value here, not a missing one: migration 050
 * gives every legacy operator row `user_id NULL`, and the tenancy-aware unique
 * indexes are declared `NULLS NOT DISTINCT` so those rows still collide with
 * each other. That means a caller that has no user in scope MUST reach `null`
 * and not some placeholder string — a placeholder would be a distinct tenant
 * and would silently fork the operator's position ledger.
 *
 * `users.id` is a UUID (039_users.sql:22), so anything that is not
 * UUID-shaped is a bug in the caller rather than a tenant we have never seen.
 * Rejecting it here keeps a stray account label (`'operator'`, an email, a
 * chain-prefixed address) from being written into the tenancy column, where it
 * would fail the foreign key at a confusing distance from its origin.
 */
export function normalizeTenantId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!UUID_PATTERN.test(trimmed)) {
    throw new Error(`userId must be a UUID or null, received ${JSON.stringify(value)}`);
  }
  return trimmed.toLowerCase();
}

function decimal(name: string, value: DecimalInput, allowZero = false): string {
  const normalized = typeof value === 'number' ? String(value) : value;
  if (
    !normalized
    || normalized.trim() !== normalized
    || !/^(?:\d+\.?\d*|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)
  ) {
    throw new Error(`${name} must be an unsigned decimal`);
  }
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric) || (allowZero ? numeric < 0 : numeric <= 0)) {
    throw new Error(`${name} must be ${allowZero ? 'non-negative' : 'positive'}`);
  }
  return normalized;
}

function optionalDecimal(name: string, value: DecimalInput | null | undefined): string | null {
  return value === null || value === undefined ? null : decimal(name, value, true);
}

function mapSourceTrade(row: SourceTradeDbRow): CanonicalSourceTrade {
  return {
    id: row.id,
    chain: row.chain,
    sourceEventType: row.source_event_type,
    sourceEventId: row.source_event_id,
    sourceEventIndex: row.source_event_index,
    transactionHash: row.transaction_hash,
    walletAddress: row.wallet_address,
    tokenMint: row.token_mint,
    side: row.direction,
    quantity: row.quantity,
    amountUsd: row.amount_usd,
    priceUsd: row.price_usd,
    feeUsd: row.fee_usd ?? null,
    eventAt: row.event_at,
    observedAt: row.observed_at,
    confirmationState: row.confirmation_state
  };
}

function mapCopyExecution(row: CopyExecutionDbRow): CopyExecutionRecord {
  return {
    id: row.id,
    signalId: row.signal_id,
    sourceTradeId: row.source_trade_id,
    exitLotId: row.exit_lot_id ?? null,
    exitTrigger: row.exit_trigger ?? null,
    chain: row.chain,
    targetAccount: row.target_account,
    userId: row.user_id ?? null,
    tokenMint: row.token_mint,
    direction: row.direction,
    executionMode: row.execution_mode,
    clientOrderId: row.client_order_id,
    state: row.state,
    requestedBaseQuantity: row.requested_base_quantity,
    requestedQuoteQuantity: row.requested_quote_quantity,
    confirmedBaseQuantity: row.confirmed_base_quantity,
    confirmedQuoteQuantity: row.confirmed_quote_quantity,
    quoteUnassessedFillCount: Number(row.quote_unassessed_fill_count ?? 0),
    reservedBaseQuantity: row.reserved_base_quantity,
    submissionAttempts: Number(row.submission_attempts),
    maxSubmissionAttempts: Number(row.max_submission_attempts),
    simulationId: row.simulation_id,
    submissionType: row.submission_type,
    submissionId: row.submission_id,
    nextReconciliationAt: row.next_reconciliation_at,
    reconciliationClaimId: row.reconciliation_claim_id,
    reconciliationAttempts: Number(row.reconciliation_attempts),
    maxReconciliationAttempts: Number(row.max_reconciliation_attempts),
    sourcePositionBeforeQuantity: row.source_position_before_quantity,
    sourceSellFraction: row.source_sell_fraction
  };
}

async function inTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(operation);
}

function isStaleConfirmation(
  current: SourceConfirmationState,
  proposed: SourceConfirmationState
): boolean {
  if (current === 'reversed') return proposed !== 'reversed';
  if (current === 'finalized') return proposed === 'observed' || proposed === 'confirmed';
  return current === 'confirmed' && proposed === 'observed';
}

async function ensureSourcePosition(client: PoolClient, source: SourceTradeDbRow): Promise<void> {
  await client.query(
    `INSERT INTO wallet_positions (wallet_address, chain, token_mint)
     VALUES ($1, $2, $3)
     ON CONFLICT (wallet_address, chain, token_mint) DO NOTHING`,
    [source.wallet_address, source.chain, source.token_mint]
  );
  await client.query(
    `SELECT wallet_address
       FROM wallet_positions
      WHERE wallet_address = $1 AND chain = $2 AND token_mint = $3
      FOR UPDATE`,
    [source.wallet_address, source.chain, source.token_mint]
  );
}

async function rebuildSourcePosition(
  client: PoolClient,
  source: SourceTradeDbRow
): Promise<PositionRecord> {
  const result = await client.query<QueryResultRow & {
    wallet_address: string;
    chain: Chain;
    token_mint: string;
    confirmed_quantity: string;
    cost_basis_usd: string;
    total_acquired_quantity: string;
    total_reduced_quantity: string;
    unmatched_reduction_quantity: string;
    last_event_at: Date | null;
  }>(
    `WITH RECURSIVE ordered_events AS (
       SELECT
         ROW_NUMBER() OVER (ORDER BY st.event_at, st.id)::bigint AS sequence,
         st.direction,
         st.token_amount,
         st.amount_usd,
         st.price_usd,
         st.event_at
       FROM source_position_applications spa
       JOIN source_trades st ON st.id = spa.source_trade_id
       WHERE spa.wallet_address = $1
         AND spa.chain = $2
         AND spa.token_mint = $3
         AND spa.active
     ), ledger AS (
       SELECT
         0::bigint AS sequence,
         wp.opening_balance AS quantity,
         wp.opening_cost_basis_usd AS cost_basis,
         0::numeric AS acquired,
         0::numeric AS reduced,
         0::numeric AS unmatched
       FROM wallet_positions wp
       WHERE wp.wallet_address = $1 AND wp.chain = $2 AND wp.token_mint = $3

       UNION ALL

       SELECT
         event.sequence,
         CASE
           WHEN event.direction IN ('buy', 'transfer_in') THEN ledger.quantity + event.token_amount
           ELSE GREATEST(0, ledger.quantity - event.token_amount)
         END,
         CASE
           WHEN event.direction IN ('buy', 'transfer_in') THEN
             ledger.cost_basis + COALESCE(event.amount_usd, event.token_amount * event.price_usd, 0)
           WHEN ledger.quantity = 0 THEN 0
           ELSE GREATEST(
             0,
             ledger.cost_basis - (ledger.cost_basis / ledger.quantity) * LEAST(ledger.quantity, event.token_amount)
           )
         END,
         ledger.acquired + CASE WHEN event.direction IN ('buy', 'transfer_in') THEN event.token_amount ELSE 0 END,
         ledger.reduced + CASE WHEN event.direction IN ('sell', 'transfer_out') THEN event.token_amount ELSE 0 END,
         ledger.unmatched + CASE
           WHEN event.direction IN ('sell', 'transfer_out') THEN GREATEST(0, event.token_amount - ledger.quantity)
           ELSE 0
         END
       FROM ledger
       JOIN ordered_events event ON event.sequence = ledger.sequence + 1
     ), final AS (
       SELECT * FROM ledger ORDER BY sequence DESC LIMIT 1
     ), last_event AS (
       SELECT MAX(event_at) AS event_at FROM ordered_events
     )
     UPDATE wallet_positions position
        SET balance = final.quantity,
            cost_basis_usd = final.cost_basis,
            total_acquired_quantity = final.acquired,
            total_reduced_quantity = final.reduced,
            unmatched_reduction_quantity = final.unmatched,
            last_event_at = last_event.event_at,
            updated_at = NOW()
       FROM final, last_event
      WHERE position.wallet_address = $1
        AND position.chain = $2
        AND position.token_mint = $3
     RETURNING
       position.wallet_address,
       position.chain,
       position.token_mint,
       position.balance::text AS confirmed_quantity,
       position.cost_basis_usd::text AS cost_basis_usd,
       position.total_acquired_quantity::text AS total_acquired_quantity,
       position.total_reduced_quantity::text AS total_reduced_quantity,
       position.unmatched_reduction_quantity::text AS unmatched_reduction_quantity,
       position.last_event_at`,
    [source.wallet_address, source.chain, source.token_mint]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Source position rebuild did not return a row');
  return {
    walletAddress: row.wallet_address,
    chain: row.chain,
    tokenMint: row.token_mint,
    confirmedQuantity: row.confirmed_quantity,
    costBasisUsd: row.cost_basis_usd,
    totalAcquiredQuantity: row.total_acquired_quantity,
    totalReducedQuantity: row.total_reduced_quantity,
    unmatchedReductionQuantity: row.unmatched_reduction_quantity,
    lastEventAt: row.last_event_at
  };
}

async function applySourceConfirmation(
  client: PoolClient,
  source: SourceTradeDbRow,
  proposedState: SourceConfirmationState,
  evidenceId: string,
  evidenceObservedAt: Date
): Promise<{ source: SourceTradeDbRow; position: PositionRecord }> {
  let current = source;
  if (current.confirmation_state !== proposedState) {
    if (canTransitionSourceConfirmation(current.confirmation_state, proposedState)) {
      const updated = await client.query<SourceTradeDbRow>(
        `UPDATE source_trades
            SET confirmation_state = $2::text,
                status = $2::text,
                confirmation_updated_at = $3
          WHERE id = $1
        RETURNING ${SOURCE_TRADE_COLUMNS}`,
        [current.id, proposedState, evidenceObservedAt]
      );
      current = updated.rows[0] as SourceTradeDbRow;
    } else if (!isStaleConfirmation(current.confirmation_state, proposedState)) {
      throw new Error(
        `Invalid source confirmation transition: ${current.confirmation_state} -> ${proposedState}`
      );
    }
  }

  await client.query(
    `INSERT INTO source_trade_confirmation_history (
       source_trade_id, confirmation_state, evidence_id, observed_at
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_trade_id, confirmation_state, evidence_id) DO NOTHING`,
    [current.id, proposedState, evidenceId, evidenceObservedAt]
  );

  await ensureSourcePosition(client, current);
  await client.query(
    `INSERT INTO source_position_applications (
       source_trade_id, wallet_address, chain, token_mint, active
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_trade_id) DO UPDATE
       SET active = EXCLUDED.active,
           updated_at = NOW()`,
    [
      current.id,
      current.wallet_address,
      current.chain,
      current.token_mint,
      isAppliedSourceConfirmation(current.confirmation_state)
    ]
  );
  return { source: current, position: await rebuildSourcePosition(client, current) };
}

export async function recordSourceTradeEvent(input: SourceTradeEventInput): Promise<{
  event: CanonicalSourceTrade;
  position: PositionRecord;
  inserted: boolean;
}> {
  const wallet = resolveChainAddress(input.walletAddress, input.chain);
  const token = resolveChainValue(input.tokenMint, input.chain);
  const sourceEventId = assertIdentifier('sourceEventId', input.sourceEventId);
  const sourceEventIndex = assertIdentifier('sourceEventIndex', input.sourceEventIndex ?? '0', 128);
  const transactionHash = input.transactionHash
    ? assertIdentifier('transactionHash', input.transactionHash)
    : null;
  if (input.sourceEventType === 'transaction' && !transactionHash) {
    throw new Error('transactionHash is required for transaction source events');
  }
  if (input.sourceEventType === 'transaction' && transactionHash !== sourceEventId) {
    throw new Error('transaction sourceEventId must equal transactionHash');
  }
  const quantity = decimal('quantity', input.quantity);
  const amountUsd = optionalDecimal('amountUsd', input.amountUsd);
  const priceUsd = optionalDecimal('priceUsd', input.priceUsd);
  const feeUsd = optionalDecimal('feeUsd', input.feeUsd);
  const eventAt = assertDate('eventAt', input.eventAt);
  const observedAt = assertDate('observedAt', input.observedAt ?? new Date());
  const confirmationEvidenceId = assertIdentifier(
    'confirmationEvidenceId',
    input.confirmationEvidenceId
  );

  return inTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO source_trades (
         chain, transaction_hash, wallet_address, token_mint, direction,
         amount_usd, token_amount, price_usd, fee_usd, status, source_event_type,
         source_event_id, source_event_index, event_at, observed_at,
         confirmation_state, confirmation_updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10::text, $11,
         $12, $13, $14, $15, $10::text, $15
       )
       ON CONFLICT (chain, source_event_type, source_event_id, source_event_index) DO NOTHING
       RETURNING id`,
      [
        input.chain,
        transactionHash,
        wallet.prefixed,
        token.prefixed,
        input.side,
        amountUsd,
        quantity,
        priceUsd,
        feeUsd,
        input.confirmationState,
        input.sourceEventType,
        sourceEventId,
        sourceEventIndex,
        eventAt,
        observedAt
      ]
    );

    const selected = await client.query<SourceTradeDbRow>(
      `SELECT ${SOURCE_TRADE_COLUMNS},
              (
                transaction_hash IS NOT DISTINCT FROM $5
                AND wallet_address = $6
                AND token_mint = $7
                AND direction = $8
                AND token_amount = $9::numeric
                AND amount_usd IS NOT DISTINCT FROM $10::numeric
                AND price_usd IS NOT DISTINCT FROM $11::numeric
                AND event_at = $12
              ) AS payload_matches
         FROM source_trades
        WHERE chain = $1
          AND source_event_type = $2
          AND source_event_id = $3
          AND source_event_index = $4
        FOR UPDATE`,
      [
        input.chain,
        input.sourceEventType,
        sourceEventId,
        sourceEventIndex,
        transactionHash,
        wallet.prefixed,
        token.prefixed,
        input.side,
        quantity,
        amountUsd,
        priceUsd,
        eventAt
      ]
    );
    const source = selected.rows[0];
    if (!source) throw new Error('Source event insert did not return a row');
    if (!source.payload_matches) {
      throw new Error('Source event identity collision with a different immutable payload');
    }

    const applied = await applySourceConfirmation(
      client,
      source,
      input.confirmationState,
      confirmationEvidenceId,
      observedAt
    );
    return {
      event: mapSourceTrade(applied.source),
      position: applied.position,
      inserted: inserted.rowCount === 1
    };
  });
}

export async function advanceSourceTradeConfirmation(input: {
  sourceTradeId: string;
  confirmationState: SourceConfirmationState;
  evidenceId: string;
  observedAt?: Date;
}): Promise<{ event: CanonicalSourceTrade; position: PositionRecord }> {
  const sourceTradeId = assertIdentifier('sourceTradeId', input.sourceTradeId, 128);
  const evidenceId = assertIdentifier('evidenceId', input.evidenceId);
  const observedAt = assertDate('observedAt', input.observedAt ?? new Date());
  return inTransaction(async (client) => {
    const selected = await client.query<SourceTradeDbRow>(
      `SELECT ${SOURCE_TRADE_COLUMNS}
         FROM source_trades
        WHERE id = $1
        FOR UPDATE`,
      [sourceTradeId]
    );
    const source = selected.rows[0];
    if (!source) throw new Error(`Source trade ${sourceTradeId} does not exist`);
    const applied = await applySourceConfirmation(
      client,
      source,
      input.confirmationState,
      evidenceId,
      observedAt
    );
    return { event: mapSourceTrade(applied.source), position: applied.position };
  });
}

/**
 * The canonical source trade by id — the master's own event.
 *
 * Exists for the mirroring price bound (`S4-M16`): a copied order has to be
 * bounded against the price the *master* actually got, and `copy_executions.price_usd`
 * is **our** fill, not theirs. `source_trades.price_usd` is the master's, and this
 * is the only read that surfaces it to the executor.
 *
 * A plain read rather than one of the `FOR SHARE` lookups above, because the
 * caller is sizing a bound before submitting and is not mutating the row — taking
 * a row lock on the money path to read one price would serialise mirrors behind
 * each other for nothing. `price_usd` is nullable, and a null is returned as null
 * rather than defaulted: the mirror planner fails closed on an absent master
 * price, which is the whole point of not inventing one.
 */
export async function getCanonicalSourceTradeById(
  sourceTradeId: string
): Promise<CanonicalSourceTrade | null> {
  const rows = await query<SourceTradeDbRow>(
    `SELECT ${SOURCE_TRADE_COLUMNS}
       FROM source_trades
      WHERE id = $1`,
    [sourceTradeId]
  );
  return rows[0] ? mapSourceTrade(rows[0]) : null;
}

export async function getSourceTradeByIdentity(input: {
  chain: Chain;
  sourceEventType: SourceEventType;
  sourceEventId: string;
  sourceEventIndex?: string;
}): Promise<CanonicalSourceTrade | null> {
  const rows = await query<SourceTradeDbRow>(
    `SELECT ${SOURCE_TRADE_COLUMNS}
       FROM source_trades
      WHERE chain = $1
        AND source_event_type = $2
        AND source_event_id = $3
        AND source_event_index = $4`,
    [
      input.chain,
      input.sourceEventType,
      assertIdentifier('sourceEventId', input.sourceEventId),
      assertIdentifier('sourceEventIndex', input.sourceEventIndex ?? '0', 128)
    ]
  );
  return rows[0] ? mapSourceTrade(rows[0]) : null;
}

function boundedDuration(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function assertScore(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be between 0 and 100`);
  }
  return value;
}

export async function listSourceTradeSignalCandidates(input: {
  sourceTradeId?: string;
  maxEventAgeMs: number;
  limit?: number;
  now?: Date;
}): Promise<SourceTradeSignalCandidate[]> {
  const sourceTradeId = input.sourceTradeId
    ? assertIdentifier('sourceTradeId', input.sourceTradeId, 128)
    : null;
  const maxEventAgeMs = boundedDuration('maxEventAgeMs', input.maxEventAgeMs);
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('limit must be an integer between 1 and 1000');
  }
  const now = assertDate('now', input.now ?? new Date());
  const rows = await query<QueryResultRow & {
    source_trade_id: string;
    chain: Chain;
    wallet_address: string;
    token_mint: string;
    direction: 'buy' | 'sell';
    quantity: string;
    amount_usd: string | null;
    price_usd: string | null;
    event_at: Date;
    wallet_score: string;
    wallet_tier: string | null;
    cluster_id: string | null;
    cluster_confidence: string;
  }>(
    `SELECT
       source.id AS source_trade_id,
       source.chain,
       source.wallet_address,
       source.token_mint,
       source.direction,
       source.token_amount::text AS quantity,
       source.amount_usd::text AS amount_usd,
       source.price_usd::text AS price_usd,
       source.event_at,
       wallet.composite_score::text AS wallet_score,
       wallet.tier AS wallet_tier,
       selected_cluster.cluster_id,
       COALESCE(selected_cluster.confidence, wallet.composite_score / 100, 0)::text
         AS cluster_confidence
     FROM source_trades source
     JOIN wallets wallet
       ON wallet.address = source.wallet_address
      AND wallet.status = 'active'
      AND wallet.composite_score IS NOT NULL
     LEFT JOIN LATERAL (
       SELECT membership.cluster_id, cluster.confidence
       FROM cluster_memberships membership
       JOIN wallet_clusters cluster ON cluster.id = membership.cluster_id
       WHERE membership.wallet_address = source.wallet_address
       ORDER BY cluster.confidence DESC, membership.cluster_id
       LIMIT 1
     ) selected_cluster ON TRUE
     LEFT JOIN signals signal ON signal.source_trade_id = source.id
     WHERE source.confirmation_state IN ('confirmed', 'finalized')
       AND source.direction IN ('buy', 'sell')
       AND (
         signal.id IS NULL
         OR (signal.source_dispatched_at IS NULL AND signal.status IN ('eligible', 'alerted'))
       )
       AND ($1::uuid IS NULL OR source.id = $1)
       AND source.event_at >= $2::timestamptz - ($3::bigint * INTERVAL '1 millisecond')
       AND source.event_at <= $2::timestamptz + INTERVAL '30 seconds'
     ORDER BY source.event_at, source.id
     LIMIT $4`,
    [sourceTradeId, now, maxEventAgeMs, limit]
  );
  return rows.map((row) => ({
    sourceTradeId: row.source_trade_id,
    chain: row.chain,
    walletAddress: row.wallet_address,
    tokenMint: row.token_mint,
    side: row.direction,
    quantity: row.quantity,
    amountUsd: row.amount_usd,
    priceUsd: row.price_usd,
    feeUsd: row.fee_usd ?? null,
    eventAt: row.event_at,
    walletScore: Number(row.wallet_score),
    walletTier: row.wallet_tier,
    clusterId: row.cluster_id,
    clusterConfidence: Number(row.cluster_confidence)
  }));
}

export async function markSourceTradeSignalDispatched(signalId: string, dispatchedAt = new Date()): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE signals
     SET source_dispatched_at = COALESCE(source_dispatched_at, $2)
     WHERE id = $1 AND source_trade_id IS NOT NULL
     RETURNING id`,
    [assertIdentifier('signalId', signalId, 128), assertDate('dispatchedAt', dispatchedAt)]
  );
  return rows.length === 1;
}

type SourcePositionEvidence = {
  beforeQuantity: string;
  sourceQuantityFits: boolean;
  sellFraction: string;
  positionEvidenceAt: Date;
  lastEventAt: Date;
};

async function getSourcePositionEvidence(
  client: PoolClient,
  source: SourceTradeDbRow
): Promise<SourcePositionEvidence> {
  const result = await client.query<QueryResultRow & {
    before_quantity: string;
    source_quantity_fits: boolean;
    sell_fraction: string;
    position_evidence_at: Date;
    last_event_at: Date | null;
    source_is_active: boolean;
  }>(
    `WITH RECURSIVE position AS (
       SELECT opening_balance, updated_at, last_event_at
       FROM wallet_positions
       WHERE wallet_address = $1 AND chain = $2 AND token_mint = $3
     ), ordered_events AS (
       SELECT
         ROW_NUMBER() OVER (ORDER BY event.event_at, event.id)::bigint AS sequence,
         event.direction,
         event.token_amount
       FROM source_position_applications application
       JOIN source_trades event ON event.id = application.source_trade_id
       WHERE application.wallet_address = $1
         AND application.chain = $2
         AND application.token_mint = $3
         AND application.active
         AND (event.event_at, event.id) < ($4::timestamptz, $5::uuid)
     ), ledger AS (
       SELECT 0::bigint AS sequence, position.opening_balance AS quantity
       FROM position

       UNION ALL

       SELECT
         event.sequence,
         CASE
           WHEN event.direction IN ('buy', 'transfer_in') THEN ledger.quantity + event.token_amount
           ELSE GREATEST(0, ledger.quantity - event.token_amount)
         END
       FROM ledger
       JOIN ordered_events event ON event.sequence = ledger.sequence + 1
     ), before_event AS (
       SELECT quantity FROM ledger ORDER BY sequence DESC LIMIT 1
     )
     SELECT
       before_event.quantity::text AS before_quantity,
       ($6::numeric <= before_event.quantity) AS source_quantity_fits,
       LEAST(1, $6::numeric / NULLIF(before_event.quantity, 0))::text AS sell_fraction,
       position.updated_at AS position_evidence_at,
       position.last_event_at,
       EXISTS (
         SELECT 1 FROM source_position_applications
         WHERE source_trade_id = $5 AND active
       ) AS source_is_active
     FROM position, before_event`,
    [
      source.wallet_address,
      source.chain,
      source.token_mint,
      source.event_at,
      source.id,
      source.quantity
    ]
  );
  const row = result.rows[0];
  if (!row || !row.source_is_active || !row.last_event_at) {
    throw new Error('Source position evidence is missing');
  }
  if (Number(row.before_quantity) <= 0 || !row.source_quantity_fits) {
    throw new Error('Source sell exceeds the proven pre-event position');
  }
  if (row.last_event_at < source.event_at) {
    throw new Error('Source position evidence does not include the source event');
  }
  return {
    beforeQuantity: row.before_quantity,
    sourceQuantityFits: row.source_quantity_fits,
    sellFraction: row.sell_fraction,
    positionEvidenceAt: row.position_evidence_at,
    lastEventAt: row.last_event_at
  };
}

export async function insertSourceTradeSignal(input: {
  sourceTradeId: string;
  clusterId?: string | null;
  confidence: number;
  signalScore: number;
  triggerData: Record<string, unknown>;
  safetyFlags?: string[];
  safetyWarnings?: string[];
  tokenName?: string | null;
  tokenSymbol?: string | null;
  maxEventAgeMs: number;
  maxPositionEvidenceAgeMs: number;
  now?: Date;
}): Promise<{
  inserted: boolean;
  id: string;
  sourceTradeId: string;
  chain: Chain;
  tokenMint: string;
  direction: 'buy' | 'sell';
  sourcePositionBeforeQuantity: string | null;
  sourceSellFraction: string | null;
}> {
  const sourceTradeId = assertIdentifier('sourceTradeId', input.sourceTradeId, 128);
  const confidence = assertScore('confidence', input.confidence);
  const signalScore = assertScore('signalScore', input.signalScore);
  const maxEventAgeMs = boundedDuration('maxEventAgeMs', input.maxEventAgeMs);
  const maxPositionEvidenceAgeMs = boundedDuration(
    'maxPositionEvidenceAgeMs',
    input.maxPositionEvidenceAgeMs
  );
  const now = assertDate('now', input.now ?? new Date());

  return inTransaction(async (client) => {
    const sourceResult = await client.query<SourceTradeDbRow>(
      `SELECT ${SOURCE_TRADE_COLUMNS}
       FROM source_trades
       WHERE id = $1
       FOR SHARE`,
      [sourceTradeId]
    );
    const source = sourceResult.rows[0];
    if (!source) throw new Error(`Source trade ${sourceTradeId} does not exist`);
    if (!isAppliedSourceConfirmation(source.confirmation_state)) {
      throw new Error(`Source trade ${sourceTradeId} is not confirmed`);
    }
    if (source.direction !== 'buy' && source.direction !== 'sell') {
      throw new Error('Transfer source events cannot derive executable signals');
    }
    const sourceAge = now.getTime() - source.event_at.getTime();
    if (sourceAge > maxEventAgeMs || sourceAge < -30_000) {
      throw new Error(sourceAge > maxEventAgeMs ? 'Source event is stale' : 'Source event is in the future');
    }

    const sourcePosition = source.direction === 'sell'
      ? await getSourcePositionEvidence(client, source)
      : null;
    if (
      sourcePosition
      && now.getTime() - sourcePosition.positionEvidenceAt.getTime() > maxPositionEvidenceAgeMs
    ) {
      throw new Error('Source position evidence is stale');
    }

    const triggerData = {
      ...input.triggerData,
      sourceTradeId,
      sourceWallet: source.wallet_address,
      sourceEventType: source.source_event_type,
      sourceEventId: source.source_event_id,
      sourceEventIndex: source.source_event_index,
      sourceQuantity: source.quantity,
      sourceSide: source.direction,
      sourcePositionBeforeQuantity: sourcePosition?.beforeQuantity ?? null,
      sourceSellFraction: sourcePosition?.sellFraction ?? null
    };
    const inserted = await client.query<{
      id: string;
      source_trade_id: string;
      chain: Chain;
      token_mint: string;
      source_side: 'buy' | 'sell';
      source_position_before_quantity: string | null;
      source_sell_fraction: string | null;
    }>(
      `INSERT INTO signals (
         pattern_type, cluster_id, token_mint, chain, confidence, signal_score,
         trigger_data, safety_flags, safety_warnings, token_name, token_symbol,
         status, detected_at, expires_at, source_trade_id, source_side,
         source_position_before_quantity, source_position_evidence_at,
         source_sell_fraction
       ) VALUES (
         'source_trade', $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10,
         'eligible', $11::timestamptz,
         $11::timestamptz + ($12::bigint * INTERVAL '1 millisecond'),
         $13, $14, $15::numeric, $16, $17::numeric
       )
       ON CONFLICT (source_trade_id) WHERE source_trade_id IS NOT NULL DO NOTHING
       RETURNING
         id, source_trade_id, chain, token_mint, source_side,
         source_position_before_quantity::text AS source_position_before_quantity,
         source_sell_fraction::text AS source_sell_fraction`,
      [
        input.clusterId ?? null,
        source.token_mint,
        source.chain,
        confidence,
        signalScore,
        JSON.stringify(triggerData),
        input.safetyFlags ?? [],
        input.safetyWarnings ?? [],
        input.tokenName ?? null,
        input.tokenSymbol ?? null,
        now,
        maxEventAgeMs,
        sourceTradeId,
        source.direction,
        sourcePosition?.beforeQuantity ?? null,
        sourcePosition?.positionEvidenceAt ?? null,
        sourcePosition?.sellFraction ?? null
      ]
    );
    const row = inserted.rows[0] ?? (await client.query<{
      id: string;
      source_trade_id: string;
      chain: Chain;
      token_mint: string;
      source_side: 'buy' | 'sell';
      source_position_before_quantity: string | null;
      source_sell_fraction: string | null;
    }>(
      `SELECT
         id, source_trade_id, chain, token_mint, source_side,
         source_position_before_quantity::text AS source_position_before_quantity,
         source_sell_fraction::text AS source_sell_fraction
       FROM signals
       WHERE source_trade_id = $1`,
      [sourceTradeId]
    )).rows[0];
    if (!row) throw new Error('Source signal insert did not return a row');
    return {
      inserted: inserted.rowCount === 1,
      id: row.id,
      sourceTradeId: row.source_trade_id,
      chain: row.chain,
      tokenMint: row.token_mint,
      direction: row.source_side,
      sourcePositionBeforeQuantity: row.source_position_before_quantity,
      sourceSellFraction: row.source_sell_fraction
    };
  });
}

export function buildCopyExecutionClientOrderId(input: {
  sourceTradeId: string;
  chain: Chain;
  targetAccount: string;
  executionMode: CopyExecutionMode;
  /** Acting tenant; `null` for the pre-multi-tenant operator account. */
  userId?: string | null;
}): string {
  const parts = [
    assertIdentifier('sourceTradeId', input.sourceTradeId, 128),
    input.chain,
    assertIdentifier('targetAccount', input.targetAccount, 128),
    input.executionMode
  ].join('\u0000');
  const tenantId = normalizeTenantId(input.userId);
  // Appended only when a tenant is present, never for `null`. That is what
  // keeps the digest byte-identical to the pre-050 derivation for every
  // operator row: `client_order_id` is a stored, indexed identity that
  // in-flight executions are looked up by (`getCopyExecutionByClientOrderId`),
  // so unconditionally reserving a tenant slot in the hash input would re-hash
  // every existing row's identity and orphan every open execution on deploy.
  //
  // With a tenant present the digest differs per user, which is what keeps two
  // paper users off each other's `UNIQUE (chain, target_account,
  // client_order_id)` row while they share one synthetic target account.
  //
  // Appending to the joined string rather than pushing into the array above is
  // equivalent, because `COPY_IDENTITY_SEPARATOR` is the same separator that
  // join used.
  const identity = tenantId === null
    ? parts
    : parts + COPY_IDENTITY_SEPARATOR + tenantId;
  return `swat-${createHash('sha256').update(identity).digest('hex')}`;
}

/**
 * Create the tenant's position row if absent, lock it, and return its id.
 *
 * The `ON CONFLICT` target is the four-column `NULLS NOT DISTINCT` index from
 * migration 050. Including `user_id` is what makes two paper users sharing one
 * synthetic `targetAccount` resolve to two different rows; `NULLS NOT DISTINCT`
 * is what stops the operator's own `NULL` row being duplicated on every call.
 */
async function ensureCopyPosition(
  client: PoolClient,
  targetAccount: string,
  chain: Chain,
  tokenMint: string,
  userId: string | null
): Promise<string> {
  await client.query(
    `INSERT INTO copy_positions (target_account, chain, token_mint, user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (target_account, chain, token_mint, user_id) DO NOTHING`,
    [targetAccount, chain, tokenMint, userId]
  );
  const locked = await client.query<{ id: string }>(
    `SELECT id
       FROM copy_positions
      WHERE target_account = $1
        AND chain = $2
        AND token_mint = $3
        AND user_id IS NOT DISTINCT FROM $4
      FOR UPDATE`,
    [targetAccount, chain, tokenMint, userId]
  );
  const id = locked.rows[0]?.id;
  if (!id) throw new Error('Copy position ensure did not return a row');
  return id;
}

/**
 * Recompute a position from its evidence ledger.
 *
 * Every one of the three sub-selects below is scoped by `user_id`, not just the
 * `copy_positions` row this UPDATE targets. That is the whole point: splitting
 * `copy_positions` per tenant while still aggregating `copy_position_applications`
 * across tenants would produce two rows holding identical, doubled quantities —
 * a cosmetic split. Two paper users share one synthetic `target_account`, so
 * the triple (target_account, chain, token_mint) does NOT identify a tenant's
 * evidence on its own.
 *
 * `IS NOT DISTINCT FROM` rather than `=` so the operator's legacy `NULL` tenant
 * matches its own rows; `=` would evaluate to NULL and select nothing, silently
 * zeroing every legacy position.
 */
async function rebuildCopyPosition(
  client: PoolClient,
  execution: Pick<CopyExecutionDbRow, 'target_account' | 'chain' | 'token_mint' | 'user_id'>
): Promise<CopyPositionRecord> {
  const result = await client.query<QueryResultRow & {
    id: string;
    target_account: string;
    chain: Chain;
    token_mint: string;
    user_id: string | null;
    confirmed_quantity: string;
    reserved_sell_quantity: string;
    cost_basis_usd: string;
    total_acquired_quantity: string;
    total_reduced_quantity: string;
    unmatched_reduction_quantity: string;
    cost_basis_unvalued_fill_count: number;
    last_evidence_at: Date | null;
  }>(
    `WITH RECURSIVE ordered_events AS (
       SELECT
         ROW_NUMBER() OVER (ORDER BY evidence.occurred_at, evidence.id)::bigint AS sequence,
         execution.direction,
         evidence.base_quantity,
         -- The unit gate (S4-M35, migration 054). quote_quantity is USD only on a
         -- row that declares its currency; a pre-054 row whose executor path was
         -- unidentifiable declares nothing, so its amount is refused here and the
         -- base_quantity * price_usd fallback below -- which is USD by
         -- construction -- decides instead. This is the COALESCE preference that
         -- used to add SOL and ETH into a column named _usd.
         CASE
           WHEN evidence.quote_currency IS NOT NULL THEN evidence.quote_quantity
           ELSE NULL
         END AS quote_usd,
         evidence.price_usd,
         evidence.occurred_at
       FROM copy_position_applications application
       JOIN copy_execution_evidence evidence ON evidence.id = application.evidence_id
       JOIN copy_executions execution ON execution.id = application.execution_id
       WHERE application.target_account = $1
         AND application.chain = $2
         AND application.token_mint = $3
         AND application.user_id IS NOT DISTINCT FROM $4
         AND application.active
     ), ledger AS (
       SELECT
         0::bigint AS sequence,
         position.opening_quantity AS quantity,
         position.opening_cost_basis_usd AS cost_basis,
         0::numeric AS acquired,
         0::numeric AS reduced,
         0::numeric AS unmatched,
         0::integer AS unvalued
       FROM copy_positions position
       WHERE position.target_account = $1
         AND position.chain = $2
         AND position.token_mint = $3
         AND position.user_id IS NOT DISTINCT FROM $4

       UNION ALL

       SELECT
         event.sequence,
         CASE
           WHEN event.direction = 'buy' THEN ledger.quantity + event.base_quantity
           ELSE GREATEST(0, ledger.quantity - event.base_quantity)
         END,
         CASE
           WHEN event.direction = 'buy' THEN
             ledger.cost_basis + COALESCE(event.quote_usd, event.base_quantity * event.price_usd, 0)
           WHEN ledger.quantity = 0 THEN 0
           ELSE GREATEST(
             0,
             ledger.cost_basis - (ledger.cost_basis / ledger.quantity) * LEAST(ledger.quantity, event.base_quantity)
           )
         END,
         ledger.acquired + CASE WHEN event.direction = 'buy' THEN event.base_quantity ELSE 0 END,
         ledger.reduced + CASE WHEN event.direction = 'sell' THEN event.base_quantity ELSE 0 END,
         ledger.unmatched + CASE
           WHEN event.direction = 'sell' THEN GREATEST(0, event.base_quantity - ledger.quantity)
           ELSE 0
         END,
         -- The trailing 0 in that COALESCE is what makes an unknown acquisition
         -- cost look like a free one. It stays, because a partial basis is more
         -- useful than none, but every buy it swallows is counted here so the
         -- number never claims to be complete.
         ledger.unvalued + CASE
           WHEN event.direction = 'buy'
             AND COALESCE(event.quote_usd, event.base_quantity * event.price_usd) IS NULL
             THEN 1
           ELSE 0
         END
       FROM ledger
       JOIN ordered_events event ON event.sequence = ledger.sequence + 1
     ), final AS (
       SELECT * FROM ledger ORDER BY sequence DESC LIMIT 1
     ), metadata AS (
       SELECT
         MAX(occurred_at) AS last_evidence_at,
         COALESCE((
           SELECT SUM(reserved_base_quantity)
           FROM copy_executions reserved
           WHERE reserved.target_account = $1
             AND reserved.chain = $2
             AND reserved.token_mint = $3
             AND reserved.user_id IS NOT DISTINCT FROM $4
             AND reserved.direction = 'sell'
         ), 0) AS reserved_sell_quantity
       FROM ordered_events
     )
     UPDATE copy_positions position
        SET confirmed_quantity = final.quantity,
            reserved_sell_quantity = metadata.reserved_sell_quantity,
            cost_basis_usd = final.cost_basis,
            total_acquired_quantity = final.acquired,
            total_reduced_quantity = final.reduced,
            unmatched_reduction_quantity = final.unmatched,
            cost_basis_unvalued_fill_count = final.unvalued,
            last_evidence_at = metadata.last_evidence_at,
            updated_at = NOW()
       FROM final, metadata
      WHERE position.target_account = $1
        AND position.chain = $2
        AND position.token_mint = $3
        AND position.user_id IS NOT DISTINCT FROM $4
     RETURNING
       position.id,
       position.target_account,
       position.chain,
       position.token_mint,
       position.user_id,
       position.confirmed_quantity::text AS confirmed_quantity,
       position.reserved_sell_quantity::text AS reserved_sell_quantity,
       position.cost_basis_usd::text AS cost_basis_usd,
       position.total_acquired_quantity::text AS total_acquired_quantity,
       position.total_reduced_quantity::text AS total_reduced_quantity,
       position.unmatched_reduction_quantity::text AS unmatched_reduction_quantity,
       position.cost_basis_unvalued_fill_count,
       position.last_evidence_at`,
    [execution.target_account, execution.chain, execution.token_mint, execution.user_id ?? null]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Copy position rebuild did not return a row');
  return {
    id: row.id,
    targetAccount: row.target_account,
    chain: row.chain,
    tokenMint: row.token_mint,
    userId: row.user_id ?? null,
    confirmedQuantity: row.confirmed_quantity,
    reservedSellQuantity: row.reserved_sell_quantity,
    costBasisUsd: row.cost_basis_usd,
    totalAcquiredQuantity: row.total_acquired_quantity,
    totalReducedQuantity: row.total_reduced_quantity,
    unmatchedReductionQuantity: row.unmatched_reduction_quantity,
    costBasisUnvaluedFillCount: Number(row.cost_basis_unvalued_fill_count ?? 0),
    lastEvidenceAt: row.last_evidence_at
  };
}

async function setCopyExecutionState(
  client: PoolClient,
  execution: CopyExecutionDbRow,
  nextState: CopyExecutionState,
  reason: string | null
): Promise<CopyExecutionDbRow> {
  if (execution.state === nextState) return execution;
  if (!canTransitionCopyExecution(execution.state, nextState)) {
    throw new Error(`Invalid copy execution transition: ${execution.state} -> ${nextState}`);
  }
  const updated = await client.query<CopyExecutionDbRow>(
    `UPDATE copy_executions
        SET state = $2::text,
            updated_at = NOW(),
            confirmed_at = CASE WHEN $2::text = 'confirmed' THEN NOW() ELSE confirmed_at END
      WHERE id = $1
    RETURNING ${COPY_EXECUTION_COLUMNS}`,
    [execution.id, nextState]
  );
  await client.query(
    `INSERT INTO copy_execution_state_history (execution_id, from_state, to_state, reason)
     VALUES ($1, $2, $3, $4)`,
    [execution.id, execution.state, nextState, reason]
  );
  return updated.rows[0] as CopyExecutionDbRow;
}

export interface CopyExecutionRequestInput {
  sourceTradeId: string;
  targetAccount: string;
  /**
   * Acting tenant. Omit or pass `null` for the pre-multi-tenant operator
   * account — `null` is a real value here (see `normalizeTenantId`), not a
   * missing one, and is what every legacy row carries.
   */
  userId?: string | null;
  executionMode: CopyExecutionMode;
  requestedBaseQuantity?: DecimalInput | null;
  requestedQuoteQuantity?: DecimalInput | null;
  maxSubmissionAttempts?: number;
  maxReconciliationAttempts?: number;
}

export async function requestCopyExecution(input: CopyExecutionRequestInput): Promise<{
  execution: CopyExecutionRecord;
  created: boolean;
}> {
  const sourceTradeId = assertIdentifier('sourceTradeId', input.sourceTradeId, 128);
  const userId = normalizeTenantId(input.userId);
  const requestedBase = input.requestedBaseQuantity === null || input.requestedBaseQuantity === undefined
    ? null
    : decimal('requestedBaseQuantity', input.requestedBaseQuantity);
  const requestedQuote = input.requestedQuoteQuantity === null || input.requestedQuoteQuantity === undefined
    ? null
    : decimal('requestedQuoteQuantity', input.requestedQuoteQuantity);
  if (!requestedBase && !requestedQuote) {
    throw new Error('At least one requested quantity is required');
  }
  const maxSubmissionAttempts = input.maxSubmissionAttempts ?? 3;
  const maxReconciliationAttempts = input.maxReconciliationAttempts ?? 10;
  if (!Number.isInteger(maxSubmissionAttempts) || maxSubmissionAttempts < 1 || maxSubmissionAttempts > 10) {
    throw new Error('maxSubmissionAttempts must be an integer between 1 and 10');
  }
  if (
    !Number.isInteger(maxReconciliationAttempts)
    || maxReconciliationAttempts < 1
    || maxReconciliationAttempts > 100
  ) {
    throw new Error('maxReconciliationAttempts must be an integer between 1 and 100');
  }

  return inTransaction(async (client) => {
    const sourceResult = await client.query<SourceTradeDbRow>(
      `SELECT ${SOURCE_TRADE_COLUMNS}
         FROM source_trades
        WHERE id = $1
        FOR SHARE`,
      [sourceTradeId]
    );
    const source = sourceResult.rows[0];
    if (!source) throw new Error(`Source trade ${sourceTradeId} does not exist`);
    if (!isAppliedSourceConfirmation(source.confirmation_state)) {
      throw new Error(`Source trade ${sourceTradeId} is not confirmed`);
    }
    if (source.direction !== 'buy' && source.direction !== 'sell') {
      throw new Error('Transfer source events cannot create copy executions');
    }
    const target = resolveChainAddress(input.targetAccount, source.chain);
    const clientOrderId = buildCopyExecutionClientOrderId({
      sourceTradeId,
      chain: source.chain,
      targetAccount: target.prefixed,
      executionMode: input.executionMode,
      userId
    });

    // The advisory lock guards the position row this transaction is about to
    // create and read, so its key has to have the same shape as that row's
    // uniqueness key. Without `userId` two tenants touching the same token on
    // the same chain would serialise against each other for no reason.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [JSON.stringify([target.prefixed, source.chain, source.token_mint, userId])]
    );
    await ensureCopyPosition(client, target.prefixed, source.chain, source.token_mint, userId);

    const existing = await client.query<CopyExecutionDbRow>(
      `SELECT ${COPY_EXECUTION_COLUMNS},
              (
                direction = $4
                AND (
                  (direction = 'sell' AND requested_base_quantity <= $5::numeric)
                  OR (direction <> 'sell' AND requested_base_quantity IS NOT DISTINCT FROM $5::numeric)
                )
                AND requested_quote_quantity IS NOT DISTINCT FROM $6::numeric
                AND client_order_id = $7
              ) AS payload_matches
         FROM copy_executions
        WHERE source_trade_id = $1
          AND target_account = $2
          AND execution_mode = $3
          AND user_id IS NOT DISTINCT FROM $8
        FOR UPDATE`,
      [
        sourceTradeId,
        target.prefixed,
        input.executionMode,
        source.direction,
        requestedBase,
        requestedQuote,
        clientOrderId,
        userId
      ]
    );
    if (existing.rows[0]) {
      if (!existing.rows[0].payload_matches) {
        throw new Error('Copy execution identity collision with different requested quantities');
      }
      return { execution: mapCopyExecution(existing.rows[0]), created: false };
    }

    let cappedBase = requestedBase;
    if (source.direction === 'sell') {
      if (!requestedBase) throw new Error('Sell executions require requestedBaseQuantity');
      const available = await client.query<{ capped: string | null }>(
        `WITH pos AS (
           SELECT id, confirmed_quantity, reserved_sell_quantity
             FROM copy_positions
            WHERE target_account = $1
              AND chain = $2
              AND token_mint = $3
              AND user_id IS NOT DISTINCT FROM $5
            FOR UPDATE
         ),
         master_lots AS (
           SELECT COALESCE(SUM(remaining_quantity), 0) AS total_remaining,
                  COUNT(*) AS lot_count
             FROM copy_position_master_lots
            WHERE position_id = (SELECT id FROM pos)
              AND master_wallet_address = $6
         )
         SELECT CASE
                  WHEN pos.confirmed_quantity - pos.reserved_sell_quantity <= 0 THEN NULL
                  WHEN (SELECT lot_count FROM master_lots) > 0 AND (SELECT total_remaining FROM master_lots) <= 0 THEN NULL
                  ELSE LEAST(
                    $4::numeric,
                    pos.confirmed_quantity - pos.reserved_sell_quantity,
                    CASE
                      WHEN (SELECT lot_count FROM master_lots) > 0 THEN (SELECT total_remaining FROM master_lots)
                      ELSE $4::numeric
                    END
                  )::text
                END AS capped
           FROM pos`,
        [target.prefixed, source.chain, source.token_mint, requestedBase, userId, source.wallet_address]
      );
      cappedBase = available.rows[0]?.capped ?? null;
      if (!cappedBase) {
        throw new Error('No unreserved confirmed copy position is available to sell');
      }
    }

    const inserted = await client.query<CopyExecutionDbRow>(
      `INSERT INTO copy_executions (
         source_trade_id, chain, target_account, token_mint, direction,
         execution_mode, client_order_id, requested_base_quantity,
         requested_quote_quantity, reserved_base_quantity,
         max_submission_attempts, max_reconciliation_attempts, user_id
       ) VALUES (
         $1, $2, $3, $4, $5::text, $6::text, $7, $8::numeric, $9::numeric,
         CASE WHEN $5::text = 'sell' THEN $8::numeric ELSE 0 END, $10, $11, $12
       )
       RETURNING ${COPY_EXECUTION_COLUMNS}`,
      [
        sourceTradeId,
        source.chain,
        target.prefixed,
        source.token_mint,
        source.direction,
        input.executionMode,
        clientOrderId,
        cappedBase,
        requestedQuote,
        maxSubmissionAttempts,
        maxReconciliationAttempts,
        userId
      ]
    );
    const execution = inserted.rows[0] as CopyExecutionDbRow;
    await client.query(
      `INSERT INTO copy_execution_state_history (execution_id, from_state, to_state, reason)
       VALUES ($1, NULL, 'requested', 'canonical request accepted')`,
      [execution.id]
    );
    if (execution.direction === 'sell') {
      await rebuildCopyPosition(client, execution);
    }
    return { execution: mapCopyExecution(execution), created: true };
  });
}

export interface LotExitExecutionInput {
  lotId: string;
  userId: string | null;
  requestId: string;
  trigger: 'close-all' | 'stop-loss' | 'manual' | 'redemption';
  requestedBaseQuantity?: DecimalInput;
}

export async function claimLotExitExecution(input: LotExitExecutionInput): Promise<{
  execution: CopyExecutionRecord;
  created: boolean;
}> {
  return inTransaction((client) => claimLotExitExecutionWithClient(client, input));
}

export async function claimLotExitExecutionWithClient(
  client: PoolClient,
  input: LotExitExecutionInput
): Promise<{ execution: CopyExecutionRecord; created: boolean }> {
  const lotId = assertIdentifier('lotId', input.lotId, 128);
  const userId = normalizeTenantId(input.userId);
  const requestId = assertIdentifier('requestId', input.requestId);
  if (!['close-all', 'stop-loss', 'manual', 'redemption'].includes(input.trigger)) {
    throw new Error('Unknown lot exit trigger');
  }
  const requested = input.requestedBaseQuantity === undefined
    ? null
    : decimal('requestedBaseQuantity', input.requestedBaseQuantity);
  const identity = ['lot-exit', lotId, userId ?? '', input.trigger, requestId]
    .join(COPY_IDENTITY_SEPARATOR);
  const clientOrderId = `swat-${createHash('sha256').update(identity).digest('hex')}`;
  const ownership = await client.query<{
    position_id: string;
    target_account: string;
    chain: Chain;
    token_mint: string;
    signal_id: string | null;
    execution_mode: CopyExecutionMode;
  }>(
    `SELECT lot.position_id, position.target_account, lot.chain, lot.token_mint,
            lot.signal_id, acquisition.execution_mode
       FROM copy_position_master_lots lot
       JOIN copy_positions position ON position.id = lot.position_id
       JOIN copy_executions acquisition ON acquisition.id = lot.acquisition_execution_id
      WHERE lot.id = $1 AND lot.user_id IS NOT DISTINCT FROM $2
        AND position.user_id IS NOT DISTINCT FROM $2`,
    [lotId, userId]
  );
  const owner = ownership.rows[0];
  if (!owner) throw new Error('Lot exit does not match the owning tenant');
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [JSON.stringify([owner.target_account, owner.chain, owner.token_mint, userId])]
  );
  await ensureCopyPosition(client, owner.target_account, owner.chain, owner.token_mint, userId);
  const existing = await client.query<CopyExecutionDbRow>(
    `SELECT ${COPY_EXECUTION_COLUMNS} FROM copy_executions
      WHERE chain = $1 AND target_account = $2 AND client_order_id = $3`,
    [owner.chain, owner.target_account, clientOrderId]
  );
  if (existing.rows[0]) {
    const execution = existing.rows[0];
    if (execution.exit_lot_id !== lotId || execution.exit_trigger !== input.trigger
      || execution.user_id !== userId
      || (requested !== null && Number(execution.requested_base_quantity) !== Number(requested))) {
      throw new Error('Lot exit identity collision with different requested quantities');
    }
    return { execution: mapCopyExecution(execution), created: false };
  }
  const lot = await client.query<{ quantity: string; available: boolean }>(
    `SELECT COALESCE($3::numeric, lot.remaining_quantity)::text AS quantity,
            lot.remaining_quantity > 0
              AND COALESCE($3::numeric, lot.remaining_quantity) <= lot.remaining_quantity
              AND COALESCE($3::numeric, lot.remaining_quantity)
                <= position.confirmed_quantity - position.reserved_sell_quantity AS available
       FROM copy_position_master_lots lot
       JOIN copy_positions position ON position.id = lot.position_id
      WHERE lot.id = $1 AND lot.user_id IS NOT DISTINCT FROM $2
      FOR UPDATE OF lot`,
    [lotId, userId, requested]
  );
  if (!lot.rows[0]?.available) throw new Error('No unreserved confirmed lot inventory is available to sell');
  const active = await client.query<{ id: string }>(
    `SELECT id FROM copy_executions WHERE exit_lot_id = $1
        AND state NOT IN ('failed', 'cancelled', 'confirmed')`,
    [lotId]
  );
  if (active.rows.length > 0) throw new Error('Lot already has an active exit execution');
  const inserted = await client.query<CopyExecutionDbRow>(
    `INSERT INTO copy_executions (
       signal_id, source_trade_id, exit_lot_id, exit_trigger, chain, target_account,
       user_id, token_mint, direction, execution_mode, client_order_id,
       requested_base_quantity, reserved_base_quantity
     ) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, 'sell', $8, $9, $10::numeric, $10::numeric)
     RETURNING ${COPY_EXECUTION_COLUMNS}`,
    [owner.signal_id, lotId, input.trigger, owner.chain, owner.target_account,
      userId, owner.token_mint, owner.execution_mode, clientOrderId, lot.rows[0].quantity]
  );
  const execution = inserted.rows[0];
  if (!execution) throw new Error('Lot exit insert did not return a row');
  await client.query(
    `INSERT INTO copy_execution_state_history (execution_id, from_state, to_state, reason)
     VALUES ($1, NULL, 'requested', $2)`,
    [execution.id, `${input.trigger} lot exit accepted`]
  );
  await rebuildCopyPosition(client, execution);
  return { execution: mapCopyExecution(execution), created: true };
}

type SourceSignalDbRow = QueryResultRow & {
  id: string;
  status: string;
  source_trade_id: string;
  source_side: 'buy' | 'sell';
  source_position_before_quantity: string | null;
  source_position_evidence_at: Date | null;
  source_sell_fraction: string | null;
  expires_at: Date | null;
};

export async function claimSourceSignalForCopyExecution(input: {
  signalId: string;
  targetAccount: string;
  /**
   * Acting tenant. Omit or pass `null` for the pre-multi-tenant operator
   * account. In paper mode `targetAccount` is one synthetic address shared by
   * every user on the chain, so this is the ONLY thing separating two users'
   * positions and executions (S4-10, migration 050).
   */
  userId?: string | null;
  executionMode: CopyExecutionMode;
  requestedBaseQuantity?: DecimalInput | null;
  requestedQuoteQuantity?: DecimalInput | null;
  maxPositionEvidenceAgeMs: number;
  maxSubmissionAttempts?: number;
  maxReconciliationAttempts?: number;
  now?: Date;
}): Promise<{
  execution: CopyExecutionRecord | null;
  created: boolean;
  claimed: boolean;
  reason?: string;
}> {
  const signalId = assertIdentifier('signalId', input.signalId, 128);
  const userId = normalizeTenantId(input.userId);
  const requestedBase = input.requestedBaseQuantity === null || input.requestedBaseQuantity === undefined
    ? null
    : decimal('requestedBaseQuantity', input.requestedBaseQuantity);
  const requestedQuote = input.requestedQuoteQuantity === null || input.requestedQuoteQuantity === undefined
    ? null
    : decimal('requestedQuoteQuantity', input.requestedQuoteQuantity);
  const maxPositionEvidenceAgeMs = boundedDuration(
    'maxPositionEvidenceAgeMs',
    input.maxPositionEvidenceAgeMs
  );
  const maxSubmissionAttempts = input.maxSubmissionAttempts ?? 3;
  const maxReconciliationAttempts = input.maxReconciliationAttempts ?? 10;
  if (!Number.isInteger(maxSubmissionAttempts) || maxSubmissionAttempts < 1 || maxSubmissionAttempts > 10) {
    throw new Error('maxSubmissionAttempts must be an integer between 1 and 10');
  }
  if (
    !Number.isInteger(maxReconciliationAttempts)
    || maxReconciliationAttempts < 1
    || maxReconciliationAttempts > 100
  ) {
    throw new Error('maxReconciliationAttempts must be an integer between 1 and 100');
  }
  const now = assertDate('now', input.now ?? new Date());

  return inTransaction(async (client) => {
    const signalResult = await client.query<SourceSignalDbRow>(
      `SELECT
         id,
         status,
         source_trade_id,
         source_side,
         source_position_before_quantity::text AS source_position_before_quantity,
         source_position_evidence_at,
         source_sell_fraction::text AS source_sell_fraction,
         expires_at
       FROM signals
       WHERE id = $1
       FOR UPDATE`,
      [signalId]
    );
    const signal = signalResult.rows[0];
    if (!signal?.source_trade_id || !signal.source_side) {
      throw new Error(`Signal ${signalId} is not linked to a canonical source trade`);
    }
    const sourceResult = await client.query<SourceTradeDbRow>(
      `SELECT ${SOURCE_TRADE_COLUMNS}
       FROM source_trades
       WHERE id = $1
       FOR SHARE`,
      [signal.source_trade_id]
    );
    const source = sourceResult.rows[0];
    if (!source) throw new Error(`Source trade ${signal.source_trade_id} does not exist`);
    if (source.direction !== signal.source_side) {
      throw new Error('Source signal direction no longer matches its immutable source event');
    }
    const target = resolveChainAddress(input.targetAccount, source.chain);
    // Tenant-scoped, mirroring `uq_copy_executions_source_target_mode_user`
    // (050_copy_tenancy.sql). Unscoped, tenant B's claim for a shared paper
    // `target_account` would find tenant A's row and return it as B's own
    // execution — B's fills would then be recorded against A's ledger.
    // `IS NOT DISTINCT FROM` because the operator's rows carry `user_id NULL`
    // and `= NULL` never matches.
    const existingResult = await client.query<CopyExecutionDbRow>(
      `SELECT ${COPY_EXECUTION_COLUMNS}
       FROM copy_executions
       WHERE source_trade_id = $1
         AND target_account = $2
         AND execution_mode = $3
         AND user_id IS NOT DISTINCT FROM $4
       FOR UPDATE`,
      [source.id, target.prefixed, input.executionMode, userId]
    );
    const existing = existingResult.rows[0];
    if (existing) {
      if (existing.signal_id !== signal.id) {
        throw new Error('Copy execution source identity is linked to a different signal');
      }
      return { execution: mapCopyExecution(existing), created: false, claimed: false };
    }

    // Deliberately NOT tenant-scoped. A signal is a shared detection, not a
    // per-tenant object: once ANY tenant has claimed it the signal sits in
    // 'executing', so scoping this by user_id would make the second tenant's
    // legitimate claim look like an attempt against a stale signal and reject
    // it with "Source signal is executing, not eligible". The tenant-scoped
    // `existingResult` lookup above is what prevents double-claiming.
    const resumable = signal.status === 'executing' && (await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM copy_executions WHERE signal_id = $1
       ) AS exists`,
      [signal.id]
    )).rows[0]?.exists === true;
    if (signal.status !== 'eligible' && signal.status !== 'alerted' && !resumable) {
      return {
        execution: null,
        created: false,
        claimed: false,
        reason: `Source signal is ${signal.status}, not eligible`
      };
    }
    if (!isAppliedSourceConfirmation(source.confirmation_state)) {
      return {
        execution: null,
        created: false,
        claimed: false,
        reason: `Source trade is ${source.confirmation_state}`
      };
    }
    if (signal.expires_at && signal.expires_at <= now) {
      await client.query(
        `UPDATE signals SET status = 'expired' WHERE id = $1`,
        [signal.id]
      );
      return {
        execution: null,
        created: false,
        claimed: false,
        reason: 'Source signal expired before execution claim'
      };
    }

    let sourcePositionBefore: string | null = null;
    let sourceSellFraction: string | null = null;
    if (source.direction === 'sell') {
      if (
        !signal.source_position_before_quantity
        || !signal.source_sell_fraction
        || !signal.source_position_evidence_at
      ) {
        throw new Error('Source sell signal is missing position evidence');
      }
      if (
        now.getTime() - signal.source_position_evidence_at.getTime()
        > maxPositionEvidenceAgeMs
      ) {
        await client.query(`UPDATE signals SET status = 'expired' WHERE id = $1`, [signal.id]);
        return {
          execution: null,
          created: false,
          claimed: false,
          reason: 'Source position evidence is stale'
        };
      }
      const currentEvidence = await getSourcePositionEvidence(client, source);
      const comparison = await client.query<{ matches: boolean }>(
        `SELECT
           $1::numeric = $2::numeric
           AND $3::numeric = $4::numeric AS matches`,
        [
          signal.source_position_before_quantity,
          currentEvidence.beforeQuantity,
          signal.source_sell_fraction,
          currentEvidence.sellFraction
        ]
      );
      if (comparison.rows[0]?.matches !== true) {
        await client.query(`UPDATE signals SET status = 'rejected' WHERE id = $1`, [signal.id]);
        return {
          execution: null,
          created: false,
          claimed: false,
          reason: 'Source position evidence changed after signal eligibility'
        };
      }
      sourcePositionBefore = signal.source_position_before_quantity;
      sourceSellFraction = signal.source_sell_fraction;
    } else if (!requestedBase && !requestedQuote) {
      throw new Error('Buy executions require a requested base or quote quantity');
    }

    // Keyed the same way as the position's uniqueness key — see the matching
    // note in `requestCopyExecution`.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [JSON.stringify([target.prefixed, source.chain, source.token_mint, userId])]
    );
    await ensureCopyPosition(client, target.prefixed, source.chain, source.token_mint, userId);

    let executionBase = requestedBase;
    let executionQuote = requestedQuote;
    if (source.direction === 'sell') {
      const availableResult = await client.query<{ requested_base: string | null }>(
        `SELECT CASE
                  WHEN confirmed_quantity - reserved_sell_quantity <= 0 THEN NULL
                  ELSE (
                    (confirmed_quantity - reserved_sell_quantity) * $4::numeric
                  )::text
                END AS requested_base
         FROM copy_positions
         WHERE target_account = $1
           AND chain = $2
           AND token_mint = $3
           AND user_id IS NOT DISTINCT FROM $5
         FOR UPDATE`,
        [target.prefixed, source.chain, source.token_mint, sourceSellFraction, userId]
      );
      executionBase = availableResult.rows[0]?.requested_base ?? null;
      executionQuote = null;
      if (!executionBase || Number(executionBase) <= 0) {
        return {
          execution: null,
          created: false,
          claimed: false,
          reason: 'No unreserved confirmed copied position is available to sell'
        };
      }
    }

    const clientOrderId = buildCopyExecutionClientOrderId({
      sourceTradeId: source.id,
      chain: source.chain,
      targetAccount: target.prefixed,
      executionMode: input.executionMode,
      userId
    });
    const inserted = await client.query<CopyExecutionDbRow>(
      `INSERT INTO copy_executions (
         signal_id, source_trade_id, chain, target_account, token_mint,
         direction, execution_mode, client_order_id, requested_base_quantity,
         requested_quote_quantity, reserved_base_quantity,
         max_submission_attempts, max_reconciliation_attempts,
         source_position_before_quantity, source_sell_fraction, user_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6::text, $7::text, $8, $9::numeric,
         $10::numeric, CASE WHEN $6::text = 'sell' THEN $9::numeric ELSE 0 END,
         $11, $12, $13::numeric, $14::numeric, $15
       )
       RETURNING ${COPY_EXECUTION_COLUMNS}`,
      [
        signal.id,
        source.id,
        source.chain,
        target.prefixed,
        source.token_mint,
        source.direction,
        input.executionMode,
        clientOrderId,
        executionBase,
        executionQuote,
        maxSubmissionAttempts,
        maxReconciliationAttempts,
        sourcePositionBefore,
        sourceSellFraction,
        userId
      ]
    );
    const execution = inserted.rows[0] as CopyExecutionDbRow;
    await client.query(
      `INSERT INTO copy_execution_state_history (execution_id, from_state, to_state, reason)
       VALUES ($1, NULL, 'requested', 'source signal claimed')`,
      [execution.id]
    );
    const claimed = signal.status === 'eligible' || signal.status === 'alerted';
    if (claimed) {
      await client.query(
        `UPDATE signals
         SET status = 'executing', claimed_at = COALESCE(claimed_at, $2)
         WHERE id = $1`,
        [signal.id, now]
      );
    }
    if (execution.direction === 'sell') {
      await rebuildCopyPosition(client, execution);
    }
    return { execution: mapCopyExecution(execution), created: true, claimed };
  });
}

export async function transitionCopyExecution(input: {
  executionId: string;
  nextState: 'simulated' | 'submitted' | 'failed' | 'cancelled' | 'reconciliation_required';
  reason?: string | null;
  simulationId?: string | null;
  submissionType?: 'transaction' | 'order' | null;
  submissionId?: string | null;
  nextReconciliationAt?: Date | null;
}): Promise<CopyExecutionRecord> {
  const executionId = assertIdentifier('executionId', input.executionId, 128);
  const reason = input.reason === null || input.reason === undefined
    ? null
    : assertIdentifier('reason', input.reason, 2_000);
  if (
    (input.nextState === 'failed'
      || input.nextState === 'cancelled'
      || input.nextState === 'reconciliation_required')
    && !reason
  ) {
    throw new Error(`${input.nextState} requires an explicit reason`);
  }
  const nextReconciliationAt = input.nextReconciliationAt
    ? assertDate('nextReconciliationAt', input.nextReconciliationAt)
    : null;

  return inTransaction(async (client) => {
    const selected = await client.query<CopyExecutionDbRow>(
      `SELECT ${COPY_EXECUTION_COLUMNS}
         FROM copy_executions
        WHERE id = $1
        FOR UPDATE`,
      [executionId]
    );
    let execution = selected.rows[0];
    if (!execution) throw new Error(`Copy execution ${executionId} does not exist`);

    let simulationId: string | null = execution.simulation_id;
    let submissionType = execution.submission_type;
    let submissionId = execution.submission_id;

    if (input.nextState === 'simulated') {
      simulationId = assertIdentifier('simulationId', input.simulationId ?? '');
      if (execution.simulation_id && execution.simulation_id !== simulationId) {
        throw new Error('Execution already has different immutable simulation evidence');
      }
    }

    if (input.nextState === 'submitted') {
      submissionType = input.submissionType ?? null;
      submissionId = input.submissionId
        ? assertIdentifier('submissionId', input.submissionId)
        : null;
      if (!submissionType || !submissionId) {
        throw new Error('Submitted executions require an explicit transaction or order identity');
      }
      if (!nextReconciliationAt) {
        throw new Error('Submitted executions require a reconciliation deadline');
      }
      if (
        execution.submission_id
        && (execution.submission_id !== submissionId || execution.submission_type !== submissionType)
      ) {
        throw new Error('Ambiguous execution already has a different submission identity');
      }
      if (!execution.submission_id && execution.submission_attempts >= execution.max_submission_attempts) {
        throw new Error('Execution submission retry limit has been reached');
      }
    }

    execution = await setCopyExecutionState(client, execution, input.nextState, reason);
    const terminal = input.nextState === 'failed' || input.nextState === 'cancelled';
    const updated = await client.query<CopyExecutionDbRow>(
      `UPDATE copy_executions
          SET simulation_id = CASE WHEN $2 = 'simulated' THEN $3 ELSE simulation_id END,
              simulated_at = CASE WHEN $2 = 'simulated' THEN COALESCE(simulated_at, NOW()) ELSE simulated_at END,
              submission_type = CASE WHEN $2 = 'submitted' THEN $4 ELSE submission_type END,
              submission_id = CASE WHEN $2 = 'submitted' THEN $5 ELSE submission_id END,
              venue_order_id = CASE WHEN $2 = 'submitted' AND $4 = 'order' THEN $5 ELSE venue_order_id END,
              transaction_hash = CASE WHEN $2 = 'submitted' AND $4 = 'transaction' THEN $5 ELSE transaction_hash END,
              submission_attempts = CASE
                WHEN $2 = 'submitted' AND submission_id IS NULL THEN submission_attempts + 1
                ELSE submission_attempts
              END,
              submitted_at = CASE WHEN $2 = 'submitted' THEN COALESCE(submitted_at, NOW()) ELSE submitted_at END,
              next_reconciliation_at = CASE
                WHEN $2 IN ('submitted', 'reconciliation_required') THEN $6
                WHEN $7 THEN NULL
                ELSE next_reconciliation_at
              END,
              reconciliation_claim_id = CASE WHEN $7 THEN NULL ELSE reconciliation_claim_id END,
              reconciliation_claimed_at = CASE WHEN $7 THEN NULL ELSE reconciliation_claimed_at END,
              reserved_base_quantity = CASE WHEN $7 THEN 0 ELSE reserved_base_quantity END,
              last_error = CASE WHEN $2 IN ('failed', 'cancelled', 'reconciliation_required') THEN $8 ELSE last_error END,
              updated_at = NOW()
        WHERE id = $1
      RETURNING ${COPY_EXECUTION_COLUMNS}`,
      [
        execution.id,
        input.nextState,
        simulationId,
        submissionType,
        submissionId,
        nextReconciliationAt,
        terminal,
        reason
      ]
    );
    execution = updated.rows[0] as CopyExecutionDbRow;
    if (terminal && execution.direction === 'sell') {
      await ensureCopyPosition(
        client,
        execution.target_account,
        execution.chain,
        execution.token_mint,
        execution.user_id ?? null
      );
      await rebuildCopyPosition(client, execution);
    }
    if (terminal && execution.signal_id && !execution.exit_lot_id && execution.execution_mode !== 'shadow') {
      await client.query(
        `UPDATE signals
         SET status = CASE WHEN $2 = 'cancelled' THEN 'rejected' ELSE 'failed' END
         WHERE id = $1 AND status = 'executing'`,
        [execution.signal_id, input.nextState]
      );
    }
    return mapCopyExecution(execution);
  });
}

type ExecutionEvidenceDbRow = QueryResultRow & {
  id: string;
  execution_id: string;
  evidence_type: ExecutionEvidenceType;
  evidence_id: string;
  base_quantity: string;
  quote_quantity: string | null;
  quote_native_quantity: string | null;
  quote_currency: QuoteCurrency | null;
  quote_native_usd_price: string | null;
  price_usd: string | null;
  confirmation_state: SourceConfirmationState;
  completes_execution: boolean;
  occurred_at: Date;
  payload_matches?: boolean;
};

/**
 * The columns that make up an evidence row's immutable quote payload.
 *
 * One constant so the INSERT, the identity-collision comparison and the two
 * RETURNING clauses cannot drift: a column present in the write but missing from
 * the comparison is a silent replay that overwrites a unit.
 */
const EVIDENCE_QUOTE_COLUMNS = `
    quote_quantity::text AS quote_quantity,
    quote_native_quantity::text AS quote_native_quantity,
    quote_currency,
    quote_native_usd_price::text AS quote_native_usd_price`;

function isStaleEvidenceConfirmation(
  current: SourceConfirmationState,
  proposed: SourceConfirmationState
): boolean {
  return isStaleConfirmation(current, proposed);
}

export interface RecordCopyExecutionEvidenceInput {
  executionId: string;
  evidenceType: ExecutionEvidenceType;
  evidenceId: string;
  baseQuantity: DecimalInput;
  /**
   * What was paid, in the unit the venue actually settled in.
   *
   * Structured rather than a bare `quoteQuantity` number on purpose (S4-M35): the
   * old field took whatever the executor path had — USD from Polymarket and paper,
   * SOL from Solana live, ETH from robinhood live — and nothing recorded which.
   * There is deliberately no way to hand this function an amount without its
   * currency. The USD conversion happens here, once, through `valuateQuoteLeg`.
   *
   * Omit or pass `null` when the venue reported no quote amount at all.
   */
  quoteLeg?: QuoteLegInput | null;
  priceUsd?: DecimalInput | null;
  confirmationState: SourceConfirmationState;
  completesExecution: boolean;
  occurredAt: Date;
  observedAt?: Date;
}

export interface RecordCopyExecutionEvidenceResult {
  execution: CopyExecutionRecord;
  position: CopyPositionRecord;
  /** How this single fill's quote leg was valued, including why it was not. */
  fillValuation: QuoteLegValuation;
  /** Whether the execution's confirmed USD total now accounts for every fill. */
  confirmedQuoteTotal: ConfirmedQuoteTotal;
}

async function synchronizePositionLots(
  client: PoolClient,
  input: {
    execution: CopyExecutionDbRow;
    evidence: ExecutionEvidenceDbRow;
    positionId: string;
  }
): Promise<void> {
  if (!isAppliedSourceConfirmation(input.evidence.confirmation_state)) return;

  if (input.execution.direction === 'sell') {
    const applied = await client.query<{ id: string }>(
      `SELECT id FROM copy_position_master_lot_reductions WHERE sell_evidence_id = $1`,
      [input.evidence.id]
    );
    if (applied.rows.length > 0) return;
  }

  if (input.execution.exit_lot_id) {
    const reduced = await client.query<{ id: string }>(
      `INSERT INTO copy_position_master_lot_reductions (
         lot_id, sell_execution_id, sell_evidence_id, quantity, proceeds_usd, reduced_at
       )
       SELECT lot.id, $2, $3, $4::numeric, $5::numeric, $6
         FROM copy_position_master_lots lot
        WHERE lot.id = $1 AND lot.position_id = $7
          AND lot.user_id IS NOT DISTINCT FROM $8
          AND lot.remaining_quantity >= $4::numeric
          AND $4::numeric <= $9::numeric - (
            SELECT COALESCE(SUM(quantity), 0) FROM copy_position_master_lot_reductions
             WHERE sell_execution_id = $2 AND sell_evidence_id = $3
          )
       ON CONFLICT (lot_id, sell_evidence_id) DO NOTHING
       RETURNING id`,
      [input.execution.exit_lot_id, input.execution.id, input.evidence.id,
        input.evidence.base_quantity, input.evidence.quote_quantity, input.evidence.occurred_at,
        input.positionId, input.execution.user_id, input.execution.requested_base_quantity]
    );
    if (reduced.rows.length === 0) throw new Error('Lot exit fill exceeds its reserved lot inventory');
    await applyLotReduction(client, input.execution.exit_lot_id, input.evidence.id, input.execution.id);
    return;
  }

  const sourceResult = await client.query<{
    wallet_address: string;
    direction: 'buy' | 'sell';
    signal_id: string | null;
  }>(
    `SELECT source.wallet_address, source.direction, execution.signal_id
       FROM source_trades source
       JOIN copy_executions execution ON execution.source_trade_id = source.id
      WHERE execution.id = $1`,
    [input.execution.id]
  );
  const source = sourceResult.rows[0];
  if (!source) throw new Error(`Source trade for execution ${input.execution.id} does not exist`);

  if (source.direction === 'buy') {
    const costBasisUsd = input.evidence.quote_quantity === null
      ? input.evidence.price_usd === null
        ? null
        : Number(input.evidence.base_quantity) * Number(input.evidence.price_usd)
      : Number(input.evidence.quote_quantity);
    await client.query(
      `INSERT INTO copy_position_master_lots (
         position_id, user_id, master_wallet_address, chain, token_mint, signal_id,
         source_trade_id, acquisition_execution_id, acquisition_evidence_id,
         acquired_quantity, remaining_quantity, acquired_cost_basis_usd,
         remaining_cost_basis_usd, acquired_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10::numeric, $10::numeric, $11::numeric, $11::numeric, $12
       )
       ON CONFLICT (acquisition_evidence_id) DO NOTHING`,
      [
        input.positionId,
        input.execution.user_id,
        source.wallet_address,
        input.execution.chain,
        input.execution.token_mint,
        source.signal_id,
        input.execution.source_trade_id,
        input.execution.id,
        input.evidence.id,
        input.evidence.base_quantity,
        costBasisUsd,
        input.evidence.occurred_at
      ]
    );
    return;
  }

  const lotRows = await client.query<PositionLot & {
    remaining_quantity: string;
    remaining_cost_basis_usd: string | null;
    acquired_at: Date;
    master_wallet_address: string;
  }>(
    `SELECT id,
            master_wallet_address AS "masterWalletAddress",
            remaining_quantity::text,
            remaining_cost_basis_usd::text,
            acquired_at
       FROM copy_position_master_lots
      WHERE position_id = $1
        AND master_wallet_address = $2
        AND remaining_quantity > 0
      ORDER BY acquired_at, id
      FOR UPDATE`,
    [input.positionId, source.wallet_address]
  );
  const lots = lotRows.rows.map((row) => ({
    id: row.id,
    masterWalletAddress: row.masterWalletAddress,
    remainingQuantity: Number(row.remaining_quantity),
    remainingCostBasisUsd: row.remaining_cost_basis_usd === null
      ? null
      : Number(row.remaining_cost_basis_usd),
    acquiredAt: row.acquired_at
  }));
  const allocation = allocateLotsForMasterSell({
    masterWalletAddress: source.wallet_address,
    quantity: Number(input.evidence.base_quantity),
    lots
  });
  assertLotAllocationComplete(allocation);

  for (const reduction of allocation.reductions) {
    const insertedReduction = await client.query<{ id: string }>(
      `INSERT INTO copy_position_master_lot_reductions (
         lot_id, sell_execution_id, sell_evidence_id, quantity, proceeds_usd, reduced_at
       ) VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6)
       ON CONFLICT (lot_id, sell_evidence_id) DO NOTHING
       RETURNING id`,
      [
        reduction.lotId,
        input.execution.id,
        input.evidence.id,
        reduction.quantity,
        input.evidence.quote_quantity === null
          ? null
          : Number(input.evidence.quote_quantity) * reduction.quantity / Number(input.evidence.base_quantity),
        input.evidence.occurred_at
      ]
    );
    if (insertedReduction.rows.length === 0) continue;
    await applyLotReduction(client, reduction.lotId, input.evidence.id, input.execution.id);
  }
}

async function applyLotReduction(
  client: PoolClient,
  lotId: string,
  evidenceId: string,
  executionId: string
): Promise<void> {
  await client.query(
    `UPDATE copy_position_master_lots lot
        SET reduced_quantity = lot.reduced_quantity + reduction.quantity,
            remaining_quantity = lot.remaining_quantity - reduction.quantity,
            remaining_cost_basis_usd = CASE
              WHEN lot.remaining_cost_basis_usd IS NULL THEN NULL
              WHEN lot.remaining_quantity = reduction.quantity THEN 0
              ELSE lot.remaining_cost_basis_usd
                - (lot.remaining_cost_basis_usd / lot.remaining_quantity) * reduction.quantity
            END,
            updated_at = NOW()
       FROM copy_position_master_lot_reductions reduction
      WHERE lot.id = $1
        AND reduction.lot_id = lot.id
        AND reduction.sell_evidence_id = $2
        AND reduction.sell_execution_id = $3`,
    [lotId, evidenceId, executionId]
  );
}

export async function recordCopyExecutionEvidence(
  input: RecordCopyExecutionEvidenceInput
): Promise<RecordCopyExecutionEvidenceResult> {
  return inTransaction((client) => recordCopyExecutionEvidenceWithClient(client, input));
}

export async function recordCopyExecutionEvidenceWithClient(
  client: PoolClient,
  input: RecordCopyExecutionEvidenceInput
): Promise<RecordCopyExecutionEvidenceResult> {
  const executionId = assertIdentifier('executionId', input.executionId, 128);
  const evidenceId = assertIdentifier('evidenceId', input.evidenceId);
  const baseQuantity = decimal('baseQuantity', input.baseQuantity);
  const fillValuation = valuateQuoteLeg(input.quoteLeg);
  const quoteQuantity = optionalDecimal('quoteLeg.usdAmount', fillValuation.usdAmount);
  const quoteNativeQuantity = optionalDecimal(
    'quoteLeg.amount',
    fillValuation.nativeAmount
  );
  const quoteCurrency = fillValuation.currency;
  const quoteNativeUsdPrice = optionalDecimal(
    'quoteLeg.nativeUsdPrice',
    fillValuation.nativeUsdPrice
  );
  const priceUsd = optionalDecimal('priceUsd', input.priceUsd);
  const occurredAt = assertDate('occurredAt', input.occurredAt);
  const observedAt = assertDate('observedAt', input.observedAt ?? new Date());

  const operation = async (): Promise<RecordCopyExecutionEvidenceResult> => {
    const executionResult = await client.query<CopyExecutionDbRow>(
      `SELECT ${COPY_EXECUTION_COLUMNS}
         FROM copy_executions
        WHERE id = $1
        FOR UPDATE`,
      [executionId]
    );
    let execution = executionResult.rows[0];
    if (!execution) throw new Error(`Copy execution ${executionId} does not exist`);
    if (execution.state === 'failed' || execution.state === 'cancelled') {
      throw new Error(`Terminal ${execution.state} execution cannot accept fill evidence`);
    }

    await client.query(
      `INSERT INTO copy_execution_evidence (
         execution_id, evidence_type, evidence_id, base_quantity, quote_quantity,
         quote_native_quantity, quote_currency, quote_native_usd_price,
         price_usd, confirmation_state, completes_execution, occurred_at, observed_at,
         confirmation_updated_at
       ) VALUES (
         $1, $2, $3, $4::numeric, $5::numeric,
         $6::numeric, $7, $8::numeric,
         $9::numeric, $10, $11, $12, $13, $13
       )
       ON CONFLICT (execution_id, evidence_type, evidence_id) DO NOTHING`,
      [
        executionId,
        input.evidenceType,
        evidenceId,
        baseQuantity,
        quoteQuantity,
        quoteNativeQuantity,
        quoteCurrency,
        quoteNativeUsdPrice,
        priceUsd,
        input.confirmationState,
        input.completesExecution,
        occurredAt,
        observedAt
      ]
    );

    const evidenceResult = await client.query<ExecutionEvidenceDbRow>(
      `SELECT
         id,
         execution_id,
         evidence_type,
         evidence_id,
         base_quantity::text AS base_quantity,${EVIDENCE_QUOTE_COLUMNS},
         price_usd::text AS price_usd,
         confirmation_state,
         completes_execution,
         occurred_at,
         (
           base_quantity = $4::numeric
           AND quote_quantity IS NOT DISTINCT FROM $5::numeric
           AND quote_native_quantity IS NOT DISTINCT FROM $6::numeric
           AND quote_currency IS NOT DISTINCT FROM $7
           AND quote_native_usd_price IS NOT DISTINCT FROM $8::numeric
           AND price_usd IS NOT DISTINCT FROM $9::numeric
           AND completes_execution = $10
           AND occurred_at = $11
         ) AS payload_matches
       FROM copy_execution_evidence
       WHERE execution_id = $1 AND evidence_type = $2 AND evidence_id = $3
       FOR UPDATE`,
      [
        executionId,
        input.evidenceType,
        evidenceId,
        baseQuantity,
        quoteQuantity,
        quoteNativeQuantity,
        quoteCurrency,
        quoteNativeUsdPrice,
        priceUsd,
        input.completesExecution,
        occurredAt
      ]
    );
    let evidence = evidenceResult.rows[0];
    if (!evidence) throw new Error('Execution evidence insert did not return a row');
    if (!evidence.payload_matches) {
      throw new Error('Execution evidence identity collision with a different immutable payload');
    }
    if (evidence.confirmation_state !== input.confirmationState) {
      if (canTransitionSourceConfirmation(evidence.confirmation_state, input.confirmationState)) {
        const updatedEvidence = await client.query<ExecutionEvidenceDbRow>(
          `UPDATE copy_execution_evidence
              SET confirmation_state = $2,
                  confirmation_updated_at = $3
            WHERE id = $1
          RETURNING
            id,
            execution_id,
            evidence_type,
            evidence_id,
            base_quantity::text AS base_quantity,${EVIDENCE_QUOTE_COLUMNS},
            price_usd::text AS price_usd,
            confirmation_state,
            completes_execution,
            occurred_at`,
          [evidence.id, input.confirmationState, observedAt]
        );
        evidence = updatedEvidence.rows[0] as ExecutionEvidenceDbRow;
      } else if (!isStaleEvidenceConfirmation(evidence.confirmation_state, input.confirmationState)) {
        throw new Error(
          `Invalid execution evidence transition: ${evidence.confirmation_state} -> ${input.confirmationState}`
        );
      }
    }

    // The tenancy key is read off the execution row rather than taken as an
    // argument: the execution is the authority on who this fill belongs to, and
    // evidence arrives from reconcilers and webhooks that have no user in scope.
    const evidenceUserId = execution.user_id ?? null;
    const positionId = await ensureCopyPosition(
      client,
      execution.target_account,
      execution.chain,
      execution.token_mint,
      evidenceUserId
    );
    // `user_id` on the application row is what makes the copy_positions split
    // real rather than cosmetic: `rebuildCopyPosition` aggregates the ledger
    // from this table, so without the tenancy column here both paper users'
    // evidence would land in each user's position (see 050_copy_tenancy.sql).
    await client.query(
      `INSERT INTO copy_position_applications (
         evidence_id, execution_id, target_account, chain, token_mint, active,
         user_id, position_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (evidence_id) DO UPDATE
         SET active = EXCLUDED.active,
             user_id = EXCLUDED.user_id,
             position_id = EXCLUDED.position_id,
             updated_at = NOW()`,
      [
        evidence.id,
        execution.id,
        execution.target_account,
        execution.chain,
        execution.token_mint,
        isAppliedSourceConfirmation(evidence.confirmation_state),
        evidenceUserId,
        positionId
      ]
    );

    await synchronizePositionLots(client, {
      execution,
      evidence,
      positionId
    });

    // `SUM` skips NULLs, so the old `COALESCE(SUM(quote_quantity), 0)` produced the
    // same confident-looking number whether every confirmed fill was valued in USD,
    // some were, or none were. The two counts alongside the sum are what let
    // `summarizeConfirmedQuoteTotal` tell those three cases apart, so an unknown
    // total can be stored as NULL instead of as a zero nobody can question.
    const totalsResult = await client.query<{
      confirmed_base_quantity: string;
      valued_quote_usd_sum: string | null;
      valued_fill_count: string;
      unvalued_fill_count: string;
      completes_execution: boolean;
    }>(
      `SELECT
         COALESCE(SUM(base_quantity), 0)::text AS confirmed_base_quantity,
         SUM(quote_quantity)::text AS valued_quote_usd_sum,
         COUNT(*) FILTER (WHERE quote_quantity IS NOT NULL)::text AS valued_fill_count,
         COUNT(*) FILTER (WHERE quote_quantity IS NULL)::text AS unvalued_fill_count,
         COALESCE(BOOL_OR(completes_execution), FALSE) AS completes_execution
       FROM copy_execution_evidence
       WHERE execution_id = $1
         AND confirmation_state IN ('confirmed', 'finalized')`,
      [execution.id]
    );
    const totals = totalsResult.rows[0] as {
      confirmed_base_quantity: string;
      valued_quote_usd_sum: string | null;
      valued_fill_count: string;
      unvalued_fill_count: string;
      completes_execution: boolean;
    };
    const confirmedQuoteTotal = summarizeConfirmedQuoteTotal({
      valuedFillCount: Number(totals.valued_fill_count),
      unvaluedFillCount: Number(totals.unvalued_fill_count),
      valuedUsdSum: totals.valued_quote_usd_sum
    });

    const preStatePosition = await rebuildCopyPosition(client, execution);
    const hasConfirmedQuantity = Number(totals.confirmed_base_quantity) > 0;
    const hasLedgerMismatch = Number(preStatePosition.unmatchedReductionQuantity) > 0;
    let desiredState: CopyExecutionState = execution.state;
    if (hasLedgerMismatch || (!hasConfirmedQuantity && evidence.confirmation_state === 'reversed')) {
      desiredState = 'reconciliation_required';
    } else if (hasConfirmedQuantity) {
      desiredState = totals.completes_execution ? 'confirmed' : 'partially_filled';
    }

    if (
      (desiredState === 'partially_filled' || desiredState === 'confirmed')
      && execution.state === 'requested'
    ) {
      execution = await setCopyExecutionState(
        client,
        execution,
        'reconciliation_required',
        'confirmed evidence arrived before submission state was persisted'
      );
    } else if (execution.state === 'confirmed' && desiredState === 'partially_filled') {
      execution = await setCopyExecutionState(
        client,
        execution,
        'reconciliation_required',
        'previously confirmed evidence was reversed'
      );
    }
    execution = await setCopyExecutionState(
      client,
      execution,
      desiredState,
      `${input.evidenceType}:${evidenceId}`
    );

    const updatedExecution = await client.query<CopyExecutionDbRow>(
      `UPDATE copy_executions
          SET confirmed_base_quantity = $2::numeric,
              confirmed_quote_quantity = $3::numeric,
              quote_unassessed_fill_count = $5::integer,
              reserved_base_quantity = CASE
                WHEN direction <> 'sell' OR $4 = 'confirmed' THEN 0
                ELSE GREATEST(0, requested_base_quantity - $2::numeric)
              END,
              next_reconciliation_at = CASE
                WHEN $4 = 'reconciliation_required' THEN COALESCE(next_reconciliation_at, NOW())
                WHEN $4 = 'confirmed' THEN NULL
                ELSE next_reconciliation_at
              END,
              reconciliation_claim_id = CASE WHEN $4 = 'confirmed' THEN NULL ELSE reconciliation_claim_id END,
              reconciliation_claimed_at = CASE WHEN $4 = 'confirmed' THEN NULL ELSE reconciliation_claimed_at END,
              updated_at = NOW()
        WHERE id = $1
      RETURNING ${COPY_EXECUTION_COLUMNS}`,
      [
        execution.id,
        totals.confirmed_base_quantity,
        confirmedQuoteTotal.usdAmount,
        desiredState,
        confirmedQuoteTotal.unvaluedFillCount
      ]
    );
    execution = updatedExecution.rows[0] as CopyExecutionDbRow;
    const position = await rebuildCopyPosition(client, execution);
    if (
      execution.state === 'confirmed'
      && execution.signal_id
      && !execution.exit_lot_id
      && execution.execution_mode !== 'shadow'
    ) {
      await client.query(
        `UPDATE signals
         SET status = 'executed', executed_at = COALESCE(executed_at, NOW())
         WHERE id = $1 AND status IN ('executing', 'eligible', 'alerted')`,
        [execution.signal_id]
      );
    }
    return {
      execution: mapCopyExecution(execution),
      position,
      fillValuation,
      confirmedQuoteTotal
    };
  };
  return operation();
}

export async function getCopyExecutionById(id: string): Promise<CopyExecutionRecord | null> {
  const rows = await query<CopyExecutionDbRow>(
    `SELECT ${COPY_EXECUTION_COLUMNS}
       FROM copy_executions
      WHERE id = $1`,
    [assertIdentifier('id', id, 128)]
  );
  return rows[0] ? mapCopyExecution(rows[0]) : null;
}

export async function getCopyExecutionByClientOrderId(input: {
  chain: Chain;
  targetAccount: string;
  clientOrderId: string;
}): Promise<CopyExecutionRecord | null> {
  const target = resolveChainAddress(input.targetAccount, input.chain);
  const rows = await query<CopyExecutionDbRow>(
    `SELECT ${COPY_EXECUTION_COLUMNS}
       FROM copy_executions
      WHERE chain = $1 AND target_account = $2 AND client_order_id = $3`,
    [input.chain, target.prefixed, assertIdentifier('clientOrderId', input.clientOrderId, 128)]
  );
  return rows[0] ? mapCopyExecution(rows[0]) : null;
}

export async function getCopyExecutionByClientOrderIdentity(input: {
  chain: Chain;
  clientOrderId: string;
}): Promise<CopyExecutionRecord | null> {
  const rows = await query<CopyExecutionDbRow>(
    `SELECT ${COPY_EXECUTION_COLUMNS}
     FROM copy_executions
     WHERE chain = $1 AND client_order_id = $2
     ORDER BY id
     LIMIT 2`,
    [input.chain, assertIdentifier('clientOrderId', input.clientOrderId, 128)]
  );
  if (rows.length > 1) {
    throw new Error('Client order identity is ambiguous across target accounts');
  }
  return rows[0] ? mapCopyExecution(rows[0]) : null;
}

export async function getCopyExecutionBySubmissionIdentity(input: {
  chain: Chain;
  submissionType: 'transaction' | 'order';
  submissionId: string;
}): Promise<CopyExecutionRecord | null> {
  const rows = await query<CopyExecutionDbRow>(
    `SELECT ${COPY_EXECUTION_COLUMNS}
     FROM copy_executions
     WHERE chain = $1 AND submission_type = $2 AND submission_id = $3
     ORDER BY id
     LIMIT 2`,
    [
      input.chain,
      input.submissionType,
      assertIdentifier('submissionId', input.submissionId)
    ]
  );
  if (rows.length > 1) throw new Error('Submission identity is ambiguous');
  return rows[0] ? mapCopyExecution(rows[0]) : null;
}

export async function claimCopyExecutionsForReconciliation(input: {
  chain?: Chain;
  limit?: number;
  staleClaimBefore?: Date;
} = {}): Promise<CopyExecutionRecord[]> {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer between 1 and 100');
  }
  const staleClaimBefore = assertDate(
    'staleClaimBefore',
    input.staleClaimBefore ?? new Date(Date.now() - 5 * 60_000)
  );
  const rows = await query<CopyExecutionDbRow>(
    `WITH candidates AS (
       SELECT id AS candidate_id
       FROM copy_executions
       WHERE state IN ('submitted', 'partially_filled', 'reconciliation_required')
         AND ($1::text IS NULL OR chain = $1)
         AND COALESCE(next_reconciliation_at, submitted_at, requested_at) <= NOW()
         AND reconciliation_attempts < max_reconciliation_attempts
         AND (reconciliation_claimed_at IS NULL OR reconciliation_claimed_at < $2)
       ORDER BY COALESCE(next_reconciliation_at, submitted_at, requested_at), id
       FOR UPDATE SKIP LOCKED
       LIMIT $3
     )
     UPDATE copy_executions execution
        SET reconciliation_claim_id = gen_random_uuid(),
            reconciliation_claimed_at = NOW(),
            reconciliation_attempts = execution.reconciliation_attempts + 1,
            updated_at = NOW()
       FROM candidates
      WHERE execution.id = candidates.candidate_id
     RETURNING ${COPY_EXECUTION_COLUMNS}`,
    [input.chain ?? null, staleClaimBefore, limit]
  );
  return rows.map(mapCopyExecution);
}

export async function releaseCopyExecutionReconciliationClaim(input: {
  executionId: string;
  claimId: string;
  retryAt?: Date | null;
}): Promise<boolean> {
  const retryAt = input.retryAt ? assertDate('retryAt', input.retryAt) : null;
  const rows = await query<{ id: string }>(
    `UPDATE copy_executions
        SET reconciliation_claim_id = NULL,
            reconciliation_claimed_at = NULL,
            next_reconciliation_at = CASE
              WHEN state IN ('confirmed', 'failed', 'cancelled') THEN NULL
              ELSE $3::timestamptz
            END,
            updated_at = NOW()
      WHERE id = $1
        AND reconciliation_claim_id = $2
      RETURNING id`,
    [
      assertIdentifier('executionId', input.executionId, 128),
      assertIdentifier('claimId', input.claimId, 128),
      retryAt
    ]
  );
  return rows.length === 1;
}
