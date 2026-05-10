import { query } from './client.js';

export type ParsedTransactionInsert = {
  signature: string;
  walletAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  direction: 'buy' | 'sell';
  targetToken: string;
  programId?: string | null;
  slot?: number | null;
  timestamp: Date;
  blockTime?: number | null;
};

export async function upsertToken(mint: string) {
  await query(
    `INSERT INTO tokens (mint)
     VALUES ($1)
     ON CONFLICT (mint) DO NOTHING`,
    [mint]
  );
}

export async function insertParsedTransaction(input: ParsedTransactionInsert) {
  const rows = await query(
    `INSERT INTO transactions (
      signature,
      wallet_address,
      token_in,
      token_out,
      amount_in,
      amount_out,
      direction,
      target_token,
      program_id,
      slot,
      timestamp,
      block_time
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (signature, wallet_address, target_token) DO NOTHING
    RETURNING id`,
    [
      input.signature,
      input.walletAddress,
      input.tokenIn,
      input.tokenOut,
      input.amountIn,
      input.amountOut,
      input.direction,
      input.targetToken,
      input.programId ?? null,
      input.slot ?? null,
      input.timestamp,
      input.blockTime ?? null
    ]
  );

  return rows.length > 0;
}
