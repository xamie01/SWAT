import { assertPackage28IsolationPreflight } from './tests/integration/helpers/package28-isolation.js';

// Fail before environment-file loading, config dependencies, worker collection or
// globalSetup can import/construct a database or Redis client. No fallback URL.
assertPackage28IsolationPreflight(process.env);
const { defineConfig } = await import('vitest/config');

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.integration.test.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
