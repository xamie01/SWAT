import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { discoverMigrationInventory, discoverMigrations } from '../../../packages/db/src/migration-discovery.js';
import { createMigrationSelectionProposal, reviewMigrationSelection, selectMigrations, sourceChecksum, WAVE4_REFUSAL } from '../../../packages/db/src/migration-selection.js';
import { assertInstallationHistory, createInstallationPlan, HANDOFF_PINS } from '../../../packages/db/src/installation-plan.js';
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
    expect(proposal.included).toHaveLength(85);
    expect(proposal.included.slice(-2).map(x => x.file)).toEqual(['085_lp_protected_paper_admission.sql', '086_wave4_restricted_composition.sql']);
    expect(() => selectMigrations(inventory, proposal as typeof selection)).toThrow('reviewed');
    expect(await discoverMigrations(sqlRoot, undefined, undefined, selection)).toEqual(selected);
    expect(proposal.inventory).toHaveLength(86);
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
    expect(plan.handoff.provisionSql).toContain("current_user <> 'swat_handoff_broker'");
    expect(plan.handoff.provisionSql).toContain('REVOKE ALL ON FUNCTION swat_migration_handoff.transfer(integer,text,text) FROM PUBLIC');
    expect(plan.handoff.provisionSql).toContain('exact function source/signature/current owner/options');
    expect(plan.handoff.provisionSql).not.toMatch(/EXECUTE\s+(format|requested|sql)|GRANT\s+swat_|GRANT\s+CREATE|DROP[^;]*CASCADE/i);
    expect(plan.handoff.cleanupSql).toContain('swat_migration_handoff.retire()');
    expect(plan.handoff.provisionSql).toContain('TO swat_migrator WITH GRANT OPTION');
    expect(plan.handoff.provisionSql).toContain('FROM swat_migrator CASCADE');
    expect(plan.handoff.cleanupSql).toContain('retirement function source/options/owner drift');
    expect(plan.handoff.provisionSql).toContain('requested_source IS DISTINCT FROM');
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
    expect(() => createLoginActivationSource({ ...approval, role: 'runtimeLookup' }, now)).toThrow();
    expect(() => createLoginActivationSource({ ...approval, role: 'financialSettler' }, now)).toThrow();
    expect(SOURCE_CAPABILITY_MATRIX.authService.sourceCapabilities).toEqual([]);
    const roles = await readFile(fileURLToPath(new URL('../../../deploy/postgres/roles.sql', import.meta.url)), 'utf8');
    for (const capability of Object.values(SOURCE_CAPABILITY_MATRIX)) expect(roles).toContain(capability.role);
    expect(roles).toContain('NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT');
    expect(roles).toContain('pg_catalog.pg_control_system() TO swat_system_observer,swat_migrator');
    expect(roles).not.toMatch(/GRANT\s+swat_|ALTER ROLE[^;]+\sLOGIN\b|GRANT[^;]+ON\s+(?:public\.)?(users|user_sessions)/i);
  });
  it('086 grants actual LP write columns/sequence only after complete installed085 guards', async () => {
    const { inventory } = await reviewed();
    const sql = inventory.at(-1)!.sql;
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
    expect(sql).not.toMatch(/CREATE POLICY|GRANT\s+(INSERT|UPDATE)\s+ON|TO swat_auth_service|TO swat_system_observer/);
  });
});
