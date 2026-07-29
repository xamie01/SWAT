import { runG0D11Acceptance } from '../apps/indexer/src/g0-d11-acceptance.js';

runG0D11Acceptance().catch((error) => {
  console.error('[G0-D11] FAILED', error);
  process.exitCode = 1;
});
