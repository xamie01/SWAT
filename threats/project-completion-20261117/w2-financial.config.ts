import { createPackageConfig } from '../sequential-fixes/package12-29-harness.js';
export default createPackageConfig([
  'packages/db/src/worker-correction-admission.sequential.test.ts',
  'packages/db/src/worker-valuation-corrections.sequential.test.ts',
  'packages/db/src/worker-settlement.sequential.test.ts',
  'packages/db/src/package19-risk-reservations.sequential.test.ts',
  'packages/db/src/trades.test.ts'
]);
