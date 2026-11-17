import { createPackageConfig } from '../sequential-fixes/package12-29-harness.js';
export default createPackageConfig([
  'packages/db/src/worker-trade-contract.sequential.test.ts',
  'packages/db/src/worker-settlement.sequential.test.ts',
  'apps/trade-executor/src/worker-policy.sequential.test.ts',
  'apps/trade-executor/src/worker-entrypoint.sequential.test.ts',
  'packages/db/src/trades.test.ts',
  'packages/db/src/package19-risk-reservations.sequential.test.ts'
]);
