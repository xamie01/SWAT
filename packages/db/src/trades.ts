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
