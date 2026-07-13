import { query } from './client.js';

export type TransactionChain = 'solana' | 'polygon' | 'robinhood-chain';

export type ParsedTransactionInsert = {
  chain?: TransactionChain;
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
  chain?: TransactionChain;
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
  const chain = info?.chain ?? 'solana';
  if (info) {
    await query(
      `INSERT INTO tokens (mint, chain, decimals, mint_authority_disabled, freeze_authority_disabled, symbol, name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (mint) DO UPDATE SET
         chain = COALESCE(EXCLUDED.chain, tokens.chain),
         decimals = COALESCE(EXCLUDED.decimals, tokens.decimals),
         mint_authority_disabled = COALESCE(EXCLUDED.mint_authority_disabled, tokens.mint_authority_disabled),
         freeze_authority_disabled = COALESCE(EXCLUDED.freeze_authority_disabled, tokens.freeze_authority_disabled),
         symbol = COALESCE(EXCLUDED.symbol, tokens.symbol),
         name = COALESCE(EXCLUDED.name, tokens.name)`,
      [
        mint,
        chain,
        info.decimals ?? null,
        info.mintAuthorityDisabled ?? null,
        info.freezeAuthorityDisabled ?? null,
        info.symbol ?? null,
        info.name ?? null
      ]
    );
  } else {
    await query(
      `INSERT INTO tokens (mint, chain) VALUES ($1, $2) ON CONFLICT (mint) DO NOTHING`,
      [mint, chain]
    );
  }
}

export async function getTokenDecimals(mint: string, chain: TransactionChain = 'solana'): Promise<number | null> {
  const rows = await query<{ decimals: number | null }>(
    `SELECT decimals FROM tokens WHERE mint = $1 AND chain = $2`,
    [mint, chain]
  );
  return rows[0]?.decimals ?? null;
}

/**
 * Record the earliest observed transaction time for a token as its
 * launch_timestamp. Only moves the value earlier, never later, so the
 * estimate converges on the true launch as more history is ingested.
 *
 * This powers the early-entry component of the wallet composite score.
 */
export async function updateTokenLaunchTimestamp(mint: string, observedAt: Date, chain: TransactionChain = 'solana') {
  await query(
    `UPDATE tokens
       SET launch_timestamp = LEAST(COALESCE(launch_timestamp, $2::timestamp), $2::timestamp)
     WHERE mint = $1
       AND chain = $3`,
    [mint, observedAt, chain]
  );
}

export async function insertParsedTransaction(input: ParsedTransactionInsert) {
  const rows = await query(
    `INSERT INTO transactions (
      signature,
      chain,
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
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    -- Matches the NULL-safe unique index idx_tx_dedup (migration 005) so rows
    -- with a NULL target_token still dedupe on re-ingestion.
    ON CONFLICT (chain, signature, wallet_address, COALESCE(target_token, '')) DO NOTHING
    RETURNING id`,
    [
      input.signature,
      input.chain ?? 'solana',
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
