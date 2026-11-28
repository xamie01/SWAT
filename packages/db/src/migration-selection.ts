import { createHash } from 'node:crypto';
import type { MigrationFile } from './migration-discovery.js';

export const WAVE4_REFUSAL = {
  file: '084_wave4_lp_runtime_privileges.sql',
  checksum: '92e662015a2527a6cfb7ed42a7efec628cc42e35cc69bfec95cc4c5099f224e2',
  reason: '084 is a preserved refusal proposal, not executable authority; reviewed protected admission 085 and restricted composition 086 replace its proposed grants.'
} as const;
export const WAVE4_COMPOSITION_FILE = '086_wave4_restricted_composition.sql';
export const WAVE4_AUTHENTICATION_FILE = '087_wave4_protected_authentication.sql';
export const WAVE4_PIPELINE_FILE = '088_wave4_protected_pipeline.sql';
export const WAVE4_FINANCIAL_FILE = '089_wave4_protected_financial.sql';
export const WAVE4_LOAD_CAPTURE_FILE = '090_wave4_protected_load_capture.sql';
export const WAVE4_READ_INDEXES_FILE = '091_wave4_read_indexes.sql';
export const WAVE4B_SCALE_FILE = '092_wave4b_scale_and_auth_opt.sql';
export const REVIEWED_085_CHECKSUM = '43f5304417e500c0e9738d07dd517e7f7582f1bc497578759d5eeb686d43e02d';
export const REVIEWED_088_CHECKSUM = '86f467ef7d61329cfd13cfe7591661f54dba80c6c23682c236f57400162faf13';
export const REVIEWED_089_CHECKSUM = '157b2704a633e79d01271f16c46685b079532fb0d3b57619884ecbc6543a68b2';
export const REVIEWED_090_CHECKSUM = 'edff459ad1430b7241588db4a33883afaad353348b5cd17460417e3c6e3dd038';
export const REVIEWED_091_CHECKSUM = '35ab21412baa5f140f081875d650c9fdaca3d1edcca4bc17e9da8af33356f8fd';
export const REVIEWED_092_CHECKSUM = '91f7911e97344a6c18dbdd52653c3522e2a5b8a9f0dd16232e50689a89920b9f';
export type MigrationIdentity = { readonly file: string; readonly checksum: string };
export type MigrationSelectionProposal = {
  readonly version: 1;
  readonly purpose: 'wave4-authorized-qualification';
  readonly inventory: readonly MigrationIdentity[];
  readonly included: readonly MigrationIdentity[];
  readonly excluded: readonly (MigrationIdentity & { readonly reason: string })[];
  readonly manifestChecksum: string;
};
export type ReviewedMigrationSelection = MigrationSelectionProposal & {
  readonly status: 'reviewed';
  readonly auditReference: string;
};
export function sourceChecksum(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function requireAuditReference(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1 || value.length > 2000
      || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Explicit bounded external audit reference required');
}
function identities(inventory: readonly MigrationFile[]): MigrationIdentity[] {
  if (inventory.length !== 92) throw new Error('Wave4 selection requires complete 001–092 inventory including refused 084');
  return inventory.map((migration, index) => {
    if (!new RegExp(`^${String(index + 1).padStart(3, '0')}_[a-z0-9_]+\\.sql$`).test(migration.file)
        || !/^[a-f0-9]{64}$/.test(migration.checksum)
        || sourceChecksum(migration.sql) !== migration.checksum) throw new Error('Migration inventory name/order/source checksum drift');
    return { file: migration.file, checksum: migration.checksum };
  });
}
/** Generates a review artifact, never authorization or migration journal entries. */
export function createMigrationSelectionProposal(inventory: readonly MigrationFile[]): MigrationSelectionProposal {
  const all = identities(inventory);
  if (all[83]?.file !== WAVE4_REFUSAL.file || all[83]?.checksum !== WAVE4_REFUSAL.checksum
      || all[84]?.file !== '085_lp_protected_paper_admission.sql' || all[84]?.checksum !== REVIEWED_085_CHECKSUM
      || all[85]?.file !== WAVE4_COMPOSITION_FILE || all[86]?.file !== WAVE4_AUTHENTICATION_FILE
      || all[87]?.file !== WAVE4_PIPELINE_FILE || all[87]?.checksum !== REVIEWED_088_CHECKSUM
      || all[88]?.file !== WAVE4_FINANCIAL_FILE || all[88]?.checksum !== REVIEWED_089_CHECKSUM
      || all[89]?.file !== WAVE4_LOAD_CAPTURE_FILE || all[89]?.checksum !== REVIEWED_090_CHECKSUM
      || all[90]?.file !== WAVE4_READ_INDEXES_FILE || all[90]?.checksum !== REVIEWED_091_CHECKSUM
      || all[91]?.file !== WAVE4B_SCALE_FILE || all[91]?.checksum !== REVIEWED_092_CHECKSUM) throw new Error('Wave4 reviewed/refusal source identity drift');
  const body = { version: 1 as const, purpose: 'wave4-authorized-qualification' as const,
    inventory: all, included: all.filter(row => row.file !== WAVE4_REFUSAL.file), excluded: [{ ...WAVE4_REFUSAL }] };
  return { ...body, manifestChecksum: sourceChecksum(JSON.stringify(body)) };
}
/** External reviewer invokes this explicitly with a durable approval identity. No environment opt-in. */
export function reviewMigrationSelection(proposal: MigrationSelectionProposal, auditReference: string): ReviewedMigrationSelection {
  requireAuditReference(auditReference);
  return { ...proposal, status: 'reviewed', auditReference };
}
/** Rebuild against freshly read bytes; omissions, new files, reordering and all checksum drift refuse. */
export function selectMigrations(inventory: readonly MigrationFile[], selection: ReviewedMigrationSelection): MigrationFile[] {
  if (!selection || selection.status !== 'reviewed') throw new Error('Explicit reviewed migration selection required');
  requireAuditReference(selection.auditReference);
  const expected = createMigrationSelectionProposal(inventory);
  for (const key of ['version', 'purpose', 'inventory', 'included', 'excluded', 'manifestChecksum'] as const) {
    if (JSON.stringify(selection[key]) !== JSON.stringify(expected[key])) throw new Error(`Reviewed migration selection drift: ${key}`);
  }
  return inventory.filter(row => row.file !== WAVE4_REFUSAL.file);
}
