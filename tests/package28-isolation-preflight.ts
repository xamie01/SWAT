import { assertPackage28IsolationPreflight } from './integration/helpers/package28-isolation.js';

// No DB imports, dotenv, migrations, services, or cleanup in this CLI.
try {
  if (process.argv.slice(2).length !== 1 || process.argv[2] !== '--preflight-only') {
    throw new Error('Integration execution unavailable; only --preflight-only is supported');
  }
  assertPackage28IsolationPreflight(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Integration isolation preflight refused');
  process.exitCode = 1;
}
