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
    readonly validationSql: string; readonly validationChecksum: string;
    readonly cleanupSql: string; readonly cleanupChecksum: string; readonly brokerSourceChecksum: string };
  readonly planChecksum: string;
};
export type InstallationHistoryRow = { readonly file: string; readonly checksum: string;
  readonly installed_checksum: string; readonly audit_reference: string | null };
/** Consistency evidence only: reviewed manifests, owner reports and hashes are not authenticated authorization. */
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
// Source provenance only, never installation authorization. A caller-supplied plan
// cannot turn the bootstrap helper into an arbitrary SQL executor. Recreate a plan
// locally from reviewed source rather than accepting deserialized validation SQL.
const bootstrapSqlByPlan = new WeakMap<InstallationPlan, string>();
/** Read-only initial bootstrap check, not an installer or a general SQL execution API.
 * The reviewed plan must come from a trusted caller; its checksums are consistency artifacts.
 * Returned OIDs identify exactly validated objects, not permission to apply migrations.
 */
export async function assertInstallationBootstrap(client: { query(sql: string): Promise<{ rows: any[] }> }, plan: InstallationPlan): Promise<Readonly<{ namespaceOid: number; functionOids: readonly number[] }>> {
  const validationSql = bootstrapSqlByPlan.get(plan);
  if (!validationSql || validationSql !== plan.handoff.validationSql
      || sourceChecksum(validationSql) !== plan.handoff.validationChecksum) throw new Error('Bootstrap validation checksum/provenance drift');
  const { rows } = await client.query(validationSql);
  const row = rows.length === 1 ? rows[0] : undefined;
  const validOid = (oid: unknown): oid is number => typeof oid === 'number' && Number.isInteger(oid) && oid > 0 && oid <= 0xffffffff;
  if (!row || row.exact !== true || !validOid(row.namespace_oid) || !Array.isArray(row.function_oids)
      || row.function_oids.length !== 2 || !row.function_oids.every(validOid) || new Set(row.function_oids).size !== 2) {
    throw new Error('Exact external installation bootstrap validation rejected');
  }
  return Object.freeze({ namespaceOid: row.namespace_oid, functionOids: Object.freeze([...row.function_oids]) });
}
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
const brokerSignature = 'swat_migration_handoff.transfer(integer,text,text)';
const retireSignature = 'swat_migration_handoff.retire()';
const directGate = `IF current_user <> 'swat_migrator' OR session_user <> 'swat_migrator'
 OR pg_catalog.current_setting('role') <> 'none' OR pg_catalog.current_setting('row_security') <> 'on' THEN
 RAISE EXCEPTION 'ownership handoff requires exact direct migrator, no SET ROLE'; END IF;`;
const roleOid = (name: string) => `(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${quote(name)})`;
const catalogTypes: Readonly<Record<string, string>> = Object.freeze({
  integer: 'int4', boolean: 'bool', 'timestamp with time zone': 'timestamptz',
  int4: 'int4', bool: 'bool', timestamptz: 'timestamptz', uuid: 'uuid', text: 'text', record: 'record', void: 'void', trigger: 'trigger'
});
const typeOid = (name: string) => {
  const catalogName = Object.hasOwn(catalogTypes, name) ? catalogTypes[name] : undefined;
  if (!catalogName) throw new Error(`Unreviewed installation function type: ${name}`);
  return `${quote(`pg_catalog.${catalogName}`)}::pg_catalog.regtype::oid`;
};
const namesSql = (names: readonly string[]) => names.length ? `ARRAY[${names.map(quote).join(',')}]::text[]` : 'NULL::text[]';
const oidArray = (types: readonly string[]) => `ARRAY[${types.map(typeOid).join(',')}]::oid[]`;
// Equality of sorted ACL tuples rejects missing grants, extra grantees/grantors,
// duplicate entries, PUBLIC and grant options (except explicitly temporary handoff WGO).
const exactAcl = (acl: string, kind: string, owner: string, grants: readonly [string, string, boolean, string?][]) =>
  `(SELECT pg_catalog.array_agg(a.grantor::text||':'||a.grantee::text||':'||a.privilege_type||':'||a.is_grantable::text ORDER BY a.grantor,a.grantee,a.privilege_type,a.is_grantable)
 FROM pg_catalog.aclexplode(COALESCE(${acl},pg_catalog.acldefault('${kind}',${roleOid(owner)}))) a)
 IS NOT DISTINCT FROM (SELECT pg_catalog.array_agg(grantor::text||':'||grantee::text||':'||privilege||':'||grantable::text ORDER BY grantor,grantee,privilege,grantable)
 FROM (VALUES ${grants.map(([grantee, privilege, grantable, grantor]) => `(${roleOid(grantor ?? owner)},${grantee === 'PUBLIC' ? '0::oid' : roleOid(grantee)},${quote(privilege)},${grantable})`).join(',')}) expected(grantor,grantee,privilege,grantable))`;
type FunctionPin = { signature: string; names: readonly string[]; inputs: readonly string[]; outputs: readonly string[];
  result: string; language: string; stable: boolean; bodyHash: string };
function functionMetadata(pin: FunctionPin): string {
  const all = [...pin.inputs, ...pin.outputs];
  return `p.prokind='f' AND p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u'
 AND p.provariadic=0 AND p.pronargs=${pin.inputs.length} AND p.proargtypes::text=(SELECT COALESCE(pg_catalog.string_agg(value::text,' ' ORDER BY ord),'') FROM pg_catalog.unnest(${oidArray(pin.inputs)}) WITH ORDINALITY AS input_types(value,ord))
 AND p.proargnames IS NOT DISTINCT FROM ${namesSql(pin.names)}
 AND p.proallargtypes IS NOT DISTINCT FROM ${pin.outputs.length ? oidArray(all) : 'NULL::oid[]'}
 AND p.proargmodes IS NOT DISTINCT FROM ${pin.outputs.length ? `ARRAY[${[...pin.inputs.map(() => "'i'"), ...pin.outputs.map(() => "'t'")].join(',')}]::"char"[]` : 'NULL::"char"[]'}
 AND p.prorettype=${typeOid(pin.result)} AND p.proretset=${pin.outputs.length > 0}
 AND p.pronargdefaults=0 AND p.proargdefaults IS NULL AND p.prosupport=0 AND p.procost=100 AND p.prorows=${pin.outputs.length ? 1000 : 0}
 AND p.provolatile=${quote(pin.stable ? 's' : 'v')} AND l.lanname=${quote(pin.language)}
 AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]`;
}
const publicUsageRoles = ['swat_app','swat_custody_writer','swat_financial_receipt_writer','swat_lp_admitter','swat_auth_service',
  'swat_system_observer','swat_source_provider_writer','swat_risk_writer','swat_capability_writer','swat_valuation_writer','swat_runtime_lookup','swat_financial_settler'];

/** Source templates only. Ordinary ALTER OWNER needs forbidden membership/CREATE;
 * an independently audited external DBA installs the exact NOLOGIN superuser broker.
 * No arbitrary executor. Each transfer and retirement has the same full SELECT gate.
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
  if (selected.some(m => m.file.startsWith('084_')) || selected.length !== 89
      || selected.at(-4)?.file !== '087_wave4_protected_authentication.sql'
      || selected.at(-3)?.file !== '088_wave4_protected_pipeline.sql'
      || selected.at(-2)?.file !== '089_wave4_protected_financial.sql'
      || selected.at(-1)?.file !== '090_wave4_protected_load_capture.sql') throw new Error('Exact reviewed Wave4 selection required for installation plan');
  const pins = HANDOFF_PINS.map(([file, checksum, name, args, target, bodyHash]): FunctionPin => {
    const migration = selected.find(m => m.file === file);
    if (!migration || migration.checksum !== checksum || sourceChecksum(migration.sql) !== checksum) throw new Error(`Pinned handoff source drift: ${file}`);
    const definition = new RegExp(`CREATE FUNCTION public\\.${name}\\(([^]*?)\\)\\s+RETURNS ([^]*?)\\s+LANGUAGE (sql|plpgsql) SECURITY DEFINER( STABLE)? SET search_path=pg_catalog AS \\$\\$([^]*?)\\$\\$;`, 'g');
    const matches = [...migration.sql.matchAll(definition)];
    const match = matches[0];
    if (matches.length !== 1 || !match || sourceChecksum(match[5]!) !== bodyHash) throw new Error(`Pinned function definition drift: ${name}`);
    const parseArgs = (text: string) => text.trim() ? text.trim().split(/\s*,\s*/).map(arg => arg.trim().split(/\s+/)) : [];
    const input = parseArgs(match[1]!);
    const resultText = match[2]!.trim();
    const output = resultText.startsWith('TABLE(') ? parseArgs(resultText.slice(6, -1)) : [];
    if (input.map(arg => arg[1]).join(',') !== args) throw new Error(`Pinned function argument signature drift: ${name}`);
    if (migration.sql.split(`ALTER FUNCTION public.${name}(${args}) OWNER TO ${target};`).length !== 2) {
      throw new Error(`Exact ownership statement missing/duplicated: ${name}`);
    }
    return { signature: `public.${name}(${args})`, names: [...input, ...output].map(arg => arg[0]!),
      inputs: input.map(arg => arg[1]!), outputs: output.map(arg => arg[1]!), result: output.length ? 'record' : resultText,
      language: match[3]!, stable: !!match[4], bodyHash };
  });
  const brokerPins: FunctionPin[] = [
    { signature: brokerSignature, names: ['requested_transfer','requested_source','requested_audit'], inputs: ['integer','text','text'], outputs: [], result: 'void', language: 'plpgsql', stable: false, bodyHash: '' },
    { signature: retireSignature, names: [], inputs: [], outputs: [], result: 'void', language: 'plpgsql', stable: false, bodyHash: '' }
  ];
  const installedFunction = (index: number, owner: string, transferred: boolean) => {
    const pin = pins[index]!;
    const appGrant = transferred && [2, 5].includes(index);
    return `EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 WHERE p.oid=pg_catalog.to_regprocedure(${quote(pin.signature)}) AND p.proowner=${roleOid(owner)}
 AND ${functionMetadata(pin)} AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')=${quote(pin.bodyHash)}
 AND ${exactAcl('p.proacl', 'f', owner, [[owner,'EXECUTE',false], ...(transferred ? [['swat_migrator','EXECUTE',true] as [string,string,boolean]] : [['PUBLIC','EXECUTE',false] as [string,string,boolean]]), ...(appGrant ? [[ 'swat_app','EXECUTE',false],['swat_app','EXECUTE',false,'swat_migrator']] as [string,string,boolean,string?][] : [])])})`;
  };
  // A phase is the exact already-completed prefix, not an arbitrary ownership report.
  // pg_shdepend covers ALL owned object classes, including non-table/non-function objects.
  const structuralValidation = (phase: number, privileged = false) => `
 ${privileged ? "session_user='swat_migrator' AND current_user='swat_handoff_broker'" : "session_user='swat_migrator' AND current_user='swat_migrator'"}
 AND pg_catalog.current_setting('role')='none' AND pg_catalog.current_setting('row_security')='on'
 AND (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN('swat_migrator','swat_handoff_broker','swat_runtime_lookup','swat_financial_settler'))=4
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='swat_handoff_broker' AND rolsuper AND NOT rolcanlogin)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname IN('swat_migrator','swat_runtime_lookup','swat_financial_settler')
 AND (r.rolsuper OR r.rolbypassrls OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
 OR (r.rolname='swat_migrator' AND NOT r.rolcanlogin) OR (r.rolname<>'swat_migrator' AND (r.rolcanlogin
 OR pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE') OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE pg_catalog.has_schema_privilege(r.oid,oid,'CREATE'))))))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member IN(${['swat_migrator','swat_handoff_broker','swat_runtime_lookup','swat_financial_settler'].map(roleOid).join(',')}) OR roleid IN(${['swat_migrator','swat_handoff_broker','swat_runtime_lookup','swat_financial_settler'].map(roleOid).join(',')}))
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='public' AND n.nspowner=${roleOid('swat_migrator')}
 AND ${exactAcl('n.nspacl','n','swat_migrator',[['swat_migrator','USAGE',false],['swat_migrator','CREATE',false],['PUBLIC','USAGE',false],...publicUsageRoles.map(role => [role,'USAGE',false] as [string,string,boolean])])})
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='swat_migration_handoff' AND n.nspowner=${roleOid('swat_handoff_broker')}
 AND ${exactAcl('n.nspacl','n','swat_handoff_broker',[['swat_handoff_broker','USAGE',false],['swat_handoff_broker','CREATE',false],['swat_migrator','USAGE',false]])}
 AND (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace=n.oid)=2
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.refclassid='pg_catalog.pg_namespace'::regclass AND d.refobjid=n.oid
 AND (d.classid='pg_catalog.pg_proc'::regclass AND d.objsubid=0 AND d.objid IN(pg_catalog.to_regprocedure(${quote(brokerSignature)}),pg_catalog.to_regprocedure(${quote(retireSignature)}))) IS DISTINCT FROM true))
 AND ${brokerPins.map(pin => `EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
 WHERE p.oid=pg_catalog.to_regprocedure(${quote(pin.signature)}) AND p.pronamespace=(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname='swat_migration_handoff')
 AND p.proowner=${roleOid('swat_handoff_broker')} AND ${functionMetadata(pin)}
 AND ${exactAcl('p.proacl','f','swat_handoff_broker',[['swat_handoff_broker','EXECUTE',false],['swat_migrator','EXECUTE',false]])})`).join('\n AND ')}
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.refobjid=${roleOid('swat_handoff_broker')} AND d.deptype='o'
 AND (d.dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AND d.objsubid=0
 AND ((d.classid='pg_catalog.pg_namespace'::regclass AND d.objid=(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname='swat_migration_handoff'))
 OR (d.classid='pg_catalog.pg_proc'::regclass AND d.objid IN(pg_catalog.to_regprocedure(${quote(brokerSignature)}),pg_catalog.to_regprocedure(${quote(retireSignature)}))))) IS DISTINCT FROM true)
 AND ${['swat_runtime_lookup','swat_financial_settler'].map(target => `NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.refobjid=${roleOid(target)} AND d.deptype='o'
 AND (d.dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AND d.classid='pg_catalog.pg_proc'::regclass AND d.objsubid=0
 AND d.objid=ANY(ARRAY[${pins.slice(0,phase).filter((_, i) => HANDOFF_PINS[i]![4] === target).map(pin => `pg_catalog.to_regprocedure(${quote(pin.signature)})::oid`).join(',')}]::oid[])) IS DISTINCT FROM true)`).join('\n AND ')}
 ${pins.slice(0,phase).map((_, index) => `AND ${installedFunction(index,HANDOFF_PINS[index]![4],true)}`).join('\n')}`;
  // Both full body hashes live in the direct call gates (embedding a function's
  // own cryptographic hash inside its body would be a circular fixed point).
  const retirementBody = `BEGIN
 IF (${structuralValidation(7,true)}) IS DISTINCT FROM true THEN RAISE EXCEPTION 'exact broker retirement catalog/phase drift'; END IF;
 ${HANDOFF_PINS.map(([, , name, args]) => `REVOKE ALL ON FUNCTION public.${name}(${args}) FROM swat_migrator CASCADE;`).join('\n')}
 DROP FUNCTION ${brokerSignature};
 DROP FUNCTION ${retireSignature};
 DROP SCHEMA swat_migration_handoff;
END`;
  const retirementHash = sourceChecksum(retirementBody);
  const cases = HANDOFF_PINS.map(([, checksum, name, args, target], index) => `WHEN ${index + 1} THEN
 IF requested_source IS DISTINCT FROM ${quote(checksum)} OR requested_audit IS DISTINCT FROM ${quote(options.auditReference)} THEN RAISE EXCEPTION 'handoff source/audit identity mismatch'; END IF;
 IF (${structuralValidation(index,true)} AND ${installedFunction(index,'swat_migrator',false)}) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'exact function source/signature/current owner/options unavailable'; END IF;
 REVOKE ALL ON FUNCTION public.${name}(${args}) FROM PUBLIC,swat_app;
 ${[2,5].includes(index) ? `GRANT EXECUTE ON FUNCTION public.${name}(${args}) TO swat_app;` : ''}
 ALTER FUNCTION public.${name}(${args}) OWNER TO ${target};
 GRANT EXECUTE ON FUNCTION public.${name}(${args}) TO swat_migrator WITH GRANT OPTION;`);
  const brokerBody = `BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure(${quote(retireSignature)})
 AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(prosrc,'UTF8')),'hex')=${quote(retirementHash)}) THEN RAISE EXCEPTION 'retirement source drift'; END IF;
 CASE requested_transfer
 ${cases.join('\n')}
 ELSE RAISE EXCEPTION 'ownership transfer not allowlisted'; END CASE;
END`;
  const brokerSourceChecksum = sourceChecksum(brokerBody);
  const fullValidation = (phase: number) => `(${structuralValidation(phase)}
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure(${quote(brokerSignature)}) AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(prosrc,'UTF8')),'hex')=${quote(brokerSourceChecksum)})
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure(${quote(retireSignature)}) AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(prosrc,'UTF8')),'hex')=${quote(retirementHash)}))`;
  const validationSql = `SELECT exact,
 CASE WHEN exact IS TRUE THEN (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname='swat_migration_handoff') END AS namespace_oid,
 CASE WHEN exact IS TRUE THEN ARRAY[pg_catalog.to_regprocedure(${quote(brokerSignature)})::oid,pg_catalog.to_regprocedure(${quote(retireSignature)})::oid] END AS function_oids
 FROM (SELECT ${fullValidation(0)} AS exact) validation;`;
  const provisionSql = `-- EXTERNAL DBA REVIEW/APPLY ONLY. No runtime installer or credential authority.
BEGIN;
DO $$ BEGIN
 IF current_user<>'swat_handoff_dba' OR session_user<>'swat_handoff_dba' OR pg_catalog.current_setting('role')<>'none'
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='swat_handoff_broker' AND rolsuper AND NOT rolcanlogin)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=${roleOid('swat_handoff_broker')} AND deptype='o')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member IN(${roleOid('swat_handoff_dba')},${roleOid('swat_handoff_broker')}) OR roleid IN(${roleOid('swat_handoff_dba')},${roleOid('swat_handoff_broker')}))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='swat_migration_handoff')
 THEN RAISE EXCEPTION 'unexpected bootstrap/owner identity or existing broker schema'; END IF;
END $$;
CREATE SCHEMA swat_migration_handoff AUTHORIZATION swat_handoff_broker;
REVOKE ALL ON SCHEMA swat_migration_handoff FROM PUBLIC;
CREATE FUNCTION swat_migration_handoff.transfer(requested_transfer integer,requested_source text,requested_audit text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $broker$${brokerBody}$broker$;
REVOKE ALL ON FUNCTION ${brokerSignature} FROM PUBLIC;
ALTER FUNCTION ${brokerSignature} OWNER TO swat_handoff_broker;
GRANT EXECUTE ON FUNCTION ${brokerSignature} TO swat_migrator;
CREATE FUNCTION ${retireSignature} RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $retire$${retirementBody}$retire$;
REVOKE ALL ON FUNCTION ${retireSignature} FROM PUBLIC;
ALTER FUNCTION ${retireSignature} OWNER TO swat_handoff_broker;
GRANT EXECUTE ON FUNCTION ${retireSignature} TO swat_migrator;
GRANT USAGE ON SCHEMA swat_migration_handoff TO swat_migrator;
COMMIT;`;
  const cleanupSql = `-- BEFORE apply transaction COMMIT; exact full source/metadata/ACL/phase check.
DO $$ BEGIN ${directGate}
 IF ${fullValidation(7)} IS DISTINCT FROM true THEN RAISE EXCEPTION 'retirement function source/options/owner drift'; END IF;
 PERFORM swat_migration_handoff.retire();
END $$;`;
  const migrations = selected.map(migration => {
    if (sourceChecksum(migration.sql) !== migration.checksum) throw new Error('Installation source checksum drift');
    let installedSql = migration.sql;
    HANDOFF_PINS.forEach(([file, checksum, name, args, target], index) => {
      if (migration.file !== file) return;
      installedSql = installedSql.replace(`ALTER FUNCTION public.${name}(${args}) OWNER TO ${target};`,
        `DO $handoff$ BEGIN ${directGate}\n IF ${fullValidation(index)} IS DISTINCT FROM true THEN RAISE EXCEPTION 'pinned external ownership handoff broker unavailable'; END IF;\n PERFORM swat_migration_handoff.transfer(${index + 1},'${checksum}',${quote(options.auditReference)}); END $handoff$;`);
    });
    return { ...migration, installedSql, installedChecksum: sourceChecksum(installedSql), auditReference: installedSql === migration.sql ? null : options.auditReference };
  });
  const handoff = { provisionSql, provisionChecksum: sourceChecksum(provisionSql), validationSql, validationChecksum: sourceChecksum(validationSql),
    cleanupSql, cleanupChecksum: sourceChecksum(cleanupSql), brokerSourceChecksum };
  const plan: InstallationPlan = { migrations, auditReference: options.auditReference, handoff,
    planChecksum: sourceChecksum(JSON.stringify({ migrations: migrations.map(m => ({ file: m.file, checksum: m.checksum,
      installedChecksum: m.installedChecksum, auditReference: m.auditReference })), handoff, auditReference: options.auditReference })) };
  bootstrapSqlByPlan.set(plan, validationSql);
  return plan;
}
