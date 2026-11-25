import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { discoverMigrationInventory, discoverMigrations } from '../../../packages/db/src/migration-discovery.js';
import { createMigrationSelectionProposal, reviewMigrationSelection, selectMigrations, sourceChecksum, WAVE4_REFUSAL } from '../../../packages/db/src/migration-selection.js';
import { assertInstallationBootstrap, assertInstallationHistory, createInstallationPlan, HANDOFF_PINS } from '../../../packages/db/src/installation-plan.js';
import { createLoginActivationSource, SOURCE_CAPABILITY_MATRIX, validateRoleIdentity, type RoleIdentity } from '../../../deploy/postgres/provisioning.js';
const sqlRoot = fileURLToPath(new URL('../../../packages/db/sql/', import.meta.url));
const auditReference = 'external-review:wave4-source-test-not-runtime-approval';
async function reviewed() {
  const inventory = await discoverMigrationInventory(sqlRoot);
  const proposal = createMigrationSelectionProposal(inventory);
  const selection = reviewMigrationSelection(proposal, auditReference);
  const selected = selectMigrations(inventory, selection);
  return { inventory, proposal, selection, selected, plan: createInstallationPlan(selected, { auditReference, selection }) };
}
describe('Wave4 migration/provisioning source-only offline contract', () => {
  it('default discover refuses; proposal excludes exactly pinned084 with reason and includes085/086', async () => {
    await expect(discoverMigrations(sqlRoot)).rejects.toThrow('explicit reviewed selection');
    const { proposal, selection, inventory, selected } = await reviewed();
    expect(proposal.excluded).toEqual([{ ...WAVE4_REFUSAL }]);
    expect(proposal.included).toHaveLength(89);
    expect(proposal.included.slice(-6).map(x => x.file)).toEqual([
      '085_lp_protected_paper_admission.sql',
      '086_wave4_restricted_composition.sql',
      '087_wave4_protected_authentication.sql',
      '088_wave4_protected_pipeline.sql',
      '089_wave4_protected_financial.sql',
      '090_wave4_protected_load_capture.sql',
    ]);
    expect(() => selectMigrations(inventory, proposal as typeof selection)).toThrow('reviewed');
    expect(await discoverMigrations(sqlRoot, undefined, undefined, selection)).toEqual(selected);
    expect(proposal.inventory).toHaveLength(90);
  });
  it('fresh source, inventory, omission reason/hash and manifest drift all reject', async () => {
    const { inventory, selection } = await reviewed();
    const changed = inventory.map((m, i) => i === 0 ? { ...m, sql: m.sql + '\n', checksum: sourceChecksum(m.sql + '\n') } : m);
    expect(() => selectMigrations(changed, selection)).toThrow('drift');
    expect(() => selectMigrations(inventory.slice(1), selection)).toThrow('complete');
    expect(() => selectMigrations(inventory, { ...selection, excluded: [] })).toThrow('excluded');
    expect(() => selectMigrations(inventory, { ...selection, excluded: [{ ...WAVE4_REFUSAL, reason: 'skip' }] })).toThrow('excluded');
    expect(() => selectMigrations(inventory, { ...selection, manifestChecksum: '0'.repeat(64) })).toThrow('manifestChecksum');
    const refusalDrift = inventory.map(m => m.file === WAVE4_REFUSAL.file ? { ...m, sql: m.sql + '\n', checksum: sourceChecksum(m.sql + '\n') } : m);
    expect(() => createMigrationSelectionProposal(refusalDrift)).toThrow('source identity drift');
  });
  it('replaces ONLY seven exact ownership statements; original source retained, actual installed hashes audited', async () => {
    const { plan, selected, selection } = await reviewed();
    for (const migration of plan.migrations) {
      expect(sourceChecksum(migration.installedSql)).toBe(migration.installedChecksum);
      let restored = migration.installedSql;
      HANDOFF_PINS.forEach(([file, , name, args, target]) => {
        if (migration.file === file) restored = restored.replace(/DO \$handoff\$[^]*?END \$handoff\$;/, `ALTER FUNCTION public.${name}(${args}) OWNER TO ${target};`);
      });
      expect(restored).toBe(migration.sql);
      expect(migration.auditReference).toBe(migration.sql === migration.installedSql ? null : auditReference);
    }
    expect(plan.migrations.filter(m => m.checksum !== m.installedChecksum)).toHaveLength(2);
    const drift = selected.map(m => m.file.startsWith('079_') ? { ...m, sql: m.sql.replace('OWNER TO swat_runtime_lookup;', 'OWNER TO swat_app;') } : m);
    expect(() => createInstallationPlan(drift, { auditReference, selection })).toThrow('drift');
    expect(() => createInstallationPlan(selected, { auditReference: 'wrong-audit', selection })).toThrow('audit');
    const journal = plan.migrations.map(m => ({ file: m.file, checksum: m.checksum, installed_checksum: m.installedChecksum, audit_reference: m.auditReference }));
    expect(() => assertInstallationHistory(journal, plan)).not.toThrow();
    const bad = journal.map(r => r.file.startsWith('079_') ? { ...r, installed_checksum: r.checksum } : r);
    expect(() => assertInstallationHistory(bad, plan)).toThrow('source/installed/audit');
    expect(plan.handoff.provisionChecksum).toBe(sourceChecksum(plan.handoff.provisionSql));
    expect(plan.handoff.cleanupChecksum).toBe(sourceChecksum(plan.handoff.cleanupSql));
    expect(plan.handoff.provisionSql).toContain("current_user<>'swat_handoff_dba'");
    expect(plan.handoff.provisionSql).toContain("current_user='swat_handoff_broker'");
    expect(plan.handoff.provisionSql).toContain('REVOKE ALL ON FUNCTION swat_migration_handoff.transfer(integer,text,text) FROM PUBLIC');
    expect(plan.handoff.provisionSql).toContain('exact function source/signature/current owner/options');
    expect(plan.handoff.provisionSql).not.toMatch(/EXECUTE\s+(format|requested|sql)|GRANT\s+swat_|GRANT\s+CREATE|DROP[^;]*CASCADE/i);
    expect(plan.handoff.cleanupSql).toContain('swat_migration_handoff.retire()');
    expect(plan.handoff.provisionSql).toContain('TO swat_migrator WITH GRANT OPTION');
    expect(plan.handoff.provisionSql).toContain('FROM swat_migrator CASCADE');
    expect(plan.handoff.cleanupSql).toContain('retirement function source/options/owner drift');
    expect(plan.handoff.provisionSql).toContain('requested_source IS DISTINCT FROM');
  });
  it('bootstrap is read-only, exact-true only, checksum-pinned, and returns immutable exact OIDs', async () => {
    const { plan } = await reviewed();
    const validation = plan.handoff.validationSql;
    expect(plan.handoff.validationChecksum).toBe(sourceChecksum(validation));
    expect(validation.trim()).toMatch(/^SELECT /);
    expect(validation).not.toMatch(/\b(CALL|PERFORM|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE|DO)\s/i);
    expect(validation).toContain('CASE WHEN exact IS TRUE');
    for (const check of ['p.proargnames IS NOT DISTINCT FROM', 'p.proargtypes::text=', 'p.proargmodes IS NOT DISTINCT FROM',
      'p.proallargtypes IS NOT DISTINCT FROM', 'p.proargdefaults IS NULL', 'p.procost=100', 'p.prorows=0',
      'p.prosupport=0', 'p.provariadic=0', 'p.proconfig=', 'pg_catalog.aclexplode', 'a.grantor', 'a.is_grantable',
      'pg_catalog.pg_shdepend', 'pg_catalog.pg_depend', "d.deptype='o'", 'pg_catalog.pg_auth_members', "n.nspname='public'",
      "rolsuper AND NOT rolcanlogin", 'pg_catalog.regtype::oid', 'pg_catalog.encode(pg_catalog.sha256']) expect(validation).toContain(check);
    const calls: string[] = [];
    const result = await assertInstallationBootstrap({ query: async sql => {
      calls.push(sql); return { rows: [{ exact: true, namespace_oid: 100, function_oids: [101, 102] }] };
    } }, plan);
    expect(calls).toEqual([validation]);
    expect(result).toEqual({ namespaceOid: 100, functionOids: [101, 102] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.functionOids)).toBe(true);
    for (const rows of [[], [{ exact: false, namespace_oid: 100, function_oids: [101, 102] }],
      [{ exact: 'true', namespace_oid: 100, function_oids: [101, 102] }],
      [{ exact: true, namespace_oid: null, function_oids: [101, 102] }],
      [{ exact: true, namespace_oid: 100, function_oids: [101, 101] }],
      [{ exact: true, namespace_oid: 100, function_oids: [101, 102, 103] }],
      [{ exact: true, namespace_oid: 100, function_oids: ['101', 102] }]]) {
      await expect(assertInstallationBootstrap({ query: async () => ({ rows }) }, plan)).rejects.toThrow('bootstrap validation');
    }
    await expect(assertInstallationBootstrap({ query: async () => { throw new Error('must not query'); } },
      { ...plan, handoff: { ...plan.handoff, validationSql: validation + '\n' } })).rejects.toThrow('checksum');
    for (const sql of ['SELECT true AS exact', 'DROP SCHEMA public CASCADE;']) {
      await expect(assertInstallationBootstrap({ query: async () => { throw new Error('must not query'); } },
        { ...plan, handoff: { ...plan.handoff, validationSql: sql, validationChecksum: sourceChecksum(sql) } })).rejects.toThrow('provenance');
    }
    // Output timestamptz aliases are compared as type identities, never deparser spelling.
    const installed079 = plan.migrations.find(m => m.file.startsWith('079_'))!.installedSql;
    expect(plan.handoff.provisionSql).toContain("'pg_catalog.timestamptz'::pg_catalog.regtype::oid");
    expect(plan.handoff.provisionSql).not.toContain('pg_get_function_result');
    expect(installed079).toContain('p.proargmodes IS NOT DISTINCT FROM');
    expect(plan.handoff.cleanupSql).toContain('p.procost=100');
    // Both app grants precede ownership transfer; temporary WGO follows. Owner's
    // later historical app grants survive retirement CASCADE of migrator grants.
    for (const name of ['swat_apply_perps_reducing_receipt(uuid,text)', 'swat_cancel_expired_financial_intent(uuid)']) {
      const sql = plan.handoff.provisionSql;
      const grant = sql.indexOf(`GRANT EXECUTE ON FUNCTION public.${name} TO swat_app;`);
      const owner = sql.indexOf(`ALTER FUNCTION public.${name} OWNER TO swat_financial_settler;`);
      const temporary = sql.indexOf(`GRANT EXECUTE ON FUNCTION public.${name} TO swat_migrator WITH GRANT OPTION;`);
      expect(grant).toBeGreaterThan(-1); expect(grant).toBeLessThan(owner); expect(owner).toBeLessThan(temporary);
    }
  });
  it('uses only canonical qualified catalog type names in every generated gate', async () => {
    const { plan, inventory } = await reviewed();
    const sql086 = inventory.find(m => m.file === '086_wave4_restricted_composition.sql')!.sql;
    const gates = [plan.handoff.validationSql, plan.handoff.provisionSql, plan.handoff.cleanupSql,
      ...plan.migrations.filter(m => m.file.startsWith('079_') || m.file.startsWith('082_')).map(m => m.installedSql)];
    const expected = new Set(['int4', 'bool', 'timestamptz', 'uuid', 'text', 'record', 'void', 'trigger']);
    for (const gate of gates) {
      const types = [...gate.matchAll(/'pg_catalog\.([^']+)'::pg_catalog\.regtype::oid/g)].map(m => m[1]);
      expect(types.length).toBeGreaterThan(0);
      for (const type of types) expect(expected.has(type!)).toBe(true);
      expect(gate).toContain("'pg_catalog.int4'::pg_catalog.regtype::oid");
      expect(gate).not.toMatch(/pg_catalog\.(?:integer|boolean|timestamp with time zone)/);
    }
    expect(plan.handoff.provisionSql).toContain("'pg_catalog.bool'::pg_catalog.regtype::oid");
    expect(sql086).toContain("WHEN type_name='boolean' THEN 'pg_catalog.bool'");
    expect(sql086).toContain("'plpgsql','bool'");
    expect(sql086).toContain("'plpgsql','timestamptz'");
    expect(sql086).not.toMatch(/'plpgsql','(?:boolean|timestamp with time zone)'/);
    expect(sql086).not.toMatch(/pg_catalog\.(?:integer|boolean|timestamp with time zone)/);
  });
  it('provisioned flags do not imply LOGIN; NOLOGIN function owners never activate', async () => {
    const identity: RoleIdentity = { currentUser: 'swat_lp_admitter', sessionUser: 'swat_lp_admitter', roleSetting: 'none', rowSecurity: 'on',
      canLogin: false, superuser: false, bypassRls: false, inherit: false, createRole: false, createDb: false, replication: false,
      membershipsIn: 0, membershipsOut: 0, ownsRelations: false, ownsFunctions: false, ownsSchemas: false, ownsDatabases: false, schemaCreate: false, databaseCreate: false };
    expect(() => validateRoleIdentity('lpAdmitter', identity, 'disabled')).not.toThrow();
    expect(() => validateRoleIdentity('lpAdmitter', identity, 'active-direct')).toThrow();
    expect(() => validateRoleIdentity('lpAdmitter', { ...identity, canLogin: true }, 'active-direct')).not.toThrow();
    for (const mutation of [{ sessionUser: 'swat_migrator' }, { roleSetting: 'swat_lp_admitter' }, { membershipsOut: 1 }, { inherit: true }, { ownsRelations: true }, { schemaCreate: true }, { rowSecurity: 'off' }]) {
      expect(() => validateRoleIdentity('lpAdmitter', { ...identity, ...mutation }, 'disabled')).toThrow();
    }
    const now = new Date('2026-11-18T00:00:00.000Z');
    const approval = { role: 'lpAdmitter' as const, auditReference, expiresAt: '2026-11-18T01:00:00.000Z', credentialProvisionedExternally: true as const,
      sessionsDrained: true as const, sourceCapabilitiesIndependentlyQualified: true as const };
    expect(createLoginActivationSource(approval, now).sql).toContain('LOGIN VALID UNTIL');
    expect(createLoginActivationSource(approval, now).disableSql).toContain('NOLOGIN PASSWORD NULL');
    const activation = createLoginActivationSource(approval, now);
    expect(activation.sql).toContain('VALID UNTIL expires passwords ONLY');
    expect(activation.passwordValidUntil).toBe(approval.expiresAt);
    expect(activation.requiredExternalDisable).toEqual({ scheduledNoLoginAt: approval.expiresAt,
      sessionDrainAt: approval.expiresAt, enforcedByThisSource: false });
    expect(activation.disableSql).toContain('NOLOGIN does not disconnect');
    expect(() => createLoginActivationSource({ ...approval, role: 'runtimeLookup' }, now)).toThrow();
    expect(() => createLoginActivationSource({ ...approval, role: 'financialSettler' }, now)).toThrow();
    expect(SOURCE_CAPABILITY_MATRIX.authService.sourceCapabilities).toEqual(['087 fixed protected authentication; external committed owner handoff required']);
    expect(SOURCE_CAPABILITY_MATRIX.authOwner.login).toBe('never');
    const roles = await readFile(fileURLToPath(new URL('../../../deploy/postgres/roles.sql', import.meta.url)), 'utf8');
    for (const capability of Object.values(SOURCE_CAPABILITY_MATRIX)) {
      if (capability.role === 'swat_auth_owner') {
        const authProvisioning = await readFile(fileURLToPath(new URL('../../../deploy/postgres/auth-provisioning.ts', import.meta.url)), 'utf8');
        expect(authProvisioning).toContain('CREATE ROLE swat_auth_owner NOLOGIN');
      } else expect(roles).toContain(capability.role);
    }
    expect(roles).toContain('NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT');
    expect(roles).toContain('pg_catalog.pg_control_system() TO swat_system_observer,swat_migrator');
    expect(roles).not.toMatch(/GRANT\s+swat_|ALTER ROLE[^;]+\sLOGIN\b|GRANT[^;]+ON\s+(?:public\.)?(users|user_sessions)/i);
  });
  it('086 grants actual LP write columns/sequence only after complete installed085 guards', async () => {
    const { inventory } = await reviewed();
    const sql = inventory.find(m => m.file === '086_wave4_restricted_composition.sql')!.sql;
    const source085 = inventory.find(m => m.file.startsWith('085_'))!.sql;
    const functions = [...source085.matchAll(/CREATE FUNCTION public\.(\w+)\([^]*?AS \$\$([^]*?)\$\$;/g)];
    expect(functions).toHaveLength(14);
    for (const [, name, body] of functions) { expect(sql).toContain(name!); expect(sql).toContain(sourceChecksum(body!)); }
    for (const [, name] of source085.matchAll(/CREATE TRIGGER (lp085_\w+)/g)) expect(sql).toContain(name!);
    for (const check of ['relowner=migrator','relrowsecurity AND relforcerowsecurity','p.proowner=migrator','NOT p.prosecdef','p.proconfig=',
      'tgtype=t.trigger_type',"tgenabled='O'",'tgqual IS NULL','tgnargs=0','pg_get_expr(polqual','IS DISTINCT FROM true',
      'missing/extra policy','history sequence identity/owner']) expect(sql).toContain(check);
    expect(sql.indexOf('END $guard$;')).toBeLessThan(sql.indexOf('GRANT INSERT('));
    expect(sql).toMatch(/GRANT UPDATE\([^)]*rung_allocations[^)]*strategy_type[^)]*\) ON public.lp_positions TO swat_app/);
    expect(sql).toContain('GRANT USAGE ON SEQUENCE public.lp_position_state_history_id_seq TO swat_app');
    expect(sql).toContain('GRANT UPDATE(max_pool_allocation_pct)');
    expect(sql).toContain('GRANT UPDATE(status) ON public.lp_copy_subscriptions');
    expect(sql).not.toMatch(/CREATE POLICY|GRANT\s+(?:INSERT|UPDATE)\s+ON\s+public\.(?:lp_positions|lp_exact_positions|lp_exact_operations|lp_exact_receipts)\b|TO swat_auth_service|TO swat_system_observer/);
    for (const check of ['full noninternal trigger inventory drift', 'SELECT * FROM actual EXCEPT SELECT * FROM expected',
      'SELECT * FROM expected EXCEPT SELECT * FROM actual', 'trg_lp_acquisition_immutable',
      'eadc7ce25888d29f7cd1ef634e03780f0600808e99d8f53967cecaa952f6710e',
      'p.proargnames IS NOT DISTINCT FROM', 'p.proargtypes::text=', 'p.proargmodes IS NULL',
      'p.proallargtypes IS NULL', 'p.provariadic=0', 'p.proargdefaults IS NULL', 'p.procost=100', 'p.prorows=0',
      "p.prorettype=to_regtype('pg_catalog.'||f.result_type)", 'aclexplode(col.attacl)', 'a.grantor<>migrator', 'a.is_grantable',
      'protected admissions canonical ACL restoration drift', 'admitter context SELECT-only ACL drift',
      'FROM PUBLIC,swat_app,swat_lp_admitter', 'COALESCE(cardinality(attacl),0)<>0']) expect(sql).toContain(check);
    expect(sql).toContain('GRANT SELECT ON public.lp_protected_quote_admissions,public.lp_protected_settlement_admissions TO swat_app,swat_lp_admitter');
    expect(sql).toContain('GRANT INSERT ON public.lp_protected_quote_admissions,public.lp_protected_settlement_admissions TO swat_lp_admitter');
    expect(sql).toContain('GRANT SELECT(id,user_id,state,auto_rebalance) ON public.lp_positions TO swat_lp_admitter');
    expect(sql).not.toMatch(/GRANT\s+(?:TRUNCATE|UPDATE|DELETE)[^;]*ON public\.lp_protected_(?:quote|settlement)_admissions/i);
  });
});
