import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  bindPipelineProvisioningSource, createPipelineProvisioningProposal,
  validatePipelineSourceBinding, validatePipelineLocalForeignKeys,
  validatePipelineInertRoutineFacts, validatePipelineInertRelationFacts, validatePipelineDisabledRoleFacts,
  assertWave4PipelineRoleWithClient, validateWave4PipelineCommittedCatalog,
  validateWave4PipelineInstallation, provisionWave4PipelineCompanion, expectedPipelineRoutineExecuteGrantees, PipelineCommitUncertainError,
  PIPELINE_PROVISIONING_STATUS, PIPELINE_SOURCE_BLOCKERS, PIPELINE_PURPOSE_ROLES,
  PIPELINE_WORKER_ROUTINES, PIPELINE_NEW_LOOKUP_ROUTINES, PIPELINE_ROUTINE_INVENTORY,
  PIPELINE_RELATION_INVENTORY, PIPELINE_LOCAL_FK_INVENTORY, PIPELINE_ROLE_INVENTORY,
  PIPELINE_EXISTING_BROKER_BOUNDARY, PIPELINE_RECEIPT_PERMISSION_PREREQUISITES,
  type PipelineCatalogPhase,
  type PipelineSourceBytes, type PipelineSourceBinding, type PipelineRoutineFact,
  type PipelineDisabledRoleFact, type PipelineLocalForeignKey, type PipelineInertRelationFact,
  type PipelineQueryClient, type PipelineClientLease
} from '../../../deploy/postgres/wave4-pipeline-provisioning.js';

/** AUTHORED ONLY, UNRUN. No database/client/credential/network fixtures, SQL
 * execution, hashes, migration selection, provisioning or activation. These
 * source/fact consistency scenarios are NOT parser/PG/P3/runtime acceptance. */
async function sources(): Promise<PipelineSourceBytes> {
  return {
    sql088: await readFile(new URL('../../../packages/db/sql/088_wave4_protected_pipeline.sql', import.meta.url)),
    sql080: await readFile(new URL('../../../packages/db/sql/080_immutable_valuation_corrections.sql', import.meta.url))
  };
}
const text = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const bytes = (sql: string) => new TextEncoder().encode(sql);
const refs = { receiptWriter: 'external-audit:disabled-receipt-role:source-test-only',
  backendLookup: 'external-audit:backend-owner:source-test-only',
  followerLookup: 'external-audit:follower-owner:source-test-only' };
const body = (binding: PipelineSourceBinding, signature: string) => binding.routines.find(p => p.signature === signature)!.body;
const catalogType = (type: string) => type.startsWith('public.') ? type : `pg_catalog.${({ integer: 'int4', bigint: 'int8', boolean: 'bool' } as Record<string,string>)[type] ?? type}`;
function inertFacts(binding: PipelineSourceBinding): PipelineRoutineFact[] {
  // Synthetic consistency inputs only, never claimed observed catalog evidence.
  return PIPELINE_ROUTINE_INVENTORY.map(p => {
    const inputs = p.arguments.map(a => catalogType(a.type)), outputs = p.outputs.map(a => catalogType(a.type));
    const names = [...p.arguments, ...p.outputs].map(a => a.name);
    return { signature: p.signature, body: body(binding, p.signature), owner: 'swat_migrator', language: p.language,
      securityDefiner: p.securityDefiner, resultType: catalogType(p.result), argumentTypes: inputs,
      argumentNames: names.length ? names : null, allArgumentTypes: p.returnsSet ? [...inputs, ...outputs] : null,
      argumentModes: p.returnsSet ? [...inputs.map(() => 'i'), ...outputs.map(() => 't')] : null,
      returnsSet: p.returnsSet, searchPath: ['search_path=pg_catalog'], kind: 'f', volatility: 'v', parallel: 'u',
      strict: false, leakproof: false, support: 0, variadic: 0, defaultCount: 0, defaults: null,
      cost: 100, rows: p.returnsSet ? 1000 : 0, binary: null, sqlBody: null };
  });
}
function disabledFacts(): PipelineDisabledRoleFact[] {
  return PIPELINE_ROLE_INVENTORY.map(p => ({ role: p.role, canLogin: false, superuser: false, bypassRls: false,
    inherit: false, createRole: false, createDb: false, replication: false, membershipsIn: 0, membershipsOut: 0,
    relationOwnership: 0, schemaOwnership: 0, databaseOwnership: 0, otherOwnership: 0,
    schemaCreate: false, databaseCreate: false, ownedFunctions: [...p.ownership].sort() }));
}

describe('Wave4 pipeline provisioning inert source contract — authored, not executed', () => {
  it('captures supplied exact bytes without a fixed digest or authorization, deeply immutable', async () => {
    const source = await sources(), binding = bindPipelineProvisioningSource(source);
    expect(binding.sql088Bytes).toEqual(Array.from(source.sql088));
    expect(binding.sql080Bytes).toEqual(Array.from(source.sql080));
    expect(binding.routines).toHaveLength(23);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.sql088Bytes)).toBe(true);
    expect(Object.isFrozen(binding.routines[0])).toBe(true);
    expect(binding.status).toBe(PIPELINE_PROVISIONING_STATUS);
    expect(Object.values(binding.status).every(flag => flag === false)).toBe(true);
    expect(() => validatePipelineSourceBinding(binding, source)).not.toThrow();
    const changed = { ...source, sql088: bytes(text(source.sql088) + '\n-- different exact input\n') };
    expect(() => validatePipelineSourceBinding(binding, changed)).toThrow('bytes/binding drift');
    // A freshly supplied draft can form a NEW descriptive binding, not approval.
    expect(bindPipelineProvisioningSource(changed).status.reviewed).toBe(false);
    const originalFirst = binding.sql088Bytes[0]; source.sql088[0] = 0;
    expect(binding.sql088Bytes[0]).toBe(originalFirst);
  });

  it('refuses malformed/empty UTF-8 source bytes and forged binding metadata', async () => {
    const source = await sources(), binding = bindPipelineProvisioningSource(source);
    expect(() => bindPipelineProvisioningSource({ ...source, sql088: new Uint8Array() })).toThrow('source bytes');
    expect(() => bindPipelineProvisioningSource({ ...source, sql088: new Uint8Array([0xff]) })).toThrow();
    expect(() => validatePipelineSourceBinding({ ...binding, blockers: [] } as unknown as PipelineSourceBinding, source)).toThrow('binding drift');
    expect(() => validatePipelineSourceBinding({ ...binding, routines: binding.routines.slice(1) }, source)).toThrow('binding drift');
  });

  it('keeps exactly TEN independent-writer purposes and distinct disabled receipt writer', () => {
    expect(PIPELINE_PURPOSE_ROLES).toEqual({
      'source-register': 'swat_source_provider_writer', 'source-intake': 'swat_source_provider_writer',
      'source-verify': 'swat_source_provider_writer', fanout: 'swat_fanout',
      'worker-register': 'swat_capability_writer', 'risk-write': 'swat_risk_writer',
      'valuation-register': 'swat_valuation_writer', 'valuation-write': 'swat_valuation_writer',
      'paper-valuation': 'swat_valuation_writer', 'paper-receipt': 'swat_worker_receipt_writer'
    });
    expect(Object.keys(PIPELINE_PURPOSE_ROLES)).toHaveLength(10);
    expect(PIPELINE_RECEIPT_PERMISSION_PREREQUISITES.role).not.toBe('swat_app');
    expect(PIPELINE_RECEIPT_PERMISSION_PREREQUISITES.role).not.toBe('swat_financial_receipt_writer');
    expect(PIPELINE_RECEIPT_PERMISSION_PREREQUISITES).toMatchObject({
      canLogin: false, ownsObjects: false, unavailable: true, emitsGrants: false, scopedReadLockAndRlsClosureComplete: false
    });
    expect(PIPELINE_RECEIPT_PERMISSION_PREREQUISITES.insert.columns).toEqual([
      'receipt_id','execution_id','user_id','worker_fence','evidence_id','paper_valuation_evidence_id','terms'
    ]);
  });

  it('preserves seven exact scalar JSONB INVOKER worker signatures, including runtime receipt reader', async () => {
    const source = await sources(), binding = bindPipelineProvisioningSource(source);
    expect(PIPELINE_WORKER_ROUTINES).toEqual([
      'public.swat_pipeline_register_worker_capability(uuid,jsonb)',
      'public.swat_pipeline_write_risk_policy(uuid,jsonb)',
      'public.swat_pipeline_register_worker_valuation_authority(text,jsonb)',
      'public.swat_pipeline_record_trusted_worker_valuation(text,jsonb)',
      'public.swat_pipeline_paper_valuation(uuid)',
      'public.swat_pipeline_record_worker_paper_receipt(uuid,bigint,jsonb)',
      'public.swat_pipeline_worker_paper_receipt(uuid,bigint,text)'
    ]);
    for (const signature of PIPELINE_WORKER_ROUTINES) {
      expect(PIPELINE_ROUTINE_INVENTORY.find(p => p.signature === signature)).toMatchObject({
        result: 'jsonb', returnsSet: false, securityDefiner: false, language: 'plpgsql', volatility: 'v', inertOwner: 'swat_migrator'
      });
    }
    expect(body(binding, PIPELINE_WORKER_ROUTINES[6])).toContain('public.swat_claim_runtime_capability(requested_execution)');
    expect(PIPELINE_ROUTINE_INVENTORY.some(p => p.signature.startsWith('public.swat_claim_runtime_capability('))).toBe(false);
  });

  it('rejects worker argument/output/security/language/options and overload drift', async () => {
    const source = await sources(), sql = text(source.sql088);
    const changes = [
      sql.replace('swat_pipeline_register_worker_capability(requested_execution uuid,terms jsonb)', 'swat_pipeline_register_worker_capability(requested_execution uuid,terms text)'),
      sql.replace('swat_pipeline_paper_valuation(requested_execution uuid) RETURNS jsonb', 'swat_pipeline_paper_valuation(requested_execution uuid) RETURNS text'),
      sql.replace('swat_pipeline_paper_valuation(requested_execution uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER',
        'swat_pipeline_paper_valuation(requested_execution uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER'),
      sql.replace('capability_id uuid,revision text,purpose text,authority_id text,runtime_role text,database_oid oid',
        'capability_id uuid,revision text,purpose text,authority_id text,runtime_role text,database_oid text'),
      sql.replace('swat_pipeline_paper_valuation(requested_execution uuid)', 'swat_pipeline_paper_valuation(requested_execution uuid DEFAULT NULL)'),
      sql + '\nCREATE FUNCTION public.swat_pipeline_unreviewed() RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$;\n'
    ];
    for (const changed of changes) {
      expect(changed).not.toBe(sql);
      expect(() => bindPipelineProvisioningSource({ ...source, sql088: bytes(changed) })).toThrow();
    }
  });

  it('copies canonical080 predecessor bodies literally, pins BEFORE each forward replacement', async () => {
    const source = await sources(), sql = text(source.sql088), old = text(source.sql080);
    for (const [name, tag] of [['guard_worker_valuation_authority','old080authority'], ['guard_trusted_worker_valuation','old080trusted']] as const) {
      const original = [...old.matchAll(/^CREATE FUNCTION public\.(guard_worker_valuation_authority|guard_trusted_worker_valuation)\(\) RETURNS trigger\s+LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS \$\$([\s\S]*?)\$\$;/gm)].find(m => m[1] === name)!;
      const delimiter = `$${tag}$`, first = sql.indexOf(delimiter), last = sql.indexOf(delimiter, first + delimiter.length);
      expect(sql.slice(first + delimiter.length, last)).toBe(original[2]);
      expect(last).toBeLessThan(sql.indexOf('END $pin080$;'));
      expect(sql.indexOf('END $pin080$;')).toBeLessThan(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`));
    }
    const brokenLiteral = sql.replace("IF TG_OP<>'INSERT'", "IF TG_OP IS DISTINCT FROM 'INSERT'");
    expect(() => bindPipelineProvisioningSource({ ...source, sql088: bytes(brokenLiteral) })).toThrow('predecessor-body/order');
    const pin = sql.match(/DO \$pin080\$[\s\S]*?END \$pin080\$;/)![0];
    const reordered = sql.replace(pin, '') + '\n' + pin;
    expect(() => bindPipelineProvisioningSource({ ...source, sql088: bytes(reordered) })).toThrow('predecessor-body/order');
  });

  it('early enrollment declares record, not an uncreated follower composite rowtype', async () => {
    const source = await sources(), sql = text(source.sql088), binding = bindPipelineProvisioningSource(source);
    const enrollment = binding.routines.find(p => p.signature === 'public.swat_pipeline_external_enrollment()')!;
    expect(enrollment.body).toContain('DECLARE follower record;');
    expect(sql.indexOf(enrollment.declaration)).toBeLessThan(sql.indexOf('CREATE TABLE public.pipeline_follower_authorities ('));
    expect(() => bindPipelineProvisioningSource({ ...source, sql088: bytes(sql.replace('DECLARE follower record;', 'DECLARE follower public.pipeline_follower_authorities;')) })).toThrow('premature follower rowtype');
  });

  it('keeps two exact plpgsql TABLE lookup contracts, scope locks before post-wait clock', async () => {
    const binding = bindPipelineProvisioningSource(await sources());
    expect(PIPELINE_NEW_LOOKUP_ROUTINES).toEqual([
      'public.swat_pipeline_backend_capability(text,text)',
      'public.swat_pipeline_exact_follower_balance(uuid,text,text,text,text)'
    ]);
    for (const signature of PIPELINE_NEW_LOOKUP_ROUTINES) {
      expect(PIPELINE_ROUTINE_INVENTORY.find(p => p.signature === signature)).toMatchObject({
        result: 'record', returnsSet: true, securityDefiner: true, language: 'plpgsql', volatility: 'v'
      });
    }
    const follower = body(binding, PIPELINE_NEW_LOOKUP_ROUTINES[1]);
    expect(follower).toContain("jsonb_build_array('pipeline-follower',requested_user,requested_chain,requested_target,requested_token,requested_mode)");
    expect(follower.match(/FOR SHARE/g)).toHaveLength(2);
    expect(follower.lastIndexOf('FOR SHARE')).toBeLessThan(follower.indexOf('checked_at:=clock_timestamp()'));
    expect(follower.indexOf("public.swat_pipeline_backend_capability('fanout','')")).toBeLessThan(follower.indexOf('checked_at:=clock_timestamp()'));
    expect(follower).toContain('public.swat_pipeline_ordered_json');
    expect(follower).toContain('e.expires_at>checked_at');
    expect(body(binding, PIPELINE_NEW_LOOKUP_ROUTINES[0])).toContain('FOR SHARE');
  });

  it('qualifies the backend control-system column instead of the TABLE OUT system_identifier', async () => {
    const binding = bindPipelineProvisioningSource(await sources());
    const backend = body(binding, PIPELINE_NEW_LOOKUP_ROUTINES[0]);
    expect(PIPELINE_ROUTINE_INVENTORY.find(p => p.signature === PIPELINE_NEW_LOOKUP_ROUTINES[0])!.outputs)
      .toContainEqual({ name: 'system_identifier', type: 'text' });
    expect(backend).toContain('AND a.system_identifier=(SELECT control.system_identifier::text FROM pg_control_system() AS control)');
    expect(backend).not.toContain('SELECT system_identifier::text FROM pg_control_system()');
  });

  it('inventories exact physical terms JSONB columns and refuses renamed/nullable/source relation drift', async () => {
    const source = await sources(), sql = text(source.sql088);
    expect(PIPELINE_RELATION_INVENTORY).toHaveLength(6);
    for (const relation of ['public.pipeline_paper_valuation_evidence','public.pipeline_worker_paper_receipts']) {
      expect(PIPELINE_RELATION_INVENTORY.find(r => r.relation === relation)!.columns.find(c => c.name === 'terms')).toEqual({
        name: 'terms', type: 'jsonb', notNull: true, defaultExpression: null
      });
    }
    for (const changed of [sql.replaceAll('terms jsonb NOT NULL CHECK', 'payload jsonb NOT NULL CHECK'),
      sql.replaceAll('terms jsonb NOT NULL CHECK', 'terms jsonb CHECK'),
      sql.replace('public.pipeline_paper_valuation_evidence (', 'public.pipeline_fake_evidence (')]) {
      expect(() => bindPipelineProvisioningSource({ ...source, sql088: bytes(changed) })).toThrow('relation');
    }
  });

  it('validates only exact inert physical relation facts and refuses FORCE RLS/ownership/terms drift', () => {
    const facts: PipelineInertRelationFact[] = PIPELINE_RELATION_INVENTORY.map(r => ({
      relation: r.relation, owner: 'swat_migrator', kind: 'r', rowSecurity: true, forceRowSecurity: true,
      columns: r.columns, inheritanceParents: 0, inheritanceChildren: 0, partition: false
    }));
    expect(() => validatePipelineInertRelationFacts(facts)).not.toThrow();
    for (const patch of [{ forceRowSecurity: false }, { rowSecurity: false }, { owner: 'swat_app' },
      { inheritanceChildren: 1 }, { columns: facts[0]!.columns.slice(1) }]) {
      expect(() => validatePipelineInertRelationFacts([{ ...facts[0], ...patch }, ...facts.slice(1)] as unknown as PipelineInertRelationFact[])).toThrow('facts drift');
    }
  });

  it('bounds all twelve touching local FKs, rejects incoming extra/omitted/shape drift, does not invent originals', () => {
    expect(PIPELINE_LOCAL_FK_INVENTORY).toHaveLength(12);
    expect(() => validatePipelineLocalForeignKeys(PIPELINE_LOCAL_FK_INVENTORY)).not.toThrow();
    expect(() => validatePipelineLocalForeignKeys(PIPELINE_LOCAL_FK_INVENTORY.slice(1))).toThrow('inventory drift');
    const extra = { ...PIPELINE_LOCAL_FK_INVENTORY[0]!, relation: 'public.unreviewed_child', name: 'incoming088',
      columns: ['id'], target: 'public.pipeline_follower_authorities', targetColumns: ['authority_id'] };
    expect(() => validatePipelineLocalForeignKeys([...PIPELINE_LOCAL_FK_INVENTORY, extra])).toThrow('inventory drift');
    const unrelated = { ...extra, target: 'public.users', targetColumns: ['id'] };
    expect(() => validatePipelineLocalForeignKeys([...PIPELINE_LOCAL_FK_INVENTORY, unrelated])).not.toThrow();
    for (const patch of [{ deleteAction: 'c' }, { deferrable: true }, { validated: false }, { targetColumns: ['other'] }]) {
      const changed = [{ ...PIPELINE_LOCAL_FK_INVENTORY[0]!, ...patch }, ...PIPELINE_LOCAL_FK_INVENTORY.slice(1)] as unknown as PipelineLocalForeignKey[];
      expect(() => validatePipelineLocalForeignKeys(changed)).toThrow('shape drift');
    }
    expect(PIPELINE_LOCAL_FK_INVENTORY.some(f => f.columns.includes('original_evidence_id'))).toBe(false);
    expect(PIPELINE_LOCAL_FK_INVENTORY.some(f => f.relation === 'public.pipeline_worker_paper_receipts' && f.columns.includes('evidence_id'))).toBe(false);
  });

  it('rejects fabricated original-evidence FK or cascading/delete action in supplied088', async () => {
    const source = await sources(), sql = text(source.sql088);
    const fabricated = sql.replace('evidence_id text NOT NULL,', 'evidence_id text NOT NULL REFERENCES public.copy_execution_evidence(id) ON DELETE RESTRICT,');
    expect(fabricated).not.toBe(sql);
    expect(() => bindPipelineProvisioningSource({ ...source, sql088: bytes(fabricated) })).toThrow('FK');
    expect(() => bindPipelineProvisioningSource({ ...source, sql088: bytes(sql.replace('ON DELETE RESTRICT', 'ON DELETE CASCADE')) })).toThrow('FK');
  });

  it('requires exact inert routine facts, TABLE modes/type identities and supplied bodies, never authorizes from them', async () => {
    const source = await sources(), binding = bindPipelineProvisioningSource(source), facts = inertFacts(binding);
    expect(() => validatePipelineInertRoutineFacts(binding, source, facts)).not.toThrow();
    const lookup = facts.findIndex(f => f.signature === PIPELINE_NEW_LOOKUP_ROUTINES[1]);
    for (const patch of [{ owner: 'swat_runtime_lookup' }, { body: facts[lookup]!.body + '\n' },
      { argumentModes: ['i','i','i','i','i'] }, { allArgumentTypes: null }, { resultType: 'pg_catalog.jsonb' },
      { returnsSet: false }, { rows: 0 }, { searchPath: ['search_path=public'] }, { strict: true }]) {
      const changed = facts.map((f, i) => i === lookup ? { ...f, ...patch } : f) as unknown as PipelineRoutineFact[];
      expect(() => validatePipelineInertRoutineFacts(binding, source, changed)).toThrow('facts drift');
    }
    expect(binding.status.runtimeAccepted).toBe(false);
  });

  it('checks disabled ownership phase facts without membership/role-name or hash shortcuts', () => {
    const facts = disabledFacts();
    expect(() => validatePipelineDisabledRoleFacts(facts, 'inert')).not.toThrow();
    const receipt = facts.findIndex(f => f.role === 'swat_worker_receipt_writer');
    for (const patch of [{ canLogin: true }, { membershipsIn: 1 }, { membershipsOut: 1 }, { inherit: true },
      { relationOwnership: 1 }, { schemaCreate: true }, { ownedFunctions: [PIPELINE_WORKER_ROUTINES[5]] }]) {
      expect(() => validatePipelineDisabledRoleFacts(facts.map((f, i) => i === receipt ? { ...f, ...patch } : f) as unknown as PipelineDisabledRoleFact[], 'inert')).toThrow('facts drift');
    }
    const backend = facts.map(f => f.role === 'swat_runtime_lookup' ? { ...f, ownedFunctions: [...f.ownedFunctions, PIPELINE_NEW_LOOKUP_ROUTINES[0]] } : f);
    expect(() => validatePipelineDisabledRoleFacts(backend, 'backend-owner-committed')).not.toThrow();
    const both = backend.map(f => f.role === 'swat_runtime_lookup' ? { ...f, ownedFunctions: [...f.ownedFunctions, PIPELINE_NEW_LOOKUP_ROUTINES[1]] } : f);
    expect(() => validatePipelineDisabledRoleFacts(both, 'both-lookup-owners-committed')).not.toThrow();
    expect(() => validatePipelineDisabledRoleFacts(both, 'inert')).toThrow('facts drift');
    expect(() => validatePipelineDisabledRoleFacts(both.map(f => f.role === 'swat_runtime_lookup' ? { ...f, ownedFunctions: [...f.ownedFunctions, 'public.unreviewed()'] } : f), 'both-lookup-owners-committed')).toThrow('facts drift');
  });

  it('proposes disabled receipt role and TWO ownership-only handoffs as separate external audited commits, never ready', async () => {
    const source = await sources(), proposal = createPipelineProvisioningProposal(source, refs);
    expect(proposal.separateExternalDbaCommits.map(s => s.stage)).toEqual(['disabled-receipt-writer','backend-lookup-owner','follower-lookup-owner']);
    expect(new Set(proposal.separateExternalDbaCommits.map(s => s.auditReference)).size).toBe(3);
    expect(proposal.separateExternalDbaCommits.every(s => s.readyToExecute === false)).toBe(true);
    expect(proposal.separateExternalDbaCommits[0]!.proposedStatements[0]).toContain('NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT');
    expect(proposal.separateExternalDbaCommits[1]!.proposedStatements).toEqual(['ALTER FUNCTION public.swat_pipeline_backend_capability(text,text) OWNER TO swat_runtime_lookup;']);
    expect(proposal.separateExternalDbaCommits[2]!.proposedStatements).toEqual(['ALTER FUNCTION public.swat_pipeline_exact_follower_balance(uuid,text,text,text,text) OWNER TO swat_runtime_lookup;']);
    const statements = proposal.separateExternalDbaCommits.flatMap(s => s.proposedStatements).join('\n');
    expect(statements).not.toMatch(/\b(?:GRANT|REVOKE|COMMIT|BEGIN|CREATE POLICY|SET ROLE|LOGIN VALID UNTIL)\b|swat_migration_handoff|swat_handoff_broker/);
    expect(PIPELINE_EXISTING_BROKER_BOUNDARY).toHaveLength(7);
    for (const signature of PIPELINE_NEW_LOOKUP_ROUTINES) expect(PIPELINE_EXISTING_BROKER_BOUNDARY as readonly string[]).not.toContain(signature);
    expect(proposal.status.authenticatesExternalApproval).toBe(false);
    expect(Object.isFrozen(proposal.separateExternalDbaCommits[1]!.proposedStatements)).toBe(true);
    expect(() => createPipelineProvisioningProposal(source, { ...refs, followerLookup: refs.backendLookup })).toThrow('distinct');
    expect(() => createPipelineProvisioningProposal(source, { ...refs, receiptWriter: 'swat_app\n' })).toThrow();
  });

  it('retains null-safe physical identity checks and required JSON model/evidence keys in frozen088', async () => {
    const source = await sources(), sql = text(source.sql088), binding = bindPipelineProvisioningSource(source);
    for (const table of ['pipeline_paper_valuation_evidence','pipeline_worker_paper_receipts']) {
      const start = sql.indexOf(`CREATE TABLE public.${table} (`), end = sql.indexOf('\n);', start);
      expect(sql.slice(start, end)).toContain(')) IS TRUE)');
    }
    const valuation = body(binding, 'public.swat_pipeline_paper_valuation(uuid)');
    expect(valuation).toContain("(terms ?& ARRAY['executionId','userId','chain','tokenMint','targetAccount','executionMode','direction'");
    expect(valuation).toContain("terms->>'simulationModelId' IS NULL");
    expect(valuation).toContain('IS DISTINCT FROM true');
    expect(valuation.lastIndexOf('FOR SHARE')).toBeLessThan(valuation.indexOf('clock_timestamp()'));
    const receipt = body(binding, 'public.swat_pipeline_receipt_valid(uuid,bigint,jsonb)');
    expect(receipt).toContain("(terms->'evidence' ?& ARRAY['executionId','evidenceType','evidenceId','baseQuantity','quoteLeg','priceUsd','feeUsd'");
    expect(receipt).toContain("terms->'evidence'->>'baseQuantity' IS NULL");
    expect(receipt).toContain('NOT isfinite(occurrence)');
  });

  it('preserves nullable ORIGINAL legacy USD/native amount and price=1/all-null exactly, no zero synthesis', async () => {
    const binding = bindPipelineProvisioningSource(await sources());
    const receipt = body(binding, 'public.swat_pipeline_receipt_valid(uuid,bigint,jsonb)');
    const legacy = receipt.slice(receipt.indexOf('-- Legacy original'), receipt.indexOf('\n ELSE', receipt.indexOf('-- Legacy original')));
    expect(legacy).toContain("original.quote_currency IS DISTINCT FROM (terms->'evidence'->'quoteLeg'->>'currency')");
    expect(legacy).toContain("original.quote_native_quantity IS DISTINCT FROM (terms->'evidence'->'quoteLeg'->>'amount')::numeric");
    expect(legacy).toContain("original.quote_native_usd_price IS DISTINCT FROM CASE WHEN terms->'evidence'->'quoteLeg'='null'::jsonb THEN NULL::numeric ELSE 1::numeric END");
    expect(legacy).toContain('FOR SHARE');
    expect(legacy).not.toMatch(/COALESCE\([^)]*,\s*0|ELSE\s+0::numeric/);
    const replay = body(binding, PIPELINE_WORKER_ROUTINES[5]);
    expect(replay.indexOf('pg_advisory_xact_lock')).toBeLessThan(replay.indexOf('public.swat_pipeline_worker_scope'));
    expect(replay.indexOf('pg_advisory_xact_lock')).toBeLessThan(replay.indexOf('public.swat_pipeline_receipt_valid'));
    expect(replay).toContain('FOR SHARE');
  });

  it('allows only confirmed/finalized applied legacy originals with unchanged confirmed receipt economics', async () => {
    const binding = bindPipelineProvisioningSource(await sources());
    const receipt = body(binding, 'public.swat_pipeline_receipt_valid(uuid,bigint,jsonb)');
    const start = receipt.indexOf('-- Legacy original'), end = receipt.indexOf('\n ELSE', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const legacy = receipt.slice(start, end);
    expect(receipt).toContain("terms->'evidence'->>'confirmationState' IS DISTINCT FROM 'confirmed'");
    expect(legacy).toContain("(original.confirmation_state IN('confirmed','finalized')) IS DISTINCT FROM true");
    expect(legacy).not.toContain("original.confirmation_state IS DISTINCT FROM 'confirmed'");
    expect(legacy).not.toMatch(/original\.confirmation_state[^\n]*'reversed'/);
    expect(legacy).toContain('original.completes_execution IS DISTINCT FROM true');
    expect(legacy).toContain('OR NOT EXISTS(SELECT 1 FROM public.copy_position_applications app WHERE app.evidence_id=original.id AND app.execution_id=e.id AND app.user_id=e.user_id AND app.active)');
    expect(legacy).toContain("WHERE execution_id=e.id AND evidence_id=terms->'evidence'->>'evidenceId' AND evidence_type='paper_simulation' FOR SHARE");
    for (const comparison of [
      'original.base_quantity IS DISTINCT FROM base',
      "original.quote_quantity IS DISTINCT FROM (terms->'evidence'->'quoteLeg'->>'amount')::numeric",
      "original.quote_currency IS DISTINCT FROM (terms->'evidence'->'quoteLeg'->>'currency')",
      "original.quote_native_quantity IS DISTINCT FROM (terms->'evidence'->'quoteLeg'->>'amount')::numeric",
      "original.quote_native_usd_price IS DISTINCT FROM CASE WHEN terms->'evidence'->'quoteLeg'='null'::jsonb THEN NULL::numeric ELSE 1::numeric END",
      "original.price_usd IS DISTINCT FROM (terms->'evidence'->>'priceUsd')::numeric",
      "original.fee_usd IS DISTINCT FROM (terms->'evidence'->>'feeUsd')::numeric",
      'original.occurred_at IS DISTINCT FROM occurrence'
    ]) expect(legacy).toContain(comparison);
    expect(legacy).not.toMatch(/COALESCE\([^)]*,\s*0|ELSE\s+0::numeric/);
  });

  it('rechecks exact live receipt approval after advisory/scope/evidence/replay waits before either return or insert', async () => {
    const binding = bindPipelineProvisioningSource(await sources());
    const replay = body(binding, PIPELINE_WORKER_ROUTINES[5]);
    const ordered = [
      "public.swat_pipeline_approved('paper-receipt',requested_execution::text) IS DISTINCT FROM terms",
      'PERFORM pg_advisory_xact_lock(hashtextextended(requested_execution::text,88082));',
      'PERFORM public.swat_pipeline_worker_scope(requested_execution,terms);',
      'PERFORM public.swat_pipeline_receipt_valid(requested_execution,requested_fence,terms);',
      "SELECT * INTO old FROM public.pipeline_worker_paper_receipts WHERE execution_id=requested_execution AND worker_fence=requested_fence AND evidence_id=terms->'evidence'->>'evidenceId' FOR SHARE;",
      "SELECT * INTO STRICT approval FROM public.swat_pipeline_backend_capability('paper-receipt',requested_execution::text);",
      'checked_at:=clock_timestamp();',
      'IF approval.approved_terms IS DISTINCT FROM terms OR approval.revoked_at IS NOT NULL',
      'OR approval.valid_from>checked_at OR approval.expires_at<=checked_at',
      "THEN RAISE EXCEPTION 'post-wait exact worker paper receipt approval required'; END IF;",
      'IF old.receipt_id IS NOT NULL THEN',
      "IF old.terms IS DISTINCT FROM terms THEN RAISE EXCEPTION 'paper receipt immutable replay collision'; END IF; RETURN terms;",
      'INSERT INTO public.pipeline_worker_paper_receipts('
    ].map(fragment => replay.indexOf(fragment));
    for (let i = 0; i < ordered.length; i++) {
      expect(ordered[i]).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(ordered[i - 1]).toBeLessThan(ordered[i]!);
    }
    expect(replay.lastIndexOf('FOR SHARE')).toBeLessThan(ordered[5]!);
    expect(replay.indexOf('RETURN terms;')).toBeGreaterThan(ordered[9]!);
  });

  it('explicitly preserves global-control/capacity/settlement/forward074/observer and full-P3 source blockers', () => {
    const blockers = PIPELINE_SOURCE_BLOCKERS.join('\n');
    for (const required of ['Global-control','capacity','settlement','forward074','observer run/backend/namespace/asset',
      'scoped SELECT RLS','worker_correction_authorized','NOT full P3','prior47-constraint/188-enforcement-path',
      'exactly seven079082','no broad grants','I1-I8']) expect(blockers).toContain(required);
    expect(PIPELINE_PROVISIONING_STATUS).toMatchObject({ sourceComplete: false, runtimeAccepted: false,
      liveCapabilityAccepted: false, productionReady: false, reviewed: false, selected: false, applied: false });
  });
});

function pipelineSqlHarness(binding: PipelineSourceBinding, dbaRole = 'ext_dba') {
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
  let publicCreateForLookup = false;
  let backendPid = 101;
  let identityOverride: Record<string, unknown> = {};
  let roleRowMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let relRowMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let procRowMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let fkRowMutator: ((rows: Record<string, unknown>[]) => void) | null = null;
  let policyRows: Record<string, unknown>[] = [];
  let commitBehavior: 'ok' | 'throw' | 'rollback-reply' = 'ok';
  let driftPidAfterBegin = false;
  let inTx = false;

  const query = vi.fn(async (sql: string, _values: unknown[] = []) => {
    calls.push(sql);
    if (sql === 'BEGIN' || sql === 'BEGIN READ ONLY') {
      inTx = true;
      return { rows: [], command: 'BEGIN' };
    }
    if (sql === 'COMMIT') {
      if (commitBehavior === 'throw') throw new Error('network link severed during COMMIT');
      if (commitBehavior === 'rollback-reply') return { rows: [], command: 'ROLLBACK' };
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
    if (sql.startsWith('LOCK TABLE ')) {
      return { rows: [] };
    }
    if (sql.includes('CREATE ROLE swat_worker_receipt_writer')) {
      createdRoles.add('swat_worker_receipt_writer');
      return { rows: [] };
    }
    if (sql.startsWith('ALTER ROLE swat_worker_receipt_writer SET ')) {
      const prev = roleSettings.get('swat_worker_receipt_writer') ?? [];
      if (sql.includes('row_security=on') && !prev.includes('row_security=on')) prev.push('row_security=on');
      if (sql.includes('search_path=pg_catalog') && !prev.includes('search_path=pg_catalog')) prev.push('search_path=pg_catalog');
      roleSettings.set('swat_worker_receipt_writer', prev);
      return { rows: [] };
    }
    if (sql === 'GRANT CREATE ON SCHEMA public TO swat_runtime_lookup') {
      publicCreateForLookup = true;
      return { rows: [] };
    }
    if (sql === 'REVOKE CREATE ON SCHEMA public FROM swat_runtime_lookup') {
      publicCreateForLookup = false;
      return { rows: [] };
    }
    const alterMatch = /^ALTER FUNCTION (public\.[^(]+\([^)]*\)) OWNER TO swat_runtime_lookup$/.exec(sql);
    if (alterMatch) {
      if (!publicCreateForLookup) throw new Error('missing temp CREATE on public');
      routineOwners.set(alterMatch[1]!, 'swat_runtime_lookup');
      return { rows: [] };
    }
    if (sql.startsWith('REVOKE ALL ON FUNCTION ')) {
      return { rows: [] };
    }
    if (sql.includes('pg_catalog.pg_stat_activity') && sql.includes('current_user AS current_role')) {
      if (driftPidAfterBegin && inTx && calls.filter(c => c.includes('current_user AS current_role')).length >= 2) {
        backendPid = 999;
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
        can_create: rolname === 'swat_runtime_lookup' ? publicCreateForLookup : false,
        functions: rolname === 'swat_runtime_lookup' ? lookupOwned : [],
        extra_ownership: false
      }));
      roleRowMutator?.(rows);
      return { rows };
    }
    if (sql.includes('FROM pg_catalog.pg_db_role_setting s')) {
      const rows = [...roleSettings.entries()].map(([rolname, setconfig]) => ({
        rolname,
        setdatabase: 0,
        setconfig
      }));
      return { rows };
    }
    if (sql.includes('FROM pg_catalog.pg_namespace n')) {
      return { rows: [{ nspname: 'public', owner: 'swat_migrator', restricted_or_public_create: publicCreateForLookup }] };
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
      relRowMutator?.(rows);
      return { rows };
    }
    if (sql.includes('FROM pg_catalog.pg_proc p') && sql.includes('JOIN pg_catalog.pg_language l')) {
      const rows: Record<string, unknown>[] = PIPELINE_ROUTINE_INVENTORY.map(r => {
        const owner = routineOwners.get(r.signature) ?? 'swat_migrator';
        const aclPhase: PipelineCatalogPhase =
          owner === 'swat_runtime_lookup'
            ? (r.signature === PIPELINE_NEW_LOOKUP_ROUTINES[1] ? 'both-lookup-owners-committed' : 'backend-owner-committed')
            : 'inert';
        return {
          signature: r.signature,
          owner,
          prosrc: body(binding, r.signature),
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
      procRowMutator?.(rows);
      return { rows };
    }
    if (sql.includes('FROM pg_catalog.pg_proc p') && !sql.includes('JOIN pg_catalog.pg_language')) {
      return {
        rows: PIPELINE_EXISTING_BROKER_BOUNDARY.map(sig => ({
          signature: sig,
          owner: sig.includes('runtime_capability') || sig.includes('worker_execution') ? 'swat_runtime_lookup' : 'swat_financial_settler'
        }))
      };
    }
    if (sql.includes('FROM pg_catalog.pg_policy p')) {
      return { rows: policyRows };
    }
    if (sql.includes('FROM pg_catalog.pg_constraint con')) {
      const rows: Record<string, unknown>[] = PIPELINE_LOCAL_FK_INVENTORY.map(f => ({
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
      }));
      fkRowMutator?.(rows);
      return { rows };
    }
    throw new Error(`Unexpected pipeline SQL query: ${sql}`);
  });

  const client = { query } as unknown as PipelineQueryClient;
  const acquire = async (): Promise<PipelineClientLease> => ({
    client,
    release: (broken: boolean) => { releases.push(broken); }
  });

  return {
    client,
    acquire,
    calls,
    releases,
    setIdentityOverride: (patch: Record<string, unknown>) => { identityOverride = patch; },
    setRoleMutator: (fn: (rows: Record<string, unknown>[]) => void) => { roleRowMutator = fn; },
    setRelMutator: (fn: (rows: Record<string, unknown>[]) => void) => { relRowMutator = fn; },
    setProcMutator: (fn: (rows: Record<string, unknown>[]) => void) => { procRowMutator = fn; },
    setFkMutator: (fn: (rows: Record<string, unknown>[]) => void) => { fkRowMutator = fn; },
    setPolicies: (rows: Record<string, unknown>[]) => { policyRows = rows; },
    setCommitBehavior: (mode: 'ok' | 'throw' | 'rollback-reply') => { commitBehavior = mode; },
    enablePidDrift: () => { driftPidAfterBegin = true; }
  };
}

describe('Wave4 pipeline executable provisioning companion (mocked SQL client)', () => {
  it('provisions disabled receipt writer and transfers lookup routines atomically, then runs fresh BEGIN READ ONLY validation', async () => {
    const source = await sources(), binding = bindPipelineProvisioningSource(source);
    const h = pipelineSqlHarness(binding);
    await provisionWave4PipelineCompanion({ acquire: h.acquire, dbaRole: 'ext_dba', source });

    expect(h.calls.some(c => c.includes('CREATE ROLE swat_worker_receipt_writer NOLOGIN PASSWORD NULL'))).toBe(true);
    expect(h.calls.filter(c => c.startsWith('ALTER FUNCTION '))).toHaveLength(2);
    const grantCreateIdx = h.calls.indexOf('GRANT CREATE ON SCHEMA public TO swat_runtime_lookup');
    const revokeCreateIdx = h.calls.indexOf('REVOKE CREATE ON SCHEMA public FROM swat_runtime_lookup');
    const commitIdx = h.calls.indexOf('COMMIT');
    expect(grantCreateIdx).toBeGreaterThan(-1);
    expect(revokeCreateIdx).toBeGreaterThan(grantCreateIdx);
    expect(commitIdx).toBeGreaterThan(revokeCreateIdx);
    expect(h.calls.some(c => c.includes('SET ROLE'))).toBe(false);
    expect(h.calls.filter(c => c === 'BEGIN READ ONLY')).toHaveLength(1);
    expect(h.calls.indexOf('BEGIN READ ONLY')).toBeGreaterThan(commitIdx);
    expect(h.releases).toEqual([false, false]);
  });

  it('supports staged provisioning and standalone read-only installation validation', async () => {
    const source = await sources(), binding = bindPipelineProvisioningSource(source);
    const h = pipelineSqlHarness(binding);
    await provisionWave4PipelineCompanion({ acquire: h.acquire, dbaRole: 'ext_dba', source, stage: 'disabled-receipt-writer' });
    await validateWave4PipelineInstallation({ acquire: h.acquire, dbaRole: 'ext_dba', source, phase: 'disabled-receipt-writer' });
    await provisionWave4PipelineCompanion({ acquire: h.acquire, dbaRole: 'ext_dba', source, stage: 'backend-lookup-owner' });
    await provisionWave4PipelineCompanion({ acquire: h.acquire, dbaRole: 'ext_dba', source, stage: 'follower-lookup-owner' });
    expect(h.releases.every(broken => broken === false)).toBe(true);
  });

  it('rejects SET ROLE aliases, wrong current_user, disabled row_security, and dirty transactions before BEGIN', async () => {
    const source = await sources(), binding = bindPipelineProvisioningSource(source);
    for (const badRole of ['swat_app', 'ext; SET ROLE swat_migrator', 'ext dba']) {
      const h = pipelineSqlHarness(binding);
      await expect(assertWave4PipelineRoleWithClient(h.client, badRole, 'dba')).rejects.toThrow();
      expect(h.calls).toHaveLength(0);
    }
    for (const patch of [
      { role_setting: 'swat_migrator' },
      { session_role: 'swat_migrator' },
      { current_role: 'swat_app' },
      { row_security: 'off' },
      { superuser: false },
      { has_memberships: true },
      { transaction_clean: false }
    ]) {
      const h = pipelineSqlHarness(binding);
      h.setIdentityOverride(patch);
      await expect(provisionWave4PipelineCompanion({ acquire: h.acquire, dbaRole: 'ext_dba', source })).rejects.toThrow();
      expect(h.calls).not.toContain('BEGIN');
      expect(h.releases).toEqual([true]);
    }
  });

  it('rejects role membership widening, PUBLIC EXECUTE, RLS disabled, permissive policy, and missing FK before COMMIT', async () => {
    const source = await sources(), binding = bindPipelineProvisioningSource(source);

    const membership = pipelineSqlHarness(binding);
    membership.setRoleMutator(rows => { rows[0]!.membership = true; });
    await expect(provisionWave4PipelineCompanion({ acquire: membership.acquire, dbaRole: 'ext_dba', source })).rejects.toThrow(/membership/i);
    expect(membership.calls).toContain('ROLLBACK');
    expect(membership.releases).toEqual([true]);

    const pubExec = pipelineSqlHarness(binding);
    pubExec.setProcMutator(rows => {
      (rows[0]!.acl as Record<string, unknown>[]).push({ grantor: 'swat_migrator', grantee: 'PUBLIC', privilege: 'EXECUTE', grantable: false });
    });
    await expect(provisionWave4PipelineCompanion({ acquire: pubExec.acquire, dbaRole: 'ext_dba', source })).rejects.toThrow(/ACL/i);
    expect(pubExec.calls).toContain('ROLLBACK');

    const rlsOff = pipelineSqlHarness(binding);
    rlsOff.setRelMutator(rows => { rows[0]!.relforcerowsecurity = false; });
    await expect(provisionWave4PipelineCompanion({ acquire: rlsOff.acquire, dbaRole: 'ext_dba', source })).rejects.toThrow(/FORCE RLS/i);
    expect(rlsOff.calls).toContain('ROLLBACK');

    const permissivePol = pipelineSqlHarness(binding);
    permissivePol.setPolicies([{
      relation: 'public.pipeline_backend_approvals',
      polname: 'hostile_open',
      polpermissive: true,
      roles: ['PUBLIC'],
      using_expr: 'true',
      check_expr: null
    }]);
    await expect(validateWave4PipelineCommittedCatalog({ client: permissivePol.client, dbaRole: 'ext_dba', source, phase: 'inert' })).rejects.toThrow(/permissive policy/i);

    const missingFk = pipelineSqlHarness(binding);
    missingFk.setFkMutator(rows => { rows.pop(); });
    await expect(provisionWave4PipelineCompanion({ acquire: missingFk.acquire, dbaRole: 'ext_dba', source })).rejects.toThrow(/FK count drift/i);
    expect(missingFk.calls).toContain('ROLLBACK');
  });

  it('fences uncertain COMMIT with PipelineCommitUncertainError, never emits ROLLBACK, and releases broken lease', async () => {
    const source = await sources(), binding = bindPipelineProvisioningSource(source);
    for (const mode of ['throw', 'rollback-reply'] as const) {
      const h = pipelineSqlHarness(binding);
      h.setCommitBehavior(mode);
      await expect(provisionWave4PipelineCompanion({ acquire: h.acquire, dbaRole: 'ext_dba', source })).rejects.toThrow(PipelineCommitUncertainError);
      expect(h.calls).not.toContain('ROLLBACK');
      expect(h.releases).toEqual([true]);
    }
  });

  it('rejects backend PID drift before COMMIT and emits ROLLBACK cleanly', async () => {
    const source = await sources(), binding = bindPipelineProvisioningSource(source);
    const h = pipelineSqlHarness(binding);
    h.enablePidDrift();
    await expect(provisionWave4PipelineCompanion({ acquire: h.acquire, dbaRole: 'ext_dba', source })).rejects.toThrow(/backend PID drift/i);
    expect(h.calls).toContain('ROLLBACK');
    expect(h.calls).not.toContain('COMMIT');
    expect(h.releases).toEqual([true]);
  });
});
