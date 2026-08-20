import { assertIntegrationSchemaCurrent } from './helpers/schema-guard.js';
import { closePool } from '../../packages/db/src/client.js';

/**
 * Runs once before any integration file. Guards the schema so a stale database
 * fails with one actionable message instead of N per-test failures.
 */
export async function setup(): Promise<void> {
  try {
    await assertIntegrationSchemaCurrent();
  } finally {
    // globalSetup runs in its own module context from the test files, so the
    // pool opened here is not the one they use and must be closed or vitest
    // hangs on an open handle.
    await closePool();
  }
}
