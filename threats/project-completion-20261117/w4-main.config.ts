import { fileURLToPath } from 'node:url';
import { createPackageConfig } from '../sequential-fixes/package12-29-harness.js';
const config = createPackageConfig([
  'tests/qualification/wave4/orchestrator.offline.test.ts',
  'tests/qualification/wave4/containment.offline.test.ts',
  'tests/qualification/wave4/lifetime.offline.test.ts',
  'tests/qualification/wave4/rollback.offline.test.ts',
  'tests/qualification/wave4/queue.offline.test.ts',
  'tests/qualification/wave4/catalog.offline.test.ts',
  'tests/qualification/wave4/migration-provisioning.offline.test.ts',
  'packages/db/src/migrate.sequential.test.ts',
  'packages/db/src/migrations.test.ts',
  'packages/db/src/lp-paper-store.sequential.test.ts',
  'tests/qualification/wave4/lp-privileges.offline.test.ts',
  'tests/qualification/wave4/withdrawal.offline.test.ts',
  'tests/qualification/wave4/pipeline.offline.test.ts',
  'tests/qualification/wave4/obligation-owned.offline.test.ts',
  'tests/qualification/wave4/lp-copy.offline.test.ts',
  'tests/qualification/wave4/lp-copy-observer.offline.test.ts',
  'tests/qualification/wave4/lp-admission.offline.test.ts',
  'tests/qualification/wave4/lp-protected-admission.offline.test.ts',
  'tests/qualification/wave4/evidence-writer.offline.test.ts',
  'tests/qualification/wave4/evidence-session.offline.test.ts',
  'tests/qualification/wave4/custody.offline.test.ts',
  'tests/unit/package28-preflight.test.ts',
  'tests/unit/package28-chaos-containment.test.ts',
  'tests/unit/build-schema.test.ts',
  'packages/db/src/auth-owned.offline.test.ts',
  'packages/db/src/auth-wallets.sequential.test.ts',
  'packages/db/src/users.sequential.test.ts',
  'packages/db/src/users-session-cache.test.ts',
  'packages/db/src/credentials.test.ts',
  'apps/api/src/auth/plugin.test.ts',
  'apps/api/src/auth/wallet-signature.test.ts',
  'apps/api/src/routes/auth.transport.sequential.test.ts',
  'apps/api/src/package28-limiter.test.ts',
  'apps/lp/src/auth.offline.test.ts',
  'deploy/postgres/auth-provisioning.offline.test.ts',
  'tests/qualification/wave4/authentication.offline.test.ts'
]);
config.resolve!.alias = [
  { find: /^@swat\/db\/dist\/(.+)\.js$/, replacement: fileURLToPath(new URL('../../packages/db/src/$1.ts', import.meta.url)) },
  ...Object.entries(config.resolve!.alias as Record<string, string>).map(([find, replacement]) => ({ find, replacement }))
];
export default config;
