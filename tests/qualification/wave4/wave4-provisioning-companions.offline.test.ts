import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  bindPipelineProvisioningSource,
  assertWave4PipelineRoleWithClient,
  validateWave4PipelineInstallation,
  provisionWave4PipelineCompanion,
  expectedPipelineRoutineExecuteGrantees,
  PipelineCommitUncertainError,
  PIPELINE_PROVISIONING_STATUS,
  PIPELINE_ROUTINE_INVENTORY,
  PIPELINE_RELATION_INVENTORY,
  PIPELINE_LOCAL_FK_INVENTORY,
  PIPELINE_ROLE_INVENTORY,
  PIPELINE_NEW_LOOKUP_ROUTINES,
  PIPELINE_EXISTING_BROKER_BOUNDARY,
  type PipelineCatalogPhase,
  type PipelineSourceBytes,
  type PipelineSourceBinding,
  type PipelineQueryClient,
  type PipelineClientLease
} from '../../../deploy/postgres/wave4-pipeline-provisioning.js';
import {
  WAVE4_FINANCIAL_PROVISIONING_STATUS,
  WAVE4_FINANCIAL_ROLES,
  WAVE4_FINANCIAL_ROUTINES,
  WAVE4_FINANCIAL_RELATIONS,
  WAVE4_FINANCIAL_AUDIT_VIEW,
  WAVE4_FINANCIAL_FOREIGN_KEYS,
  WAVE4_FINANCIAL_TRIGGERS,
  requireWave4FinancialSourceComplete,
  assertWave4FinancialRoleWithClient,
  validateWave4FinancialInstallation,
  provisionWave4FinancialCompanion,
  Wave4FinancialCommitUncertainError,
  type FinancialProvisioningQueryClient,
  type FinancialProvisioningClientLease
} from '../../../deploy/postgres/wave4-financial-provisioning.js';
import {
  WAVE4_LOAD_PROVISIONING_STATUS,
  WAVE4_LOAD_DISABLED_ROLES,
  WAVE4_LOAD_ROUTINES,
  WAVE4_LOAD_FUNCTION_SIGNATURES,
  WAVE4_LOAD_OWNER_TRANSFERS,
  WAVE4_LOAD_CAPTURE_RELATIONS,
  WAVE4_LOAD_FOREIGN_KEYS,
  provisionWave4LoadCaptureWithClient,
  assertWave4LoadRoleWithClient,
  validateWave4LoadInstallation,
  provisionWave4LoadCompanion,
  Wave4LoadCommitUncertainError,
  type LoadProvisioningQueryClient,
  type LoadProvisioningClientLease
} from '../../../deploy/postgres/wave4-load-provisioning.js';
import type { PoolClient } from '../../../packages/db/src/copy-trade-lifecycle-owned.js';

type CompanionKind = 'pipeline' | 'financial' | 'load';

async function loadPipelineSources(): Promise<PipelineSourceBytes> {
  return {
    sql088: await readFile(new URL('../../../packages/db/sql/088_wave4_protected_pipeline.sql', import.meta.url)),
    sql080: await readFile(new URL('../../../packages/db/sql/080_immutable_valuation_corrections.sql', import.meta.url))
  };
}

function assertPgRoleLiteralPrivilegeGuard(sql: string, createdRoles: ReadonlySet<string>): void {
  const privPattern = /\bhas_(?:table|column|function|schema|database)_privilege\s*\(\s*'([^']+)'/g;
  for (const match of sql.matchAll(privPattern)) {
    const role = match[1]!;
    if (role.toUpperCase() === 'PUBLIC' || createdRoles.has(role)) continue;
    const escaped = role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = sql.slice(Math.max(0, (match.index ?? 0) - 300), (match.index ?? 0) + match[0]!.length);
    const guardPattern = new RegExp(
      `CASE\\s+WHEN\\s+EXISTS\\s*\\(\\s*SELECT\\s+1\\s+FROM\\s+pg_catalog\\.pg_roles\\b[^)]*rolname\\s*=\\s*'${escaped}'[^)]*\\)\\s+THEN\\s+has_(?:table|column|function|schema|database)_privilege\\s*\\(\\s*'${escaped}'$`,
      'i'
    );
    if (!guardPattern.test(prefix)) {
      const err = new Error(`role "${role}" does not exist`) as Error & { code: string };
      err.code = '42704';
      throw err;
    }
  }
}

function createPipelineHarness(binding: PipelineSourceBinding, dbaRole = 'ext_dba') {
  const calls: string[] = [];
  const releases: boolean[] = [];
  const createdRoles = new Set<string>(
    PIPELINE_ROLE_INVENTORY.map(r => r.role).filter(r => r !== 'swat_worker_receipt_writer')
  );
  const roleSettings = new Map<string, string[]>(
    [...createdRoles].map(r => [r, ['row_security=on', 'search_path=pg_catalog']])
  );
  const routineOwners = new Map<string, string>(
    PIPELINE_ROUTINE_INVENTORY.map(r => [r.signature, 'swat_migrator'])
  );
  let publicCreate = false;
  let backendPid = 201;
  let inTx = false;
  let driftPid = false;
  let commitMode: 'ok' | 'throw' | 'bad-cmd' = 'ok';
  let identityOverride: Record<string, unknown> = {};
  let roleMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let relMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let procMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let policyRows: Record<string, unknown>[] = [];
  let nsMutator: ((rows: Record<string, unknown>[]) => void) | null = null;

  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    assertPgRoleLiteralPrivilegeGuard(sql, createdRoles);
    if (sql === 'BEGIN' || sql === 'BEGIN READ ONLY') {
      inTx = true;
      return { rows: [], command: 'BEGIN' };
    }
    if (sql === 'COMMIT') {
      if (commitMode === 'throw') throw new Error('lost commit response');
      if (commitMode === 'bad-cmd') return { rows: [], command: 'ROLLBACK' };
      inTx = false;
      return { rows: [], command: 'COMMIT' };
    }
    if (sql === 'ROLLBACK') {
      inTx = false;
      return { rows: [], command: 'ROLLBACK' };
    }
    if (sql.includes("SELECT set_config('statement_timeout'") || sql.includes("SELECT set_config('search_path'")) {
      return { rows: [{ set_config: 'pg_catalog' }] };
    }
    if (sql.startsWith('LOCK TABLE ')) return { rows: [] };
    if (sql.includes('CREATE ROLE swat_worker_receipt_writer')) {
      createdRoles.add('swat_worker_receipt_writer');
      return { rows: [] };
    }
    if (sql.startsWith('ALTER ROLE swat_worker_receipt_writer SET ')) {
      const cur = roleSettings.get('swat_worker_receipt_writer') ?? [];
      if (sql.includes('row_security=on') && !cur.includes('row_security=on')) cur.push('row_security=on');
      if (sql.includes('search_path=pg_catalog') && !cur.includes('search_path=pg_catalog')) cur.push('search_path=pg_catalog');
      roleSettings.set('swat_worker_receipt_writer', cur);
      return { rows: [] };
    }
    if (sql === 'GRANT CREATE ON SCHEMA public TO swat_runtime_lookup') {
      publicCreate = true;
      return { rows: [] };
    }
    if (sql === 'REVOKE CREATE ON SCHEMA public FROM swat_runtime_lookup') {
      publicCreate = false;
      return { rows: [] };
    }
    const alterFn = /^ALTER FUNCTION (public\.[^(]+\([^)]*\)) OWNER TO swat_runtime_lookup$/.exec(sql);
    if (alterFn) {
      if (!publicCreate) throw new Error('missing temp CREATE on public');
      routineOwners.set(alterFn[1]!, 'swat_runtime_lookup');
      return { rows: [] };
    }
    if (sql.startsWith('REVOKE ALL ON FUNCTION ')) return { rows: [] };
    if (sql.includes('pg_catalog.pg_stat_activity') && sql.includes('current_user AS current_role')) {
      if (driftPid && inTx && calls.filter(c => c.includes('current_user AS current_role')).length >= 2) {
        backendPid += 1;
      }
      return {
        rows: [{
          current_role: dbaRole,
          session_role: dbaRole,
          role_setting: 'none',
          row_security: 'on',
          backend: backendPid,
          superuser: true,
          can_login: true,
          bypass_rls: false,
          inherit: false,
          create_role: false,
          create_db: false,
          replication: false,
          has_memberships: false,
          transaction_clean: true,
          ...identityOverride
        }]
      };
    }
    if (sql.includes('FROM pg_catalog.pg_roles r WHERE r.rolname = ANY')) {
      const lookupOwned = [
        'public.swat_claim_runtime_capability(uuid)',
        'public.has_worker_execution_capability(uuid)',
        ...PIPELINE_NEW_LOOKUP_ROUTINES.filter(sig => routineOwners.get(sig) === 'swat_runtime_lookup')
      ].sort();
      const rows: Record<string, unknown>[] = [...createdRoles].map(rolname => ({
        rolname,
        rolcanlogin: false,
        unsafe: false,
        membership: false,
        owns: false,
        can_create: rolname === 'swat_runtime_lookup' ? publicCreate : false,
        functions: rolname === 'swat_runtime_lookup' ? lookupOwned : [],
        extra_ownership: false
      }));
      roleMutator?.(rows);
      return { rows };
    }
    if (sql.includes('FROM pg_catalog.pg_db_role_setting s')) {
      return {
        rows: [...roleSettings.entries()].map(([rolname, setconfig]) => ({
          rolname,
          setdatabase: 0,
          setconfig
        }))
      };
    }
    if (sql.includes('FROM pg_catalog.pg_namespace n')) {
      const rows: Record<string, unknown>[] = [{ nspname: 'public', owner: 'swat_migrator', restricted_or_public_create: publicCreate }];
      nsMutator?.(rows);
      return { rows };
    }
    if (sql.includes('FROM pg_catalog.pg_class c')) {
      const rows: Record<string, unknown>[] = PIPELINE_RELATION_INVENTORY.map(r => ({
        relation: r.relation,
        owner: 'swat_migrator',
        relkind: 'r',
        relrowsecurity: true,
        relforcerowsecurity: true,
        public_or_grantable_acl: false
      }));
      relMutator?.(rows);
      return { rows };
    }
    if (sql.includes('FROM pg_catalog.pg_proc p') && sql.includes('JOIN pg_catalog.pg_language l')) {
      const rows: Record<string, unknown>[] = PIPELINE_ROUTINE_INVENTORY.map(r => {
        const owner = routineOwners.get(r.signature) ?? 'swat_migrator';
        const pin = binding.routines.find(b => b.signature === r.signature)!;
        const aclPhase: PipelineCatalogPhase =
          owner === 'swat_runtime_lookup'
            ? (r.signature === PIPELINE_NEW_LOOKUP_ROUTINES[1] ? 'both-lookup-owners-committed' : 'backend-owner-committed')
            : 'inert';
        return {
          signature: r.signature,
          owner,
          prosrc: pin.body,
          prokind: 'f',
          prosecdef: r.securityDefiner,
          proisstrict: false,
          proleakproof: false,
          provolatile: 'v',
          proparallel: 'u',
          pronargdefaults: 0,
          proconfig: ['search_path=pg_catalog'],
          lanname: r.language,
          acl: expectedPipelineRoutineExecuteGrantees(r.signature, aclPhase).map(grantee => ({
            grantor: owner,
            grantee,
            privilege: 'EXECUTE',
            grantable: false
          }))
        };
      });
      procMutator?.(rows);
      return { rows };
    }
    if (sql.includes('FROM pg_catalog.pg_proc p')) {
      return {
        rows: PIPELINE_EXISTING_BROKER_BOUNDARY.map(sig => ({
          signature: sig,
          owner: sig.includes('runtime_capability') || sig.includes('worker_execution') ? 'swat_runtime_lookup' : 'swat_financial_settler'
        }))
      };
    }
    if (sql.includes('FROM pg_catalog.pg_policy p')) return { rows: policyRows };
    if (sql.includes('FROM pg_catalog.pg_constraint con')) {
      return {
        rows: PIPELINE_LOCAL_FK_INVENTORY.map(f => ({
          relation: f.relation,
          name: f.name,
          columns: [...f.columns],
          target: f.target,
          target_columns: [...f.targetColumns],
          delete_action: f.deleteAction,
          update_action: f.updateAction,
          match_type: f.matchType,
          deferrable: f.deferrable,
          initially_deferred: f.initiallyDeferred,
          validated: f.validated
        }))
      };
    }
    throw new Error(`Unexpected pipeline query: ${sql}`);
  });

  const client = { query } as unknown as PipelineQueryClient;
  const acquire = async (): Promise<PipelineClientLease> => ({
    client,
    release: (broken: boolean) => { releases.push(broken); }
  });
  return {
    kind: 'pipeline' as const,
    client,
    acquire,
    calls,
    releases,
    setIdentityOverride: (p: Record<string, unknown>) => { identityOverride = p; },
    setRoleMutator: (fn: (rows: Record<string, unknown>[]) => void) => { roleMutator = fn; },
    setRelMutator: (fn: (rows: Record<string, unknown>[]) => void) => { relMutator = fn; },
    setProcMutator: (fn: (rows: Record<string, unknown>[]) => void) => { procMutator = fn; },
    setNsMutator: (fn: (rows: Record<string, unknown>[]) => void) => { nsMutator = fn; },
    setPolicies: (rows: Record<string, unknown>[]) => { policyRows = rows; },
    setCommitMode: (mode: 'ok' | 'throw' | 'bad-cmd') => { commitMode = mode; },
    enablePidDrift: () => { driftPid = true; },
    preparePhase: (phase: PipelineCatalogPhase) => {
      if (phase === 'inert') {
        createdRoles.delete('swat_worker_receipt_writer');
        roleSettings.delete('swat_worker_receipt_writer');
        routineOwners.set(PIPELINE_NEW_LOOKUP_ROUTINES[0], 'swat_migrator');
        routineOwners.set(PIPELINE_NEW_LOOKUP_ROUTINES[1], 'swat_migrator');
        return;
      }
      createdRoles.add('swat_worker_receipt_writer');
      roleSettings.set('swat_worker_receipt_writer', ['row_security=on', 'search_path=pg_catalog']);
      routineOwners.set(
        PIPELINE_NEW_LOOKUP_ROUTINES[0],
        phase === 'backend-owner-committed' || phase === 'both-lookup-owners-committed' ? 'swat_runtime_lookup' : 'swat_migrator'
      );
      routineOwners.set(
        PIPELINE_NEW_LOOKUP_ROUTINES[1],
        phase === 'both-lookup-owners-committed' ? 'swat_runtime_lookup' : 'swat_migrator'
      );
    }
  };
}

function createFinancialHarness(dbaRole = 'ext_dba') {
  const calls: string[] = [];
  const releases: boolean[] = [];
  const financialRoleNames = Object.values(WAVE4_FINANCIAL_ROLES).map(r => r.role);
  const createdRoles = new Set<string>(['swat_migrator', 'swat_app', 'swat_financial_settler']);
  const roleSettings = new Map<string, string[]>();
  const settlerFuncs = [
    'public.swat_apply_perps_reducing_receipt(uuid,text)',
    'public.w3_apply_financial_receipt()',
    'public.w3_perps_accounting_requires_application()',
    'public.swat_cancel_expired_financial_intent(uuid)',
    'public.w3_guard_perps_position_mutation()'
  ].sort();

  let backendPid = 301;
  let inTx = false;
  let driftPid = false;
  let commitMode: 'ok' | 'throw' | 'bad-cmd' = 'ok';
  let identityOverride: Record<string, unknown> = {};
  let privOverride: Record<string, boolean> = {};
  let roleMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let relMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let procMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let nsMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let policyMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let triggerMutator: ((rows: Record<string, unknown>[]) => void) | null = null;

  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    assertPgRoleLiteralPrivilegeGuard(sql, createdRoles);
    if (sql === 'BEGIN' || sql === 'BEGIN READ ONLY') {
      inTx = true;
      return { rows: [], command: 'BEGIN' };
    }
    if (sql === 'COMMIT') {
      if (commitMode === 'throw') throw new Error('lost commit response');
      if (commitMode === 'bad-cmd') return { rows: [], command: 'ROLLBACK' };
      inTx = false;
      return { rows: [], command: 'COMMIT' };
    }
    if (sql === 'ROLLBACK') {
      inTx = false;
      return { rows: [], command: 'ROLLBACK' };
    }
    if (sql.includes("SELECT set_config('statement_timeout'") || sql.includes("SELECT set_config('search_path'")) {
      return { rows: [{ set_config: 'pg_catalog' }] };
    }
    if (sql.startsWith('LOCK TABLE ')) return { rows: [] };
    if (sql.includes('DO $$ DECLARE r text;') && sql.includes('swat_wave4_authority_writer')) {
      for (const r of financialRoleNames) createdRoles.add(r);
      return { rows: [] };
    }
    const alterRoleMatch = /^ALTER ROLE (swat_[a-z0-9_]+) SET (row_security=on|search_path=pg_catalog)$/.exec(sql);
    if (alterRoleMatch) {
      const cur = roleSettings.get(alterRoleMatch[1]!) ?? [];
      if (!cur.includes(alterRoleMatch[2]!)) cur.push(alterRoleMatch[2]!);
      roleSettings.set(alterRoleMatch[1]!, cur);
      return { rows: [] };
    }
    if (sql.includes('pg_catalog.pg_stat_activity') && sql.includes('current_user AS current_role')) {
      if (driftPid && inTx && calls.filter(c => c.includes('current_user AS current_role')).length >= 2) {
        backendPid += 1;
      }
      return {
        rows: [{
          current_role: dbaRole,
          session_role: dbaRole,
          role_setting: 'none',
          row_security: 'on',
          backend: backendPid,
          superuser: true,
          can_login: true,
          bypass_rls: false,
          inherit: false,
          create_role: false,
          create_db: false,
          replication: false,
          has_memberships: false,
          transaction_clean: true,
          ...identityOverride
        }]
      };
    }
    if (sql.includes('FROM pg_catalog.pg_roles r WHERE r.rolname = ANY')) {
      const rows: Record<string, unknown>[] = [...createdRoles].map(rolname => ({
        rolname,
        rolcanlogin: rolname === 'swat_migrator' || rolname === 'swat_app',
        unsafe: false,
        membership: false,
        owns: rolname === 'swat_migrator',
        can_create: rolname === 'swat_migrator',
        functions: rolname === 'swat_financial_settler' ? settlerFuncs : [],
        extra_ownership: false
      }));
      roleMutator?.(rows);
      return { rows };
    }
    if (sql.includes('FROM pg_catalog.pg_db_role_setting s')) {
      return {
        rows: [...roleSettings.entries()].map(([rolname, setconfig]) => ({
          rolname,
          setdatabase: 0,
          setconfig
        }))
      };
    }
    if (sql.includes('FROM pg_catalog.pg_namespace n')) {
      const rows: Record<string, unknown>[] = [{ nspname: 'public', owner: 'swat_migrator', restricted_or_public_create: false }];
      nsMutator?.(rows);
      return { rows };
    }
    if (sql.includes('FROM pg_catalog.pg_class c')) {
      const rows: Record<string, unknown>[] = [
        ...WAVE4_FINANCIAL_RELATIONS.map(r => ({
          relation: r.relation,
          owner: 'swat_migrator',
          relkind: 'r',
          relrowsecurity: true,
          relforcerowsecurity: true,
          reloptions: null,
          public_or_grantable_acl: false
        })),
        {
          relation: WAVE4_FINANCIAL_AUDIT_VIEW.relation,
          owner: 'swat_migrator',
          relkind: 'v',
          relrowsecurity: false,
          relforcerowsecurity: false,
          reloptions: ['security_invoker=true', 'security_barrier=true'],
          public_or_grantable_acl: false
        }
      ];
      relMutator?.(rows);
      return { rows };
    }
    if (sql.includes('observer_audit_select')) {
      const observerCanSeeAudit =
        createdRoles.has('swat_custody_observer') || sql.includes("has_table_privilege('PUBLIC'")
          ? (privOverride.observer_audit_select ?? false)
          : false;
      return {
        rows: [{
          app_grants_secret_select: false,
          app_admissions_secret_select: false,
          ...privOverride,
          observer_audit_select: observerCanSeeAudit
        }]
      };
    }
    if (sql.includes('FROM pg_catalog.pg_proc p')) {
      const rows: Record<string, unknown>[] = WAVE4_FINANCIAL_ROUTINES.map(r => ({
        signature: r.signature,
        owner: 'swat_migrator',
        prokind: 'f',
        prosecdef: false,
        proisstrict: false,
        proleakproof: false,
        provolatile: 'v',
        proparallel: 'u',
        pronargdefaults: 0,
        proconfig: ['search_path=pg_catalog'],
        lanname: r.language,
        acl: r.execute
          .filter(grantee => !financialRoleNames.includes(grantee as typeof financialRoleNames[number]) || createdRoles.has(grantee))
          .map(grantee => ({ grantor: 'swat_migrator', grantee, privilege: 'EXECUTE', grantable: false }))
      }));
      procMutator?.(rows);
      return { rows };
    }
    if (sql.includes('FROM pg_catalog.pg_policy p')) {
      const rows: Record<string, unknown>[] = [
        ...WAVE4_FINANCIAL_RELATIONS.map(r => ({
          relation: r.relation,
          polname: 'wave4_tenant089',
          polpermissive: false,
          roles: ['PUBLIC'],
          using_expr: 'user_id=public.current_app_user_id()',
          check_expr: 'user_id=public.current_app_user_id()'
        })),
        {
          relation: 'public.user_execution_grants',
          polname: 'wave4_execution_scope089',
          polpermissive: false,
          roles: ['swat_custody_reader', 'swat_custody_observer'],
          using_expr: 'public.wave4_custody_scope089(user_id,id)',
          check_expr: 'false'
        },
        {
          relation: 'public.custody_secret_admissions',
          polname: 'wave4_execution_scope089',
          polpermissive: false,
          roles: ['swat_custody_reader', 'swat_custody_observer'],
          using_expr: 'public.wave4_custody_scope089(user_id,grant_id)',
          check_expr: 'false'
        }
      ];
      policyMutator?.(rows);
      return { rows };
    }
    if (sql.includes('FROM pg_catalog.pg_constraint con')) {
      return {
        rows: WAVE4_FINANCIAL_FOREIGN_KEYS.map(f => ({
          relation: f.from,
          columns: [...f.columns],
          target: f.to,
          target_columns: [...f.targetColumns],
          delete_action: 'r',
          update_action: 'a',
          match_type: 's',
          deferrable: false,
          initially_deferred: false,
          validated: true
        }))
      };
    }
    if (sql.includes('FROM pg_catalog.pg_trigger t')) {
      const rows: Record<string, unknown>[] = WAVE4_FINANCIAL_TRIGGERS.map(t => ({
        relation: t.relation,
        name: t.name,
        tgenabled: 'O',
        is_constraint: t.constraint,
        tgdeferrable: t.deferrable,
        tginitdeferred: t.initiallyDeferred
      }));
      triggerMutator?.(rows);
      return { rows };
    }
    throw new Error(`Unexpected financial query: ${sql}`);
  });

  const client = { query } as unknown as FinancialProvisioningQueryClient;
  const acquire = async (): Promise<FinancialProvisioningClientLease> => ({
    client,
    release: (broken: boolean) => { releases.push(broken); }
  });
  return {
    kind: 'financial' as const,
    client,
    acquire,
    calls,
    releases,
    setIdentityOverride: (p: Record<string, unknown>) => { identityOverride = p; },
    setPrivOverride: (p: Partial<Record<string, boolean>>) => { privOverride = p as Record<string, boolean>; },
    setRoleMutator: (fn: (rows: Record<string, unknown>[]) => void) => { roleMutator = fn; },
    setRelMutator: (fn: (rows: Record<string, unknown>[]) => void) => { relMutator = fn; },
    setProcMutator: (fn: (rows: Record<string, unknown>[]) => void) => { procMutator = fn; },
    setNsMutator: (fn: (rows: Record<string, unknown>[]) => void) => { nsMutator = fn; },
    setPolicyMutator: (fn: (rows: Record<string, unknown>[]) => void) => { policyMutator = fn; },
    setTriggerMutator: (fn: (rows: Record<string, unknown>[]) => void) => { triggerMutator = fn; },
    setCommitMode: (mode: 'ok' | 'throw' | 'bad-cmd') => { commitMode = mode; },
    enablePidDrift: () => { driftPid = true; },
    markRolesCreated: () => {
      for (const r of financialRoleNames) {
        createdRoles.add(r);
        roleSettings.set(r, ['row_security=on', 'search_path=pg_catalog']);
      }
    }
  };
}

function createLoadHarness(dbaRole = 'ext_dba') {
  const calls: string[] = [];
  const releases: boolean[] = [];
  const createdRoles = new Set<string>();
  const roleSettings = new Map<string, string[]>();
  const routineOwners = new Map<string, string>(
    WAVE4_LOAD_ROUTINES.map(r => [r.signature, 'swat_migrator'])
  );
  const routineAcls = new Map<string, { grantor: string; grantee: string; privilege: string; grantable: boolean }[]>(
    WAVE4_LOAD_ROUTINES.map(r => [r.signature, [{ grantor: 'swat_migrator', grantee: 'swat_migrator', privilege: 'EXECUTE', grantable: false }]])
  );
  let wave4LoadCreate = false;
  let backendPid = 401;
  let inTx = false;
  let driftPid = false;
  let commitMode: 'ok' | 'throw' | 'bad-cmd' = 'ok';
  let identityOverride: Record<string, unknown> = {};
  let lockOnlyOverride: Record<string, boolean> = {};
  let roleMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let relMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let procMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let nsMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let policyRows: Record<string, unknown>[] = [];
  let fkMutator: ((rows: Record<string, unknown>[]) => void) | null = null;

  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    assertPgRoleLiteralPrivilegeGuard(sql, createdRoles);
    if (sql === 'BEGIN' || sql === 'BEGIN READ ONLY') {
      inTx = true;
      return { rows: [], command: 'BEGIN' };
    }
    if (sql === 'COMMIT') {
      if (commitMode === 'throw') throw new Error('lost commit response');
      if (commitMode === 'bad-cmd') return { rows: [], command: 'ROLLBACK' };
      inTx = false;
      return { rows: [], command: 'COMMIT' };
    }
    if (sql === 'ROLLBACK') {
      inTx = false;
      return { rows: [], command: 'ROLLBACK' };
    }
    if (sql.includes("SELECT set_config('statement_timeout'") || sql.includes("SELECT set_config('search_path'")) {
      return { rows: [{ set_config: 'pg_catalog' }] };
    }
    if (sql.startsWith('LOCK TABLE ')) return { rows: [] };
    if (sql.includes('DO $$ DECLARE r text;') && sql.includes('swat_load_capture_owner')) {
      for (const r of WAVE4_LOAD_DISABLED_ROLES) createdRoles.add(r);
      return { rows: [] };
    }
    const alterRoleMatch = /^ALTER ROLE (swat_load_[a-z0-9_]+) SET (row_security=on|search_path=pg_catalog)$/.exec(sql);
    if (alterRoleMatch) {
      const cur = roleSettings.get(alterRoleMatch[1]!) ?? [];
      if (!cur.includes(alterRoleMatch[2]!)) cur.push(alterRoleMatch[2]!);
      roleSettings.set(alterRoleMatch[1]!, cur);
      return { rows: [] };
    }
    if (sql === 'REVOKE ALL ON SCHEMA wave4_load FROM PUBLIC') return { rows: [] };
    if (sql.startsWith('GRANT USAGE ON SCHEMA wave4_load TO ')) return { rows: [] };
    if (sql === 'GRANT CREATE ON SCHEMA wave4_load TO swat_load_capture_owner') {
      wave4LoadCreate = true;
      return { rows: [] };
    }
    if (sql === 'REVOKE CREATE ON SCHEMA wave4_load FROM swat_load_capture_owner') {
      wave4LoadCreate = false;
      return { rows: [] };
    }
    const alterFn = /^ALTER FUNCTION (wave4_load\.[^(]+\([^)]*\)) OWNER TO swat_load_capture_owner$/.exec(sql);
    if (alterFn) {
      if (!wave4LoadCreate) throw new Error('missing temp CREATE on wave4_load');
      const sig = alterFn[1]!;
      routineOwners.set(sig, 'swat_load_capture_owner');
      routineAcls.set(sig, [{ grantor: 'swat_load_capture_owner', grantee: 'swat_load_capture_owner', privilege: 'EXECUTE', grantable: false }]);
      return { rows: [] };
    }
    const revokeFn = /^REVOKE ALL ON FUNCTION (wave4_load\.[^(]+\([^)]*\)) FROM PUBLIC$/.exec(sql);
    if (revokeFn) {
      const sig = revokeFn[1]!;
      const owner = routineOwners.get(sig) ?? 'swat_migrator';
      routineAcls.set(sig, [{ grantor: owner, grantee: owner, privilege: 'EXECUTE', grantable: false }]);
      return { rows: [] };
    }
    const grantExecFn = /^GRANT EXECUTE ON FUNCTION (wave4_load\.[^(]+\([^)]*\)) TO (.+)$/.exec(sql);
    if (grantExecFn) {
      const sig = grantExecFn[1]!;
      const callers = grantExecFn[2]!.split(',').map(s => s.trim());
      const owner = routineOwners.get(sig) ?? 'swat_migrator';
      routineAcls.set(sig, [
        { grantor: owner, grantee: owner, privilege: 'EXECUTE', grantable: false },
        ...callers.map(grantee => ({ grantor: owner, grantee, privilege: 'EXECUTE', grantable: false }))
      ]);
      return { rows: [] };
    }
    if (sql.includes('pg_catalog.pg_stat_activity') && sql.includes('current_user AS current_role')) {
      if (driftPid && inTx && calls.filter(c => c.includes('current_user AS current_role')).length >= 2) {
        backendPid += 1;
      }
      return {
        rows: [{
          current_role: dbaRole,
          session_role: dbaRole,
          role_setting: 'none',
          row_security: 'on',
          backend: backendPid,
          superuser: true,
          can_login: true,
          bypass_rls: false,
          inherit: false,
          create_role: false,
          create_db: false,
          replication: false,
          has_memberships: false,
          transaction_clean: true,
          ...identityOverride
        }]
      };
    }
    if (sql.includes('FROM pg_catalog.pg_roles r WHERE r.rolname = ANY')) {
      const ownedByCaptureOwner = WAVE4_LOAD_OWNER_TRANSFERS.filter(
        sig => routineOwners.get(sig) === 'swat_load_capture_owner'
      ).sort();
      const rows: Record<string, unknown>[] = [...createdRoles].map(rolname => ({
        rolname,
        rolcanlogin: false,
        unsafe: false,
        membership: false,
        owns: false,
        can_create: rolname === 'swat_load_capture_owner' ? wave4LoadCreate : false,
        functions: rolname === 'swat_load_capture_owner' ? ownedByCaptureOwner : [],
        extra_ownership: false
      }));
      roleMutator?.(rows);
      return { rows };
    }
    if (sql.includes('FROM pg_catalog.pg_db_role_setting s')) {
      return {
        rows: [...roleSettings.entries()].map(([rolname, setconfig]) => ({
          rolname,
          setdatabase: 0,
          setconfig
        }))
      };
    }
    if (sql.includes('FROM pg_catalog.pg_namespace n')) {
      const rows: Record<string, unknown>[] = [{ nspname: 'wave4_load', owner: 'swat_migrator', restricted_or_public_create: wave4LoadCreate }];
      nsMutator?.(rows);
      return { rows };
    }
    if (sql.includes('FROM pg_catalog.pg_class c')) {
      const rows: Record<string, unknown>[] = WAVE4_LOAD_CAPTURE_RELATIONS.map(r => ({
        relation: r.name,
        owner: 'swat_migrator',
        relkind: 'r',
        relrowsecurity: true,
        relforcerowsecurity: true,
        public_or_grantable_acl: false
      }));
      relMutator?.(rows);
      return { rows };
    }
    if (sql.includes('owner_users_update')) {
      return {
        rows: [{
          owner_users_update: false,
          owner_sessions_update: false,
          owner_col_update: false,
          ...lockOnlyOverride
        }]
      };
    }
    if (sql.includes('FROM pg_catalog.pg_proc p')) {
      const rows: Record<string, unknown>[] = WAVE4_LOAD_ROUTINES.map(r => ({
        signature: r.signature,
        owner: routineOwners.get(r.signature) ?? 'swat_migrator',
        prokind: 'f',
        prosecdef: r.definer,
        proisstrict: false,
        proleakproof: false,
        provolatile: 'v',
        proparallel: 'u',
        pronargdefaults: 0,
        proconfig: ['search_path=pg_catalog'],
        lanname: r.language,
        acl: routineAcls.get(r.signature) ?? []
      }));
      procMutator?.(rows);
      return { rows };
    }
    if (sql.includes('FROM pg_catalog.pg_policy p')) return { rows: policyRows };
    if (sql.includes('FROM pg_catalog.pg_constraint con')) {
      const rows: Record<string, unknown>[] = WAVE4_LOAD_FOREIGN_KEYS.map(f => ({
        relation: f.from,
        columns: [...f.columns],
        target: f.to,
        target_columns: [...f.referenced],
        delete_action: 'r',
        update_action: 'a',
        match_type: 's',
        deferrable: f.deferrable,
        initially_deferred: f.initiallyDeferred,
        validated: f.validated
      }));
      fkMutator?.(rows);
      return { rows };
    }
    throw new Error(`Unexpected load query: ${sql}`);
  });

  const dbConn = { query } as unknown as LoadProvisioningQueryClient;
  const acquire = async (): Promise<LoadProvisioningClientLease> => ({
    dbConn,
    release: (broken: boolean) => { releases.push(broken); }
  });
  return {
    kind: 'load' as const,
    dbConn,
    acquire,
    calls,
    releases,
    setIdentityOverride: (p: Record<string, unknown>) => { identityOverride = p; },
    setLockOnlyOverride: (p: Partial<Record<string, boolean>>) => { lockOnlyOverride = p as Record<string, boolean>; },
    setRoleMutator: (fn: (rows: Record<string, unknown>[]) => void) => { roleMutator = fn; },
    setRelMutator: (fn: (rows: Record<string, unknown>[]) => void) => { relMutator = fn; },
    setProcMutator: (fn: (rows: Record<string, unknown>[]) => void) => { procMutator = fn; },
    setNsMutator: (fn: (rows: Record<string, unknown>[]) => void) => { nsMutator = fn; },
    setPolicies: (rows: Record<string, unknown>[]) => { policyRows = rows; },
    setFkMutator: (fn: (rows: Record<string, unknown>[]) => void) => { fkMutator = fn; },
    setCommitMode: (mode: 'ok' | 'throw' | 'bad-cmd') => { commitMode = mode; },
    enablePidDrift: () => { driftPid = true; },
    prepareDisabledHandoff: () => {
      for (const r of WAVE4_LOAD_DISABLED_ROLES) {
        createdRoles.add(r);
        roleSettings.set(r, ['row_security=on', 'search_path=pg_catalog']);
      }
      for (const r of WAVE4_LOAD_ROUTINES) {
        const owner = r.ownerDisabled;
        routineOwners.set(r.signature, owner);
        routineAcls.set(r.signature, [owner, ...r.callers].map(grantee => ({
          grantor: owner,
          grantee,
          privilege: 'EXECUTE',
          grantable: false
        })));
      }
    }
  };
}

describe('Wave4 provisioning companions — happy paths & hostile rejection matrix (mocked SQL)', () => {
  it('pipeline companion provisions, revokes temporary schema CREATE before COMMIT, and validates read-only on fresh lease', async () => {
    const source = await loadPipelineSources();
    const binding = bindPipelineProvisioningSource(source);
    const h = createPipelineHarness(binding);
    await provisionWave4PipelineCompanion({ acquire: h.acquire, dbaRole: 'ext_dba', source });
    expect(h.calls.some(c => c.includes('LOCK TABLE'))).toBe(true);
    expect(h.calls.indexOf('REVOKE CREATE ON SCHEMA public FROM swat_runtime_lookup')).toBeLessThan(h.calls.indexOf('COMMIT'));
    expect(h.calls.filter(c => c === 'BEGIN READ ONLY')).toHaveLength(1);
    expect(h.releases).toEqual([false, false]);
  });

  it('financial companion creates 5 disabled roles with locked GUCs without grant/ownership widening and validates read-only', async () => {
    const h = createFinancialHarness();
    await provisionWave4FinancialCompanion({ acquire: h.acquire, dbaRole: 'ext_dba' });
    expect(h.calls.some(c => c.includes('LOCK TABLE public.wave4_authorities089'))).toBe(true);
    expect(h.calls.some(c => c.includes('OWNER TO'))).toBe(false);
    expect(h.calls.some(c => c.includes('GRANT '))).toBe(false);
    expect(h.calls.filter(c => c === 'BEGIN READ ONLY')).toHaveLength(1);
    expect(h.releases).toEqual([false, false]);
    await validateWave4FinancialInstallation({ acquire: h.acquire, dbaRole: 'ext_dba', phase: 'disabled-roles-and-catalog' });
    expect(h.releases).toEqual([false, false, false]);
  });

  it('load companion performs bounded schema/owner handoff, revokes CREATE before COMMIT, and validates read-only', async () => {
    const h = createLoadHarness();
    await provisionWave4LoadCompanion({ acquire: h.acquire, dbaRole: 'ext_dba' });
    expect(h.calls.some(c => c.includes('LOCK TABLE wave4_load.runs'))).toBe(true);
    expect(h.calls.filter(c => c.startsWith('ALTER FUNCTION '))).toHaveLength(WAVE4_LOAD_OWNER_TRANSFERS.length);
    expect(h.calls.filter(c => c.startsWith('REVOKE ALL ON FUNCTION '))).toHaveLength(WAVE4_LOAD_ROUTINES.length);
    expect(h.calls.indexOf('REVOKE CREATE ON SCHEMA wave4_load FROM swat_load_capture_owner')).toBeLessThan(h.calls.indexOf('COMMIT'));
    expect(h.calls.filter(c => c === 'BEGIN READ ONLY')).toHaveLength(1);
    expect(h.releases).toEqual([false, false]);
    await validateWave4LoadInstallation({ acquire: h.acquire, dbaRole: 'ext_dba', phase: 'disabled-handoff' });
    expect(h.releases).toEqual([false, false, false]);
  });

  it.each(['pipeline', 'financial', 'load'] as const)(
    '[%s] rejects SET ROLE aliases, swat_* DBA names, wrong current_user, dirty lease, and PID drift',
    async (kind: CompanionKind) => {
      const source = kind === 'pipeline' ? await loadPipelineSources() : null;
      const binding = source ? bindPipelineProvisioningSource(source) : null;

      for (const badRole of ['swat_app', 'swat_migrator', 'ext; SET ROLE swat_migrator', 'bad role']) {
        if (kind === 'pipeline') {
          const h = createPipelineHarness(binding!);
          await expect(assertWave4PipelineRoleWithClient(h.client, badRole, 'dba')).rejects.toThrow();
          expect(h.calls).toHaveLength(0);
        } else if (kind === 'financial') {
          const h = createFinancialHarness();
          await expect(assertWave4FinancialRoleWithClient(h.client, badRole, 'dba')).rejects.toThrow();
          expect(h.calls).toHaveLength(0);
        } else {
          const h = createLoadHarness();
          await expect(assertWave4LoadRoleWithClient(h.dbConn, badRole, 'dba')).rejects.toThrow();
          expect(h.calls).toHaveLength(0);
        }
      }

      for (const patch of [
        { role_setting: 'swat_migrator' },
        { session_role: 'swat_migrator' },
        { current_role: 'swat_app' },
        { row_security: 'off' },
        { transaction_clean: false }
      ]) {
        if (kind === 'pipeline') {
          const h = createPipelineHarness(binding!);
          h.setIdentityOverride(patch);
          await expect(provisionWave4PipelineCompanion({ acquire: h.acquire, dbaRole: 'ext_dba', source: source! })).rejects.toThrow();
          expect(h.calls).not.toContain('BEGIN');
          expect(h.releases).toEqual([true]);
        } else if (kind === 'financial') {
          const h = createFinancialHarness();
          h.setIdentityOverride(patch);
          await expect(provisionWave4FinancialCompanion({ acquire: h.acquire, dbaRole: 'ext_dba' })).rejects.toThrow();
          expect(h.calls).not.toContain('BEGIN');
          expect(h.releases).toEqual([true]);
        } else {
          const h = createLoadHarness();
          h.setIdentityOverride(patch);
          await expect(provisionWave4LoadCompanion({ acquire: h.acquire, dbaRole: 'ext_dba' })).rejects.toThrow();
          expect(h.calls).not.toContain('BEGIN');
          expect(h.releases).toEqual([true]);
        }
      }

      // PID drift before COMMIT
      if (kind === 'pipeline') {
        const h = createPipelineHarness(binding!);
        h.enablePidDrift();
        await expect(provisionWave4PipelineCompanion({ acquire: h.acquire, dbaRole: 'ext_dba', source: source! })).rejects.toThrow(/PID drift/i);
        expect(h.calls).toContain('ROLLBACK');
        expect(h.releases).toEqual([true]);
      } else if (kind === 'financial') {
        const h = createFinancialHarness();
        h.enablePidDrift();
        await expect(provisionWave4FinancialCompanion({ acquire: h.acquire, dbaRole: 'ext_dba' })).rejects.toThrow(/PID drift/i);
        expect(h.calls).toContain('ROLLBACK');
        expect(h.releases).toEqual([true]);
      } else {
        const h = createLoadHarness();
        h.enablePidDrift();
        await expect(provisionWave4LoadCompanion({ acquire: h.acquire, dbaRole: 'ext_dba' })).rejects.toThrow(/PID drift/i);
        expect(h.calls).toContain('ROLLBACK');
        expect(h.releases).toEqual([true]);
      }
    }
  );

  it.each(['pipeline', 'financial', 'load'] as const)(
    '[%s] rejects privilege escalation on restricted roles, membership/CREATE/ACL widening, and RLS/policy weakening',
    async (kind: CompanionKind) => {
      const source = kind === 'pipeline' ? await loadPipelineSources() : null;
      const binding = source ? bindPipelineProvisioningSource(source) : null;

      // Restricted role privilege escalation via assertWave4*RoleWithClient
      for (const esc of [{ superuser: true }, { bypass_rls: true }, { inherit: true }, { create_role: true }, { create_db: true }, { replication: true }, { has_memberships: true }]) {
        if (kind === 'pipeline') {
          const h = createPipelineHarness(binding!, 'swat_app');
          h.setIdentityOverride({ superuser: false, ...esc });
          await expect(assertWave4PipelineRoleWithClient(h.client, 'swat_app', 'restricted')).rejects.toThrow();
        } else if (kind === 'financial') {
          const h = createFinancialHarness('swat_app');
          h.setIdentityOverride({ superuser: false, ...esc });
          await expect(assertWave4FinancialRoleWithClient(h.client, 'swat_app', 'restricted')).rejects.toThrow();
        } else {
          const h = createLoadHarness('swat_app');
          h.setIdentityOverride({ superuser: false, ...esc });
          await expect(assertWave4LoadRoleWithClient(h.dbConn, 'swat_app', 'restricted')).rejects.toThrow();
        }
      }

      // Membership, can_create, is_grantable, PUBLIC EXECUTE, RLS disabled, permissive policy
      const runHostile = async (scenario: 'membership' | 'can_create' | 'grantable' | 'public_exec' | 'rls_off' | 'permissive_policy') => {
        if (kind === 'pipeline') {
          const h = createPipelineHarness(binding!);
          if (scenario === 'membership') h.setRoleMutator(rows => { rows[0]!.membership = true; });
          if (scenario === 'can_create') h.setNsMutator(rows => { rows[0]!.restricted_or_public_create = true; });
          if (scenario === 'grantable') h.setProcMutator(rows => { (rows[0]!.acl as Record<string, unknown>[])[0]!.grantable = true; });
          if (scenario === 'public_exec') h.setProcMutator(rows => { (rows[0]!.acl as Record<string, unknown>[]).push({ grantor: 'swat_migrator', grantee: 'PUBLIC', privilege: 'EXECUTE', grantable: false }); });
          if (scenario === 'rls_off') h.setRelMutator(rows => { rows[0]!.relforcerowsecurity = false; });
          if (scenario === 'permissive_policy') h.setPolicies([{ relation: 'public.pipeline_backend_approvals', polname: 'open', polpermissive: true, roles: ['PUBLIC'], using_expr: 'true', check_expr: null }]);
          await expect(provisionWave4PipelineCompanion({ acquire: h.acquire, dbaRole: 'ext_dba', source: source! })).rejects.toThrow();
          expect(h.calls).toContain('ROLLBACK');
          expect(h.releases).toEqual([true]);
        } else if (kind === 'financial') {
          const h = createFinancialHarness();
          if (scenario === 'membership') h.setRoleMutator(rows => { rows[0]!.membership = true; });
          if (scenario === 'can_create') h.setNsMutator(rows => { rows[0]!.restricted_or_public_create = true; });
          if (scenario === 'grantable') h.setProcMutator(rows => { (rows[0]!.acl as Record<string, unknown>[])[0]!.grantable = true; });
          if (scenario === 'public_exec') h.setProcMutator(rows => { (rows[0]!.acl as Record<string, unknown>[]).push({ grantor: 'swat_migrator', grantee: 'PUBLIC', privilege: 'EXECUTE', grantable: false }); });
          if (scenario === 'rls_off') h.setRelMutator(rows => { rows[0]!.relrowsecurity = false; });
          if (scenario === 'permissive_policy') h.setPolicyMutator(rows => { rows.push({ relation: 'public.wave4_authorities089', polname: 'open', polpermissive: true, roles: ['PUBLIC'], using_expr: 'true', check_expr: null }); });
          await expect(provisionWave4FinancialCompanion({ acquire: h.acquire, dbaRole: 'ext_dba' })).rejects.toThrow();
          expect(h.calls).toContain('ROLLBACK');
          expect(h.releases).toEqual([true]);
        } else {
          const h = createLoadHarness();
          if (scenario === 'membership') h.setRoleMutator(rows => { rows[0]!.membership = true; });
          if (scenario === 'can_create') h.setNsMutator(rows => { rows[0]!.restricted_or_public_create = true; });
          if (scenario === 'grantable') h.setProcMutator(rows => { (rows[0]!.acl as Record<string, unknown>[])[0]!.grantable = true; });
          if (scenario === 'public_exec') h.setProcMutator(rows => { (rows[0]!.acl as Record<string, unknown>[]).push({ grantor: 'swat_migrator', grantee: 'PUBLIC', privilege: 'EXECUTE', grantable: false }); });
          if (scenario === 'rls_off') h.setRelMutator(rows => { rows[0]!.relforcerowsecurity = false; });
          if (scenario === 'permissive_policy') h.setPolicies([{ relation: 'wave4_load.runs', polname: 'open', polpermissive: true, roles: ['PUBLIC'], using_expr: 'true', check_expr: null }]);
          await expect(provisionWave4LoadCompanion({ acquire: h.acquire, dbaRole: 'ext_dba' })).rejects.toThrow();
          expect(h.calls).toContain('ROLLBACK');
          expect(h.releases).toEqual([true]);
        }
      };

      for (const scenario of ['membership', 'can_create', 'grantable', 'public_exec', 'rls_off', 'permissive_policy'] as const) {
        await runHostile(scenario);
      }
    }
  );

  it('rejects domain-specific widening on 089 (sealed_secret, audit_log, non-deferred atomic trigger) and 090 (users/sessions UPDATE, non-deferred FK)', async () => {
    for (const priv of [
      { observer_audit_select: true },
      { app_grants_secret_select: true },
      { app_admissions_secret_select: true }
    ]) {
      const h = createFinancialHarness();
      h.setPrivOverride(priv);
      await expect(provisionWave4FinancialCompanion({ acquire: h.acquire, dbaRole: 'ext_dba' })).rejects.toThrow(/privilege widening/i);
      expect(h.calls).toContain('ROLLBACK');
    }

    const badTrigger = createFinancialHarness();
    badTrigger.setTriggerMutator(rows => {
      const atomic = rows.find(r => r.name === 'wave4_spot_atomic089')!;
      atomic.tginitdeferred = false;
    });
    await expect(provisionWave4FinancialCompanion({ acquire: badTrigger.acquire, dbaRole: 'ext_dba' })).rejects.toThrow(/trigger catalog drift/i);

    for (const lockPriv of [
      { owner_users_update: true },
      { owner_sessions_update: true },
      { owner_col_update: true }
    ]) {
      const h = createLoadHarness();
      h.setLockOnlyOverride(lockPriv);
      await expect(provisionWave4LoadCompanion({ acquire: h.acquire, dbaRole: 'ext_dba' })).rejects.toThrow(/forbidden UPDATE/i);
      expect(h.calls).toContain('ROLLBACK');
    }

    const badLoadFk = createLoadHarness();
    badLoadFk.setFkMutator(rows => {
      const deliveryFk = rows.find(r => r.target === 'public.source_fanout_deliveries')!;
      deliveryFk.initially_deferred = false;
    });
    await expect(provisionWave4LoadCompanion({ acquire: badLoadFk.acquire, dbaRole: 'ext_dba' })).rejects.toThrow(/FK catalog shape drift/i);
  });

  it.each(['pipeline', 'financial', 'load'] as const)(
    '[%s] fences ambiguous COMMIT without ROLLBACK and discards broken lease',
    async (kind: CompanionKind) => {
      const source = kind === 'pipeline' ? await loadPipelineSources() : null;
      const binding = source ? bindPipelineProvisioningSource(source) : null;

      for (const mode of ['throw', 'bad-cmd'] as const) {
        if (kind === 'pipeline') {
          const h = createPipelineHarness(binding!);
          h.setCommitMode(mode);
          await expect(provisionWave4PipelineCompanion({ acquire: h.acquire, dbaRole: 'ext_dba', source: source! })).rejects.toThrow(PipelineCommitUncertainError);
          expect(h.calls).not.toContain('ROLLBACK');
          expect(h.releases).toEqual([true]);
        } else if (kind === 'financial') {
          const h = createFinancialHarness();
          h.setCommitMode(mode);
          await expect(provisionWave4FinancialCompanion({ acquire: h.acquire, dbaRole: 'ext_dba' })).rejects.toThrow(Wave4FinancialCommitUncertainError);
          expect(h.calls).not.toContain('ROLLBACK');
          expect(h.releases).toEqual([true]);
        } else {
          const h = createLoadHarness();
          h.setCommitMode(mode);
          await expect(provisionWave4LoadCompanion({ acquire: h.acquire, dbaRole: 'ext_dba' })).rejects.toThrow(Wave4LoadCommitUncertainError);
          expect(h.calls).not.toContain('ROLLBACK');
          expect(h.releases).toEqual([true]);
        }
      }
    }
  );

  it('preserves static STATUS flags and existing source/frozen refusals unchanged', async () => {
    expect(PIPELINE_PROVISIONING_STATUS).toMatchObject({
      sourceComplete: false, runtimeAccepted: false, liveCapabilityAccepted: false,
      productionReady: false, reviewed: false, selected: false, applied: false
    });
    expect(WAVE4_FINANCIAL_PROVISIONING_STATUS).toMatchObject({
      sourceComplete: false, reviewed: false, selected: false, applied: false,
      installed: false, runtimeAccepted: false, liveCapabilityAccepted: false,
      productionReady: false, sourceSha256: null
    });
    expect(WAVE4_LOAD_PROVISIONING_STATUS).toMatchObject({
      frozen: true, reviewed: false, installable: false, installed: false,
      sourceComplete: false, runtimeAccepted: false, liveCapabilityAccepted: false,
      productionReady: false
    });
    expect(WAVE4_LOAD_FUNCTION_SIGNATURES).toHaveLength(15);
    expect(() => requireWave4FinancialSourceComplete()).toThrow('SOURCE-refused');
    const dummyQuery = vi.fn();
    await expect(provisionWave4LoadCaptureWithClient({ query: dummyQuery } as unknown as PoolClient)).rejects.toThrow(/FROZEN provisioning refused/);
    expect(dummyQuery).not.toHaveBeenCalled();
  });
});
