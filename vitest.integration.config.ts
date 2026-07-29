import 'dotenv/config';
import { defineConfig } from 'vitest/config';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'INTEGRATION_DATABASE_URL is required (DATABASE_URL is accepted only for a dedicated test database)'
  );
}

const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
if (!/(?:^|_)(?:integration|test)$/.test(databaseName)) {
  throw new Error(
    `Refusing to run integration tests against non-test database "${databaseName}"; `
      + 'use a database whose name ends in _integration or _test'
  );
}

process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.TRADING_MODE = 'paper';
process.env.AUTO_EXECUTE = 'false';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.integration.test.ts'],
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
