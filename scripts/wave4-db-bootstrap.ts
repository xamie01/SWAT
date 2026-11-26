/**
 * Shared disposable DB bootstrap helper for Wave 4 Stage A (I1) and Stage B (I7).
 * Ensures 088/089 NOLOGIN prerequisite roles, public schema ownership/ACL by swat_migrator,
 * and external swat_handoff_dba provisioning of plan.handoff.provisionSql prior to migratePristine.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const { createInstallationPlan } = require('../packages/db/dist/installation-plan.js');
const { discoverMigrations } = require('../packages/db/dist/migration-discovery.js');
import type { ReviewedMigrationSelection } from '../packages/db/src/migration-selection.js';

const dbRequire = createRequire(resolve(__dirname, '../packages/db/package.json'));
const { Client } = dbRequire('pg') as { Client: new (opts: Record<string, unknown>) => any };

function withCredentials(baseUrl: string, user: string, pass: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = pass;
  return u.toString();
}

const REVOKE_ALL_PUBLIC_SCHEMA_SQL = `DO $$
DECLARE g record;
BEGIN
  REVOKE ALL ON SCHEMA public FROM PUBLIC;
  FOR g IN
    SELECT DISTINCT r.rolname
    FROM pg_catalog.pg_namespace n
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
    JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', g.rolname);
  END LOOP;
END $$`;

/**
 * Prepares a fresh or pre-initialized Wave 4 database before `migratePristine` runs:
 * ensures 088/089 prerequisite NOLOGIN roles, creates `swat_handoff_broker` and
 * `swat_handoff_dba`, normalizes `public` schema ownership/ACL to match
 * `installation-plan.ts`'s `exactAcl` contract (including revoking PG16's default
 * `pg_database_owner` entry), provisions `plan.handoff.provisionSql` via
 * `swat_handoff_dba`, and returns `swat_handoff_dba` to `NOLOGIN`.
 */
export async function prepareDatabaseForMigratePristine(input: {
  swatDir: string;
  dbaUrl: string;
  dbaPass: string;
  migratorUrl: string;
  selection: unknown;
  auditReference: string;
}): Promise<void> {
  const handoffPass = input.dbaPass;
  const dbaClient = new Client({ connectionString: input.dbaUrl, connectionTimeoutMillis: 10_000 });
  await dbaClient.connect();
  try {
    await dbaClient.query(`DO $$
DECLARE role_name text;
  extra_roles text[] := ARRAY[
    'swat_fanout',
    'swat_wave4_authority_writer', 'swat_wave4_financial_writer',
    'swat_lp_initializer', 'swat_custody_reader', 'swat_custody_observer'
  ];
BEGIN
  FOREACH role_name IN ARRAY extra_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION', role_name);
    END IF;
    EXECUTE format('ALTER ROLE %I SET row_security=on', role_name);
    EXECUTE format('ALTER ROLE %I SET search_path=pg_catalog', role_name);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'swat_handoff_broker') THEN
    CREATE ROLE swat_handoff_broker SUPERUSER NOLOGIN PASSWORD NULL;
  ELSE
    ALTER ROLE swat_handoff_broker SUPERUSER NOLOGIN PASSWORD NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'swat_handoff_dba') THEN
    CREATE ROLE swat_handoff_dba SUPERUSER LOGIN;
  ELSE
    ALTER ROLE swat_handoff_dba SUPERUSER LOGIN;
  END IF;
END $$`);
    await dbaClient.query(`ALTER ROLE swat_handoff_dba WITH PASSWORD '${handoffPass.replaceAll("'", "''")}'`);
    // Transfer public schema ownership first, then strip ALL existing ACL entries
    // (including PG16 default pg_database_owner and prior superuser grants) so
    // swat_migrator can establish the exact ACL checked by assertInstallationBootstrap.
    await dbaClient.query(`ALTER SCHEMA public OWNER TO swat_migrator`);
    await dbaClient.query(REVOKE_ALL_PUBLIC_SCHEMA_SQL);
  } finally {
    await dbaClient.end();
  }

  // Normalize public schema ACL strictly as swat_migrator (matching installation-plan.ts exactAcl)
  const migClient = new Client({ connectionString: input.migratorUrl, connectionTimeoutMillis: 10_000 });
  await migClient.connect();
  try {
    await migClient.query(REVOKE_ALL_PUBLIC_SCHEMA_SQL);
    await migClient.query(`GRANT USAGE ON SCHEMA public TO PUBLIC`);
    await migClient.query(`GRANT USAGE, CREATE ON SCHEMA public TO swat_migrator`);
    await migClient.query(`GRANT USAGE ON SCHEMA public TO swat_app, swat_custody_writer, swat_financial_receipt_writer,
      swat_lp_admitter, swat_auth_service, swat_system_observer, swat_source_provider_writer, swat_risk_writer,
      swat_capability_writer, swat_valuation_writer, swat_runtime_lookup, swat_financial_settler`);
  } finally {
    await migClient.end();
  }

  const selected = await discoverMigrations(
    resolve(input.swatDir, 'packages/db/sql'),
    undefined,
    undefined,
    input.selection as ReviewedMigrationSelection
  );
  const plan = createInstallationPlan(selected, { auditReference: input.auditReference, selection: input.selection });

  const handoffUrl = withCredentials(input.dbaUrl, 'swat_handoff_dba', handoffPass);
  const handoffClient = new Client({ connectionString: handoffUrl, connectionTimeoutMillis: 10_000 });
  await handoffClient.connect();
  try {
    const exists = (await handoffClient.query("SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='swat_migration_handoff'")).rows.length > 0;
    if (!exists) {
      await handoffClient.query(plan.handoff.provisionSql);
    }
  } finally {
    await handoffClient.end();
  }

  const lockDba = new Client({ connectionString: input.dbaUrl, connectionTimeoutMillis: 10_000 });
  await lockDba.connect();
  try {
    await lockDba.query('ALTER ROLE swat_handoff_dba NOLOGIN PASSWORD NULL');
  } finally {
    await lockDba.end();
  }
}
