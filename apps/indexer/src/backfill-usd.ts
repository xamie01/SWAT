import { query } from '@swat/db';
import { fetchTokenPriceUsd } from '@swat/shared';

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
  let updated = 0;
  
  for (const tx of txs) {
    let amountInUsd: number | null = null;
    let amountOutUsd: number | null = null;
    
    const tokenIn = tx.token_in;
    const tokenOut = tx.token_out;
    const amountIn = Number(tx.amount_in);
    const amountOut = Number(tx.amount_out);
    
    // For MVP historical backfill without a dedicated historical price API,
    // we use the current SOL price to approximate the fiat value.
    const currentSolPrice = await fetchTokenPriceUsd(SOL_MINT) ?? 150;
    
    if (tokenIn === SOL_MINT) {
      amountInUsd = (amountIn / 1e9) * currentSolPrice;
      amountOutUsd = amountInUsd;
    } else if (tokenOut === SOL_MINT) {
      amountOutUsd = (amountOut / 1e9) * currentSolPrice;
      amountInUsd = amountOutUsd;
    } else if (tokenIn === USDC_MINT) {
      amountInUsd = amountIn / 1e6;
      amountOutUsd = amountInUsd;
    } else if (tokenOut === USDC_MINT) {
      amountOutUsd = amountOut / 1e6;
      amountInUsd = amountOutUsd;
    }
    
    if (amountInUsd !== null && amountOutUsd !== null) {
      await query(`UPDATE transactions SET amount_in_usd = $1, amount_out_usd = $2 WHERE id = $3`, 
        [amountInUsd, amountOutUsd, tx.id]);
      updated++;
    }
    
    // Throttle to avoid rate limits
    await new Promise(r => setTimeout(r, 100));
  }
  
  console.log(`[backfill-usd] Complete. Updated ${updated} transactions.`);
  process.exit(0);
}

run().catch(e => {
  console.error('[backfill-usd] Error:', e);
  process.exit(1);
});
