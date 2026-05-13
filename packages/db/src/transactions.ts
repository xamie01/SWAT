import { query } from './client.js';

export type ParsedTransactionInsert = {
  signature: string;
  walletAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  amountInUsd?: number | null;
  amountOutUsd?: number | null;
  direction: 'buy' | 'sell';
  targetToken: string;
  programId?: string | null;
  slot?: number | null;
  timestamp: Date;
  blockTime?: number | null;
};

export type TokenMintInfo = {
  decimals?: number | null;
  mintAuthorityDisabled?: boolean | null;
  freezeAuthorityDisabled?: boolean | null;
  symbol?: string | null;
  name?: string | null;
};

/**
 * Upsert a token record. On first insert, optionally populate metadata.
 * On subsequent calls, only updates fields that are provided.
 */
export async function upsertToken(mint: string, info?: TokenMintInfo) {
  if (info) {
    await query(
      `INSERT INTO tokens (mint, decimals, mint_authority_disabled, freeze_authority_disabled, symbol, name)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (mint) DO UPDATE SET
         decimals = COALESCE(EXCLUDED.decimals, tokens.decimals),
         mint_authority_disabled = COALESCE(EXCLUDED.mint_authority_disabled, tokens.mint_authority_disabled),
         freeze_authority_disabled = COALESCE(EXCLUDED.freeze_authority_disabled, tokens.freeze_authority_disabled),
         symbol = COALESCE(EXCLUDED.symbol, tokens.symbol),
         name = COALESCE(EXCLUDED.name, tokens.name)`,
      [
        mint,
        info.decimals ?? null,
        info.mintAuthorityDisabled ?? null,
        info.freezeAuthorityDisabled ?? null,
        info.symbol ?? null,
        info.name ?? null
      ]
    );
  } else {
    await query(
      `INSERT INTO tokens (mint) VALUES ($1) ON CONFLICT (mint) DO NOTHING`,
      [mint]
    );
  }
}

export async function getTokenDecimals(mint: string): Promise<number | null> {
  const rows = await query<{ decimals: number | null }>(
    `SELECT decimals FROM tokens WHERE mint = $1`,
    [mint]
  );
  return rows[0]?.decimals ?? null;
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
      amount_in_usd,
      amount_out_usd,
      direction,
      target_token,
      program_id,
      slot,
      timestamp,
      block_time
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (signature, wallet_address, target_token) DO NOTHING
    RETURNING id`,
    [
      input.signature,
      input.walletAddress,
      input.tokenIn,
      input.tokenOut,
      input.amountIn,
      input.amountOut,
      input.amountInUsd ?? null,
      input.amountOutUsd ?? null,
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
