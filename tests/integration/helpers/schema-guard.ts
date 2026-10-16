import { readdirSync } from 'node:fs';
import { pool } from '../../../packages/db/src/client.js';

/**
 * Fails the suite fast when the integration database is behind the migration
 * set, rather than letting every test fail on its own missing table.
 *
 * This exists because of a real incident: `swat_integration` sat at migration
 * `029` while the tree was at `038`. The suite reported 20 failures across all
 * five files — the loudest of which was a *cleanup* error — which reads like a
 * teardown bug and sent the investigation to the wrong place entirely. The
 * schema was the only thing wrong.
 *
 * It checks the newest migration's table rather than counting applied files
 * because there is no applied-migrations table: `migrate.ts` deliberately
 * replays every file on every run (D16). The schema itself is the only record.
 */

const MIGRATIONS_DIR = new URL('../../../packages/db/sql/', import.meta.url).pathname;

/**
 * Tables that must exist, each introduced by a late migration. Extend this when
 * adding a migration whose absence would be confusing to debug from a test
 * failure — the newest entry is what actually catches staleness.
 */
const REQUIRED_TABLES = [
  'copy_executions',             // 028
  'signal_stop_losses',          // 034
  'copy_eligibility_rejections', // 035
  'users',                       // 039
  'user_sessions',               // 040
  'user_auth_wallets',           // 041
  'user_api_keys',               // 042
  'audit_log',                   // 043
  'user_wallet_subscriptions',   // 044
  'user_token_watches',          // 045
  'user_execution_grants',       // 047
  'user_balances',               // 048
  'user_execution_settings',     // 049
   'user_chain_execution_settings', // 049
   'copy_position_lots',            // 058
  'lp_pools',                    // 059
  'lp_positions',                // 059
  'lp_guardrail_configs',        // 059
  'lp_tracked_wallets'           // 059
] as const;

/** Columns whose absence would otherwise surface as an opaque SQL error. */
const REQUIRED_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['trades', 'venue_settlement_status'], // 038
  // 050. The newest entry is what actually catches staleness, and this one is
  // load-bearing twice over: `copy-position-tenancy.integration.test.ts` asserts
  // the tenancy key directly, so without this guard a database sitting at 046
  // fails that suite with an opaque "column user_id does not exist" — exactly
  // the misdirected investigation this file was written after.
  ['copy_positions', 'user_id'],
  ['copy_position_applications', 'position_id'],
  ['copy_executions', 'user_id'],
  ['trades', 'user_id'],
  // 051. Same reasoning as the 050 entries above: `subscription-states.integration.test.ts`
  // asserts the state CHECK constraints directly, so a database sitting at 050
  // would fail it with an opaque "column state does not exist" rather than the
  // actionable "schema is stale, run migrations" this guard exists to produce.
  ['user_wallet_subscriptions', 'state'],
  // 053. Without this a database at 051 fails the capacity suite with an opaque
  // "relation master_capacity_ledger does not exist".
  ['master_capacity_ledger', 'notional_basis'],
  ['user_wallet_subscriptions', 'active_since'],
  ['copy_position_applications', 'master_wallet_address'],
  ['copy_position_applications', 'lot_id'],
  ['copy_position_lots', 'master_wallet_address'],
  ['lp_positions', 'auto_rebalance']
];

export async function assertIntegrationSchemaCurrent(): Promise<void> {
  const highestMigration = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .at(-1);

  const missing: string[] = [];

  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [[...REQUIRED_TABLES]]
  );
  const present = new Set(tables.rows.map((row) => row.table_name));
  for (const table of REQUIRED_TABLES) {
    if (!present.has(table)) missing.push(`table ${table}`);
  }

  for (const [table, column] of REQUIRED_COLUMNS) {
    const result = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column]
    );
    if (result.rowCount === 0) missing.push(`column ${table}.${column}`);
  }

  if (missing.length > 0) {
    throw new Error(
      `Integration database schema is stale — missing ${missing.join(', ')}.\n`
        + `Latest migration on disk is ${highestMigration}.\n`
        + 'Run migrations against the integration database first:\n'
        + '  DATABASE_URL=$INTEGRATION_DATABASE_URL pnpm db:migrate\n'
        + 'Note: migrations can be blocked by leftover fixture rows from a crashed '
        + 'run; if so the migrate output names the violated constraint.'
    );
  }
}
