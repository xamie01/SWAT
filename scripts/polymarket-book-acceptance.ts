import { runPolymarketBookAcceptance } from '../apps/indexer/src/polymarket-book-acceptance.js';

runPolymarketBookAcceptance().catch((error) => {
  console.error('[POLYMARKET-BOOK] FAILED', error);
  process.exitCode = 1;
});
