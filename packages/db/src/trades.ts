import { pool, query } from './client.js';
import { resolveChainAddress, resolveChainValue } from '@swat/shared';
import type { Chain } from '@swat/shared';

export type TradeInsert = {
  signalId?: string | null;
  sourceTradeId?: string | null;
  copyExecutionId?: string | null;
  walletAddress?: string | null;
  tokenMint: string;
  chain?: Chain | null;
  direction: 'buy' | 'sell';
  /** Size of the position in SOL. */
  amountSol?: number | null;
  /** USD value of the position at execution time (the cost basis for a buy). */
  amountUsd?: number | null;
  /** Requested USD notional, retained separately when a venue fill is pending or partial. */
  targetAmountUsd?: number | null;
  /** Token amount acquired/sold, in human units (used for mark-to-market). */
  tokenAmount?: number | null;
  /** Token price in USD at execution time. */
  priceUsd?: number | null;
  /** Receipt- or venue-derived execution fees in USD. */
  feeUsd?: number | null;
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
  minTokenAmount?: number | null;
  
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
   target_amount_usd
 )
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
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
   submitted_at = COALESCE(trades.submitted_at, EXCLUDED.submitted_at),
   confirmed_at = COALESCE(EXCLUDED.confirmed_at, trades.confirmed_at)
 RETURNING id`;

function validatedFeeUsd(input: TradeInsert): number | null {
  const feeUsd = input.feeUsd ?? null;
  if (feeUsd !== null && (!Number.isFinite(feeUsd) || feeUsd < 0)) {
    throw new Error('feeUsd must be a finite non-negative number');
  }
  return feeUsd;
}

function getTradeValues(input: TradeInsert) {
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
    input.targetAmountUsd ?? null
  ];
}

export async function insertTrade(input: TradeInsert) {
  const rows = await query<{ id: string }>(INSERT_TRADE_SQL, getTradeValues(input));
  return rows[0] ?? null;
}

/**
 * Persist a filled trade and mark its signal executed in one transaction.
 * Locking the signal also makes retry recovery idempotent: if a previous
 * attempt committed the trade, a retry only repairs the signal status.
 */
export async function insertTradeAndMarkSignalExecuted(
  input: TradeInsert & { signalId: string }
) {
  const status = input.status ?? 'filled';
  if (status !== 'filled' && status !== 'partial') {
    throw new Error(`Cannot mark signal executed from unconfirmed trade status: ${status}`);
  }
  if (input.executionMode === 'shadow') {
    throw new Error('Shadow trades cannot mark signals executed');
  }
  validatedFeeUsd(input);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const signal = await client.query<{ id: string }>(
      `SELECT id FROM signals WHERE id = $1 FOR UPDATE`,
      [input.signalId]
    );
    if (signal.rowCount !== 1) {
      throw new Error(`Signal ${input.signalId} does not exist`);
    }

    const existing = await client.query<{ id: string }>(
      `SELECT id
         FROM trades
        WHERE signal_id = $1
          AND direction = $2
          AND status IN ('filled', 'partial')
          AND (execution_mode IS NULL OR execution_mode != 'shadow')
        ORDER BY executed_at DESC
        LIMIT 1`,
      [input.signalId, input.direction]
    );

    let trade = existing.rows[0] ?? null;
    if (!trade) {
      const inserted = await client.query<{ id: string }>(
        INSERT_TRADE_SQL,
        getTradeValues({ ...input, status })
      );
      trade = inserted.rows[0] ?? null;
    }

    await client.query(
      `UPDATE signals
          SET status = 'executed',
              executed_at = NOW()
        WHERE id = $1`,
      [input.signalId]
    );
    await client.query('COMMIT');
    return trade;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Persist a terminal non-fill attempt and release its execution claim atomically. */
export async function insertTradeAndReleaseSignalClaim(
  input: TradeInsert & { signalId: string; status: string }
) {
  if (input.status === 'filled' || input.status === 'partial') {
    throw new Error('Confirmed trade quantities must execute their signal instead of releasing its claim');
  }
  if (input.executionMode === 'shadow') {
    throw new Error('Shadow trades do not own signal claims');
  }
  validatedFeeUsd(input);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const signal = await client.query<{ id: string }>(
      `SELECT id FROM signals WHERE id = $1 FOR UPDATE`,
      [input.signalId]
    );
    if (signal.rowCount !== 1) {
      throw new Error(`Signal ${input.signalId} does not exist`);
    }

    const inserted = await client.query<{ id: string }>(
      INSERT_TRADE_SQL,
      getTradeValues(input)
    );
    await client.query(
      `UPDATE signals
          SET status = 'pending'
        WHERE id = $1
          AND status = 'executing'`,
      [input.signalId]
    );
    await client.query('COMMIT');
    return inserted.rows[0] ?? null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Advance a signal's lifecycle status (e.g. to 'executed' once a trade fills).
 */
export async function markSignalExecuted(signalId: string) {
  await query(
    `UPDATE signals
       SET status = 'executed',
           executed_at = NOW()
     WHERE id = $1`,
    [signalId]
  );
}

/**
 * Atomically claim a signal for execution. Sets status to 'executing' only if
 * it is pending, and returns true if THIS caller won the
 * claim. This is the idempotency guard that prevents a duplicate/re-delivered
 * signal from triggering a second (live) trade — it must be called BEFORE the
 * trade is placed. Returns false if the signal was already claimed/executed.
 */
export async function claimSignalForExecution(signalId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE signals
       SET status = 'executing'
     WHERE id = $1
       AND status = 'pending'
     RETURNING id`,
    [signalId]
  );
  return rows.length > 0;
}

/** Revert a claim back to pending when execution fails, so it can be retried. */
export async function releaseSignalClaim(signalId: string) {
  await query(
    `UPDATE signals SET status = 'pending' WHERE id = $1 AND status = 'executing'`,
    [signalId]
  );
}

/**
 * Whether a filled buy for this token was placed within the last N minutes.
 * Used by the executor to suppress re-buying a token the system just bought
 * (a held position keeps re-triggering snipe signals after the dedupe window).
 */
export async function hasRecentBuy(tokenMint: string, withinMinutes: number): Promise<boolean> {
  const rows = await query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM trades
       WHERE token_mint = $1
         AND direction = 'buy'
         AND status IN ('filled', 'partial')
         AND (execution_mode IS NULL OR execution_mode != 'shadow')
         AND executed_at > NOW() - make_interval(mins => $2)
     ) AS exists`,
    [tokenMint, withinMinutes]
  );
  return rows[0]?.exists === true;
}

/**
 * Calculates the total USD exposure traded on a given chain in the last 24 hours.
 */
export async function getRollingExposureUsd(chain: string): Promise<number> {
  const rows = await query<{ total_usd: string | null }>(
    `SELECT SUM(amount_usd) AS total_usd
     FROM trades
     WHERE chain = $1
       AND direction = 'buy'
       AND status IN ('filled', 'partial')
       AND (execution_mode IS NULL OR execution_mode != 'shadow')
       AND executed_at > NOW() - INTERVAL '24 hours'`,
    [chain]
  );
  return parseFloat(rows[0]?.total_usd || '0');
}
