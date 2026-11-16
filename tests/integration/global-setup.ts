import { assertIntegrationSchemaCurrent } from './helpers/schema-guard.js';

/**
 * Runs once before any integration file. Guards the schema so a stale database
 * fails with one actionable message instead of N per-test failures.
 */
export async function setup(): Promise<void> {
  await assertIntegrationSchemaCurrent();
}
