import { fileURLToPath } from 'node:url';
import { createPackageConfig } from '../sequential-fixes/package12-29-harness.js';
const config = createPackageConfig([
  'packages/db/src/withdrawal-protocol.test.ts',
  'packages/db/src/withdrawal-store.test.ts',
  'packages/db/src/reducing-protocol.test.ts',
  'packages/db/src/polymarket-perps.reducing.test.ts',
  'packages/db/src/package23-perps.sequential.test.ts',
  'apps/trade-executor/src/reducing-orchestration.test.ts',
  'apps/trade-executor/src/manual-exit.test.ts',
  'apps/trade-executor/src/polymarket-perps.test.ts'
]);
// Coordinator-authorized exact aliases: compiler-safe emitted subpath types, actual current keyless source in tests.
// Preserve inherited CLI, literal manifest, safety setup and one-fork settings unchanged.
const inherited = config.resolve?.alias;
const inheritedEntries = Array.isArray(inherited) ? inherited : Object.entries(inherited ?? {}).map(([find, replacement]) => ({ find, replacement }));
export default {
  ...config,
  resolve: {
    ...config.resolve,
    alias: [
      { find: /^@swat\/db\/dist\/withdrawal-contract\.js$/, replacement: fileURLToPath(new URL('../../packages/db/src/withdrawal-contract.ts', import.meta.url)) },
      { find: /^@swat\/db\/dist\/withdrawal-store\.js$/, replacement: fileURLToPath(new URL('../../packages/db/src/withdrawal-store.ts', import.meta.url)) },
      { find: /^@swat\/db\/dist\/withdrawal-service\.js$/, replacement: fileURLToPath(new URL('../../packages/db/src/withdrawal-service.ts', import.meta.url)) },
      { find: /^@swat\/db\/dist\/withdrawal-test-fixture\.js$/, replacement: fileURLToPath(new URL('../../packages/db/src/withdrawal-test-fixture.ts', import.meta.url)) },
      { find: /^@swat\/db\/dist\/reducing-contract\.js$/, replacement: fileURLToPath(new URL('../../packages/db/src/reducing-contract.ts', import.meta.url)) },
      { find: /^@swat\/db\/dist\/reducing-service\.js$/, replacement: fileURLToPath(new URL('../../packages/db/src/reducing-service.ts', import.meta.url)) },
      ...inheritedEntries
    ]
  }
};
