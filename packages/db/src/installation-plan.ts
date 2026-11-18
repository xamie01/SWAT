import type { MigrationFile } from './migration-discovery.js';
import { requireAuditReference, sourceChecksum, type ReviewedMigrationSelection } from './migration-selection.js';

export const HANDOFF_PINS = [
  ['079_claim_runtime_capabilities.sql', '960642ce04c9f7ffc9fb599bde1edcec4159fed6277f522d74ee11a702aa3cc3', 'swat_claim_runtime_capability', 'uuid', 'swat_runtime_lookup', '51cc38b56e482b62e87a737df104051c752afe2f476e81ce50c472a1bf9ffe64'],
  ['079_claim_runtime_capabilities.sql', '960642ce04c9f7ffc9fb599bde1edcec4159fed6277f522d74ee11a702aa3cc3', 'has_worker_execution_capability', 'uuid', 'swat_runtime_lookup', '6be4760551f98b07025a2cf75122d4233be65c5b7e56fffc787d5faf903f460f'],
  ['082_withdrawal_reducing_intent.sql', '4d186f7d932545c467b869285693e23d6e06d282a3b7a8a21b2ae22517c3aa53', 'swat_apply_perps_reducing_receipt', 'uuid,text', 'swat_financial_settler', '933cedf2bdb6119039b08f72d3bfc4b4a8c61cdeef06c04e0ab7d4da0664d342'],
  ['082_withdrawal_reducing_intent.sql', '4d186f7d932545c467b869285693e23d6e06d282a3b7a8a21b2ae22517c3aa53', 'w3_apply_financial_receipt', '', 'swat_financial_settler', '2cc1511f3c4e4337ba7d5195bd779819d53db17eb9ce66d38c58e8c7473916ae'],
  ['082_withdrawal_reducing_intent.sql', '4d186f7d932545c467b869285693e23d6e06d282a3b7a8a21b2ae22517c3aa53', 'w3_perps_accounting_requires_application', '', 'swat_financial_settler', '50d4e6524cc51810f5feea0577635fd8ee9bd368f0f15a0bc95e1efbcda76a8f'],
  ['082_withdrawal_reducing_intent.sql', '4d186f7d932545c467b869285693e23d6e06d282a3b7a8a21b2ae22517c3aa53', 'swat_cancel_expired_financial_intent', 'uuid', 'swat_financial_settler', '9d43245ef74c33e13551a053109f8bb450f6f17d8b2173d0e47164086ee43468'],
  ['082_withdrawal_reducing_intent.sql', '4d186f7d932545c467b869285693e23d6e06d282a3b7a8a21b2ae22517c3aa53', 'w3_guard_perps_position_mutation', '', 'swat_financial_settler', '0ca2eb18e5e17ce0aa56f961c8545e1e676f815bbdaf0421881791b80eb2dc1c']
] as const;
export type InstalledMigration = MigrationFile & { readonly installedSql: string; readonly installedChecksum: string; readonly auditReference: string | null };
export type InstallationPlan = {
  readonly migrations: readonly InstalledMigration[];
  readonly auditReference: string;
  readonly handoff: { readonly provisionSql: string; readonly provisionChecksum: string;
    readonly cleanupSql: string; readonly cleanupChecksum: string; readonly brokerSourceChecksum: string };
  readonly planChecksum: string;
};
export type InstallationHistoryRow = { readonly file: string; readonly checksum: string;
  readonly installed_checksum: string; readonly audit_reference: string | null };
/** Catalog/journal callers compare actual source+installed identities, never accept an audited arbitrary hash. */
export function assertInstallationHistory(history: readonly InstallationHistoryRow[], plan: InstallationPlan): void {
  if (history.length > plan.migrations.length) throw new Error('Installed history exceeds exact plan');
  history.forEach((row, index) => {
    const migration = plan.migrations[index];
    if (!migration || row.file !== migration.file || row.checksum !== migration.checksum
        || row.installed_checksum !== migration.installedChecksum || row.audit_reference !== migration.auditReference) {
      throw new Error('Installed history is not exact reviewed source/installed/audit prefix');
    }
  });
}
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
const brokerSignature = 'swat_migration_handoff.transfer(integer,text,text)';
const directGate = `IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator'
 OR current_setting('role') <> 'none' OR current_setting('row_security') <> 'on' THEN
 RAISE EXCEPTION 'ownership handoff requires exact direct migrator, no SET ROLE'; END IF;`;

/** No connections or journal fabrication. Externally DBA installed superuser broker is necessary:
 * ordinary ALTER OWNER requires target membership and target schema CREATE, both forbidden here.
 * provisionSql is a source template, NOT an installer; cleanupSql belongs in the apply transaction.
 */
export function createInstallationPlan(selected: readonly MigrationFile[], options: { auditReference: string; selection: ReviewedMigrationSelection }): InstallationPlan {
  requireAuditReference(options.auditReference);
  const selection = options.selection;
  if (!selection || selection.status !== 'reviewed' || selection.auditReference !== options.auditReference
      || JSON.stringify(selected.map(({ file, checksum }) => ({ file, checksum }))) !== JSON.stringify(selection.included)) {
    throw new Error('Installation requires identical explicit reviewed selection/audit identity');
  }
  const manifestBody = { version: selection.version, purpose: selection.purpose, inventory: selection.inventory,
    included: selection.included, excluded: selection.excluded };
  if (sourceChecksum(JSON.stringify(manifestBody)) !== selection.manifestChecksum) throw new Error('Installation selection manifest checksum drift');
  if (selected.some(m => m.file.startsWith('084_')) || selected.length !== 85
      || selected.at(-1)?.file !== '086_wave4_restricted_composition.sql') throw new Error('Exact reviewed Wave4 selection required for installation plan');
  const cases: string[] = [];
  HANDOFF_PINS.forEach(([file, checksum, name, args, target, bodyHash], index) => {
    const migration = selected.find(m => m.file === file);
    if (!migration || migration.checksum !== checksum || sourceChecksum(migration.sql) !== checksum) throw new Error(`Pinned handoff source drift: ${file}`);
    const definition = new RegExp(`CREATE FUNCTION public\\.${name}\\(([^]*?)\\)\\s+RETURNS ([^]*?)\\s+LANGUAGE (sql|plpgsql) SECURITY DEFINER( STABLE)? SET search_path=pg_catalog AS \\$\\$([^]*?)\\$\\$;`, 'g');
    const matches = [...migration.sql.matchAll(definition)];
    const match = matches[0];
    if (matches.length !== 1 || !match || sourceChecksum(match[5]!) !== bodyHash) throw new Error(`Pinned function definition drift: ${name}`);
    const argumentsText = match[1]!.trim().replace(/\s+/g, ' ').replace(/,\s*/g, ', ');
    const resultText = match[2]!.trim().replace(/\s+/g, ' ').replace(/,\s*/g, ', ').replace(/^TABLE\(/, 'TABLE(');
    const resultSet = /^TABLE\(/.test(resultText);
    const argumentTypes = argumentsText ? argumentsText.split(', ').map(arg => arg.split(' ').at(-1)).join(',') : '';
    if (argumentTypes !== args) throw new Error(`Pinned function argument signature drift: ${name}`);
    const statement = `ALTER FUNCTION public.${name}(${args}) OWNER TO ${target};`;
    if (migration.sql.split(statement).length !== 2) throw new Error(`Exact ownership statement missing/duplicated: ${name}`);
    cases.push(`WHEN ${index + 1} THEN
 IF requested_source IS DISTINCT FROM ${quote(checksum)} OR requested_audit IS DISTINCT FROM ${quote(options.auditReference)} THEN RAISE EXCEPTION 'handoff source/audit identity mismatch'; END IF;
 function_oid := to_regprocedure(${quote(`public.${name}(${args})`)});
 IF function_oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
   WHERE p.oid=function_oid AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname='swat_migrator')
    AND p.prokind='f' AND p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u'
    AND p.proretset=${resultSet ? 'true' : 'false'} AND p.pronargdefaults=0 AND p.prosupport=0
    AND p.procost=100 AND p.prorows=${resultSet ? 1000 : 0}
    AND p.provolatile=${quote(match[4] ? 's' : 'v')} AND l.lanname=${quote(match[3]!)}
    AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
    AND pg_get_function_arguments(p.oid)=${quote(argumentsText)} AND pg_get_function_result(p.oid)=${quote(resultText)}
    AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=${quote(bodyHash)})
 THEN RAISE EXCEPTION 'exact function source/signature/current owner/options unavailable'; END IF;
 REVOKE ALL ON FUNCTION public.${name}(${args}) FROM PUBLIC,swat_app;
 ${['swat_apply_perps_reducing_receipt', 'swat_cancel_expired_financial_intent'].includes(name) ? `GRANT EXECUTE ON FUNCTION public.${name}(${args}) TO swat_app;` : ''}
 ALTER FUNCTION public.${name}(${args}) OWNER TO ${target};
 GRANT EXECUTE ON FUNCTION public.${name}(${args}) TO swat_migrator WITH GRANT OPTION;`);
  });
  const brokerBody = `DECLARE function_oid oid; role_row record;
BEGIN
 IF session_user <> 'swat_migrator' OR current_user <> 'swat_handoff_broker'
  OR current_setting('role') <> 'none' OR current_setting('row_security') <> 'on'
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper AND NOT rolcanlogin)
  OR NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='swat_migration_handoff' AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
  OR NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='public' AND nspowner=(SELECT oid FROM pg_roles WHERE rolname='swat_migrator'))
 THEN RAISE EXCEPTION 'externally installed exact privileged broker/direct session required'; END IF;
 FOR role_row IN SELECT * FROM pg_roles WHERE rolname IN('swat_migrator','swat_runtime_lookup','swat_financial_settler') LOOP
  IF role_row.rolsuper OR role_row.rolbypassrls OR role_row.rolinherit OR role_row.rolcreaterole OR role_row.rolcreatedb OR role_row.rolreplication
   OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=role_row.oid OR roleid=role_row.oid)
   OR (role_row.rolname<>'swat_migrator' AND (role_row.rolcanlogin
      OR EXISTS(SELECT 1 FROM pg_namespace WHERE has_schema_privilege(role_row.oid,oid,'CREATE'))
      OR has_database_privilege(role_row.oid,current_database(),'CREATE')
      OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=role_row.oid)
      OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=role_row.oid)
      OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=role_row.oid)))
  THEN RAISE EXCEPTION 'restricted migrator/target flags, membership or CREATE drift'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN('swat_migrator','swat_runtime_lookup','swat_financial_settler')) <> 3
 THEN RAISE EXCEPTION 'handoff identities missing'; END IF;
 CASE requested_transfer
 ${cases.join('\n')}
 ELSE RAISE EXCEPTION 'ownership transfer not allowlisted'; END CASE;
END`;
  const brokerSourceChecksum = sourceChecksum(brokerBody);
  const provisionSql = `-- EXTERNAL DBA REVIEW/APPLY ONLY. Requires separately provisioned exact NOLOGIN superuser owner.
BEGIN;
DO $$ BEGIN
 IF current_user<>'swat_handoff_dba' OR session_user<>'swat_handoff_dba' OR current_setting('role')<>'none'
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper)
  OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='swat_handoff_broker' AND rolsuper AND NOT rolcanlogin)
  OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname='swat_handoff_broker'))
  OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=(SELECT oid FROM pg_roles WHERE rolname='swat_handoff_broker'))
  OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname='swat_handoff_broker'))
  OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname='swat_handoff_broker'))
  OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member OR r.oid=m.roleid WHERE r.rolname IN('swat_handoff_dba','swat_handoff_broker'))
  OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='swat_migration_handoff')
 THEN RAISE EXCEPTION 'unexpected bootstrap/owner identity or existing broker schema'; END IF;
END $$;
CREATE SCHEMA swat_migration_handoff AUTHORIZATION swat_handoff_broker;
REVOKE ALL ON SCHEMA swat_migration_handoff FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA swat_migration_handoff REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE FUNCTION ${brokerSignature.replace('(integer,text,text)', '(requested_transfer integer,requested_source text,requested_audit text)')}
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $broker$${brokerBody}$broker$;
REVOKE ALL ON FUNCTION ${brokerSignature} FROM PUBLIC;
ALTER FUNCTION ${brokerSignature} OWNER TO swat_handoff_broker;
GRANT USAGE ON SCHEMA swat_migration_handoff TO swat_migrator;
GRANT EXECUTE ON FUNCTION ${brokerSignature} TO swat_migrator;
COMMIT;`;
  const cleanupSql = `-- Execute BEFORE application transaction COMMIT; source+cleanup hashes retained in external audit.
DO $$ BEGIN ${directGate}
 IF EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname='swat_migration_handoff' AND r.rolname='swat_handoff_broker')
  AND EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('${brokerSignature}') AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='${brokerSourceChecksum}') THEN
  PERFORM swat_migration_handoff.retire();
 ELSE RAISE EXCEPTION 'broker cleanup source/owner drift'; END IF;
END $$;`;
  // Retire is privileged too: no arbitrary objects, no CASCADE, no surviving grant.
  const retirement = `CREATE FUNCTION swat_migration_handoff.retire() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $retire$
BEGIN
 IF session_user<>'swat_migrator' OR current_user<>'swat_handoff_broker' OR current_setting('role')<>'none'
  OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('${brokerSignature}') AND proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
    AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='${brokerSourceChecksum}') THEN RAISE EXCEPTION 'broker retirement identity/source mismatch'; END IF;
 ${HANDOFF_PINS.map(([, , name, args, target, bodyHash]) => `IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.${name}(${args})') AND proowner=(SELECT oid FROM pg_roles WHERE rolname='${target}') AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='${bodyHash}') THEN RAISE EXCEPTION 'handoff incomplete/source drift'; END IF; REVOKE ALL ON FUNCTION public.${name}(${args}) FROM swat_migrator CASCADE;`).join('\n')}
 DROP FUNCTION ${brokerSignature};
 DROP FUNCTION swat_migration_handoff.retire();
 DROP SCHEMA swat_migration_handoff;
END $retire$;
REVOKE ALL ON FUNCTION swat_migration_handoff.retire() FROM PUBLIC;
ALTER FUNCTION swat_migration_handoff.retire() OWNER TO swat_handoff_broker;
GRANT EXECUTE ON FUNCTION swat_migration_handoff.retire() TO swat_migrator;`;
  const completeProvision = provisionSql.replace('\nCOMMIT;', `\n${retirement}\nCOMMIT;`);
  const retirementBody = retirement.split('$retire$')[1]!;
  const completeCleanup = cleanupSql.replace('  PERFORM swat_migration_handoff.retire();',
    `  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('swat_migration_handoff.retire()')
    AND proowner=(SELECT oid FROM pg_roles WHERE rolname='swat_handoff_broker') AND prosecdef
    AND proconfig=ARRAY['search_path=pg_catalog']::text[]
    AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='${sourceChecksum(retirementBody)}')
  THEN RAISE EXCEPTION 'retirement function source/options/owner drift'; END IF;
  PERFORM swat_migration_handoff.retire();`);
  const migrations = selected.map(migration => {
    if (sourceChecksum(migration.sql) !== migration.checksum) throw new Error('Installation source checksum drift');
    let installedSql = migration.sql;
    HANDOFF_PINS.forEach(([file, checksum, name, args, target], index) => {
      if (migration.file !== file) return;
      installedSql = installedSql.replace(`ALTER FUNCTION public.${name}(${args}) OWNER TO ${target};`,
        `DO $handoff$ BEGIN ${directGate}\n IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('${brokerSignature}')
  AND proowner=(SELECT oid FROM pg_roles WHERE rolname='swat_handoff_broker') AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']::text[]
  AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='${brokerSourceChecksum}') THEN RAISE EXCEPTION 'pinned external ownership handoff broker unavailable'; END IF;\n PERFORM swat_migration_handoff.transfer(${index + 1},'${checksum}',${quote(options.auditReference)}); END $handoff$;`);
    });
    return { ...migration, installedSql, installedChecksum: sourceChecksum(installedSql),
      auditReference: installedSql === migration.sql ? null : options.auditReference };
  });
  const handoff = { provisionSql: completeProvision, provisionChecksum: sourceChecksum(completeProvision), cleanupSql: completeCleanup,
    cleanupChecksum: sourceChecksum(completeCleanup), brokerSourceChecksum };
  return { migrations, auditReference: options.auditReference, handoff,
    planChecksum: sourceChecksum(JSON.stringify({ migrations: migrations.map(m => ({ file: m.file, checksum: m.checksum,
      installedChecksum: m.installedChecksum, auditReference: m.auditReference })), handoff, auditReference: options.auditReference })) };
}
