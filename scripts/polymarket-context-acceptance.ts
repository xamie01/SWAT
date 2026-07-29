import { runPolymarketContextAcceptance } from '../apps/indexer/src/polymarket-context-acceptance.js';

runPolymarketContextAcceptance().catch((error) => {
  console.error('[POLYMARKET-CONTEXT] FAILED', error);
  process.exitCode = 1;
});
