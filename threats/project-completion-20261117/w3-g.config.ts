import { fileURLToPath } from 'node:url';
import { createPackageConfig } from '../sequential-fixes/package12-29-harness.js';
// Literal offline selection only. Import inventory and hashes: WAVE3-G-IMPLEMENTATION.md.
// Coordinator review/global freeze required; this config is not test or runtime acceptance.
const config = createPackageConfig([
  'packages/db/src/lp-exact.sequential.test.ts',
  'packages/db/src/lp-paper-protocol.sequential.test.ts',
  'packages/db/src/lp-paper-store.sequential.test.ts',
  'packages/db/src/lp-lifecycle.sequential.test.ts',
  'packages/db/src/lp-positions.test.ts',
  'packages/db/src/lp-copy-trading.test.ts',
  'packages/db/src/lp-guardrails.test.ts',
  'apps/lp/src/builder/exact-paper.sequential.test.ts',
  'apps/lp/src/builder/build-position.test.ts',
  'apps/lp/src/lifecycle.sequential.test.ts',
  'apps/lp/src/routes-exact.sequential.test.ts',
  'apps/lp/src/routes.test.ts',
  'apps/lp/src/copy/copy.test.ts',
  'apps/lp/src/monitor/monitor-job.test.ts'
]);
const names = ['lp-exact', 'lp-paper-service', 'lp-paper-store', 'lp-paper-fixture'];
const inherited = config.resolve?.alias;
const entries = Array.isArray(inherited) ? inherited : Object.entries(inherited ?? {}).map(([find, replacement]) => ({ find, replacement }));
export default { ...config, resolve: { ...config.resolve, alias: [
  ...names.map(name => ({ find: new RegExp(`^@swat/db/dist/${name}\\.js$`),
    replacement: fileURLToPath(new URL(`../../packages/db/src/${name}.ts`, import.meta.url)) })),
  ...entries
] } };
