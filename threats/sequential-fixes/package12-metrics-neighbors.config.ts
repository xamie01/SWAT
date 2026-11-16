import { createPackageConfig } from './package12-29-harness';
export default createPackageConfig([
  'packages/db/src/scoring-queries.test.ts',
  'packages/db/src/clustering-queries.test.ts',
  'packages/db/src/independence.test.ts',
  'packages/db/src/independence-queries.test.ts',
  'packages/shared/src/scoring.test.ts',
  'apps/scorer/src/master-metrics.test.ts',
  'apps/scorer/src/expectancy.test.ts'
]);
