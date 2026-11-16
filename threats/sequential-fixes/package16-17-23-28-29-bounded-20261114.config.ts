import { createPackageConfig } from './package12-29-harness.js';

export default createPackageConfig([
  'apps/trade-executor/src/policy.test.ts',
  'apps/trade-executor/src/copy-eligibility.test.ts',
  'apps/signal-engine/src/trade-eligibility.test.ts',
  'apps/trade-executor/src/package17-authority-bounded.sequential.test.ts',
  'apps/api/src/package28-limiter.test.ts',
  'packages/db/src/package23-perps.sequential.test.ts',
  'apps/api/src/routes/package23-perps-close.sequential.test.ts',
  'apps/api/src/routes/me.authority.sequential.test.ts',
  'apps/api/src/routes/me.grants.sequential.test.ts',
  'apps/api/src/routes/me.withdrawal.sequential.test.ts',
  'apps/api/src/routes/package29-admin-csv.sequential.test.ts'
]);
