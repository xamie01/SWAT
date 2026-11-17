import { createPackageConfig } from '../sequential-fixes/package12-29-harness.js';
export default createPackageConfig([
  'packages/db/src/custody-contract.test.ts',
  'packages/db/src/custody-enrollment.test.ts',
  'packages/db/src/custody-execution.test.ts',
  'packages/db/src/custody-store.test.ts',
  'packages/db/src/custody-credentials.test.ts',
  'packages/db/src/execution-grants.test.ts',
  'packages/db/src/execution-grants.sequential.test.ts',
  'apps/trade-executor/src/delegation-authority.test.ts',
  'apps/trade-executor/src/execution-authority.test.ts',
  'apps/trade-executor/src/execution-authority-adapters.test.ts'
]);
