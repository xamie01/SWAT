import { defineConfig } from '../../node_modules/vitest/dist/config.js';
import { fileURLToPath } from 'node:url';

// Explicit pure/mocked neighbors only; never include rls/integration/service suites.
const package09Neighbors = (process.env.REVIEW_RESULTS ?? '').includes('/package09-')
  ? ['client-runtime', 'client-pools', 'transaction', 'evm-nonce', 'migrations'].map(name => `packages/db/src/${name}.test.ts`) : [];

const package10Neighbors = (process.env.REVIEW_RESULTS ?? '').includes('/package10-')
  ? ['parse', 'webhook-helpers', 'solana-parity', 'solana-source-lifecycle', 'webhook-source-lifecycle', 'source-trade-lifecycle']
    .map(name => `apps/indexer/src/${name}.test.ts`) : [];
const package11Neighbors = (process.env.REVIEW_RESULTS ?? '').includes('/package11-')
  ? [
    ...['polymarket', 'polymarket-helpers', 'robinhood-ingestion', 'evm-source-lifecycle', 'ingestion-health', 'solana-source-lifecycle', 'webhook-source-lifecycle', 'source-trade-lifecycle'].map(name => `apps/indexer/src/${name}.test.ts`),
    'packages/shared/src/ingestion-health.test.ts',
    'packages/db/src/ingestion-health.test.ts',
    'apps/alert-service/src/ingestion-health.test.ts'
  ] : [];
const root = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig({
  root,
  envDir: fileURLToPath(new URL('./empty-env', import.meta.url)),
  cacheDir: fileURLToPath(new URL('./cache', import.meta.url)),
  resolve: {
    alias: {
      '@swat/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@swat/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
      'viem': fileURLToPath(new URL('../../apps/api/node_modules/viem', import.meta.url)),
      '@solana/web3.js': fileURLToPath(new URL('../../packages/shared/node_modules/@solana/web3.js', import.meta.url))
    }
  },
  test: {
    include: [...package09Neighbors, ...package10Neighbors, ...package11Neighbors, 'apps/api/src/routes/*.sequential.test.ts', 'packages/db/src/*.sequential.test.ts', 'apps/web/lib/*.sequential.test.ts', 'packages/shared/src/**/*.sequential.test.ts', 'pda-test-ui/*.sequential.test.ts', 'apps/indexer/src/**/*.sequential.test.ts', 'apps/scorer/src/**/*.sequential.test.ts'],
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
