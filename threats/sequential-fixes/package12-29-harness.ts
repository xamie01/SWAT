import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '../../node_modules/vitest/dist/config.js';
import { JsonReporter } from 'vitest/reporters';

const workspace = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const evidenceDirectory = fileURLToPath(new URL('./', import.meta.url));

function insideWorkspace(path: string): boolean {
  const name = relative(workspace, path);
  return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

const dynamicPathSyntax = /[*?\[\]{}!()\\]/;

function assertTestPath(name: string): void {
  if (dynamicPathSyntax.test(name)) {
    throw new Error(`Package harness requires literal test paths: ${name}`);
  }
  const parts = name.split('/');
  const filename = parts[parts.length - 1];
  if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename)) {
    throw new Error(`Package harness rejects non-test files: ${name}`);
  }
  // Application names such as apps/alert-service are allowed; owners must review
  // imports before execution. Actual service/integration suites are not allowed.
  if (parts.slice(0, -1).some(part => /^(?:integration|integrations|e2e|rls|service|services)$/i.test(part))
      || /(?:^|[._-])(?:integration|e2e|rls|service|services)(?:[._-]|$)/i.test(filename)) {
    throw new Error(`Package harness rejects integration/service test paths: ${name}`);
  }
}

function explicitTestFiles(explicitFiles: string[]): string[] {
  if (!Array.isArray(explicitFiles) || explicitFiles.length === 0) {
    throw new Error('Package harness requires a nonempty explicit test file list');
  }
  const seen = new Set<string>();
  return explicitFiles.map(file => {
    if (typeof file !== 'string' || file.trim() !== file || file.length === 0 || dynamicPathSyntax.test(file)) {
      throw new Error(`Package harness requires literal test paths: ${String(file)}`);
    }
    const candidate = resolve(workspace, file);
    if (!insideWorkspace(candidate)) {
      throw new Error(`Package harness rejects paths outside the workspace: ${file}`);
    }
    assertTestPath(relative(workspace, candidate).split(sep).join('/'));
    let canonical: string;
    try {
      canonical = realpathSync(candidate);
      if (!statSync(canonical).isFile()) throw new Error('not a regular file');
    } catch {
      throw new Error(`Package harness requires an existing regular test file: ${file}`);
    }
    if (!insideWorkspace(canonical)) {
      throw new Error(`Package harness rejects symlinks outside the workspace: ${file}`);
    }
    const name = relative(workspace, canonical).split(sep).join('/');
    assertTestPath(name);
    if (seen.has(canonical)) {
      throw new Error(`Package harness rejects duplicate test files: ${file}`);
    }
    seen.add(canonical);
    return name;
  });
}

/** Only the explicit, unfiltered CLI grammar is supported by this harness. */
export function assertPackageCli(args: string[]): void {
  let configPath: string | undefined;
  if (Array.isArray(args) && args[0] === 'run') {
    if (args.length === 3 && (args[1] === '--config' || args[1] === '-c')) configPath = args[2];
    if (args.length === 2) configPath = /^(?:--config|-c)=(.+)$/.exec(args[1])?.[1];
  }
  if (typeof configPath !== 'string' || !configPath || configPath.trim() !== configPath || configPath.startsWith('-')) {
    throw new Error('Package harness allows only Vitest run --config/-c <config>, without filters or overrides');
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Package harness requires a valid JSON manifest report');
  }
  return value as Record<string, unknown>;
}

function verifyManifest(manifest: readonly string[], results: unknown) {
  const report = record(results);
  const actual = report.testResults;
  if (!Array.isArray(actual) || actual.length === 0 || actual.length !== manifest.length) {
    throw new Error('Package harness actual JSON manifest must match every selected file exactly');
  }
  const expected = new Set(manifest);
  const seen = new Set<string>();
  const counts = { files: actual.length, total: 0, passed: 0, failed: 0, skipped: 0, pending: 0, todo: 0 };
  const statuses = { passed: 'passed', failed: 'failed', skipped: 'skipped', pending: 'pending', todo: 'todo' } as const;
  let failedFiles = 0;
  for (const value of actual) {
    const file = record(value);
    if (typeof file.name !== 'string' || !isAbsolute(file.name) || !expected.has(file.name) || seen.has(file.name)) {
      throw new Error('Package harness actual JSON manifest contains missing, duplicate or unselected files');
    }
    seen.add(file.name);
    if (!['passed', 'failed'].includes(String(file.status)) || !Array.isArray(file.assertionResults)) {
      throw new Error('Package harness requires valid JSON file status and assertions');
    }
    if (file.status === 'failed') failedFiles++;
    for (const value of file.assertionResults) {
      const assertion = record(value);
      const status = assertion.status;
      if (typeof status !== 'string' || !Object.hasOwn(statuses, status)) {
        throw new Error('Package harness requires valid JSON assertion status');
      }
      if (status === 'failed' && file.status !== 'failed') {
        throw new Error('Package harness rejects contradictory JSON file status');
      }
      counts[statuses[status as keyof typeof statuses]]++;
      counts.total++;
    }
  }
  const aggregates = {
    numTotalTests: counts.total, numPassedTests: counts.passed, numFailedTests: counts.failed,
    // Vitest JSON includes skipped assertions in numPendingTests.
    numPendingTests: counts.skipped + counts.pending, numTodoTests: counts.todo
  };
  for (const [key, count] of Object.entries(aggregates)) {
    if (report[key] !== count) throw new Error(`Package harness rejects contradictory JSON count: ${key}`);
  }
  if (typeof report.success !== 'boolean' || (report.success && (failedFiles > 0 || counts.failed > 0))) {
    throw new Error('Package harness rejects contradictory JSON success');
  }
  return counts;
}

/** Counts come from actual assertionResults; suite totals are not file totals. */
export function verifyPackageResults(explicitFiles: string[], results: unknown) {
  return verifyManifest(explicitTestFiles(explicitFiles).map(name => resolve(workspace, name)), results);
}

class ManifestJsonReporter extends JsonReporter {
  readonly manifest: readonly string[];

  constructor(manifest: string[], outputFile: string) {
    super({ outputFile });
    this.manifest = Object.freeze([...manifest]);
  }

  override async writeReport(report: string): Promise<void> {
    try {
      // Await the installed JSON writer first so rejected actual collection is retained.
      await super.writeReport(report);
      const results: unknown = JSON.parse(report);
      verifyManifest(this.manifest, results);
      if (record(results).success === false) process.exitCode = 1;
    } catch (error) {
      process.exitCode = 1;
      throw error;
    }
  }
}

/**
 * Paths are literal workspace-relative or absolute existing test files, never globs.
 * This selects files only; the owner must independently review their import safety.
 * Invoke Vitest via the historical offline runner under the shared flock.
 */
export function createPackageConfig(explicitFiles: string[]) {
  const include = explicitTestFiles(explicitFiles);
  const outputFile = process.env.REVIEW_RESULTS;
  if (!outputFile || !isAbsolute(outputFile)) {
    throw new Error('Package harness requires the offline runner absolute REVIEW_RESULTS path');
  }
  return defineConfig({
    root: workspace,
    envDir: resolve(evidenceDirectory, 'empty-env'),
    cacheDir: process.env.REVIEW_CACHE || resolve(evidenceDirectory, 'cache'),
    resolve: {
      alias: {
        '@swat/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
        '@swat/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
        'viem': fileURLToPath(new URL('../../apps/api/node_modules/viem', import.meta.url)),
        '@solana/web3.js': fileURLToPath(new URL('../../packages/shared/node_modules/@solana/web3.js', import.meta.url))
      }
    },
    plugins: [{
      name: 'package-manifest-cli',
      enforce: 'pre',
      config() { assertPackageCli(process.argv.slice(2)); }
    }],
    test: {
      include,
      pool: 'forks',
      minWorkers: 1,
      maxWorkers: 1,
      fileParallelism: false,
      maxConcurrency: 1,
      testTimeout: 10000,
      hookTimeout: 10000,
      setupFiles: [resolve(evidenceDirectory, 'test-safety.ts')],
      reporters: ['default', new ManifestJsonReporter(include.map(name => resolve(workspace, name)), outputFile)],
      outputFile
    }
  });
}
