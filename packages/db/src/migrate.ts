import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDirectAdvisoryLock } from './direct-session.js';
import { discoverMigrations, migrationProfileFromEnv, type MigrationFile } from './migration-discovery.js';
import { assertInstallationBootstrap, assertInstallationHistory, createInstallationPlan, type InstallationPlan } from './installation-plan.js';
import type { ReviewedMigrationSelection } from './migration-selection.js';

const __filename = fileURLToPath(import.meta.url);
const hash = /^[a-f0-9]{64}$/;
type History = { file: string; checksum: string; installed_checksum: string; audit_reference: string | null };
export type MigrationBaseline = {
  database: string;
  auditReference: string;
  migrations: { file: string; checksum: string; installedChecksum: string }[];
};
export type MigrationOptions = {
  sqlDir?: string;
  initialize?: boolean;
  quiesced?: boolean;
  baseline?: MigrationBaseline;
  selection?: ReviewedMigrationSelection;
};

function checkHistory(history: History[], migrations: MigrationFile[], plan: InstallationPlan | null): void {
  if (plan) { assertInstallationHistory(history, plan); return; }
  for (let i = 0; i < history.length; i++) {
    const row = history[i];
    if (row.file !== migrations[i]?.file || row.checksum !== migrations[i]?.checksum
        || !hash.test(row.installed_checksum)
        || (row.installed_checksum !== row.checksum && !row.audit_reference?.trim())) {
      throw new Error('Migration journal checksum/history is not an exact source prefix; refuse replay');
    }
  }
}

function auditedBaseline(value: MigrationBaseline, database: string, migrations: MigrationFile[], plan: InstallationPlan | null): History[] {
  if (!value || value.database !== database || typeof value.auditReference !== 'string'
      || !value.auditReference.trim() || value.auditReference.length > 2000
      || !Array.isArray(value.migrations) || !value.migrations.length) throw new Error('Invalid audited baseline');
  if (plan && value.auditReference !== plan.auditReference) throw new Error('Baseline audit differs from reviewed installation plan');
  const rows = value.migrations.map((row, index) => ({ file: row?.file, checksum: row?.checksum,
    installed_checksum: row?.installedChecksum, audit_reference: plan ? plan.migrations[index]?.auditReference ?? null : value.auditReference }));
  try { checkHistory(rows, migrations, plan); } catch { throw new Error('Invalid baseline prefix/checksum'); }
  return rows;
}

/** Import-safe, no credential loading. Adoption journals only; apply is a separate invocation.
 * Both use the legacy lock key 1 so an old runner cannot race a new runner.
 */
export async function runMigrations(options: MigrationOptions = {}): Promise<void> {
  const migrations = await discoverMigrations(options.sqlDir ?? resolve(dirname(__filename), '../sql'), undefined, undefined, options.selection);
  const plan = options.selection ? createInstallationPlan(migrations, {
    selection: options.selection, auditReference: options.selection.auditReference
  }) : null;
  const outcome = await withDirectAdvisoryLock('migration', 1, async client => {
    const { rows: state } = await client.query("SELECT to_regclass('public.swat_schema_migrations') AS journal, current_database() AS database");
    if (state.length !== 1 || typeof state[0].database !== 'string') throw new Error('Cannot establish migration journal state');
    const exists = state[0].journal !== null;
    const history: History[] = exists
      ? (await client.query<History>('SELECT file, checksum, installed_checksum, audit_reference FROM public.swat_schema_migrations ORDER BY file')).rows : [];
    checkHistory(history, migrations, plan);
    let adopting: History[] | undefined;
    if (options.baseline) {
      if (history.length || options.initialize) throw new Error('Baseline adoption requires an untracked database and no initialization');
      adopting = auditedBaseline(options.baseline, state[0].database, migrations, plan);
    } else if (!history.length) {
      const bootstrap = plan ? await assertInstallationBootstrap(client, plan) : null;
      // Any user schema relation or routine is evidence of an existing DB, not its version.
      const { rows } = await client.query(`SELECT (
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
            AND n.nspname NOT LIKE 'pg_temp_%'
            AND c.oid <> COALESCE(to_regclass('public.swat_schema_migrations'), 0::oid)
            AND c.oid NOT IN (SELECT indexrelid FROM pg_index WHERE indrelid = to_regclass('public.swat_schema_migrations')))
        OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND NOT (p.pronamespace=$1::oid AND p.oid=ANY($2::oid[])))
      ) AS has_objects`, [bootstrap?.namespaceOid ?? 0, bootstrap?.functionOids ?? []]);
      if (rows[0]?.has_objects !== false) throw new Error('Existing untracked database requires an independently audited baseline; no guessed replay');
      if (options.initialize !== true) throw new Error('Empty database requires explicit initialization');
    }
    const pending = adopting ? [] : migrations.slice(history.length);
    if (!adopting && !pending.length) return;
    if (options.quiesced !== true) throw new Error('Migration apply/adoption requires explicit quiesced maintenance approval');
    await client.query('BEGIN');
    try {
      if (!exists) {
        await client.query(`CREATE TABLE public.swat_schema_migrations (
          file text PRIMARY KEY,
          checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
          installed_checksum text NOT NULL CHECK (installed_checksum ~ '^[a-f0-9]{64}$'),
          audit_reference text,
          recorded_at timestamptz NOT NULL DEFAULT now(),
          recorded_by text NOT NULL DEFAULT session_user
        )`);
      }
      // Old default grants must never expose this journal to runtime DML.
      await client.query('REVOKE ALL ON public.swat_schema_migrations FROM PUBLIC');
      await client.query(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swat_app') THEN
          REVOKE ALL ON public.swat_schema_migrations FROM swat_app;
        END IF;
      END $$`);
      const insert = async (row: History) => {
        await client.query(`INSERT INTO public.swat_schema_migrations (file, checksum, installed_checksum, audit_reference)
          VALUES ($1, $2, $3, $4)`, [row.file, row.checksum, row.installed_checksum, row.audit_reference]);
      };
      if (adopting) {
        for (const row of adopting) await insert(row);
      } else {
        if (plan && pending.some(row => row.file === '079_claim_runtime_capabilities.sql' || row.file === '082_withdrawal_reducing_intent.sql')) {
          await assertInstallationBootstrap(client, plan);
        }
        // One commit for the whole pending suffix: never publish a temporary 066 lifecycle.
        for (const migration of pending) {
          const installed = plan?.migrations.find(row => row.file === migration.file);
          await client.query(installed?.installedSql ?? migration.sql);
          await insert({ file: migration.file, checksum: migration.checksum,
            installed_checksum: installed?.installedChecksum ?? migration.checksum, audit_reference: installed?.auditReference ?? null });
        }
        if (plan && pending.some(row => row.file === '079_claim_runtime_capabilities.sql' || row.file === '082_withdrawal_reducing_intent.sql')) {
          await client.query(plan.handoff.cleanupSql);
        }
      }
      const result = await client.query('COMMIT');
      if (result.command !== 'COMMIT') throw new Error('Migration transaction did not commit');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* direct session is destroyed by its owner */ }
      throw error;
    }
  });
  if (!outcome.acquired) throw new Error('Migration lock is busy; another runner owns this database');
}

async function main(): Promise<void> {
  migrationProfileFromEnv(process.env.SWAT_DB_PROFILE);
  const flags = process.argv.slice(2);
  const options: MigrationOptions = {};
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--quiesced') options.quiesced = true;
    else if (flags[i] === '--initialize-empty') options.initialize = true;
    else if (flags[i] === '--reviewed-selection' && flags[i + 1]) {
      options.selection = JSON.parse(await readFile(resolve(flags[++i]), 'utf8'));
    } else if (flags[i] === '--adopt-baseline' && flags[i + 1]) {
      options.baseline = JSON.parse(await readFile(resolve(flags[++i]), 'utf8'));
    } else throw new Error('Unknown or incomplete migration option');
  }
  await runMigrations(options);
  console.log(options.baseline ? 'Audited baseline recorded; no migration SQL applied' : 'Migration journal verified; pending suffix committed if present');
}
if (process.argv[1] && resolve(process.argv[1]) === __filename) main().catch(() => {
  console.error('Migration refused or failed; inspect approved maintenance evidence, not runtime credentials');
  process.exitCode = 1;
});
