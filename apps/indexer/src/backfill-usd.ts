import { query } from '@swat/db';
import { fetchTokenPriceUsd } from '@swat/shared';
import { baseUnitsToFloat } from './parse.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function run() {
  console.log('[backfill-usd] Starting...');
  const txs = await query<{ id: string, token_in: string, token_out: string, amount_in: string, amount_out: string }>(
    `SELECT id, token_in, token_out, amount_in, amount_out
     FROM transactions
     WHERE amount_in_usd IS NULL OR amount_out_usd IS NULL`
  );

  console.log(`[backfill-usd] Found ${txs.length} transactions to update.`);

  // Fetch the SOL price ONCE for the whole run instead of per-row. If the price
  // feed is unavailable we skip SOL-leg rows rather than fabricating a value —
  // they stay NULL and a later run can fill them with a real price.
  const solPrice = await fetchTokenPriceUsd(SOL_MINT);
  if (solPrice === null) {
    console.warn('[backfill-usd] SOL price unavailable — SOL-leg rows will be skipped this run.');
  }

  let updated = 0;
  let skippedNoPrice = 0;
  let skippedUnsupported = 0;

  for (const tx of txs) {
    let amountInUsd: number | null = null;
    let amountOutUsd: number | null = null;

    const tokenIn = tx.token_in;
    const tokenOut = tx.token_out;

    if (tokenIn === SOL_MINT || tokenOut === SOL_MINT) {
      if (solPrice === null) { skippedNoPrice++; continue; }
      if (tokenIn === SOL_MINT) {
        amountInUsd = baseUnitsToFloat(tx.amount_in, 9) * solPrice;
        amountOutUsd = amountInUsd;
      } else {
        amountOutUsd = baseUnitsToFloat(tx.amount_out, 9) * solPrice;
        amountInUsd = amountOutUsd;
      }
    } else if (tokenIn === USDC_MINT) {
      amountInUsd = baseUnitsToFloat(tx.amount_in, 6);
      amountOutUsd = amountInUsd;
    } else if (tokenOut === USDC_MINT) {
      amountOutUsd = baseUnitsToFloat(tx.amount_out, 6);
      amountInUsd = amountOutUsd;
    } else {
      // Token↔token rows aren't priced by this script; count them so we don't
      // appear to have "finished" when some rows remain unenriched.
      skippedUnsupported++;
      continue;
    }

    if (amountInUsd !== null && amountOutUsd !== null) {
      await query(`UPDATE transactions SET amount_in_usd = $1, amount_out_usd = $2 WHERE id = $3`,
        [amountInUsd, amountOutUsd, tx.id]);
      updated++;
    }
  }

  console.log(`[backfill-usd] Complete. Updated ${updated}, skipped ${skippedNoPrice} (no SOL price), ${skippedUnsupported} (token↔token unsupported).`);
  process.exit(0);
}

run().catch(e => {
  console.error('[backfill-usd] Error:', e);
  process.exit(1);
});
