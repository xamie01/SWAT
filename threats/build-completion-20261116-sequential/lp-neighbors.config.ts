import { createPackageConfig } from '../sequential-fixes/package12-29-harness.js';
export default createPackageConfig([
  'apps/lp/src/routes.test.ts',
  'apps/lp/src/builder/live-context.sequential.test.ts',
  'apps/lp/src/builder/live-preview.test.ts',
  'apps/lp/src/builder/ladder-plan.test.ts',
  'apps/lp/src/builder/ladder-builders.test.ts',
  'apps/lp/src/monitor/monitor-job.test.ts',
  'apps/lp/src/monitor/monitor.test.ts',
  'apps/lp/src/copy/copy.test.ts',
  'apps/lp/src/guardrails/guardrails.test.ts',
  'packages/db/src/lp-positions.test.ts',
  'packages/db/src/lp-guardrails.test.ts',
  'packages/db/src/lp-copy-trading.test.ts',
  'packages/db/src/lp-pools.test.ts'
]);
