import type { PoolClient } from 'pg';
import { normalizeTenantId } from './copy-trade-lifecycle-owned.js';
import { resolveChainAddress, resolveChainValue, type Chain } from '@swat/shared';

export type TradeInsert = {
  signalId?: string | null;
  sourceTradeId?: string | null;
  copyExecutionId?: string | null;
  exitLotId?: string | null;
  /**
   * Owning tenant. Omit or pass `null` for the pre-multi-tenant operator
   * account — `null` is a real, meaningful value here, not a missing one
   * (S4-10, migration 050_copy_tenancy.sql). Do not substitute a placeholder
   * uuid: `normalizeTenantId` rejects anything that is not a uuid or null.
   */
  userId?: string | null;
  walletAddress?: string | null;
  tokenMint: string;
  chain?: Chain | null;
  direction: 'buy' | 'sell';
  /** Size of the position in SOL. */
  amountSol?: number | string | null;
  /** USD value of the position at execution time (the cost basis for a buy). */
  amountUsd?: number | string | null;
  /** Requested USD notional, retained separately when a venue fill is pending or partial. */
  targetAmountUsd?: number | string | null;
  /** Token amount acquired/sold, in human units (used for mark-to-market). */
  tokenAmount?: number | string | null;
  /** Token price in USD at execution time. */
  priceUsd?: number | string | null;
  /** Receipt- or venue-derived execution fees in USD. */
  feeUsd?: number | string | null;
  slippageBps?: number | null;
  signature?: string | null;
  /** 'paper' | 'live' */
  executionMode?: string | null;
  /** 'paper' | 'trojan' | 'jupiter-sim' | ... */
  executor?: string | null;
  status?: string;
  errorMessage?: string | null;
  /** Venue-assigned order identity; never substitute this for an on-chain signature. */
  venueOrderId?: string | null;
  venueStatus?: string | null;
  venueTradeIds?: string[];
  settlementTransactionHashes?: string[];
  /** Link a simulated trade to the real live trade it is shadowing */
  shadowOf?: string | null;

  // ── Jupiter simulation fields (paper trades only) ─────────────────────
  /** Price impact the swap would cause (e.g. 0.45 = 0.45 %). */
  priceImpactPct?: number | null;
  /** Full Jupiter route plan (DEX hops, amounts, fees). */
  routeInfo?: unknown | null;
  /** Solana slot at which the Jupiter quote was computed. */
  quoteSlot?: number | null;
  /** Minimum output after slippage, in human token units. */
  minTokenAmount?: number | string | null;
  
  submittedAt?: Date | null;
  confirmedAt?: Date | null;
};

/**
 * Persist an executed (or paper-filled) trade.
 *
 * `token_amount` is stored as a NUMERIC so mark-to-market can later compute
 * `pnl = token_amount * current_price - amount_usd`.
 */
const INSERT_TRADE_SQL = `INSERT INTO trades (
   signal_id,
   wallet_address,
   token_mint,
   chain,
   direction,
   amount_sol,
   amount_usd,
   token_amount,
   price_usd,
   fee_usd,
   slippage_bps,
   signature,
   execution_mode,
   executor,
   status,
   error_message,
   price_impact_pct,
   route_info,
   quote_slot,
   min_token_amount,
   venue_order_id,
   venue_status,
   venue_trade_ids,
   settlement_transaction_hashes,
   shadow_of,
   submitted_at,
   confirmed_at,
   source_trade_id,
   copy_execution_id,
   target_amount_usd,
   user_id,
   exit_lot_id
 )
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32)
 ON CONFLICT (copy_execution_id) WHERE copy_execution_id IS NOT NULL
 DO UPDATE SET
   signature = COALESCE(EXCLUDED.signature, trades.signature),
   status = EXCLUDED.status,
   error_message = EXCLUDED.error_message,
   amount_sol = EXCLUDED.amount_sol,
   amount_usd = EXCLUDED.amount_usd,
   token_amount = COALESCE(EXCLUDED.token_amount, trades.token_amount),
   price_usd = COALESCE(EXCLUDED.price_usd, trades.price_usd),
   fee_usd = COALESCE(EXCLUDED.fee_usd, trades.fee_usd),
   slippage_bps = COALESCE(EXCLUDED.slippage_bps, trades.slippage_bps),
   venue_order_id = COALESCE(EXCLUDED.venue_order_id, trades.venue_order_id),
   venue_status = COALESCE(EXCLUDED.venue_status, trades.venue_status),
   venue_trade_ids = EXCLUDED.venue_trade_ids,
   settlement_transaction_hashes = EXCLUDED.settlement_transaction_hashes,
   target_amount_usd = COALESCE(trades.target_amount_usd, EXCLUDED.target_amount_usd),
   -- Tenant order is deliberate: trades.user_id first, so a re-upsert can only
   -- ever FILL IN a missing tenant (an expand-phase operator row) and can never
   -- silently reattribute financial history from one user to another. The
   -- conflict target copy_execution_id is already tenant-scoped, so a differing
   -- EXCLUDED.user_id would mean corruption upstream, not an update.
   -- (No backticks in this comment: the whole statement is a TS template
   -- literal, and a backtick here terminates it.)
   user_id = COALESCE(trades.user_id, EXCLUDED.user_id),
   submitted_at = COALESCE(trades.submitted_at, EXCLUDED.submitted_at),
   confirmed_at = COALESCE(EXCLUDED.confirmed_at, trades.confirmed_at)
 WHERE trades.user_id IS NOT DISTINCT FROM EXCLUDED.user_id
   AND trades.signal_id IS NOT DISTINCT FROM EXCLUDED.signal_id
   AND trades.source_trade_id IS NOT DISTINCT FROM EXCLUDED.source_trade_id
   AND trades.exit_lot_id IS NOT DISTINCT FROM EXCLUDED.exit_lot_id
   AND trades.token_mint = EXCLUDED.token_mint AND trades.chain = EXCLUDED.chain
   AND trades.direction = EXCLUDED.direction AND trades.execution_mode IS NOT DISTINCT FROM EXCLUDED.execution_mode
 RETURNING id`;

export function validatedFeeUsd(input: TradeInsert): number | string | null {
  const feeUsd = input.feeUsd ?? null;
  if (feeUsd !== null && (typeof feeUsd === 'string'
    ? feeUsd.length > 256 || !/^\d+(?:\.\d+)?$/.test(feeUsd)
    : !Number.isFinite(feeUsd) || feeUsd < 0)) {
    throw new Error('feeUsd must be a finite non-negative number');
  }
  return feeUsd;
}

export function prepareTradeInsert(input: TradeInsert) {
  const resolvedToken = resolveChainValue(input.tokenMint, input.chain ?? undefined);
  const chain = resolvedToken.chain;
  const tokenMint = resolvedToken.prefixed;
  const feeUsd = validatedFeeUsd(input);
  const walletAddress = input.walletAddress
    ? resolveChainAddress(input.walletAddress, chain).prefixed
    : null;
  return [
    input.signalId ?? null,
    walletAddress,
    tokenMint,
    chain,
    input.direction,
    input.amountSol ?? null,
    input.amountUsd ?? null,
    input.tokenAmount ?? null,
    input.priceUsd ?? null,
    feeUsd,
    input.slippageBps ?? null,
    input.signature ?? null,
    input.executionMode ?? null,
    input.executor ?? null,
    input.status ?? 'filled',
    input.errorMessage ?? null,
    input.priceImpactPct ?? null,
    input.routeInfo ? JSON.stringify(input.routeInfo) : null,
    input.quoteSlot ?? null,
    input.minTokenAmount ?? null,
    input.venueOrderId ?? null,
    input.venueStatus ?? null,
    JSON.stringify(input.venueTradeIds ?? []),
    JSON.stringify(input.settlementTransactionHashes ?? []),
    input.shadowOf ?? null,
    input.submittedAt ?? null,
    input.confirmedAt ?? null,
    input.sourceTradeId ?? null,
    input.copyExecutionId ?? null,
    input.targetAmountUsd ?? null,
    normalizeTenantId(input.userId),
    input.exitLotId ?? null
  ];
}

/** Snapshot/validate values before acquisition; both public insert paths share
 * this SQL operation and never re-serialize a caller payload after acquisition. */
export function prepareTradeInsertOperation(input: TradeInsert) {
  const values = prepareTradeInsert(input);
  return async (client: PoolClient) => {
    const result = await client.query<{ id: string }>(INSERT_TRADE_SQL, values);
    return result.rows[0] ?? null;
  };
}

export async function insertTradeWithClient(client: PoolClient, input: TradeInsert) {
  return prepareTradeInsertOperation(input)(client);
}

