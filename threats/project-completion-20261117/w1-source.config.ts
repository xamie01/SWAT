import { createPackageConfig } from '../sequential-fixes/package12-29-harness.js';
export default createPackageConfig([
  'packages/db/src/source-verification.sequential.test.ts',
  'packages/db/src/source-claim.sequential.test.ts',
  'apps/indexer/src/source-verification.sequential.test.ts',
  'packages/db/src/copy-trade-lifecycle.sequential.test.ts',
  'apps/indexer/src/source-unavailable.sequential.test.ts',
  'packages/db/src/package15-lot-claim-recovery.sequential.test.ts'
]);
