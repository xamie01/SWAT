import { createPackageConfig } from './package12-29-harness.js';
// The complete historical isolation file is retained in neighbor-final (one
// unresolved chaos static failure). This separate manifest has no test filters.
export default createPackageConfig([
  'tests/unit/package28-preflight.test.ts',
  'packages/shared/src/address.test.ts',
  'packages/db/src/migrations.test.ts',
  'packages/db/src/database-policy.sequential.test.ts'
]);
