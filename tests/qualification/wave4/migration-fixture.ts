import { createMigrationSelectionProposal, reviewMigrationSelection, selectMigrations } from '../../../packages/db/src/migration-selection.js';
import { discoverMigrationInventory } from '../../../packages/db/src/migration-discovery.js';
import { createInstallationPlan } from '../../../packages/db/src/installation-plan.js';
import { hash } from './core.js';

export async function offlineMigrationSource() {
  const root = new URL('../../../packages/db/sql/', import.meta.url).pathname;
  const inventory = await discoverMigrationInventory(root);
  const selection = reviewMigrationSelection(createMigrationSelectionProposal(inventory), 'offline-contract-only-not-runtime-authorization');
  const files = selectMigrations(inventory, selection);
  const plan = createInstallationPlan(files, { selection, auditReference: selection.auditReference });
  return { files, plan, digest: hash({ profile: 'core', migrations: files.map(({ file, checksum }) => ({ file, checksum })),
    selectionChecksum: selection.manifestChecksum, planChecksum: plan.planChecksum }) };
}
