import { query } from './client.js';

export type TradeInsert = {
  signalId?: string | null;
  walletAddress?: string | null;
  tokenMint: string;
  direction: 'buy' | 'sell';
  /** Size of the position in SOL. */
  amountSol?: number | null;
  /** USD value of the position at execution time (the cost basis for a buy). */
  amountUsd?: number | null;
  /** Token amount acquired/sold, in human units (used for mark-to-market). */
  tokenAmount?: number | null;
  /** Token price in USD at execution time. */
  priceUsd?: number | null;
  slippageBps?: number | null;
  signature?: string | null;
  /** 'paper' | 'live' */
  executionMode?: string | null;
  /** 'paper' | 'trojan' | ... */
  executor?: string | null;
  status?: string;
};

/**
 * Persist an executed (or paper-filled) trade.
 *
 * `token_amount` is stored as a NUMERIC so mark-to-market can later compute
 * `pnl = token_amount * current_price - amount_usd`.
 */
export async function insertTrade(input: TradeInsert) {
  const rows = await query<{ id: string }>(
    `INSERT INTO trades (
       signal_id,
       wallet_address,
       token_mint,
       direction,
       amount_sol,
       amount_usd,
       token_amount,
       price_usd,
       slippage_bps,
       signature,
       execution_mode,
       executor,
       status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      input.signalId ?? null,
      input.walletAddress ?? null,
      input.tokenMint,
      input.direction,
      input.amountSol ?? null,
      input.amountUsd ?? null,
      input.tokenAmount ?? null,
      input.priceUsd ?? null,
      input.slippageBps ?? null,
      input.signature ?? null,
      input.executionMode ?? null,
      input.executor ?? null,
      input.status ?? 'filled'
    ]
  );
  return rows[0] ?? null;
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
 * it is not already executing/executed, and returns true if THIS caller won the
 * claim. This is the idempotency guard that prevents a duplicate/re-delivered
 * signal from triggering a second (live) trade — it must be called BEFORE the
 * trade is placed. Returns false if the signal was already claimed/executed.
 */
export async function claimSignalForExecution(signalId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE signals
       SET status = 'executing'
     WHERE id = $1
       AND status NOT IN ('executing', 'executed')
     RETURNING id`,
    [signalId]
  );
  return rows.length > 0;
}

/** Revert a claim back to 'active' when execution fails, so it can be retried. */
export async function releaseSignalClaim(signalId: string) {
  await query(
    `UPDATE signals SET status = 'active' WHERE id = $1 AND status = 'executing'`,
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
         AND status = 'filled'
         AND executed_at > NOW() - make_interval(mins => $2)
     ) AS exists`,
    [tokenMint, withinMinutes]
  );
  return rows[0]?.exists === true;
}
