import { createPackageConfig } from '../sequential-fixes/package12-29-harness.js';
export default createPackageConfig([
  'apps/trade-executor/src/worker-policy.sequential.test.ts',
  'apps/trade-executor/src/worker-entrypoint.sequential.test.ts',
  'packages/db/src/worker-policy.sequential.test.ts',
  'packages/db/src/worker-settlement.sequential.test.ts',
  'apps/trade-executor/src/policy.test.ts',
  'apps/trade-executor/src/canonical-copy.test.ts',
  'packages/db/src/package19-risk-reservations.sequential.test.ts',
  'packages/db/src/transaction.test.ts',
  'packages/db/src/master-capacity.test.ts'
]);
