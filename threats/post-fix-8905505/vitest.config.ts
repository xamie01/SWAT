import { defineConfig } from '../../node_modules/vitest/dist/config.js';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig({
  root,
  envDir: fileURLToPath(new URL('./tmp', import.meta.url)),
  cacheDir: fileURLToPath(new URL('./cache', import.meta.url)),
  resolve: {
    alias: {
      '@swat/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@swat/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
      'viem': fileURLToPath(new URL('../../apps/api/node_modules/viem', import.meta.url))
    }
  },
  test: {
    include: process.env.REVIEW_EXISTING === '2' ? [
      'apps/api/src/routes/billing.test.ts',
      'apps/api/src/routes/withdraw.test.ts',
      'apps/trade-executor/src/execution-authority-adapters.test.ts',
      'packages/db/src/billing.test.ts',
      'packages/db/src/fanout-eligibility.test.ts'
    ] : process.env.REVIEW_EXISTING === '1' ? [
      'packages/db/src/lot-allocation.test.ts',
      'apps/trade-executor/src/solana-executor-selection.test.ts',
      'packages/shared/src/authority/envelope.test.ts',
      'apps/indexer/src/parse.test.ts',
      'apps/indexer/src/webhook-helpers.test.ts',
      'apps/web/lib/api.test.ts',
      'packages/shared/src/billing.test.ts'
    ] : ['threats/post-fix-8905505/*.test.ts'],
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 10000,
    hookTimeout: 10000,
    setupFiles: [fileURLToPath(new URL('./test-safety.ts', import.meta.url))],
    reporters: ['default', 'json'],
    outputFile: process.env.REVIEW_RESULTS || fileURLToPath(new URL('./focused-results.json', import.meta.url))
  }
});
