import { fileURLToPath } from 'node:url';
import { createPackageConfig } from '../sequential-fixes/package12-29-harness.js';
const config = createPackageConfig([
  'apps/api/src/routes/me.withdrawal.sequential.test.ts',
  'apps/api/src/routes/me.grants.sequential.test.ts',
  'apps/api/src/routes/me.authority.sequential.test.ts',
  'apps/api/src/routes/me.portfolio.sequential.test.ts',
  'apps/api/src/routes/package23-perps-close.sequential.test.ts',
  'apps/api/src/routes/me.withdrawal.injected.sequential.test.ts',
  'apps/api/src/routes/me.reducing.injected.sequential.test.ts',
  'apps/api/src/routes/me.custody.injected.sequential.test.ts',
  'apps/web/lib/portfolio-model.sequential.test.ts',
  'apps/web/lib/transport.sequential.test.ts',
  'apps/web/lib/api-error-message.test.ts',
  'apps/web/lib/wallets.sequential.test.ts',
  'apps/web/lib/domain-transport.sequential.test.ts',
  'apps/web/lib/financial-request-state.sequential.test.ts',
  'apps/web/lib/lp-observation.sequential.test.ts',
  'apps/web/lib/lp-request-state.sequential.test.ts'
]);
// Exact API-safe subpaths avoid a whole DB barrel import and stale dist artifacts.
const domainModules = ['withdrawal-contract', 'withdrawal-store', 'withdrawal-service', 'withdrawal-test-fixture',
  'reducing-contract', 'reducing-service', 'custody-contract', 'custody-enrollment'];
const inherited = config.resolve?.alias;
const inheritedEntries = Array.isArray(inherited) ? inherited : Object.entries(inherited ?? {}).map(([find, replacement]) => ({ find, replacement }));
export default {
  ...config,
  resolve: { ...config.resolve, alias: [
    ...domainModules.map(name => ({ find: new RegExp(`^@swat/db/dist/${name}\\.js$`),
      replacement: fileURLToPath(new URL(`../../packages/db/src/${name}.ts`, import.meta.url)) })),
    ...inheritedEntries
  ] }
};
