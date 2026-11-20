import { createHash } from 'node:crypto';
import type { MigrationFile } from './migration-discovery.js';

export const WAVE4_REFUSAL = {
  file: '084_wave4_lp_runtime_privileges.sql',
  checksum: '92e662015a2527a6cfb7ed42a7efec628cc42e35cc69bfec95cc4c5099f224e2',
  reason: '084 is a preserved refusal proposal, not executable authority; reviewed protected admission 085 and restricted composition 086 replace its proposed grants.'
} as const;
export const WAVE4_COMPOSITION_FILE = '086_wave4_restricted_composition.sql';
export const WAVE4_AUTHENTICATION_FILE = '087_wave4_protected_authentication.sql';
export const REVIEWED_085_CHECKSUM = '3abc3a000b11051a2b46243a845b7b29e74979d791550160592a7f403513e0d6';
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
  if (inventory.length !== 87) throw new Error('Wave4 selection requires complete 001–087 inventory including refused 084');
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
      || all[85]?.file !== WAVE4_COMPOSITION_FILE || all[86]?.file !== WAVE4_AUTHENTICATION_FILE) throw new Error('Wave4 reviewed/refusal source identity drift');
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
