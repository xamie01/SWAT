import { fileURLToPath } from 'node:url';
import { createPackageConfig } from '../sequential-fixes/package12-29-harness.js';

const config = createPackageConfig([
  'tests/qualification/wave4/custody-journal.offline.test.ts',
  'tests/qualification/wave4/load-pipeline-durable.offline.test.ts',
  'tests/qualification/wave4/orchestrator.offline.test.ts',
  'tests/qualification/wave4/p6-concurrency-faults.offline.test.ts',
  'tests/qualification/wave4/pipeline-economics.offline.test.ts',
  'tests/qualification/wave4/wave4-provisioning-companions.offline.test.ts'
]);
config.resolve!.alias = [
  { find: /^@swat\/db\/dist\/(.+)\.js$/, replacement: fileURLToPath(new URL('../../packages/db/src/$1.ts', import.meta.url)) },
  ...Object.entries(config.resolve!.alias as Record<string, string>).map(([find, replacement]) => ({ find, replacement }))
];
export default config;
