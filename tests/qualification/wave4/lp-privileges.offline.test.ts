import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

// Source reads only: no production module imports, SQL client, child, or service.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const sql = source('../../../packages/db/sql/084_wave4_lp_runtime_privileges.sql');
const executable = sql.replace(/--[^\n]*/g, '').trim();
// Role/DDL token checks must not confuse catalog privilege-name string literals
// (for example 'CREATE') with executable role or schema alteration statements.
const tokens = executable.replace(/'(?:''|[^'])*'/g, "''");
const boundary = source('../../../packages/db/sql/070_runtime_role_boundary.sql');
const exact = source('../../../packages/db/sql/083_lp_exact_paper_operations.sql');
const base = source('../../../packages/db/sql/066_lp_dashboard.sql');
const roles = source('../../../deploy/postgres/roles.sql');
const roleAssertion = source('../../../packages/db/src/database-role.ts');
const store = source('../../../packages/db/src/lp-paper-store.ts');
const domains = source('./domains.ts');
const cli = source('./cli.ts');
const pipeline = source('./pipeline.ts');
const core = source('./core.ts');
const proposal = source('../../../threats/project-completion-20261117/WAVE4-LP-PRIVILEGES-PROPOSAL.md');
const compact = (text: string) => text.replace(/\s+/g, ' ').trim();
const columns = (text: string) => text.split(',').map(value => value.trim()).sort();

const grants = [...executable.matchAll(/GRANT\s+([\s\S]*?)\s+ON\s+(SEQUENCE\s+)?public\.([a-z_]+)\s+TO\s+([a-z_]+)\s*;/g)]
  .map(match => ({ privilege: compact(match[1]!), sequence: Boolean(match[2]), table: match[3]!, role: match[4]! }));
function grantedColumns(table: string, privilege: string) {
  const grant = grants.find(row => row.table === table && row.privilege.startsWith(`${privilege} (`));
  expect(grant, `${privilege} grant for ${table}`).toBeDefined();
  return columns(grant!.privilege.slice(privilege.length + 2, -1));
}
function insertedColumns(table: string) {
  const match = store.match(new RegExp(`INSERT INTO ${table}\\s*\\(([^)]+)\\)`));
  expect(match, `actual store INSERT for ${table}`).not.toBeNull();
  return columns(match![1]!);
}

describe('S2 canonical LP privilege source proposal; static/offline only', () => {
  it('pins the complete column-level grant allowlist and one exact sequence', () => {
    expect(grants).toEqual([
      { privilege: 'SELECT (user_id, max_pool_allocation_pct)', sequence: false, table: 'lp_guardrail_configs', role: 'swat_app' },
      { privilege: 'UPDATE (updated_at)', sequence: false, table: 'lp_guardrail_configs', role: 'swat_app' },
      { privilege: 'SELECT (id, user_id, chain, pool_address, state, auto_rebalance, acquisition_mode, acquisition_provenance, deposit_value_usd)', sequence: false, table: 'lp_positions', role: 'swat_app' },
      { privilege: 'INSERT (user_id, chain, protocol, pool_address, strategy_type, range_lower, range_upper, rung_allocations, deposit_amount, deposit_asset, state, auto_rebalance, acquisition_mode, acquisition_provenance, deposit_value_usd, valuation_evidence, paper_plan, acquisition_key, acquisition_fingerprint)', sequence: false, table: 'lp_positions', role: 'swat_app' },
      { privilege: 'UPDATE (state, updated_at, paper_plan, range_lower, range_upper, closed_at)', sequence: false, table: 'lp_positions', role: 'swat_app' },
      { privilege: 'INSERT (position_id, from_state, to_state, reason)', sequence: false, table: 'lp_position_state_history', role: 'swat_app' },
      { privilege: 'USAGE', sequence: true, table: 'lp_position_state_history_id_seq', role: 'swat_app' },
      { privilege: 'SELECT (id, user_id, master_wallet_address, chain, venue, allocated_budget_usd, max_capital_per_position_usd, status, created_at, updated_at)', sequence: false, table: 'lp_copy_subscriptions', role: 'swat_app' },
      { privilege: 'UPDATE (updated_at)', sequence: false, table: 'lp_copy_subscriptions', role: 'swat_app' },
      { privilege: 'SELECT (user_id, subscription_id, status, follower_position_id)', sequence: false, table: 'lp_copy_executions', role: 'swat_app' },
      { privilege: 'INSERT (subscription_id, user_id, master_position_id, follower_position_id, chain, action, master_deposit_usd, follower_deposit_usd, scale_ratio, status, error_message)', sequence: false, table: 'lp_copy_executions', role: 'swat_app' }
    ]);
    // Reject unparsed/dynamic/role grants as well as extra valid relation grants.
    expect(executable.match(/\bGRANT\b/g)).toHaveLength(grants.length);
    expect(executable.slice(executable.indexOf('END $$;') + 'END $$;'.length).trim()).toBe('');
    const firstStatement = executable.slice(executable.indexOf('BEGIN') + 'BEGIN'.length).trim();
    expect(firstStatement).toMatch(/^RAISE EXCEPTION '084 application refused:/);
    expect(executable.indexOf('GRANT SELECT')).toBeLessThan(executable.indexOf('END $$;'));
  });

  it('preserves refused084 INSERT coverage and records its later rebalance UPDATE gap', () => {
    for (const table of ['lp_positions', 'lp_position_state_history', 'lp_copy_executions']) {
      expect(grantedColumns(table, 'INSERT')).toEqual(insertedColumns(table));
    }
    const assignments = [...store.matchAll(/UPDATE\s+lp_positions\s+SET\s+([\s\S]*?)\s+WHERE\b/g)]
      .flatMap(match => match[1]!.split(',').map(value => value.split('=')[0]!.trim()));
    const required = [...new Set(assignments)].sort();
    const preserved = grantedColumns('lp_positions', 'UPDATE');
    expect(required.filter(column => !preserved.includes(column))).toEqual(['rung_allocations', 'strategy_type']);
    expect(preserved.every(column => required.includes(column))).toBe(true);
    expect(executable.slice(executable.indexOf('BEGIN') + 'BEGIN'.length).trim()).toMatch(/^RAISE EXCEPTION '084 application refused:/);
    expect(grantedColumns('lp_position_state_history', 'INSERT')).not.toContain('id');
    expect(grantedColumns('lp_positions', 'INSERT')).not.toContain('id');
  });

  it('covers exposure, returning identity, tenant joins and copy-budget reads without global reads', () => {
    for (const fragment of [
      'JOIN lp_positions p ON p.id=e.position_id AND p.user_id=e.user_id',
      'p.state, p.auto_rebalance', 'RETURNING id',
      'SUM(deposit_value_usd)', "acquisition_mode <> 'paper'", "acquisition_provenance <> 'exact-injected-paper-v2'",
      'chain=$2 AND pool_address=$3', "FROM lp_positions WHERE user_id=$1 AND state <> 'closed'",
      'c.user_id=$1 AND c.subscription_id=$2', 'e.position_id=c.follower_position_id'
    ]) expect(store).toContain(fragment);
    expect(grantedColumns('lp_positions', 'SELECT')).toEqual(columns('id,user_id,chain,pool_address,state,auto_rebalance,acquisition_mode,acquisition_provenance,deposit_value_usd'));
    expect(grantedColumns('lp_copy_executions', 'SELECT')).toEqual(columns('user_id,subscription_id,status,follower_position_id'));
    expect(grants.some(row => /lp_pools|lp_tracked_wallets|lp_wallet_|users/.test(row.table))).toBe(false);
  });

  it('provides minimal locking UPDATE without cap, reserve or subscription-budget authority', () => {
    expect(store).toContain('FROM lp_guardrail_configs WHERE user_id=$1 FOR UPDATE');
    expect(store).toContain('FROM lp_copy_subscriptions WHERE user_id=$1 AND id=$2 FOR UPDATE');
    expect(store).toContain('FOR UPDATE OF p,e');
    expect(grantedColumns('lp_guardrail_configs', 'SELECT')).toEqual(columns('user_id,max_pool_allocation_pct'));
    expect(grantedColumns('lp_guardrail_configs', 'UPDATE')).toEqual(['updated_at']);
    expect(grantedColumns('lp_copy_subscriptions', 'UPDATE')).toEqual(['updated_at']);
    expect(grantedColumns('lp_copy_subscriptions', 'SELECT')).toEqual(columns('id,user_id,master_wallet_address,chain,venue,allocated_budget_usd,max_capital_per_position_usd,status,created_at,updated_at'));
    expect(store).not.toMatch(/INSERT INTO lp_guardrail_configs|UPDATE lp_guardrail_configs|INSERT INTO lp_copy_subscriptions|UPDATE lp_copy_subscriptions/);
  });

  it('does not paper over the current seedOwners table-level preflight or initialization', () => {
    expect(domains).toContain("has_table_privilege(current_user,'lp_guardrail_configs','INSERT')");
    expect(domains).toContain("has_table_privilege(current_user,'lp_positions','INSERT')");
    expect(domains).toContain("has_table_privilege(current_user,'lp_position_state_history','INSERT')");
    expect(domains).toContain('INSERT INTO lp_guardrail_configs(user_id,max_pool_allocation_pct)');
    expect(domains).toContain('Canonical base LP DML privileges unavailable; qualification cannot add harness-only grants');
    expect(domains).toContain('store: createLpPaperSqlStore(');
    expect(grants.some(row => row.table === 'lp_guardrail_configs' && row.privilege.startsWith('INSERT'))).toBe(false);
    expect(proposal).toContain('seedOwners remains blocked');
    expect(proposal).toContain('has_column_privilege');
  });

  it('requires trusted ownership, forced exact tenant policies and live receipt guards before grants', () => {
    const guard = executable.slice(0, executable.indexOf('END $$;') + 'END $$;'.length);
    expect(guard).toMatch(/^DO \$\$/);
    for (const fragment of [
      "current_user <> 'swat_migrator' OR session_user <> 'swat_migrator'",
      "current_setting('row_security') <> 'on'", 'NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls',
      'NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolinherit',
      'member = app_oid OR roleid = app_oid', 'member = migrator_oid OR roleid = migrator_oid',
      'relowner = app_oid', 'nspowner = app_oid', 'proowner = app_oid', 'datdba = app_oid',
      "has_schema_privilege('swat_app', 'public', 'CREATE')", "has_database_privilege('swat_app', current_database(), 'CREATE')",
      'c.relowner = migrator_oid AND c.relrowsecurity AND c.relforcerowsecurity',
      "policy_row.polcmd <> '*'", 'policy_row.polroles <> ARRAY[app_oid]::oid[]',
      'policy_row.polqual', 'policy_row.polwithcheck', 'IS DISTINCT FROM expected_expression',
      "ELSE 'user_id=current_app_user_id'", 'p.user_id=current_app_user_id',
      'pg_catalog.aclexplode(c.relacl)', 'pg_catalog.aclexplode(att.attacl)', 'a.grantee IN (0, app_oid)',
      "t.tgenabled = 'O'", 't.tgtype = trigger_row.trigger_type', 'p.proowner = migrator_oid AND NOT p.prosecdef'
    ]) expect(guard).toContain(fragment);
    for (const name of [
      'trg_lp_exact_acquisition_snapshot', 'trg_lp_exact_position_guard', 'trg_lp_exact_operation_guard',
      'trg_lp_exact_receipt_immutable', 'trg_lp_exact_legacy_guard', 'trg_lp_position_state_transition'
    ]) { expect(guard).toContain(name); expect(exact + base).toContain(name); }
    expect(guard).toContain('refuses missing or additional tenant policies');
  });

  it('pins literal sealed guard bodies and refuses conditional or altered installed trigger coverage', () => {
    const rows = [...executable.matchAll(/\('([a-z_]+)', '([a-z_]+)', '([a-z_]+)', (\d+), '([a-f0-9]{64})'\)/g)];
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      const body = (exact + base).match(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION ${row[3]}\\(\\)[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$`))?.[1];
      expect(body).toBeDefined();
      expect(createHash('sha256').update(body!).digest('hex')).toBe(row[5]);
      expect(createHash('sha256').update(`${body}\nRETURN NEW;`).digest('hex')).not.toBe(row[5]);
    }
    for (const fragment of [
      't.tgqual IS NULL', "t.tgattr::text = CASE WHEN trigger_row.trigger_name = 'trg_lp_position_state_transition'",
      "attname = 'state' AND NOT attisdropped", "ELSE '' END", "t.tgnargs = 0 AND t.tgargs = ''::bytea",
      't.tgconstraint = 0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred', 't.tgoldtable IS NULL AND t.tgnewtable IS NULL',
      "p.prorettype = 'pg_catalog.trigger'::regtype", "p.prokind = 'f' AND p.provolatile = 'v'",
      'p.proconfig IS NULL AND p.prosupport = 0', "lanname = 'plpgsql'",
      "pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8'))"
    ]) expect(executable).toContain(fragment);
  });

  it('adds only required history nextval USAGE after canonical 070 sequence revocation', () => {
    expect(boundary).toContain('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM swat_app;');
    expect(boundary).toContain('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;');
    expect(boundary).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE swat_migrator REVOKE ALL ON SEQUENCES FROM swat_app;');
    expect(boundary).not.toMatch(/^GRANT .*SEQUENCE/gm);
    expect(base).toContain('id          BIGSERIAL PRIMARY KEY');
    expect(executable).toContain("pg_get_serial_sequence('public.lp_position_state_history', 'id')");
    expect(executable).toContain("IS DISTINCT FROM 'public.lp_position_state_history_id_seq'");
    expect(executable).toContain("AND relkind = 'S' AND relowner = migrator_oid");
    expect(grants.filter(row => row.sequence)).toEqual([
      { privilege: 'USAGE', sequence: true, table: 'lp_position_state_history_id_seq', role: 'swat_app' }
    ]);
    expect(exact).toContain('GRANT SELECT,INSERT,UPDATE ON lp_exact_positions,lp_exact_operations TO swat_app;');
    expect(exact).toContain('GRANT SELECT,INSERT ON lp_exact_receipts TO swat_app;');
    expect(executable).not.toMatch(/GRANT[^;]+ON\s+public\.lp_exact_/);
  });

  it('retains receipt-first same-transaction exact financial guards rather than minting authority', () => {
    const settlement = store.slice(store.indexOf('settle: async'));
    const writes = ['INSERT INTO lp_exact_receipts', 'UPDATE lp_exact_operations', 'UPDATE lp_exact_positions', 'UPDATE lp_positions'];
    const offsets = writes.map(write => settlement.indexOf(write));
    expect(offsets.every(offset => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    for (const fragment of [
      'LP exact receipts are append only', 'LP operation admission requires pending state without receipt',
      'LP operation identity, quote and plan are immutable', 'LP completion requires immutable durable receipt',
      'LP acquisition retry snapshot must equal initial committed position', 'LP exact acquisition evidence immutable',
      'LP position update requires completed revision-bound receipt', 'LP financial mutation requires exact completed receipt',
      'LP exact closed inventory cannot be reopened by legacy state',
      "op.data->>'positionRevision' <> OLD.data->>'revision'", "r.data=op.data->'receipt'",
      "r.data=NEW.data->'receipt'", "'mode'='paper'", "'finality'='paper-settled'"
    ]) expect(exact).toContain(fragment);
    expect(grants.some(row => /DELETE|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN|ALL/.test(row.privilege))).toBe(false);
    expect(tokens).not.toMatch(/\b(?:CREATE|ALTER|DROP|REVOKE|EXECUTE)\b|\bSECURITY\s+DEFINER\b|\bSET\s+(?:ROLE|SESSION\s+AUTHORIZATION)\b|\bWITH\s+GRANT\s+OPTION\b/i);
    expect(executable.slice(executable.indexOf('END $$;') + 'END $$;'.length).trim()).toBe('');
    expect(executable).not.toMatch(/app\.bypass_rls|app\.current_user_id|source_provider_authorities|worker_runtime_capabilities|custody_secret_admissions|withdrawal_reducing_receipts/);
  });

  it('keeps authentication, role enablement and real runtime acceptance unresolved and disabled', () => {
    expect(sql).toContain('SOURCE-ONLY PROPOSAL. NOT APPLIED.');
    expect(sql).toContain('NOLOGIN/auth/global-read remain separate unresolved decisions.');
    expect(roles).toContain("roles text[]:=ARRAY['swat_app'");
    expect(roles).toContain("FOREACH role_name IN ARRAY roles LOOP");
    expect(roles).toContain("format('ALTER ROLE %I NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION',role_name)");
    expect(roleAssertion).toContain("role?.role_name !== name || role?.session_role !== name");
    expect(roleAssertion).toContain("denied.push('owns_objects', 'can_create')");
    expect(cli).toMatch(/export async function runQualification\([^)]*\) \{\s*await privateConfig\(configPath\);\s*throw new Error\('Wave4 real execution is unavailable/);
    expect(pipeline).toMatch(/export async function exercisePaperPipeline\([^)]*\): Promise<never> \{\s*throw new Error\('Joined pipeline execution unavailable/);
    expect(core).toContain('runtimeAccepted: false, liveCapabilityAccepted: false, productionReady: false');
    expect(proposal).toContain('runtimeAccepted=false, liveCapabilityAccepted=false, productionReady=false');
    expect(proposal).toContain('No tests, emits, typechecks, migration application');
  });
});
