import { query } from './client.js';
/**
 * Upsert a token record. On first insert, optionally populate metadata.
 * On subsequent calls, only updates fields that are provided.
 */
export async function upsertToken(mint, info) {
    if (info) {
        await query(`INSERT INTO tokens (mint, decimals, mint_authority_disabled, freeze_authority_disabled, symbol, name)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (mint) DO UPDATE SET
         decimals = COALESCE(EXCLUDED.decimals, tokens.decimals),
         mint_authority_disabled = COALESCE(EXCLUDED.mint_authority_disabled, tokens.mint_authority_disabled),
         freeze_authority_disabled = COALESCE(EXCLUDED.freeze_authority_disabled, tokens.freeze_authority_disabled),
         symbol = COALESCE(EXCLUDED.symbol, tokens.symbol),
         name = COALESCE(EXCLUDED.name, tokens.name)`, [
            mint,
            info.decimals ?? null,
            info.mintAuthorityDisabled ?? null,
            info.freezeAuthorityDisabled ?? null,
            info.symbol ?? null,
            info.name ?? null
        ]);
    }
    else {
        await query(`INSERT INTO tokens (mint) VALUES ($1) ON CONFLICT (mint) DO NOTHING`, [mint]);
    }
}
export async function getTokenDecimals(mint) {
    const rows = await query(`SELECT decimals FROM tokens WHERE mint = $1`, [mint]);
    return rows[0]?.decimals ?? null;
}
/**
 * Record the earliest observed transaction time for a token as its
 * launch_timestamp. Only moves the value earlier, never later, so the
 * estimate converges on the true launch as more history is ingested.
 *
 * This powers the early-entry component of the wallet composite score.
 */
export async function updateTokenLaunchTimestamp(mint, observedAt) {
    await query(`UPDATE tokens
       SET launch_timestamp = LEAST(COALESCE(launch_timestamp, $2::timestamp), $2::timestamp)
     WHERE mint = $1`, [mint, observedAt]);
}
export async function insertParsedTransaction(input) {
    const rows = await query(`INSERT INTO transactions (
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
    -- Matches the NULL-safe unique index idx_tx_dedup (migration 005) so rows
    -- with a NULL target_token still dedupe on re-ingestion.
    ON CONFLICT (signature, wallet_address, COALESCE(target_token, '')) DO NOTHING
    RETURNING id`, [
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
    ]);
    return rows.length > 0;
}
//# sourceMappingURL=transactions.js.map