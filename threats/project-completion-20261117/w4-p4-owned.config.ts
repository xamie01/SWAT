import { fileURLToPath } from 'node:url';
import { createPackageConfig } from '../sequential-fixes/package12-29-harness.js';

const config = createPackageConfig([
  'tests/qualification/wave4/pipeline-import-containment.offline.test.ts',
  'tests/qualification/wave4/pipeline-owned.offline.test.ts',
  'packages/db/src/copy-trade-lifecycle.sequential.test.ts',
  'packages/db/src/source-claim.sequential.test.ts',
  'packages/db/src/source-verification.sequential.test.ts',
  'packages/db/src/source-sell-evidence.sequential.test.ts',
  'packages/db/src/source-sell-lot-allocation.sequential.test.ts',
  'packages/db/src/package15-lot-claim-recovery.sequential.test.ts',
  'packages/db/src/trades.test.ts',
  'packages/db/src/worker-trade-contract.sequential.test.ts',
  'packages/db/src/package19-risk-reservations.sequential.test.ts',
  'packages/db/src/worker-settlement.sequential.test.ts',
  'packages/db/src/worker-valuation-corrections.sequential.test.ts',
  'packages/db/src/package13-fanout-delivery.test.ts',
  'packages/db/src/fanout-eligibility.test.ts',
  'packages/db/src/subscriptions.test.ts',
  'packages/db/src/obligation-runtime-capability.sequential.test.ts',
  'apps/signal-engine/src/fanout-enqueue.test.ts',
  'apps/signal-engine/src/fanout-canonical.sequential.test.ts',
  'apps/trade-executor/src/worker-policy.sequential.test.ts',
  'apps/trade-executor/src/worker-runtime-adapters.sequential.test.ts'
]);
config.resolve!.alias = [
  { find: /^@swat\/db\/dist\/(.+)\.js$/, replacement: fileURLToPath(new URL('../../packages/db/src/$1.ts', import.meta.url)) },
  ...Object.entries(config.resolve!.alias as Record<string, string>).map(([find, replacement]) => ({ find, replacement }))
];
export default config;
