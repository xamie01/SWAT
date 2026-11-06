import { defineConfig } from '../node_modules/vitest/dist/config.js';
import { fileURLToPath } from 'node:url';
const source = (path: string) => fileURLToPath(new URL('../' + path, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      '@swat/db': source('packages/db/src/index.ts'),
      '@swat/shared': source('packages/shared/src/index.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx', 'tests/integration/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
    reporters: ['default', 'json'],
    outputFile: process.env.REVIEW_TEST_JSON || 'threats/runtime/tests.json'
  }
});
