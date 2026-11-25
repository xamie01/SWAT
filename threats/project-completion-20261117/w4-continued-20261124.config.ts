import { fileURLToPath } from 'node:url';
import { createPackageConfig } from '../sequential-fixes/package12-29-harness.js';

const config = createPackageConfig([
  'tests/qualification/wave4/pipeline-source-backing.offline.test.ts',
  'tests/qualification/wave4/pipeline-follower-backing.offline.test.ts',
  'tests/qualification/wave4/pipeline-worker-backing.offline.test.ts',
  'tests/qualification/wave4/pipeline-provisioning.offline.test.ts',
  'packages/db/src/exact-follower-sizing.sequential.test.ts',
  'tests/qualification/wave4/pipeline-executed.offline.test.ts',
  'tests/qualification/wave4/pipeline-sql-observer.offline.test.ts',
  'tests/qualification/wave4/custody-owned-composition.offline.test.ts',
  'tests/qualification/wave4/withdrawal-owned-composition.offline.test.ts',
  'tests/qualification/wave4/reducing-owned-composition.offline.test.ts',
  'tests/qualification/wave4/lp-owned-composition.offline.test.ts',
  'tests/qualification/wave4/financial-backing.offline.test.ts',
  'packages/db/src/execution-grant-projection.test.ts',
  'packages/db/src/execution-grants.test.ts',
  'packages/db/src/execution-grants.sequential.test.ts',
  'packages/db/src/custody-store.test.ts',
  'packages/db/src/custody-credentials.test.ts',
  'packages/db/src/custody-enrollment.test.ts',
  'packages/db/src/custody-contract.test.ts',
  'packages/db/src/custody-execution.test.ts',
  'packages/db/src/withdrawal-store.test.ts',
  'packages/db/src/withdrawal-protocol.test.ts',
  'packages/db/src/reducing-protocol.test.ts',
  'tests/qualification/wave4/load-fixture-consumers.offline.test.ts',
  'tests/qualification/wave4/load-durable-economics.offline.test.ts',
  'tests/qualification/wave4/load-capture-backing.offline.test.ts',
  'tests/qualification/wave4/load-lifetime.offline.test.ts',
  'packages/db/src/source-claim.sequential.test.ts'
]);
config.resolve!.alias = [
  { find: /^@swat\/db\/dist\/(.+)\.js$/, replacement: fileURLToPath(new URL('../../packages/db/src/$1.ts', import.meta.url)) },
  ...Object.entries(config.resolve!.alias as Record<string, string>).map(([find, replacement]) => ({ find, replacement }))
];
export default config;
