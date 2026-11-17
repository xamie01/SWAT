import { createPackageConfig } from '../sequential-fixes/package12-29-harness.js';
export default createPackageConfig([
  'packages/db/src/obligation-runtime-capability.sequential.test.ts',
  'packages/db/src/source-sell-lot-allocation.sequential.test.ts',
  'packages/db/src/exact-follower-sizing.sequential.test.ts',
  'apps/trade-executor/src/worker-runtime-adapters.sequential.test.ts',
  'apps/trade-executor/src/worker-policy.sequential.test.ts',
  'apps/trade-executor/src/worker-entrypoint.sequential.test.ts'
]);
